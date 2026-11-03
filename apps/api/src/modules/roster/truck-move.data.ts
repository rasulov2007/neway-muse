import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { ACTIVE_LOAD_STATUSES, ARCHIVED_TRUCK_STATUS } from '@neway/shared';
import type { Database } from '../../database/client';
import { trailers, truckDriverAssignments } from '../../database/schema/fleet';
import { loads } from '../../database/schema/loads';
import { auditLogs } from '../../database/schema/people';
import { companies, drivers, trucks } from '../../database/schema/roster';
import { easternToday } from './driver-archive.data';
import { archiveTruck } from './truck-archive.data';

/**
 * Moves a truck from one company to another (owner, 2026-10-21: unit 0016 from Northwind Freight to
 * Harbor Line Transport).
 *
 * A truck row belongs to one company and its history (repairs, loads, PTI, odometer readings,
 * fuel, settlements) is that company's, so a move is not a re-parenting:
 *   - the destination gets a NEW truck row with its own id, copying the vehicle facts (unit number,
 *     VIN, year, make, model, plate, colour, ownership, odometer and its date, engine hours, in-service
 *     date, next service) — no driver, no trailer, no load, no telematics link (the destination's own
 *     ELD sync links it by VIN), status `available`, no position;
 *   - the source truck is archived (hidden, kept, reversible, audited — `archiveTruck`) with the
 *     reason "Moved to <destination> (owner, 2026-10-21)"; its open driver assignment is ended
 *     first the way the assignment service ends one (as of today, Eastern, version-checked,
 *     audited), the driver's and the truck's pointers cleared, and a hooked trailer unhooked;
 *   - every history row stays on the source company;
 *   - both sides are audited.
 * Refused, nothing written, when the destination already has a truck with the unit number or the
 * VIN (live or archived — the unique indexes forbid a second), or the source is on an active load.
 * A second run finds the source archived and the VIN in the destination: "already moved".
 *
 * Shared by `scripts/move-truck.ts` (dry run by default) and its tests.
 */

export type TruckMoveDb = Pick<Database, 'select' | 'insert' | 'update' | 'transaction'>;

export interface TruckMoveOptions {
  fromCompanyId: string;
  toCompanyId: string;
  /** The source truck's unit number (or id). */
  unit: string;
  /** False = dry run: reads, plans, writes nothing. */
  confirm: boolean;
  now: Date;
  actor: { userId: string; userName: string };
  /** "(owner, 2026-10-21)" — the note on the reasons. */
  reasonNote?: string;
  /** The new truck's id (tests pass a fixed one); else the TrucksService rule. */
  newTruckId?: () => Promise<string> | string;
}

export interface TruckMoveResult {
  outcome: 'not_found' | 'already_moved' | 'refused' | 'planned' | 'applied';
  sourceTruckId: string | null;
  newTruckId: string | null;
  refusals: string[];
  /** Open assignments to end on the source truck. */
  endAssignments: { id: string; driverId: string; assignedOn: string; endedOn: string }[];
  reason: string | null;
  /** Human lines for the console. */
  lines: string[];
}

type TruckRow = typeof trucks.$inferSelect;

/** Upper-case, trimmed: how the unique VIN index compares. */
const vinKey = (vin: string | null | undefined) => (vin ?? '').trim().toUpperCase();

/**
 * The pure decision, from what was read. `destination` is every truck in the destination company
 * sharing the unit number or the VIN.
 */
