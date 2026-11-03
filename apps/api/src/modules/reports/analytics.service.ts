import type { VendorMoneySummary } from '@neway/shared';
import { computeVendorMoney } from '../reporting/vendor-trucks';
import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import {
  ACTIVE_ROSTER_DRIVER_STATUSES,
  INSIGHT_THRESHOLDS,
  compareMetricPeriods,
  type Insight,
  type MetricComparison,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import {
  attendanceEntries,
  onboardingChecklists,
  ptoRequests,
} from '../../database/schema/hr';
import { hiringLeads } from '../../database/schema/hiring';
import { employees } from '../../database/schema/people';
import { drivers } from '../../database/schema/roster';
import {
  computeCostMix,
  computeFinancials,
  computeFuelAnalytics,
  computeRevenueMix,
  computeTruckPnl,
  profitBasis,
  revenueOf,
  type CostMix,
  type ProfitBasis,
  type RevenueMix,
} from '../reporting/engines';
import {
  REPORTING_DATA_SOURCE,
  type DateRange,
  type ReportingDataSource,
  type ReportingFacts,
} from '../reporting/facts';
import { ReportingPeriodService } from '../reporting/period/reporting-period.service';
import { addDays, localDateOf } from '../reporting/period/date-utils';
import { REPORTING_TIMEZONE } from '../reporting/workspace/workspace-reporting-data-source';
import { CLOCK, type Clock } from '../dashboard/clock';
import { pageRanking, type RankingPage, type RankingQuery } from './analytics-ranking';
import {
  buildAccessorialSplit,
  readAccessorialRaw,
  type AccessorialRaw,
  type AccessorialSplit,
} from './accessorial-split';

type RankingResponse =
  | { range: DateRange; rows: RankedEntity[] }
  | ({ range: DateRange } & RankingPage<RankedEntity>);

export interface TrendPoint {
  weekStart: string;
  /** Linehaul + accessorials + TONU. */
  gross: number;
  linehaul: number;
  accessorials: number;
  tonu: number;
  /** Net cost (after recoveries); null when the week has no cost line. */
  cost: number | null;
  /** Null unless the week has both delivered loads and cost (owner, 2026-10-25). */
  profit: number | null;
  miles: number;
}

export interface CostDriver {
  category: string;
  /** Negative for `recovered`. */
  amount: number;
  perMile: number | null;
  shareOfRevenue: number | null;
  changePct: number | null;
}

export interface RankedEntity {
  id: string;
  label: string;
  gross: number;
  cost: number | null;
  profit: number | null;
  miles: number | null;
  rpm: number | null;
  cpm: number | null;
  marginPct: number | null;
  href: string;
  /** Linehaul ÷ load miles. */
  linehaulRpm?: number | null;
  /** `cost_only` / `revenue_only` when one side is missing (F19); null when both or neither. */
  oneSided?: 'cost_only' | 'revenue_only' | null;
  /** Why profit is not shown for this row; null when it is. */
  profitReason?: string | null;
}

/** What the figures were built from - read, not configured (F3). */
export interface DataStatus {
  generated: boolean;
  revenue: {
    source: 'neway_loads';
    /** Real loads the company has in NeWay Loads, any date. 0 = revenue not connected. */
    loadsOnFile: number;
    connected: boolean;
    linesInPeriod: number;
  };
  cost: { linesInPeriod: number; bySource: Record<string, number> };
  fuel: { rowsInPeriod: number; latestAt: string | null; unlinkedLedgerFuel: number };
  profit: ProfitBasis;
}

export interface AnalyticsSection {
  range: { from: string; to: string; label: string };
  comparison: { from: string; to: string };
  /** `demo` only when the generated book was actually read. */
  source: 'demo' | 'database';
  metrics: MetricComparison[];
  notes: string[];
}

/** Analytics periods and business days are US Eastern (owner, 2026-09-25). */
const TIMEZONE = REPORTING_TIMEZONE;

/**
 * Analytics.
 *
 * The dashboard answers "what is happening". This answers "why, and where is it moving" — so every
 * figure is paired with the previous period, every cost is expressed as a rate as well as a total,
 * and every ranking is ordered so the worst performer is as easy to find as the best.
 *
 * Nothing here adds money up itself: gross, cost, the revenue and cost mix and the profit basis
 * come from the reporting engines over the same facts the dashboard and the reports read.
 *
 * Owner decisions of 2026-10-25 shape it: revenue is NeWay Loads (by Eastern delivery day); TONU
 * and accessorials are in gross and shown apart; RPM, CPM and PPM divide by load miles, with a
 * Linehaul RPM beside RPM; recoveries are a separate negative cost line; DEF and trailer repairs
 * are their own lines; and profit is never shown from one side alone.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(REPORTING_DATA_SOURCE) private readonly facts: ReportingDataSource,
    private readonly periods: ReportingPeriodService,
    private readonly database: DatabaseService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** The range and the comparison the period service resolved for it (F6). */
  private resolve(
    principal: Principal,
    preset: string,
    from?: string,
    to?: string,
  ): { range: { from: string; to: string; label: string }; comparison: DateRange } {
    if (from && to) {
      const range = { from, to, label: `${from} – ${to}` };
      return { range, comparison: this.periods.comparisonFor(range) };
    }
    const resolved = this.periods.resolve(
      { period: preset as never },
      { timezone: TIMEZONE, weekStart: principal.weekStart },
      this.clock(),
    );
    return {
      range: { from: resolved.from, to: resolved.to, label: resolved.label },
      comparison: { from: resolved.comparison.from, to: resolved.comparison.to },
    };
  }

  private sourceOf(facts: ReportingFacts): 'demo' | 'database' {
    if (facts.provenance) return facts.provenance.generated ? 'demo' : 'database';
    return this.facts.kind;
  }

  /** Headline figures, this period against the last, with every change honestly qualified. */
  async executive(
    principal: Principal,
    preset: string,
    from?: string,
    to?: string,
  ): Promise<
    AnalyticsSection & {
      trend: TrendPoint[];
      insights: Insight[];
      dataStatus: DataStatus;
      profitHidden: { code: string; reason: string } | null;
    }
  > {
    const { range, comparison } = this.resolve(principal, preset, from, to);
    const [current, prior] = await Promise.all([
      this.facts.facts(principal.companyId, range),
      this.facts.facts(principal.companyId, comparison),
    ]);

    const now = headline(current);
    const before = headline(prior);

    const metrics: MetricComparison[] = [
      compareMetricPeriods('gross', now.mix.gross, before.mix.gross),
      compareMetricPeriods('linehaul', now.mix.linehaul, before.mix.linehaul),
      compareMetricPeriods('accessorials', now.mix.accessorials, before.mix.accessorials),
      compareMetricPeriods('tonu', now.mix.tonu, before.mix.tonu),
      compareMetricPeriods('cost', now.costs.net, before.costs.net),
      compareMetricPeriods('costBeforeRecovery', now.costs.costBeforeRecovery, before.costs.costBeforeRecovery),
      compareMetricPeriods('recovered', now.costs.recovered, before.costs.recovered),
      compareMetricPeriods('profit', now.profit, before.profit),
      compareMetricPeriods('marginPct', now.marginPct, before.marginPct),
      compareMetricPeriods('miles', now.mix.loadMiles, before.mix.loadMiles),
      compareMetricPeriods('rpm', now.mix.rpm, before.mix.rpm),
      compareMetricPeriods('linehaulRpm', now.mix.linehaulRpm, before.mix.linehaulRpm),
      compareMetricPeriods('cpm', now.cpm, before.cpm),
      compareMetricPeriods('ppm', now.ppm, before.ppm),
      compareMetricPeriods('activeTrucks', now.financials.activeTrucks, before.financials.activeTrucks),
      compareMetricPeriods('grossPerTruck', now.financials.avgGrossPerTruck, before.financials.avgGrossPerTruck),
    ];

    const notes: string[] = [];
    if (!now.financials.hasExpenseData) {
      notes.push('No expense data in this period, so cost, profit and margin are unavailable.');
    }
    if (now.basis.reason && now.basis.code !== 'no_cost') notes.push(now.basis.reason);
    notes.push(...dataNotes(current, now.costs));

    return {
      range,
      comparison,
      source: this.sourceOf(current),
      metrics,
      notes,
      trend: this.trendOf(principal, current),
      insights: this.insights(current, prior, now, range),
      dataStatus: dataStatusOf(current, now.basis),
      profitHidden: now.basis.available ? null : { code: now.basis.code, reason: now.basis.reason ?? '' },
    };
  }

  /** Weekly gross, cost and profit — the same buckets the weekly board uses. */
  async trend(principal: Principal, range: DateRange): Promise<TrendPoint[]> {
    return this.trendOf(principal, await this.facts.facts(principal.companyId, range));
  }

  /**
   * Every week with revenue OR cost (F25): a week with only cost shows its cost and no profit,
   * so the chart and the header totals agree.
   */
  private trendOf(principal: Principal, facts: ReportingFacts): TrendPoint[] {
    const weeks = new Map<string, TrendPoint & { lines: number }>();
    const pointFor = (date: string) => {
      const weekStart = this.periods.weekOf(date, principal.weekStart).weekStart;
      const point = weeks.get(weekStart) ?? {
        weekStart,
        gross: 0,
        linehaul: 0,
        accessorials: 0,
        tonu: 0,
        cost: null,
        profit: null,
        miles: 0,
        lines: 0,
      };
      weeks.set(weekStart, point);
      return point;
    };
    for (const line of facts.revenue) {
      const point = pointFor(line.deliveredOn);
      point.gross = round(point.gross + revenueOf(line));
      point.linehaul = round(point.linehaul + line.linehaul);
      point.accessorials = round(point.accessorials + (line.accessorials ?? 0));
      point.tonu = round(point.tonu + (line.tonu ?? 0));
      point.miles = Math.round(point.miles + line.loadedMiles + line.emptyMiles);
      point.lines += 1;
    }
    for (const expense of facts.expenses) {
      const point = pointFor(expense.date);
      point.cost = round((point.cost ?? 0) + expense.amount);
    }
    return [...weeks.values()]
      .map(({ lines, ...point }) => ({
        ...point,
        // Profit only from both sides - never gross minus nothing, never a "loss" of pure cost.
        profit: point.cost === null || lines === 0 ? null : round(point.gross - point.cost),
      }))
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  }

  /** Where the money goes, ranked, as a total and as a rate, against the previous period. */
  async costDrivers(
    principal: Principal,
    preset: string,
    from?: string,
    to?: string,
  ): Promise<{
    range: DateRange;
    drivers: CostDriver[];
    notes: string[];
    totals: { costBeforeRecovery: number | null; recovered: number | null; net: number | null; recoveredUnapplied: number };
    recoveredByKind: CostMix['recoveredByKind'];
    byTrailer: Array<{ trailerId: string | null; unitNumber: string | null; amount: number; orders: number }>;
    /** Repairs and maintenance written to each truck (owner, 2026-10-25: "truck repair?"), most first. */
    byTruck: Array<{ truckId: string | null; unitNumber: string | null; amount: number; orders: number }>;
  }> {
    const { range, comparison } = this.resolve(principal, preset, from, to);
    const [current, prior] = await Promise.all([
      this.facts.facts(principal.companyId, range),
      this.facts.facts(principal.companyId, comparison),
    ]);
    const now = computeFinancials(current);
    const before = computeFinancials(prior);
    const mix = computeRevenueMix(current);
    const costs = computeCostMix(current);
    const priorByCategory = new Map(before.costBreakdown.map((c) => [c.category, c.amount]));
    const miles = mix.loadMiles !== null && mix.loadMiles > 0 ? mix.loadMiles : null;

    const drivers: CostDriver[] = now.costBreakdown
      .map((entry) => {
        const priorAmount = priorByCategory.get(entry.category);
        return {
          category: entry.category,
          amount: round(entry.amount),
          perMile: miles !== null ? round(entry.amount / miles) : null,
          shareOfRevenue: mix.gross > 0 ? round((entry.amount / mix.gross) * 100) : null,
          // No previous figure means no percentage; it does not mean a rise from zero.
          changePct:
            priorAmount === undefined || priorAmount === 0
              ? null
              : round(((entry.amount - priorAmount) / Math.abs(priorAmount)) * 100),
        };
      })
      .sort((a, b) => b.amount - a.amount);

    const trailers = new Map<string, { trailerId: string | null; unitNumber: string | null; amount: number; orders: number }>();
    for (const line of current.expenses) {
      if (line.category !== 'trailer_repairs') continue;
      const key = line.trailerId ?? 'none';
      const entry = trailers.get(key) ?? { trailerId: line.trailerId ?? null, unitNumber: line.trailerUnit ?? null, amount: 0, orders: 0 };
      entry.amount = round(entry.amount + line.amount);
      entry.orders += 1;
      entry.unitNumber ??= line.trailerUnit ?? null;
      trailers.set(key, entry);
    }

    // The same for trucks: repair and maintenance lines that name a truck (trailer work never does).
    const units = new Map(current.trucks.map((t) => [t.truckId, t.unitNumber]));
    const trucks = new Map<string, { truckId: string | null; unitNumber: string | null; amount: number; orders: number }>();
    for (const line of current.expenses) {
      if (line.category !== 'repairs' && line.category !== 'maintenance') continue;
      if (!line.truckId) continue;
      const entry = trucks.get(line.truckId) ?? { truckId: line.truckId, unitNumber: units.get(line.truckId) ?? null, amount: 0, orders: 0 };
      entry.amount = round(entry.amount + line.amount);
      entry.orders += 1;
      trucks.set(line.truckId, entry);
    }

    const notes = now.hasExpenseData ? [] : ['No expense data in this period.'];
    notes.push(...dataNotes(current, costs));
    return {
      range,
      drivers,
      notes,
      totals: { costBeforeRecovery: costs.costBeforeRecovery, recovered: costs.recovered, net: costs.net, recoveredUnapplied: costs.recoveredUnapplied },
      recoveredByKind: costs.recoveredByKind,
      byTrailer: [...trailers.values()].sort((a, b) => b.amount - a.amount),
      byTruck: [...trucks.values()].sort((a, b) => b.amount - a.amount),
    };
  }

  /** Where the rows of the accessorial split are read from; replaced in the tests. */
  accessorialSource: (companyId: string) => Promise<AccessorialRaw> = (companyId) =>
    readAccessorialRaw(this.database, companyId);

  /**
   * Accessorials - who gets what (owner, 2026-10-25): per type, what was billed, what the driver
   * is paid for it, what the dispatcher's claim pays and what the company keeps, with the loads
   * behind it. Same loads, amounts and Eastern days as the accessorials and TONU in gross.
   */
  async accessorials(
    principal: Principal,
    preset: string,
    from?: string,
    to?: string,
    paging: { page?: number; pageSize?: number } = {},
  ): Promise<AccessorialSplit & { source: 'database' }> {
    const { range } = this.resolve(principal, preset, from, to);
    const raw = await this.accessorialSource(principal.companyId);
    return { ...buildAccessorialSplit({ from: range.from, to: range.to }, raw, paging, TIMEZONE), source: 'database' };
  }

  /** Trucks ranked by profit, with the rates that explain the ranking. */
  /** The vendor trucks' money for the period (owner, 2026-10-28). */
  async vendors(principal: Principal, preset: string, from?: string, to?: string): Promise<VendorMoneySummary> {
    const { range } = this.resolve(principal, preset, from, to);
    const facts = await this.facts.facts(principal.companyId, range);
    return computeVendorMoney(facts, range);
  }

  async truckRanking(
    principal: Principal,
    preset: string,
    from?: string,
    to?: string,
    paging?: RankingQuery | null,
  ): Promise<RankingResponse> {
    const { range } = this.resolve(principal, preset, from, to);
    const facts = await this.facts.facts(principal.companyId, range);
    const rows = truckRows(facts);
    // Paged only on request, over every row; the unpaged response is unchanged.
    if (paging) return { range, ...pageRanking(rows, paging) };
    return { range, rows };
  }

  /** Drivers ranked the same way, from the revenue attributed to them. */
  async driverRanking(
    principal: Principal,
    preset: string,
    from?: string,
    to?: string,
    paging?: RankingQuery | null,
  ): Promise<RankingResponse> {
    const { range } = this.resolve(principal, preset, from, to);
    const facts = await this.facts.facts(principal.companyId, range);
    const nameFor = new Map(facts.drivers.map((d) => [d.driverId, d.name]));
    const byDriver = new Map<string, { gross: number; linehaul: number; miles: number }>();

    for (const line of facts.revenue) {
      if (!line.driverId) continue;
      const bucket = byDriver.get(line.driverId) ?? { gross: 0, linehaul: 0, miles: 0 };
      bucket.gross += revenueOf(line);
      bucket.linehaul += line.linehaul;
      bucket.miles += line.loadedMiles + line.emptyMiles;
      byDriver.set(line.driverId, bucket);
    }

    const rows: RankedEntity[] = [...byDriver.entries()]
      .map(([driverId, bucket]) => ({
        id: driverId,
        label: nameFor.get(driverId) ?? driverId,
        gross: round(bucket.gross),
        // Cost is not attributed to a driver by the facts, so it stays unknown rather than zero.
        cost: null,
        profit: null,
        miles: Math.round(bucket.miles),
        rpm: bucket.miles > 0 ? round(bucket.gross / bucket.miles) : null,
        linehaulRpm: bucket.miles > 0 ? round(bucket.linehaul / bucket.miles) : null,
        cpm: null,
        marginPct: null,
        oneSided: null,
        profitReason: 'Cost is not attributed to drivers.',
        // The driver's own profile (F24).
        href: `/drivers/${encodeURIComponent(driverId)}`,
      }))
      .sort((a, b) => b.gross - a.gross);

    if (paging) return { range, ...pageRanking(rows, paging) };
    return { range, rows };
  }

  /** Operations: what moved, how far, and how much of it was empty. */
  async operations(principal: Principal, preset: string, from?: string, to?: string) {
    const { range, comparison } = this.resolve(principal, preset, from, to);
    const [current, prior] = await Promise.all([
      this.facts.facts(principal.companyId, range),
      this.facts.facts(principal.companyId, comparison),
    ]);

    const summarise = (facts: ReportingFacts) => {
      const mix = computeRevenueMix(facts);
      const total = mix.loadedMiles + mix.emptyMiles;
      return { mix, total, emptyPct: total > 0 ? round((mix.emptyMiles / total) * 100) : null };
    };
    const now = summarise(current);
    const before = summarise(prior);
    const notes = [
      'Empty miles are the deadhead recorded on delivered loads. On-time and dwell are not in the reporting facts.',
    ];
    if (current.provenance && !current.provenance.generated && current.provenance.loadsOnFile === 0) {
      notes.unshift('This company has no loads in NeWay Loads, so loads and miles cannot be counted yet.');
    }

    return {
      range,
      comparison,
      source: this.sourceOf(current),
      /** Delivered loads; TONU lines are counted apart in `tonuLoads`. */
      loads: now.mix.loads,
      tonuLoads: now.mix.tonuLoads,
      loadedMiles: now.mix.loadedMiles,
      emptyMiles: now.mix.emptyMiles,
      totalMiles: Math.round(now.total),
      // Analytics redesign (2026-10-25): the same figures for the previous period, so each volume
      // card carries a change. `metrics` below is the data-integrity set, unchanged.
      volume: [
        compareMetricPeriods('loads', now.mix.loads, before.mix.loads),
        compareMetricPeriods('loadedMiles', now.mix.loadedMiles, before.mix.loadedMiles),
        compareMetricPeriods('emptyMiles', now.mix.emptyMiles, before.mix.emptyMiles),
      ],
      metrics: [
        compareMetricPeriods('miles', now.mix.loadMiles, before.mix.loadMiles),
        compareMetricPeriods('emptyPct', now.emptyPct, before.emptyPct),
        compareMetricPeriods('rpm', now.mix.rpm, before.mix.rpm),
        compareMetricPeriods('linehaulRpm', now.mix.linehaulRpm, before.mix.linehaulRpm),
      ],
      notes,
    };
  }

  /** Fuel: diesel spend and economy, DEF apart, and the trucks whose rates stand out. */
  async fuel(principal: Principal, preset: string, from?: string, to?: string) {
    const { range } = this.resolve(principal, preset, from, to);
    const facts = await this.facts.facts(principal.companyId, range);
    const mix = computeRevenueMix(facts);
    const result = computeFuelAnalytics(facts, mix.loadMiles);
    const notes: string[] = [];
    if (result.byTruck.length === 0) notes.push('No fuel transactions in this period.');
    else notes.push('Gallons, $/gal and fuel per mile are diesel only; DEF is shown separately. Fuel per mile divides by load miles.');
    const latest = facts.provenance?.fuelLatestAt ?? null;
    if (latest) notes.push(`Fuel card feed: newest transaction ${latest.slice(0, 16).replace('T', ' ')} UTC.`);
    else if (facts.provenance && !facts.provenance.generated) notes.push('Fuel cost not connected for this company: there is no fuel card feed.');
    return {
      range,
      source: this.sourceOf(facts),
      totals: result.totals,
      byTruck: result.byTruck,
      byState: result.byState,
      freshness: { latestAt: latest, rowsInPeriod: facts.fuel.length },
      notes,
    };
  }

  /**
   * Workforce, from the live records (owner, 2026-10-25):
   *  - **Drivers** is the working roster: drivers table, this company, not archived, in a working
   *    status (onboarding, suspended, terminated and inactive are not on it).
   *  - **Office & operations** is working employees with no driver record.
   *  - **Headcount** is the two together.
   *  - **Candidates in pipeline** is open hiring leads: not converted, not dead, not test data.
   */
  async workforce(principal: Principal) {
    const companyId = principal.companyId;
    const scope = eq(employees.companyId, companyId);
    const working = and(scope, sql`${employees.status} not in ('terminated','archived')`);
    const driverEmployeeIds = sql`(select ${drivers.employeeId} from ${drivers} where ${drivers.companyId} = ${companyId} and ${drivers.employeeId} is not null)`;

    const [
      byDepartment,
      byStatus,
      [staffRow],
      [employeeRow],
      driversByStatus,
      [ptoPending],
      [attendanceExceptions],
      [onboardingActive],
      [candidates],
    ] = await Promise.all([
      this.db
        .select({ department: employees.department, value: count() })
        .from(employees)
        .where(and(working, sql`${employees.id} not in ${driverEmployeeIds}`))
        .groupBy(employees.department),
      this.db
        .select({ status: employees.status, value: count() })
        .from(employees)
        .where(scope)
        .groupBy(employees.status),
      this.db
        .select({ value: count() })
        .from(employees)
        .where(and(working, sql`${employees.id} not in ${driverEmployeeIds}`)),
      this.db.select({ value: count() }).from(employees).where(working),
      this.db
        .select({ status: drivers.status, value: count() })
        .from(drivers)
        .where(and(eq(drivers.companyId, companyId), isNull(drivers.archivedAt)))
        .groupBy(drivers.status),
      this.db
        .select({ value: count() })
        .from(ptoRequests)
        .where(and(eq(ptoRequests.companyId, companyId), eq(ptoRequests.status, 'submitted'))),
      this.db
        .select({ value: count() })
        .from(attendanceEntries)
        .where(
          and(
            eq(attendanceEntries.companyId, companyId),
            sql`${attendanceEntries.exception} is not null and ${attendanceEntries.exceptionResolvedAt} is null`,
          ),
        ),
      this.db
        .select({ value: count() })
        .from(onboardingChecklists)
        .where(
          and(
            eq(onboardingChecklists.companyId, companyId),
            sql`${onboardingChecklists.status} in ('not_started','in_progress','blocked')`,
          ),
        ),
      this.db
        .select({ value: count() })
        .from(hiringLeads)
        .where(
          and(
            eq(hiringLeads.companyId, companyId),
            eq(hiringLeads.isTest, false),
            sql`${hiringLeads.status} not in ('converted','dead')`,
          ),
        ),
    ]);

    const active = new Set<string>(ACTIVE_ROSTER_DRIVER_STATUSES);
    const driverCount = driversByStatus.filter((r) => active.has(r.status)).reduce((s, r) => s + Number(r.value), 0);
    const onboardingDrivers = driversByStatus.filter((r) => r.status === 'onboarding').reduce((s, r) => s + Number(r.value), 0);
    const staff = Number(staffRow?.value ?? 0);
    return {
      source: 'database' as const,
      headcount: driverCount + staff,
      drivers: driverCount,
      staff,
      /** Working employee records (drivers with an employee record included). */
      employees: Number(employeeRow?.value ?? 0),
      driversOnboarding: onboardingDrivers,
      driversByStatus: driversByStatus.map((r) => ({ status: r.status, count: Number(r.value) })),
      byDepartment: byDepartment.map((r) => ({ department: r.department, count: r.value })),
      byStatus: byStatus.map((r) => ({ status: r.status, count: r.value })),
      ptoPending: ptoPending?.value ?? 0,
      attendanceExceptions: attendanceExceptions?.value ?? 0,
      onboardingActive: onboardingActive?.value ?? 0,
      candidatesInPipeline: candidates?.value ?? 0,
      candidatesBasis: 'open_leads' as const,
      notes: [
        'Drivers are the working roster (available, on a load, off duty, sleeper, vacation); onboarding drivers are counted apart. Candidates are open hiring leads, test data excluded.',
        'Turnover needs termination history over time, which is not on file yet.',
      ],
    };
  }

  /**
   * What deserves attention.
   *
   * Data gaps come first (F26): a period with no revenue source, no cost, a stale fuel feed or
   * one-sided trucks is never shown as "all clear". Then per-truck moves: a truck is only compared
   * when it ran enough miles in both periods for a rate to mean anything, and margin only where
   * profit is shown in both.
   */
  private insights(current: ReportingFacts, prior: ReportingFacts, now: Headline, range: DateRange): Insight[] {
    const gaps: Insight[] = [];
    const gap = (key: string, severity: Insight['severity'], title: string, action: string, metric: Insight['evidence']['metric'], value: number | null, href?: string) =>
      gaps.push({
        key,
        severity,
        title,
        action,
        entity: null,
        evidence: { metric, current: value, previous: null, change: null, changePct: null },
        ...(href ? { href } : {}),
      });
    const provenance = current.provenance;
    const live = provenance ? !provenance.generated : false;

    if (live && provenance!.loadsOnFile === 0) {
      gap('data_no_loads', 'critical', 'No loads in NeWay Loads: revenue is not connected', 'Revenue, RPM and profit stay empty until loads are recorded in NeWay Loads. Costs are shown as recorded.', 'gross', 0, '/loads');
    } else if (current.revenue.length === 0) {
      gap('data_no_revenue', 'warning', 'No loads delivered in this period', 'Profit is not shown without revenue. Check that delivered loads are marked delivered in NeWay Loads.', 'gross', 0, '/loads');
    }
    if (current.revenue.length > 0 && !now.financials.hasExpenseData) {
      gap('data_no_cost', 'warning', 'No cost recorded for this period', 'Profit is not shown without cost. Check that fuel, repairs and driver pay are recorded.', 'cost', null);
    }
    for (const row of now.costs.unmatchedRecoveries) {
      gap(
        `data_recovery_${row.kind}`,
        'warning',
        `${capitalise(row.kind === 'fleet_expense' ? 'fleet expense' : row.kind)} cost not connected for this company`,
        `$${row.recovered.toFixed(2)} was recovered from drivers for ${row.kind.replace('_', ' ')} but only $${row.cost.toFixed(2)} of that cost is recorded in the period, so $${(row.recovered - row.applied).toFixed(2)} is not taken off cost.`,
        'recovered',
        row.recovered,
      );
    }
    if (live && provenance!.fuelLatestAt) {
      const today = localDateOf(this.clock(), TIMEZONE);
      const latestDay = localDateOf(new Date(provenance!.fuelLatestAt), TIMEZONE);
      if (range.to >= addDays(today, -1) && latestDay < addDays(today, -2)) {
        gap('data_fuel_stale', 'warning', `Fuel card feed has nothing since ${latestDay}`, 'Check the Relay connection; fuel cost for the last days is missing.', 'cost', null);
      }
    }
    if (live && provenance!.unlinkedLedgerFuel !== 0) {
      gap('data_fuel_unlinked', 'warning', `$${provenance!.unlinkedLedgerFuel.toFixed(2)} of posted fuel is not linked to card transactions`, 'It may duplicate card fuel. Link the postings to their card transactions in Accounting.', 'cost', provenance!.unlinkedLedgerFuel);
    }

    const rows = truckRows(current);
    const costOnly = rows.filter((r) => r.oneSided === 'cost_only');
    const revenueOnly = rows.filter((r) => r.oneSided === 'revenue_only');
    if (current.revenue.length > 0 && costOnly.length > 0) {
      gap('data_trucks_cost_only', 'info', `${costOnly.length} truck(s) had costs but no delivered load`, 'Their cost counts in the company total; no truck profit is shown for them.', 'cost', round(costOnly.reduce((s, r) => s + (r.cost ?? 0), 0)));
    }
    if (revenueOnly.length > 0 && now.financials.hasExpenseData) {
      gap('data_trucks_revenue_only', 'info', `${revenueOnly.length} truck(s) delivered loads with no cost recorded`, 'No truck profit is shown for them until their fuel, repairs or pay are recorded.', 'gross', round(revenueOnly.reduce((s, r) => s + r.gross, 0)));
    }

    // ---- per-truck moves ------------------------------------------------------------
    const moves: Insight[] = [];
    const beforeRows = new Map(truckRows(prior).map((r) => [r.id, r]));
    let comparable = 0;
    for (const row of rows) {
      const before = beforeRows.get(row.id);
      if (!before) continue;
      if (
        row.miles === null ||
        before.miles === null ||
        row.miles < INSIGHT_THRESHOLDS.minimumMiles ||
        before.miles < INSIGHT_THRESHOLDS.minimumMiles
      ) {
        continue;
      }
      comparable += 1;
      const nowCpm = row.cpm;
      const beforeCpm = before.cpm;
      if (nowCpm !== null && beforeCpm !== null && beforeCpm > 0) {
        const changePct = round(((nowCpm - beforeCpm) / beforeCpm) * 100);
        if (changePct >= INSIGHT_THRESHOLDS.ratePct) {
          moves.push({
            key: `cpm_${row.id}`,
            severity: changePct >= 30 ? 'critical' : 'warning',
            title: `Unit ${row.label} cost per mile rose ${changePct.toFixed(1)}% to $${nowCpm.toFixed(2)}`,
            action: 'Open the truck and check its fuel and maintenance in this period.',
            entity: { type: 'truck', id: row.id, label: `Unit ${row.label}` },
            evidence: { metric: 'cpm', current: nowCpm, previous: beforeCpm, change: round(nowCpm - beforeCpm), changePct },
            href: row.href,
          });
        }
      }
      if (row.marginPct !== null && before.marginPct !== null) {
        const points = round(row.marginPct - before.marginPct);
        if (points <= -INSIGHT_THRESHOLDS.marginPoints) {
          moves.push({
            key: `margin_${row.id}`,
            severity: points <= -8 ? 'critical' : 'warning',
            title: `Unit ${row.label} margin fell ${Math.abs(points).toFixed(1)} points to ${row.marginPct.toFixed(1)}%`,
            action: 'Compare its loads and rates against the previous period.',
            entity: { type: 'truck', id: row.id, label: `Unit ${row.label}` },
            evidence: { metric: 'marginPct', current: row.marginPct, previous: before.marginPct, change: points, changePct: null },
            href: row.href,
          });
        }
      }
    }
    if (current.revenue.length > 0 && comparable === 0) {
      gap('data_no_comparable_trucks', 'info', 'No truck ran enough miles in both periods to compare', `Per-truck changes need ${INSIGHT_THRESHOLDS.minimumMiles.toLocaleString('en-US')} load miles in this period and the previous one.`, 'miles', null);
    }

    const rank = { critical: 0, warning: 1, info: 2 };
    moves.sort((a, b) => rank[a.severity] - rank[b.severity]);
    gaps.sort((a, b) => rank[a.severity] - rank[b.severity]);
    return [...gaps, ...moves].slice(0, 12);
  }
}

