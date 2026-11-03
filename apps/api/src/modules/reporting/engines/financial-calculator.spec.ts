import { describe, expect, it } from 'vitest';
import { compareFinancials, compareMetric, computeFinancials } from './financial-calculator';
import { expense, makeFacts, mileage, revenue, truck } from './fixtures';
import { FINANCIAL_METRIC_KEYS } from './types';

describe('computeFinancials', () => {
  it('computes gross, cost, operating profit and unit economics from load miles', () => {
    const result = computeFinancials(makeFacts());
    expect(result.gross).toBe(4000.75);
    expect(result.cost).toBe(2100);
    expect(result.costEstimated).toBe(0);
    expect(result.operatingProfit).toBe(1900.75);
    expect(result.totalMiles).toBe(1870);
    expect(result.milesSource).toBe('loads');
    expect(result.rpm).toBe(2.1394);
    expect(result.cpm).toBe(1.123);
    expect(result.ppm).toBe(1.0164);
    expect(result.marginPct).toBe(47.5);
    expect(result.hasExpenseData).toBe(true);
    expect(result.reasons.cost).toEqual([]);
    expect(result.reasons.rpm).toEqual([]);
  });

  it('breaks cost down by category with estimated portion and share of cost', () => {
    const result = computeFinancials(makeFacts());
    expect(result.costBreakdown).toEqual([
      { category: 'fuel', amount: 1200, estimated: 0, shareOfCostPct: 57.1 },
      { category: 'driver_pay', amount: 600, estimated: 0, shareOfCostPct: 28.6 },
      { category: 'insurance', amount: 300, estimated: 0, shareOfCostPct: 14.3 },
    ]);
  });

  it('treats zero revenue as a real zero, not null', () => {
    const result = computeFinancials(makeFacts({ revenue: [] }));
    expect(result.gross).toBe(0);
    expect(result.cost).toBe(2100);
    expect(result.operatingProfit).toBe(-2100);
    expect(result.marginPct).toBeNull();
    expect(result.reasons.marginPct).toEqual(['zero_gross']);
    expect(result.activeTrucks).toBe(0);
    expect(result.avgGrossPerTruck).toBeNull();
    expect(result.reasons.avgGrossPerTruck).toEqual(['no_active_trucks']);
  });

  it('returns null rpm/cpm/ppm with zero_miles when miles are recorded as 0', () => {
    const result = computeFinancials(
      makeFacts({
        revenue: [revenue({ loadId: 'A', loadedMiles: 0, emptyMiles: 0 })],
      }),
    );
    expect(result.totalMiles).toBe(0);
    expect(result.rpm).toBeNull();
    expect(result.cpm).toBeNull();
    expect(result.ppm).toBeNull();
    expect(result.reasons.rpm).toEqual(['zero_miles']);
    expect(result.reasons.cpm).toEqual(['zero_miles']);
    expect(result.reasons.totalMiles).toEqual([]);
  });

  it('returns null miles with no_mileage_data when there are no mileage records or loads', () => {
    const result = computeFinancials(makeFacts({ revenue: [], mileage: [] }));
    expect(result.totalMiles).toBeNull();
    expect(result.milesSource).toBeNull();
    expect(result.rpm).toBeNull();
    expect(result.reasons.totalMiles).toEqual(['no_mileage_data']);
    expect(result.reasons.rpm).toEqual(['no_mileage_data']);
    expect(result.reasons.avgMilesPerTruck).toEqual(['no_mileage_data', 'no_active_trucks']);
  });

  it('prefers odometer mileage records over load miles when any exist', () => {
    const result = computeFinancials(
      makeFacts({
        mileage: [mileage({ truckId: 'T1', miles: 1000 }), mileage({ truckId: 'T2', miles: 1500 })],
      }),
    );
    expect(result.totalMiles).toBe(2500);
    expect(result.milesSource).toBe('odometer');
    expect(result.rpm).toBe(1.6003);
  });

  it('reports cost, profit, margin, cpm and ppm as null (not zero) with no expense data', () => {
    const result = computeFinancials(
      makeFacts({
        expenses: [],
        expenseCoverage: [{ weekStart: '2026-08-31', hasExpenseData: false }],
      }),
    );
    expect(result.gross).toBe(4000.75);
    expect(result.cost).toBeNull();
    expect(result.costEstimated).toBe(0);
    expect(result.costBreakdown).toEqual([]);
    expect(result.operatingProfit).toBeNull();
    expect(result.inactiveTruckLoss).toBeNull();
    expect(result.netOperatingProfit).toBeNull();
    expect(result.marginPct).toBeNull();
    expect(result.cpm).toBeNull();
    expect(result.ppm).toBeNull();
    expect(result.rpm).toBe(2.1394);
    expect(result.avgCostPerTruck).toBeNull();
    expect(result.avgGrossPerTruck).toBe(2000.38);
    expect(result.hasExpenseData).toBe(false);
    for (const key of [
      'cost',
      'operatingProfit',
      'netOperatingProfit',
      'cpm',
      'ppm',
      'marginPct',
    ] as const) {
      expect(result.reasons[key]).toContain('no_expense_data');
    }
    expect(result.inactiveTruckRows).toEqual([]);
  });

  it('treats coverage flags without any expense lines as no expense data', () => {
    const result = computeFinancials(makeFacts({ expenses: [] }));
    expect(result.cost).toBeNull();
    expect(result.reasons.cost).toEqual(['no_expense_data']);
  });

  it('treats expense lines without any covered week as no expense data', () => {
    const result = computeFinancials(makeFacts({ expenseCoverage: [] }));
    expect(result.cost).toBeNull();
  });

  it('computes a numeric cost when only some weeks have expense data', () => {
    const result = computeFinancials(
      makeFacts({
        expenseCoverage: [
          { weekStart: '2026-08-24', hasExpenseData: false },
          { weekStart: '2026-08-31', hasExpenseData: true },
        ],
      }),
    );
    expect(result.cost).toBe(2100);
    expect(result.hasExpenseData).toBe(true);
  });

  it('flags inactive trucks with cost and subtracts their loss for net operating profit', () => {
    const facts = makeFacts({
      expenses: [
        ...makeFacts().expenses,
        expense({ id: 'E5', category: 'insurance', amount: 250.5, truckId: 'T3' }),
        expense({ id: 'E6', category: 'fuel', amount: 49.5, truckId: 'T3', source: 'fuel' }),
      ],
    });
    const result = computeFinancials(facts);
    expect(result.cost).toBe(2400);
    expect(result.operatingProfit).toBe(1600.75);
    expect(result.inactiveTruckRows).toEqual([
      { truckId: 'T3', unitNumber: '103', cost: 300, gross: 0 },
    ]);
    expect(result.inactiveTruckLoss).toBe(300);
    expect(result.netOperatingProfit).toBe(1300.75);
    expect(result.activeTrucks).toBe(2);
    expect(result.inactiveTrucks).toBe(1);
  });

  it('excludes sold trucks from inactive trucks and inactive loss', () => {
    const facts = makeFacts({
      expenses: [
        ...makeFacts().expenses,
        expense({ id: 'E7', category: 'repairs', amount: 999, truckId: 'T9' }),
      ],
    });
    const result = computeFinancials(facts);
    expect(result.inactiveTrucks).toBe(1);
    expect(result.inactiveTruckRows).toEqual([]);
    expect(result.inactiveTruckLoss).toBe(0);
    expect(result.cost).toBe(3099);
  });

  it('never turns company-level expenses (no truck) into inactive truck loss', () => {
    const facts = makeFacts({
      trucks: [truck({ truckId: 'T5', unitNumber: '105', status: 'idle' })],
      revenue: [],
      expenses: [expense({ id: 'E8', category: 'insurance', amount: 5000, truckId: null })],
    });
    const result = computeFinancials(facts);
    expect(result.cost).toBe(5000);
    expect(result.inactiveTrucks).toBe(1);
    expect(result.inactiveTruckRows).toEqual([]);
    expect(result.inactiveTruckLoss).toBe(0);
    expect(result.netOperatingProfit).toBe(-5000);
  });

  it('separates the estimated portion of cost', () => {
    const facts = makeFacts({
      expenses: [
        expense({ id: 'E1', category: 'fuel', amount: 500, source: 'fuel' }),
        expense({
          id: 'E2',
          category: 'driver_pay',
          amount: 400,
          driverId: 'D1',
          source: 'estimate',
          isEstimate: true,
        }),
        expense({
          id: 'E3',
          category: 'driver_pay',
          amount: 100,
          driverId: 'D2',
          source: 'settlement',
        }),
      ],
    });
    const result = computeFinancials(facts);
    expect(result.cost).toBe(1000);
    expect(result.costEstimated).toBe(400);
    const driverPay = result.costBreakdown.find((entry) => entry.category === 'driver_pay');
    expect(driverPay).toEqual({
      category: 'driver_pay',
      amount: 500,
      estimated: 400,
      shareOfCostPct: 50,
    });
  });

  it('divides averages by active trucks only', () => {
    const result = computeFinancials(makeFacts());
    expect(result.averagesBasis).toBe('active_trucks');
    expect(result.activeTrucks).toBe(2);
    expect(result.avgGrossPerTruck).toBe(2000.38);
    expect(result.avgCostPerTruck).toBe(1050);
    expect(result.avgProfitPerTruck).toBe(950.38);
    expect(result.avgMilesPerTruck).toBe(935);
  });

  it('rounds money to cents on output', () => {
    const result = computeFinancials(
      makeFacts({
        revenue: [
          revenue({ loadId: 'A', linehaul: 0.1 }),
          revenue({ loadId: 'B', linehaul: 0.2 }),
          revenue({ loadId: 'C', linehaul: 33.335 }),
        ],
        expenses: [expense({ id: 'E1', amount: 10.005 })],
      }),
    );
    expect(result.gross).toBe(33.64);
    expect(result.cost).toBe(10.01);
    expect(result.operatingProfit).toBe(23.63);
  });

  it('never yields NaN or Infinity in any metric', () => {
    const empty = computeFinancials(
      makeFacts({ revenue: [], expenses: [], trucks: [], drivers: [], expenseCoverage: [] }),
    );
    for (const key of FINANCIAL_METRIC_KEYS) {
      const value = empty[key];
      expect(value === null || Number.isFinite(value)).toBe(true);
    }
  });
});

