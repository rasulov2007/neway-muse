import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demoData } from './data';
import { exposureOf, latestUnitExit, recordUnitExit, unitExits } from './unit-status-api';

// The status move goes through the audited path; this suite is about the account filed with it.
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, changeEntityStatus: vi.fn(async () => ({})) };
});

describe('taking a unit off the road', () => {
  const unitId = 'trk_exit_test';

  beforeEach(() => {
    demoData.unitExits.length = 0;
    const truck = demoData.trucks[0];
    if (truck) {
      const clone = { ...truck, id: unitId, unitNumber: '9999', status: 'available' as const };
      const at = demoData.trucks.findIndex((t) => t.id === unitId);
      if (at >= 0) demoData.trucks.splice(at, 1, clone);
      else demoData.trucks.push(clone);
    }
  });

  const base = {
    entity: 'truck' as const,
    unitId,
    unitNumber: '9999',
    toStatus: 'inactive',
    occurredOn: '2026-09-10',
    odometer: 482000,
    salePrice: null,
    buyer: null,
    titleTransferred: null,
    policeReport: null,
    stolenFrom: null,
    recovered: null,
    contents: [],
    damage: [],
    injuries: null,
    driverId: null,
    driverName: null,
    loadNumber: null,
    insuranceClaimNumber: null,
    insuredValue: null,
    deductible: null,
    expectedRecovery: null,
  };

  it('refuses a status change with no account of what happened', async () => {
    await expect(
      recordUnitExit({ ...base, reason: 'mechanical', narrative: '   ' }),
    ).rejects.toThrow(/say what happened/i);
    expect(demoData.unitExits).toHaveLength(0);
  });

  it('keeps what a sale fetched, against the unit', async () => {
    const record = await recordUnitExit({
      ...base,
      reason: 'sold',
      narrative: 'Sold at auction after the second engine failure.',
      salePrice: 38000,
      buyer: 'Midwest Truck Sales',
      titleTransferred: true,
      expectedRecovery: 38000,
    });

    expect(latestUnitExit(unitId)?.id).toBe(record.id);
    expect(record.salePrice).toBe(38000);
    // Money coming in is not exposure.
    expect(exposureOf(record)).toBe(-38000);
  });

  it('counts what was stolen and not recovered, but not what came back', async () => {
    const record = await recordUnitExit({
      ...base,
      reason: 'stolen',
      narrative: 'Taken overnight from the fuel island.',
      policeReport: 'CPD-2026-88142',
      contents: [
        { label: 'Pallet jack', value: 600, recovered: false },
        { label: 'Load bars', value: 240, recovered: true },
        { label: "Driver's tools", value: 1800, recovered: false },
      ],
      expectedRecovery: 1000,
    });

    // 600 + 1800 lost, 240 recovered, less 1000 expected from the claim.
    expect(exposureOf(record)).toBe(1400);
    expect(record.policeReport).toBe('CPD-2026-88142');
  });

  it('adds repair estimates for a wreck and keeps every account on the unit', async () => {
    await recordUnitExit({
      ...base,
      reason: 'accident',
      narrative: 'Rear-ended on I-65; frame bent behind the cab.',
      damage: [
        { part: 'Frame', note: 'Bent beyond repair', repairable: false, estimate: 14000 },
        { part: 'Cab', note: 'Rear wall crushed', repairable: true, estimate: 6500 },
      ],
      contents: [{ label: 'Freight on board', value: 9000, recovered: false }],
      injuries: false,
      expectedRecovery: 20000,
    });

    const record = latestUnitExit(unitId);
    expect(record).toBeTruthy();
    expect(exposureOf(record!)).toBe(9500);
    expect(unitExits(unitId)).toHaveLength(1);
  });

  it('lets go of the driver, trailer and load when the unit leaves the road', async () => {
    const truck = demoData.trucks.find((t) => t.id === unitId);
    const driver = demoData.drivers[0];
    if (!truck || !driver) throw new Error('fixture');

    truck.currentDriverId = driver.id;
    truck.currentDriverName = driver.name;
    truck.currentTrailerId = 'trl_x';
    truck.currentLoadId = 'ld_x';
    driver.currentTruckId = unitId;
    driver.currentTruckUnit = truck.unitNumber;

    const load = demoData.loads[0];
    if (load) {
      load.truckId = unitId;
      load.truckUnit = truck.unitNumber;
      load.status = 'in_transit';
    }

    await recordUnitExit({
      ...base,
      reason: 'sold',
      narrative: 'Sold to a neighbouring carrier.',
      salePrice: 41000,
    });

    expect(truck.currentDriverId).toBeNull();
    expect(truck.currentTrailerId).toBeNull();
    expect(truck.currentLoadId).toBeNull();
    expect(driver.currentTruckId).toBeNull();
    if (load) expect(load.truckId).toBeNull();
  });
});