// ------------------------------------------------------------------------------------ helpers

interface Headline {
  financials: ReturnType<typeof computeFinancials>;
  mix: RevenueMix;
  costs: CostMix;
  basis: ProfitBasis;
  profit: number | null;
  marginPct: number | null;
  cpm: number | null;
  ppm: number | null;
}

/** The period's headline from the engines; profit only when both sides exist (decision 1). */
function headline(facts: ReportingFacts): Headline {
  const financials = computeFinancials(facts);
  const mix = computeRevenueMix(facts);
  const costs = computeCostMix(facts);
  const basis = profitBasis(facts);
  const miles = mix.loadMiles !== null && mix.loadMiles > 0 ? mix.loadMiles : null;
  const profit = basis.available ? financials.operatingProfit : null;
  return {
    financials,
    mix,
    costs,
    basis,
    profit,
    marginPct: basis.available ? financials.marginPct : null,
    cpm: costs.net !== null && miles !== null ? ratio(costs.net / miles) : null,
    ppm: profit !== null && miles !== null ? ratio(profit / miles) : null,
  };
}

/**
 * One row per fleet truck. Profit, margin and CPM-based comparisons need both sides (F19): a
 * truck with cost and no delivered load is `cost_only`, one with loads and no cost line is
 * `revenue_only`, and neither shows a profit.
 */
