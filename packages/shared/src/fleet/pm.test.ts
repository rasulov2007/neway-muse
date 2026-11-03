import { describe, expect, it } from 'vitest';
import {
  PM_SETTINGS,
  averageMilesPerDay,
  computePmStatus,
  dueSoonMilesFor,
  estimatedDueDate,
  milesRemainingLabel,
  newestUsableReading,
  pmStatusLine,
  readingConflict,
  resolvePlan,
  type ComputeInput,
  type ResolvedPlan,
} from './pm';

/** The clock the acceptance tests freeze: 2026-09-17 07:45 America/Chicago (CDT). */
const NOW = new Date('2026-09-17T07:45:00-05:00');
const TZ = 'America/Chicago';

/** Truck 0074 from 03-acceptance-tests.md. */
const PLAN_0074: ResolvedPlan = { id: 'plan_0074', intervalMiles: 35_000, intervalDays: null, intervalHours: null, dueSoonMiles: null, dueSoonDays: null, origin: 'unit' };
const LAST_0074 = { id: 'wo_0074', at: '2026-06-22T14:00:00-05:00', odometerMiles: 105_368, source: 'import' as const };
const READINGS_0074 = [
  { id: 'r1', readingAt: '2026-09-14T06:12:00-05:00', odometerMiles: 138_900, source: 'eld' as const, status: 'ok' as const },
  { id: 'r2', readingAt: '2026-09-15T06:08:00-05:00', odometerMiles: 141_290, source: 'eld' as const, status: 'ok' as const },
  { id: 'r3', readingAt: '2026-09-16T06:10:00-05:00', odometerMiles: 141_655, source: 'eld' as const, status: 'ok' as const },
  { id: 'r4', readingAt: '2026-09-17T07:25:00-05:00', odometerMiles: 142_020, source: 'eld' as const, status: 'ok' as const },
];

function input(overrides: Partial<ComputeInput> = {}): ComputeInput {
  return {
    unit: { id: 'trk_0074', unitNumber: '0074', status: 'available', groupName: 'NWF', pmResponsibility: 'us', lessorName: null },
    serviceCode: 'OIL_CHANGE',
    plan: PLAN_0074,
    lastService: LAST_0074,
    readings: READINGS_0074,
    groupMedianAvg: null,
    now: NOW,
    timeZone: TZ,
    ...overrides,
  };
}

