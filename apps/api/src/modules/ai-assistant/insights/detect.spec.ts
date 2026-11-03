import { describe, expect, it } from 'vitest';
import { briefHours, briefSlot } from '../ai-brief.scheduler';
import {
  assessDeviation,
  assessLateRisk,
  detectFuelAnomalies,
  DEVIATION_DEFAULT_MILES,
  FUEL_DEFAULTS,
  offLineMiles,
  plainBrief,
  rankIssues,
  roadMiles,
  type FuelRow,
  type LatLng,
  type StopFacts,
} from './detect';

/** Every test runs on this fixed clock: 3 Nov 2026, 14:00 UTC (9:00 AM Eastern). */
const NOW = new Date('2026-11-03T14:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

const PLACES: Record<string, LatLng> = {
  'Chicago|IL': { lat: 41.8781, lng: -87.6298 },
  'Indianapolis|IN': { lat: 39.7684, lng: -86.1581 },
  'Columbus|OH': { lat: 39.9612, lng: -82.9988 },
  'Nashville|TN': { lat: 36.1627, lng: -86.7816 },
};
const placeOf = (s: StopFacts) => PLACES[`${s.city}|${s.state}`] ?? null;

const stop = (over: Partial<StopFacts>): StopFacts => ({
  id: over.id ?? 's1',
  kind: 'delivery',
  city: 'Columbus',
  state: 'OH',
  timezone: 'America/New_York',
  status: 'pending',
  appointmentStartAt: hoursFromNow(4),
  appointmentEndAt: hoursFromNow(4),
  arrivedAt: null,
  departedAt: null,
  ...over,
});

const fill = (over: Partial<FuelRow>): FuelRow => ({
  id: over.id ?? 'f1',
  truckId: 'trk_1',
  unitNumber: '0033',
  at: minutesAgo(60),
  product: 'diesel',
  gallons: 120,
  odometer: 0,
  station: { name: 'Pilot #1', city: 'Gary', state: 'IN' },
  ...over,
});

describe('fuel anomalies', () => {
  const opts = { ...FUEL_DEFAULTS, now: NOW };

  it('flags the same truck fueling twice within the window without driving far', () => {
    const rows = [fill({ id: 'a', at: minutesAgo(150), odometer: 500_000, gallons: 110 }), fill({ id: 'b', at: minutesAgo(60), odometer: 500_040, gallons: 95 })];
    const found = detectFuelAnomalies(rows, opts);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'twice_in_a_row', purchaseId: 'b', previousId: 'a', level: 'warning' });
    expect(found[0]!.detail).toContain('1 h 30 min');
    expect(found[0]!.detail).toContain('40 mi apart');
  });

  it('does not flag two fills hours apart with real miles between them', () => {
    const rows = [fill({ id: 'a', at: minutesAgo(600), odometer: 500_000 }), fill({ id: 'b', at: minutesAgo(60), odometer: 500_480 })];
    expect(detectFuelAnomalies(rows, opts)).toEqual([]);
  });

  it('does not flag two close fills when the odometer shows the truck drove far', () => {
    const rows = [fill({ id: 'a', at: minutesAgo(200), odometer: 500_000 }), fill({ id: 'b', at: minutesAgo(10), odometer: 500_190 })];
    expect(detectFuelAnomalies(rows, opts)).toEqual([]);
  });

  it('a pair whose gallons together exceed the tanks is urgent', () => {
    const rows = [fill({ id: 'a', at: minutesAgo(90), gallons: 180 }), fill({ id: 'b', at: minutesAgo(30), gallons: 170 })];
    expect(detectFuelAnomalies(rows, opts)[0]).toMatchObject({ kind: 'twice_in_a_row', level: 'urgent' });
  });

  it('flags a single fill above the tank capacity, and an odometer going back', () => {
    const rows = [fill({ id: 'a', at: minutesAgo(3000), odometer: 600_000 }), fill({ id: 'b', at: minutesAgo(60), odometer: 599_000, gallons: 340 })];
    const kinds = detectFuelAnomalies(rows, opts).map((a) => a.kind).sort();
    expect(kinds).toEqual(['odometer_backwards', 'over_tank']);
  });

  it('ignores DEF, other trucks and purchases outside the period', () => {
    const rows = [
      fill({ id: 'a', at: minutesAgo(90) }),
      fill({ id: 'b', at: minutesAgo(60), product: 'def', gallons: 5 }),
      fill({ id: 'c', at: minutesAgo(50), truckId: 'trk_2', unitNumber: '0044' }),
      fill({ id: 'old1', at: minutesAgo(20 * 24 * 60), gallons: 400 }),
    ];
    expect(detectFuelAnomalies(rows, opts)).toEqual([]);
  });

  it('carries what the ledger itself flagged', () => {
    const found = detectFuelAnomalies([fill({ id: 'x', anomalyFlags: ['location_mismatch'] })], opts);
    expect(found).toEqual([expect.objectContaining({ kind: 'ledger_flag', level: 'warning' })]);
  });
});