function truckRows(facts: ReportingFacts): RankedEntity[] {
  const costLines = new Map<string, number>();
  const linehaul = new Map<string, number>();
  const miles = new Map<string, number>();
  for (const line of facts.expenses) {
    if (line.truckId) costLines.set(line.truckId, (costLines.get(line.truckId) ?? 0) + 1);
  }
  for (const line of facts.revenue) {
    if (!line.truckId) continue;
    linehaul.set(line.truckId, (linehaul.get(line.truckId) ?? 0) + line.linehaul);
    miles.set(line.truckId, (miles.get(line.truckId) ?? 0) + line.loadedMiles + line.emptyMiles);
  }
  return computeTruckPnl(facts).map((row) => {
    const hasCost = (costLines.get(row.truckId) ?? 0) > 0;
    const hasRevenue = row.gross > 0 || row.loads > 0;
    const loadMiles = miles.has(row.truckId) ? Math.round(miles.get(row.truckId)!) : null;
    const usable = loadMiles !== null && loadMiles > 0 ? loadMiles : null;
    const cost = hasCost ? row.cost : null;
    const both = hasCost && hasRevenue && cost !== null;
    const profit = both ? round(row.gross - cost) : null;
    return {
      id: row.truckId,
      label: row.unitNumber,
      gross: row.gross,
      cost,
      profit,
      miles: loadMiles,
      rpm: usable === null ? null : round(row.gross / usable),
      linehaulRpm: usable === null ? null : round((linehaul.get(row.truckId) ?? 0) / usable),
      cpm: cost !== null && usable !== null ? round(cost / usable) : null,
      marginPct: profit !== null && row.gross > 0 ? round((profit / row.gross) * 100) : null,
      oneSided: hasCost && !hasRevenue ? 'cost_only' : !hasCost && hasRevenue ? 'revenue_only' : null,
      profitReason: both
        ? null
        : hasCost
          ? 'No delivered load for this truck in the period.'
          : hasRevenue
            ? 'No cost recorded for this truck in the period.'
            : 'No loads and no cost in the period.',
      href: `/fleet/trucks/${row.truckId}`,
    };
  });
}

