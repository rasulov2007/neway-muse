import type { DashboardVendors } from '@neway/shared';
import { computeVendorMoney } from '../reporting/vendor-trucks';
import { canViewFinancial } from './masking';


import { Inject, Injectable } from '@nestjs/common';
import {
  costMix,
  dateBasisNote,
  DashboardDataHealthSchema,
  DashboardDispatchSchema,
  DashboardDrilldownSchema,
  DashboardFuelSchema,
  DashboardOpsNetSchema,
  DashboardOverviewSchema,
  DashboardTrendsSchema,
  DashboardTruckPnlSchema,
  type DashboardDataHealth,
  type DashboardDispatch,
  type DashboardDrilldown,
  type DashboardFuel,
  type DashboardMeta,
  type DashboardOpsNet,
  type DashboardOverview,
  type DashboardPeriodQuery,
  type DashboardTrends,
  type DashboardTruckPnl,
  type DispatchTeam,
  type DrilldownQuery,
  type MoneyMetric,
  type OpsNetPayType,
  type OpsNetTotals,
  type ResolvedPeriod,
  type TrendSummary,
  type TrendWeek,
  type TruckPnlQuery,
  type TruckPnlSortField,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import {
  activeTrucksByPayType,
  checkRevenueReconciliation,
  compareFinancials,
  computeDataQuality,
  computeDispatchPerformance,
  computeFinancials,
  computeFuelAnalytics,
  computeOpsNet,
  computeTruckPnl,
  filterTruckPnl,
  roundMoney,
  sortTruckPnl,
  sum,
  summarizeTruckPnl,
  type ComparedMetric,
  type DispatchTeamSummary,
  type DispatchTeamWeekMetrics,
  type DispatchWeekInfo,
  type FinancialResult,
  type FuelResult,
  type NullReason,
  type OpsNetResult,
  type OpsNetTotalsRow,
  type TruckPnlRow,
  type TruckPnlSort,
  type WeekCoverage,
} from '../reporting/engines';
import {
  REPORTING_DATA_SOURCE,
  type DateRange,
  type ReportingDataSource,
  type ReportingFacts,
} from '../reporting/facts';
import { daysInclusive } from '../reporting/period/date-utils';
import {
  ReportingPeriodService,
  type WeekRange,
} from '../reporting/period/reporting-period.service';
import { CLOCK, type Clock } from './clock';
import { DashboardCache, periodCacheKey } from './dashboard-cache';
import { buildDrilldown } from './drilldown';
import { sliceFacts } from './facts-slice';
import { applyVisibility } from './masking';

/** Facts for one company and range plus the engine results memoized on them. */
export interface PeriodComputation {
  facts: ReportingFacts;
  financials: FinancialResult;
  opsNet?: OpsNetResult;
  truckPnl?: TruckPnlRow[];
  fuel?: FuelResult;
}

/** Resolved period plus the response meta every section shares. */
interface PeriodContext {
  resolved: ResolvedPeriod;
  now: Date;
  meta: DashboardMeta;
}

const OPS_NET_LABELS: Record<OpsNetPayType, string> = {
  company: 'Company drivers',
  owner_operator: 'Owner operators',
  lease_owner: 'Lease owners',
  percentage: 'Percentage',
  unknown: 'Unknown pay type',
};

export const OPS_NET_TOTALS_LABEL = 'Total';

export const NO_EXPENSE_DATA_NOTE = 'No expense data available for this period';

/**
 * The running costs a trucking company always has. When a period records some costs but nothing at
 * all in one of these, the profit on this screen is revenue less what was recorded, not profit
 * after every cost — and the screen has to say so rather than let the number read as final.
 */
const ALWAYS_PRESENT_COSTS: { category: string; label: string }[] = [
  { category: 'fuel', label: 'fuel' },
  { category: 'maintenance', label: 'maintenance' },
  { category: 'insurance', label: 'insurance' },
  { category: 'tolls', label: 'tolls' },
];

/** The sentence naming what this period has no cost record for, or null when nothing is absent. */
export function absentCosts(breakdown: readonly { category: string; amount: number }[]): string | null {
  const recorded = new Set(breakdown.filter((e) => e.amount > 0).map((e) => e.category));
  const absent = ALWAYS_PRESENT_COSTS.filter((c) => !recorded.has(c.category)).map((c) => c.label);
  if (absent.length === 0) return null;
  const list = absent.length === 1 ? absent[0] : `${absent.slice(0, -1).join(', ')} and ${absent.at(-1)}`;
  return `Profit here is revenue less the costs recorded for this period. No ${list} cost is recorded, so it is not profit after every cost.`;
}

/**
 * Orchestrates the dashboard sections (docs/DASHBOARD.md §2): resolves the period for the
 * principal's company, loads facts through the reporting data source (cached per company and
 * range), runs the pure engines, maps to the shared contracts, validates and masks. It performs
 * no calculations of its own.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly periods: ReportingPeriodService,
    @Inject(REPORTING_DATA_SOURCE) private readonly source: ReportingDataSource,
    private readonly cache: DashboardCache<PeriodComputation>,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** `GET /dashboard/overview` */
  async overview(principal: Principal, query: DashboardPeriodQuery): Promise<DashboardOverview> {
    const ctx = this.context(principal, query);
    const [current, previous] = await Promise.all([
      this.load(principal, ctx.resolved),
      this.load(principal, ctx.resolved.comparison),
    ]);
    const f = current.financials;
    const compared = compareFinancials(f, previous.financials);
    const metric = (key: keyof typeof compared): MoneyMetric =>
      toMetric(compared[key], f.reasons[key]);
    const cost = metric('cost');
    if (f.costEstimated > 0) cost.estimated = { amount: f.costEstimated };
    const reconciliation = checkRevenueReconciliation(current.facts, f);
    // The books and the projection are different claims, and the screen has to keep them apart.
    const mix = costMix(current.facts.expenses);
    const body: DashboardOverview = {
      meta: ctx.meta,
      financial: {
        gross: metric('gross'),
        cost,
        operatingProfit: metric('operatingProfit'),
        inactiveTruckLoss: metric('inactiveTruckLoss'),
        netOperatingProfit: metric('netOperatingProfit'),
      },
      unitEconomics: {
        rpm: metric('rpm'),
        cpm: metric('cpm'),
        ppm: metric('ppm'),
        marginPct: metric('marginPct'),
        totalMiles: metric('totalMiles'),
      },
      fleet: {
        activeTrucks: metric('activeTrucks'),
        inactiveTrucks: metric('inactiveTrucks'),
        avgGrossPerTruck: metric('avgGrossPerTruck'),
        avgCostPerTruck: metric('avgCostPerTruck'),
        avgProfitPerTruck: metric('avgProfitPerTruck'),
        avgMilesPerTruck: metric('avgMilesPerTruck'),
        averagesBasis: 'active_trucks',
      },
      costBreakdown: f.costBreakdown.map((entry) => ({
        category: entry.category,
        amount: entry.amount,
        estimatedAmount: entry.estimated,
        share: entry.shareOfCostPct,
      })),
      reconciliation: {
        status: reconciliation.status === 'ok' ? 'ok' : 'mismatch',
        dashboardGross: numberOf(reconciliation.data?.dashboardGross),
        ledgerGross: numberOf(reconciliation.data?.ledgerTotal),
        difference: reconciliation.amount ?? null,
      },
      costMix: {
        posted: mix.postedCents / 100,
        estimated: mix.estimatedCents / 100,
        unallocatedPosted: mix.unallocatedPostedCents / 100,
        hasEstimates: mix.hasEstimates,
        dateBasis: dateBasisNote(mix),
      },
      expenseCoverage: f.hasExpenseData
        ? { hasData: true, ...(absentCosts(f.costBreakdown) ? { note: absentCosts(f.costBreakdown) as string } : {}) }
        : { hasData: false, note: NO_EXPENSE_DATA_NOTE },
    };
    return applyVisibility('overview', DashboardOverviewSchema.parse(body), principal);
  }

  /**
   * `GET /dashboard/trends`: the trailing 8 reporting weeks, each computed on a slice of facts,
   * plus a `summary` rolling the whole window up against the 8 reporting weeks before it.
   *
   * Both windows are fetched in one data-source call each and rolled up with `computeFinancials`
   * over the window's own facts — the rollup is NOT the sum of the per-week values. It agrees for
   * plain sums such as gross, but rates (rpm, cpm, ppm, marginPct) and counts (activeTrucks) are
   * window-level figures that averaging weeks would misstate.
   */
  async trends(principal: Principal, query: DashboardPeriodQuery): Promise<DashboardTrends> {
    const ctx = this.context(principal, query);
    const weeks = this.periods.trailingWeeks(ctx.resolved, 8, ctx.now);
    const first = weeks[0];
    if (first === undefined) {
      const empty: DashboardTrends = { meta: ctx.meta, weeks: [], summary: null, masked: false };
      return applyVisibility('trends', DashboardTrendsSchema.parse(empty), principal);
    }
    const previousWeeks = this.periods.precedingWeeks(first, weeks.length);
    const [span, previousSpan] = await Promise.all([
      this.loadSpan(principal, weeks),
      this.loadSpan(principal, previousWeeks),
    ]);
    const rows: TrendWeek[] = weeks.map((week) => {
      const slice = sliceFacts(span.facts, { from: week.weekStart, to: week.weekEnd });
      const f = computeFinancials(slice);
      return {
        weekStart: week.weekStart,
        weekEnd: week.weekEnd,
        label: week.label,
        highlighted: week.highlighted,
        isComplete: week.isComplete,
        gross: f.gross,
        cost: f.cost,
        profit: f.operatingProfit,
        rpm: f.rpm,
        cpm: f.cpm,
        ppm: f.ppm,
        marginPct: f.marginPct,
        totalMiles: f.totalMiles,
        activeTrucks: f.activeTrucks,
        inactiveTrucks: f.inactiveTrucks,
        activeByPayType: activeTrucksByPayType(slice),
        avgGrossPerTruck: f.avgGrossPerTruck,
        avgCostPerTruck: f.avgCostPerTruck,
        avgProfitPerTruck: f.avgProfitPerTruck,
        avgMilesPerTruck: f.avgMilesPerTruck,
        hasExpenseData: f.hasExpenseData,
      };
    });
    const body: DashboardTrends = {
      meta: ctx.meta,
      weeks: rows,
      summary: buildTrendSummary(rows, span, previousWeeks, previousSpan),
      masked: false,
    };
    return applyVisibility('trends', DashboardTrendsSchema.parse(body), principal);
  }

  /** `GET /dashboard/ops-net` */
  async opsNet(principal: Principal, query: DashboardPeriodQuery): Promise<DashboardOpsNet> {
    const ctx = this.context(principal, query);
    const current = await this.load(principal, ctx.resolved);
    const result = (current.opsNet ??= computeOpsNet(current.facts));
    const body: DashboardOpsNet = {
      meta: ctx.meta,
      buckets: result.buckets.map((bucket) => ({
        payType: bucket.key,
        ...toOpsNetRow(bucket, OPS_NET_LABELS[bucket.key]),
      })),
      totals: toOpsNetRow(result.totals, OPS_NET_TOTALS_LABEL),
      inactiveTruckLoss: result.inactiveTruckLoss,
      netOperatingProfit: result.netOperatingProfit,
      unknown: {
        driverCount: result.unknown.driverCount,
        gross: result.unknown.gross,
        drivers: result.unknown.drivers.map((driver) => ({
          driverId: driver.driverId,
          name: driver.name,
          rawPayTag: driver.rawPayTag,
        })),
      },
      masked: false,
    };
    return applyVisibility('opsNet', DashboardOpsNetSchema.parse(body), principal);
  }

  /**
   * `GET /dashboard/vendors` (owner, 2026-10-28): the vendor trucks' money for the period. The
   * company share is already inside revenue and profit everywhere else; this shows it beside the
   * vendor's side. Money is withheld from a role that does not see financials.
   */
  async vendors(principal: Principal, query: DashboardPeriodQuery): Promise<DashboardVendors> {
    const ctx = this.context(principal, query);
    const current = await this.load(principal, ctx.resolved);
    const summary = computeVendorMoney(current.facts, { from: ctx.resolved.from, to: ctx.resolved.to });
    if (!canViewFinancial(principal)) {
      return { meta: ctx.meta, masked: true, ...summary, trucks: [], totals: { ...summary.totals, gross: 0, companyShare: 0, driverPay: 0, truckCosts: 0, vendorNet: 0 } };
    }
    return { meta: ctx.meta, masked: false, ...summary };
  }

  /** `GET /dashboard/truck-pnl`: filters, sort, totals and paging via the engine helpers. */
  async truckPnl(principal: Principal, query: TruckPnlQuery): Promise<DashboardTruckPnl> {
    const ctx = this.context(principal, query);
    const current = await this.load(principal, ctx.resolved);
    const rows = (current.truckPnl ??= computeTruckPnl(current.facts));
    const filtered = filterTruckPnl(rows, {
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.payType !== undefined ? { payType: query.payType } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.unit !== undefined ? { unit: query.unit } : {}),
      ...(query.view !== 'all' ? { view: query.view } : {}),
    });
    const sorted = sortTruckPnl(filtered, parseSort(query.sort));
    const totals = summarizeTruckPnl(sorted);
    const estimated = sorted
      .map((row) => row.costEstimated)
      .filter((value): value is number => value !== null);
    const start = (query.page - 1) * query.pageSize;
    const body: DashboardTruckPnl = {
      meta: ctx.meta,
      rows: sorted.slice(start, start + query.pageSize).map((row) => ({
        truckId: row.truckId,
        unitNumber: row.unitNumber,
        status: row.status,
        driverId: row.driverId,
        driverName: row.driverName,
        payType: row.payType ?? 'unknown',
        gross: row.gross,
        miles: row.miles,
        loads: row.loads,
        cost: row.cost,
        costEstimated: row.costEstimated,
        profit: row.profit,
        inactiveLoss: row.inactiveLoss,
      })),
      totals: {
        trucks: totals.trucks,
        gross: totals.gross,
        miles: totals.miles,
        loads: totals.loads,
        cost: totals.cost,
        costEstimated: totals.cost === null ? null : roundMoney(sum(estimated)),
        profit: totals.profit,
        inactiveLoss: totals.inactiveLoss,
        inactiveTrucks: totals.inactiveLossTrucks,
      },
      page: { page: query.page, pageSize: query.pageSize, total: sorted.length },
      masked: false,
    };
    return applyVisibility('truckPnl', DashboardTruckPnlSchema.parse(body), principal);
  }

  /** `GET /dashboard/fuel` */
  async fuel(principal: Principal, query: DashboardPeriodQuery): Promise<DashboardFuel> {
    const ctx = this.context(principal, query);
    const current = await this.load(principal, ctx.resolved);
    const result = this.fuelOf(current);
    const body: DashboardFuel = {
      meta: ctx.meta,
      totals: {
        fillUps: result.totals.fillUps,
        gallons: result.totals.gallons,
        discountedCost: result.totals.discountedCost,
        grossCost: result.totals.grossCost,
        avgPricePerGallon: result.totals.avgPricePerGallon,
        fuelCostPerMile: result.totals.fuelCostPerMile,
      },
      byTruck: result.byTruck.map((row) => ({
        id: row.truckId ?? 'unassigned',
        label: row.unitNumber ?? row.truckId ?? 'Unassigned',
        fillUps: row.fillUps,
        gallons: row.gallons,
        cost: row.cost,
        share: row.sharePct,
      })),
      byDriver: result.byDriver.map((row) => ({
        id: row.driverId ?? 'unassigned',
        label: row.name ?? row.driverId ?? 'Unassigned',
        fillUps: row.fillUps,
        gallons: row.gallons,
        cost: row.cost,
        share: row.sharePct,
      })),
      byState: result.byState.map((row) => ({
        state: row.state,
        fillUps: row.fillUps,
        gallons: row.gallons,
        cost: row.cost,
        avgPricePerGallon: row.avgPricePerGallon,
      })),
      masked: false,
    };
    return applyVisibility('fuel', DashboardFuelSchema.parse(body), principal);
  }

  /** `GET /dashboard/dispatch-performance` */
  async dispatchPerformance(
    principal: Principal,
    query: DashboardPeriodQuery,
  ): Promise<DashboardDispatch> {
    const ctx = this.context(principal, query);
    const weeks = this.periods.dispatchWeeks(ctx.resolved, ctx.now);
    const today = this.periods.today(principal.companyTimezone, ctx.now);
    const infos: DispatchWeekInfo[] = weeks.map((week) => ({
      weekStart: week.weekStart,
      isComplete: week.isComplete,
      elapsedDays: week.isComplete
        ? 7
        : Math.min(7, Math.max(1, daysInclusive(week.weekStart, today))),
    }));
    const span = await this.loadSpan(principal, weeks);
    const result = computeDispatchPerformance(span.facts.dispatchWeeks, infos);
    const body: DashboardDispatch = {
      meta: ctx.meta,
      weeks: weeks.map((week) => ({
        weekStart: week.weekStart,
        label: week.label,
        isComplete: week.isComplete,
      })),
      teams: result.teams.map((team) => toDispatchTeam(team)),
      rpmBucketsTotal: result.rpmBucketsTotal,
      masked: false,
    };
    return applyVisibility('dispatch', DashboardDispatchSchema.parse(body), principal);
  }

  /** `GET /dashboard/data-health`: checks over the period; completeness over the trailing 8 weeks. */
  async dataHealth(
    principal: Principal,
    query: DashboardPeriodQuery,
  ): Promise<DashboardDataHealth> {
    const ctx = this.context(principal, query);
    const weeks = this.periods.trailingWeeks(ctx.resolved, 8, ctx.now);
    const [current, span] = await Promise.all([
      this.load(principal, ctx.resolved),
      this.loadSpan(principal, weeks),
    ]);
    const coverage: WeekCoverage[] = weeks.map((week) => ({
      weekStart: week.weekStart,
      hasExpenseData:
        span.facts.expenseCoverage.find((c) => c.weekStart === week.weekStart)?.hasExpenseData ??
        false,
    }));
    const checks = computeDataQuality(current.facts, current.financials, coverage);
    const body: DashboardDataHealth = {
      meta: ctx.meta,
      checks: checks.map((check) => ({
        key: check.key,
        status: check.status,
        title: check.title,
        detail: check.detail,
        ...(check.count !== undefined ? { count: check.count } : {}),
        ...(check.amount !== undefined ? { amount: check.amount } : {}),
      })),
      summary: {
        ok: checks.filter((c) => c.status === 'ok').length,
        warning: checks.filter((c) => c.status === 'warning').length,
        error: checks.filter((c) => c.status === 'error').length,
      },
    };
    return applyVisibility('dataHealth', DashboardDataHealthSchema.parse(body), principal);
  }

  /** `GET /dashboard/drilldown`: contributing records whose total equals the headline. */
  async drilldown(principal: Principal, query: DrilldownQuery): Promise<DashboardDrilldown> {
    const ctx = this.context(principal, query);
    const current = await this.load(principal, ctx.resolved);
    const data = buildDrilldown(
      query.metric,
      current.facts,
      current.financials,
      this.fuelOf(current),
    );
    const start = (query.page - 1) * query.pageSize;
    const body: DashboardDrilldown = {
      meta: ctx.meta,
      metric: query.metric,
      title: data.title,
      total: data.total,
      columns: data.columns,
      rows: data.rows.slice(start, start + query.pageSize),
      page: { page: query.page, pageSize: query.pageSize, total: data.rows.length },
    };
    return applyVisibility('drilldown', DashboardDrilldownSchema.parse(body), principal);
  }

  /** Resolves the period for the principal's company settings and builds the response meta. */
  private context(principal: Principal, query: DashboardPeriodQuery): PeriodContext {
    const now = this.clock();
    const resolved = this.periods.resolve(
      { period: query.period, from: query.from, to: query.to },
      { timezone: principal.companyTimezone, weekStart: principal.weekStart },
      now,
    );
    return {
      resolved,
      now,
      meta: { source: this.source.kind, generatedAt: now.toISOString(), period: resolved },
    };
  }

  /** Facts and headline financials for a range, cached per company, range and source. */
  private load(principal: Principal, range: DateRange): Promise<PeriodComputation> {
    const key = periodCacheKey(principal.companyId, range, this.source.kind);
    return this.cache.getOrCreate(key, async () => {
      const facts = await this.source.facts(principal.companyId, {
        from: range.from,
        to: range.to,
      });
      return { facts, financials: computeFinancials(facts) };
    });
  }

  /** Facts covering a list of consecutive reporting weeks, loaded once. */
  private loadSpan(principal: Principal, weeks: readonly WeekRange[]): Promise<PeriodComputation> {
    return this.load(principal, spanRange(weeks));
  }

  private fuelOf(computation: PeriodComputation): FuelResult {
    return (computation.fuel ??= computeFuelAnalytics(
      computation.facts,
      computation.financials.totalMiles,
    ));
  }
}