describe('late risk (the Operations screen rule, fixed clock)', () => {
  const chicago = { ...PLACES['Chicago|IL']!, updatedAt: minutesAgo(5) };

  it('late: the ETA lands past the appointment, with the minutes', () => {
    // Chicago → Columbus is ~280 straight-line miles x 1.18 ≈ 330 road miles ≈ 7 h at 47 mph.
    const r = assessLateRisk({ nowIso: NOW_ISO, stops: [stop({ appointmentStartAt: hoursFromNow(4), appointmentEndAt: hoursFromNow(4) })], position: chicago, placeOf });
    expect(r.remainingMiles).toBeGreaterThan(300);
    expect(r.verdict.state).toBe('late');
    expect(r.verdict.minutesLate).toBeGreaterThan(150);
    expect(r.minutesToDeadline).toBe(240);
  });

  it('at risk: the ETA lands inside the 30-minute buffer', () => {
    const r0 = assessLateRisk({ nowIso: NOW_ISO, stops: [stop({})], position: chicago, placeOf });
    const etaMs = Date.parse(r0.etaAt!);
    const deadline = new Date(etaMs + 10 * 60_000).toISOString();
    const r = assessLateRisk({ nowIso: NOW_ISO, stops: [stop({ appointmentStartAt: deadline, appointmentEndAt: deadline })], position: chicago, placeOf });
    expect(r.verdict.state).toBe('at_risk');
    expect(r.verdict.minutesLate).toBe(-10);
  });

  it('on time with hours to spare', () => {
    const r = assessLateRisk({ nowIso: NOW_ISO, stops: [stop({ appointmentStartAt: hoursFromNow(20), appointmentEndAt: hoursFromNow(22) })], position: chicago, placeOf });
    expect(r.verdict.state).toBe('on_time');
  });

  it('runs to the first stop not completed', () => {
    const r = assessLateRisk({
      nowIso: NOW_ISO,
      stops: [stop({ id: 'p', kind: 'pickup', city: 'Chicago', state: 'IL', status: 'completed', arrivedAt: minutesAgo(300), departedAt: minutesAgo(240) }), stop({ id: 'd' })],
      position: chicago,
      placeOf,
    });
    expect(r.nextStop?.id).toBe('d');
  });

  it('an old position is "no update", never on time', () => {
    const r = assessLateRisk({ nowIso: NOW_ISO, stops: [stop({ appointmentEndAt: hoursFromNow(30) })], position: { ...chicago, updatedAt: minutesAgo(120) }, placeOf });
    expect(r.verdict.state).toBe('no_update');
    expect(r.remainingMiles).toBeNull();
  });

  it('a passed appointment with no arrival is late even without a position', () => {
    const r = assessLateRisk({ nowIso: NOW_ISO, stops: [stop({ appointmentStartAt: minutesAgo(90), appointmentEndAt: minutesAgo(45) })], position: null, placeOf });
    expect(r.verdict).toMatchObject({ state: 'late', minutesLate: 45 });
  });
});