describe('B · calculations and due status', () => {
  it('B1 · the formulas on 0074', () => {
    const s = computePmStatus(input());
    expect(s.milesSinceService).toBe(36_652);
    expect(s.nextServiceOdometer).toBe(140_368);
    expect(s.milesRemaining).toBe(-1_652);
    expect(s.dueStatus).toBe('overdue');
    expect(s.dueBasis).toBe('miles');
  });

  it('B2 · never a negative number on the row', () => {
    expect(milesRemainingLabel(-1_652)).toBe('1,652 mi over');
    expect(milesRemainingLabel(1_468)).toBe('1,468 mi left');
    expect(pmStatusLine(computePmStatus(input()))).toBe('Overdue · 1,652 mi over');
  });

  it('B3 · due soon is 2,500 mi whatever the interval (owner, 2026-10-23), unless the plan says', () => {
    expect(dueSoonMilesFor(35_000, null)).toBe(2_500);
    expect(dueSoonMilesFor(30_000, null)).toBe(2_500);
    expect(dueSoonMilesFor(12_000, null)).toBe(2_500);
    expect(dueSoonMilesFor(35_000, 2_000)).toBe(2_000);
    // 0074 turns due soon at exactly 2,500 mi remaining: 140,368 − 2,500 = 137,868 on the clock.
    const atThreshold = computePmStatus(input({ readings: [{ ...READINGS_0074[3]!, odometerMiles: 137_868 }] }));
    expect(atThreshold.dueStatus).toBe('due_soon');
    expect(atThreshold.milesRemaining).toBe(2_500);
    const justBefore = computePmStatus(input({ readings: [{ ...READINGS_0074[3]!, odometerMiles: 137_867 }] }));
    expect(justBefore.dueStatus).toBe('ok');
  });

  it('B4 · the estimated date: 35,000 mi at 355 mi/day is Fri Dec 25, 2026', () => {
    expect(estimatedDueDate(35_000, 355, '2026-09-17')).toBe('2026-12-25');
  });

  it('B5 · a slow truck gets its own days, not the fleet average', () => {
    expect(estimatedDueDate(1_320, 145, '2026-09-17')).toBe('2026-09-26');
  });

  it('B6 · no average worth the name, no date', () => {
    expect(estimatedDueDate(4_000, 12, '2026-09-17')).toBeNull();
    expect(estimatedDueDate(4_000, null, '2026-09-17')).toBeNull();
  });

  it('B7 · whichever comes first: 12,000 mi and 190 days on a 30,000 mi / 180 day plan is overdue by days', () => {
    const plan: ResolvedPlan = { ...PLAN_0074, intervalMiles: 30_000, intervalDays: 180 };
    const s = computePmStatus(
      input({
        plan,
        lastService: { id: 'x', at: '2026-03-11T12:00:00-05:00', odometerMiles: 100_000, source: 'completion' },
        readings: [{ id: 'r', readingAt: '2026-09-17T07:00:00-05:00', odometerMiles: 112_000, source: 'eld', status: 'ok' }],
      }),
    );
    expect(s.daysSinceService).toBe(190);
    expect(s.dueStatus).toBe('overdue');
    expect(s.dueBasis).toBe('days');
    expect(s.milesRemaining).toBe(18_000);
  });

  it('B8 · no plan is "No interval set", never OK', () => {
    const s = computePmStatus(input({ plan: null }));
    expect(s.dueStatus).toBe('no_interval');
    expect(pmStatusLine(s)).toBe('No interval set');
    expect(resolvePlan({ unitPlan: null, groupPlan: null, groupName: 'Nobody' }, { ...PM_SETTINGS, fleetIntervalMiles: 0 })).toBeNull();
  });

  it('B9 · a unit plan beats its group plan; removing it falls back to the group, then the fleet', () => {
    const unitPlan = { id: 'u', intervalMiles: 35_000, intervalDays: null, intervalHours: null, dueSoonMiles: null, dueSoonDays: null };
    const groupPlan = { id: 'g', intervalMiles: 30_000, intervalDays: null, intervalHours: null, dueSoonMiles: null, dueSoonDays: null };
    expect(resolvePlan({ unitPlan, groupPlan, groupName: 'NWF' })).toMatchObject({ id: 'u', origin: 'unit' });
    expect(resolvePlan({ unitPlan: null, groupPlan, groupName: 'NWF' })).toMatchObject({ id: 'g', origin: 'group' });
    // No plan row for the group: the group's starting default, then the fleet's.
    expect(resolvePlan({ unitPlan: null, groupPlan: null, groupName: 'Ryder' })).toMatchObject({ intervalMiles: 50_000, origin: 'group' });
    expect(resolvePlan({ unitPlan: null, groupPlan: null, groupName: null })).toMatchObject({ intervalMiles: 30_000, origin: 'fleet' });
  });

  it('B10 · an interval change moves the next service and nothing else', () => {
    const changed = computePmStatus(input({ plan: { ...PLAN_0074, intervalMiles: 30_000 } }));
    expect(changed.nextServiceOdometer).toBe(135_368);
    expect(changed.lastServiceOdometer).toBe(105_368);
    expect(changed.milesRemaining).toBe(-6_652);
  });

  it('B11 · a lease unit carries the same verdict and its lessor', () => {
    const s = computePmStatus(input({ unit: { id: 'trk_796570', unitNumber: '796570', status: 'available', groupName: 'Ryder', pmResponsibility: 'lessor', lessorName: 'Ryder' } }));
    expect(s.dueStatus).toBe('overdue');
    expect(s.pmResponsibility).toBe('lessor');
    expect(s.lessorName).toBe('Ryder');
  });

  it('no service on record is its own honest state, never OK', () => {
    const s = computePmStatus(input({ lastService: null }));
    expect(s.dueStatus).toBe('no_baseline');
  });
});

