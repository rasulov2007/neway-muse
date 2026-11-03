import { describe, expect, it } from 'vitest';
import { placeToCityState, planSamsaraSync, type TruckSnapshot } from './samsara-sync.plan';
import type { SamsaraVehicle, SamsaraVehicleStats } from './samsara.client';

/**
 * The rules a sync runs by, each with the case the owner described: an account that still lists
 * trucks nobody drives, and the same unit number two or three times over.
 */

const NOW = new Date('2026-09-18T12:00:00Z');
const ACCOUNT = 'int_a';

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function vehicle(id: string, name: string, extra: Partial<SamsaraVehicle> = {}): SamsaraVehicle {
  return {
    id,
    name,
    vin: null,
    make: 'Freightliner',
    model: 'Cascadia',
    year: 2021,
    licensePlate: null,
    updatedAt: null,
    ...extra,
  };
}

function stats(
  id: string,
  name: string,
  miles: number,
  at: string,
  extra: Partial<SamsaraVehicleStats> = {},
): SamsaraVehicleStats {
  return {
    id,
    name,
    obdOdometerMiles: miles,
    obdOdometerAt: at,
    gpsOdometerMiles: null,
    gpsOdometerAt: null,
    engineHours: null,
    engineHoursAt: null,
    gps: null,
    engineState: null,
    engineStateAt: null,
    ...extra,
  };
}

function truck(id: string, unitNumber: string, extra: Partial<TruckSnapshot> = {}): TruckSnapshot {
  return {
    id,
    unitNumber,
    vin: '1FUJGLDR8CLBP0101',
    status: 'available',
    odometer: 100_000,
    odometerAt: new Date('2026-09-01T00:00:00Z'),
    telematicsAccountId: null,
    telematicsExternalId: null,
    ...extra,
  };
}

describe('inactive vehicles', () => {
  it('skips a vehicle with no reading in the window, and never creates a truck from it', () => {
    const plan = planSamsaraSync(
      [vehicle('v1', '3001'), vehicle('v2', '3002')],
      [stats('v1', '3001', 120_000, daysAgo(45)), stats('v2', '3002', 90_000, daysAgo(2))],
      [],
      { accountId: ACCOUNT, now: NOW, createMissing: true },
    );
    expect(plan.inactive.map((l) => l.name)).toEqual(['3001']);
    expect(plan.inactive[0]?.note).toMatch(/45 days ago/);
    expect(plan.creates.map((c) => c.unitNumber)).toEqual([]);
    // 3002 has no VIN, so even with createMissing it is unmatched, not created.
    expect(plan.unmatched.map((l) => l.name)).toEqual(['3002']);
    expect(plan.summary).toMatchObject({ fetched: 2, inactive: 1, unmatched: 1, created: 0 });
  });

  it('treats a vehicle with no readings at all as inactive', () => {
    const plan = planSamsaraSync([vehicle('v1', '3001')], [], [truck('trk_3001', '3001')], {
      accountId: ACCOUNT,
      now: NOW,
    });
    expect(plan.inactive[0]?.note).toMatch(/No reading/);
    expect(plan.updates).toEqual([]);
  });

  it('honours a per-account window', () => {
    const plan = planSamsaraSync(
      [vehicle('v1', '3001')],
      [stats('v1', '3001', 120_000, daysAgo(10))],
      [truck('trk_3001', '3001')],
      { accountId: ACCOUNT, now: NOW, inactiveAfterDays: 7 },
    );
    expect(plan.inactive).toHaveLength(1);
  });
});

