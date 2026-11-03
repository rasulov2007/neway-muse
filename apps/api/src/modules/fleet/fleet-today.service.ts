import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  MAINTENANCE_DEFAULTS,
  annualInspectionStatus,
  downtimeMinutes,
  oilChangeStatus,
  pmInspectionStatus,
  workOrderLabel,
  type FleetToday,
  type InShopRow,
  type InspectionRow,
  type OilChangeRow,
  type ShopStage,
  type WorkOrderAction,
  type WorkType,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import {
  trailers,
  trucks,
  unitMaintenanceSettings,
  workOrderActions,
  workOrders,
} from '../../database/schema';
import { fleetBreakdowns } from '../../database/schema/mobile';

/** Roster statuses that mean the unit has left the fleet and owes nobody a service. */
const RETIRED = new Set(['sold', 'retired', 'archived', 'inactive']);

/**
 * The Today board, computed on the server.
 *
 * Three questions a mechanic has at the start of a shift, and nothing else: what needs oil, what
 * needs inspecting, and what is already in the shop. Every row here is a row that needs doing
 * something about — a unit on schedule is not listed, because a list that includes the healthy
 * units is a list nobody reads to the bottom of.
 *
 * Two deliberate absences. There is no money in this response at all, because the reader is a
 * mechanic and the shape simply has no field for a price. And a unit with no service history is
 * reported as `unknown` rather than overdue, because "we never wrote it down" and "it is late" ask
 * for different actions, and the first one is somebody entering a baseline.
 *
 * Fleet specification §8.2. Odometers come from `trucks.odometer`, which is as fresh as the last
 * time somebody recorded one; a telematics feed is separate work and is not pretended at here.
 */
@Injectable()
export class FleetTodayService {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async today(principal: Principal, todayDate: string): Promise<FleetToday> {
    const defaults = MAINTENANCE_DEFAULTS;
    const now = Date.now();

    const [truckRows, trailerRows, settingRows, inShopRows] = await Promise.all([
      this.db.select().from(trucks).where(eq(trucks.companyId, principal.companyId)),
      this.db.select().from(trailers).where(eq(trailers.companyId, principal.companyId)),
      this.db
        .select()
        .from(unitMaintenanceSettings)
        .where(eq(unitMaintenanceSettings.companyId, principal.companyId)),
      this.db
        .select()
        .from(workOrders)
        .where(
          and(eq(workOrders.companyId, principal.companyId), eq(workOrders.status, 'in_shop'), isNull(workOrders.voidedAt)),
        ),
    ]);

    const settings = new Map(
      settingRows.map((row) => [`${row.assetType}:${row.unitId}`, row] as const),
    );
    const activeTrucks = truckRows.filter((row) => !RETIRED.has(row.status));
    const activeTrailers = trailerRows.filter((row) => !RETIRED.has(row.status));

    // ---- A · oil change ------------------------------------------------------------------
    const oilChanges: OilChangeRow[] = activeTrucks
      .map((truck) => {
        const setting = settings.get(`truck:${truck.id}`);
        const intervalMiles = setting?.oilChangeIntervalMiles ?? defaults.oilChangeIntervalMiles;
        const { milesRemaining, status } = oilChangeStatus({
          odometer: truck.odometer,
          lastOdometer: setting?.lastOilChangeOdometer ?? null,
          intervalMiles,
          dueSoonMiles: defaults.oilChangeDueSoonMiles,
        });
        return {
          unitId: truck.id,
          unitNumber: truck.unitNumber,
          description: `${truck.year} ${truck.make} ${truck.model}`,
          odometer: truck.odometer,
          odometerAt: truck.odometerAt.toISOString(),
          lastOilChangeAt: setting?.lastOilChangeAt?.toISOString() ?? null,
          lastOilChangeOdometer: setting?.lastOilChangeOdometer ?? null,
          intervalMiles,
          milesRemaining,
          status,
        } satisfies OilChangeRow;
      })
      // Only what needs attention. Overdue first and worst first, then the ones closest to due,
      // then the units nobody has a baseline for — which is a data job, not a shop job.
      .filter((row) => row.status !== 'ok')
      .sort(
        (a, b) =>
          rank(a.status) - rank(b.status) || (a.milesRemaining ?? 0) - (b.milesRemaining ?? 0),
      );

