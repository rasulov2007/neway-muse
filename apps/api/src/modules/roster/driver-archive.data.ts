import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ACTIVE_LOAD_STATUSES, localParts, weekStartMonday } from '@neway/shared';
import type { Database } from '../../database/client';
import { dispatchRoster } from '../../database/schema/dispatch-ops';
import { truckDriverAssignments } from '../../database/schema/fleet';
import { loads } from '../../database/schema/loads';
import { auditLogs } from '../../database/schema/people';
import { drivers, trucks } from '../../database/schema/roster';
import { audit } from '../dispatch-board/ops.helpers';
import { NO_DISPATCHER_ID } from '../dispatch-board/no-dispatcher';

/**
 * Archiving drivers (owner, 2026-10-02).
 *
 * "Archived" means hidden, kept, reversible, audited:
 *   - the driver file gets `archived_at` / `archived_reason` / `archived_by` (migration 0039). Its
 *     status, loads, documents and history are untouched. GET /drivers leaves it out unless
 *     `includeArchived=true`; the Drivers page shows it under its Archived tab, with Restore;
 *   - its board row is taken off the boards with the roster's own unassign mechanism, from the
 *     Monday of the current Eastern week, so this week and every later one leave it out and every
 *     earlier week and day keeps it exactly as it was.
 * Every change writes an audit line: `audit_logs` for the driver file, `dispatch_audit` for the
 * board row. Nothing is deleted.
 *
 * Shared by `scripts/archive-unassigned-drivers.ts` (the owner's one-off for the UNASSIGNED team)
 * and by the drivers / roster services (restore).
 */

/** Every clock in the product is US Eastern (owner, 2026-09-25). */
const ZONE = 'America/New_York';

/** The reason the owner's 2026-10-02 decision writes on every row it archives. */
export const ARCHIVE_REASON_NO_DISPATCHER = 'Archived: no dispatcher (owner, 2026-10-02)';

/** A database or a transaction: both read and write the same way. */
export type ArchiveDb = Pick<Database, 'select' | 'insert' | 'update'>;

export interface ArchiveActor {
  userId: string;
  userName: string;
  /** `system` for the script, `user` for a person in the app. */
  actorType: 'user' | 'system';
}

export interface ArchiveCandidate {
  rosterId: string;
  rosterVersion: number;
  /** Null for a board row with no driver file behind it: only the board row is taken off. */
  driverId: string | null;
  driverNumber: string | null;
  name: string;
  status: string | null;
  /** The unit the fleet has the driver in, if any. */
  fleetTruckUnit: string | null;
  /** The truck typed on the board row, if any (a label on the board, not a fleet assignment). */
  boardTruckUnit: string | null;
  lastLoad: { loadNumber: string; date: string | null; status: string } | null;
  /** Why this row is NOT archived; null when it will be. */
  skip: string | null;
}

export interface ArchivePlan {
  companyId: string;
  /** The Monday (Eastern) the board rows go off from. */
  fromWeek: string;
  candidates: ArchiveCandidate[];
  /** Drivers already archived with this reason (a re-run finds them here, not in `candidates`). */
  alreadyArchived: number;
}

/** The company's today, US Eastern, from the server clock. */
export function easternToday(now: Date): string {
  return localParts(now.toISOString(), ZONE)?.date ?? now.toISOString().slice(0, 10);
}

/**
 * The board rows the Daily/Weekly boards put under UNASSIGNED, and whether each may be archived.
 *
 * The rule mirrors `RosterService.resolve`: a live board row (never unassigned) whose team is the
 * board row's own dispatcher, else the driver file's - and both are empty. A driver file that is
 * terminated is not on the boards and is left out. A driver on an active load or in a truck is a
 * skip, with the reason.
 */