describe('duplicates in one account', () => {
  it('keeps the copy that reported most recently and lists the others', () => {
    const plan = planSamsaraSync(
      [vehicle('old', '3001'), vehicle('new', '3001'), vehicle('older', ' 3001 ')],
      [
        stats('old', '3001', 110_000, daysAgo(5)),
        stats('new', '3001', 121_500, daysAgo(1)),
        stats('older', '3001', 105_000, daysAgo(9)),
      ],
      [truck('trk_3001', '3001')],
      { accountId: ACCOUNT, now: NOW },
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]?.externalId).toBe('new');
    expect(plan.updates[0]?.odometer).toBe(121_500);
    expect(plan.duplicates.map((l) => l.externalId).sort()).toEqual(['old', 'older']);
    expect(plan.duplicates[0]?.note).toMatch(/reported more recently/);
    expect(plan.summary.duplicates).toBe(2);
  });

  it('does not let two vehicles claim one truck through different keys', () => {
    // One matches by VIN, the other by unit number; the truck is matched once.
    const plan = planSamsaraSync(
      [vehicle('byvin', 'OLD-NAME', { vin: '1FUJGLDR8CLBP0101' }), vehicle('byname', '3001')],
      [
        stats('byvin', 'OLD-NAME', 120_000, daysAgo(1)),
        stats('byname', '3001', 119_000, daysAgo(2)),
      ],
      [truck('trk_3001', '3001')],
      { accountId: ACCOUNT, now: NOW },
    );
    expect(plan.updates.length + plan.unchanged.length).toBe(1);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0]?.note).toMatch(/already matched/);
  });
});

describe('matching', () => {
  it('prefers the remembered Samsara id, then the VIN, then the unit number', () => {
    const remembered = truck('trk_a', 'A', {
      vin: 'JHMCM56557C404453',
      telematicsAccountId: ACCOUNT,
      telematicsExternalId: 'v-remembered',
    });
    const byVin = truck('trk_b', 'B', { vin: '1FUJGLDR8CLBP0101' });
    const byName = truck('trk_c', '3003', { vin: '2HGFB2F50DH500001' });

    const plan = planSamsaraSync(
      [
        vehicle('v-remembered', 'RENAMED', { vin: null }),
        vehicle('v-vin', 'ALSO-RENAMED', { vin: '1fujgldr8clbp0101' }),
        vehicle('v-name', '3003'),
      ],
      [
        stats('v-remembered', 'RENAMED', 100_500, daysAgo(1)),
        stats('v-vin', 'ALSO-RENAMED', 100_500, daysAgo(1)),
        stats('v-name', '3003', 100_500, daysAgo(1)),
      ],
      [remembered, byVin, byName],
      { accountId: ACCOUNT, now: NOW },
    );
    const byTruck = new Map(plan.updates.map((u) => [u.truckId, u.externalId]));
    expect(byTruck.get('trk_a')).toBe('v-remembered');
    expect(byTruck.get('trk_b')).toBe('v-vin');
    expect(byTruck.get('trk_c')).toBe('v-name');
    expect(plan.summary.matched).toBe(3);
  });

  it('does not use a remembered id from a different account', () => {
    const other = truck('trk_a', 'A', { telematicsAccountId: 'int_b', telematicsExternalId: 'v1' });
    const plan = planSamsaraSync(
      [vehicle('v1', 'ZZZ')],
      [stats('v1', 'ZZZ', 100_500, daysAgo(1))],
      [other],
      { accountId: ACCOUNT, now: NOW },
    );
    expect(plan.updates).toEqual([]);
    expect(plan.unmatched).toHaveLength(1);
  });

  it('leaves a sold or inactive truck alone', () => {
    const plan = planSamsaraSync(
      [vehicle('v1', '3001')],
      [stats('v1', '3001', 200_000, daysAgo(1))],
      [truck('trk_3001', '3001', { status: 'sold' })],
      { accountId: ACCOUNT, now: NOW },
    );
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged[0]?.note).toMatch(/sold/);
  });

  it('never revives or re-creates an archived truck (owner, 2026-10-05)', () => {
    // Matched by unit number and by VIN, with createMissing on: still no update and no create.
    const plan = planSamsaraSync(
      [vehicle('v1', 'TOW1', { vin: '1FUJGLDR8CLBP0101' })],
      [stats('v1', 'TOW1', 200_000, daysAgo(1))],
      [truck('trk_tow1', 'TOW1', { status: 'archived' })],
      { accountId: ACCOUNT, now: NOW, createMissing: true },
    );
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([]);
    expect(plan.unchanged[0]?.note).toMatch(/archived/);
  });
});

