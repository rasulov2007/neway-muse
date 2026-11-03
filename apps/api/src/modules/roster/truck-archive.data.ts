import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { ACTIVE_LOAD_STATUSES, ARCHIVED_TRUCK_STATUS } from '@neway/shared';
import type { Database } from '../../database/client';
import { truckDriverAssignments } from '../../database/schema/fleet';
import { loads } from '../../database/schema/loads';
import { auditLogs } from '../../database/schema/people';
import { drivers, trucks } from '../../database/schema/roster';

/**
 * Archiving trucks (owner, 2026-10-05).
 *
 * "Archived" means hidden, kept, reversible, audited:
 *   - the truck's status becomes `archived`. Nothing else on the row changes and nothing is
 *     deleted. Every list, picker, board and count of the current fleet leaves it out (the Trucks
 *     page shows it only under its Archived filter); old loads, repairs, fuel and settlements keep
 *     its unit number;
 *   - a Samsara sync matches it (so never creates it again) and leaves it alone (so never revives
 *     it): see `samsara-sync.plan.ts`;
 *   - restore puts it back to `available`.
 * Every change writes one `audit_logs` line with who, when, the reason and the status before and
 * after. The row's `updated_at` is the version check: a stale archive or restore is refused.
 *
 * Shared by TrucksService (POST /trucks/:id/archive and /restore) and
 * `scripts/archive-truck.ts` (the owner's one-off, dry run by default).
 */

/** A database or a transaction: both read and write the same way. */
export type TruckArchiveDb = Pick<Database, 'select' | 'insert' | 'update'>;

export interface TruckArchiveActor {
  userId: string;
  userName: string;
  /** `system` for the script, `user` for a person in the app. */
  actorType: 'user' | 'system';
}

export interface TruckArchiveCheck {
  truckId: string;
  unitNumber: string;
  status: string;
  updatedAt: string;
  /** Why it may not be archived now; empty when it may. */
  blockers: string[];
}

export type TruckArchiveResult =
  | { ok: true; truckId: string; unitNumber: string; before: string; after: string }
  | { ok: false; status: 404 | 409; detail: string };

