import { describe, expect, it } from 'vitest';
import { planFiveEldSync, readFiveEldVehicle, toPlannerStats, trucksWithNewerReport, type FiveEldReading } from './fiveeld-sync.plan';
import type { FiveEldTrackPoint, FiveEldUnit } from './fiveeld.client';
import { planSamsaraSync, type TruckSnapshot } from './samsara-sync.plan';

const NOW = new Date('2026-10-20T12:00:00Z');
const ACCOUNT = 'int_fiveeld';
const SAMSARA = 'int_samsara';
const VIN_A = '1FUJGLDR8CLBP0101';
const VIN_B = '3AKJHHDR5NSNA1234';

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function unit(id: string, name: string, vin: string | null = null): FiveEldUnit {
  return { id, name, vin };
}

function point(miles: number | null, at: string, extra: Partial<FiveEldTrackPoint> = {}): FiveEldTrackPoint {
  return {
    at,
    latitude: 41.7,
    longitude: -88.1,
    address: '1850 Diehl Rd, Naperville, IL 60563',
    odometer: miles,
    speed: 0,
    headingDegrees: null,
    driverId: null,
    ...extra,
  };
}

function reading(u: FiveEldUnit, latest: FiveEldTrackPoint | null): FiveEldReading {
  return { unit: u, latest };
}

function truck(id: string, unitNumber: string, extra: Partial<TruckSnapshot> = {}): TruckSnapshot {
  return {
    id,
    unitNumber,
    vin: VIN_A,
    status: 'available',
    odometer: 100_000,
    odometerAt: new Date('2026-10-01T00:00:00Z'),
    telematicsAccountId: null,
    telematicsExternalId: null,
    telematicsProvider: 'Five ELD',
    locationAt: null,
    ...extra,
  };
}

const options = { accountId: ACCOUNT, now: NOW };

