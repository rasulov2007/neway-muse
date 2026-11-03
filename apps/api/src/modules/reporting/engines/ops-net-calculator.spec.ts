import { describe, expect, it } from 'vitest';
import { computeFinancials } from './financial-calculator';
import { driver, expense, makeFacts, mileage, revenue, truck } from './fixtures';
import { activeTrucksByPayType, computeOpsNet } from './ops-net-calculator';
import type { OpsNetBucket, OpsNetBucketKey } from './types';

function bucket(result: ReturnType<typeof computeOpsNet>, key: OpsNetBucketKey): OpsNetBucket {
  const found = result.buckets.find((b) => b.key === key);
  if (!found) throw new Error(`missing bucket ${key}`);
  return found;
}

describe('computeOpsNet', () => {
  it('allocates revenue and expenses to driver pay-type buckets', () => {
    const result = computeOpsNet(makeFacts());
    const company = bucket(result, 'company');
    expect(company.gross).toBe(2000.75);
    expect(company.loads).toBe(2);
    expect(company.fuel).toBe(500);
    expect(company.driverPay).toBe(600);
    expect(company.driverPayEstimated).toBe(0);
    expect(company.totalCost).toBe(1100);
    expect(company.operatingProfit).toBe(900.75);
    expect(company.marginPct).toBe(45);
    expect(company.driverCount).toBe(1);

    const oo = bucket(result, 'owner_operator');
    expect(oo.gross).toBe(2000);
    expect(oo.fuel).toBe(700);
    expect(oo.totalCost).toBe(700);
    expect(oo.driverCount).toBe(1);

    // Company-level insurance (no truck, no driver) is kept in the unknown bucket, never dropped.
    const unknown = bucket(result, 'unknown');
    expect(unknown.insurance).toBe(300);
    expect(unknown.gross).toBe(0);
    expect(unknown.marginPct).toBeNull();
    expect(unknown.reasons).toEqual(['zero_gross']);
  });

  it('returns buckets in a fixed order', () => {
    const result = computeOpsNet(makeFacts());
    expect(result.buckets.map((b) => b.key)).toEqual([
      'company',
      'owner_operator',
      'lease_owner',
      'percentage',
      'unknown',
    ]);
  });

  it('routes lines with a truck but no driver to the truck current driver', () => {
    const facts = makeFacts({
      revenue: [revenue({ loadId: 'A', truckId: 'T2', driverId: null, linehaul: 1500 })],
      expenses: [
        expense({ id: 'E1', category: 'tolls', amount: 40, truckId: 'T2', driverId: null }),
      ],
    });
    const result = computeOpsNet(facts);
    const oo = bucket(result, 'owner_operator');
    expect(oo.gross).toBe(1500);
    expect(oo.other).toBe(40);
    expect(oo.driverCount).toBe(1);
    expect(bucket(result, 'unknown').gross).toBe(0);
  });

  it('keeps money for unknown driver types in the unknown bucket with the raw pay tag', () => {
    const facts = makeFacts({
      drivers: [
        ...makeFacts().drivers,
        driver({ driverId: 'D4', payType: null, rawPayTag: 'per-mile??' }),
      ],
      trucks: [...makeFacts().trucks, truck({ truckId: 'T4', unitNumber: '104', driverId: 'D4' })],
      revenue: [
        ...makeFacts().revenue,
        revenue({ loadId: 'U1', truckId: 'T4', driverId: 'D4', linehaul: 750 }),
        revenue({ loadId: 'U2', truckId: null, driverId: null, linehaul: 250 }),
      ],
      expenses: [
        ...makeFacts().expenses,
        expense({ id: 'E9', category: 'fuel', amount: 120, truckId: 'T4' }),
      ],
    });
    const result = computeOpsNet(facts);
    const unknown = bucket(result, 'unknown');
    expect(unknown.gross).toBe(1000);
    expect(unknown.fuel).toBe(120);
    expect(unknown.insurance).toBe(300);
    expect(unknown.driverCount).toBe(1);
    expect(result.unknown).toEqual({
      driverCount: 1,
      gross: 1000,
      drivers: [{ driverId: 'D4', name: 'Driver D4', rawPayTag: 'per-mile??' }],
    });
  });

  it('separates estimated driver pay from finalized settlements', () => {
    const facts = makeFacts({
      expenses: [
        expense({
          id: 'E1',
          category: 'driver_pay',
          amount: 400,
          driverId: 'D1',
          source: 'estimate',
          isEstimate: true,
        }),
        expense({
          id: 'E2',
          category: 'driver_pay',
          amount: 100,
          driverId: 'D1',
          source: 'settlement',
        }),
      ],
    });
    const company = bucket(computeOpsNet(facts), 'company');
    expect(company.driverPay).toBe(500);
    expect(company.driverPayEstimated).toBe(400);
  });

  it('nulls every cost field with no_expense_data when the period has no expenses', () => {
    const result = computeOpsNet(makeFacts({ expenses: [] }));
    expect(result.hasExpenseData).toBe(false);
    expect(result.totals.totalCost).toBeNull();
    const company = bucket(result, 'company');
    expect(company.gross).toBe(2000.75);
    expect(company.fuel).toBeNull();
    expect(company.driverPay).toBeNull();
    expect(company.driverPayEstimated).toBeNull();
    expect(company.other).toBeNull();
    expect(company.totalCost).toBeNull();
    expect(company.operatingProfit).toBeNull();
    expect(company.marginPct).toBeNull();
    expect(company.reasons).toEqual(['no_expense_data']);
  });

  it('reconciles bucket totals to computeFinancials exactly', () => {
    const facts = makeFacts({
      drivers: [...makeFacts().drivers, driver({ driverId: 'D4', payType: null, rawPayTag: null })],
      revenue: [
        ...makeFacts().revenue,
        revenue({ loadId: 'X', truckId: null, driverId: 'D4', linehaul: 333.33 }),
        revenue({ loadId: 'Y', truckId: null, driverId: null, linehaul: 0.01 }),
      ],
      expenses: [
        ...makeFacts().expenses,
        expense({ id: 'Z1', category: 'factoring', amount: 12.345, truckId: null, driverId: 'D2' }),
        expense({
          id: 'Z2',
          category: 'maintenance',
          amount: 0.005,
          truckId: null,
          driverId: 'D4',
        }),
      ],
    });
    const financials = computeFinancials(facts);
    const opsNet = computeOpsNet(facts);
    expect(opsNet.totals.gross).toBe(financials.gross);
    expect(opsNet.totals.totalCost).toBe(financials.cost);
    const grossSum = opsNet.buckets.reduce((acc, b) => acc + b.gross, 0);
    const costSum = opsNet.buckets.reduce((acc, b) => acc + (b.totalCost ?? 0), 0);
    expect(Math.abs(grossSum - financials.gross)).toBeLessThan(0.05);
    expect(Math.abs(costSum - (financials.cost ?? 0))).toBeLessThan(0.05);
  });

  it('counts only drivers with activity in the period for classified buckets', () => {
    const facts = makeFacts({
      drivers: [...makeFacts().drivers, driver({ driverId: 'D5', payType: 'company' })],
    });
    expect(bucket(computeOpsNet(facts), 'company').driverCount).toBe(1);
    expect(bucket(computeOpsNet(facts), 'lease_owner').driverCount).toBe(0);
  });

  it('breaks costs down per category and dashes categories with no line at all', () => {
    const result = computeOpsNet(makeFacts());

    const company = bucket(result, 'company');
    expect(company.costs).toEqual({
      fuel: 500,
      insurance: null,
      maintenance: null,
      tolls: null,
      repairs: null,
      dispatch_fee: null,
      factoring: null,
      driver_pay: 600,
      staff_payroll: null,
      other: null,
    });

    // Company-level insurance has no truck and no driver, so it belongs to `unknown` only.
    expect(bucket(result, 'unknown').costs.insurance).toBe(300);
    expect(bucket(result, 'owner_operator').costs).toMatchObject({ fuel: 700, driver_pay: null });
    // A pay type with no activity at all dashes every category rather than reporting zeros.
    expect(Object.values(bucket(result, 'percentage').costs).every((v) => v === null)).toBe(true);
  });

  it('sums the per-category breakdown to totalCost in every bucket', () => {
    const facts = makeFacts({
      expenses: [
        ...makeFacts().expenses,
        expense({ id: 'E5', category: 'tolls', amount: 12.34, truckId: 'T1' }),
        expense({ id: 'E6', category: 'repairs', amount: 55.66, truckId: 'T2' }),
        expense({ id: 'E7', category: 'dispatch_fee', amount: 7.5, truckId: 'T2' }),
      ],
    });
    const result = computeOpsNet(facts);
    for (const row of [...result.buckets, result.totals]) {
      const categorySum = Object.values(row.costs).reduce<number>((acc, v) => acc + (v ?? 0), 0);
      expect(Math.round(categorySum * 100) / 100).toBe(row.totalCost);
    }
  });

  it('nulls every cost category when the period has no expense data', () => {
    const result = computeOpsNet(makeFacts({ expenses: [] }));
    for (const row of [...result.buckets, result.totals]) {
      expect(Object.values(row.costs)).toEqual(Array<null>(10).fill(null));
    }
  });

  it('computes per-bucket unit economics from load miles when no odometer records exist', () => {
    const result = computeOpsNet(makeFacts());

    const company = bucket(result, 'company');
    expect(company.totalMiles).toBe(870); // 550 + 320 from T1's two loads
    expect(company.activeTrucks).toBe(1);
    expect(company.rpm).toBe(2.2997); // 2000.75 / 870
    expect(company.avgGrossPerTruck).toBe(2000.75);
    expect(company.avgMilesPerTruck).toBe(870);

    const oo = bucket(result, 'owner_operator');
    expect(oo).toMatchObject({ totalMiles: 1000, activeTrucks: 1, rpm: 2, avgMilesPerTruck: 1000 });

    // No revenue means no active truck: averages are unknown, never zero.
    const unknown = bucket(result, 'unknown');
    expect(unknown.activeTrucks).toBe(0);
    expect(unknown.rpm).toBeNull();
    expect(unknown.avgGrossPerTruck).toBeNull();
    expect(unknown.avgMilesPerTruck).toBeNull();
  });

  it('prefers odometer records over load miles, matching the financial engine', () => {
    const facts = makeFacts({ mileage: [mileage({ truckId: 'T1', miles: 600 })] });
    const result = computeOpsNet(facts);
    expect(result.totals.totalMiles).toBe(computeFinancials(facts).totalMiles);
    expect(bucket(result, 'company').totalMiles).toBe(600);
    expect(bucket(result, 'owner_operator').totalMiles).toBe(0);
  });

  it('nulls miles-derived unit economics when the period has no miles at all', () => {
    const result = computeOpsNet(makeFacts({ revenue: [], mileage: [] }));
    for (const row of [...result.buckets, result.totals]) {
      expect(row.totalMiles).toBeNull();
      expect(row.rpm).toBeNull();
      expect(row.avgMilesPerTruck).toBeNull();
    }
  });

  it('reconciles the totals row with computeFinancials for the same period', () => {
    const facts = makeFacts({
      drivers: [...makeFacts().drivers, driver({ driverId: 'D4', payType: null, rawPayTag: null })],
      revenue: [
        ...makeFacts().revenue,
        revenue({ loadId: 'X', truckId: null, driverId: 'D4', linehaul: 333.33 }),
        revenue({ loadId: 'Y', truckId: 'T3', driverId: 'D3', linehaul: 640.6, loadedMiles: 210 }),
      ],
      expenses: [
        ...makeFacts().expenses,
        expense({ id: 'Z1', category: 'factoring', amount: 12.345, truckId: null, driverId: 'D2' }),
        expense({ id: 'Z2', category: 'maintenance', amount: 90.05, truckId: 'T3' }),
      ],
    });
    const financials = computeFinancials(facts);
    const totals = computeOpsNet(facts).totals;

    expect(totals.gross).toBe(financials.gross);
    expect(totals.totalCost).toBe(financials.cost);
    expect(totals.operatingProfit).toBe(financials.operatingProfit);
    expect(totals.marginPct).toBe(financials.marginPct);
    expect(totals.totalMiles).toBe(financials.totalMiles);
    expect(totals.rpm).toBe(financials.rpm);
    expect(totals.activeTrucks).toBe(financials.activeTrucks);
    expect(totals.avgGrossPerTruck).toBe(financials.avgGrossPerTruck);
    expect(totals.avgMilesPerTruck).toBe(financials.avgMilesPerTruck);
  });

  it('surfaces the company-level rows that no pay type can own', () => {
    const facts = makeFacts({
      expenses: [...makeFacts().expenses, expense({ id: 'I1', amount: 450, truckId: 'T3' })],
    });
    const financials = computeFinancials(facts);
    const result = computeOpsNet(facts);
    expect(result.inactiveTruckLoss).toBe(financials.inactiveTruckLoss);
    expect(result.inactiveTruckLoss).toBe(450);
    expect(result.netOperatingProfit).toBe(financials.netOperatingProfit);
  });

  it('keeps the unknown bucket money and folds it into the totals row', () => {
    const facts = makeFacts({
      revenue: [
        ...makeFacts().revenue,
        revenue({ loadId: 'U', truckId: null, driverId: null, linehaul: 500, loadedMiles: 0 }),
      ],
    });
    const result = computeOpsNet(facts);
    const unknown = bucket(result, 'unknown');
    expect(unknown.gross).toBe(500);
    expect(unknown.costs.insurance).toBe(300);
    expect(unknown.totalCost).toBe(300);
    expect(unknown.operatingProfit).toBe(200);
    expect(result.totals.gross).toBe(computeFinancials(facts).gross);
    expect(result.totals.gross).toBe(result.buckets.reduce((acc, b) => acc + b.gross, 0));
  });

  it('counts an active truck once, in the pay type that earned most of its revenue', () => {
    const facts = makeFacts({
      revenue: [
        // T1 is driven by a company driver for $900 and by an owner operator for $2,100.
        revenue({ loadId: 'A', truckId: 'T1', driverId: 'D1', linehaul: 900 }),
        revenue({ loadId: 'B', truckId: 'T1', driverId: 'D2', linehaul: 2100 }),
        revenue({ loadId: 'C', truckId: 'T2', driverId: 'D2', linehaul: 1000 }),
      ],
    });
    const result = computeOpsNet(facts);
    expect(bucket(result, 'company').activeTrucks).toBe(0);
    expect(bucket(result, 'owner_operator').activeTrucks).toBe(2);
    expect(result.totals.activeTrucks).toBe(computeFinancials(facts).activeTrucks);
  });
});

describe('activeTrucksByPayType', () => {
  it('splits active trucks by pay type and sums to the financial active-truck count', () => {
    const facts = makeFacts();
    const split = activeTrucksByPayType(facts);
    expect(split).toEqual({
      company: 1,
      owner_operator: 1,
      lease_owner: 0,
      percentage: 0,
      unknown: 0,
    });
    const total = Object.values(split ?? {}).reduce((acc, n) => acc + n, 0);
    expect(total).toBe(computeFinancials(facts).activeTrucks);
  });

  it('attributes a driverless revenue line to the truck current driver', () => {
    const facts = makeFacts({
      revenue: [revenue({ loadId: 'A', truckId: 'T3', driverId: null, linehaul: 700 })],
    });
    expect(activeTrucksByPayType(facts)).toMatchObject({ lease_owner: 1, company: 0 });
  });

  it('is null when the week has no revenue at all rather than reporting zeros', () => {
    expect(activeTrucksByPayType(makeFacts({ revenue: [] }))).toBeNull();
  });
});
