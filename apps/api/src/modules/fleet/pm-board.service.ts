import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, ne } from 'drizzle-orm';
import {
  PM_BUNDLE_WINDOW_DAYS,
  PM_ON_TIME_WINDOW_DAYS,
  completionOnTime,
  dateInZone,
  nextStepFor,
  odometerCheck,
  sortBoardRows,
  shopNameIsAddress,
  type CompletePmInput,
  type RenamePmShopInput,
  type CorrectPmInput,
  type PmAppointment,
  type PmBoard,
  type PmBoardRow,
  type PmNextStop,
  type PmShop,
  PM_WORK_ITEM_LABEL,
  defaultInvoiceNumber,
  type CreatePmShopInput,
  type PmStatus,
  type PmUnitDetail,
  type SchedulePmInput,
  type VoidPmCompletionInput,
  type WorkOrder,
  HOME_ZONE,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { auditLogs } from '../../database/schema/people';
import { ptiDefects } from '../../database/schema/pti';
import {
  unitMaintenanceSettings,
  vendors,
  workOrderActions,
  workOrderLines,
  workOrders,
} from '../../database/schema/fleet';
import { odometerReadings, pmPlans } from '../../database/schema/pm';
import { loads as loadsTable } from '../../database/schema/loads';
import { drivers, trucks } from '../../database/schema/roster';
import { AuditService } from '../people/audit.service';
import { PtiService } from './pti.service';
import { StolenUnitsService } from '../state/stolen-units.service';
import { PmService } from '../pm/pm.service';

/** The permission that lets somebody see what maintenance cost. */
const COST_PERMISSION = 'maintenance_costs.view';
const DAY_MS = 86_400_000;

type WoRow = typeof workOrders.$inferSelect;

interface WorkspaceStop {
  id: string;
  sequence: number;
  kind: 'pickup' | 'delivery';
  city: string;
  state: string;
  timezone: string;
  appointmentStartAt: string;
  status: string;
}
interface WorkspaceLoad {
  id: string;
  loadNumber: string;
  status: string;
  truckId: string | null;
  stops: WorkspaceStop[];
}

/** The invoice reading a completion writes, addressable from its work order. */
const readingIdFor = (workOrderId: string) => `odo_wo_${workOrderId}`;
/** "142,020" - a number as the screens print it, for an audit line a person reads. */
const fmt = (v: string | null) =>
  v === null || Number.isNaN(Number(v)) ? (v ?? 'none') : Number(v).toLocaleString('en-US');

const ACTIVE_LOAD = new Set([
  'assigned',
  'dispatched',
  'at_pickup',
  'loading',
  'loaded',
  'in_transit',
  'at_delivery',
  'unloading',
]);

/**
 * The Oil change / PM board and its two forms (docs/pm-module §6, §7; reference mockups A–C).
 *
 * The board is a read over `pm_status`, the work orders and the roster, joined here so the screen
 * shows numbers the server added up. The two writes are the appointment (a work order in
 * `scheduled`, which never touches the due status) and the completion - the one transaction that
 * resets the clock, in the order §6.2 gives: work order completed with its lines, a reading
 * written from the service odometer, `pm_status` recomputed, audit. Nothing else resets it.
 */
@Injectable()
export class PmBoardService {
  constructor(
    private readonly database: DatabaseService,
    private readonly pm: PmService,
    private readonly pti: PtiService,
    private readonly audit: AuditService,
    private readonly stolen: StolenUnitsService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private seesCost(principal: Principal): boolean {
    return hasPermission(principal, COST_PERMISSION);
  }

  // =============================================================================== the board

  async board(principal: Principal): Promise<PmBoard> {
    const companyId = principal.companyId;
    const now = this.pm.clock();
    const statuses = await this.pm.statuses(principal);
    const unitIds = statuses.map((s) => s.unitId);
    if (unitIds.length === 0) {
      return { rows: [], summary: this.summarise([], [], now, principal) };
    }

    const [fleet, open, lastServices, alsoDue, nextStops, stolenUnits] = await Promise.all([
      this.db
        .select({
          id: trucks.id,
          currentDriverId: trucks.currentDriverId,
          location: trucks.location,
        })
        .from(trucks)
        .where(and(eq(trucks.companyId, companyId), inArray(trucks.id, unitIds))),
      this.openAppointments(companyId, unitIds),
      this.lastServiceRows(companyId, statuses),
      this.alsoDueByUnit(companyId, unitIds, now),
      this.nextStopsByUnit(unitIds),
      // A stolen truck's position reaches the administrator role only (owner decision).
      this.stolen.hiddenUnits(principal),
    ]);
    const driverIds = fleet.map((t) => t.currentDriverId).filter((id): id is string => Boolean(id));
    const driverRows = driverIds.length
      ? await this.db
          .select({ id: drivers.id, firstName: drivers.firstName, lastName: drivers.lastName })
          .from(drivers)
          .where(inArray(drivers.id, driverIds))
      : [];
    const driverName = new Map(
      driverRows.map((d) => [d.id, `${d.firstName} ${d.lastName}`.trim()]),
    );
    const truckById = new Map(fleet.map((t) => [t.id, t]));

    const rows: PmBoardRow[] = statuses.map((status) => {
      const truck = truckById.get(status.unitId);
      const appointment = open.get(status.unitId) ?? null;
      const last = lastServices.get(status.unitId) ?? null;
      const location = stolenUnits.has(status.unitId) ? null : this.locationOf(truck?.location);
      const stops = nextStops.get(status.unitId) ?? [];
      const pctOver =
        status.dueStatus === 'overdue' && status.intervalMiles && status.milesRemaining !== null
          ? Math.round((-status.milesRemaining / status.intervalMiles) * 1000) / 10
          : null;
      return {
        ...status,
        driverName: truck?.currentDriverId ? (driverName.get(truck.currentDriverId) ?? null) : null,
        location,
        nextStop: stops[0] ?? null,
        route: stops.slice(0, 3),
        appointment: appointment ? this.toAppointment(appointment, principal) : null,
        lastService:
          status.lastServiceAt && status.lastServiceOdometer !== null
            ? {
                workOrderId: status.lastServiceId,
                at: status.lastServiceAt,
                odometer: status.lastServiceOdometer,
                vendorName: last?.vendorName || null,
                cost: this.seesCost(principal)
                  ? last?.invoiceTotal !== null && last?.invoiceTotal !== undefined
                    ? Number(last.invoiceTotal)
                    : null
                  : undefined,
                invoiceNumber: last?.invoiceNumber ?? null,
                source: status.lastServiceSource ?? 'baseline',
              }
            : null,
        alsoDue: alsoDue.get(status.unitId) ?? [],
        nextStep: nextStepFor({
          dueStatus: status.dueStatus,
          pmResponsibility: status.pmResponsibility,
          appointment: appointment
            ? {
                scheduledFor: (appointment.scheduledFor ?? appointment.shopInAt).toISOString(),
                inShop: appointment.status === 'in_shop',
              }
            : null,
          now: now.toISOString(),
        }),
        pctOver,
      };
    });

    const sorted = sortBoardRows(rows);
    const completions = await this.completionsSince(
      companyId,
      new Date(now.getTime() - PM_ON_TIME_WINDOW_DAYS * DAY_MS),
    );
    return { rows: sorted, summary: this.summarise(sorted, completions, now, principal) };
  }

  private summarise(
    rows: PmBoardRow[],
    completions: {
      unitId: string;
      serviceOdometer: number | null;
      previousOdometer: number | null;
      intervalMiles: number | null;
      invoiceTotal: number | null;
      ownYard: boolean;
    }[],
    now: Date,
    principal: Principal,
  ): PmBoard['summary'] {
    const overdueRows = rows.filter(
      (r) => r.dueStatus === 'overdue' || r.dueStatus === 'overdue_at_least',
    );
    const milesOver = (r: PmBoardRow) =>
      r.dueStatus === 'overdue' ? -(r.milesRemaining ?? 0) : (r.milesOverAtReading ?? 0);
    // The company's day, not UTC's: a PM booked for tonight is still today at 9pm Eastern.
    const dayIn = (at: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: HOME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
    const today = dayIn(now);
    const weekEnd = dayIn(new Date(now.getTime() + 7 * DAY_MS));
    const booked = rows.filter((r) => r.appointment);
    const noReading = rows.filter((r) => r.dueStatus === 'no_reading');
    const lease = rows.filter(
      (r) =>
        r.pmResponsibility === 'lessor' &&
        (r.dueStatus === 'overdue' ||
          r.dueStatus === 'overdue_at_least' ||
          r.dueStatus === 'due_soon'),
    );
    const withOnTime = completions.filter(
      (c) => c.previousOdometer !== null && c.serviceOdometer !== null && c.intervalMiles !== null,
    );
    const onTime = withOnTime.filter(
      (c) =>
        completionOnTime({
          previousOdometer: c.previousOdometer,
          serviceOdometer: c.serviceOdometer as number,
          intervalMiles: c.intervalMiles,
        }) === true,
    ).length;
    const costed = completions.filter((c) => c.invoiceTotal !== null && c.invoiceTotal > 0);
    const yard = costed.filter((c) => c.ownYard);
    const avg = (list: { invoiceTotal: number | null }[]) =>
      list.length
        ? Math.round(
            (list.reduce((sum, c) => sum + (c.invoiceTotal ?? 0), 0) / list.length) * 100,
          ) / 100
        : null;
    return {
      total: rows.length,
      overdue: overdueRows.length,
      overdueWorstMiles: overdueRows.length ? Math.max(...overdueRows.map(milesOver)) : null,
      overdueTotalMiles: overdueRows.reduce((sum, r) => sum + milesOver(r), 0),
      dueSoon: rows.filter((r) => r.dueStatus === 'due_soon').length,
      dueSoonThisWeek: rows.filter(
        (r) =>
          r.dueStatus === 'due_soon' &&
          r.estimatedDueDate !== null &&
          r.estimatedDueDate <= weekEnd,
      ).length,
      booked: booked.length,
      bookedToday: booked.filter(
        (r) => (r.appointment as PmAppointment).scheduledFor.slice(0, 10) === today,
      ).length,
      bookedAtOwnYard: booked.filter((r) =>
        /own yard|naperville/i.test((r.appointment as PmAppointment).vendorName),
      ).length,
      bookedOverdue: booked.filter(
        (r) => r.dueStatus === 'overdue' || r.dueStatus === 'overdue_at_least',
      ).length,
      noReading: noReading.length,
      noReadingStale: noReading.filter((r) => r.readingAt !== null).length,
      noReadingNever: noReading.filter((r) => r.readingAt === null).length,
      leaseDue: lease.length,
      leaseNames: [
        ...new Set(lease.map((r) => r.lessorName).filter((n): n is string => Boolean(n))),
      ],
      onTime: { done: withOnTime.length, onTime },
      avgCost: this.seesCost(principal) ? avg(costed) : undefined,
      ownYardAvgCost: this.seesCost(principal) ? avg(yard) : undefined,
      computedAt: now.toISOString(),
    };
  }

  // ------------------------------------------------------------------------------- pieces

  /** The open appointment per unit: a scheduled or in-shop work order for the service. */
  private async openAppointments(
    companyId: string,
    unitIds: string[],
  ): Promise<Map<string, WoRow>> {
    const rows = await this.db
      .select()
      .from(workOrders)
      .where(
        and(
          eq(workOrders.companyId, companyId),
          inArray(workOrders.unitId, unitIds),
          eq(workOrders.pmServiceCode, 'OIL_CHANGE'),
          inArray(workOrders.status, ['scheduled', 'in_shop']),
        ),
      )
      .orderBy(desc(workOrders.scheduledFor));
    const map = new Map<string, WoRow>();
    for (const row of rows) if (!map.has(row.unitId)) map.set(row.unitId, row);
    return map;
  }

  private async lastServiceRows(
    companyId: string,
    statuses: PmStatus[],
  ): Promise<Map<string, WoRow>> {
    const ids = statuses.map((s) => s.lastServiceId).filter((id): id is string => Boolean(id));
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(workOrders)
      .where(and(eq(workOrders.companyId, companyId), inArray(workOrders.id, ids)));
    return new Map(rows.map((r) => [r.unitId, r]));
  }

  /** Work a visit could cover (§6.1): the annual inspection within 30 days, open walk-around defects. */
  private async alsoDueByUnit(
    companyId: string,
    unitIds: string[],
    now: Date,
  ): Promise<Map<string, PmBoardRow['alsoDue']>> {
    const map = new Map<string, PmBoardRow['alsoDue']>();
    const push = (unitId: string, item: PmBoardRow['alsoDue'][number]) =>
      map.set(unitId, [...(map.get(unitId) ?? []), item]);
    const settings = await this.db
      .select({
        unitId: unitMaintenanceSettings.unitId,
        lastAnnual: unitMaintenanceSettings.lastAnnualInspectionAt,
        months: unitMaintenanceSettings.annualInspectionMonths,
      })
      .from(unitMaintenanceSettings)
      .where(
        and(
          eq(unitMaintenanceSettings.companyId, companyId),
          eq(unitMaintenanceSettings.assetType, 'truck'),
          inArray(unitMaintenanceSettings.unitId, unitIds),
        ),
      );
    for (const s of settings) {
      if (!s.lastAnnual) continue;
      const due = new Date(s.lastAnnual);
      due.setUTCMonth(due.getUTCMonth() + (s.months ?? 12));
      const days = Math.ceil((due.getTime() - now.getTime()) / DAY_MS);
      if (days <= PM_BUNDLE_WINDOW_DAYS) {
        push(s.unitId, {
          key: 'annual_inspection',
          label: 'Annual DOT inspection',
          detail:
            days < 0
              ? `overdue by ${-days} days · saves a second trip`
              : `due ${due.toISOString().slice(0, 10)} · ${days} days · saves a second trip`,
        });
      }
    }
    const defects = await this.db
      .select({
        id: ptiDefects.id,
        unitId: ptiDefects.unitId,
        number: ptiDefects.defectNumber,
        component: ptiDefects.componentName,
        description: ptiDefects.description,
        state: ptiDefects.state,
        dueAt: ptiDefects.dueAt,
      })
      .from(ptiDefects)
      .where(
        and(
          eq(ptiDefects.companyId, companyId),
          inArray(ptiDefects.unitId, unitIds),
          inArray(ptiDefects.state, ['open', 'assigned', 'scheduled']),
        ),
      );
    for (const d of defects) {
      push(d.unitId, {
        key: d.id,
        label: `${d.number} · ${d.component || 'defect'}`,
        detail: `${d.description.slice(0, 60)}${d.dueAt ? ` · fix by ${d.dueAt.toISOString().slice(0, 10)}` : ''}`,
      });
    }
    return map;
  }

  /** Where the truck is going next, from Dispatch's own loads. */
  private async nextStopsByUnit(unitIds: string[]): Promise<Map<string, PmNextStop[]>> {
    const map = new Map<string, PmNextStop[]>();
    const rows = await this.database.db
      .select({ record: loadsTable.record })
      .from(loadsTable)
      .where(eq(loadsTable.isDemo, false));
    const loads = rows.map((r) => r.record as WorkspaceLoad);
    const wanted = new Set(unitIds);
    for (const load of loads) {
      if (!load || !load.truckId || !wanted.has(load.truckId) || !ACTIVE_LOAD.has(load.status))
        continue;
      const stops = [...(load.stops ?? [])]
        .filter((s) => s && s.status !== 'completed' && s.status !== 'cancelled')
        .sort((a, b) => a.sequence - b.sequence)
        .map((s): PmNextStop => ({
          kind: s.kind,
          city: s.city,
          state: s.state,
          at: s.appointmentStartAt,
          timezone: s.timezone || '',
          loadNumber: load.loadNumber,
        }));
      map.set(
        load.truckId,
        [...(map.get(load.truckId) ?? []), ...stops].sort(
          (a, b) => Date.parse(a.at) - Date.parse(b.at),
        ),
      );
    }
    return map;
  }

  private locationOf(raw: unknown): PmBoardRow['location'] {
    if (!raw || typeof raw !== 'object') return null;
    const loc = raw as { city?: unknown; state?: unknown; updatedAt?: unknown };
    if (typeof loc.city !== 'string' || typeof loc.state !== 'string') return null;
    return {
      city: loc.city,
      state: loc.state,
      updatedAt: typeof loc.updatedAt === 'string' ? loc.updatedAt : '',
    };
  }

  private toAppointment(row: WoRow, principal: Principal): PmAppointment {
    return {
      workOrderId: row.id,
      workOrderNumber: row.number,
      scheduledFor: (row.scheduledFor ?? row.shopInAt).toISOString(),
      vendorId: row.vendorId,
      vendorName: row.vendorName,
      responsibleUserId: row.responsibleUserId ?? null,
      responsibleName: row.responsibleName ?? null,
      estimatedCost: this.seesCost(principal)
        ? row.estimatedCost === null
          ? null
          : Number(row.estimatedCost)
        : undefined,
      noteForShop: row.noteForShop ?? null,
      holdMinutes: row.holdMinutes ?? 0,
      inShop: row.status === 'in_shop',
    };
  }

  /** Completions in a window, each with the previous one's odometer, for the on-time rate. */
  private async completionsSince(companyId: string, since: Date) {
    const rows = await this.db
      .select({
        id: workOrders.id,
        unitId: workOrders.unitId,
        serviceAt: workOrders.serviceAt,
        serviceOdometer: workOrders.serviceOdometer,
        invoiceTotal: workOrders.invoiceTotal,
        vendorId: workOrders.vendorId,
      })
      .from(workOrders)
      .where(
        and(
          eq(workOrders.companyId, companyId),
          eq(workOrders.status, 'completed'),
          eq(workOrders.pmServiceCode, 'OIL_CHANGE'),
          isNull(workOrders.voidedAt),
        ),
      )
      .orderBy(workOrders.unitId, workOrders.serviceAt);
    const plans = await this.db
      .select()
      .from(pmPlans)
      .where(
        and(
          eq(pmPlans.companyId, companyId),
          eq(pmPlans.serviceCode, 'OIL_CHANGE'),
          isNull(pmPlans.voidedAt),
        ),
      );
    const unitInterval = new Map(
      plans
        .filter((p) => p.scope === 'unit' && p.unitId)
        .map((p) => [p.unitId as string, p.intervalMiles]),
    );
    const vendorIds = [
      ...new Set(rows.map((r) => r.vendorId).filter((v): v is string => Boolean(v))),
    ];
    const yardRows = vendorIds.length
      ? await this.db
          .select({ id: vendors.id, isOwnYard: vendors.isOwnYard })
          .from(vendors)
          .where(inArray(vendors.id, vendorIds))
      : [];
    const ownYard = new Set(yardRows.filter((v) => v.isOwnYard).map((v) => v.id));
    const previous = new Map<string, number | null>();
    const out: {
      unitId: string;
      serviceOdometer: number | null;
      previousOdometer: number | null;
      intervalMiles: number | null;
      invoiceTotal: number | null;
      ownYard: boolean;
    }[] = [];
    for (const row of rows) {
      const prev = previous.get(row.unitId) ?? null;
      if (row.serviceAt && row.serviceAt.getTime() >= since.getTime()) {
        out.push({
          unitId: row.unitId,
          serviceOdometer: row.serviceOdometer,
          previousOdometer: prev,
          intervalMiles: unitInterval.get(row.unitId) ?? this.pm.settings.fleetIntervalMiles,
          invoiceTotal: row.invoiceTotal === null ? null : Number(row.invoiceTotal),
          ownYard: row.vendorId ? ownYard.has(row.vendorId) : false,
        });
      }
      if (row.serviceOdometer !== null) previous.set(row.unitId, row.serviceOdometer);
    }
    return out;
  }

  // =============================================================================== the row, opened

  async unitDetail(principal: Principal, unitId: string): Promise<PmUnitDetail> {
    const companyId = principal.companyId;
    const status = await this.pm.status(principal, unitId);
    const rows = await this.db
      .select()
      .from(workOrders)
      .where(
        and(
          eq(workOrders.companyId, companyId),
          eq(workOrders.unitId, unitId),
          eq(workOrders.status, 'completed'),
          eq(workOrders.pmServiceCode, 'OIL_CHANGE'),
          isNull(workOrders.voidedAt),
        ),
      )
      .orderBy(desc(workOrders.serviceAt));
    const services: PmUnitDetail['services'] = rows.slice(0, 4).map((row, i) => {
      const older = rows[i + 1];
      const milesRun =
        row.serviceOdometer !== null &&
        older?.serviceOdometer !== null &&
        older?.serviceOdometer !== undefined
          ? row.serviceOdometer - older.serviceOdometer
          : null;
      return {
        workOrderId: row.id,
        number: row.number,
        at: (row.serviceAt ?? row.completedAt ?? row.shopInAt).toISOString(),
        odometer: row.serviceOdometer,
        milesRun,
        vendorName: row.vendorName,
        cost: this.seesCost(principal)
          ? row.invoiceTotal === null
            ? null
            : Number(row.invoiceTotal)
          : undefined,
        invoiceNumber: row.invoiceNumber,
        invoiceFileIds: Array.isArray(row.invoiceFileIds) ? (row.invoiceFileIds as string[]) : [],
        source: row.enteredVia === 'import' ? 'import' : 'completion',
        historic: row.historic,
      };
    });
    const runs = rows
      .map((row, i) =>
        row.serviceOdometer !== null &&
        rows[i + 1]?.serviceOdometer !== null &&
        rows[i + 1]?.serviceOdometer !== undefined
          ? row.serviceOdometer - (rows[i + 1]?.serviceOdometer as number)
          : null,
      )
      .filter((n): n is number => n !== null && n > 0);
    const averageMilesBetween = runs.length
      ? Math.round(runs.reduce((a, b) => a + b, 0) / runs.length)
      : null;

    // The interval and who set it (§6.5), with the group default beside it.
    const plans = await this.pm.plans(principal, { unitId });
    const active = plans.find(
      (p) => !p.voidedAt && (p.scope === 'unit' ? p.unitId === unitId : true),
    );
    const groupPlan = plans.find((p) => !p.voidedAt && p.scope === 'group');
    const groupCount = status.groupName
      ? (
          await this.db
            .select({ id: trucks.id })
            .from(trucks)
            .where(and(eq(trucks.companyId, companyId), eq(trucks.groupName, status.groupName)))
        ).length
      : 0;
    const plan: PmUnitDetail['plan'] =
      status.intervalMiles !== null
        ? {
            intervalMiles: status.intervalMiles,
            intervalDays: status.intervalDays,
            intervalHours: status.intervalHours,
            origin: status.planOrigin ?? 'fleet',
            setByName: active?.setByName ?? null,
            setAt: active?.setAt ?? null,
            reason: active?.reason ?? null,
            groupName: status.groupName,
            groupIntervalMiles:
              groupPlan?.intervalMiles ??
              (status.groupName
                ? (this.pm.settings.groupIntervalMiles[status.groupName] ?? null)
                : null),
            groupUnitCount: groupCount,
          }
        : null;

    const readingRows = await this.db
      .select()
      .from(odometerReadings)
      .where(
        and(
          eq(odometerReadings.companyId, companyId),
          eq(odometerReadings.unitId, unitId),
          ne(odometerReadings.status, 'void'),
        ),
      )
      .orderBy(desc(odometerReadings.readingAt))
      .limit(5);
    const readings: PmUnitDetail['readings'] = readingRows.map((r, i) => {
      const older = readingRows[i + 1];
      return {
        id: r.id,
        readingAt: r.readingAt.toISOString(),
        odometerMiles: r.odometerMiles,
        source: r.source,
        status: r.status,
        ageUnknown: r.ageUnknown,
        usedForRow: r.id === status.readingId,
        deltaMiles: older ? r.odometerMiles - older.odometerMiles : null,
      };
    });

    const audit = await this.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, companyId),
          eq(auditLogs.entityType, 'pm_completion'),
          inArray(auditLogs.action, ['correct', 'void']),
        ),
      )
      .orderBy(desc(auditLogs.at))
      .limit(50);
    const woIds = new Set(rows.map((r) => r.id));
    const corrections: PmUnitDetail['corrections'] = audit
      .filter((a) => woIds.has(a.entityId) || a.entityLabel.includes(status.unitNumber))
      .slice(0, 10)
      .map((a) => ({
        id: a.id,
        at: a.at.toISOString(),
        byName: a.actorName,
        summary: a.summary,
        reason: a.reason,
      }));

    return { unitId, services, averageMilesBetween, plan, readings, corrections };
  }

  // =============================================================================== shops

  /** Every active shop with what this company paid it for the service (§3.6): a price list. */
  /** A new shop, from the sheet; a name already on the list answers with that shop instead. */
  async addShop(principal: Principal, input: CreatePmShopInput): Promise<PmShop> {
    const companyId = principal.companyId;
    const existing = (await this.shops(principal)).find(
      (s) => s.name.trim().toLowerCase() === input.name.trim().toLowerCase(),
    );
    if (existing) return existing;
    const now = new Date();
    const id = `ven_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.db.insert(vendors).values({
      id,
      companyId,
      name: input.name.trim(),
      kind: 'shop',
      city: input.city?.trim() || null,
      state: input.state?.trim().toUpperCase() || null,
      isOwnYard: input.isOwnYard,
      status: 'active',
      source: 'user',
      createdAt: now,
      updatedAt: now,
    });
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'vendor',
      entityId: id,
      entityLabel: input.name.trim(),
      summary: `Shop ${input.name.trim()} added from the oil change sheet`,
      reason: null,
      changes: [],
    });
    return {
      id,
      name: input.name.trim(),
      city: input.city?.trim() || null,
      state: input.state?.trim().toUpperCase() || null,
      isOwnYard: input.isOwnYard,
      visits: 0,
      lastVisitAt: null,
      lastPrice: null,
      avgPrice: null,
    };
  }

  async shops(principal: Principal): Promise<PmShop[]> {
    const companyId = principal.companyId;
    const list = await this.db
      .select()
      .from(vendors)
      // A truck's vendor (owner, 2026-10-28) is not a shop.
      .where(and(eq(vendors.companyId, companyId), ne(vendors.status, 'inactive'), ne(vendors.kind, 'truck_owner')))
      .orderBy(vendors.name);
    const history = await this.db
      .select({
        vendorId: workOrders.vendorId,
        serviceAt: workOrders.serviceAt,
        invoiceTotal: workOrders.invoiceTotal,
      })
      .from(workOrders)
      .where(
        and(
          eq(workOrders.companyId, companyId),
          eq(workOrders.status, 'completed'),
          eq(workOrders.pmServiceCode, 'OIL_CHANGE'),
          isNull(workOrders.voidedAt),
        ),
      )
      .orderBy(desc(workOrders.serviceAt));
    const byVendor = new Map<
      string,
      { visits: number; last: Date | null; lastPrice: number | null; prices: number[] }
    >();
    for (const h of history) {
      if (!h.vendorId) continue;
      const entry = byVendor.get(h.vendorId) ?? {
        visits: 0,
        last: null,
        lastPrice: null,
        prices: [],
      };
      entry.visits += 1;
      if (!entry.last && h.serviceAt) {
        entry.last = h.serviceAt;
        entry.lastPrice = h.invoiceTotal === null ? null : Number(h.invoiceTotal);
      }
      if (h.invoiceTotal !== null && Number(h.invoiceTotal) > 0)
        entry.prices.push(Number(h.invoiceTotal));
      byVendor.set(h.vendorId, entry);
    }
    const sees = this.seesCost(principal);
    return list.map((v) => {
      const h = byVendor.get(v.id);
      const avg =
        h && h.prices.length
          ? Math.round((h.prices.reduce((a, b) => a + b, 0) / h.prices.length) * 100) / 100
          : null;
      return {
        id: v.id,
        name: v.name,
        city: v.city,
        state: v.state,
        isOwnYard: v.isOwnYard,
        visits: h?.visits ?? 0,
        lastVisitAt: h?.last?.toISOString() ?? null,
        lastPrice: sees ? (h?.lastPrice ?? null) : undefined,
        avgPrice: sees ? avg : undefined,
        addressLine: v.addressLine,
        version: v.version,
        needsName: shopNameIsAddress(v.name),
      };
    });
  }

  /**
   * Names a shop (owner, 2026-10-19: the oil-change import only had addresses, and every page said
   * the address). The work orders that name the shop follow, so the repair log reads the name too;
   * a draft becomes an active shop once a person has named it. Version-checked and audited.
   */
  async renameShop(principal: Principal, id: string, input: RenamePmShopInput): Promise<PmShop[]> {
    const companyId = principal.companyId;
    const [shop] = await this.db.select().from(vendors).where(and(eq(vendors.companyId, companyId), eq(vendors.id, id))).limit(1);
    if (!shop) throw new NotFoundException('No such shop');
    if (shop.version !== input.version) throw new ConflictException('Someone changed this shop since you opened it. Reload and try again.');
    const name = input.name.trim();
    const now = new Date();
    let orders = 0;
    await this.db.transaction(async (tx) => {
      await tx
        .update(vendors)
        .set({ name, status: shop.status === 'draft' ? 'active' : shop.status, version: shop.version + 1, updatedAt: now })
        .where(and(eq(vendors.id, id), eq(vendors.version, shop.version)));
      const moved = await tx
        .update(workOrders)
        // Not updatedAt: a rename is not the shop's update, and Last update must not restart.
        .set({ vendorName: name })
        .where(and(eq(workOrders.companyId, companyId), eq(workOrders.vendorId, id)))
        .returning({ id: workOrders.id });
      orders = moved.length;
    });
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'vendor',
      entityId: id,
      entityLabel: name,
      summary: `Shop named "${name}" (was "${shop.name}")${orders ? `; ${orders} work order(s) now read the name` : ''}`,
      changes: [{ field: 'name', old: shop.name, new: name }],
    });
    return this.shops(principal);
  }

  // =============================================================================== schedule (§6.1)

  async schedule(principal: Principal, input: SchedulePmInput): Promise<WorkOrder> {
    const companyId = principal.companyId;
    const [truck] = await this.db
      .select()
      .from(trucks)
      .where(and(eq(trucks.companyId, companyId), eq(trucks.id, input.unitId)))
      .limit(1);
    if (!truck) throw new NotFoundException('No such unit');
    const [vendor] = await this.db
      .select()
      .from(vendors)
      .where(and(eq(vendors.companyId, companyId), eq(vendors.id, input.vendorId)))
      .limit(1);
    if (!vendor) throw new BadRequestException('Pick a shop from the list');
    const scheduledFor = new Date(input.scheduledFor);
    if (Number.isNaN(scheduledFor.getTime()))
      throw new BadRequestException('That date is not a date');
    const responsible = (await this.pti.assignees(principal)).find(
      (a) => a.id === input.responsibleUserId,
    );
    if (!responsible) throw new BadRequestException('Pick who is responsible from the list');

    const existing =
      (await this.openAppointments(companyId, [input.unitId])).get(input.unitId) ?? null;
    if (existing && existing.status === 'in_shop')
      throw new BadRequestException(
        `${truck.unitNumber} is already in the shop on ${existing.number}`,
      );
    if (existing && !input.moveExisting) {
      throw new BadRequestException(
        `${truck.unitNumber} is already booked on ${existing.number} for ${(existing.scheduledFor ?? existing.shopInAt).toISOString()}. Say so to move it.`,
      );
    }

    const now = this.pm.clock();
    const bundle = input.bundle.filter((b) => b !== 'oil_filter');
    const workDone = [
      'Oil & filter change (PM A)',
      ...bundle.map((b) => (b === 'annual_inspection' ? 'Annual DOT inspection' : `Defect ${b}`)),
    ].join(' · ');
    const fields: Partial<typeof workOrders.$inferInsert> = {
      status: 'scheduled',
      shopStage: null,
      workType: 'oil_change',
      pmServiceCode: input.serviceCode,
      workDone,
      shopInAt: scheduledFor,
      scheduledFor,
      vendorId: vendor.id,
      vendorName: vendor.name,
      responsibleUserId: responsible.id,
      responsibleName: responsible.name,
      estimatedCost:
        input.estimatedCost === null || input.estimatedCost === undefined
          ? null
          : input.estimatedCost.toFixed(2),
      noteForShop: input.noteForShop?.trim() || null,
      notifyDriver: input.notifyDriver,
      notifyDispatcher: input.notifyDispatcher,
      holdMinutes: input.holdMinutes,
      enteredVia: 'pm_board',
      updatedAt: now,
    };

    let id: string;
    if (existing) {
      id = existing.id;
      await this.db.transaction(async (tx) => {
        await tx.update(workOrders).set(fields).where(eq(workOrders.id, existing.id));
        await tx.insert(workOrderActions).values({
          id: `woa_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
          workOrderId: existing.id,
          action: 'note_added',
          stage: null,
          note: `Appointment moved to ${scheduledFor.toISOString()} at ${vendor.name}`,
          userName: principal.userName ?? principal.userId,
          createdAt: now,
        });
      });
    } else {
      id = `wo_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
      const number = await this.nextNumber(companyId);
      await this.db.transaction(async (tx) => {
        await tx.insert(workOrders).values({
          id,
          companyId,
          number,
          assetType: 'truck',
          unitId: truck.id,
          unitNumber: truck.unitNumber,
          odometer: truck.odometer ?? null,
          createdBy: principal.userName ?? principal.userId,
          ...fields,
        } as typeof workOrders.$inferInsert);
        await tx.insert(workOrderActions).values({
          id: `woa_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
          workOrderId: id,
          action: 'created',
          stage: null,
          note: `Scheduled into ${vendor.name} for ${scheduledFor.toISOString()}`,
          userName: principal.userName ?? principal.userId,
          createdAt: now,
        });
      });
    }
    await this.audit.write(principal, {
      action: existing ? 'update' : 'create',
      entityType: 'pm_appointment',
      entityId: id,
      entityLabel: `Unit ${truck.unitNumber} · oil change`,
      summary: `${existing ? 'Moved' : 'Booked'} oil change for ${truck.unitNumber} at ${vendor.name}, ${scheduledFor.toISOString()}, ${responsible.name} responsible`,
      changes: [
        {
          field: 'scheduledFor',
          old: existing?.scheduledFor?.toISOString() ?? null,
          new: scheduledFor.toISOString(),
        },
      ],
    });
    // The due status is untouched on purpose (§4.3): no recompute here.
    const [saved] = await this.db.select().from(workOrders).where(eq(workOrders.id, id)).limit(1);
    return this.toWorkOrder(saved as WoRow, now);
  }

  // =============================================================================== complete (§6.2)

  async complete(
    principal: Principal,
    input: CompletePmInput,
  ): Promise<{ workOrder: WorkOrder; status: PmStatus }> {
    const companyId = principal.companyId;
    const [truck] = await this.db
      .select()
      .from(trucks)
      .where(and(eq(trucks.companyId, companyId), eq(trucks.id, input.unitId)))
      .limit(1);
    if (!truck) throw new NotFoundException('No such unit');
    const [vendor] = await this.db
      .select()
      .from(vendors)
      .where(and(eq(vendors.companyId, companyId), eq(vendors.id, input.vendorId)))
      .limit(1);
    if (!vendor) throw new BadRequestException('Pick a shop from the list');
    const serviceAt = new Date(input.serviceAt);
    if (Number.isNaN(serviceAt.getTime()))
      throw new BadRequestException('That service date is not a date');
    const now = this.pm.clock();
    if (serviceAt.getTime() > now.getTime() + 5 * 60_000)
      throw new BadRequestException('The service time is in the future');

    // The odometer at the service against the ELD (§6.2): beyond the tolerance, a reason.
    const eld = await this.nearestReading(companyId, input.unitId, serviceAt);
    const check = odometerCheck({
      serviceOdometer: input.serviceOdometer,
      eldOdometer: eld?.odometerMiles ?? null,
      eldAt: eld?.readingAt.toISOString() ?? null,
    });
    if (check.verdict === 'needs_reason' && !input.odometerReason?.trim()) {
      throw new BadRequestException(
        `The odometer is ${check.gapMiles} miles from the ELD's ${eld?.odometerMiles}. Say why before saving.`,
      );
    }
    // A duplicate invoice is flagged, not added (§8).
    if (input.invoiceNumber?.trim()) {
      const dup = await this.db
        .select({ id: workOrders.id, number: workOrders.number })
        .from(workOrders)
        .where(
          and(
            eq(workOrders.companyId, companyId),
            eq(workOrders.vendorId, vendor.id),
            eq(workOrders.invoiceNumber, input.invoiceNumber.trim()),
            isNull(workOrders.voidedAt),
          ),
        )
        .limit(1);
      if (dup.length && dup[0]?.id !== input.workOrderId) {
        throw new BadRequestException(
          `Invoice ${input.invoiceNumber.trim()} from ${vendor.name} is already on ${dup[0]?.number}`,
        );
      }
    }

    const existing = input.workOrderId
      ? (
          await this.db
            .select()
            .from(workOrders)
            .where(and(eq(workOrders.companyId, companyId), eq(workOrders.id, input.workOrderId)))
            .limit(1)
        )[0]
      : (await this.openAppointments(companyId, [input.unitId])).get(input.unitId);
    if (existing && existing.status === 'completed')
      throw new BadRequestException(`${existing.number} is already completed`);
    if (existing && existing.unitId !== input.unitId)
      throw new BadRequestException(`${existing.number} is on another unit`);
    // The same oil change already written up in Repairs (or here): one record, one bill (owner,
    // 2026-10-18). Within a day and a half of the service either side.
    const twins = await this.db
      .select({ id: workOrders.id, number: workOrders.number, completedAt: workOrders.completedAt })
      .from(workOrders)
      .where(
        and(
          eq(workOrders.companyId, companyId),
          eq(workOrders.unitId, input.unitId),
          eq(workOrders.assetType, 'truck'),
          eq(workOrders.workType, 'oil_change'),
          eq(workOrders.status, 'completed'),
          isNull(workOrders.voidedAt),
        ),
      );
    const twin = twins.find(
      (r) =>
        r.id !== existing?.id &&
        r.completedAt &&
        Math.abs(r.completedAt.getTime() - serviceAt.getTime()) <= 1.5 * DAY_MS,
    );
    if (twin) {
      throw new BadRequestException(
        `This oil change is already recorded as ${twin.number}. Correct that one instead of adding another.`,
      );
    }

    const status = await this.pm.status(principal, input.unitId);
    const timeZone = await this.pm.timeZone(companyId);
    const workDone = input.work.map((w) => PM_WORK_ITEM_LABEL[w]?.label ?? w).join(', ');
    const pmTotal = Math.max(
      0,
      input.invoiceTotal - input.otherLines.reduce((sum, l) => sum + l.amount, 0),
    );
    const id = existing?.id ?? `wo_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
    const odoCheck = await this.pm.checkReading(companyId, { unitId: input.unitId, readingAt: serviceAt, odometerMiles: input.serviceOdometer, ignoreId: readingIdFor(id) });
    const number = existing?.number ?? (await this.nextNumber(companyId));
    const shopInAt = existing?.status === 'in_shop' ? existing.shopInAt : serviceAt;

    await this.db.transaction(async (tx) => {
      const fields: Partial<typeof workOrders.$inferInsert> = {
        status: 'completed',
        shopStage: null,
        workType: 'oil_change',
        pmServiceCode: input.serviceCode,
        workDone,
        shopInAt,
        completedAt: serviceAt,
        downtimeMinutes: Math.max(
          0,
          Math.round((serviceAt.getTime() - shopInAt.getTime()) / 60_000),
        ),
        serviceAt,
        serviceOdometer: input.serviceOdometer,
        odometer: input.serviceOdometer,
        vendorId: vendor.id,
        vendorName: vendor.name,
        invoiceTotal: input.invoiceTotal.toFixed(2),
        total: input.invoiceTotal.toFixed(2),
        partsTotal: '0',
        laborTotal: pmTotal.toFixed(2),
        feesTotal: input.otherLines.reduce((sum, l) => sum + l.amount, 0).toFixed(2),
        invoiceNumber: input.invoiceNumber?.trim() || defaultInvoiceNumber(number),
        invoiceFileIds: input.invoiceFileIds,
        zeroReason: input.invoiceTotal === 0 ? (input.zeroReason ?? null) : null,
        enteredVia: 'pm_board',
        notes: input.odometerReason?.trim()
          ? `Odometer reason: ${input.odometerReason.trim()}`
          : (existing?.notes ?? null),
        updatedAt: now,
      };
      if (existing) {
        await tx.update(workOrders).set(fields).where(eq(workOrders.id, existing.id));
        await tx.delete(workOrderLines).where(eq(workOrderLines.workOrderId, existing.id));
      } else {
        await tx.insert(workOrders).values({
          id,
          companyId,
          number,
          assetType: 'truck',
          unitId: truck.id,
          unitNumber: truck.unitNumber,
          createdBy: principal.userName ?? principal.userId,
          ...fields,
        } as typeof workOrders.$inferInsert);
      }
      // 1. the lines: one PM line, then the other work on the invoice, kept apart (§6.2).
      const lines: (typeof workOrderLines.$inferInsert)[] = [
        {
          id: `wol_${now.getTime()}_pm`,
          companyId,
          workOrderId: id,
          systemCode: 'pm',
          lineKind: 'pm',
          description: workDone,
          totalAmount: pmTotal.toFixed(2),
          pmServiceCode: input.serviceCode,
          sort: 0,
        },
        ...input.otherLines.map((l, i) => ({
          id: `wol_${now.getTime()}_${i + 1}`,
          companyId,
          workOrderId: id,
          systemCode: l.systemCode,
          lineKind: 'repair',
          description: l.description,
          totalAmount: l.amount.toFixed(2),
          pmServiceCode: null,
          sort: i + 1,
        })),
      ];
      await tx.insert(workOrderLines).values(lines);
      await tx.insert(workOrderActions).values({
        id: `woa_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
        workOrderId: id,
        action: 'completed',
        stage: null,
        note: `${workDone} at ${input.serviceOdometer.toLocaleString('en-US')} mi · ${vendor.name}`,
        userName: principal.userName ?? principal.userId,
        createdAt: now,
      });
      // 2. a reading from the service odometer, source invoice - checked like any reading
      // (owner, 2026-10-22): a typo far from the last good reading is kept as a conflict.
      // Keyed on the work order so a correction or a void finds it again.
      await tx.delete(odometerReadings).where(eq(odometerReadings.id, readingIdFor(id)));
      await tx.insert(odometerReadings).values({
        id: readingIdFor(id),
        companyId,
        unitId: input.unitId,
        readingAt: serviceAt,
        readingDate: dateInZone(serviceAt, timeZone),
        odometerMiles: input.serviceOdometer,
        source: 'invoice',
        status: odoCheck.status,
        conflictReason: odoCheck.conflictReason,
        conflictWith: odoCheck.conflictWith,
        note: `From ${vendor.name} invoice${input.invoiceNumber ? ` ${input.invoiceNumber.trim()}` : ''}`,
        createdBy: principal.userId,
        createdByName: principal.userName ?? principal.userId,
        createdAt: now,
      });
    });

    // 3. the verdict follows the new baseline; 4-6 read the same record; 7. audit.
    await this.pm.recompute(companyId, [input.unitId]);
    const after = await this.pm.status(principal, input.unitId);
    const ranOver =
      status.lastServiceOdometer !== null && after.intervalMiles !== null
        ? input.serviceOdometer - status.lastServiceOdometer - after.intervalMiles
        : null;
    await this.audit.write(principal, {
      action: 'complete',
      entityType: 'pm_completion',
      entityId: id,
      entityLabel: `Unit ${truck.unitNumber} · oil change`,
      summary: `Oil change recorded for ${truck.unitNumber} at ${input.serviceOdometer.toLocaleString('en-US')} mi, ${vendor.name}, $${input.invoiceTotal.toFixed(2)}${ranOver !== null && ranOver > 0 ? ` · interval ran ${ranOver.toLocaleString('en-US')} mi over` : ''}`,
      reason: input.odometerReason?.trim() || null,
      changes: [
        {
          field: 'lastServiceOdometer',
          old: status.lastServiceOdometer === null ? null : String(status.lastServiceOdometer),
          new: String(input.serviceOdometer),
        },
        {
          field: 'nextServiceOdometer',
          old: status.nextServiceOdometer === null ? null : String(status.nextServiceOdometer),
          new: after.nextServiceOdometer === null ? null : String(after.nextServiceOdometer),
        },
      ],
    });
    // The walk-around defects it fixed follow the closed order; a person still verifies (§4.4).
    await this.pti.workOrderClosed(principal, id);
    const [saved] = await this.db.select().from(workOrders).where(eq(workOrders.id, id)).limit(1);
    return { workOrder: { ...this.toWorkOrder(saved as WoRow, now), odometerWarning: odoCheck.message }, status: after };
  }

  /** The ELD's nearest reading to a moment, for the completion form's comparison line. */
  async nearestReading(
    companyId: string,
    unitId: string,
    at: Date,
  ): Promise<{ odometerMiles: number; readingAt: Date; source: string } | null> {
    const window = 3 * DAY_MS;
    const rows = await this.db
      .select({
        odometerMiles: odometerReadings.odometerMiles,
        readingAt: odometerReadings.readingAt,
        source: odometerReadings.source,
      })
      .from(odometerReadings)
      .where(
        and(
          eq(odometerReadings.companyId, companyId),
          eq(odometerReadings.unitId, unitId),
          eq(odometerReadings.status, 'ok'),
          eq(odometerReadings.source, 'eld'),
          gte(odometerReadings.readingAt, new Date(at.getTime() - window)),
        ),
      )
      .orderBy(odometerReadings.readingAt);
    let best: { odometerMiles: number; readingAt: Date; source: string } | null = null;
    for (const r of rows) {
      if (
        !best ||
        Math.abs(r.readingAt.getTime() - at.getTime()) <
          Math.abs(best.readingAt.getTime() - at.getTime())
      )
        best = r;
    }
    return best;
  }

  // =============================================================================== correct / void (§6.3)

  async correct(
    principal: Principal,
    workOrderId: string,
    input: CorrectPmInput,
  ): Promise<PmStatus> {
    const companyId = principal.companyId;
    const [row] = await this.db
      .select()
      .from(workOrders)
      .where(and(eq(workOrders.companyId, companyId), eq(workOrders.id, workOrderId)))
      .limit(1);
    if (!row || !row.pmServiceCode) throw new NotFoundException('No such PM completion');
    if (row.voidedAt) throw new BadRequestException('That completion is voided');
    const now = this.pm.clock();
    const patch: Partial<typeof workOrders.$inferInsert> = { updatedAt: now };
    const changes: { field: string; old: string | null; new: string | null }[] = [];
    if (input.serviceOdometer !== undefined && input.serviceOdometer !== row.serviceOdometer) {
      patch.serviceOdometer = input.serviceOdometer;
      patch.odometer = input.serviceOdometer;
      changes.push({
        field: 'serviceOdometer',
        old: row.serviceOdometer === null ? null : String(row.serviceOdometer),
        new: String(input.serviceOdometer),
      });
    }
    if (input.serviceAt !== undefined) {
      const at = new Date(input.serviceAt);
      if (Number.isNaN(at.getTime())) throw new BadRequestException('That date is not a date');
      if (at.getTime() !== row.serviceAt?.getTime()) {
        patch.serviceAt = at;
        patch.completedAt = at;
        changes.push({
          field: 'serviceAt',
          old: row.serviceAt?.toISOString() ?? null,
          new: at.toISOString(),
        });
      }
    }
    if (changes.length === 0) throw new BadRequestException('Nothing changed');
    const timeZone = await this.pm.timeZone(companyId);
    const correctedAt = patch.serviceAt ?? row.serviceAt ?? now;
    const correctedMiles = patch.serviceOdometer ?? row.serviceOdometer ?? 0;
    const recheck = await this.pm.checkReading(companyId, { unitId: row.unitId, readingAt: correctedAt, odometerMiles: correctedMiles, ignoreId: readingIdFor(row.id) });
    await this.db.transaction(async (tx) => {
      await tx.update(workOrders).set(patch).where(eq(workOrders.id, row.id));
      if (patch.serviceOdometer !== undefined || patch.serviceAt !== undefined) {
        const readingAt = correctedAt;
        await tx
          .update(odometerReadings)
          .set({
            odometerMiles: correctedMiles,
            readingAt,
            readingDate: dateInZone(readingAt, timeZone),
            // A corrected figure is checked again: a typo fixed becomes a good reading.
            status: recheck.status,
            conflictReason: recheck.conflictReason,
            conflictWith: recheck.conflictWith,
          })
          .where(and(eq(odometerReadings.id, readingIdFor(row.id)), ne(odometerReadings.status, 'void')));
      }
    });
    await this.pm.recompute(companyId, [row.unitId]);
    await this.audit.write(principal, {
      action: 'correct',
      entityType: 'pm_completion',
      entityId: row.id,
      entityLabel: `Unit ${row.unitNumber} · oil change ${row.number}`,
      summary:
        changes
          .map((c) =>
            c.field === 'serviceOdometer'
              ? `Service odometer changed from ${fmt(c.old)} to ${fmt(c.new)}`
              : `Service date changed from ${c.old ?? 'none'} to ${c.new ?? 'none'}`,
          )
          .join('; ') + ` on ${row.number}. Next-service mileage recalculated.`,
      reason: input.reason.trim(),
      changes,
    });
    return this.pm.status(principal, row.unitId);
  }

  async void(
    principal: Principal,
    workOrderId: string,
    input: VoidPmCompletionInput,
  ): Promise<PmStatus> {
    const companyId = principal.companyId;
    const [row] = await this.db
      .select()
      .from(workOrders)
      .where(and(eq(workOrders.companyId, companyId), eq(workOrders.id, workOrderId)))
      .limit(1);
    if (!row || !row.pmServiceCode) throw new NotFoundException('No such PM completion');
    if (row.voidedAt) throw new BadRequestException('Already voided');
    const now = this.pm.clock();
    await this.db.transaction(async (tx) => {
      await tx
        .update(workOrders)
        .set({
          voidedAt: now,
          voidedBy: principal.userName ?? principal.userId,
          voidReason: input.reason.trim(),
          pmServiceCode: null,
          updatedAt: now,
        })
        .where(eq(workOrders.id, row.id));
      await tx
        .update(odometerReadings)
        .set({ status: 'void', voidedAt: now, voidReason: input.reason.trim() })
        .where(eq(odometerReadings.id, readingIdFor(row.id)));
    });
    await this.pm.recompute(companyId, [row.unitId]);
    await this.audit.write(principal, {
      action: 'void',
      entityType: 'pm_completion',
      entityId: row.id,
      entityLabel: `Unit ${row.unitNumber} · oil change ${row.number}`,
      summary: `Oil change ${row.number} voided; the previous baseline stands`,
      reason: input.reason.trim(),
      changes: [{ field: 'voidedAt', old: null, new: now.toISOString() }],
    });
    return this.pm.status(principal, row.unitId);
  }

  // =============================================================================== helpers

  private async nextNumber(companyId: string): Promise<string> {
    const year = this.pm.clock().getUTCFullYear();
    const rows = await this.db
      .select({ number: workOrders.number })
      .from(workOrders)
      .where(eq(workOrders.companyId, companyId));
    let max = 0;
    for (const r of rows) {
      const m = /^RO-(\d{4})-(\d+)$/.exec(r.number);
      if (m && Number(m[1]) === year) max = Math.max(max, Number(m[2]));
    }
    return `RO-${year}-${String(max + 1).padStart(4, '0')}`;
  }

  private toWorkOrder(row: WoRow, now: Date): WorkOrder {
    return {
      id: row.id,
      number: row.number,
      assetType: row.assetType as 'truck' | 'trailer',
      unitId: row.unitId,
      unitNumber: row.unitNumber,
      status: row.status as WorkOrder['status'],
      shopStage: (row.shopStage as WorkOrder['shopStage']) ?? null,
      workType: row.workType as WorkOrder['workType'],
      workDone: row.workDone,
      charge: {
        party: (row.chargeParty as WorkOrder['charge']['party']) ?? 'company',
        driverId: row.chargeDriverId ?? null,
        driverName: row.chargeDriverName ?? null,
        driverInformed: row.driverInformed ?? null,
        informedAt: row.driverInformedAt?.toISOString() ?? null,
        informedBy: row.driverInformedBy ?? null,
      },
      shopInAt: row.shopInAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      downtimeMinutes:
        row.downtimeMinutes ??
        Math.max(0, Math.round((now.getTime() - row.shopInAt.getTime()) / 60_000)),
      odometer: row.odometer,
      assignedTo: row.assignedTo,
      label: `${row.unitNumber} · Oil change`,
      lastAction: null,
      defectId: row.defectId ?? null,
      pmServiceCode: row.pmServiceCode ?? null,
      scheduledFor: row.scheduledFor?.toISOString() ?? null,
      responsibleName: row.responsibleName ?? null,
      vendorName: row.vendorName ?? null,
      driverName: null,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