describe('compareFinancials', () => {
  it('produces value, previous, delta and deltaPct per metric', () => {
    const current = computeFinancials(makeFacts());
    const previous = computeFinancials(
      makeFacts({
        revenue: [revenue({ loadId: 'P', linehaul: 2000, loadedMiles: 900, emptyMiles: 100 })],
      }),
    );
    const compared = compareFinancials(current, previous);
    expect(compared.gross).toEqual({
      value: 4000.75,
      previous: 2000,
      delta: 2000.75,
      deltaPct: 100,
    });
    expect(compared.rpm.delta).toBe(0.1394);
    expect(compared.activeTrucks).toEqual({ value: 2, previous: 1, delta: 1, deltaPct: 100 });
  });

  it('returns null deltaPct when previous is 0 and null deltas when either side is null', () => {
    expect(compareMetric(500, 0)).toEqual({ value: 500, previous: 0, delta: 500, deltaPct: null });
    expect(compareMetric(500, null)).toEqual({
      value: 500,
      previous: null,
      delta: null,
      deltaPct: null,
    });
    expect(compareMetric(null, 500)).toEqual({
      value: null,
      previous: 500,
      delta: null,
      deltaPct: null,
    });
  });

  it('uses the absolute previous value for deltaPct so a shrinking loss reads as improvement', () => {
    expect(compareMetric(-50, -100)).toEqual({
      value: -50,
      previous: -100,
      delta: 50,
      deltaPct: 50,
    });
  });

  it('compares against all-null previous when there is no comparison period', () => {
    const compared = compareFinancials(computeFinancials(makeFacts()), null);
    expect(compared.gross).toEqual({ value: 4000.75, previous: null, delta: null, deltaPct: null });
  });
});