export function planTruckMove(input: {
  source: Pick<TruckRow, 'id' | 'unitNumber' | 'vin' | 'status'>;
  destination: Pick<TruckRow, 'id' | 'unitNumber' | 'vin' | 'status'>[];
  destinationName: string;
  activeLoads: string[];
}): { outcome: 'already_moved' | 'refused' | 'go'; refusals: string[]; movedTo: string | null } {
  const { source, destination } = input;
  const sameVin = destination.find((t) => vinKey(t.vin) !== '' && vinKey(t.vin) === vinKey(source.vin));
  if (source.status === ARCHIVED_TRUCK_STATUS && sameVin) {
    return { outcome: 'already_moved', refusals: [], movedTo: sameVin.id };
  }
  const refusals: string[] = [];
  if (source.status === ARCHIVED_TRUCK_STATUS) {
    refusals.push(`Source unit ${source.unitNumber} (${source.id}) is already archived and ${input.destinationName} has no truck with its VIN; restore it first if it should move`);
  }
  for (const t of destination) {
    const live = t.status !== ARCHIVED_TRUCK_STATUS;
    const what = [
      t.unitNumber.trim().toUpperCase() === source.unitNumber.trim().toUpperCase() ? `unit number ${t.unitNumber}` : null,
      vinKey(t.vin) !== '' && vinKey(t.vin) === vinKey(source.vin) ? `VIN ${t.vin}` : null,
    ]
      .filter(Boolean)
      .join(' and ');
    refusals.push(
      live
        ? `${input.destinationName} already has a live truck with ${what} (${t.id}, ${t.status})`
        : `${input.destinationName} already has an archived truck with ${what} (${t.id}); restore that one instead of moving`,
    );
  }
  if (!vinKey(source.vin)) refusals.push(`Source unit ${source.unitNumber} has no VIN`);
  if (input.activeLoads.length > 0) refusals.push(`Unit ${source.unitNumber} is on active load ${input.activeLoads.join(', ')}; finish or move the load first`);
  return { outcome: refusals.length > 0 ? 'refused' : 'go', refusals, movedTo: null };
}

