import { and, desc, eq, isNotNull, isNull, like } from 'drizzle-orm';
import type { Database } from '../../database/client';
import { truckDriverAssignments } from '../../database/schema/fleet';
import { auditLogs } from '../../database/schema/people';
import { drivers, trucks } from '../../database/schema/roster';
import { easternToday } from './driver-archive.data';

/**
 * Open assignment rows for trucks that have a driver pointer but no open row (owner, 2026-10-08).
 *
 * Before 0047 the driver page, the dispatch board and truck creation paired a driver with a truck
 * by pointer only, so 135 production trucks show a driver with no assignment record behind it.
 * Each gets one open row whose start date is APPROXIMATE (`assigned_on_approximate = true`, shown
 * as "about <date>"):
 *   1. the day of the latest "Assigned to unit <unit>" audit entry on the driver, else
 *   2. the later of the driver's and the truck's created date (the pair cannot be older),
 * in US Eastern, never after today.
 * A pair whose pointers disagree, or where either side already has an open row elsewhere, is
 * listed as a skip with the reason and never written. Re-runnable: a truck with an open row is
 * not a candidate any more.
 */

type Db = Pick<Database, 'select' | 'insert'>;

export interface BackfillCandidate {
  truckId: string;
  unitNumber: string;
  driverId: string;
  driverName: string;
  assignedOn: string;
  basis: 'audit' | 'created';
  /** Why the pair is not written; null when it is. */
  skip: string | null;
}

export interface BackfillPlan {
  companyId: string;
  /** Trucks with a driver pointer. */
  pointed: number;
  /** Of those, already backed by an open row for the same driver. */
  alreadyBacked: number;
  candidates: BackfillCandidate[];
}

export const BACKFILL_ACTOR = {
  userId: 'system:backfill-truck-assignments',
  userName: 'Assignment backfill (owner, 2026-10-08)',
};

const easternDay = (d: Date): string => easternToday(d);

export async function planAssignmentBackfill(
  db: Db,
  companyId: string,
  now: Date,
): Promise<BackfillPlan> {
  const today = easternToday(now);
  const truckRows = await db
    .select({
      id: trucks.id,
      unitNumber: trucks.unitNumber,
      status: trucks.status,
      currentDriverId: trucks.currentDriverId,
      createdAt: trucks.createdAt,
    })
    .from(trucks)
    .where(and(eq(trucks.companyId, companyId), isNotNull(trucks.currentDriverId)));
  const driverRows = await db
    .select({
      id: drivers.id,
      first: drivers.firstName,
      last: drivers.lastName,
      currentTruckId: drivers.currentTruckId,
      createdAt: drivers.createdAt,
    })
    .from(drivers)
    .where(eq(drivers.companyId, companyId));
  const open = await db
    .select({ truckId: truckDriverAssignments.truckId, driverId: truckDriverAssignments.driverId })
    .from(truckDriverAssignments)
    .where(and(eq(truckDriverAssignments.companyId, companyId), isNull(truckDriverAssignments.endedOn)));
  const byDriver = new Map(driverRows.map((d) => [d.id, d]));
  const openByTruck = new Map(open.map((o) => [o.truckId, o]));
  const openByDriver = new Map(open.map((o) => [o.driverId, o]));

  const plan: BackfillPlan = { companyId, pointed: truckRows.length, alreadyBacked: 0, candidates: [] };
  for (const t of truckRows.sort((a, b) => a.unitNumber.localeCompare(b.unitNumber))) {
    const driverId = t.currentDriverId!;
    const truckOpen = openByTruck.get(t.id);
    if (truckOpen && truckOpen.driverId === driverId) {
      plan.alreadyBacked += 1;
      continue;
    }
    const d = byDriver.get(driverId);
    const driverName = d ? `${d.first} ${d.last}`.trim() : driverId;
    let skip: string | null = null;
    if (!d) skip = 'the driver file is missing';
    else if (d.currentTruckId !== t.id) {
      skip = `pointers disagree: the driver file says ${d.currentTruckId ?? 'no truck'}`;
    } else if (truckOpen) {
      skip = `the unit already has an open row for another driver (${truckOpen.driverId})`;
    } else if (openByDriver.has(driverId)) {
      skip = `the driver already has an open row on ${openByDriver.get(driverId)!.truckId}`;
    } else if (t.status === 'archived') {
      skip = 'the unit is archived';
    }

    // The latest "Assigned to unit <unit>" entry on the driver.
    const entries = await db
      .select({ at: auditLogs.at, summary: auditLogs.summary })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, companyId),
          eq(auditLogs.entityType, 'driver'),
          eq(auditLogs.entityId, driverId),
          like(auditLogs.summary, `Assigned to unit ${t.unitNumber}%`),
        ),
      )
      .orderBy(desc(auditLogs.at))
      .limit(5);
    const exact = entries.find((e) => {
      const rest = e.summary.slice(`Assigned to unit ${t.unitNumber}`.length);
      return rest === '' || rest.startsWith(' ');
    });
    let assignedOn: string;
    let basis: BackfillCandidate['basis'];
    if (exact) {
      assignedOn = easternDay(exact.at);
      basis = 'audit';
    } else {
      const later = d && d.createdAt > t.createdAt ? d.createdAt : t.createdAt;
      assignedOn = easternDay(later);
      basis = 'created';
    }
    if (assignedOn > today) assignedOn = today;
    plan.candidates.push({
      truckId: t.id,
      unitNumber: t.unitNumber,
      driverId,
      driverName,
      assignedOn,
      basis,
      skip,
    });
  }
  return plan;
}

/** Writes the open rows the plan found, with one audit entry each. Run inside a transaction. */
export async function applyAssignmentBackfill(
  db: Db,
  plan: BackfillPlan,
  now: Date,
): Promise<number> {
  let written = 0;
  for (const c of plan.candidates) {
    if (c.skip) continue;
    const id = `tda_bf_${crypto.randomUUID()}`;
    const basisWords =
      c.basis === 'audit'
        ? `the day the audit log says the driver was assigned to unit ${c.unitNumber}`
        : 'the later of the driver and truck created dates (no assignment entry in the audit log)';
    await db.insert(truckDriverAssignments).values({
      id,
      companyId: plan.companyId,
      truckId: c.truckId,
      driverId: c.driverId,
      assignedOn: c.assignedOn,
      assignedOnApproximate: true,
      source: 'backfill',
      equipment: [],
      note: null,
      createdBy: BACKFILL_ACTOR.userId,
      createdByName: BACKFILL_ACTOR.userName,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(auditLogs).values({
      id: `aud_${crypto.randomUUID()}`,
      companyId: plan.companyId,
      actorType: 'system',
      actorId: BACKFILL_ACTOR.userId,
      actorName: BACKFILL_ACTOR.userName,
      action: 'create',
      entityType: 'truck_driver_assignment',
      entityId: id,
      entityLabel: `Unit ${c.unitNumber} · ${c.driverName}`,
      summary: `Assignment record added for ${c.driverName} in unit ${c.unitNumber}, about ${c.assignedOn} (approximate)`,
      reason: `Backfill 0047: start date is ${basisWords}`,
      changes: [
        { field: 'assignedOn', old: null, new: `${c.assignedOn} (approximate)` },
        { field: 'driver', old: null, new: c.driverName },
      ],
      at: now,
    });
    written += 1;
  }
  return written;
}
