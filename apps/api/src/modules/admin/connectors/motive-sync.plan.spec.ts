import { describe, expect, it } from 'vitest';
import { motivePlace, planMotiveSync } from './motive-sync.plan';
import type { MotiveVehicle, MotiveVehicleLocation } from './motive.client';
import { planSamsaraSync, type TruckSnapshot } from './samsara-sync.plan';

const NOW = new Date('2026-10-20T12:00:00Z');
const ACCOUNT = 'int_motive';
const SAMSARA = 'int_samsara';
const VIN_A = '1FUJGLDR8CLBP0101';
const VIN_B = '3AKJHHDR5NSNA1234';

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function vehicle(id: string, name: string, extra: Partial<MotiveVehicle> = {}): MotiveVehicle {
  return {
    id,
    name,
    vin: null,
    make: 'Freightliner',
    model: 'Cascadia',
    year: 2022,
    licensePlate: null,
    licensePlateState: null,
    status: 'active',
    updatedAt: null,
    ...extra,
  };
}

function loc(id: string, name: string, miles: number | null, at: string | null, extra: Partial<MotiveVehicleLocation> = {}): MotiveVehicleLocation {
  return {
    id,
    name,
    odometerMiles: miles,
    engineHours: null,
    at,
    latitude: 41.7,
    longitude: -88.1,
    place: 'Naperville, IL',
    speedMph: 0,
    headingDegrees: null,
    engineState: 'off',
    ...extra,
  };
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
    telematicsProvider: 'Motive',
    locationAt: null,
    ...extra,
  };
}

const options = { accountId: ACCOUNT, now: NOW };

describe('matching', () => {
  it('matches by VIN first, then by unit number, and links the Motive id', () => {
    const plan = planMotiveSync(
      [vehicle('m1', 'ZZZ', { vin: VIN_A }), vehicle('m2', '3002')],
      [loc('m1', 'ZZZ', 100_500, daysAgo(1)), loc('m2', '3002', 90_500, daysAgo(1))],
      [truck('trk_3001', '3001', { vin: VIN_A }), truck('trk_3002', '3002', { vin: VIN_B, odometer: 90_000 })],
      options,
    );
    const linked = new Map(plan.updates.map((u) => [u.truckId, u.externalId]));
    expect(linked.get('trk_3001')).toBe('m1');
    expect(linked.get('trk_3002')).toBe('m2');
    expect(plan.summary.matched).toBe(2);
    expect(plan.updates.find((u) => u.truckId === 'trk_3001')?.line.note).toMatch(/Motive calls it "ZZZ"/);
  });

  it('never creates a duplicate: a matched unit is updated, and createMissing creates only the unknown one', () => {
    const plan = planMotiveSync(
      [vehicle('m1', '3001', { vin: VIN_A }), vehicle('m9', '3009', { vin: VIN_B })],
      [loc('m1', '3001', 100_500, daysAgo(1)), loc('m9', '3009', 50_000, daysAgo(1))],
      [truck('trk_3001', '3001')],
      { ...options, createMissing: true },
    );
    expect(plan.creates.map((c) => c.unitNumber)).toEqual(['3009']);
    expect(plan.creates[0]?.line.note).toBe('Created from Motive');
    expect(plan.updates.map((u) => u.truckId)).toEqual(['trk_3001']);
  });

  it('reports the same unit number twice in Motive as a duplicate, newest reading wins', () => {
    const plan = planMotiveSync(
      [vehicle('old', '3001'), vehicle('new', '3001')],
      [loc('old', '3001', 100_100, daysAgo(5)), loc('new', '3001', 100_200, daysAgo(1))],
      [truck('trk_3001', '3001', { vin: '' })],
      options,
    );
    expect(plan.updates.map((u) => u.externalId)).toEqual(['new']);
    expect(plan.duplicates.map((l) => l.externalId)).toEqual(['old']);
  });

  it('two Motive vehicles for one truck: the second is a duplicate, not a second link', () => {
    const plan = planMotiveSync(
      [vehicle('m1', 'A', { vin: VIN_A }), vehicle('m2', '3001')],
      [loc('m1', 'A', 100_500, daysAgo(1)), loc('m2', '3001', 100_600, daysAgo(1))],
      [truck('trk_3001', '3001')],
      options,
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.duplicates).toHaveLength(1);
  });

  it('treats a vehicle Motive marks deactivated as inactive, never matched', () => {
    const plan = planMotiveSync(
      [vehicle('m1', '3001', { status: 'deactivated', vin: VIN_A })],
      [loc('m1', '3001', 200_000, daysAgo(1))],
      [truck('trk_3001', '3001')],
      { ...options, createMissing: true },
    );
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([]);
    expect(plan.inactive[0]?.note).toBe('Deactivated in Motive');
    expect(plan.summary).toMatchObject({ fetched: 1, inactive: 1, matched: 0 });
  });
});