describe('a parked truck', () => {
  it('still gets its newer position, and nothing when the fix is the one already stored', () => {
    const gps = {
      latitude: 41.5,
      longitude: -81.6,
      place: 'Brecksville, OH, USA',
      at: daysAgo(0.1),
      speedMph: 0,
      headingDegrees: null,
    };
    const linked = truck('trk_3001', '3001', {
      telematicsAccountId: ACCOUNT,
      telematicsExternalId: 'v1',
      locationAt: new Date(daysAgo(1)),
    });
    const plan = planSamsaraSync(
      [vehicle('v1', '3001')],
      [stats('v1', '3001', 100_000, daysAgo(1), { gps, engineState: 'off' })],
      [linked],
      { accountId: ACCOUNT, now: NOW },
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]?.odometer).toBeNull();
    expect(plan.updates[0]?.location).toMatchObject({
      city: 'Brecksville',
      state: 'OH',
      engineState: 'off',
    });
    expect(plan.updates[0]?.line.note).toBe('Position updated');

    const same = planSamsaraSync(
      [vehicle('v1', '3001')],
      [stats('v1', '3001', 100_000, daysAgo(1), { gps })],
      [{ ...linked, locationAt: new Date(gps.at) }],
      { accountId: ACCOUNT, now: NOW },
    );
    expect(same.updates).toEqual([]);
    expect(same.unchanged[0]?.note).toBe('Up to date');
  });
});

describe('the odometer', () => {
  it('moves forward with a newer reading', () => {
    const plan = planSamsaraSync(
      [vehicle('v1', '3001')],
      [stats('v1', '3001', 101_250, daysAgo(1))],
      [truck('trk_3001', '3001')],
      { accountId: ACCOUNT, now: NOW },
    );
    expect(plan.updates[0]?.odometer).toBe(101_250);
    expect(plan.updates[0]?.line.note).toMatch(/100,000 → 101,250/);
  });

  it('is never lowered: a reading well below ours is a conflict, not an update', () => {
    const plan = planSamsaraSync(
      [vehicle('v1', '3001')],
      [stats('v1', '3001', 80_000, daysAgo(1))],
      [truck('trk_3001', '3001')],
      { accountId: ACCOUNT, now: NOW },
    );
    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.note).toMatch(/below the roster/);
  });

  it('ignores a dip inside the tolerance and still links the truck', () => {
    const plan = planSamsaraSync(
      [vehicle('v1', '3001')],
      [stats('v1', '3001', 99_980, daysAgo(1))],
      [truck('trk_3001', '3001')],
      { accountId: ACCOUNT, now: NOW },
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.updates[0]?.odometer).toBeNull();
    expect(plan.updates[0]?.line.note).toMatch(/Linked/);
  });

  it('prefers the engine odometer over the GPS estimate', () => {
    const plan = planSamsaraSync(
      [vehicle('v1', '3001')],
      [
        stats('v1', '3001', 101_000, daysAgo(1), {
          gpsOdometerMiles: 140_000,
          gpsOdometerAt: daysAgo(1),
        }),
      ],
      [truck('trk_3001', '3001')],
      { accountId: ACCOUNT, now: NOW },
    );
    expect(plan.updates[0]?.odometer).toBe(101_000);
  });

  it('reports a truck that is already up to date as unchanged', () => {
    const plan = planSamsaraSync(
      [vehicle('v1', '3001')],
      [stats('v1', '3001', 100_000, daysAgo(1))],
      [
        truck('trk_3001', '3001', {
          telematicsAccountId: ACCOUNT,
          telematicsExternalId: 'v1',
          odometerAt: new Date(daysAgo(1)),
        }),
      ],
      { accountId: ACCOUNT, now: NOW },
    );
    expect(plan.unchanged).toHaveLength(1);
    expect(plan.updates).toEqual([]);
  });

  it('does not list a parked truck as an update just because the reading is newer', () => {
    // Same miles, later timestamp, already linked: nothing to say, so nothing is said.
    const plan = planSamsaraSync(
      [vehicle('v1', '3001')],
      [stats('v1', '3001', 100_000, daysAgo(0))],
      [
        truck('trk_3001', '3001', {
          telematicsAccountId: ACCOUNT,
          telematicsExternalId: 'v1',
          odometerAt: new Date(daysAgo(3)),
        }),
      ],
      { accountId: ACCOUNT, now: NOW },
    );
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged[0]?.note).toBe('Up to date');
  });

  it('lists a reading for every matched, active vehicle - parked, updated or in conflict - for the odometer history', () => {
    const plan = planSamsaraSync(
      [vehicle('v1', '3001'), vehicle('v2', '3002'), vehicle('v3', '3003'), vehicle('v4', '3004')],
      [
        stats('v1', '3001', 100_000, daysAgo(0)), // parked: unchanged
        stats('v2', '3002', 120_500, daysAgo(0)), // moved: updated
        stats('v3', '3003', 90_000, daysAgo(0)), // far below the roster: a conflict for the roster
        stats('v4', '3004', 50_000, daysAgo(0)), // sold: left alone
      ],
      [
        truck('trk_3001', '3001', {
          telematicsAccountId: ACCOUNT,
          telematicsExternalId: 'v1',
          odometerAt: new Date(daysAgo(3)),
        }),
        truck('trk_3002', '3002', { odometer: 120_000, odometerAt: new Date(daysAgo(1)) }),
        truck('trk_3003', '3003', { odometer: 100_000, odometerAt: new Date(daysAgo(1)) }),
        truck('trk_3004', '3004', { status: 'sold' }),
      ],
      { accountId: ACCOUNT, now: NOW },
    );
    expect(plan.readings.map((r) => [r.truckId, r.odometer])).toEqual([
      ['trk_3001', 100_000],
      ['trk_3002', 120_500],
      ['trk_3003', 90_000],
    ]);
    expect(plan.readings.every((r) => r.odometerAt.length > 0)).toBe(true);
  });
});