/** Inclusive date bounds of a list of consecutive reporting weeks. */
function spanRange(weeks: readonly WeekRange[]): DateRange {
  const first = weeks[0];
  const last = weeks[weeks.length - 1];
  if (first === undefined || last === undefined) {
    throw new RangeError('at least one reporting week is required');
  }
  return { from: first.weekStart, to: last.weekEnd };
}

/**
 * True when a loaded span holds any dated record. Trucks and drivers are company-level and come
 * back for every range, so only dated rows can tell a real window from one before the data begins.
 */
function spanHasRecords(facts: ReportingFacts): boolean {
  return (
    facts.revenue.length > 0 ||
    facts.expenses.length > 0 ||
    facts.fuel.length > 0 ||
    facts.mileage.length > 0 ||
    facts.dispatchWeeks.length > 0 ||
    facts.expenseCoverage.length > 0
  );
}

/**
 * The trend window rolled up against the equivalent window before it (docs/DASHBOARD.md §4).
 *
 * Each side is `computeFinancials` over that window's own facts — deliberately not the sum or the
 * average of the per-week rows, which would misstate every rate and count. When the previous span
 * holds no records at all the dataset does not reach back that far: `previousWindow.weeks` is 0 and
 * every `previous`, `delta` and `deltaPct` stays null rather than pretending the window was empty.
 *
 * `expenseCoverage` discloses how much of the window has expense data at all. A week with revenue
 * but no costs still adds its gross to the rollup, so the rolled-up profit and margin read better
 * than any single week; the count lets the UI say so instead of presenting the figure bare. It is
 * a disclosure, not a correction: the metric values are left exactly as the engine computed them.
 */