describe('matching', () => {
  it('matches by VIN first, then by unit number, and links the Five ELD id', () => {
    const plan = planFiveEldSync(
      [reading(unit('f1', 'ZZZ', VIN_A), point(100_500, daysAgo(1))), reading(unit('f2', '3002'), point(90_500, daysAgo(1)))],
      [truck('trk_3001', '3001', { vin: VIN_A }), truck('trk_3002', '3002', { vin: VIN_B, odometer: 90_000 })],
      options,
    );
    const linked = new Map(plan.updates.map((u) => [u.truckId, u.externalId]));
    expect(linked.get('trk_3001')).toBe('f1');
    expect(linked.get('trk_3002')).toBe('f2');
    expect(plan.summary.matched).toBe(2);
    expect(plan.updates.find((u) => u.truckId === 'trk_3001')?.line.note).toMatch(/Five ELD calls it "ZZZ"/);
  });

  it('matches by the remembered Five ELD id before anything else', () => {
    const plan = planFiveEldSync(
      [reading(unit('f1', 'RENAMED', null), point(100_500, daysAgo(1)))],
      [truck('trk_3001', '3001', { telematicsAccountId: ACCOUNT, telematicsExternalId: 'f1', telematicsProvider: 'fiveeld', vin: '' })],
      options,
    );
    expect(plan.updates.map((u) => u.truckId)).toEqual(['trk_3001']);
    expect(plan.unmatched).toEqual([]);
  });

  it('never creates a duplicate: a matched unit is updated, and createMissing creates only the unknown one', () => {
    const plan = planFiveEldSync(
      [reading(unit('f1', '3001', VIN_A), point(100_500, daysAgo(1))), reading(unit('f9', '3009', VIN_B), point(50_000, daysAgo(1)))],
      [truck('trk_3001', '3001')],
      { ...options, createMissing: true },
    );
    expect(plan.creates.map((c) => c.unitNumber)).toEqual(['3009']);
    expect(plan.creates[0]?.line.note).toBe('Created from Five ELD');
    expect(plan.creates[0]).toMatchObject({ make: 'Unknown', model: 'Unknown', year: 1980, engineHours: 0 });
    expect(plan.updates.map((u) => u.truckId)).toEqual(['trk_3001']);
  });

  it('without the tick, an unknown vehicle is listed and nothing is invented', () => {
    const plan = planFiveEldSync([reading(unit('f9', '3009', VIN_B), point(50_000, daysAgo(1)))], [], options);
    expect(plan.creates).toEqual([]);
    expect(plan.unmatched[0]?.note).toMatch(/create missing/);
  });

  it('cannot create a vehicle Five ELD has no VIN or no odometer for', () => {
    const plan = planFiveEldSync(
      [reading(unit('f8', '3008', null), point(50_000, daysAgo(1))), reading(unit('f9', '3009', VIN_B), point(null, daysAgo(1)))],
      [],
      { ...options, createMissing: true },
    );
    expect(plan.creates).toEqual([]);
    expect(plan.unmatched.map((l) => l.note)).toEqual([
      'Not in the roster and Five ELD has no VIN for it, so it cannot be created',
      'Not in the roster and Five ELD has no odometer for it',
    ]);
  });

  it('reports the same unit number twice in Five ELD as a duplicate, newest reading wins', () => {
    const plan = planFiveEldSync(
      [reading(unit('old', '3001'), point(100_100, daysAgo(5))), reading(unit('new', '3001'), point(100_200, daysAgo(1)))],
      [truck('trk_3001', '3001', { vin: '' })],
      options,
    );
    expect(plan.updates.map((u) => u.externalId)).toEqual(['new']);
    expect(plan.duplicates.map((l) => l.externalId)).toEqual(['old']);
  });

  it('two Five ELD vehicles for one truck: the second is a duplicate, not a second link', () => {
    const plan = planFiveEldSync(
      [reading(unit('f1', 'A', VIN_A), point(100_500, daysAgo(1))), reading(unit('f2', '3001'), point(100_600, daysAgo(1)))],
      [truck('trk_3001', '3001')],
      options,
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.duplicates).toHaveLength(1);
  });

  it('a vehicle with no point at all is inactive, never matched, never created', () => {
    const plan = planFiveEldSync([reading(unit('f1', '3001', VIN_A), null)], [truck('trk_3001', '3001')], { ...options, createMissing: true });
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([]);
    expect(plan.inactive[0]?.note).toBe('No reading of any kind from this vehicle');
    expect(plan.summary).toMatchObject({ fetched: 1, inactive: 1, matched: 0 });
  });

  it('a vehicle whose newest point is older than the window is inactive', () => {
    const plan = planFiveEldSync([reading(unit('f1', '3001'), point(120_000, daysAgo(40)))], [truck('trk_3001', '3001')], options);
    expect(plan.inactive[0]?.note).toBe('Last reading 40 days ago');
    expect(plan.updates).toEqual([]);
  });
});

