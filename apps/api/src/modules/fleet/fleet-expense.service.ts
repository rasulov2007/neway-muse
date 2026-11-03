import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { FLEET_EXPENSE_CATEGORY_LABEL, type FleetExpenseCategory, type FleetExpenseQuery, type FleetExpenseSummary } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import {
  fleetExpenses,
  trailers as trailerTable,
  workOrderLines,
  workOrders as workOrderTable,
} from '../../database/schema/fleet';
import { drivers, trucks } from '../../database/schema/roster';
import { addDays, addMonths, endOfMonth, localDateOf, startOfMonth, type IsoDate } from '../reporting/period/date-utils';
import { ReportingPeriodService } from '../reporting/period/reporting-period.service';
import { StateService } from '../state/state.service';
import {
  computeExpenseSummary,
  type EnginePeriod,
  type EngineTruck,
  type SourceFleetExpense,
  type SourceOdometerReading,
  type SourceServiceRecord,
  type SourceWorkOrder,
} from './expense-summary.engine';

/**
 * Where the Fleet expense summary gets its records.
 *
 * Work orders, service records and fuel fills live in the workspace snapshot the browser saves to
 * `app_state` — the same rows the Maintenance and Fuel pages show — so the summary and the pages
 * cannot disagree. The snapshot has no company column; a record is tied to this company only
 * through the truck it names, and the trucks table is company-scoped. A record on a unit that is
 * not on this company's roster is excluded and counted, never relabelled.
 *
 * The period resolves from the wall clock, not the pinned demo clock: this screen is about what
 * the company has spent up to today.
 */

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The workspace's own key for its operational snapshot (see apps/web/src/demo/state-persist.ts). */
export const WORKSPACE_SNAPSHOT_KEY = 'demo-data-v1';

const Money = z.number().finite().nullable().catch(null);
const Odometer = z.number().finite().nullable().catch(null);

const WorkOrderRow = z.object({
  id: z.string(),
  roNumber: z.string().catch(''),
  truckId: z.string(),
  status: z.string(),
  type: z.string().catch('other'),
  vendorName: z.string().nullable().catch(null),
  vendorId: z.string().nullable().catch(null),
  unitType: z.string().nullable().catch(null),
  trailerId: z.string().nullable().catch(null),
  openedAt: z.string().catch(''),
  completedAt: z.string().nullable().catch(null),
  odometer: Odometer,
  total: Money,
  invoices: z.array(z.object({ amount: Money, uploadedAt: z.string().catch('') })).catch([]),
  summary: z.string().catch(''),
  invoiceFileIds: z.array(z.string()).catch([]),
  /** Who the repair is charged to; absent on every order written before owner billing existed. */
  billing: z
    .object({ party: z.string().catch('company'), companyAmount: Money })
    .nullable()
    .catch(null),
});

const ServiceRecordRow = z.object({
  id: z.string(),
  truckId: z.string(),
  type: z.string().catch('other'),
  description: z.string().catch(''),
  doneAt: z.string().catch(''),
  odometer: Odometer,
  vendorName: z.string().nullable().catch(null),
  cost: Money,
  repairOrderId: z.string().nullable().catch(null),
});

const VendorRow = z.object({ id: z.string(), name: z.string() });

const FuelRow = z.object({
  truckId: z.string(),
  at: z.string(),
  odometer: Odometer,
});