function dataStatusOf(facts: ReportingFacts, basis: ProfitBasis): DataStatus {
  const p = facts.provenance;
  return {
    generated: p?.generated ?? false,
    revenue: {
      source: 'neway_loads',
      loadsOnFile: p?.loadsOnFile ?? 0,
      connected: (p?.loadsOnFile ?? 0) > 0 || (p?.generated ?? false),
      linesInPeriod: facts.revenue.length,
    },
    cost: { linesInPeriod: facts.expenses.length, bySource: { ...(p?.expenseLines ?? {}) } as Record<string, number> },
    fuel: { rowsInPeriod: facts.fuel.length, latestAt: p?.fuelLatestAt ?? null, unlinkedLedgerFuel: p?.unlinkedLedgerFuel ?? 0 },
    profit: basis,
  };
}

/** Notes every money section shares: what is missing or may be counted twice. */
function dataNotes(facts: ReportingFacts, costs: CostMix): string[] {
  const notes: string[] = [];
  const p = facts.provenance;
  if (p && !p.generated && p.loadsOnFile === 0) {
    notes.push('This company has no loads in NeWay Loads: revenue is not connected, so gross, RPM and profit are not available.');
  }
  for (const row of costs.unmatchedRecoveries) {
    const what = row.kind === 'fleet_expense' ? 'fleet expense' : row.kind;
    notes.push(
      `${capitalise(what)} cost not connected for this company: $${row.recovered.toFixed(2)} recovered from drivers for ${what}, but only $${row.cost.toFixed(2)} of that cost is recorded, so $${(row.recovered - row.applied).toFixed(2)} is not taken off cost.`,
    );
  }
  const estimated = round(facts.expenses.filter((l) => l.isEstimate).reduce((s, l) => s + l.amount, 0));
  if (estimated !== 0) {
    notes.push(`Cost includes $${estimated.toFixed(2)} of driver pay from statements not approved yet (an estimate until Accounting approves them).`);
  }
  if (p && p.unlinkedLedgerFuel !== 0) {
    notes.push(`$${p.unlinkedLedgerFuel.toFixed(2)} of fuel posted in Accounting is not linked to card transactions and may duplicate card fuel.`);
  }
  return notes;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function ratio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