describe('values', () => {
  it('moves the odometer forward only, and reports a big drop as a conflict', () => {
    const plan = planFiveEldSync(
      [reading(unit('f1', '3001'), point(100_900, daysAgo(1))), reading(unit('f2', '3002'), point(80_000, daysAgo(1)))],
      [truck('trk_3001', '3001', { vin: '' }), truck('trk_3002', '3002', { vin: '' })],
      options,
    );
    expect(plan.updates.map((u) => [u.truckId, u.odometer])).toEqual([['trk_3001', 100_900]]);
    expect(plan.conflicts.map((l) => l.unitNumber)).toEqual(['3002']);
    expect(plan.conflicts[0]?.note).toMatch(/Five ELD reads 80,000 mi/);
  });

  it('never writes an unknown over a known: a missing odometer or fix stays unwritten, engine hours always', () => {
    const plan = planFiveEldSync(
      [
        // A fix but no odometer.
        reading(unit('f1', '3001'), point(null, daysAgo(1))),
        // An odometer but no fix.
        reading(unit('f2', '3002'), point(100_700, daysAgo(1), { latitude: null, longitude: null })),
      ],
      [truck('trk_3001', '3001', { vin: '' }), truck('trk_3002', '3002', { vin: '' })],
      options,
    );
    const a = plan.updates.find((u) => u.truckId === 'trk_3001');
    const b = plan.updates.find((u) => u.truckId === 'trk_3002');
    expect(a).toMatchObject({ odometer: null, odometerAt: null, engineHours: null });
    expect(a?.location).not.toBeNull();
    expect(b).toMatchObject({ odometer: 100_700, engineHours: null, location: null });
    // Only the vehicle with an odometer reaches the PM history; a position-only point never does.
    expect(plan.readings).toEqual([{ truckId: 'trk_3002', odometer: 100_700, odometerAt: daysAgo(1), engineHours: null }]);
  });

  it('an equal odometer is not a change; a newer fix on a parked truck is', () => {
    const remembered = truck('trk_3001', '3001', {
      vin: '',
      telematicsAccountId: ACCOUNT,
      telematicsExternalId: 'f1',
      telematicsProvider: 'fiveeld',
      locationAt: new Date(daysAgo(2)),
    });
    const same = planFiveEldSync([reading(unit('f1', '3001'), point(100_000, daysAgo(3)))], [remembered], options);
    expect(same.unchanged[0]?.note).toBe('Up to date');
    const moved = planFiveEldSync([reading(unit('f1', '3001'), point(100_000, daysAgo(1)))], [remembered], options);
    expect(moved.updates[0]?.line.note).toBe('Position updated');
    expect(moved.updates[0]?.odometer).toBeNull();
  });

  it('turns the point into the roster shape: city and state from the address, engine state from the speed', () => {
    const plan = planFiveEldSync(
      [reading(unit('f1', '3001'), point(100_500, daysAgo(1), { speed: 60, headingDegrees: 90 }))],
      [truck('trk_3001', '3001', { vin: '' })],
      options,
    );
    expect(plan.updates[0]?.location).toEqual({
      lat: 41.7,
      lng: -88.1,
      city: 'Naperville',
      state: 'IL',
      updatedAt: daysAgo(1),
      speedMph: 60,
      headingDegrees: 90,
      engineState: 'on',
    });
    const parked = toPlannerStats('f1', '3001', point(null, daysAgo(1), { speed: 0 }));
    expect(parked.engineState).toBe('off');
    const unknown = toPlannerStats('f1', '3001', point(null, daysAgo(1), { speed: null }));
    expect(unknown.engineState).toBeNull();
    expect(unknown.engineHours).toBeNull();
  });

  it('converts a kilometre odometer to miles only when the account says km', () => {
    const km = toPlannerStats('f1', '3001', point(160_934, daysAgo(1)), 'km');
    expect(km.obdOdometerMiles).toBe(100_000);
    const mi = toPlannerStats('f1', '3001', point(160_934, daysAgo(1)));
    expect(mi.obdOdometerMiles).toBe(160_934);
  });

  it('a retired truck is matched (never re-created) and left alone', () => {
    const plan = planFiveEldSync(
      [reading(unit('f1', '3001', VIN_A), point(200_000, daysAgo(1)))],
      [truck('trk_3001', '3001', { status: 'sold' })],
      { ...options, createMissing: true },
    );
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged[0]?.note).toMatch(/sold in the roster; left alone/);
  });
});