function buildTrendSummary(
  weeks: readonly TrendWeek[],
  span: PeriodComputation,
  previousWeeks: readonly WeekRange[],
  previousSpan: PeriodComputation,
): TrendSummary {
  const reaches = spanHasRecords(previousSpan.facts);
  const current = span.financials;
  const compared = compareFinancials(current, reaches ? previousSpan.financials : null);
  const metric = (key: keyof typeof compared): MoneyMetric =>
    toMetric(compared[key], current.reasons[key]);
  return {
    window: { ...spanRange(weeks), weeks: weeks.length },
    previousWindow: { ...spanRange(previousWeeks), weeks: reaches ? previousWeeks.length : 0 },
    gross: metric('gross'),
    cost: metric('cost'),
    profit: metric('operatingProfit'),
    rpm: metric('rpm'),
    cpm: metric('cpm'),
    ppm: metric('ppm'),
    marginPct: metric('marginPct'),
    totalMiles: metric('totalMiles'),
    activeTrucks: metric('activeTrucks'),
    expenseCoverage: {
      weeks: weeks.length,
      weeksWithData: weeks.filter((week) => week.hasExpenseData).length,
    },
  };
}

/** Maps an engine ops-net row (a bucket or the totals row) to the shared contract shape. */
function toOpsNetRow(row: OpsNetTotalsRow, label: string): OpsNetTotals {
  return {
    label,
    driverCount: row.driverCount,
    gross: row.gross,
    costs: { ...row.costs },
    fuel: row.fuel,
    insurance: row.insurance,
    factoring: row.factoring,
    driverPay: row.driverPay,
    driverPayEstimated: row.driverPayEstimated,
    other: row.other,
    totalCost: row.totalCost,
    operatingProfit: row.operatingProfit,
    marginPct: row.marginPct,
    rpm: row.rpm,
    totalMiles: row.totalMiles,
    activeTrucks: row.activeTrucks,
    avgGrossPerTruck: row.avgGrossPerTruck,
    avgMilesPerTruck: row.avgMilesPerTruck,
  };
}

