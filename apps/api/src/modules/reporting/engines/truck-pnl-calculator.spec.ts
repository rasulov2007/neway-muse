import { describe, expect, it } from 'vitest';
import { expense, makeFacts, mileage, revenue, truck } from './fixtures';
import {
  computeTruckPnl,
  filterTruckPnl,
  sortTruckPnl,
  summarizeTruckPnl,
} from './truck-pnl-calculator';
import type { TruckPnlRow } from './types';

function rowFor(rows: TruckPnlRow[], truckId: string): TruckPnlRow {
  const row = rows.find((r) => r.truckId === truckId);
  if (!row) throw new Error(`missing row ${truckId}`);
  return row;
}

function inactiveFacts() {
  return makeFacts({
    expenses: [
      ...makeFacts().expenses,
      expense({ id: 'E5', category: 'insurance', amount: 300, truckId: 'T3' }),
    ],
  });
}

describe('computeTruckPnl', () => {
  it('leaves an archived truck out of the P&L rows and the truck count (owner, 2026-10-05)', () => {
    const facts = makeFacts();
    const rows = computeTruckPnl({
      ...facts,
      trucks: [...facts.trucks, truck({ truckId: 'TA', unitNumber: 'TOW1', status: 'archived' })],
    });
    expect(rows.map((r) => r.truckId)).toEqual(['T1', 'T2', 'T3']);
    expect(summarizeTruckPnl(rows).trucks).toBe(3);
  });

  it('builds one row per non-sold truck with driver, type, gross, miles, loads, cost, profit', () => {
    const rows = computeTruckPnl(makeFacts());
    expect(rows.map((r) => r.truckId)).toEqual(['T1', 'T2', 'T3']);
    const t1 = rowFor(rows, 'T1');
    expect(t1).toMatchObject({
      unitNumber: '101',
      driverId: 'D1',
      driverName: 'Driver D1',
      payType: 'company',
      gross: 2000.75,
      miles: 870,
      loads: 2,
      cost: 1100,
      costEstimated: 0,
      profit: 900.75,
      rpm: 2.2997,
      inactiveLoss: false,
    });
    const t3 = rowFor(rows, 'T3');
    expect(t3).toMatchObject({
      gross: 0,
      miles: null,
      loads: 0,
      cost: 0,
      profit: 0,
      inactiveLoss: false,
    });
  });

  it('uses odometer mileage for a truck when present, else load miles', () => {
    const rows = computeTruckPnl(makeFacts({ mileage: [mileage({ truckId: 'T1', miles: 1234 })] }));
    expect(rowFor(rows, 'T1').miles).toBe(1234);
    expect(rowFor(rows, 'T2').miles).toBe(1000);
  });

  it('marks inactive-loss rows when gross is 0 and truck cost is positive', () => {
    const rows = computeTruckPnl(inactiveFacts());
    expect(rowFor(rows, 'T3')).toMatchObject({
      gross: 0,
      cost: 300,
      profit: -300,
      inactiveLoss: true,
    });
  });

  it('renders cost/profit as null and no loss rows without expense data', () => {
    const rows = computeTruckPnl(makeFacts({ expenses: [] }));
    for (const row of rows) {
      expect(row.cost).toBeNull();
      expect(row.costEstimated).toBeNull();
      expect(row.profit).toBeNull();
      expect(row.inactiveLoss).toBe(false);
    }
  });

  it('separates estimated truck cost', () => {
    const rows = computeTruckPnl(
      makeFacts({
        expenses: [
          expense({
            id: 'E1',
            category: 'driver_pay',
            amount: 400,
            truckId: 'T1',
            source: 'estimate',
            isEstimate: true,
          }),
        ],
      }),
    );
    expect(rowFor(rows, 'T1')).toMatchObject({ cost: 400, costEstimated: 400 });
  });
});