describe('Five ELD beside Samsara and Motive in one company', () => {
  const samsaraTruck = truck('trk_3001', '3001', {
    telematicsAccountId: SAMSARA,
    telematicsExternalId: 's1',
    telematicsProvider: 'samsara',
    locationAt: new Date(daysAgo(0.1)),
  });

  it('Five ELD leaves a truck that a live Samsara account reports alone', () => {
    const plan = planFiveEldSync([reading(unit('f1', '3001', VIN_A), point(200_000, daysAgo(0)))], [samsaraTruck], options);
    expect(plan.updates).toEqual([]);
    expect(plan.readings).toEqual([]);
    expect(plan.unchanged[0]?.note).toMatch(/Reported by its Samsara account.*left alone/);
  });

  it('a live Samsara that sends no odometer: Five ELD gives the odometer only, Samsara keeps the truck (owner, 2026-10-29)', () => {
    const gpsOnly = { ...samsaraTruck, odometer: 0, odometerAt: new Date(NOW.getTime() - 60 * 86_400_000) };
    const plan = planFiveEldSync([reading(unit('f1', '3001', VIN_A), point(197_449, daysAgo(0)))], [gpsOnly], options);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toMatchObject({ truckId: 'trk_3001', odometer: 197_449, odometerOnly: true, location: null });
    expect(plan.updates[0]?.line.note).toMatch(/Samsara sends no odometer for it and keeps the position/);
    expect(plan.readings).toEqual([expect.objectContaining({ truckId: 'trk_3001', odometer: 197_449 })]);
  });

  it('Samsara leaves a truck that a live Five ELD account reports alone, and names it properly', () => {
    const fiveTruck = truck('trk_3001', '3001', {
      telematicsAccountId: ACCOUNT,
      telematicsExternalId: 'f1',
      telematicsProvider: 'fiveeld',
      locationAt: new Date(daysAgo(0.1)),
    });
    const plan = planSamsaraSync(
      [{ id: 's1', name: '3001', vin: VIN_A, make: null, model: null, year: null, licensePlate: null, updatedAt: null }],
      [{ id: 's1', name: '3001', obdOdometerMiles: 200_000, obdOdometerAt: daysAgo(0), gpsOdometerMiles: null, gpsOdometerAt: null, engineHours: null, engineHoursAt: null, gps: null, engineState: null, engineStateAt: null }],
      [fiveTruck],
      { accountId: SAMSARA, now: NOW },
    );
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged[0]?.note).toMatch(/Reported by its Five ELD account/);
  });

  it('takes over a truck whose Samsara account has gone silent past the inactive window', () => {
    const quiet = { ...samsaraTruck, locationAt: new Date(daysAgo(45)) };
    const plan = planFiveEldSync([reading(unit('f1', '3001', VIN_A), point(100_500, daysAgo(0)))], [quiet], options);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]?.externalId).toBe('f1');
    expect(plan.updates[0]?.line.note).toMatch(/Taken over from Samsara, silent for 45 days/);
  });

  it('takes over a truck a Motive account linked but never positioned', () => {
    const motiveTruck = truck('trk_3001', '3001', { telematicsAccountId: 'int_motive', telematicsExternalId: 'm1', telematicsProvider: 'motive', locationAt: null });
    const plan = planFiveEldSync([reading(unit('f1', '3001', VIN_A), point(100_500, daysAgo(0)))], [motiveTruck], options);
    expect(plan.updates[0]?.line.note).toMatch(/Taken over from Motive, which has no position for it/);
  });

  it('a hand-typed "Five ELD" on an unlinked truck does not block the sync', () => {
    const plan = planFiveEldSync([reading(unit('f1', '3001', VIN_A), point(100_500, daysAgo(0)))], [truck('trk_3001', '3001', { telematicsProvider: 'Five ELD' })], options);
    expect(plan.updates).toHaveLength(1);
  });
});

