import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gte, lte, sql } from 'drizzle-orm';
import {
  reportByKey,
  type ReportCell,
  type ReportDefinition,
  type ReportResult,
  type ReportRow,
  type RunReportRequest,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import {
  attendanceEntries,
  applicants,
  onboardingChecklists,
  onboardingItems,
  ptoPolicies,
  ptoRequests,
} from '../../database/schema/hr';
import { employees } from '../../database/schema/people';
import { drivers } from '../../database/schema/roster';
import { computeFinancials, computeFuelAnalytics, computeTruckPnl, revenueOf } from '../reporting/engines';
import {
  REPORTING_DATA_SOURCE,
  type DateRange,
  type ReportingDataSource,
  type ReportingFacts,
} from '../reporting/facts';
import { ReportingPeriodService } from '../reporting/period/reporting-period.service';
import { CLOCK, type Clock } from '../dashboard/clock';

/**
 * The report runner.
 *
 * Every financial figure this produces comes from the reporting engines that already back the
 * dashboard — `computeFinancials`, `computeTruckPnl`, the fuel analytics. Nothing here re-derives
 * profit, RPM, CPM or margin, which is why a report and the dashboard cannot disagree about the
 * same period. Where a report has no engine behind it (the People reports) it aggregates in the
 * database, and says so in `source`.
 */
@Injectable()
export class ReportRunnerService {
  constructor(
    @Inject(REPORTING_DATA_SOURCE) private readonly facts: ReportingDataSource,
    private readonly periods: ReportingPeriodService,
    private readonly database: DatabaseService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private get db() {
    return this.database.db;
  }

  async run(principal: Principal, request: RunReportRequest): Promise<ReportResult> {
    const definition = reportByKey(request.reportKey);
    if (!definition) {
      throw new AppError({
        status: 404,
        title: 'Not Found',
        detail: `No report called ${request.reportKey}`,
      });
    }
    if (definition.unavailable) {
      // A report whose data does not exist is refused with the reason, never returned empty: an
      // empty table is indistinguishable from a genuinely quiet period.
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: definition.unavailable,
      });
    }
    if (!principal.permissions.has(definition.permission)) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: `You do not have ${definition.permission}`,
      });
    }

    const range = this.resolveRange(principal, request);
    const notes: string[] = [];

    const rows =
      definition.category === 'people'
        ? await this.runPeopleReport(principal, definition, range, request, notes)
        : await this.runFactsReport(principal, definition, range, request, notes);

    const sorted = this.sort(rows, request);
    const page = sorted.slice(
      (request.page - 1) * request.pageSize,
      request.page * request.pageSize,
    );

    return {
      reportKey: definition.key,
      name: definition.name,
      category: definition.category,
      range,
      grouping: request.grouping ?? definition.defaultGrouping,
      columns: definition.columns,
      rows: page,
      totals: this.totals(definition, sorted),
      total: sorted.length,
      page: request.page,
      pageSize: request.pageSize,
      generatedAt: new Date().toISOString(),
      source: definition.category === 'people' ? 'database' : this.facts.kind,
      notes,
    };
  }

  /** The period service owns every date decision, so a report and the dashboard agree on a week. */
  private resolveRange(
    principal: Principal,
    request: RunReportRequest,
  ): { from: string; to: string; label: string } {
    if (request.from && request.to) {
      return { from: request.from, to: request.to, label: `${request.from} – ${request.to}` };
    }
    // The period service owns preset resolution; the dashboard uses the same call, so a preset
    // means the same range in both places.
    const resolved = this.periods.resolve(
      { period: (request.preset ?? 'this_month') as never },
      { timezone: principal.companyTimezone, weekStart: principal.weekStart },
      this.clock(),
    );
    return { from: resolved.from, to: resolved.to, label: resolved.label };
  }

  // -------------------------------------------------------------------------- engine-backed

  private async runFactsReport(
    principal: Principal,
    definition: ReportDefinition,
    range: DateRange & { label: string },
    request: RunReportRequest,
    notes: string[],
  ): Promise<ReportRow[]> {
    const facts = await this.facts.facts(principal.companyId, {
      from: range.from,
      to: range.to,
    });

    switch (definition.key) {
      case 'profit_and_loss':
        return this.profitAndLoss(facts, notes);
      case 'cost_per_mile':
        return this.costPerMile(facts, notes);
      case 'revenue_by_week':
        return this.revenueByWeek(principal, facts);
      case 'truck_profitability':
        return this.truckProfitability(facts, request);
      case 'fleet_utilization':
        return this.fleetUtilisation(facts, notes);
      case 'fuel':
        return this.fuel(facts, request, notes);
      case 'maintenance_cost':
        return this.maintenanceCost(facts, request, notes);
      case 'driver_performance':
        return this.driverPerformance(facts, request);
      case 'miles':
        return this.miles(facts, request);
      case 'load_profitability':
        return this.loadProfitability(facts, request);
      case 'dispatch_performance':
        return this.dispatchPerformance(facts);
      default:
        throw new AppError({
          status: 501,
          title: 'Not Implemented',
          detail: `${definition.name} has no runner yet`,
        });
    }
  }

  private profitAndLoss(facts: ReportingFacts, notes: string[]): ReportRow[] {
    const financials = computeFinancials(facts);
    if (!financials.hasExpenseData) {
      notes.push(
        'No expense data in this period, so cost and profit are unavailable rather than zero.',
      );
    }
    const gross = financials.gross;
    const share = (amount: number) => (gross > 0 ? round((amount / gross) * 100) : null);
    const perMile = (amount: number) =>
      financials.totalMiles && financials.totalMiles > 0
        ? round(amount / financials.totalMiles)
        : null;

    const rows: ReportRow[] = [
      {
        id: 'gross',
        cells: {
          label: 'Gross revenue',
          amount: gross,
          share: gross > 0 ? 100 : null,
          perMile: perMile(gross),
        },
      },
    ];
    for (const entry of financials.costBreakdown) {
      rows.push({
        id: `cost_${entry.category}`,
        cells: {
          label: labelForCategory(entry.category),
          amount: -entry.amount,
          share: share(entry.amount) === null ? null : -(share(entry.amount) as number),
          perMile: perMile(entry.amount) === null ? null : -(perMile(entry.amount) as number),
        },
      });
    }
    rows.push({
      id: 'profit',
      cells: {
        label: 'Operating profit',
        amount: financials.operatingProfit,
        share: financials.marginPct,
        perMile: financials.ppm,
      },
    });
    return rows;
  }

  private costPerMile(facts: ReportingFacts, notes: string[]): ReportRow[] {
    const financials = computeFinancials(facts);
    if (financials.totalMiles === null) {
      notes.push('Miles are unknown for this period, so cost per mile cannot be computed.');
    }
    return financials.costBreakdown
      .map((entry) => ({
        id: entry.category,
        cells: {
          label: labelForCategory(entry.category),
          amount: entry.amount,
          perMile:
            financials.totalMiles && financials.totalMiles > 0
              ? round(entry.amount / financials.totalMiles)
              : null,
          share: financials.gross > 0 ? round((entry.amount / financials.gross) * 100) : null,
        } satisfies Record<string, ReportCell>,
      }))
      .sort((a, b) => Number(b.cells.amount) - Number(a.cells.amount));
  }

  private revenueByWeek(principal: Principal, facts: ReportingFacts): ReportRow[] {
    const weeks = new Map<string, { gross: number; miles: number }>();
    for (const line of facts.revenue) {
      const weekStart = this.periods.weekOf(line.deliveredOn, principal.weekStart).weekStart;
      const bucket = weeks.get(weekStart) ?? { gross: 0, miles: 0 };
      bucket.gross += revenueOf(line);
      bucket.miles += line.loadedMiles + line.emptyMiles;
      weeks.set(weekStart, bucket);
    }
    const costByWeek = new Map<string, number>();
    for (const expense of facts.expenses) {
      const weekStart = this.periods.weekOf(expense.date, principal.weekStart).weekStart;
      costByWeek.set(weekStart, (costByWeek.get(weekStart) ?? 0) + expense.amount);
    }

    return [...weeks.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([weekStart, bucket]) => {
        const cost = costByWeek.get(weekStart) ?? null;
        return {
          id: weekStart,
          cells: {
            label: weekStart,
            gross: round(bucket.gross),
            cost: cost === null ? null : round(cost),
            profit: cost === null ? null : round(bucket.gross - cost),
            miles: Math.round(bucket.miles),
            rpm: bucket.miles > 0 ? round(bucket.gross / bucket.miles) : null,
          } satisfies Record<string, ReportCell>,
        };
      });
  }

  private truckProfitability(facts: ReportingFacts, request: RunReportRequest): ReportRow[] {
    // The same engine the dashboard's truck P&L widget uses.
    return computeTruckPnl(facts)
      .filter((row) => !request.truckId || row.truckId === request.truckId)
      .filter((row) => !request.status || row.status === request.status)
      .map((row) => ({
        id: row.truckId,
        href: `/fleet/trucks/${row.truckId}`,
        cells: {
          label: row.unitNumber,
          status: row.status,
          miles: row.miles,
          gross: row.gross,
          cost: row.cost,
          profit: row.profit,
          rpm: row.rpm,
          // Derived from the engine's own cost and miles — the shared CPM definition applied to
          // the engine's figures, not a second calculation of cost.
          cpm: divide(row.cost, row.miles),
          marginPct:
            row.profit !== null && row.gross > 0 ? round((row.profit / row.gross) * 100) : null,
        } satisfies Record<string, ReportCell>,
      }));
  }

  private fleetUtilisation(facts: ReportingFacts, notes: string[]): ReportRow[] {
    const financials = computeFinancials(facts);
    notes.push('Active means a truck delivered at least one load in the period.');
    return [
      { id: 'active', cells: { label: 'Active trucks', value: financials.activeTrucks } },
      { id: 'inactive', cells: { label: 'Idle trucks', value: financials.inactiveTrucks } },
      {
        id: 'gross_per_truck',
        cells: { label: 'Revenue per active truck', value: financials.avgGrossPerTruck },
      },
      {
        id: 'miles_per_truck',
        cells: { label: 'Miles per active truck', value: financials.avgMilesPerTruck },
      },
    ];
  }

  private fuel(facts: ReportingFacts, request: RunReportRequest, notes: string[]): ReportRow[] {
    const financials = computeFinancials(facts);
    const result = computeFuelAnalytics(facts, financials.totalMiles);
    if (result.byTruck.length === 0) notes.push('No fuel transactions in this period.');
    notes.push(
      'MPG and fuel cost per mile are computed against miles from delivered loads, not odometer readings.',
    );

    const milesByTruck = new Map<string, number>();
    for (const line of facts.revenue) {
      if (!line.truckId) continue;
      milesByTruck.set(
        line.truckId,
        (milesByTruck.get(line.truckId) ?? 0) + line.loadedMiles + line.emptyMiles,
      );
    }

    return result.byTruck
      .filter((row) => !request.truckId || row.truckId === request.truckId)
      .map((row) => {
        const miles = row.truckId ? (milesByTruck.get(row.truckId) ?? 0) : 0;
        return {
          id: row.truckId ?? 'unassigned',
          href: row.truckId ? `/fleet/trucks/${row.truckId}` : undefined,
          cells: {
            label: row.unitNumber ?? 'Unassigned',
            gallons: round(row.gallons),
            amount: round(row.cost),
            pricePerGallon: row.gallons > 0 ? round(row.cost / row.gallons) : null,
            miles: Math.round(miles),
            // Null rather than zero when there are no miles to divide by.
            mpg: miles > 0 && row.gallons > 0 ? round(miles / row.gallons) : null,
            perMile: miles > 0 ? round(row.cost / miles) : null,
          } satisfies Record<string, ReportCell>,
        };
      });
  }

  private maintenanceCost(
    facts: ReportingFacts,
    request: RunReportRequest,
    notes: string[],
  ): ReportRow[] {
    notes.push('Cost only. Downtime, vendor and repair frequency are not in the reporting facts.');
    const byTruck = new Map<string, { cost: number; unit: string }>();
    const unitFor = new Map(facts.trucks.map((t) => [t.truckId, t.unitNumber]));
    for (const expense of facts.expenses) {
      if (expense.category !== 'maintenance' && expense.category !== 'repairs') continue;
      const key = expense.truckId ?? 'unassigned';
      const bucket = byTruck.get(key) ?? { cost: 0, unit: unitFor.get(key) ?? 'Unassigned' };
      bucket.cost += expense.amount;
      byTruck.set(key, bucket);
    }
    const milesByTruck = new Map<string, number>();
    for (const line of facts.revenue) {
      if (!line.truckId) continue;
      milesByTruck.set(
        line.truckId,
        (milesByTruck.get(line.truckId) ?? 0) + line.loadedMiles + line.emptyMiles,
      );
    }

    return [...byTruck.entries()]
      .filter(([truckId]) => !request.truckId || truckId === request.truckId)
      .map(([truckId, bucket]) => {
        const miles = milesByTruck.get(truckId) ?? 0;
        return {
          id: truckId,
          href: truckId === 'unassigned' ? undefined : `/fleet/trucks/${truckId}`,
          cells: {
            label: bucket.unit,
            amount: round(bucket.cost),
            miles: Math.round(miles),
            perMile: miles > 0 ? round(bucket.cost / miles) : null,
          } satisfies Record<string, ReportCell>,
        };
      })
      .sort((a, b) => Number(b.cells.amount) - Number(a.cells.amount));
  }

  private driverPerformance(facts: ReportingFacts, request: RunReportRequest): ReportRow[] {
    const nameFor = new Map(facts.drivers.map((d) => [d.driverId, d.name]));
    const byDriver = new Map<
      string,
      { loads: number; miles: number; empty: number; gross: number }
    >();
    for (const line of facts.revenue) {
      if (!line.driverId) continue;
      const bucket = byDriver.get(line.driverId) ?? { loads: 0, miles: 0, empty: 0, gross: 0 };
      bucket.loads += 1;
      bucket.miles += line.loadedMiles + line.emptyMiles;
      bucket.empty += line.emptyMiles;
      bucket.gross += revenueOf(line);
      byDriver.set(line.driverId, bucket);
    }

    return [...byDriver.entries()]
      .filter(([driverId]) => !request.driverId || driverId === request.driverId)
      .map(([driverId, bucket]) => ({
        id: driverId,
        cells: {
          label: nameFor.get(driverId) ?? driverId,
          loads: bucket.loads,
          miles: Math.round(bucket.miles),
          gross: round(bucket.gross),
          rpm: bucket.miles > 0 ? round(bucket.gross / bucket.miles) : null,
          emptyMiles: Math.round(bucket.empty),
          emptyPct: bucket.miles > 0 ? round((bucket.empty / bucket.miles) * 100) : null,
        } satisfies Record<string, ReportCell>,
      }));
  }

  private miles(facts: ReportingFacts, request: RunReportRequest): ReportRow[] {
    const grouping = request.grouping ?? 'week';
    const buckets = new Map<string, { loaded: number; empty: number }>();
    const unitFor = new Map(facts.trucks.map((t) => [t.truckId, t.unitNumber]));

    for (const line of facts.revenue) {
      if (request.truckId && line.truckId !== request.truckId) continue;
      const key =
        grouping === 'truck' ? (line.truckId ?? 'unassigned') : line.deliveredOn.slice(0, 7);
      const bucket = buckets.get(key) ?? { loaded: 0, empty: 0 };
      bucket.loaded += line.loadedMiles;
      bucket.empty += line.emptyMiles;
      buckets.set(key, bucket);
    }

    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, bucket]) => {
        const total = bucket.loaded + bucket.empty;
        return {
          id: key,
          cells: {
            label: grouping === 'truck' ? (unitFor.get(key) ?? key) : key,
            loadedMiles: Math.round(bucket.loaded),
            emptyMiles: Math.round(bucket.empty),
            miles: Math.round(total),
            emptyPct: total > 0 ? round((bucket.empty / total) * 100) : null,
          } satisfies Record<string, ReportCell>,
        };
      });
  }

  private loadProfitability(facts: ReportingFacts, request: RunReportRequest): ReportRow[] {
    const unitFor = new Map(facts.trucks.map((t) => [t.truckId, t.unitNumber]));
    const nameFor = new Map(facts.drivers.map((d) => [d.driverId, d.name]));
    return facts.revenue
      .filter((line) => !request.truckId || line.truckId === request.truckId)
      .filter((line) => !request.driverId || line.driverId === request.driverId)
      .map((line) => {
        const miles = line.loadedMiles + line.emptyMiles;
        return {
          id: line.loadId,
          href: `/loads/${line.loadNumber}`,
          cells: {
            label: line.loadNumber,
            truck: line.truckId ? (unitFor.get(line.truckId) ?? line.truckId) : null,
            driver: line.driverId ? (nameFor.get(line.driverId) ?? line.driverId) : null,
            deliveredOn: line.deliveredOn,
            loadedMiles: Math.round(line.loadedMiles),
            emptyMiles: Math.round(line.emptyMiles),
            gross: round(revenueOf(line)),
            rpm: miles > 0 ? round(revenueOf(line) / miles) : null,
          } satisfies Record<string, ReportCell>,
        };
      });
  }

  private dispatchPerformance(facts: ReportingFacts): ReportRow[] {
    const byTeam = new Map<
      string,
      {
        name: string;
        loads: number;
        gross: number;
        active: number;
        truckDays: number;
        activeDays: number;
      }
    >();
    for (const week of facts.dispatchWeeks) {
      const bucket = byTeam.get(week.teamId) ?? {
        name: week.teamName,
        loads: 0,
        gross: 0,
        active: 0,
        truckDays: 0,
        activeDays: 0,
      };
      bucket.loads += week.loads;
      bucket.gross += week.gross;
      bucket.active = Math.max(bucket.active, week.activeTrucks);
      bucket.truckDays += week.truckDays;
      bucket.activeDays += week.activeTruckDays;
      byTeam.set(week.teamId, bucket);
    }
    return [...byTeam.entries()].map(([teamId, bucket]) => ({
      id: teamId,
      cells: {
        label: bucket.name,
        loads: bucket.loads,
        gross: round(bucket.gross),
        activeTrucks: bucket.active,
        utilization:
          bucket.truckDays > 0 ? round((bucket.activeDays / bucket.truckDays) * 100) : null,
      } satisfies Record<string, ReportCell>,
    }));
  }

  // ------------------------------------------------------------------------ database-backed

  private async runPeopleReport(
    principal: Principal,
    definition: ReportDefinition,
    range: DateRange,
    request: RunReportRequest,
    notes: string[],
  ): Promise<ReportRow[]> {
    notes.push('Live workforce records, not a generated dataset.');
    const scope = eq(employees.companyId, principal.companyId);

    if (definition.key === 'headcount') {
      // Counted through a join. The `exists` subquery inside `count(*) filter` reads correctly but
      // returns zero once Drizzle interpolates the table reference.
      const rows = await this.db
        .select({
          department: employees.department,
          headcount: sql<number>`count(distinct ${employees.id})::int`,
          drivers: sql<number>`count(distinct ${drivers.id})::int`,
        })
        .from(employees)
        .leftJoin(drivers, eq(drivers.employeeId, employees.id))
        .where(
          request.department
            ? and(scope, eq(employees.department, request.department))
            : and(scope, sql`${employees.status} not in ('terminated','archived')`),
        )
        .groupBy(employees.department);
      return rows.map((row) => ({
        id: row.department,
        cells: {
          label: row.department,
          headcount: row.headcount,
          drivers: row.drivers,
          staff: row.headcount - row.drivers,
        },
      }));
    }

    if (definition.key === 'pto_report') {
      const parts = [eq(ptoRequests.companyId, principal.companyId)];
      if (range.from) parts.push(gte(ptoRequests.endsOn, range.from));
      if (range.to) parts.push(lte(ptoRequests.startsOn, range.to));
      if (request.status) parts.push(eq(ptoRequests.status, request.status));
      if (request.department) parts.push(eq(employees.department, request.department));
      const rows = await this.db
        .select({
          id: ptoRequests.id,
          first: employees.firstName,
          last: employees.lastName,
          policy: ptoPolicies.name,
          startsOn: ptoRequests.startsOn,
          endsOn: ptoRequests.endsOn,
          hours: ptoRequests.hours,
          status: ptoRequests.status,
        })
        .from(ptoRequests)
        .innerJoin(employees, eq(ptoRequests.employeeId, employees.id))
        .innerJoin(ptoPolicies, eq(ptoRequests.policyId, ptoPolicies.id))
        .where(and(...parts));
      return rows.map((row) => ({
        id: row.id,
        cells: {
          label: `${row.first} ${row.last}`,
          policy: row.policy,
          startsOn: row.startsOn,
          endsOn: row.endsOn,
          hours: Number(row.hours),
          status: row.status,
        },
      }));
    }

    if (definition.key === 'attendance_report') {
      const parts = [eq(attendanceEntries.companyId, principal.companyId)];
      if (range.from) parts.push(gte(attendanceEntries.entryDate, range.from));
      if (range.to) parts.push(lte(attendanceEntries.entryDate, range.to));
      if (request.department) parts.push(eq(employees.department, request.department));
      const rows = await this.db
        .select({
          employeeId: employees.id,
          first: employees.firstName,
          last: employees.lastName,
          days: count(),
          // Hours are computed the same way the attendance module computes them.
          hours: sql<string | null>`sum(
            case when ${attendanceEntries.checkOutAt} is null then null
            else extract(epoch from (${attendanceEntries.checkOutAt} - ${attendanceEntries.checkInAt})) / 3600
                 - ${attendanceEntries.breakMinutes} / 60.0 end
          )`,
          overtime: sql<string | null>`sum(
            case when ${attendanceEntries.checkOutAt} is null then null
            else greatest(extract(epoch from (${attendanceEntries.checkOutAt} - ${attendanceEntries.checkInAt})) / 3600
                 - ${attendanceEntries.breakMinutes} / 60.0 - 8, 0) end
          )`,
          exceptions: sql<number>`count(*) filter (where ${attendanceEntries.exception} is not null and ${attendanceEntries.exceptionResolvedAt} is null)::int`,
        })
        .from(attendanceEntries)
        .innerJoin(employees, eq(attendanceEntries.employeeId, employees.id))
        .where(and(...parts))
        .groupBy(employees.id, employees.firstName, employees.lastName);
      return rows.map((row) => ({
        id: row.employeeId,
        href: `/hr/employees/${row.employeeId}`,
        cells: {
          label: `${row.first} ${row.last}`,
          days: row.days,
          hours: row.hours === null ? null : round(Number(row.hours)),
          overtime: row.overtime === null ? null : round(Number(row.overtime)),
          exceptions: row.exceptions,
        },
      }));
    }

    if (definition.key === 'onboarding_report') {
      const rows = await this.db
        .select({
          id: onboardingChecklists.id,
          employeeId: onboardingChecklists.employeeId,
          first: employees.firstName,
          last: employees.lastName,
          status: onboardingChecklists.status,
          total: sql<number>`(select count(*)::int from ${onboardingItems} i where i.checklist_id = ${onboardingChecklists.id})`,
          completed: sql<number>`(select count(*)::int from ${onboardingItems} i where i.checklist_id = ${onboardingChecklists.id} and i.status = 'completed')`,
          overdue: sql<number>`(select count(*)::int from ${onboardingItems} i where i.checklist_id = ${onboardingChecklists.id} and i.due_date < current_date and i.status in ('pending','in_progress','blocked'))`,
        })
        .from(onboardingChecklists)
        .innerJoin(employees, eq(onboardingChecklists.employeeId, employees.id))
        .where(
          request.status
            ? and(
                eq(onboardingChecklists.companyId, principal.companyId),
                eq(onboardingChecklists.status, request.status),
              )
            : eq(onboardingChecklists.companyId, principal.companyId),
        );
      return rows.map((row) => ({
        id: row.id,
        href: `/hr/onboarding/${row.id}`,
        cells: {
          label: `${row.first} ${row.last}`,
          status: row.status,
          completed: row.completed,
          total: row.total,
          overdue: row.overdue,
        },
      }));
    }

    if (definition.key === 'recruiting_report') {
      const rows = await this.db
        .select({ stage: applicants.stage, value: count() })
        .from(applicants)
        .where(eq(applicants.companyId, principal.companyId))
        .groupBy(applicants.stage);
      return rows.map((row) => ({
        id: row.stage,
        cells: { label: row.stage.replace(/_/g, ' '), count: row.value },
      }));
    }

    throw new AppError({
      status: 501,
      title: 'Not Implemented',
      detail: `${definition.name} has no runner yet`,
    });
  }

  // -------------------------------------------------------------------------------- shaping

  private sort(rows: ReportRow[], request: RunReportRequest): ReportRow[] {
    if (!request.sort) return rows;
    const key = request.sort;
    const factor = request.sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = a.cells[key];
      const right = b.cells[key];
      // Nulls sort last regardless of direction: an unknown is not the smallest value.
      if (left === null || left === undefined) return 1;
      if (right === null || right === undefined) return -1;
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor;
      return String(left).localeCompare(String(right)) * factor;
    });
  }

  /**
   * The totals row.
   *
   * Sums are summed; rates are re-derived from the summed numerator and denominator. Averaging a
   * column of RPMs would weight a 200-mile load the same as a 2,000-mile one and produce a number
   * that matches nothing.
   */
  private totals(definition: ReportDefinition, rows: ReportRow[]): Record<string, ReportCell> {
    const totals: Record<string, ReportCell> = {};
    for (const column of definition.columns) {
      if (column.total !== 'sum') continue;
      let sum = 0;
      let sawValue = false;
      for (const row of rows) {
        const value = row.cells[column.key];
        if (typeof value === 'number') {
          sum += value;
          sawValue = true;
        }
      }
      totals[column.key] = sawValue ? round(sum) : null;
    }

    const gross = numberOr(totals.gross ?? totals.amount, null);
    const cost = numberOr(totals.cost, null);
    const miles = numberOr(totals.miles, null);
    const profit = numberOr(totals.profit, gross !== null && cost !== null ? gross - cost : null);

    for (const column of definition.columns) {
      if (column.total !== 'derived') continue;
      totals[column.key] =
        column.key === 'rpm'
          ? divide(gross, miles)
          : column.key === 'cpm'
            ? divide(cost, miles)
            : column.key === 'ppm'
              ? divide(profit, miles)
              : column.key === 'marginPct'
                ? gross && gross !== 0 && profit !== null
                  ? round((profit / gross) * 100)
                  : null
                : column.key === 'perMile'
                  ? divide(numberOr(totals.amount, null), miles)
                  : column.key === 'emptyPct'
                    ? divide(numberOr(totals.emptyMiles, null), miles, 100)
                    : null;
    }
    return totals;
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function numberOr(value: ReportCell | undefined, fallback: number | null): number | null {
  return typeof value === 'number' ? value : fallback;
}

function divide(numerator: number | null, denominator: number | null, scale = 1): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return round((numerator / denominator) * scale);
}

const CATEGORY_LABELS: Record<string, string> = {
  fuel: 'Fuel',
  driver_pay: 'Driver pay',
  maintenance: 'Maintenance',
  repairs: 'Repairs',
  insurance: 'Insurance',
  tolls: 'Tolls',
  dispatch_fee: 'Dispatch fee',
  factoring: 'Factoring',
  other: 'Other',
};

function labelForCategory(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}