describe('filterTruckPnl', () => {
  it('searches by unit and driver name case-insensitively', () => {
    const rows = computeTruckPnl(makeFacts());
    expect(filterTruckPnl(rows, { q: '10' }).map((r) => r.unitNumber)).toEqual([
      '101',
      '102',
      '103',
    ]);
    expect(filterTruckPnl(rows, { q: 'driver d2' }).map((r) => r.truckId)).toEqual(['T2']);
    expect(filterTruckPnl(rows, { q: 'nope' })).toEqual([]);
  });

  it('filters by pay type (including unknown), status and unit', () => {
    const rows = computeTruckPnl(makeFacts());
    expect(filterTruckPnl(rows, { payType: 'owner_operator' }).map((r) => r.truckId)).toEqual([
      'T2',
    ]);
    expect(filterTruckPnl(rows, { payType: 'unknown' })).toEqual([]);
    expect(filterTruckPnl(rows, { status: 'idle' }).map((r) => r.truckId)).toEqual(['T3']);
    expect(filterTruckPnl(rows, { unit: '102' }).map((r) => r.truckId)).toEqual(['T2']);
  });

  it('supports best, worst, inactive and unprofitable views', () => {
    const rows = computeTruckPnl(inactiveFacts());
    expect(filterTruckPnl(rows, { view: 'best', limit: 1 }).map((r) => r.truckId)).toEqual(['T2']);
    expect(filterTruckPnl(rows, { view: 'worst', limit: 2 }).map((r) => r.truckId)).toEqual([
      'T3',
      'T1',
    ]);
    expect(filterTruckPnl(rows, { view: 'inactive' }).map((r) => r.truckId)).toEqual(['T3']);
    expect(filterTruckPnl(rows, { view: 'unprofitable' }).map((r) => r.truckId)).toEqual(['T3']);
  });

  it('excludes rows with null profit from best/worst and unprofitable views', () => {
    const rows = computeTruckPnl(makeFacts({ expenses: [] }));
    expect(filterTruckPnl(rows, { view: 'best' })).toEqual([]);
    expect(filterTruckPnl(rows, { view: 'unprofitable' })).toEqual([]);
    expect(filterTruckPnl(rows, { view: 'inactive' })).toEqual([]);
  });
});

describe('sortTruckPnl', () => {
  it('sorts numerically and by string with nulls last', () => {
    const rows = computeTruckPnl(makeFacts());
    expect(sortTruckPnl(rows, { field: 'gross', direction: 'desc' }).map((r) => r.truckId)).toEqual(
      ['T1', 'T2', 'T3'],
    );
    expect(sortTruckPnl(rows, { field: 'gross', direction: 'asc' }).map((r) => r.truckId)).toEqual([
      'T3',
      'T2',
      'T1',
    ]);
    expect(sortTruckPnl(rows, { field: 'miles', direction: 'asc' }).map((r) => r.truckId)).toEqual([
      'T1',
      'T2',
      'T3',
    ]);
    expect(sortTruckPnl(rows, { field: 'miles', direction: 'desc' }).map((r) => r.truckId)).toEqual(
      ['T2', 'T1', 'T3'],
    );
    expect(
      sortTruckPnl(rows, { field: 'payType', direction: 'asc' }).map((r) => r.payType),
    ).toEqual(['company', 'lease_owner', 'owner_operator']);
  });

  it('does not mutate the input', () => {
    const rows = computeTruckPnl(makeFacts());
    const ids = rows.map((r) => r.truckId);
    sortTruckPnl(rows, { field: 'gross', direction: 'asc' });
    expect(rows.map((r) => r.truckId)).toEqual(ids);
  });
});

describe('summarizeTruckPnl', () => {
  it('totals gross, miles, loads, cost, profit and inactive loss', () => {
    const summary = summarizeTruckPnl(computeTruckPnl(inactiveFacts()));
    expect(summary).toEqual({
      trucks: 3,
      gross: 4000.75,
      miles: 1870,
      loads: 3,
      cost: 2100,
      profit: 1900.75,
      inactiveLossTrucks: 1,
      inactiveLoss: 300,
    });
  });

  it('returns null cost, profit and miles when rows carry none', () => {
    const summary = summarizeTruckPnl(computeTruckPnl(makeFacts({ expenses: [], revenue: [] })));
    expect(summary).toMatchObject({
      gross: 0,
      miles: null,
      cost: null,
      profit: null,
      inactiveLoss: null,
    });
  });

  it('rounds totals to cents', () => {
    const rows = computeTruckPnl(
      makeFacts({
        revenue: [
          revenue({ loadId: 'A', truckId: 'T1', linehaul: 0.1 }),
          revenue({ loadId: 'B', truckId: 'T2', linehaul: 0.2 }),
        ],
        expenses: [
          expense({ id: 'E1', amount: 0.07, truckId: 'T1' }),
          expense({ id: 'E2', amount: 0.03, truckId: 'T2' }),
        ],
      }),
    );
    expect(summarizeTruckPnl(rows)).toMatchObject({ gross: 0.3, cost: 0.1, profit: 0.2 });
  });
});