describe('C · mileage trust', () => {
  it('C1 · a fresh reading drives the verdict without a warning', () => {
    const s = computePmStatus(input());
    expect(s.readingStale).toBe(false);
    expect(s.readingAgeHours).toBeCloseTo(0.3, 1);
    expect(s.readingSource).toBe('eld');
  });

  it('C2 · five days old is usable, and says so', () => {
    const s = computePmStatus(input({ readings: [{ id: 'm', readingAt: '2026-09-12T08:00:00-05:00', odometerMiles: 139_000, source: 'manual', status: 'ok' }] }));
    expect(s.readingStale).toBe(false);
    expect(Math.round((s.readingAgeHours ?? 0) / 24)).toBe(5);
    expect(s.readingSource).toBe('manual');
    expect(s.dueStatus).toBe('due_soon');
  });

  it('C3 · nineteen days old and already past due: overdue by at least what the reading proved', () => {
    const s = computePmStatus(
      input({
        lastService: { id: 'x', at: '2026-04-27T12:00:00-05:00', odometerMiles: 236_727, source: 'import' },
        plan: { ...PLAN_0074, intervalMiles: 30_000 },
        readings: [{ id: 'old', readingAt: '2026-08-29T08:00:00-05:00', odometerMiles: 270_716, source: 'import', status: 'ok' }],
      }),
    );
    expect(s.dueStatus).toBe('overdue_at_least');
    expect(s.milesOverAtReading).toBe(3_989);
    expect(s.readingStale).toBe(true);
    expect(Math.round((s.readingAgeHours ?? 0) / 24)).toBe(19);
    expect(pmStatusLine(s)).toBe('Overdue · ≥ 3,989 mi over');
  });

  it('C4 · ten days old and not yet due is No reading, not OK', () => {
    const s = computePmStatus(input({ readings: [{ id: 'old', readingAt: '2026-09-07T08:00:00-05:00', odometerMiles: 136_368, source: 'eld', status: 'ok' }] }));
    expect(s.dueStatus).toBe('no_reading');
    expect(s.readingOdometer).toBe(136_368);
    expect(pmStatusLine(s)).toBe("No reading — can't tell");
  });

  it('A7 · an undated import reading is a last known value, never a due status', () => {
    const s = computePmStatus(
      input({
        readings: [{ id: 'imp', readingAt: '2026-09-17T07:00:00-05:00', odometerMiles: 142_020, source: 'import', status: 'ok', ageUnknown: true }],
      }),
    );
    expect(s.dueStatus).toBe('no_reading');
    expect(s.readingAgeUnknown).toBe(true);
    expect(s.readingOdometer).toBe(142_020);
    expect(s.readingAt).toBeNull();
    expect(s.milesOverAtReading).toBeNull();
  });

  it('C5 · a reading below the previous one is a conflict', () => {
    expect(readingConflict({ odometerMiles: 141_655, readingAt: '2026-09-16T06:10:00-05:00' }, { odometerMiles: 141_000, readingAt: '2026-09-17T06:10:00-05:00' })).toBe('below_previous');
  });

  it('C6 · more than 1,500 mi/day above the previous one is a conflict', () => {
    expect(readingConflict({ odometerMiles: 141_655, readingAt: '2026-09-16T06:10:00-05:00' }, { odometerMiles: 143_200, readingAt: '2026-09-17T06:10:00-05:00' })).toBe('too_high_per_day');
    expect(readingConflict({ odometerMiles: 141_655, readingAt: '2026-09-16T06:10:00-05:00' }, { odometerMiles: 143_100, readingAt: '2026-09-17T06:10:00-05:00' })).toBeNull();
    // Two days apart, the same jump is fine.
    expect(readingConflict({ odometerMiles: 141_655, readingAt: '2026-09-15T06:10:00-05:00' }, { odometerMiles: 143_200, readingAt: '2026-09-17T06:10:00-05:00' })).toBeNull();
  });

  it('C8 · at the same moment the ELD reading beats the manual one; a conflict never drives', () => {
    const chosen = newestUsableReading([
      { id: 'm', readingAt: '2026-09-17T07:25:00-05:00', odometerMiles: 142_100, source: 'manual', status: 'ok' },
      { id: 'e', readingAt: '2026-09-17T07:25:00-05:00', odometerMiles: 142_020, source: 'eld', status: 'ok' },
      { id: 'c', readingAt: '2026-09-17T09:00:00-05:00', odometerMiles: 140_000, source: 'eld', status: 'conflict' },
    ]);
    expect(chosen?.id).toBe('e');
  });

  it('the average is miles over the window per day it spans, with fallbacks', () => {
    // 3,120 miles over the 3.05 days between the first and last of the four readings.
    expect(Math.round(averageMilesPerDay(READINGS_0074, NOW, 30) ?? 0)).toBe(1_023);
    expect(averageMilesPerDay(READINGS_0074.slice(3), NOW, 30)).toBeNull();
    const s = computePmStatus(input({ readings: READINGS_0074.slice(3), groupMedianAvg: 355 }));
    expect(s.avgBasis).toBe('group_median');
    expect(s.avgMilesPerDay).toBe(355);
    expect(s.estimatedDueDate).toBe('2026-09-17');
  });
});