export async function moveTruck(db: TruckMoveDb, opts: TruckMoveOptions): Promise<TruckMoveResult> {
  const result: TruckMoveResult = {
    outcome: 'not_found',
    sourceTruckId: null,
    newTruckId: null,
    refusals: [],
    endAssignments: [],
    reason: null,
    lines: [],
  };
  const say = (line: string) => result.lines.push(line);
  const note = opts.reasonNote ?? '(owner, 2026-10-21)';

  const [from] = await db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, opts.fromCompanyId));
  const [to] = await db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, opts.toCompanyId));
  if (!from || !to) {
    say(`No company ${!from ? opts.fromCompanyId : opts.toCompanyId}.`);
    return result;
  }
  if (from.id === to.id) {
    result.outcome = 'refused';
    result.refusals.push('--from and --to are the same company');
    say('REFUSED - nothing written:');
    say('  - --from and --to are the same company');
    return result;
  }

  // Prefer the live truck when the unit number was reused after an earlier archive.
  const candidates = await db
    .select()
    .from(trucks)
    .where(and(eq(trucks.companyId, from.id), or(eq(trucks.id, opts.unit), eq(trucks.unitNumber, opts.unit))));
  const source = candidates.find((t) => t.status !== ARCHIVED_TRUCK_STATUS) ?? candidates[0] ?? null;
  if (!source) {
    say(`No truck ${opts.unit} in ${from.name} (${from.id}).`);
    return result;
  }
  result.sourceTruckId = source.id;
  say(`  Source  [${from.id}] ${from.name}: ${source.id}  unit ${source.unitNumber}  VIN ${source.vin}  ${source.year} ${source.make} ${source.model}  status ${source.status}  odometer ${source.odometer} @ ${source.odometerAt.toISOString()}  telematics ${source.telematicsProvider}${source.telematicsExternalId ? ` (${source.telematicsExternalId})` : ''}`);

  const destination = await db
    .select({ id: trucks.id, unitNumber: trucks.unitNumber, vin: trucks.vin, status: trucks.status })
    .from(trucks)
    .where(
      and(
        eq(trucks.companyId, to.id),
        or(eq(trucks.unitNumber, source.unitNumber), sql`upper(${trucks.vin}) = ${vinKey(source.vin)}`),
      ),
    );
  const active = await db
    .select({ loadNumber: loads.loadNumber })
    .from(loads)
    .where(and(eq(loads.companyId, from.id), eq(loads.truckId, source.id), inArray(loads.status, [...ACTIVE_LOAD_STATUSES]), eq(loads.isDemo, false)))
    .limit(5);

  const decision = planTruckMove({ source, destination, destinationName: `${to.name} (${to.id})`, activeLoads: active.map((l) => l.loadNumber) });
  if (decision.outcome === 'already_moved') {
    result.outcome = 'already_moved';
    result.newTruckId = decision.movedTo;
    say(`Already moved: ${source.id} is archived in ${from.name} and ${to.name} has ${decision.movedTo} with VIN ${source.vin} - nothing to do.`);
    return result;
  }
  if (decision.outcome === 'refused') {
    result.outcome = 'refused';
    result.refusals = decision.refusals;
    say('REFUSED - nothing written:');
    for (const why of decision.refusals) say(`  - ${why}`);
    return result;
  }

  const reason = `Moved to ${to.name} ${note}`;
  result.reason = reason;
  const today = easternToday(opts.now);
  const open = await db
    .select()
    .from(truckDriverAssignments)
    .where(and(eq(truckDriverAssignments.companyId, from.id), eq(truckDriverAssignments.truckId, source.id), isNull(truckDriverAssignments.endedOn)));
  result.endAssignments = open.map((a) => ({ id: a.id, driverId: a.driverId, assignedOn: a.assignedOn, endedOn: a.assignedOn > today ? a.assignedOn : today }));
  const driverIds = [...new Set([...open.map((a) => a.driverId), ...(source.currentDriverId ? [source.currentDriverId] : [])])];
  const driverRows = driverIds.length
    ? await db
        .select({ id: drivers.id, first: drivers.firstName, last: drivers.lastName, currentTruckId: drivers.currentTruckId })
        .from(drivers)
        .where(and(eq(drivers.companyId, from.id), inArray(drivers.id, driverIds)))
    : [];
  const nameOf = (id: string) => {
    const d = driverRows.find((r) => r.id === id);
    return d ? `${d.first} ${d.last}`.trim() : id;
  };
  const hooked = await db
    .select({ id: trailers.id, unitNumber: trailers.unitNumber })
    .from(trailers)
    .where(and(eq(trailers.companyId, from.id), eq(trailers.currentTruckId, source.id)));

  const newId = opts.newTruckId ? await opts.newTruckId() : await nextTruckId(db, source.unitNumber);
  result.newTruckId = newId;
  say(`  Create  [${to.id}] ${to.name}: ${newId}  unit ${source.unitNumber}  VIN ${source.vin}  odometer ${source.odometer} @ ${source.odometerAt.toISOString()}  engine hours ${source.engineHours}  status available  no driver / trailer / ELD link`);
  if (source.groupName) say(`          truck type "${source.groupName}" is not carried (a ${from.name} PM group); set it in ${to.name} if it applies`);
  for (const a of result.endAssignments) say(`  End     assignment ${a.id}: ${nameOf(a.driverId)} on unit ${source.unitNumber} since ${a.assignedOn}, ended ${a.endedOn}`);
  if (source.currentDriverId && !open.some((a) => a.driverId === source.currentDriverId)) say(`  Clear   driver pointer ${nameOf(source.currentDriverId)} (no open assignment row)`);
  for (const t of hooked) say(`  Unhook  trailer ${t.unitNumber} (${t.id})`);
  say(`  Archive [${from.id}] ${source.id}: ${source.status} -> archived, reason "${reason}"; repairs, loads, PTI and odometer history stay with ${from.name}`);
  if (!opts.confirm) {
    result.outcome = 'planned';
    say('DRY RUN - nothing written. Re-run with --confirm to apply.');
    return result;
  }

  const audit = (companyId: string, row: Omit<typeof auditLogs.$inferInsert, 'id' | 'companyId' | 'actorType' | 'actorId' | 'actorName' | 'at'>) =>
    ({
      id: `aud_${crypto.randomUUID()}`,
      companyId,
      actorType: 'system',
      actorId: opts.actor.userId,
      actorName: opts.actor.userName,
      at: opts.now,
      ...row,
    }) as typeof auditLogs.$inferInsert;

  await db.transaction(async (tx) => {
    // Version check on the source truck: locked, and still as it was read.
    const [current] = await tx
      .select({ updatedAt: trucks.updatedAt })
      .from(trucks)
      .where(and(eq(trucks.companyId, from.id), eq(trucks.id, source.id)))
      .for('update');
    if (!current || current.updatedAt.getTime() !== source.updatedAt.getTime()) {
      throw new Error(`Unit ${source.unitNumber} was changed by someone else; nothing written. Run again.`);
    }

    // 1 - the source's driver assignments end, as AssignmentsService.releaseDriverIn ends them.
    for (const a of open) {
      const endedOn = a.assignedOn > today ? a.assignedOn : today;
      const closed = await tx
        .update(truckDriverAssignments)
        .set({
          endedOn,
          endReason: reason,
          endedBy: opts.actor.userId,
          endedByName: opts.actor.userName,
          endedAt: opts.now,
          version: a.version + 1,
          updatedAt: opts.now,
        })
        .where(and(eq(truckDriverAssignments.id, a.id), eq(truckDriverAssignments.version, a.version), isNull(truckDriverAssignments.endedOn)))
        .returning({ id: truckDriverAssignments.id });
      if (closed.length === 0) throw new Error(`Assignment ${a.id} was changed by someone else; nothing written. Run again.`);
      await tx.insert(auditLogs).values(
        audit(from.id, {
          action: 'update',
          entityType: 'truck_driver_assignment',
          entityId: a.id,
          entityLabel: `Unit ${source.unitNumber} · ${nameOf(a.driverId)}`,
          summary: `${nameOf(a.driverId)} taken out of unit ${source.unitNumber} on ${endedOn} (${reason})`,
          changes: [{ field: 'endedOn', old: null, new: endedOn }],
          reason,
        }),
      );
    }
    for (const id of driverIds) {
      const d = driverRows.find((r) => r.id === id);
      if (!d || d.currentTruckId !== source.id) continue;
      await tx.update(drivers).set({ currentTruckId: null, updatedAt: opts.now }).where(and(eq(drivers.companyId, from.id), eq(drivers.id, id)));
      await tx.insert(auditLogs).values(
        audit(from.id, {
          action: 'update',
          entityType: 'driver',
          entityId: id,
          entityLabel: nameOf(id),
          summary: `${nameOf(id)} no longer on unit ${source.unitNumber}: the unit moved to ${to.name}`,
          changes: [{ field: 'currentTruckId', old: source.id, new: null }],
          reason,
        }),
      );
    }
    for (const t of hooked) {
      await tx.update(trailers).set({ currentTruckId: null, updatedAt: opts.now }).where(and(eq(trailers.companyId, from.id), eq(trailers.id, t.id)));
      await tx.insert(auditLogs).values(
        audit(from.id, {
          action: 'update',
          entityType: 'trailer',
          entityId: t.id,
          entityLabel: `Trailer ${t.unitNumber}`,
          summary: `Trailer ${t.unitNumber} unhooked from unit ${source.unitNumber}: the unit moved to ${to.name}`,
          changes: [{ field: 'currentTruckId', old: source.id, new: null }],
          reason,
        }),
      );
    }
    await tx
      .update(trucks)
      .set({ currentDriverId: null, currentTrailerId: null, updatedAt: opts.now })
      .where(and(eq(trucks.companyId, from.id), eq(trucks.id, source.id)));

    // 2 - the destination's new truck.
    await tx.insert(trucks).values({
      id: newId,
      companyId: to.id,
      unitNumber: source.unitNumber,
      vin: source.vin,
      year: source.year,
      make: source.make,
      model: source.model,
      plate: source.plate,
      plateState: source.plateState,
      color: source.color,
      status: 'available',
      health: source.health,
      ownership: source.ownership,
      groupName: null,
      pmResponsibility: source.pmResponsibility,
      lessorName: source.lessorName,
      odometer: source.odometer,
      odometerAt: source.odometerAt,
      engineHours: source.engineHours,
      inServiceDate: source.inServiceDate,
      currentDriverId: null,
      currentTrailerId: null,
      currentLoadId: null,
      location: null,
      nextServiceOdometer: source.nextServiceOdometer,
      nextServiceDate: source.nextServiceDate,
      nextServiceType: source.nextServiceType,
      telematicsProvider: 'Unassigned',
      telematicsStatus: 'disconnected',
      telematicsAccountId: null,
      telematicsExternalId: null,
      telematicsSyncedAt: null,
      mpg30d: '0',
      mpg90d: '0',
      idlePercent30d: '0',
      idlePercent90d: '0',
      homeTerminal: null,
      createdAt: opts.now,
      updatedAt: opts.now,
    });
    await tx.insert(auditLogs).values(
      audit(to.id, {
        action: 'create',
        entityType: 'truck',
        entityId: newId,
        entityLabel: `Unit ${source.unitNumber}`,
        summary: `Unit ${source.unitNumber} moved in from ${from.name} (was ${source.id} there); its history stays with ${from.name}`,
        changes: [
          { field: 'unitNumber', old: null, new: source.unitNumber },
          { field: 'vin', old: null, new: source.vin },
          { field: 'odometer', old: null, new: String(source.odometer) },
          { field: 'movedFrom', old: null, new: `${from.id}/${source.id}` },
        ],
        reason: `Moved from ${from.name} ${note}`,
      }),
    );

    // 3 - the source truck archived, the existing way (one audit line), plus where it went.
    const archived = await archiveTruck(tx, from.id, source.id, { ...opts.actor, actorType: 'system' }, opts.now, reason, null);
    if (!archived.ok) throw new Error(`${archived.detail} Nothing written.`);
    await tx.insert(auditLogs).values(
      audit(from.id, {
        action: 'update',
        entityType: 'truck',
        entityId: source.id,
        entityLabel: `Unit ${source.unitNumber}`,
        summary: `Unit ${source.unitNumber} moved to ${to.name} as ${newId}; history kept here`,
        changes: [{ field: 'movedTo', old: null, new: `${to.id}/${newId}` }],
        reason,
      }),
    );
  });
  result.outcome = 'applied';
  say(`APPLIED: ${newId} created in ${to.name}, ${source.id} archived in ${from.name}, ${open.length} assignment(s) ended, ${hooked.length} trailer(s) unhooked; audited on both sides.`);
  return result;
}

/** TrucksService's rule: `trk_<unit>` for a numeric unit when free, else the next free surrogate across every company. */
async function nextTruckId(db: Pick<Database, 'select'>, unitNumber: string): Promise<string> {
  const candidate = /^\d{1,6}$/.test(unitNumber) ? `trk_${unitNumber}` : null;
  if (candidate) {
    const [taken] = await db.select({ id: trucks.id }).from(trucks).where(eq(trucks.id, candidate)).limit(1);
    if (!taken) return candidate;
  }
  const [highest] = await db
    .select({ value: sql<number>`coalesce(max(nullif(regexp_replace(${trucks.id}, '\\D', '', 'g'), '')::bigint), 0)::bigint` })
    .from(trucks);
  let next = Number(highest?.value ?? 0) + 1;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const id = `trk_${String(next).padStart(3, '0')}`;
    const [taken] = await db.select({ id: trucks.id }).from(trucks).where(eq(trucks.id, id)).limit(1);
    if (!taken) return id;
    next += 1;
  }
  throw new Error('Could not find a free truck id after 50 attempts');
}
