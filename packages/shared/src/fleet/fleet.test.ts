import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAINTENANCE_POLICY,
  buildFleetExceptions,
  maintenanceDue,
  summarizeFuel,
  summarizeUnitEconomics,
  summarizeUnitFuel,
  unitAvailability,
  type ExceptionTruck,
  type FuelFill,
} from './index.js';

const TODAY = '2026-09-06';

describe('unitAvailability', () => {
  it('reports a free unit as dispatchable', () => {
    const result = unitAvailability({ status: 'available', currentLoadId: null });
    expect(result.availability).toBe('available');
    expect(result.dispatchable).toBe(true);
  });

  it('separates assigned from in transit on speed', () => {
    const stopped = unitAvailability({ status: 'driving', currentLoadId: 'ld_1', speedMph: 0 });
    const moving = unitAvailability({ status: 'driving', currentLoadId: 'ld_1', speedMph: 58 });
    expect(stopped.availability).toBe('assigned');
    expect(moving.availability).toBe('in_transit');
  });

  it('lets a shop hold outrank whatever the unit was doing', () => {
    const result = unitAvailability({
      status: 'driving',
      currentLoadId: 'ld_1',
      speedMph: 60,
      inOpenWorkOrder: true,
    });
    expect(result.availability).toBe('in_maintenance');
    expect(result.dispatchable).toBe(false);
  });

  it('never quietly calls an unrecognised status available', () => {
    const result = unitAvailability({ status: 'wat', currentLoadId: null });
    expect(result.availability).toBe('unknown');
    expect(result.dispatchable).toBe(false);
    expect(result.reasons[0]).toContain('wat');
  });

  it('reports a status/load disagreement rather than guessing which is stale', () => {
    const result = unitAvailability({ status: 'dispatched', currentLoadId: null });
    expect(result.availability).toBe('assigned');
    expect(result.reasons[0]).toContain('no load is attached');
  });

  it('treats sold units as retired, not merely out of service', () => {
    expect(unitAvailability({ status: 'sold' }).availability).toBe('retired');
    expect(unitAvailability({ status: 'out_of_service' }).availability).toBe('out_of_service');
  });

  // Owner, 2026-10-22: 137 trucks with an open driver assignment all read Available.
  describe('an open driver assignment', () => {
    it('turns an otherwise free unit into assigned, still dispatchable', () => {
      for (const status of ['available', 'active', 'idle']) {
        const result = unitAvailability({ status, driverAssigned: true });
        expect(result.availability).toBe('assigned');
        expect(result.dispatchable).toBe(true);
        expect(result.reasons[0]).toContain('Driver assigned');
      }
    });

    it('leaves a free unit with nobody in it available', () => {
      expect(unitAvailability({ status: 'available', driverAssigned: false }).availability).toBe(
        'available',
      );
      expect(unitAvailability({ status: 'available' }).availability).toBe('available');
    });

    it('never outranks a hold, a load in motion or an unknown status', () => {
      const withDriver = { driverAssigned: true } as const;
      expect(unitAvailability({ ...withDriver, status: 'inactive' }).availability).toBe('inactive');
      expect(unitAvailability({ ...withDriver, status: 'sold' }).availability).toBe('retired');
      expect(unitAvailability({ ...withDriver, status: 'out_of_service' }).availability).toBe(
        'out_of_service',
      );
      expect(unitAvailability({ ...withDriver, status: 'in_shop' }).availability).toBe(
        'in_maintenance',
      );
      expect(
        unitAvailability({ ...withDriver, status: 'available', inOpenWorkOrder: true }).availability,
      ).toBe('in_maintenance');
      expect(
        unitAvailability({ ...withDriver, status: 'available', documentHold: 'Registration expired' })
          .availability,
      ).toBe('out_of_service');
      expect(
        unitAvailability({ ...withDriver, status: 'driving', currentLoadId: 'ld_1', speedMph: 60 })
          .availability,
      ).toBe('in_transit');
      expect(unitAvailability({ ...withDriver, status: 'wat' }).availability).toBe('unknown');
    });
  });
});