describe('route deviation', () => {
  const stops = [stop({ id: 'p', kind: 'pickup', city: 'Chicago', state: 'IL', status: 'completed', departedAt: minutesAgo(200) }), stop({ id: 'd', city: 'Nashville', state: 'TN' })];

  it('a truck on I-65 through Indianapolis is on route at the default 75 mi - though ~60 mi off the straight line', () => {
    const r = assessDeviation({ nowIso: NOW_ISO, stops, position: { ...PLACES['Indianapolis|IN']!, updatedAt: minutesAgo(5) }, placeOf, thresholdMiles: DEVIATION_DEFAULT_MILES, maxPositionAgeMinutes: 60 });
    expect(r.state).toBe('on_route');
    expect(r.offMiles).toBeGreaterThan(50);
    expect(r.offMiles).toBeLessThan(DEVIATION_DEFAULT_MILES);
  });

  it('a truck in Columbus OH is far off the Chicago → Nashville line', () => {
    const r = assessDeviation({ nowIso: NOW_ISO, stops, position: { ...PLACES['Columbus|OH']!, updatedAt: minutesAgo(5) }, placeOf, thresholdMiles: DEVIATION_DEFAULT_MILES, maxPositionAgeMinutes: 60 });
    expect(r.state).toBe('off_route');
    expect(r.offMiles).toBeGreaterThan(150);
    expect(r.reason).toContain('Chicago, IL → Nashville, TN');
  });

  it('is not judged before the first stop, or on an old position', () => {
    expect(assessDeviation({ nowIso: NOW_ISO, stops: [stops[1]!], position: { ...PLACES['Columbus|OH']!, updatedAt: minutesAgo(5) }, placeOf, thresholdMiles: DEVIATION_DEFAULT_MILES, maxPositionAgeMinutes: 60 }).state).toBe('unknown');
    expect(assessDeviation({ nowIso: NOW_ISO, stops, position: { ...PLACES['Columbus|OH']!, updatedAt: minutesAgo(240) }, placeOf, thresholdMiles: DEVIATION_DEFAULT_MILES, maxPositionAgeMinutes: 60 }).state).toBe('unknown');
  });

  it('measures distance to the segment, not to the infinite line', () => {
    const a = { lat: 40, lng: -90 };
    const b = { lat: 40, lng: -89 };
    expect(offLineMiles({ lat: 40, lng: -89.5 }, a, b).miles).toBeLessThan(1);
    // Beyond b: the distance to b, not to the extended line.
    expect(offLineMiles({ lat: 40, lng: -88 }, a, b).miles).toBeGreaterThan(50);
    expect(roadMiles(a, b) % 5).toBe(0);
  });
});

describe('the brief', () => {
  it('ranks urgent → warning → info, late loads before papers before hiring', () => {
    const ranked = rankIssues([
      { level: 'info', area: 'hiring', title: 'h', detail: '' },
      { level: 'urgent', area: 'compliance', title: 'c', detail: '' },
      { level: 'warning', area: 'fuel', title: 'f', detail: '' },
      { level: 'urgent', area: 'late_risk', title: 'l', detail: '' },
    ]);
    expect(ranked.map((i) => i.title)).toEqual(['l', 'c', 'f', 'h']);
  });

  it('writes a plain brief with the level word on every line when there is no model', () => {
    const text = plainBrief([{ level: 'urgent', area: 'late_risk', title: 'L-1 late', detail: 'by 2 h' }], 'Tuesday, Nov 3');
    expect(text).toContain('**Urgent** · L-1 late');
    expect(plainBrief([], 'Tuesday, Nov 3')).toContain('Nothing needs attention');
  });

  it('the schedule is off unless AI_BRIEF_CRON names hours, and fires once in the slot (Eastern)', () => {
    expect(briefHours(undefined)).toEqual([]);
    expect(briefHours('18, 6,x,25,10')).toEqual([6, 10, 18]);
    // 14:05 UTC = 9:05 Eastern (EST).
    expect(briefSlot(new Date('2026-11-03T14:05:00Z'), [9])).toBe('2026-11-03T09');
    expect(briefSlot(new Date('2026-11-03T14:15:00Z'), [9])).toBeNull();
    expect(briefSlot(new Date('2026-11-03T14:05:00Z'), [6])).toBeNull();
  });
});