    // ---- B · inspections -----------------------------------------------------------------
    const inspections: InspectionRow[] = [];
    for (const truck of activeTrucks) {
      const setting = settings.get(`truck:${truck.id}`);
      inspections.push(
        this.annualRow({
          unitId: truck.id,
          unitNumber: truck.unitNumber,
          assetType: 'truck',
          // The roster's own next-inspection date is the baseline until a completed annual
          // inspection replaces it.
          lastDoneAt: setting?.lastAnnualInspectionAt?.toISOString() ?? null,
          rosterDue: truck.nextServiceDate,
          today: todayDate,
        }),
      );
      const pm = pmInspectionStatus({
        odometer: truck.odometer,
        lastOdometer: setting?.lastPmOdometer ?? null,
        lastDoneAt: setting?.lastPmAt?.toISOString() ?? null,
        today: todayDate,
        intervalMiles: setting?.pmIntervalMiles ?? defaults.pmIntervalMiles,
        intervalDays: setting?.pmIntervalDays ?? defaults.pmIntervalDays,
        dueSoonMiles: defaults.pmDueSoonMiles,
        dueSoonDays: defaults.pmDueSoonDays,
      });
      inspections.push({
        unitId: truck.id,
        unitNumber: truck.unitNumber,
        assetType: 'truck',
        inspectionType: 'pm_inspection',
        lastDoneAt: setting?.lastPmAt?.toISOString() ?? null,
        lastDoneOdometer: setting?.lastPmOdometer ?? null,
        dueDate: pm.dueDate,
        dueOdometer: pm.dueOdometer,
        daysRemaining: pm.daysRemaining,
        milesRemaining: pm.milesRemaining,
        status: pm.status,
      });
    }
    for (const trailer of activeTrailers) {
      const setting = settings.get(`trailer:${trailer.id}`);
      inspections.push(
        this.annualRow({
          unitId: trailer.id,
          unitNumber: trailer.unitNumber,
          assetType: 'trailer',
          lastDoneAt: setting?.lastAnnualInspectionAt?.toISOString() ?? null,
          rosterDue: trailer.nextInspectionDate,
          today: todayDate,
        }),
      );
      // A trailer has no odometer, so its PM is judged on days alone. That is the only honest
      // reading of it, not a degraded one.
      const pm = pmInspectionStatus({
        odometer: null,
        lastOdometer: null,
        lastDoneAt: setting?.lastPmAt?.toISOString() ?? null,
        today: todayDate,
        intervalMiles: defaults.pmIntervalMiles,
        intervalDays: setting?.pmIntervalDays ?? defaults.pmIntervalDays,
        dueSoonMiles: defaults.pmDueSoonMiles,
        dueSoonDays: defaults.pmDueSoonDays,
      });
      inspections.push({
        unitId: trailer.id,
        unitNumber: trailer.unitNumber,
        assetType: 'trailer',
        inspectionType: 'pm_inspection',
        lastDoneAt: setting?.lastPmAt?.toISOString() ?? null,
        lastDoneOdometer: null,
        dueDate: pm.dueDate,
        dueOdometer: null,
        daysRemaining: pm.daysRemaining,
        milesRemaining: null,
        status: pm.status,
      });
    }
    const needing = inspections
      .filter((row) => row.status !== 'ok')
      .sort(
        (a, b) =>
          rank(a.status) - rank(b.status) || (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0),
      );

    // ---- C · in the shop -----------------------------------------------------------------
    const latest = await this.latestActions(inShopRows.map((row) => row.id));
    // An archived truck's open work order is history, not today's shop floor.
    const archivedTruckIds = new Set(
      truckRows.filter((row) => row.status === 'archived').map((row) => row.id),
    );
    const workOrdersInShop: InShopRow[] = inShopRows
      .filter((row) => !(row.assetType === 'truck' && archivedTruckIds.has(row.unitId)))
      .map((row) => ({
        workOrderId: row.id,
        number: row.number,
        unitId: row.unitId,
        unitNumber: row.unitNumber,
        assetType: row.assetType as 'truck' | 'trailer',
        workType: row.workType as WorkType,
        label: workOrderLabel(row.unitNumber, row.workType as WorkType),
        shopStage: (row.shopStage as ShopStage | null) ?? null,
        shopInAt: row.shopInAt.toISOString(),
        downtimeMinutes: downtimeMinutes(row.shopInAt.toISOString(), null, now),
        assignedTo: row.assignedTo,
        lastAction: latest.get(row.id) ?? null,
        vendorName: row.vendorName ?? null,
        scheduledFor: row.scheduledFor?.toISOString() ?? null,
      }))
      // Longest in the shop first: that is the one costing the most and the one nobody has chased.
      .sort((a, b) => b.downtimeMinutes - a.downtimeMinutes);