describe('maintenanceDue', () => {
  it('binds on whichever limit runs out first', () => {
    // Plenty of miles left, but the calendar is nearly up.
    const byDays = maintenanceDue(
      {
        nextDueOdometer: 500_000,
        currentOdometer: 400_000,
        nextDueAt: '2026-09-10',
      },
      TODAY,
    );
    expect(byDays.urgency).toBe('due_soon');
    expect(byDays.basis).toBe('days');

    // Plenty of calendar, but the odometer is nearly up.
    const byMiles = maintenanceDue(
      {
        nextDueOdometer: 401_000,
        currentOdometer: 400_000,
        nextDueAt: '2027-01-01',
      },
      TODAY,
    );
    expect(byMiles.urgency).toBe('due_soon');
    expect(byMiles.basis).toBe('miles');
  });

  it('is unknown, not ok, when no interval is recorded', () => {
    const result = maintenanceDue({ currentOdometer: 400_000 }, TODAY);
    expect(result.urgency).toBe('unknown');
    expect(result.milesRemaining).toBeNull();
    expect(result.daysRemaining).toBeNull();
  });

  it('drops the mileage limit when the unit has no odometer, keeping the calendar', () => {
    const result = maintenanceDue({ nextDueOdometer: 401_000, nextDueAt: '2027-01-01' }, TODAY);
    expect(result.milesRemaining).toBeNull();
    expect(result.urgency).toBe('ok');
    expect(result.basis).toBe('days');
  });

  it('still calls an already-past unit overdue even when the repair is booked', () => {
    const result = maintenanceDue(
      {
        nextDueOdometer: 399_000,
        currentOdometer: 400_000,
        nextDueAt: '2026-08-01',
        scheduledFor: '2026-09-12',
      },
      TODAY,
    );
    expect(result.urgency).toBe('overdue');
    expect(result.summary).toContain('booked for 2026-09-12');
  });

  it('reports scheduled when work is booked and nothing is past due', () => {
    const result = maintenanceDue(
      {
        nextDueOdometer: 401_000,
        currentOdometer: 400_000,
        nextDueAt: '2026-09-08',
        scheduledFor: '2026-09-07',
      },
      TODAY,
      DEFAULT_MAINTENANCE_POLICY,
    );
    expect(result.urgency).toBe('scheduled');
  });
});

function fill(over: Partial<FuelFill> & Pick<FuelFill, 'id' | 'at' | 'odometer'>): FuelFill {
  return {
    truckId: 'trk_1',
    product: 'diesel',
    gallons: 100,
    pricePerGallon: 4,
    amount: 400,
    ...over,
  };
}

describe('summarizeFuel', () => {
  it('measures MPG between consecutive fills, charging the earlier fill for the distance', () => {
    const result = summarizeUnitFuel('trk_1', [
      fill({ id: 'f1', at: '2026-09-01T08:00:00Z', odometer: 400_000, gallons: 100 }),
      fill({ id: 'f2', at: '2026-09-03T08:00:00Z', odometer: 400_700, gallons: 90 }),
    ]);
    // 700 miles on the 100 gallons the first fill put in.
    expect(result.mpg).toBe(7);
    expect(result.measuredMiles).toBe(700);
  });

  it('gives a unit with one fill no MPG rather than a made-up one', () => {
    const result = summarizeUnitFuel('trk_1', [
      fill({ id: 'f1', at: '2026-09-01T08:00:00Z', odometer: 400_000 }),
    ]);
    expect(result.mpg).toBeNull();
    expect(result.costPerMile).toBeNull();
    expect(result.spend).toBe(400);
  });

  it('discards an implausible pair instead of averaging it in', () => {
    const result = summarizeFuel([
      fill({ id: 'f1', at: '2026-09-01T08:00:00Z', odometer: 400_000, gallons: 100 }),
      // Odometer jumps 50,000 miles in two days — a typo, not a run.
      fill({ id: 'f2', at: '2026-09-03T08:00:00Z', odometer: 450_000, gallons: 100 }),
      fill({ id: 'f3', at: '2026-09-05T08:00:00Z', odometer: 450_650, gallons: 100 }),
    ]);
    expect(result.discardedPairs).toBe(1);
    expect(result.measuredMiles).toBe(650);
  });

  it('keeps DEF in spend but out of gallons and MPG', () => {
    const result = summarizeFuel([
      fill({ id: 'f1', at: '2026-09-01T08:00:00Z', odometer: 400_000, gallons: 100 }),
      fill({ id: 'f2', at: '2026-09-03T08:00:00Z', odometer: 400_700, gallons: 100 }),
      fill({
        id: 'f3',
        at: '2026-09-03T08:05:00Z',
        odometer: 400_700,
        product: 'def',
        gallons: 10,
        pricePerGallon: 3,
        amount: 30,
      }),
    ]);
    expect(result.spend).toBe(830);
    expect(result.gallons).toBe(200);
    expect(result.avgMpg).toBe(7);
  });

  it('names the units it could not measure', () => {
    const result = summarizeFuel([
      fill({ id: 'f1', truckId: 'trk_9', at: '2026-09-01T08:00:00Z', odometer: 0 }),
    ]);
    expect(result.avgMpg).toBeNull();
    expect(result.unitsWithoutMpg).toEqual(['trk_9']);
  });
});

