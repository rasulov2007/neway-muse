import { describe, expect, it } from 'vitest';
import { computeDataQuality } from './data-quality';
import { computeFinancials } from './financial-calculator';
import { driver, makeFacts, revenue } from './fixtures';
import type { DataQualityCheck, DataQualityKey } from './types';

const WEEKS = [
  { weekStart: '2026-08-24', hasExpenseData: true },
  { weekStart: '2026-08-31', hasExpenseData: true },
];

function run(facts = makeFacts(), weeks = WEEKS): Record<DataQualityKey, DataQualityCheck> {
  const checks = computeDataQuality(facts, computeFinancials(facts), weeks);
  return Object.fromEntries(checks.map((c) => [c.key, c])) as Record<
    DataQualityKey,
    DataQualityCheck
  >;
}

describe('computeDataQuality', () => {
  it('returns all six checks in a fixed order', () => {
    const facts = makeFacts();
    const keys = computeDataQuality(facts, computeFinancials(facts), WEEKS).map((c) => c.key);
    expect(keys).toEqual([
      'revenue_reconciliation',
      'expense_completeness',
      'unknown_pay_types',
      'missing_truck_assignments',
      'missing_driver_assignments',
      'missing_fuel_data',
    ]);
  });

  it('reports everything ok for clean facts', () => {
    const checks = run();
    for (const check of Object.values(checks)) expect(check.status).toBe('ok');
  });

  it('reconciles revenue when equal to the cent', () => {
    const check = run(makeFacts({ revenueLedgerTotal: 4000.754 })).revenue_reconciliation;
    expect(check.status).toBe('ok');
    expect(check.data).toEqual({ dashboardGross: 4000.75, ledgerTotal: 4000.75, difference: 0 });
  });

  it('errors on a revenue mismatch with both values and the difference', () => {
    const check = run(makeFacts({ revenueLedgerTotal: 4100 })).revenue_reconciliation;
    expect(check.status).toBe('error');
    expect(check.amount).toBe(-99.25);
    expect(check.data).toEqual({ dashboardGross: 4000.75, ledgerTotal: 4100, difference: -99.25 });
    expect(check.detail).toContain('$4000.75');
    expect(check.detail).toContain('$4100.00');
  });

  it('warns about weeks without expense data, listing their week starts', () => {
    const check = run(makeFacts(), [
      { weekStart: '2026-08-17', hasExpenseData: false },
      { weekStart: '2026-08-24', hasExpenseData: true },
      { weekStart: '2026-08-31', hasExpenseData: false },
    ]).expense_completeness;
    expect(check.status).toBe('warning');
    expect(check.count).toBe(2);
    expect(check.data).toEqual({ missingWeeks: ['2026-08-17', '2026-08-31'] });
    expect(check.detail).toContain('2026-08-17, 2026-08-31');
  });

  it('warns when partial expense coverage still yields a numeric cost', () => {
    const facts = makeFacts({
      expenseCoverage: [
        { weekStart: '2026-08-24', hasExpenseData: false },
        { weekStart: '2026-08-31', hasExpenseData: true },
      ],
    });
    const financials = computeFinancials(facts);
    expect(financials.cost).toBe(2100);
    const check = run(facts, facts.expenseCoverage).expense_completeness;
    expect(check.status).toBe('warning');
    expect(check.data).toEqual({ missingWeeks: ['2026-08-24'] });
  });

  it('warns when there are no weeks and no expense data at all', () => {
    const check = run(makeFacts({ expenses: [] }), []).expense_completeness;
    expect(check.status).toBe('warning');
  });

  it('warns about unknown pay types with count and unclassified gross', () => {
    const facts = makeFacts({
      drivers: [
        ...makeFacts().drivers,
        driver({ driverId: 'D4', payType: null, rawPayTag: 'weird' }),
      ],
      revenue: [
        ...makeFacts().revenue,
        revenue({ loadId: 'U', truckId: null, driverId: 'D4', linehaul: 500 }),
      ],
    });
    const check = run(facts).unknown_pay_types;
    expect(check.status).toBe('warning');
    expect(check.count).toBe(1);
    expect(check.amount).toBe(500);
    expect(check.data).toEqual({
      drivers: [{ driverId: 'D4', name: 'Driver D4', rawPayTag: 'weird' }],
    });
  });

  it('warns about missing truck and driver assignments with counts and gross', () => {
    const facts = makeFacts({
      revenue: [
        ...makeFacts().revenue,
        revenue({ loadId: 'NT', truckId: null, driverId: 'D1', linehaul: 100 }),
        revenue({ loadId: 'ND', truckId: 'T1', driverId: null, linehaul: 200 }),
        revenue({ loadId: 'NB', truckId: null, driverId: null, linehaul: 300 }),
      ],
    });
    const checks = run(facts);
    expect(checks.missing_truck_assignments).toMatchObject({
      status: 'warning',
      count: 2,
      amount: 400,
    });
    expect(checks.missing_truck_assignments.data).toEqual({ loadIds: ['NT', 'NB'] });
    expect(checks.missing_driver_assignments).toMatchObject({
      status: 'warning',
      count: 2,
      amount: 500,
    });
    expect(checks.missing_driver_assignments.data).toEqual({ loadIds: ['ND', 'NB'] });
  });

  it('warns about missing fuel data when miles were driven without fuel transactions', () => {
    const check = run(makeFacts({ fuel: [] })).missing_fuel_data;
    expect(check.status).toBe('warning');
    expect(check.detail).toContain('1870 miles');
  });

  it('does not warn about fuel when there are no miles', () => {
    const check = run(makeFacts({ fuel: [], revenue: [] })).missing_fuel_data;
    expect(check.status).toBe('ok');
  });
});