describe('creating trucks', () => {
  it('creates nothing unless the run asked for it', () => {
    const plan = planSamsaraSync(
      [vehicle('v1', '3009', { vin: '1FUJGLDR8CLBP0101' })],
      [stats('v1', '3009', 50_000, daysAgo(1))],
      [],
      { accountId: ACCOUNT, now: NOW },
    );
    expect(plan.creates).toEqual([]);
    expect(plan.unmatched[0]?.note).toMatch(/create missing/);
  });

  it('creates from a vehicle with a VIN and an odometer when asked', () => {
    const plan = planSamsaraSync(
      [vehicle('v1', '3009', { vin: '1FUJGLDR8CLBP0101', year: 2022, licensePlate: 'P123' })],
      [stats('v1', '3009', 50_000, daysAgo(1), { engineHours: 1234.5 })],
      [],
      { accountId: ACCOUNT, now: NOW, createMissing: true },
    );
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]).toMatchObject({
      unitNumber: '3009',
      vin: '1FUJGLDR8CLBP0101',
      year: 2022,
      plate: 'P123',
      odometer: 50_000,
      engineHours: 1234.5,
    });
  });

  it('refuses to create without a VIN, and says so', () => {
    const plan = planSamsaraSync(
      [vehicle('v1', '3009')],
      [stats('v1', '3009', 50_000, daysAgo(1))],
      [],
      { accountId: ACCOUNT, now: NOW, createMissing: true },
    );
    expect(plan.creates).toEqual([]);
    expect(plan.unmatched[0]?.note).toMatch(/no VIN/);
  });
});

describe('places', () => {
  it('reads city and state out of a Samsara address', () => {
    expect(placeToCityState('1850 Diehl Rd, Naperville, IL 60563')).toEqual({
      city: 'Naperville',
      state: 'IL',
    });
    expect(placeToCityState('Naperville, IL')).toEqual({ city: 'Naperville', state: 'IL' });
    expect(placeToCityState('Somewhere')).toEqual({ city: 'Somewhere', state: '' });
    expect(placeToCityState(null)).toEqual({ city: '', state: '' });
  });
  it('is not fooled by the country on the end, or a missing zip', () => {
    // What production's Samsara accounts actually send (2026-09-18): the state ended up as the city.
    expect(placeToCityState('1850 Diehl Rd, Naperville, IL 60563, USA')).toEqual({
      city: 'Naperville',
      state: 'IL',
    });
    expect(placeToCityState('Grand Prairie, TX, USA')).toEqual({
      city: 'Grand Prairie',
      state: 'TX',
    });
    expect(placeToCityState('Jasper County, IN, United States')).toEqual({
      city: 'Jasper County',
      state: 'IN',
    });
    expect(placeToCityState('PA, USA')).toEqual({ city: '', state: 'PA' });
    expect(placeToCityState('I-80, PA 17701, USA')).toEqual({ city: 'I-80', state: 'PA' });
  });
});