describe('values', () => {
  it('moves the odometer forward only, and reports a big drop as a conflict', () => {
    const plan = planMotiveSync(
      [vehicle('m1', '3001'), vehicle('m2', '3002')],
      [loc('m1', '3001', 100_900, daysAgo(1)), loc('m2', '3002', 80_000, daysAgo(1))],
      [truck('trk_3001', '3001', { vin: '' }), truck('trk_3002', '3002', { vin: '' })],
      options,
    );
    expect(plan.updates.map((u) => [u.truckId, u.odometer])).toEqual([['trk_3001', 100_900]]);
    expect(plan.conflicts.map((l) => l.unitNumber)).toEqual(['3002']);
    expect(plan.conflicts[0]?.note).toMatch(/Motive reads 80,000 mi/);
  });

  it('never writes an unknown over a known: a missing odometer or fix stays unwritten', () => {
    const plan = planMotiveSync(
      [vehicle('m1', '3001'), vehicle('m2', '3002')],
      [
        // A fix but no odometer and no engine hours.
        loc('m1', '3001', null, daysAgo(1)),
        // An odometer but no fix.
        loc('m2', '3002', 100_700, daysAgo(1), { latitude: null, longitude: null }),
      ],
      [truck('trk_3001', '3001', { vin: '' }), truck('trk_3002', '3002', { vin: '' })],
      options,
    );
    const a = plan.updates.find((u) => u.truckId === 'trk_3001');
    const b = plan.updates.find((u) => u.truckId === 'trk_3002');
    expect(a).toMatchObject({ odometer: null, odometerAt: null, engineHours: null });
    expect(a?.location).not.toBeNull();
    expect(b).toMatchObject({ odometer: 100_700, engineHours: null, location: null });
    expect(plan.readings.map((r) => r.truckId)).toEqual(['trk_3002']);
  });

  it('a vehicle with no location time at all is inactive, not zeroed', () => {
    const plan = planMotiveSync([vehicle('m1', '3001')], [loc('m1', '3001', 120_000, null)], [truck('trk_3001', '3001')], options);
    expect(plan.inactive).toHaveLength(1);
    expect(plan.updates).toEqual([]);
  });

  it('turns the location into the roster shape, with the distance prefix dropped', () => {
    const plan = planMotiveSync(
      [vehicle('m1', '3001')],
      [loc('m1', '3001', 100_500, daysAgo(1), { place: '3.2 mi NE of Naperville, IL', speedMph: 60, engineState: 'on', headingDegrees: 90 })],
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
    expect(motivePlace('12 mi SW of Gary, IN')).toBe('Gary, IN');
    expect(motivePlace('Seattle, WA')).toBe('Seattle, WA');
  });
});

describe('Samsara and Motive in one company', () => {
  const samsaraTruck = truck('trk_3001', '3001', {
    telematicsAccountId: SAMSARA,
    telematicsExternalId: 's1',
    telematicsProvider: 'samsara',
    locationAt: new Date(daysAgo(0.1)),
  });

  it('Motive leaves a truck that a live Samsara account reports alone', () => {
    const plan = planMotiveSync([vehicle('m1', '3001', { vin: VIN_A })], [loc('m1', '3001', 200_000, daysAgo(0))], [samsaraTruck], options);
    expect(plan.updates).toEqual([]);
    expect(plan.readings).toEqual([]);
    expect(plan.unchanged[0]?.note).toMatch(/Reported by its Samsara account.*left alone/);
  });

  it('Samsara leaves a truck that a live Motive account reports alone', () => {
    const motiveTruck = truck('trk_3001', '3001', {
      telematicsAccountId: ACCOUNT,
      telematicsExternalId: 'm1',
      telematicsProvider: 'motive',
      locationAt: new Date(daysAgo(0.1)),
    });
    const plan = planSamsaraSync(
      [{ id: 's1', name: '3001', vin: VIN_A, make: null, model: null, year: null, licensePlate: null, updatedAt: null }],
      [{ id: 's1', name: '3001', obdOdometerMiles: 200_000, obdOdometerAt: daysAgo(0), gpsOdometerMiles: null, gpsOdometerAt: null, engineHours: null, engineHoursAt: null, gps: null, engineState: null, engineStateAt: null }],
      [motiveTruck],
      { accountId: SAMSARA, now: NOW },
    );
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged[0]?.note).toMatch(/Reported by its Motive account/);
  });

  it('takes over a truck whose Samsara account has gone silent past the inactive window', () => {
    const quiet = { ...samsaraTruck, locationAt: new Date(daysAgo(45)) };
    const plan = planMotiveSync([vehicle('m1', '3001', { vin: VIN_A })], [loc('m1', '3001', 100_500, daysAgo(0))], [quiet], options);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]?.externalId).toBe('m1');
    expect(plan.updates[0]?.line.note).toMatch(/Taken over from Samsara, silent for 45 days/);
  });

  it('two Samsara accounts keep their old behaviour (the guard is between providers only)', () => {
    const other = truck('trk_3001', '3001', { telematicsAccountId: 'int_samsara_2', telematicsExternalId: 'x', telematicsProvider: 'samsara', locationAt: new Date(daysAgo(0)) });
    const plan = planSamsaraSync(
      [{ id: 's1', name: '3001', vin: VIN_A, make: null, model: null, year: null, licensePlate: null, updatedAt: null }],
      [{ id: 's1', name: '3001', obdOdometerMiles: 100_500, obdOdometerAt: daysAgo(0), gpsOdometerMiles: null, gpsOdometerAt: null, engineHours: null, engineHoursAt: null, gps: null, engineState: null, engineStateAt: null }],
      [other],
      { accountId: SAMSARA, now: NOW },
    );
    expect(plan.updates).toHaveLength(1);
  });

  it('a hand-typed "Motive" on an unlinked truck does not block either sync', () => {
    const plan = planSamsaraSync(
      [{ id: 's1', name: '3001', vin: VIN_A, make: null, model: null, year: null, licensePlate: null, updatedAt: null }],
      [{ id: 's1', name: '3001', obdOdometerMiles: 100_500, obdOdometerAt: daysAgo(0), gpsOdometerMiles: null, gpsOdometerAt: null, engineHours: null, engineHoursAt: null, gps: null, engineState: null, engineStateAt: null }],
      [truck('trk_3001', '3001', { telematicsProvider: 'Motive' })],
      { accountId: SAMSARA, now: NOW },
    );
    expect(plan.updates).toHaveLength(1);
  });
});
