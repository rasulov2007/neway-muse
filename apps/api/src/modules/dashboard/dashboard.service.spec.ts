import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demoPrincipal } from '../../common/auth/demo-principal.middleware';
import { DEMO_COMPANY, DEMO_WEEK_WITHOUT_EXPENSES } from '../reporting/demo/demo-company';
import { DemoReportingDataSource } from '../reporting/demo/demo-reporting-data-source';
import { ReportingPeriodService } from '../reporting/period/reporting-period.service';
import { demoClock } from './clock';
import { DashboardCache } from './dashboard-cache';
import {
  DashboardService,
  NO_EXPENSE_DATA_NOTE,
  type PeriodComputation,
} from './dashboard.service';

const LAST_WEEK = { from: '2026-08-24', to: '2026-08-30' };

describe('DashboardService (demo dataset, today = 2026-09-06)', () => {
  let source: DemoReportingDataSource;
  let service: DashboardService;
  const admin = demoPrincipal('admin');
  const executive = demoPrincipal('executive');

  beforeEach(() => {
    source = new DemoReportingDataSource();
    service = new DashboardService(
      new ReportingPeriodService(),
      source,
      new DashboardCache<PeriodComputation>(),
      demoClock,
    );
  });

  it('overview gross for last_week equals the sum of demo revenue lines and reconciles', async () => {
    const overview = await service.overview(admin, { period: 'last_week' });
    const facts = await source.facts(DEMO_COMPANY.id, LAST_WEEK);
    const expected = Math.round(facts.revenue.reduce((s, r) => s + r.linehaul, 0) * 100) / 100;

    expect(overview.meta.period).toMatchObject({ ...LAST_WEEK, isComplete: true });
    expect(overview.meta.source).toBe('demo');
    expect(overview.financial.gross.value).toBe(expected);
    expect(overview.financial.gross.masked).toBe(false);
    expect(overview.financial.gross.previous).not.toBeNull();
    expect(overview.reconciliation).toEqual({
      status: 'ok',
      dashboardGross: expected,
      ledgerGross: expected,
      difference: 0,
    });
    expect(overview.expenseCoverage).toEqual({ hasData: true });
    expect(overview.financial.cost.value).not.toBeNull();
  });

  it('reports cost as unknown with a note for the week without expense data', async () => {
    const overview = await service.overview(admin, {
      period: 'custom',
      from: DEMO_WEEK_WITHOUT_EXPENSES,
      to: '2026-08-16',
    });
    expect(overview.financial.cost.value).toBeNull();
    expect(overview.financial.cost.reasons).toContain('no_expense_data');
    expect(overview.financial.operatingProfit.value).toBeNull();
    expect(overview.expenseCoverage).toEqual({ hasData: false, note: NO_EXPENSE_DATA_NOTE });
    expect(overview.costBreakdown).toEqual([]);
  });

  it('inactive loss for this_week includes unit 3012 with $2,000', async () => {
    const overview = await service.overview(admin, { period: 'this_week' });
    expect(overview.financial.inactiveTruckLoss.value).toBeGreaterThanOrEqual(2000);

    const drilldown = await service.drilldown(admin, {
      metric: 'inactive_loss',
      period: 'this_week',
      page: 1,
      pageSize: 50,
    });
    expect(drilldown.rows).toContainEqual(expect.objectContaining({ unit: '3012', cost: 2000 }));
    expect(drilldown.total).toBe(overview.financial.inactiveTruckLoss.value);
  });

  it('drilldown gross rows sum to the overview gross', async () => {
    const overview = await service.overview(admin, { period: 'last_week' });
    const drilldown = await service.drilldown(admin, {
      metric: 'gross',
      period: 'last_week',
      page: 1,
      pageSize: 200,
    });
    const rowSum =
      Math.round(drilldown.rows.reduce((s, row) => s + Number(row['linehaul'] ?? 0), 0) * 100) /
      100;
    expect(drilldown.total).toBe(overview.financial.gross.value);
    expect(rowSum).toBe(drilldown.total);
    expect(drilldown.page.total).toBe(drilldown.rows.length);
  });

  it('ops-net unknown bucket has 4 drivers', async () => {
    const opsNet = await service.opsNet(admin, { period: 'last_week' });
    expect(opsNet.unknown.driverCount).toBe(4);
    expect(opsNet.unknown.drivers).toHaveLength(4);
    expect(opsNet.buckets.map((b) => b.payType)).toEqual([
      'company',
      'owner_operator',
      'lease_owner',
      'percentage',
      'unknown',
    ]);
    expect(opsNet.masked).toBe(false);
  });

  it('trends has 8 weeks with exactly one highlighted for last_week', async () => {
    const trends = await service.trends(admin, { period: 'last_week' });
    expect(trends.weeks).toHaveLength(8);
    expect(trends.weeks.filter((w) => w.highlighted).map((w) => w.weekStart)).toEqual([
      LAST_WEEK.from,
    ]);
    expect(trends.weeks.at(-1)).toMatchObject({ weekStart: LAST_WEEK.from, isComplete: true });
    const noExpense = trends.weeks.find((w) => w.weekStart === DEMO_WEEK_WITHOUT_EXPENSES);
    expect(noExpense?.hasExpenseData).toBe(false);
    expect(noExpense?.cost).toBeNull();
  });

  it('dispatch performance marks the current week as estimated', async () => {
    const dispatch = await service.dispatchPerformance(admin, { period: 'this_week' });
    expect(dispatch.weeks).toHaveLength(4);
    expect(dispatch.weeks.at(-1)).toMatchObject({ weekStart: '2026-08-31', isComplete: false });
    expect(dispatch.teams.length).toBeGreaterThan(0);
    for (const team of dispatch.teams) {
      expect(team.estimatedFullWeekGross.estimated).toBe(true);
      expect(team.byWeek).toHaveLength(4);
    }
  });

  it('fuel and data-health sections validate against the contracts', async () => {
    const fuel = await service.fuel(admin, { period: 'last_week' });
    expect(fuel.totals.fillUps).toBeGreaterThan(0);
    expect(fuel.totals.fuelCostPerMile).not.toBeNull();
    const health = await service.dataHealth(admin, { period: 'last_week' });
    expect(health.checks).toHaveLength(6);
    expect(health.checks.find((c) => c.key === 'revenue_reconciliation')?.status).toBe('ok');
    expect(health.summary.ok + health.summary.warning + health.summary.error).toBe(6);
  });

  it('masks every money field for the executive role', async () => {
    const overview = await service.overview(executive, { period: 'last_week' });
    for (const metric of Object.values(overview.financial)) {
      expect(metric).toMatchObject({ value: null, previous: null, delta: null, masked: true });
    }
    expect(overview.unitEconomics.rpm.masked).toBe(true);
    expect(overview.unitEconomics.totalMiles.masked).toBe(false);
    expect(overview.fleet.activeTrucks.value).not.toBeNull();
    expect(overview.costBreakdown.every((item) => item.amount === null)).toBe(true);
    expect(overview.reconciliation.dashboardGross).toBeNull();

    const pnl = await service.truckPnl(executive, {
      period: 'last_week',
      view: 'all',
      sort: '-profit',
      page: 1,
      pageSize: 10,
    });
    expect(pnl.masked).toBe(true);
    expect(pnl.rows.every((r) => r.gross === null && r.cost === null && r.profit === null)).toBe(
      true,
    );
    expect(pnl.rows.some((r) => r.loads > 0)).toBe(true);
    expect(pnl.totals.gross).toBeNull();

    const json = JSON.stringify([
      overview,
      pnl,
      await service.trends(executive, { period: 'last_week' }),
      await service.opsNet(executive, { period: 'last_week' }),
      await service.fuel(executive, { period: 'last_week' }),
      await service.dispatchPerformance(executive, { period: 'last_week' }),
      await service.dataHealth(executive, { period: 'last_week' }),
    ]);
    const adminGross = (await service.overview(admin, { period: 'last_week' })).financial.gross
      .value;
    expect(json).not.toContain(String(adminGross));
  });

  it('trends weeks carry unit economics, truck counts and the pay-type split', async () => {
    const trends = await service.trends(admin, { period: 'last_week' });
    const week = trends.weeks.at(-1);
    expect(week).toBeDefined();
    expect(week?.ppm).not.toBeNull();
    expect(week?.totalMiles).toBeGreaterThan(0);
    expect(week?.inactiveTrucks).not.toBeNull();
    expect(week?.avgGrossPerTruck).not.toBeNull();
    expect(week?.avgCostPerTruck).not.toBeNull();
    expect(week?.avgProfitPerTruck).not.toBeNull();
    expect(week?.avgMilesPerTruck).not.toBeNull();

    for (const w of trends.weeks) {
      const split = w.activeByPayType;
      expect(split).not.toBeNull();
      if (split === null) continue;
      // Every active truck is counted in exactly one pay type.
      expect(Object.values(split).reduce((acc, n) => acc + n, 0)).toBe(w.activeTrucks);
      expect(Object.keys(split).sort()).toEqual([
        'company',
        'lease_owner',
        'owner_operator',
        'percentage',
        'unknown',
      ]);
    }
  });

  it('reports the week without expense data with null costs and null cost-derived fields', async () => {
    const trends = await service.trends(admin, { period: 'last_week' });
    const week = trends.weeks.find((w) => w.weekStart === DEMO_WEEK_WITHOUT_EXPENSES);
    expect(week?.hasExpenseData).toBe(false);
    expect(week?.cost).toBeNull();
    expect(week?.profit).toBeNull();
    expect(week?.cpm).toBeNull();
    expect(week?.ppm).toBeNull();
    expect(week?.avgCostPerTruck).toBeNull();
    expect(week?.avgProfitPerTruck).toBeNull();
    // Operational figures are still known for that week.
    expect(week?.gross).not.toBeNull();
    expect(week?.totalMiles).not.toBeNull();
    expect(week?.avgGrossPerTruck).not.toBeNull();
    expect(week?.avgMilesPerTruck).not.toBeNull();
  });

  it('trends summary rolls the window up against the equivalent window before it', async () => {
    const trends = await service.trends(admin, { period: 'last_week' });
    const summary = trends.summary;
    expect(summary).not.toBeNull();
    if (summary === null) return;

    expect(summary.window).toEqual({ from: '2026-07-06', to: LAST_WEEK.to, weeks: 8 });
    expect(summary.previousWindow).toEqual({ from: '2026-05-11', to: '2026-07-05', weeks: 8 });

    // The rollup is computeFinancials over the window's facts, not the sum of the per-week rows.
    // For gross - a plain sum - the two must nevertheless agree to the cent.
    const weekGross = trends.weeks.reduce((acc, w) => acc + (w.gross ?? 0), 0);
    expect(summary.gross.value).toBe(Math.round(weekGross * 100) / 100);

    expect(summary.gross.previous).not.toBeNull();
    expect(summary.gross.delta).toBe(
      Math.round(((summary.gross.value ?? 0) - (summary.gross.previous ?? 0)) * 100) / 100,
    );
    expect(summary.gross.deltaPct).not.toBeNull();
    expect(summary.gross.masked).toBe(false);
    expect(summary.profit.value).not.toBeNull();
    expect(summary.rpm.value).not.toBeNull();
    expect(summary.marginPct.value).not.toBeNull();
    // A window-level count, never the sum of the weekly counts.
    expect(summary.activeTrucks.value).toBeGreaterThan(0);
    expect(summary.totalMiles.value).toBeGreaterThan(0);
  });

  it('trends summary discloses how much of the window has expense data', async () => {
    // The trailing window for last_week contains DEMO_WEEK_WITHOUT_EXPENSES: its gross counts
    // toward the rollup while its costs do not, so the rolled-up margin flatters the window.
    const partial = await service.trends(admin, { period: 'last_week' });
    expect(partial.summary?.expenseCoverage).toEqual({ weeks: 8, weeksWithData: 7 });
    expect(partial.weeks.filter((w) => w.hasExpenseData)).toHaveLength(7);

    // A window ending before that week is fully covered.
    const full = await service.trends(admin, {
      period: 'custom',
      from: '2026-07-06',
      to: '2026-07-12',
    });
    expect(full.summary?.window).toEqual({ from: '2026-05-18', to: '2026-07-12', weeks: 8 });
    expect(full.summary?.expenseCoverage).toEqual({ weeks: 8, weeksWithData: 8 });
  });

  it('trends summary leaves the comparison null when the data does not reach back a window', async () => {
    const trends = await service.trends(admin, {
      period: 'custom',
      from: '2026-05-04',
      to: '2026-05-10',
    });
    const summary = trends.summary;
    expect(summary).not.toBeNull();
    if (summary === null) return;

    expect(summary.window).toEqual({ from: '2026-03-16', to: '2026-05-10', weeks: 8 });
    expect(summary.previousWindow).toEqual({ from: '2026-01-19', to: '2026-03-15', weeks: 0 });
    expect(summary.gross.value).toBeGreaterThan(0);
    for (const metric of [summary.gross, summary.cost, summary.totalMiles, summary.activeTrucks]) {
      expect(metric.previous).toBeNull();
      expect(metric.delta).toBeNull();
      expect(metric.deltaPct).toBeNull();
    }
  });

  it('trends summary reports cost-derived metrics as unknown when the window has no expenses', async () => {
    const trends = await service.trends(admin, {
      period: 'custom',
      from: '2026-01-05',
      to: '2026-01-11',
    });
    const summary = trends.summary;
    expect(summary).not.toBeNull();
    if (summary === null) return;

    expect(trends.weeks.every((w) => w.hasExpenseData === false)).toBe(true);
    expect(summary.cost.value).toBeNull();
    expect(summary.cost.reasons).toContain('no_expense_data');
    expect(summary.profit.value).toBeNull();
    expect(summary.cpm.value).toBeNull();
    expect(summary.ppm.value).toBeNull();
    expect(summary.marginPct.value).toBeNull();
    expect(summary.marginPct.reasons).toContain('no_expense_data');
    // Gross is a real zero here, not unknown.
    expect(summary.gross.value).toBe(0);
  });

  it('ops-net totals reconcile with the overview and every bucket breaks costs down', async () => {
    const [overview, opsNet] = await Promise.all([
      service.overview(admin, { period: 'last_week' }),
      service.opsNet(admin, { period: 'last_week' }),
    ]);

    expect(opsNet.totals.label).toBe('Total');
    expect(opsNet.totals.gross).toBe(overview.financial.gross.value);
    expect(opsNet.totals.totalCost).toBe(overview.financial.cost.value);
    expect(opsNet.totals.operatingProfit).toBe(overview.financial.operatingProfit.value);
    expect(opsNet.totals.rpm).toBe(overview.unitEconomics.rpm.value);
    expect(opsNet.totals.totalMiles).toBe(overview.unitEconomics.totalMiles.value);
    expect(opsNet.totals.activeTrucks).toBe(overview.fleet.activeTrucks.value);
    expect(opsNet.totals.avgGrossPerTruck).toBe(overview.fleet.avgGrossPerTruck.value);
    expect(opsNet.inactiveTruckLoss).toBe(overview.financial.inactiveTruckLoss.value);
    expect(opsNet.netOperatingProfit).toBe(overview.financial.netOperatingProfit.value);

    const bucketGross = opsNet.buckets.reduce((acc, b) => acc + (b.gross ?? 0), 0);
    expect(Math.round(bucketGross * 100) / 100).toBe(opsNet.totals.gross);
    const bucketTrucks = opsNet.buckets.reduce((acc, b) => acc + (b.activeTrucks ?? 0), 0);
    expect(bucketTrucks).toBe(opsNet.totals.activeTrucks);

    for (const bucket of opsNet.buckets) {
      expect(Object.keys(bucket.costs)).toHaveLength(10);
      const categorySum = Object.values(bucket.costs).reduce<number>((a, v) => a + (v ?? 0), 0);
      expect(Math.round(categorySum * 100) / 100).toBe(bucket.totalCost);
    }
  });

  it('masks every new money field for the executive role but keeps the counts', async () => {
    const [trends, opsNet] = await Promise.all([
      service.trends(executive, { period: 'last_week' }),
      service.opsNet(executive, { period: 'last_week' }),
    ]);

    for (const week of trends.weeks) {
      expect(week.ppm).toBeNull();
      expect(week.avgGrossPerTruck).toBeNull();
      expect(week.avgCostPerTruck).toBeNull();
      expect(week.avgProfitPerTruck).toBeNull();
      expect(week.activeByPayType).not.toBeNull();
      expect(week.activeTrucks).not.toBeNull();
      expect(week.avgMilesPerTruck).not.toBeNull();
    }

    const summary = trends.summary;
    expect(summary).not.toBeNull();
    for (const key of ['gross', 'cost', 'profit', 'rpm', 'cpm', 'ppm', 'marginPct'] as const) {
      expect(summary?.[key]).toMatchObject({
        value: null,
        previous: null,
        delta: null,
        deltaPct: null,
        masked: true,
      });
    }
    expect(summary?.totalMiles.value).not.toBeNull();
    expect(summary?.activeTrucks.value).not.toBeNull();
    expect(summary?.window.weeks).toBe(8);
    // Coverage is a count, not money: masking leaves it alone.
    expect(summary?.expenseCoverage).toEqual({ weeks: 8, weeksWithData: 7 });

    expect(opsNet.inactiveTruckLoss).toBeNull();
    expect(opsNet.netOperatingProfit).toBeNull();
    for (const row of [...opsNet.buckets, opsNet.totals]) {
      expect(Object.values(row.costs)).toEqual(Array<null>(10).fill(null));
      expect(row.gross).toBeNull();
      expect(row.totalCost).toBeNull();
      expect(row.rpm).toBeNull();
      expect(row.avgGrossPerTruck).toBeNull();
      expect(row.activeTrucks).not.toBeNull();
      expect(row.totalMiles).not.toBeNull();
    }
    expect(opsNet.totals.driverCount).toBeGreaterThan(0);

    const adminOpsNet = await service.opsNet(admin, { period: 'last_week' });
    const adminMoney = [
      adminOpsNet.totals.gross,
      adminOpsNet.totals.totalCost,
      adminOpsNet.inactiveTruckLoss,
      ...adminOpsNet.buckets.map((b) => b.gross),
      ...adminOpsNet.buckets.flatMap((b) => Object.values(b.costs)),
    ].filter((value): value is number => value !== null && value !== 0);
    const json = JSON.stringify([trends, opsNet]);
    for (const value of adminMoney) expect(json).not.toContain(String(value));
  });

  it('serves the second call for the same company and range from the cache', async () => {
    const spy = vi.spyOn(source, 'facts');
    await service.overview(admin, { period: 'last_week' });
    expect(spy).toHaveBeenCalledTimes(2); // current + comparison
    await service.overview(admin, { period: 'last_week' });
    await service.opsNet(admin, { period: 'last_week' });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.every(([companyId]) => companyId === DEMO_COMPANY.id)).toBe(true);
  });
});
