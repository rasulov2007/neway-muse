import { describe, expect, it } from 'vitest';
import type { Principal } from '../../common/auth/principal';
import type { DatabaseService } from '../../database/database.service';
import { expense, makeFacts, mileage, revenue, truck } from '../reporting/engines/fixtures';
import type { DateRange, ReportingDataSource, ReportingFacts } from '../reporting/facts';
import { ReportingPeriodService } from '../reporting/period/reporting-period.service';
import { pageRanking, parseRankingQuery } from './analytics-ranking';
import { AnalyticsService } from './analytics.service';

const CURRENT = { from: '2026-09-01', to: '2026-09-07' } as const;
const principal = (companyId = 'C1') =>
  ({ companyId, companyTimezone: 'America/New_York', weekStart: 1 }) as unknown as Principal;

/** A data source that records who asked, and answers with `current` or `prior` facts. */
function source(build: (isCurrent: boolean) => ReportingFacts) {
  const calls: { companyId: string; range: DateRange }[] = [];
  const facts: ReportingDataSource = {
    kind: 'database',
    async facts(companyId, range) {
      calls.push({ companyId, range });
      return { ...build(range.from === CURRENT.from), companyId, range };
    },
  };
  return { facts, calls };
}

function service(facts: ReportingDataSource) {
  return new AnalyticsService(
    facts,
    new ReportingPeriodService(),
    {} as DatabaseService,
    () => new Date('2026-09-07T12:00:00Z'),
  );
}

/** One truck per id: 3,000 gross and 2,500 odometer miles in both periods; cost varies. */
function fleet(costs: Record<string, number>, miles = 2500): ReportingFacts {
  const ids = Object.keys(costs);
  return makeFacts({
    trucks: ids.map((id) => truck({ truckId: id, unitNumber: id })),
    revenue: ids.map((id) =>
      // Rates divide by load miles since the data-integrity pass, so the load carries the miles.
      revenue({
        loadId: `L${id}`,
        truckId: id,
        driverId: null,
        linehaul: 3000,
        loadedMiles: miles * 0.8,
        emptyMiles: miles * 0.2,
      }),
    ),
    mileage: ids.map((id) => mileage({ truckId: id, miles })),
    expenses: ids.map((id) => expense({ id: `E${id}`, truckId: id, amount: costs[id] ?? 0 })),
  });
}