    return {
      asOf: new Date(now).toISOString(),
      defaults,
      oilChanges,
      inspections: needing,
      workOrdersInShop,
      counts: {
        oilOverdue: oilChanges.filter((row) => row.status === 'overdue').length,
        oilDueSoon: oilChanges.filter((row) => row.status === 'due_soon').length,
        oilUnknown: oilChanges.filter((row) => row.status === 'unknown').length,
        inspectionsOverdue: needing.filter((row) => row.status === 'overdue').length,
        inspectionsDueSoon: needing.filter((row) => row.status === 'due_soon').length,
        inShop: workOrdersInShop.length,
        ...(await this.breakdownCounts(principal.companyId)),
      },
    };
  }

  /** Driver-reported breakdowns still open (mobile M3): the badge on the Today page. Never voided ones. */
  private async breakdownCounts(companyId: string): Promise<{ breakdownsOpen: number; breakdownsNew: number }> {
    const rows = await this.db
      .select({ status: fleetBreakdowns.status })
      .from(fleetBreakdowns)
      .where(and(eq(fleetBreakdowns.companyId, companyId), isNull(fleetBreakdowns.voidedAt), ne(fleetBreakdowns.status, 'closed')));
    return { breakdownsOpen: rows.length, breakdownsNew: rows.filter((r) => r.status === 'received').length };
  }

  /**
   * The annual inspection row for one unit.
   *
   * The roster already carries a next-inspection date, entered when the unit was set up. It is
   * used as the due date until a completed annual inspection supersedes it, so a fleet that has
   * never recorded one through this product still gets a true answer rather than "no record".
   */
  private annualRow(input: {
    unitId: string;
    unitNumber: string;
    assetType: 'truck' | 'trailer';
    lastDoneAt: string | null;
    rosterDue: string | null;
    today: string;
  }): InspectionRow {
    const defaults = MAINTENANCE_DEFAULTS;
    if (input.lastDoneAt) {
      const out = annualInspectionStatus({
        lastDoneAt: input.lastDoneAt,
        today: input.today,
        months: defaults.annualInspectionMonths,
        dueSoonDays: defaults.annualInspectionDueSoonDays,
      });
      return {
        unitId: input.unitId,
        unitNumber: input.unitNumber,
        assetType: input.assetType,
        inspectionType: 'annual_inspection',
        lastDoneAt: input.lastDoneAt,
        lastDoneOdometer: null,
        dueDate: out.dueDate,
        dueOdometer: null,
        daysRemaining: out.daysRemaining,
        milesRemaining: null,
        status: out.status,
      };
    }

    // No completed inspection on file: fall back to the date the roster carries.
    if (input.rosterDue) {
      const out = annualInspectionStatus({
        // The roster holds the due date, so work back to the notional last one.
        lastDoneAt: shiftMonths(input.rosterDue, -defaults.annualInspectionMonths),
        today: input.today,
        months: defaults.annualInspectionMonths,
        dueSoonDays: defaults.annualInspectionDueSoonDays,
      });
      return {
        unitId: input.unitId,
        unitNumber: input.unitNumber,
        assetType: input.assetType,
        inspectionType: 'annual_inspection',
        lastDoneAt: null,
        lastDoneOdometer: null,
        dueDate: input.rosterDue.slice(0, 10),
        dueOdometer: null,
        daysRemaining: out.daysRemaining,
        milesRemaining: null,
        status: out.status,
      };
    }

    return {
      unitId: input.unitId,
      unitNumber: input.unitNumber,
      assetType: input.assetType,
      inspectionType: 'annual_inspection',
      lastDoneAt: null,
      lastDoneOdometer: null,
      dueDate: null,
      dueOdometer: null,
      daysRemaining: null,
      milesRemaining: null,
      status: 'unknown',
    };
  }

  private async latestActions(ids: string[]): Promise<Map<string, WorkOrderAction>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(workOrderActions)
      .where(inArray(workOrderActions.workOrderId, ids))
      .orderBy(asc(workOrderActions.createdAt));
    const latest = new Map<string, WorkOrderAction>();
    for (const row of rows) {
      latest.set(row.workOrderId, {
        id: row.id,
        action: row.action as WorkOrderAction['action'],
        stage: (row.stage as ShopStage | null) ?? null,
        note: row.note,
        userName: row.userName,
        createdAt: row.createdAt.toISOString(),
      });
    }
    return latest;
  }
}

/** Overdue, then due soon, then the units with no baseline at all. */
function rank(status: OilChangeRow['status']): number {
  return status === 'overdue' ? 0 : status === 'due_soon' ? 1 : status === 'unknown' ? 2 : 3;
}

function shiftMonths(date: string, months: number): string {
  const at = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  at.setUTCMonth(at.getUTCMonth() + months);
  return at.toISOString().slice(0, 10);
}