async function findTruck(db: TruckArchiveDb, companyId: string, idOrUnit: string) {
  const [row] = await db
    .select()
    .from(trucks)
    .where(
      and(
        eq(trucks.companyId, companyId),
        or(eq(trucks.id, idOrUnit), eq(trucks.unitNumber, idOrUnit)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** What stands in the way of archiving the truck, read without writing anything. */
export async function checkTruckArchive(
  db: TruckArchiveDb,
  companyId: string,
  idOrUnit: string,
): Promise<TruckArchiveCheck | null> {
  const truck = await findTruck(db, companyId, idOrUnit);
  if (!truck) return null;
  const blockers: string[] = [];
  if (truck.status === ARCHIVED_TRUCK_STATUS) blockers.push('already archived');

  if (truck.currentDriverId) {
    const [driver] = await db
      .select({ first: drivers.firstName, last: drivers.lastName })
      .from(drivers)
      .where(and(eq(drivers.companyId, companyId), eq(drivers.id, truck.currentDriverId)))
      .limit(1);
    const name = driver ? `${driver.first} ${driver.last}`.trim() : truck.currentDriverId;
    blockers.push(`${name} is still assigned to unit ${truck.unitNumber}; move them off it first`);
  } else {
    const [open] = await db
      .select({ id: truckDriverAssignments.id })
      .from(truckDriverAssignments)
      .where(
        and(
          eq(truckDriverAssignments.companyId, companyId),
          eq(truckDriverAssignments.truckId, truck.id),
          isNull(truckDriverAssignments.endedOn),
        ),
      )
      .limit(1);
    if (open) blockers.push(`unit ${truck.unitNumber} has an open driver assignment; end it first`);
  }

  const active = await db
    .select({ loadNumber: loads.loadNumber })
    .from(loads)
    .where(
      and(
        eq(loads.companyId, companyId),
        eq(loads.truckId, truck.id),
        inArray(loads.status, [...ACTIVE_LOAD_STATUSES]),
        eq(loads.isDemo, false),
      ),
    )
    .limit(3);
  if (active.length > 0) {
    blockers.push(
      `unit ${truck.unitNumber} is on active load ${active.map((l) => l.loadNumber).join(', ')}`,
    );
  }

  return {
    truckId: truck.id,
    unitNumber: truck.unitNumber,
    status: truck.status,
    updatedAt: truck.updatedAt.toISOString(),
    blockers,
  };
}

function stale(expected: string | null, actual: Date): boolean {
  if (expected === null) return false;
  const parsed = Date.parse(expected);
  return !Number.isFinite(parsed) || parsed !== actual.getTime();
}

/**
 * Archives one truck. `expectedUpdatedAt` is the version the caller read; null only for the
 * owner's script, which reads and writes inside the same transaction.
 */
export async function archiveTruck(
  db: TruckArchiveDb,
  companyId: string,
  idOrUnit: string,
  actor: TruckArchiveActor,
  now: Date,
  reason: string,
  expectedUpdatedAt: string | null,
): Promise<TruckArchiveResult> {
  const truck = await findTruck(db, companyId, idOrUnit);
  if (!truck) return { ok: false, status: 404, detail: `No truck ${idOrUnit} on this fleet` };
  if (stale(expectedUpdatedAt, truck.updatedAt)) {
    return {
      ok: false,
      status: 409,
      detail: `Unit ${truck.unitNumber} was changed by someone else. Reload it and try again.`,
    };
  }
  const check = await checkTruckArchive(db, companyId, truck.id);
  if (check && check.blockers.length > 0) {
    return { ok: false, status: 409, detail: `Cannot archive: ${check.blockers.join('; ')}.` };
  }

  await db
    .update(trucks)
    .set({ status: ARCHIVED_TRUCK_STATUS, updatedAt: now })
    .where(and(eq(trucks.companyId, companyId), eq(trucks.id, truck.id)));

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    companyId,
    actorType: actor.actorType,
    actorId: actor.userId,
    actorName: actor.userName,
    action: 'archive',
    entityType: 'truck',
    entityId: truck.id,
    entityLabel: `Unit ${truck.unitNumber}`,
    summary: `Archived unit ${truck.unitNumber} (was ${truck.status}): hidden from every fleet list, picker and count; history kept`,
    changes: [{ field: 'status', old: truck.status, new: ARCHIVED_TRUCK_STATUS }],
    reason,
    at: now,
  });

  return {
    ok: true,
    truckId: truck.id,
    unitNumber: truck.unitNumber,
    before: truck.status,
    after: ARCHIVED_TRUCK_STATUS,
  };
}

/** Restores an archived truck to `available`, with the same version check and audit line. */
export async function restoreTruck(
  db: TruckArchiveDb,
  companyId: string,
  idOrUnit: string,
  actor: TruckArchiveActor,
  now: Date,
  reason: string | null,
  expectedUpdatedAt: string | null,
): Promise<TruckArchiveResult> {
  const truck = await findTruck(db, companyId, idOrUnit);
  if (!truck) return { ok: false, status: 404, detail: `No truck ${idOrUnit} on this fleet` };
  if (stale(expectedUpdatedAt, truck.updatedAt)) {
    return {
      ok: false,
      status: 409,
      detail: `Unit ${truck.unitNumber} was changed by someone else. Reload it and try again.`,
    };
  }
  if (truck.status !== ARCHIVED_TRUCK_STATUS) {
    return { ok: false, status: 409, detail: `Unit ${truck.unitNumber} is not archived` };
  }

  await db
    .update(trucks)
    .set({ status: 'available', updatedAt: now })
    .where(and(eq(trucks.companyId, companyId), eq(trucks.id, truck.id)));

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    companyId,
    actorType: actor.actorType,
    actorId: actor.userId,
    actorName: actor.userName,
    action: 'restore',
    entityType: 'truck',
    entityId: truck.id,
    entityLabel: `Unit ${truck.unitNumber}`,
    summary: `Restored unit ${truck.unitNumber} from the archive; back on the fleet as available`,
    changes: [{ field: 'status', old: ARCHIVED_TRUCK_STATUS, new: 'available' }],
    reason,
    at: now,
  });

  return {
    ok: true,
    truckId: truck.id,
    unitNumber: truck.unitNumber,
    before: ARCHIVED_TRUCK_STATUS,
    after: 'available',
  };
}