describe('AnalyticsService', () => {
  it('reads facts only for the principal’s company', async () => {
    const { facts, calls } = source(() => makeFacts());
    const analytics = service(facts);
    const p = principal('co_other');
    await analytics.executive(p, 'custom', CURRENT.from, CURRENT.to);
    await analytics.costDrivers(p, 'custom', CURRENT.from, CURRENT.to);
    await analytics.truckRanking(p, 'custom', CURRENT.from, CURRENT.to);
    await analytics.driverRanking(p, 'custom', CURRENT.from, CURRENT.to);
    await analytics.operations(p, 'custom', CURRENT.from, CURRENT.to);
    await analytics.fuel(p, 'custom', CURRENT.from, CURRENT.to);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((c) => c.companyId))).toEqual(new Set(['co_other']));
  });

  it('with no cost data: cost, profit and margin are null, never zero, and say why', async () => {
    const { facts } = source(() => makeFacts({ expenses: [] }));
    const analytics = service(facts);
    const exec = await analytics.executive(principal(), 'custom', CURRENT.from, CURRENT.to);
    const byKey = Object.fromEntries(exec.metrics.map((m) => [m.key, m]));
    expect(byKey.cost?.current).toBeNull();
    expect(byKey.profit?.current).toBeNull();
    expect(byKey.marginPct?.current).toBeNull();
    expect(byKey.gross?.current).toBeGreaterThan(0);
    expect(exec.notes.join(' ')).toMatch(/No expense data/);
    for (const point of exec.trend) {
      expect(point.cost).toBeNull();
      expect(point.profit).toBeNull();
    }
    const trucks = await analytics.truckRanking(principal(), 'custom', CURRENT.from, CURRENT.to);
    for (const row of trucks.rows) {
      expect(row.cost).toBeNull();
      expect(row.profit).toBeNull();
      expect(row.marginPct).toBeNull();
    }
    const costs = await analytics.costDrivers(principal(), 'custom', CURRENT.from, CURRENT.to);
    expect(costs.drivers).toEqual([]);
    expect(costs.notes).toEqual(['No expense data in this period.']);
  });

  describe('Needs attention', () => {
    it('flags CPM +15% as warning and +30% as critical, margin −3 / −8 points, critical first', async () => {
      const { facts } = source((isCurrent) =>
        isCurrent ? fleet({ A: 1200, B: 1400, C: 1050 }) : fleet({ A: 1000, B: 1000, C: 1000 }),
      );
      const exec = await service(facts).executive(principal(), 'custom', CURRENT.from, CURRENT.to);
      const found = exec.insights.map((i) => `${i.key}:${i.severity}`);
      // A: CPM 0.40 → 0.48 (+20%), margin 66.67 → 60 (−6.67 pts).
      // B: CPM 0.40 → 0.56 (+40%), margin 66.67 → 53.33 (−13.33 pts).
      // C: CPM +5% and margin −1.67 pts: under both thresholds.
      expect(found).toEqual(['cpm_B:critical', 'margin_B:critical', 'cpm_A:warning', 'margin_A:warning']);
      for (const insight of exec.insights) expect(insight.href).toMatch(/^\/fleet\/trucks\//);
    });

    it('ignores trucks under 2,000 miles in either period', async () => {
      const { facts } = source((isCurrent) =>
        isCurrent ? fleet({ A: 1800 }, 1999) : fleet({ A: 1000 }, 2500),
      );
      const exec = await service(facts).executive(principal(), 'custom', CURRENT.from, CURRENT.to);
      // No per-truck finding; the data-integrity pass says so with an info item instead.
      expect(exec.insights.filter((i) => !i.key.startsWith('data_'))).toEqual([]);
      expect(exec.insights.every((i) => i.severity === 'info')).toBe(true);
    });

    it('returns at most 12 findings', async () => {
      const ids = Array.from({ length: 10 }, (_, i) => `T${i}`);
      const now = Object.fromEntries(ids.map((id) => [id, 1600]));
      const before = Object.fromEntries(ids.map((id) => [id, 1000]));
      const { facts } = source((isCurrent) => (isCurrent ? fleet(now) : fleet(before)));
      const exec = await service(facts).executive(principal(), 'custom', CURRENT.from, CURRENT.to);
      expect(exec.insights).toHaveLength(12);
    });
  });

  it('operations volume compares the same sums with the previous period', async () => {
    const { facts } = source((isCurrent) =>
      makeFacts(
        isCurrent
          ? {}
          : { revenue: [revenue({ loadId: 'P', loadedMiles: 1000, emptyMiles: 300 })] },
      ),
    );
    const ops = await service(facts).operations(principal(), 'custom', CURRENT.from, CURRENT.to);
    expect(ops.loads).toBe(3);
    const volume = Object.fromEntries(ops.volume.map((m) => [m.key, m]));
    expect(volume.loads).toMatchObject({ current: ops.loads, previous: 1, change: 2 });
    expect(volume.loadedMiles).toMatchObject({ current: ops.loadedMiles, previous: 1000 });
    expect(volume.emptyMiles).toMatchObject({ current: ops.emptyMiles, previous: 300 });
    // The figures that were there before keep their values and order.
    expect(ops.metrics.map((m) => m.key)).toEqual(['miles', 'emptyPct', 'rpm', 'linehaulRpm']);
  });

  it('a paged ranking is a window onto the full, server-sorted list', async () => {
    const costs = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`U${String(i).padStart(2, '0')}`, 100 * i]),
    );
    const { facts } = source(() => fleet(costs));
    const analytics = service(facts);
    const full = await analytics.truckRanking(principal(), 'custom', CURRENT.from, CURRENT.to);
    const paging = parseRankingQuery({ page: '2', pageSize: '25' }, { sort: 'profit', dir: 'desc' });
    const page = await analytics.truckRanking(principal(), 'custom', CURRENT.from, CURRENT.to, paging);
    expect('total' in page && page.total).toBe(30);
    const expected = [...full.rows].sort((a, b) => (b.profit ?? 0) - (a.profit ?? 0)).slice(25);
    expect(page.rows).toEqual(expected);
    // Rows are the same objects' values as unpaged: nothing recomputed.
    for (const row of page.rows) expect(full.rows).toContainEqual(row);
  });
});

describe('ranking paging', () => {
  const rows = [
    { label: '101', profit: 5 },
    { label: '102', profit: null },
    { label: '103', profit: 9 },
    { label: '204', profit: -2 },
  ];

  it('returns null when no paging parameter was sent', () => {
    expect(parseRankingQuery({ preset: 'this_month' }, { sort: 'profit', dir: 'desc' })).toBeNull();
  });

  it('clamps page size and falls back to the default sort', () => {
    expect(parseRankingQuery({ pageSize: '500', sort: 'nope' }, { sort: 'gross', dir: 'desc' })).toEqual({
      page: 1,
      pageSize: 100,
      sort: 'gross',
      dir: 'desc',
      q: '',
    });
  });

  it('keeps missing values last in both directions', () => {
    const desc = pageRanking(rows, { page: 1, pageSize: 25, sort: 'profit', dir: 'desc', q: '' });
    expect(desc.rows.map((r) => r.label)).toEqual(['103', '101', '204', '102']);
    const asc = pageRanking(rows, { page: 1, pageSize: 25, sort: 'profit', dir: 'asc', q: '' });
    expect(asc.rows.map((r) => r.label)).toEqual(['204', '101', '103', '102']);
  });

  it('searches the whole list before paging and reports both counts', () => {
    const result = pageRanking(rows, { page: 1, pageSize: 1, sort: 'profit', dir: 'desc', q: '10' });
    expect(result).toMatchObject({ total: 3, totalAll: 4, page: 1 });
    expect(result.rows.map((r) => r.label)).toEqual(['103']);
  });

  it('pulls a page past the end back to the last page', () => {
    const result = pageRanking(rows, { page: 9, pageSize: 3, sort: 'label', dir: 'asc', q: '' });
    expect(result.page).toBe(2);
    expect(result.rows.map((r) => r.label)).toEqual(['204']);
  });
});