describe('reading one vehicle (the walk back for parked trucks)', () => {
  const HOUR = 3_600_000;
  /** A Five ELD that holds these points and answers each window with the ones inside it. */
  function history(points: FiveEldTrackPoint[]) {
    const asked: Array<[string, string]> = [];
    const fetch = async (from: Date, to: Date) => {
      asked.push([from.toISOString(), to.toISOString()]);
      expect(to.getTime() - from.getTime()).toBeLessThanOrEqual(72 * HOUR);
      return points.filter((p) => Date.parse(p.at) >= from.getTime() && Date.parse(p.at) <= to.getTime());
    };
    return { fetch, asked };
  }
  const walk = { now: NOW, inactiveAfterDays: 30 };
  const u700123 = unit('v-700123', '700123', '4V4NC9EH2RN700123');

  it('a truck that moved today costs one request', async () => {
    const five = history([point(100_000, daysAgo(0.5))]);
    const r = await readFiveEldVehicle(u700123, five.fetch, walk);
    expect(r.requests).toBe(1);
    expect(r.odometerPoint?.odometer).toBe(100_000);
    expect(r.latest?.at).toBe(daysAgo(0.5));
  });

  it('a truck parked five days is found by walking back, and gets its odometer at its own time', async () => {
    const five = history([point(412_345, daysAgo(5)), point(412_300, daysAgo(5.2))]);
    const r = await readFiveEldVehicle(u700123, five.fetch, walk);
    expect(five.asked).toEqual([
      [daysAgo(1), NOW.toISOString()],
      [daysAgo(4), daysAgo(1)],
      [daysAgo(7), daysAgo(4)],
    ]);
    expect(r.odometerPoint).toMatchObject({ odometer: 412_345, at: daysAgo(5) });

    const plan = planFiveEldSync([r], [truck('trk_700123', '700123', { vin: '4V4NC9EH2RN700123', odometer: 410_000 })], options);
    expect(plan.inactive).toEqual([]);
    expect(plan.updates[0]).toMatchObject({ truckId: 'trk_700123', odometer: 412_345, odometerAt: daysAgo(5) });
    expect(plan.readings).toEqual([{ truckId: 'trk_700123', odometer: 412_345, odometerAt: daysAgo(5), engineHours: null }]);
  });

  it('an odometer 0 point does not mask an earlier real one; the position stays the newest fix', async () => {
    // Today the parked truck powered up and sent a fix with odometer 0; the real reading is two days old.
    const five = history([point(0, daysAgo(0.2), { latitude: 40.2, longitude: -75.1 }), point(null, daysAgo(0.3)), point(388_120, daysAgo(2))]);
    const r = await readFiveEldVehicle(u700123, five.fetch, walk);
    expect(r.requests).toBe(2);
    expect(r.latest).toMatchObject({ at: daysAgo(0.2), latitude: 40.2 });
    expect(r.odometerPoint).toMatchObject({ odometer: 388_120, at: daysAgo(2) });

    const plan = planFiveEldSync([r], [truck('trk_700123', '700123', { vin: '4V4NC9EH2RN700123', odometer: 380_000 })], options);
    expect(plan.updates[0]).toMatchObject({ odometer: 388_120, odometerAt: daysAgo(2) });
    expect(plan.updates[0]?.location).toMatchObject({ lat: 40.2, updatedAt: daysAgo(0.2) });

    // Even handed straight to the planner, a 0 is unknown, never a reading.
    expect(toPlannerStats('f1', '3001', point(0, daysAgo(0))).obdOdometerMiles).toBeNull();
  });

  it('a vehicle silent for 30 days walks the whole window once and is inactive', async () => {
    const five = history([point(300_000, daysAgo(31))]);
    const r = await readFiveEldVehicle(u700123, five.fetch, walk);
    expect(r.requests).toBe(11);
    expect(five.asked.at(-1)?.[0]).toBe(daysAgo(30));
    expect(r.latest).toBeNull();
    expect(r.odometerPoint).toBeNull();
    const plan = planFiveEldSync([r], [truck('trk_700123', '700123', { vin: '4V4NC9EH2RN700123' })], { ...options, createMissing: true });
    expect(plan.inactive[0]?.note).toBe('No reading of any kind from this vehicle');
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([]);
  });

  it('stops walking once the slices are older than the odometer the roster already holds from this account', async () => {
    const five = history([point(null, daysAgo(0.1))]);
    const r = await readFiveEldVehicle(u700123, five.fetch, { ...walk, knownOdometerAt: new Date(daysAgo(3)) });
    // Today, then [-4d, -1d] (ends after the known reading), then [-7d, -4d] ends before it: stop.
    expect(r.requests).toBe(2);
    expect(r.latest?.at).toBe(daysAgo(0.1));
    expect(r.odometerPoint).toBeNull();
  });
});

describe('position refresh: which trucks units-by-usdot says have moved', () => {
  const linked = [
    { id: 'trk_a', unitNumber: '0016', vin: '1FUJHHDR9PLUK0202', locationAt: new Date(daysAgo(1)) },
    { id: 'trk_b', unitNumber: '700123', vin: '', locationAt: new Date(daysAgo(5)) },
    { id: 'trk_c', unitNumber: '700124', vin: null, locationAt: null },
    { id: 'trk_d', unitNumber: '9999', vin: null, locationAt: new Date(daysAgo(1)) },
  ];

  it('reads only the trucks that reported after the position held, by VIN then unit number; unknown ones too', () => {
    const set = trucksWithNewerReport(linked, [
      { truckNumber: 'X', vin: '1fujhhdr9pluk0202', latitude: 1, longitude: 1, at: daysAgo(0.1) },
      { truckNumber: '700123', vin: null, latitude: 1, longitude: 1, at: daysAgo(5) },
      { truckNumber: '700124', vin: null, latitude: null, longitude: null, at: daysAgo(3) },
    ]);
    expect([...set].sort()).toEqual(['trk_a', 'trk_c', 'trk_d']);
  });

  it('reads every truck when v2 gave no answer', () => {
    expect(trucksWithNewerReport(linked, null).size).toBe(4);
  });
});