export async function planUnassignedArchive(db: ArchiveDb, companyId: string, now: Date): Promise<ArchivePlan> {
  const fromWeek = weekStartMonday(easternToday(now));
  const rows = await db
    .select({
      rosterId: dispatchRoster.id,
      rosterVersion: dispatchRoster.version,
      rosterName: dispatchRoster.name,
      boardTruckUnit: dispatchRoster.truckUnit,
      driverId: drivers.id,
      driverNumber: drivers.driverNumber,
      firstName: drivers.firstName,
      lastName: drivers.lastName,
      status: drivers.status,
      currentTruckId: drivers.currentTruckId,
    })
    .from(dispatchRoster)
    .leftJoin(drivers, and(eq(drivers.id, dispatchRoster.driverId), eq(drivers.companyId, dispatchRoster.companyId)))
    .where(
      and(
        eq(dispatchRoster.companyId, companyId),
        isNull(dispatchRoster.unassignedFrom),
        // Unassigned on the boards: no team on the row or the driver file, or the row taken off its dispatcher.
        sql`(${dispatchRoster.dispatcherId} = ${NO_DISPATCHER_ID} or coalesce(nullif(${dispatchRoster.dispatcherId}, ''), ${drivers.dispatcherId}, '') = '')`,
        sql`(${drivers.id} is null or ${drivers.status} <> 'terminated')`,
      ),
    );

  const driverIds = rows.map((r) => r.driverId).filter((x): x is string => Boolean(x));
  const [activeLoads, fleetTrucks, openAssignments, lastLoads, [already]] = await Promise.all([
    driverIds.length
      ? db
          .select({ driverId: loads.driverId, loadNumber: loads.loadNumber, status: loads.status })
          .from(loads)
          .where(
            and(
              eq(loads.companyId, companyId),
              inArray(loads.driverId, driverIds),
              inArray(loads.status, [...ACTIVE_LOAD_STATUSES]),
              eq(loads.isDemo, false),
            ),
          )
      : Promise.resolve([]),
    driverIds.length
      ? db
          .select({ id: trucks.id, unitNumber: trucks.unitNumber, currentDriverId: trucks.currentDriverId })
          .from(trucks)
          .where(and(eq(trucks.companyId, companyId), inArray(trucks.currentDriverId, driverIds)))
      : Promise.resolve([]),
    driverIds.length
      ? db
          .select({ driverId: truckDriverAssignments.driverId, truckId: truckDriverAssignments.truckId, unitNumber: trucks.unitNumber })
          .from(truckDriverAssignments)
          .leftJoin(trucks, and(eq(trucks.id, truckDriverAssignments.truckId), eq(trucks.companyId, companyId)))
          .where(
            and(
              eq(truckDriverAssignments.companyId, companyId),
              inArray(truckDriverAssignments.driverId, driverIds),
              isNull(truckDriverAssignments.endedOn),
            ),
          )
      : Promise.resolve([]),
    driverIds.length
      ? db
          .select({
            driverId: loads.driverId,
            loadNumber: loads.loadNumber,
            status: loads.status,
            pickup: sql<string | null>`coalesce(${loads.record}->'stops'->0->>'appointmentStartAt', ${loads.record}->>'pickupAt', ${loads.createdAt}::text)`,
          })
          .from(loads)
          .where(and(eq(loads.companyId, companyId), inArray(loads.driverId, driverIds), eq(loads.isDemo, false)))
          .orderBy(desc(sql`coalesce(${loads.record}->'stops'->0->>'appointmentStartAt', ${loads.record}->>'pickupAt', ${loads.createdAt}::text)`))
      : Promise.resolve([]),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(drivers)
      .where(and(eq(drivers.companyId, companyId), eq(drivers.archivedReason, ARCHIVE_REASON_NO_DISPATCHER))),
  ]);

  const truckIds = rows.map((r) => r.currentTruckId).filter((x): x is string => Boolean(x));
  const currentTrucks = truckIds.length
    ? await db
        .select({ id: trucks.id, unitNumber: trucks.unitNumber })
        .from(trucks)
        .where(and(eq(trucks.companyId, companyId), inArray(trucks.id, truckIds)))
    : [];
  const unitOf = new Map(currentTrucks.map((t) => [t.id, t.unitNumber]));

  const candidates: ArchiveCandidate[] = rows.map((r) => {
    const id = r.driverId;
    const reasons: string[] = [];
    let fleetTruckUnit: string | null = null;
    if (id) {
      const onLoads = activeLoads.filter((l) => l.driverId === id);
      if (onLoads.length)
        reasons.push(`active load ${onLoads.map((l) => `${l.loadNumber} (${l.status})`).join(', ')}`);
      const units = new Set<string>();
      if (r.currentTruckId) units.add(unitOf.get(r.currentTruckId) ?? r.currentTruckId);
      for (const t of fleetTrucks) if (t.currentDriverId === id) units.add(t.unitNumber);
      for (const a of openAssignments) if (a.driverId === id) units.add(a.unitNumber ?? a.truckId);
      if (units.size) {
        fleetTruckUnit = [...units].join('/');
        reasons.push(`assigned to truck ${fleetTruckUnit}`);
      }
    }
    const last = id ? lastLoads.find((l) => l.driverId === id) : undefined;
    return {
      rosterId: r.rosterId,
      rosterVersion: r.rosterVersion,
      driverId: id,
      driverNumber: r.driverNumber,
      name: r.rosterName || (id ? `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() : ''),
      status: r.status,
      fleetTruckUnit,
      boardTruckUnit: r.boardTruckUnit,
      lastLoad: last
        ? { loadNumber: last.loadNumber, date: last.pickup ? (localParts(last.pickup, ZONE)?.date ?? last.pickup.slice(0, 10)) : null, status: last.status }
        : null,
      skip: reasons.length ? reasons.join('; ') : null,
    };
  });
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  return { companyId, fromWeek, candidates, alreadyArchived: already?.n ?? 0 };
}

/**
 * Archives every candidate the plan does not skip. Run inside one transaction; the guards in the
 * WHERE clauses (board row still live, driver not yet archived) make a second run write nothing.
 */
export async function applyUnassignedArchive(
  tx: ArchiveDb,
  plan: ArchivePlan,
  actor: ArchiveActor,
  now: Date,
  reason = ARCHIVE_REASON_NO_DISPATCHER,
): Promise<{ rosterRows: number; drivers: number }> {
  let rosterRows = 0;
  let archivedDrivers = 0;
  const who = { companyId: plan.companyId, userId: actor.userId, userName: actor.userName };
  for (const c of plan.candidates) {
    if (c.skip) continue;
    const [row] = await tx
      .update(dispatchRoster)
      .set({
        unassignedAt: now,
        unassignedFrom: plan.fromWeek,
        unassignedReason: reason,
        updatedAt: now,
        version: sql`${dispatchRoster.version} + 1`,
      })
      .where(
        and(
          eq(dispatchRoster.companyId, plan.companyId),
          eq(dispatchRoster.id, c.rosterId),
          isNull(dispatchRoster.unassignedFrom),
        ),
      )
      .returning({ id: dispatchRoster.id, version: dispatchRoster.version });
    if (row) {
      rosterRows += 1;
      await audit(tx, who, now, 'roster', c.rosterId, 'unassign', { unassignedAt: null, version: row.version - 1 }, { fromWeek: plan.fromWeek, reason, version: row.version });
    }
    if (!c.driverId) continue;
    const [file] = await tx
      .update(drivers)
      .set({ archivedAt: now, archivedReason: reason, archivedBy: actor.userId, updatedAt: now })
      .where(and(eq(drivers.companyId, plan.companyId), eq(drivers.id, c.driverId), isNull(drivers.archivedAt)))
      .returning({ id: drivers.id });
    if (file) {
      archivedDrivers += 1;
      await tx.insert(auditLogs).values({
        id: `aud_${crypto.randomUUID()}`,
        companyId: plan.companyId,
        actorType: actor.actorType,
        actorId: actor.userId,
        actorName: actor.userName,
        action: 'archive',
        entityType: 'driver',
        entityId: c.driverId,
        entityLabel: c.name,
        summary: `Archived (status stays ${c.status ?? 'unknown'}); off the boards from ${plan.fromWeek}`,
        changes: [
          { field: 'archivedAt', old: null, new: now.toISOString() },
          { field: 'archivedReason', old: null, new: reason },
        ],
        reason,
        at: now,
      });
    }
  }
  return { rosterRows, drivers: archivedDrivers };
}

export interface RestoreResult {
  driverId: string;
  name: string;
  driverRestored: boolean;
  /** The board row put back on the boards (only when the archive had taken it off). */
  rosterRestored: string | null;
}

/**
 * Brings an archived driver back: the file is shown again and, when the archive took the board
 * row off (same reason on both), the board row is back from its unassign week. Idempotent: a
 * driver who is not archived comes back unchanged. `expectedArchivedAt`, when given, is the
 * version check - a restore against an archive somebody else already changed is refused.
 */
export async function restoreArchivedDriver(
  tx: ArchiveDb,
  companyId: string,
  driverId: string,
  actor: ArchiveActor,
  now: Date,
  expectedArchivedAt?: string,
): Promise<RestoreResult | { conflict: string } | null> {
  const [file] = await tx
    .select({
      id: drivers.id,
      firstName: drivers.firstName,
      lastName: drivers.lastName,
      archivedAt: drivers.archivedAt,
      archivedReason: drivers.archivedReason,
    })
    .from(drivers)
    .where(and(eq(drivers.companyId, companyId), eq(drivers.id, driverId)))
    .limit(1);
  if (!file) return null;
  const name = `${file.firstName} ${file.lastName}`.trim();
  if (!file.archivedAt) {
    if (expectedArchivedAt) return { conflict: `${name} is not archived any more. Reload and try again.` };
    return { driverId, name, driverRestored: false, rosterRestored: null };
  }
  const archivedIso = new Date(file.archivedAt).toISOString();
  if (expectedArchivedAt && new Date(expectedArchivedAt).toISOString() !== archivedIso)
    return { conflict: `${name} was archived again by someone else. Reload and try again.` };

  await clearArchive(tx, companyId, { ...file, name, archivedIso }, actor, now, 'Restored from the archive');

  let rosterRestored: string | null = null;
  const [row] = await tx
    .select()
    .from(dispatchRoster)
    .where(and(eq(dispatchRoster.companyId, companyId), eq(dispatchRoster.driverId, driverId)))
    .limit(1);
  if (row && row.unassignedAt && row.unassignedReason && row.unassignedReason === file.archivedReason) {
    await tx
      .update(dispatchRoster)
      .set({ unassignedAt: null, unassignedFrom: null, unassignedReason: null, updatedAt: now, version: row.version + 1 })
      .where(and(eq(dispatchRoster.companyId, companyId), eq(dispatchRoster.id, row.id)));
    await audit(
      tx,
      { companyId, userId: actor.userId, userName: actor.userName },
      now,
      'roster',
      row.id,
      'restore',
      { unassignedFrom: row.unassignedFrom, reason: row.unassignedReason, version: row.version },
      { version: row.version + 1, with: 'driver restored from the archive' },
    );
    rosterRestored = row.id;
  }
  return { driverId, name, driverRestored: true, rosterRestored };
}

/** For the roster service: un-archive the driver file behind a board row the board just restored. */
export async function unarchiveForRosterRestore(
  tx: ArchiveDb,
  companyId: string,
  driverId: string,
  unassignedReason: string | null,
  actor: ArchiveActor,
  now: Date,
): Promise<boolean> {
  const [file] = await tx
    .select({ id: drivers.id, firstName: drivers.firstName, lastName: drivers.lastName, archivedAt: drivers.archivedAt, archivedReason: drivers.archivedReason })
    .from(drivers)
    .where(and(eq(drivers.companyId, companyId), eq(drivers.id, driverId)))
    .limit(1);
  if (!file?.archivedAt || !unassignedReason || file.archivedReason !== unassignedReason) return false;
  const name = `${file.firstName} ${file.lastName}`.trim();
  const archivedIso = new Date(file.archivedAt).toISOString();
  await clearArchive(tx, companyId, { id: driverId, archivedReason: file.archivedReason, name, archivedIso }, actor, now, 'Restored from the archive (board row restored on the dispatch board)');
  return true;
}

/** Clears the three archive columns and writes the driver's audit line. */
async function clearArchive(
  tx: ArchiveDb,
  companyId: string,
  file: { id: string; name: string; archivedIso: string; archivedReason: string | null },
  actor: ArchiveActor,
  now: Date,
  summary: string,
): Promise<void> {
  await tx
    .update(drivers)
    .set({ archivedAt: null, archivedReason: null, archivedBy: null, updatedAt: now })
    .where(and(eq(drivers.companyId, companyId), eq(drivers.id, file.id)));
  await tx.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    companyId,
    actorType: actor.actorType,
    actorId: actor.userId,
    actorName: actor.userName,
    action: 'restore',
    entityType: 'driver',
    entityId: file.id,
    entityLabel: file.name,
    summary,
    changes: [
      { field: 'archivedAt', old: file.archivedIso, new: null },
      { field: 'archivedReason', old: file.archivedReason, new: null },
    ],
    reason: null,
    at: now,
  });
}