/** Maps an engine comparison to the shared metric shape. */
function toMetric(compared: ComparedMetric, reasons: readonly NullReason[]): MoneyMetric {
  return {
    value: compared.value,
    previous: compared.previous,
    delta: compared.delta,
    deltaPct: compared.deltaPct,
    reasons: [...reasons],
    masked: false,
  };
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/** Parses `field` / `-field` into an engine sort. */
function parseSort(sort: string): TruckPnlSort {
  const descending = sort.startsWith('-');
  const field = (descending ? sort.slice(1) : sort) as TruckPnlSortField;
  return { field, direction: descending ? 'desc' : 'asc' };
}

const ZERO_WEEK: Pick<
  DispatchTeamWeekMetrics,
  'gross' | 'loads' | 'activeTrucks' | 'activeDaysPct' | 'rpm' | 'grossPerTruck' | 'rpmBuckets'
> & { estimatedFullWeekGross: { value: number; estimated: boolean } } = {
  gross: 0,
  loads: 0,
  activeTrucks: 0,
  activeDaysPct: null,
  rpm: null,
  grossPerTruck: null,
  rpmBuckets: { lt150: 0, b150to200: 0, b200to250: 0, gte250: 0 },
  estimatedFullWeekGross: { value: 0, estimated: false },
};

/**
 * Maps a team summary to the contract: headline figures come from the latest listed week (the
 * selected one), `byWeek` carries actual gross per week, and `total` never includes estimates.
 */
function toDispatchTeam(team: DispatchTeamSummary): DispatchTeam {
  const latest = team.byWeek[team.byWeek.length - 1] ?? ZERO_WEEK;
  return {
    teamId: team.teamId,
    teamName: team.teamName,
    gross: latest.gross,
    loads: latest.loads,
    activeTrucks: latest.activeTrucks,
    activeDaysPct: latest.activeDaysPct,
    rpm: latest.rpm,
    grossPerTruck: latest.grossPerTruck,
    estimatedFullWeekGross: {
      value: latest.estimatedFullWeekGross.value,
      estimated: latest.estimatedFullWeekGross.estimated,
    },
    rpmBuckets: latest.rpmBuckets,
    byWeek: team.byWeek.map((week) => ({
      weekStart: week.weekStart,
      gross: week.gross,
      estimated: !week.isComplete,
    })),
    total: team.totals.gross,
  };
}