/** Rows that fail the minimal shape are dropped; the count is what the summary cannot see. */
function rows<T extends z.ZodType>(schema: T, value: unknown): z.output<T>[] {
  if (!Array.isArray(value)) return [];
  const out: z.output<T>[] = [];
  for (const row of value) {
    const parsed = schema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

@Injectable()
export class FleetExpenseService {
  constructor(
    private readonly database: DatabaseService,
    private readonly state: StateService,
    private readonly periods: ReportingPeriodService,
  ) {}

  async summary(principal: Principal, query: FleetExpenseQuery): Promise<FleetExpenseSummary> {
    const now = new Date();
    const timezone = principal.companyTimezone;
    const today = this.periods.today(timezone, now);
    const period = query.window
      ? this.rolling(query.period, query.window, today, timezone)
      : this.resolve(query.period, today, principal.weekStart, timezone, query.at ?? query.week);

    const roster = await this.database.db
      .select({
        id: trucks.id,
        unitNumber: trucks.unitNumber,
        year: trucks.year,
        make: trucks.make,
        model: trucks.model,
        ownership: trucks.ownership,
        status: trucks.status,
        odometer: trucks.odometer,
        nextServiceOdometer: trucks.nextServiceOdometer,
        nextServiceDate: trucks.nextServiceDate,
      })
      .from(trucks)
      .where(eq(trucks.companyId, principal.companyId));
    const driverRows = await this.database.db
      .select({ unitId: trucks.id, first: drivers.firstName, last: drivers.lastName })
      .from(trucks)
      .innerJoin(drivers, eq(drivers.id, trucks.currentDriverId))
      .where(eq(trucks.companyId, principal.companyId));
    const driverNames = new Map(driverRows.map((r) => [r.unitId, `${r.first} ${r.last}`.trim()]));
    const engineTrucks: EngineTruck[] = roster.map((truck) => ({
      ...truck,
      kind: 'truck' as const,
      nextServiceDate: truck.nextServiceDate ? String(truck.nextServiceDate).slice(0, 10) : null,
      driverName: driverNames.get(truck.id) ?? null,
    }));

    const snapshot = await this.snapshot(principal.companyId);
    // Trailers are their own table (2026-09-25); they used to be read out of the workspace, which
    // is why an imported trailer's repairs were attributed to a unit this report could not see.
    const trailerRows = await this.database.db
      .select()
      .from(trailerTable)
      .where(eq(trailerTable.companyId, principal.companyId));
    const trailerUnits: EngineTruck[] = trailerRows.map((t) => ({
      id: t.id,
      kind: 'trailer' as const,
      unitNumber: t.unitNumber,
      year: t.year ?? 0,
      make: t.make ?? '',
      model: [t.type.replace(/_/g, ' '), t.lengthFt ? `${t.lengthFt} ft` : ''].join(' ').trim(),
      ownership: t.ownership,
      status: t.status,
      odometer: null,
      nextServiceOdometer: null,
      nextServiceDate: null,
    }));
    engineTrucks.push(...trailerUnits);

    const requested = (query.units ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    // An archived truck (owner, 2026-10-05) is not part of the fleet this report describes: it is
    // left out of the units, the counts and the spend unless it is asked for by id.
    for (let i = engineTrucks.length - 1; i >= 0; i -= 1) {
      const unit = engineTrucks[i];
      if (unit && unit.kind === 'truck' && unit.status === 'archived' && !requested.includes(unit.id)) {
        engineTrucks.splice(i, 1);
      }
    }

    const known = new Set(engineTrucks.map((truck) => truck.id));
    const selectedUnits = [...new Set(requested.filter((id) => known.has(id)))];
    const unknownUnits = [...new Set(requested.filter((id) => !known.has(id)))];

    const workOrders: SourceWorkOrder[] = rows(WorkOrderRow, snapshot?.data.repairOrders).map(
      (order) => ({
        ...order,
        workDone: order.summary || null,
        invoiceFileId: order.invoiceFileIds[0] ?? null,
        // The owner's share is what is left after the company's part of a split.
        ownerBilledAmount:
          order.billing?.party === 'owner' && typeof order.total === 'number'
            ? Math.max(order.total - (order.billing.companyAmount ?? 0), 0)
            : null,
      }),
    );
    /*
     * The server's own work orders (the Create work order form, PM completions, imports) count
     * too. A record migrated from the workspace keeps its origin in `migrated_from`, so it is
     * counted once, from the table; a voided completion is not spend. Cost fields are read here
     * as numbers because this report is already behind the cost permission.
     */
    const tableRows = await this.database.db
      .select()
      .from(workOrderTable)
      .where(
        and(eq(workOrderTable.companyId, principal.companyId), isNull(workOrderTable.voidedAt)),
      );
    const migrated = new Set(
      tableRows.map((r) => r.migratedFrom).filter((id): id is string => Boolean(id)),
    );
    /*
     * The server's own orders are kept apart until the workspace copies have been weighed
     * against them. Mixing the two lists first and then filtering the mixture against itself is
     * how every order the server holds once disappeared from this report.
     */
    const serverOrders: SourceWorkOrder[] = [];
    // The lines say what the money went on; the biggest one names the category of a repair.
    const lineRows =
      tableRows.length === 0
        ? []
        : await this.database.db
            .select({
              workOrderId: workOrderLines.workOrderId,
              systemCode: workOrderLines.systemCode,
              amount: workOrderLines.totalAmount,
            })
            .from(workOrderLines)
            .where(eq(workOrderLines.companyId, principal.companyId));
    const topSystem = new Map<string, { code: string; amount: number }>();
    for (const l of lineRows) {
      const amount = Number(l.amount ?? 0);
      const current = topSystem.get(l.workOrderId);
      if (!current || amount > current.amount)
        topSystem.set(l.workOrderId, { code: l.systemCode, amount });
    }
    for (const r of tableRows) {
      const money = r.invoiceTotal ?? r.total;
      serverOrders.push({
        id: r.id,
        roNumber: r.number,
        truckId: r.assetType === 'truck' ? r.unitId : '',
        status: r.status,
        type: expenseTypeFor(r.workType, topSystem.get(r.id)?.code ?? null),
        vendorName: r.vendorName || null,
        vendorId: r.vendorId ?? null,
        unitType: r.assetType,
        trailerId: r.assetType === 'trailer' ? r.unitId : null,
        openedAt: r.shopInAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
        odometer: r.odometer ?? null,
        total: money === null || money === undefined ? null : Number(money),
        invoices: (Array.isArray(r.invoiceFileIds) ? (r.invoiceFileIds as string[]) : []).map(
          () => ({ amount: null, uploadedAt: r.updatedAt.toISOString() }),
        ),
        workDone: r.workDone ?? r.title ?? null,
        invoiceFileId: (Array.isArray(r.invoiceFileIds) ? (r.invoiceFileIds as string[]) : [])[0] ?? null,
        ownerBilledAmount: null,
        payer: r.chargeParty === 'vendor' ? 'owner' : ((['driver', 'investigation', 'warranty'] as const).find((p) => p === r.chargeParty) ?? 'company'),
      });
    }
    /*
     * The same order from two places.
     *
     * `migrated_from` names the workspace record a table row came from, but it is only set when
     * the migration wrote it. Two other things identify the same order just as certainly: the
     * same id, and the same RO number - which Postgres already holds unique per company. The
     * table's copy is the authority, so the workspace copy is the one that goes.
     *
     * Only the workspace copies are weighed. The table's own rows were appended to this list
     * above and are the thing being matched against; filtering the whole list against itself
     * removes every order the server holds, which is how this once emptied the report.
     */
    const tableIds = new Set(serverOrders.map((o) => o.id));
    const tableNumbers = new Set(
      serverOrders.map((o) => o.roNumber?.trim().toUpperCase()).filter((n): n is string => Boolean(n)),
    );
    const workspaceOnly = workOrders.filter(
      (o) =>
        !migrated.has(o.id) &&
        !tableIds.has(o.id) &&
        !(o.roNumber && tableNumbers.has(o.roNumber.trim().toUpperCase())),
    );
    workOrders.length = 0;
    workOrders.push(...workspaceOnly, ...serverOrders);

    const serviceRecords: SourceServiceRecord[] = rows(
      ServiceRecordRow,
      snapshot?.data.serviceRecords,
    );
    const odometerReadings: SourceOdometerReading[] = rows(
      FuelRow,
      snapshot?.data.fuelTransactions,
    );
    const vendors = rows(VendorRow, snapshot?.data.vendors);

    // All fleet costs (owner, 2026-10-12): the hand-entered Fleet Expenses beside the repairs.
    // Repairs are never among them, so nothing is counted twice; Maintenance only leaves them out.
    const fleetExpenseRows =
      query.scope === 'all'
        ? await this.database.db
            .select()
            .from(fleetExpenses)
            .where(and(eq(fleetExpenses.companyId, principal.companyId), eq(fleetExpenses.status, 'recorded')))
        : [];
    const manualExpenses: SourceFleetExpense[] = fleetExpenseRows
      .filter((r) => r.amountCents > 0)
      .map((r) => ({
        id: r.id,
        reference: r.reference,
        truckId: r.truckId,
        type: r.category === 'repair_maintenance' ? 'other' : r.category,
        date: String(r.expenseDate),
        amount: r.amountCents / 100,
        vendorName: r.vendorName ?? r.placeName,
        description: [FLEET_EXPENSE_CATEGORY_LABEL[r.category as FleetExpenseCategory] ?? r.category, r.placeName, r.description].filter(Boolean).join(' · ') || null,
        // A driver's own cost (paid and borne by the driver) is the driver's; an owner's, the owner's.
        payer: r.chargeTo === 'investigation' ? 'investigation' : r.chargeTo === 'owner' ? 'owner' : r.chargeTo === 'driver' ? 'driver' : 'company',
        driverShare: r.chargeTo !== 'driver' ? 0 : r.paidBy === 'company' ? Math.min(r.chargeCents ?? 0, r.amountCents) / 100 : r.amountCents / 100,
      }));

    return computeExpenseSummary({
      trucks: engineTrucks,
      vendors,
      workOrders,
      serviceRecords,
      fleetExpenses: manualExpenses,
      odometerReadings,
      period,
      today,
      selectedUnits,
      unknownUnits,
      unitType: query.unitType,
      localDate: (iso) => localDay(iso, timezone),
      provenance: env.SEED_DEMO_DATA ? 'demo' : 'workspace',
      snapshotUpdatedAt: snapshot?.updatedAt ?? null,
      asOf: now.toISOString(),
    });
  }

  /** Week / month / quarter / year to date, in the company calendar. */
  /** The last 30 days, 90 days or 12 months to today (Eastern, from the server clock). */
  private rolling(preset: FleetExpenseQuery['period'], window: '7d' | '30d' | '90d' | '12m', today: IsoDate, timezone: string): EnginePeriod {
    const from: IsoDate = window === '7d' ? addDays(today, -6) : window === '30d' ? addDays(today, -29) : window === '90d' ? addDays(today, -89) : addDays(addMonths(today, -12), 1);
    const range = { from, to: today };
    const comparison = this.periods.comparisonFor(range);
    return {
      preset,
      from,
      to: today,
      label: window === '7d' ? 'Last 7 days' : window === '30d' ? 'Last 30 days' : window === '90d' ? 'Last 90 days' : 'Last 12 months',
      timezone,
      comparison: { ...comparison, label: this.periods.labelFor(comparison) },
    };
  }

  private resolve(
    preset: FleetExpenseQuery['period'],
    today: IsoDate,
    weekStart: number,
    timezone: string,
    at?: IsoDate,
  ): EnginePeriod {
    // The period that holds `at` (any day of it; owner, 2026-10-09). A past period shows whole; the
    // current one - or a future date, which falls back to it - runs to today.
    const bounds = (day: IsoDate): { from: IsoDate; end: IsoDate } => {
      switch (preset) {
        case 'week': {
          const start = this.periods.weekOf(day, weekStart).weekStart;
          return { from: start, end: addDays(start, 6) };
        }
        case 'month':
          return { from: startOfMonth(day), end: endOfMonth(day) };
        case 'quarter': {
          const month = Number(day.slice(5, 7));
          const first = `${day.slice(0, 4)}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
          return { from: first, end: endOfMonth(addMonths(first, 2)) };
        }
        case 'year':
          return { from: `${day.slice(0, 4)}-01-01`, end: `${day.slice(0, 4)}-12-31` };
      }
    };
    const current = bounds(today);
    const chosen = at ? bounds(at) : current;
    const past = chosen.from < current.from;
    const from: IsoDate = past ? chosen.from : current.from;
    const to: IsoDate = past ? chosen.end : today;
    const range = { from, to };
    const comparison = this.periods.comparisonFor(range);
    return {
      preset,
      from: range.from,
      to: range.to,
      label: this.periods.labelFor(range),
      timezone,
      comparison: { ...comparison, label: this.periods.labelFor(comparison) },
    };
  }

  private snapshot(companyId: string): Promise<{ data: Record<string, unknown>; updatedAt: string } | null> {
    // One row per collection since the round-3 P0 work; `workspace()` puts them back together and
    // falls back to the single blob on a server that has not split yet.
    return this.state.workspace(companyId);
  }
}

/**
 * The summary's category for a server work order (2026-09-21).
 *
 * The table records the six work types and, per line, the system the work was on; the summary
 * speaks the older, finer vocabulary. A tires job is tire replacement, a repair takes the category
 * of its largest line, and only what neither names is "Other" - which is what a tire replacement
 * used to read as.
 */
export function expenseTypeFor(workType: string, topSystem: string | null): string {
  switch (workType) {
    case 'tires':
      return 'tire_replacement';
    case 'oil_change':
      return 'oil_change';
    case 'annual_inspection':
      return 'dot_inspection';
    case 'pm_inspection':
      return 'pm_service';
    default:
      break;
  }
  switch (topSystem) {
    case 'tires_wheels':
      return 'tire_replacement';
    case 'brakes':
      return 'brake_repair';
    case 'engine':
      return 'engine';
    case 'electrical':
      return 'electrical';
    case 'cooling':
      return 'coolant';
    case 'suspension':
      return 'suspension';
    case 'aftertreatment':
      return 'dpf';
    case 'body_doors':
      return 'doors_seals';
    case 'pm':
      return 'pm_service';
    default:
      return 'other';
  }
}

/** Company-local day of an instant; a date-only value passes through; garbage is null. */
export function localDay(iso: string, timezone: string): IsoDate | null {
  if (ISO_DATE_ONLY.test(iso)) return iso;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return localDateOf(new Date(ms), timezone);
}

// Re-exported so the e2e test can build a range the same way the service does.
export { addDays };