describe('summarizeUnitEconomics', () => {
  const costs = { fuel: 700, driverPay: 600, tolls: 40, maintenanceAllocation: 200, other: 10 };

  it('prices deadhead before rolling up, so a repositioning-heavy unit does not flatter itself', () => {
    const tight = summarizeUnitEconomics([
      { id: 'l1', status: 'delivered', revenue: 2600, loadedMiles: 1000, emptyMiles: 20, costs },
    ]);
    const loose = summarizeUnitEconomics([
      { id: 'l2', status: 'delivered', revenue: 2600, loadedMiles: 1000, emptyMiles: 600, costs },
    ]);
    expect(tight.profit).not.toBeNull();
    expect(loose.profit).not.toBeNull();
    expect(loose.profit as number).toBeLessThan(tight.profit as number);
    expect(loose.deadheadPct).toBeGreaterThan(tight.deadheadPct as number);
  });

  it('returns nulls, never zeros, when nothing could be priced', () => {
    const result = summarizeUnitEconomics([
      {
        id: 'l1',
        status: 'in_transit',
        revenue: null,
        loadedMiles: 500,
        emptyMiles: 0,
        costs: null,
      },
    ]);
    expect(result.revenue).toBeNull();
    expect(result.profit).toBeNull();
    expect(result.marginPct).toBeNull();
    expect(result.coverage).toEqual({ loads: 1, priced: 0, cancelled: 0 });
  });

  it('excludes cancelled loads from money but still counts them', () => {
    const result = summarizeUnitEconomics([
      { id: 'l1', status: 'delivered', revenue: 2600, loadedMiles: 1000, emptyMiles: 20, costs },
      { id: 'l2', status: 'cancelled', revenue: 5000, loadedMiles: 1000, emptyMiles: 0, costs },
    ]);
    expect(result.coverage).toEqual({ loads: 1, priced: 1, cancelled: 1 });
    expect(result.revenue).toBe(2600);
  });

  it('reports coverage so the caller can say how many loads the figure rests on', () => {
    const result = summarizeUnitEconomics([
      { id: 'l1', status: 'delivered', revenue: 2600, loadedMiles: 1000, emptyMiles: 20, costs },
      {
        id: 'l2',
        status: 'delivered',
        revenue: null,
        loadedMiles: null,
        emptyMiles: null,
        costs: null,
      },
    ]);
    expect(result.coverage.loads).toBe(2);
    expect(result.coverage.priced).toBe(1);
  });
});

function truck(over: Partial<ExceptionTruck> & Pick<ExceptionTruck, 'id'>): ExceptionTruck {
  return {
    unitNumber: over.id,
    status: 'available',
    currentLoadId: null,
    odometer: 400_000,
    nextServiceOdometer: 420_000,
    nextServiceDate: '2027-01-01',
    ...over,
  };
}

describe('buildFleetExceptions', () => {
  const empty = { trucks: [], trailers: [], workOrders: [] };

  it('produces no items for a clean fleet, so the panel can disappear', () => {
    const result = buildFleetExceptions(
      { ...empty, trucks: [truck({ id: 'trk_1', currentLoadId: 'ld_1', status: 'driving' })] },
      TODAY,
    );
    expect(result.items).toHaveLength(0);
  });

  it('carries the ids behind every count so a tile and its list cannot drift', () => {
    const result = buildFleetExceptions(
      {
        ...empty,
        trucks: [
          truck({ id: 'trk_1', odometer: 425_000 }),
          truck({ id: 'trk_2', odometer: 430_000 }),
          truck({ id: 'trk_3', currentLoadId: 'ld_1', status: 'driving' }),
        ],
      },
      TODAY,
    );
    const overdue = result.items.find((i) => i.key === 'maintenance_overdue');
    expect(overdue?.count).toBe(2);
    expect(overdue?.ids).toEqual(['trk_1', 'trk_2']);
    expect(overdue?.count).toBe(overdue?.ids.length);
  });

  it('sorts critical findings above warnings', () => {
    const result = buildFleetExceptions(
      {
        ...empty,
        trucks: [truck({ id: 'trk_1', status: 'out_of_service' }), truck({ id: 'trk_2' })],
      },
      TODAY,
    );
    expect(result.items[0]?.severity).toBe('critical');
  });

  it('declares the fuel trend unavailable rather than reporting a 0% change', () => {
    const result = buildFleetExceptions({ ...empty, costPerMile: 0.62 }, TODAY);
    expect(result.items.find((i) => i.key === 'fuel_cost_per_mile_up')).toBeUndefined();
    expect(result.unavailable.map((u) => u.key)).toContain('fuel_cost_trend');
  });

  it('raises a cost-per-mile jump only when both windows were measured', () => {
    const result = buildFleetExceptions(
      { ...empty, costPerMile: 0.67, priorCostPerMile: 0.62 },
      TODAY,
    );
    const item = result.items.find((i) => i.key === 'fuel_cost_per_mile_up');
    expect(item?.label).toContain('8%');
  });

  it('flags work orders past their promised date', () => {
    const result = buildFleetExceptions(
      {
        ...empty,
        workOrders: [
          {
            id: 'ro_1',
            roNumber: 'RO-1',
            status: 'in_shop',
            promisedAt: '2026-09-01T00:00:00Z',
            completedAt: null,
          },
          {
            id: 'ro_2',
            roNumber: 'RO-2',
            status: 'in_shop',
            promisedAt: '2026-09-20T00:00:00Z',
            completedAt: null,
          },
          {
            id: 'ro_3',
            roNumber: 'RO-3',
            status: 'completed',
            promisedAt: '2026-09-01T00:00:00Z',
            completedAt: '2026-09-02T00:00:00Z',
          },
        ],
      },
      TODAY,
    );
    const item = result.items.find((i) => i.key === 'work_orders_past_promise');
    expect(item?.ids).toEqual(['ro_1']);
  });
});
