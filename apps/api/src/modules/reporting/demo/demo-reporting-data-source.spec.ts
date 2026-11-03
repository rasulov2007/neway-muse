import { describe, expect, it } from 'vitest';
import { DEMO_COMPANY, DEMO_TODAY, DEMO_WEEK_WITHOUT_EXPENSES } from './demo-company';
import {
  DemoReportingDataSource,
  generateDemoDataset,
  weekStartOf,
} from './demo-reporting-data-source';

const CURRENT_WEEK = { from: '2026-08-31', to: '2026-09-06' };
const FULL = { from: '2026-05-01', to: '2026-09-30' };

describe('DemoReportingDataSource', () => {
  const source = new DemoReportingDataSource();

  it('is labeled demo and generates the dataset within the time bound', () => {
    expect(source.kind).toBe('demo');
    const started = performance.now();
    const dataset = new DemoReportingDataSource().getDataset();
    const coldMs = performance.now() - started;
    // Generation happens once per process and is cached, so this is a guard against a pathological
    // regression (an accidental O(n²) pass), not a benchmark. The bound is loose because the suite
    // runs files in parallel and wall-clock here includes unrelated CPU contention; a healthy run
    // is well under 100 ms.
    expect(coldMs).toBeLessThan(1500);
    expect(dataset.trucks.length).toBeGreaterThanOrEqual(55);
    expect(dataset.drivers).toHaveLength(70);

    // The contract callers depend on: the second read is served from cache, not regenerated.
    // Identity, not elapsed time - a wall-clock comparison under a parallel suite measures CPU
    // contention rather than caching, and a regenerated dataset is a different object either way.
    const first = source.getDataset();
    expect(source.getDataset()).toBe(first);
  });

  it('is deterministic across instances and cached within one', () => {
    const a = generateDemoDataset();
    const b = generateDemoDataset();
    expect(a).toEqual(b);
    expect(source.getDataset()).toBe(source.getDataset());
  });

  it('returns empty facts for any other company', async () => {
    const facts = await source.facts('co_other', FULL);
    expect(facts.revenue).toEqual([]);
    expect(facts.expenses).toEqual([]);
    expect(facts.trucks).toEqual([]);
    expect(facts.dispatchWeeks).toEqual([]);
    expect(facts.revenueLedgerTotal).toBe(0);
  });

  it('filters every dated fact by the inclusive range', async () => {
    const facts = await source.facts(DEMO_COMPANY.id, CURRENT_WEEK);
    expect(facts.revenue.length).toBeGreaterThan(0);
    for (const r of facts.revenue)
      expect(r.deliveredOn >= '2026-08-31' && r.deliveredOn <= '2026-09-06').toBe(true);
    for (const e of facts.expenses)
      expect(e.date >= '2026-08-31' && e.date <= '2026-09-06').toBe(true);
    for (const f of facts.fuel) expect(f.date >= '2026-08-31' && f.date <= '2026-09-06').toBe(true);
    for (const m of facts.mileage)
      expect(m.date >= '2026-08-31' && m.date <= '2026-09-06').toBe(true);
    expect(facts.dispatchWeeks.map((w) => w.weekStart)).toEqual(Array(6).fill('2026-08-31'));
    expect(facts.expenseCoverage).toEqual([{ weekStart: '2026-08-31', hasExpenseData: true }]);
    expect(weekStartOf(DEMO_TODAY)).toBe('2026-08-31');
  });

  it('has ~95–115 delivered loads per full week with a plausible spread of linehaul and miles', async () => {
    const facts = await source.facts(DEMO_COMPANY.id, { from: '2026-07-06', to: '2026-08-30' });
    const byWeek = new Map<string, number>();
    for (const r of facts.revenue)
      byWeek.set(weekStartOf(r.deliveredOn), (byWeek.get(weekStartOf(r.deliveredOn)) ?? 0) + 1);
    for (const count of byWeek.values()) expect(count).toBeGreaterThanOrEqual(95);
    for (const count of byWeek.values()) expect(count).toBeLessThanOrEqual(115);
    for (const r of facts.revenue) {
      expect(r.linehaul).toBeGreaterThanOrEqual(900);
      expect(r.linehaul).toBeLessThanOrEqual(6800);
      expect(r.loadedMiles).toBeGreaterThanOrEqual(150);
      expect(r.loadedMiles).toBeLessThanOrEqual(1400);
    }
  });

  it('exposes unit 3012 and 3091 as inactive-loss trucks in the current week', async () => {
    const facts = await source.facts(DEMO_COMPANY.id, CURRENT_WEEK);
    const t3012 = facts.trucks.find((t) => t.unitNumber === '3012');
    const t3091 = facts.trucks.find((t) => t.unitNumber === '3091');
    expect(t3012 && t3091).toBeTruthy();
    expect(facts.revenue.some((r) => r.truckId === t3012?.truckId)).toBe(false);
    expect(facts.revenue.some((r) => r.truckId === t3091?.truckId)).toBe(false);
    const cost = (truckId: string | undefined): number =>
      facts.expenses.filter((e) => e.truckId === truckId).reduce((s, e) => s + e.amount, 0);
    expect(cost(t3012?.truckId)).toBe(2000);
    expect(
      facts.expenses.filter((e) => e.truckId === t3012?.truckId).map((e) => [e.category, e.amount]),
    ).toEqual(
      expect.arrayContaining([
        ['fuel', 500],
        ['maintenance', 1200],
        ['other', 300],
      ]),
    );
    expect(cost(t3091?.truckId)).toBe(1250);
    expect(facts.trucks.find((t) => t.unitNumber === '3120')?.status).toBe('in_shop');
  });

  it('has no expense data at all in the week starting 2026-08-10', async () => {
    const facts = await source.facts(DEMO_COMPANY.id, {
      from: DEMO_WEEK_WITHOUT_EXPENSES,
      to: '2026-08-16',
    });
    expect(facts.expenses).toEqual([]);
    expect(facts.revenue.length).toBeGreaterThan(0);
    expect(facts.expenseCoverage).toEqual([
      { weekStart: DEMO_WEEK_WITHOUT_EXPENSES, hasExpenseData: false },
    ]);
  });

  it('has exactly 4 drivers with unclassifiable pay tags', async () => {
    const facts = await source.facts(DEMO_COMPANY.id, FULL);
    const unknown = facts.drivers.filter((d) => d.payType === null);
    expect(unknown.map((d) => d.rawPayTag).sort()).toEqual(['', 'C-30', 'OO/C', 'TBD']);
    const types = new Set(facts.drivers.map((d) => d.payType));
    expect(types).toEqual(
      new Set(['company', 'owner_operator', 'lease_owner', 'percentage', null]),
    );
  });

  it('includes the data-quality anomalies and estimated driver pay', async () => {
    const facts = await source.facts(DEMO_COMPANY.id, FULL);
    expect(facts.revenue.filter((r) => r.truckId === null)).toHaveLength(2);
    expect(facts.revenue.filter((r) => r.driverId === null)).toHaveLength(3);
    const pay = facts.expenses.filter((e) => e.category === 'driver_pay');
    expect(pay.some((e) => e.isEstimate && e.source === 'estimate')).toBe(true);
    expect(pay.some((e) => !e.isEstimate && e.source === 'settlement')).toBe(true);
    expect(facts.expenses.filter((e) => e.category === 'fuel')).toHaveLength(facts.fuel.length);
    expect(facts.trucks.filter((t) => t.status === 'sold').length).toBeGreaterThan(0);
  });

  it('reconciles the revenue ledger with the revenue lines unless a mismatch is simulated', async () => {
    const facts = await source.facts(DEMO_COMPANY.id, { from: '2026-08-01', to: '2026-08-31' });
    const sum = Math.round(facts.revenue.reduce((s, r) => s + r.linehaul, 0) * 100) / 100;
    expect(facts.revenueLedgerTotal).toBe(sum);

    const flaky = new DemoReportingDataSource();
    flaky.simulateReconciliationMismatch = true;
    const mismatched = await flaky.facts(DEMO_COMPANY.id, { from: '2026-08-01', to: '2026-08-31' });
    expect(mismatched.revenueLedgerTotal).not.toBe(sum);
  });

  it('aggregates dispatch team-weeks from the revenue lines', async () => {
    const facts = await source.facts(DEMO_COMPANY.id, CURRENT_WEEK);
    for (const week of facts.dispatchWeeks) {
      const loads = facts.revenue.filter((r) => r.teamId === week.teamId);
      expect(week.loads).toBe(loads.length);
      expect(week.gross).toBeCloseTo(
        loads.reduce((s, r) => s + r.linehaul, 0),
        2,
      );
      expect(week.truckDays).toBeGreaterThan(0);
      expect(week.activeTruckDays).toBeLessThanOrEqual(week.truckDays);
      expect(week.activeTruckDays / week.truckDays).toBeGreaterThanOrEqual(0.84);
      expect(week.truckRpms).toHaveLength(week.activeTrucks);
    }
  });
});
