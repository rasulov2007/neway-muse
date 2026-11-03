import { Injectable } from '@nestjs/common';
import { compareTeams, loadTeamNames, withTeamName } from './team-names';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  type SeparateTeamInput,
  assignmentInForce,
  cleanTruck,
  localParts,
  onBoardFrom,
  parseRosterCsv,
  normalizeName,
  type AddRosterRowInput,
  type AssignDriverToTeamInput,
  type OffBoardDriver,
  type RosterImportReport,
  type RosterRow,
  type UnassignRosterRowInput,
  type UpdateRosterRowInput,
  type DispatcherRotationReport,
  type DispatcherRotationRow,
  weekStartMonday,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import type { Database } from '../../database/client';
import { dispatchRoster, dispatchRosterAssignments } from '../../database/schema/dispatch-ops';
import { driverTeams, drivers, trucks } from '../../database/schema/roster';
import { unarchiveForRosterRestore } from '../roster/driver-archive.data';
import { applyRosterHistory, planRosterHistory, type Db } from './roster-history.data';
import { NO_DISPATCHER_ID, NO_DISPATCHER_NAME, isNoDispatcher } from './no-dispatcher';
import { audit, companyToday, conflict, forbidden, iso, newId, notFound, unprocessable } from './ops.helpers';

type RosterRecord = typeof dispatchRoster.$inferSelect;
type AssignmentRecord = typeof dispatchRosterAssignments.$inferSelect;

/** Every clock in the product is US Eastern (owner, 2026-09-25). */
const BOARD_ZONE = 'America/New_York';

/** Who the audit names when the board itself records a change it noticed. */
const SYSTEM = { userId: 'system:dispatch-roster', userName: 'System (board roster)' };

export { NO_DISPATCHER_ID, NO_DISPATCHER_NAME, isNoDispatcher };

/**
 * The team a dated assignment puts a row in: '' (Unassigned drivers) when the assignment took the
 * row off its dispatcher; the row's own team when the assignment names none.
 */
export function teamInForce(
  pin: { dispatcherId: string; dispatcherName: string } | null | undefined,
  row: { dispatcherId: string; dispatcherName: string },
): { dispatcherId: string; dispatcherName: string } {
  if (!pin) return { dispatcherId: row.dispatcherId, dispatcherName: row.dispatcherName };
  if (isNoDispatcher(pin.dispatcherId)) return { dispatcherId: '', dispatcherName: '' };
  return { dispatcherId: pin.dispatcherId || row.dispatcherId, dispatcherName: pin.dispatcherName || row.dispatcherName };
}

/** Who writes a team change: a person, or the board noticing one. */
type Actor = Pick<Principal, 'companyId' | 'userId' | 'userName'>;

/** A row's assignment history and the first date it is on the board. */
export interface RowHistory {
  history: AssignmentRecord[];
  onBoardFrom: string | null;
}

/** A board row with the driver facts behind it, resolved. */
export interface ResolvedRow extends RosterRow {
  driverNumber: string;
  driverType: string;
  cdlExpiresOn: string | null;
  medicalCardExpiresOn: string | null;
  unassignedFrom: string | null;
}

/**
 * The board roster (owner's brief §4, §6, §14): every driver file gets a board row that carries
 * the driver's own id, so typed cells stay where they were; rows the sheet ran without a driver
 * file live here on their own. Team, truck, co-driver and pay tag changes append an assignment
 * row dated today, and the weekly board reads the assignment in force for its week - so moving
 * a driver today never moves last month's earnings.
 */
@Injectable()
export class RosterService {
  constructor(private readonly database: DatabaseService) {}

  clock: () => Date = () => new Date();

  private get db() {
    return this.database.db;
  }

  /** Every active driver file has a roster row; run before every read. Idempotent. */
  async ensure(companyId: string): Promise<void> {
    const missing = await this.db
      .select({
        id: drivers.id,
        firstName: drivers.firstName,
        lastName: drivers.lastName,
        phone: drivers.phone,
        dispatcherId: drivers.dispatcherId,
        dispatcherName: drivers.dispatcherName,
        truckUnit: trucks.unitNumber,
      })
      .from(drivers)
      .leftJoin(trucks, eq(trucks.id, drivers.currentTruckId))
      .leftJoin(
        dispatchRoster,
        and(eq(dispatchRoster.companyId, companyId), eq(dispatchRoster.driverId, drivers.id)),
      )
      .where(
        and(
          eq(drivers.companyId, companyId),
          sql`${drivers.status} <> 'terminated'`,
          // An archived driver (owner, 2026-10-02) never gets a new board row.
          isNull(drivers.archivedAt),
          isNull(dispatchRoster.id),
        ),
      );
    if (missing.length === 0) return;
    const now = this.clock();
    const today = this.today(now);
    await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(dispatchRoster)
        .values(
          missing.map((d) => ({
            id: d.id,
            companyId,
            driverId: d.id,
            name: `${d.firstName} ${d.lastName}`.trim(),
            phone: d.phone,
            // Empty here means "read the driver file"; the file stays the source until the board overrides it.
            dispatcherId: '',
            dispatcherName: '',
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: dispatchRoster.id });
      const added = new Set(inserted.map((r) => r.id));
      // A new driver is on the board from today, never in earlier weeks: the first assignment says so.
      for (const d of missing) {
        if (!added.has(d.id)) continue;
        const first = {
          id: newId('dra'),
          companyId,
          rosterId: d.id,
          effectiveFrom: today,
          dispatcherId: d.dispatcherId,
          dispatcherName: d.dispatcherName,
          truckUnit: d.truckUnit ?? null,
          coDriver: null,
          payTag: null,
          by: SYSTEM.userId,
          at: now,
        };
        await tx.insert(dispatchRosterAssignments).values(first);
        await audit(tx, { companyId, ...SYSTEM }, now, 'roster', d.id, 'add-from-driver-file', null, first);
      }
    });
  }

  /**
   * Gives the named rows a first assignment when their history does not reach back to their first
   * data (the same plan the history script runs for the whole company). Idempotent.
   */
  private async completeHistory(tx: Db, companyId: string, rosterIds: string[], now: Date): Promise<void> {
    const { plan } = await planRosterHistory(tx, companyId, rosterIds);
    if (plan.length > 0) await applyRosterHistory(tx, companyId, plan, SYSTEM, now, 'history-complete-before-move');
  }

  /** The company's today: US Eastern, from the server clock. */
  private today(now: Date): string {
    return localParts(now.toISOString(), BOARD_ZONE)?.date ?? now.toISOString().slice(0, 10);
  }

  /**
   * A row whose team, truck, co-driver or pay tag changed outside the board (the driver file's
   * dispatcher or truck) gets an assignment row dated today, so the change counts from today on
   * and earlier dates keep what they had. Only rows that already have history: a row without any
   * is the history backfill's job, and until then it reads as it always did.
   */
  private async recordOutsideChanges(
    companyId: string,
    rows: ResolvedRow[],
    histories: Map<string, RowHistory>,
    noDispatcher: Set<string>,
  ): Promise<void> {
    const changes: { row: ResolvedRow; last: AssignmentRecord }[] = [];
    // Compared with the assignment in force TODAY: one dated for a later week (an Unassign from
    // next week) is a decision waiting for its week, not a change made outside the board.
    const today = this.today(this.clock());
    for (const r of rows) {
      if (r.unassignedAt) continue;
      const h = histories.get(r.id);
      if (!h || h.history.length === 0) continue;
      const last = assignmentInForce(h.history, today);
      if (!last) continue;
      const lastTeam = isNoDispatcher(last.dispatcherId) ? '' : last.dispatcherId || '';
      const differs =
        lastTeam !== (r.dispatcherId || '') ||
        (last.truckUnit ?? null) !== (r.truckUnit ?? null) ||
        (last.coDriver ?? null) !== (r.coDriver ?? null) ||
        (last.payTag ?? null) !== (r.payTag ?? null);
      if (differs) changes.push({ row: r, last });
    }
    if (changes.length === 0) return;
    const now = this.clock();
    await this.db.transaction(async (tx) => {
      for (const { row, last } of changes) {
        const lastFrom = String(last.effectiveFrom);
        const next = {
          id: newId('dra'),
          companyId,
          rosterId: row.id,
          // Never dated before the latest assignment, so the newest row stays the one in force.
          effectiveFrom: lastFrom > today ? lastFrom : today,
          dispatcherId: noDispatcher.has(row.id) ? NO_DISPATCHER_ID : row.dispatcherId,
          dispatcherName: noDispatcher.has(row.id) ? NO_DISPATCHER_NAME : row.dispatcherName,
          truckUnit: row.truckUnit ?? null,
          coDriver: row.coDriver ?? null,
          payTag: row.payTag ?? null,
          by: SYSTEM.userId,
          at: now,
        };
        await tx.insert(dispatchRosterAssignments).values(next);
        await audit(tx, { companyId, ...SYSTEM }, now, 'roster', row.id, 'assignment-from-driver-file', last, next);
      }
    });
  }

  /** Every row's assignment history and its first date on the board, keyed by roster row id. */
  async histories(companyId: string): Promise<Map<string, RowHistory>> {
    const all = await this.db
      .select()
      .from(dispatchRosterAssignments)
      .where(eq(dispatchRosterAssignments.companyId, companyId));
    const out = new Map<string, RowHistory>();
    for (const a of all) {
      const h = out.get(a.rosterId) ?? { history: [], onBoardFrom: null };
      h.history.push(a);
      out.set(a.rosterId, h);
    }
    for (const h of out.values()) h.onBoardFrom = onBoardFrom(h.history);
    return out;
  }

  /** All rows, resolved against the driver files. Unassigned rows are included (the caller filters by date). */
  async rows(companyId: string): Promise<ResolvedRow[]> {
    await this.ensure(companyId);
    const [roster, files] = await Promise.all([
      this.db.select().from(dispatchRoster).where(eq(dispatchRoster.companyId, companyId)),
      this.db
        .select({
          id: drivers.id,
          driverNumber: drivers.driverNumber,
          firstName: drivers.firstName,
          lastName: drivers.lastName,
          phone: drivers.phone,
          driverType: drivers.driverType,
          status: drivers.status,
          dispatcherId: drivers.dispatcherId,
          dispatcherName: drivers.dispatcherName,
          cdlExpiresOn: drivers.cdlExpiresOn,
          medicalCardExpiresOn: drivers.medicalCardExpiresOn,
          truckUnit: trucks.unitNumber,
        })
        .from(drivers)
        .leftJoin(trucks, eq(trucks.id, drivers.currentTruckId))
        .where(eq(drivers.companyId, companyId)),
    ]);
    const byDriver = new Map(files.map((f) => [f.id, f]));
    const rows = roster
      .map((r) => this.resolve(r, r.driverId ? byDriver.get(r.driverId) : undefined))
      .filter((r): r is ResolvedRow => r !== null);
    const live = rows.filter((r) => !r.unassignedAt);
    const byTruck = new Map<string, number>();
    for (const r of live) if (r.truckUnit) byTruck.set(r.truckUnit, (byTruck.get(r.truckUnit) ?? 0) + 1);
    for (const r of rows) r.truckConflict = Boolean(r.truckUnit && (byTruck.get(r.truckUnit) ?? 0) > 1);
    rows.sort((a, b) => a.dispatcherName.localeCompare(b.dispatcherName) || a.name.localeCompare(b.name));
    const histories = await this.histories(companyId);
    const noDispatcher = new Set(roster.filter((r) => isNoDispatcher(r.dispatcherId)).map((r) => r.id));
    await this.applyDueTeamChanges(companyId, roster, rows, histories, noDispatcher);
    await this.recordOutsideChanges(companyId, rows, histories, noDispatcher);
    return rows;
  }

  /**
   * An Unassign dated for a later week (owner, 2026-10-26) takes effect when its week comes: the
   * first read on or after that Monday moves the board row itself to "no dispatcher", so the row,
   * the Drivers' team pickers and the boards agree. The other way round too - a row whose dated
   * assignment in force today names a team again leaves "no dispatcher". Audited as the system.
   */
  private async applyDueTeamChanges(
    companyId: string,
    roster: RosterRecord[],
    rows: ResolvedRow[],
    histories: Map<string, RowHistory>,
    noDispatcher: Set<string>,
  ): Promise<void> {
    const now = this.clock();
    const today = this.today(now);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const due: { record: RosterRecord; dispatcherId: string; dispatcherName: string }[] = [];
    for (const record of roster) {
      if (record.unassignedAt || !byId.has(record.id)) continue;
      const pin = assignmentInForce(histories.get(record.id)?.history ?? [], today);
      if (!pin) continue;
      if (isNoDispatcher(pin.dispatcherId) && !isNoDispatcher(record.dispatcherId))
        due.push({ record, dispatcherId: NO_DISPATCHER_ID, dispatcherName: NO_DISPATCHER_NAME });
      else if (isNoDispatcher(record.dispatcherId) && pin.dispatcherId && !isNoDispatcher(pin.dispatcherId))
        due.push({ record, dispatcherId: pin.dispatcherId, dispatcherName: pin.dispatcherName });
    }
    await this.applyDueCoDrivers(companyId, roster, byId, histories, today, now);
    if (due.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const { record, dispatcherId, dispatcherName } of due) {
        const [written] = await tx
          .update(dispatchRoster)
          .set({ dispatcherId, dispatcherName, updatedAt: now, version: record.version + 1 })
          .where(and(eq(dispatchRoster.companyId, companyId), eq(dispatchRoster.id, record.id), eq(dispatchRoster.version, record.version)))
          .returning({ id: dispatchRoster.id });
        if (!written) continue; // somebody else wrote the row meanwhile; the next read tries again
        await audit(
          tx,
          { companyId, ...SYSTEM },
          now,
          'roster',
          record.id,
          'team-change-takes-effect',
          { dispatcherId: record.dispatcherId, dispatcherName: record.dispatcherName },
          { dispatcherId: isNoDispatcher(dispatcherId) ? null : dispatcherId, dispatcherName, from: today },
        );
        const row = byId.get(record.id)!;
        row.dispatcherId = isNoDispatcher(dispatcherId) ? '' : dispatcherId;
        row.dispatcherName = isNoDispatcher(dispatcherId) ? '' : dispatcherName;
        row.version = record.version + 1;
        if (isNoDispatcher(dispatcherId)) noDispatcher.add(record.id);
        else noDispatcher.delete(record.id);
      }
    });
  }

  /**
   * A co-driver written ahead of its day (owner, 2026-10-28: a split team's return day) moves onto
   * the board row itself once the day comes, so the row and its history agree and the board does not
   * read the row's old value back as a change made today. Only an assignment dated after the day it
   * was written counts; one dated the day it was written is already on the row. Audited as the system.
   */
  private async applyDueCoDrivers(
    companyId: string,
    roster: RosterRecord[],
    byId: Map<string, ResolvedRow>,
    histories: Map<string, RowHistory>,
    today: string,
    now: Date,
  ): Promise<void> {
    const dayOf = (at: Date | string) => localParts(new Date(at).toISOString(), BOARD_ZONE)?.date ?? new Date(at).toISOString().slice(0, 10);
    for (const record of roster) {
      const row = byId.get(record.id);
      if (record.unassignedAt || !row) continue;
      const pin = assignmentInForce(histories.get(record.id)?.history ?? [], today);
      if (!pin) continue;
      const writtenAhead = String(pin.effectiveFrom).slice(0, 10) > dayOf(pin.at);
      if (!writtenAhead || (pin.coDriver ?? null) === (record.coDriver ?? null)) continue;
      const [written] = await this.db
        .update(dispatchRoster)
        .set({ coDriver: pin.coDriver ?? null, updatedAt: now, version: record.version + 1 })
        .where(and(eq(dispatchRoster.companyId, companyId), eq(dispatchRoster.id, record.id), eq(dispatchRoster.version, record.version)))
        .returning({ id: dispatchRoster.id });
      if (!written) continue;
      await audit(this.db, { companyId, ...SYSTEM }, now, 'roster', record.id, 'co-driver-takes-effect', { coDriver: record.coDriver }, { coDriver: pin.coDriver ?? null, from: String(pin.effectiveFrom).slice(0, 10) });
      record.coDriver = pin.coDriver ?? null;
      record.version += 1;
      row.coDriver = pin.coDriver ?? null;
      row.version = record.version;
    }
  }

  /**
   * The co-driver on a row from `from` on (owner, 2026-10-28): one assignment dated `from`, and -
   * so nothing dated later puts the old co-driver back - one on each later-dated assignment's own
   * date before `until`. With `until`, the partner is back on the row from that day (the return
   * day of a split team). Every other value is the one in force that day, unless `override` names
   * it. Insert only: the newest write on a date is the one in force.
   */
  private async writeCoDriverFrom(
    tx: Db,
    actor: Actor,
    rosterId: string,
    from: string,
    coDriver: string | null,
    until: { day: string; coDriver: string } | null,
    reason: string | null,
    now: Date,
    override: { truckUnit?: string | null } = {},
  ): Promise<void> {
    const history = await tx
      .select()
      .from(dispatchRosterAssignments)
      .where(and(eq(dispatchRosterAssignments.companyId, actor.companyId), eq(dispatchRosterAssignments.rosterId, rosterId)));
    const put = async (day: string, co: string | null) => {
      const pin = assignmentInForce(history, day);
      await tx.insert(dispatchRosterAssignments).values({
        id: newId('dra'),
        companyId: actor.companyId,
        rosterId,
        effectiveFrom: day,
        dispatcherId: pin?.dispatcherId ?? '',
        dispatcherName: pin?.dispatcherName ?? '',
        truckUnit: override.truckUnit !== undefined ? override.truckUnit : (pin?.truckUnit ?? null),
        coDriver: co,
        payTag: pin?.payTag ?? null,
        reason,
        by: actor.userId,
        at: now,
      });
    };
    await put(from, coDriver);
    const later = [...new Set(history.map((h) => String(h.effectiveFrom).slice(0, 10)).filter((d) => d > from && (!until || d < until.day)))].sort();
    for (const day of later) await put(day, coDriver);
    if (until) await put(until.day, until.coDriver);
  }

  /** The co-driver's driver file: the open pairing first, then a driver file with that name. */
  private async coDriverFile(companyId: string, driverId: string | null, coDriver: string): Promise<{ id: string; name: string } | null> {
    const wanted = normalizeName(coDriver);
    if (driverId) {
      const [pair] = await this.db
        .select({ id: drivers.id, firstName: drivers.firstName, lastName: drivers.lastName })
        .from(driverTeams)
        .innerJoin(drivers, and(eq(drivers.id, driverTeams.partnerId), eq(drivers.companyId, companyId)))
        .where(and(eq(driverTeams.companyId, companyId), eq(driverTeams.driverId, driverId), isNull(driverTeams.endedOn)))
        .limit(1);
      if (pair && normalizeName(`${pair.firstName} ${pair.lastName}`) === wanted) return { id: pair.id, name: `${pair.firstName} ${pair.lastName}`.trim() };
    }
    const files = await this.db
      .select({ id: drivers.id, firstName: drivers.firstName, lastName: drivers.lastName, status: drivers.status })
      .from(drivers)
      .where(and(eq(drivers.companyId, companyId), isNull(drivers.archivedAt)));
    const hits = files.filter((f) => f.status !== 'terminated' && normalizeName(`${f.firstName} ${f.lastName}`) === wanted);
    if (hits.length !== 1) return null;
    return { id: hits[0]!.id, name: `${hits[0]!.firstName} ${hits[0]!.lastName}`.trim() };
  }

  /** The pairing on the driver files ends with the board's split, on the first solo day. */
  private async endPairing(tx: Pick<Database, 'update'>, actor: Actor, a: string | null, b: string | null, from: string, reason: string, now: Date): Promise<void> {
    if (!a || !b) return;
    await tx
      .update(driverTeams)
      .set({ endedOn: from, endedBy: actor.userName ?? actor.userId, endedAt: now, endReason: reason, version: sql`${driverTeams.version} + 1`, updatedAt: now })
      .where(
        and(
          eq(driverTeams.companyId, actor.companyId),
          isNull(driverTeams.endedOn),
          sql`${driverTeams.startedOn} <= ${from}`,
          sql`((${driverTeams.driverId} = ${a} and ${driverTeams.partnerId} = ${b}) or (${driverTeams.driverId} = ${b} and ${driverTeams.partnerId} = ${a}))`,
        ),
      );
  }

  /**
   * Separate team (owner, 2026-10-28). From the Monday of `fromWeek` the team row drives solo:
   *
   *   - the row's own driver stays: the row loses its co-driver from that week;
   *   - the co-driver stays: the co-driver's own row takes the team, the truck and the board place
   *     from that week, and the driver who left moves to Unassigned drivers.
   *
   * With `returnsOn` the one who left is back on the row from that day, as a team again. Earlier
   * weeks keep the team. Driver pay follows the loads, so the one who left is paid for nothing
   * after the split. Version-checked and audited with the reason; the driver files' pairing ends too.
   */
  async separateTeam(principal: Principal, id: string, input: SeparateTeamInput): Promise<RosterRow> {
    this.manageOrThrow(principal);
    const companyId = principal.companyId;
    const now = this.clock();
    const today = companyToday(principal, now);
    const from = weekStartMonday(input.fromWeek);
    if (from > weekStartMonday(today)) throw unprocessable('A team splits from this week or an earlier one');
    const returnsOn = input.returnsOn ?? null;
    if (returnsOn && returnsOn <= from) throw unprocessable('The return day has to come after the split');
    const before = await this.rowOrThrow(companyId, id);
    const [existing] = await this.db
      .select()
      .from(dispatchRoster)
      .where(and(eq(dispatchRoster.companyId, companyId), eq(dispatchRoster.id, id)))
      .limit(1);
    if (!existing) throw notFound('No such board row');
    if (existing.version !== input.expectedVersion)
      throw conflict('This row was changed by someone else. Reload and try again.', { currentVersion: existing.version });
    const history = (await this.histories(companyId)).get(id)?.history ?? [];
    const pinFrom = assignmentInForce(history, from);
    // The co-driver the row had that week; the row's own value only when it has no history.
    const partner = ((pinFrom ? pinFrom.coDriver : before.coDriver) ?? '').trim();
    if (!partner) throw unprocessable(`${before.name} drives solo that week: there is no team to split`);
    const reason = input.reason.trim();

    if (input.stays === 'driver') {
      const partnerFile = await this.coDriverFile(companyId, before.driverId, partner);
      await this.db.transaction(async (tx) => {
        await this.completeHistory(tx, companyId, [id], now);
        await this.writeCoDriverFrom(tx, principal, id, from, null, returnsOn ? { day: returnsOn, coDriver: partner } : null, reason, now);
        const [saved] = await tx
          .update(dispatchRoster)
          .set({ coDriver: null, updatedAt: now, version: existing.version + 1 })
          .where(and(eq(dispatchRoster.companyId, companyId), eq(dispatchRoster.id, id), eq(dispatchRoster.version, existing.version)))
          .returning({ id: dispatchRoster.id });
        if (!saved) throw conflict('This row was changed by someone else. Reload and try again.');
        await this.endPairing(tx, principal, before.driverId, partnerFile?.id ?? null, from, reason, now);
        await audit(tx, principal, now, 'roster', id, 'separate-team', { name: before.name, coDriver: partner }, { stays: before.name, leaves: partner, soloFrom: from, returnsOn, reason });
      });
      return this.rowOrThrow(companyId, id);
    }

    // The co-driver stays: their own row takes the truck and the team.
    const file = await this.coDriverFile(companyId, before.driverId, partner);
    if (!file) throw unprocessable(`${partner} has no driver file the board can match, so the row cannot be theirs. Create the driver file first, or keep ${before.name} on the board.`);
    const team = teamInForce(pinFrom, before);
    if (!team.dispatcherId) throw unprocessable(`${before.name} has no dispatcher that week`);
    const truckUnit = pinFrom?.truckUnit ?? before.truckUnit ?? null;
    await this.unassign(principal, id, { reason, fromWeek: from, expectedVersion: existing.version });
    const [coRow] = await this.db
      .select()
      .from(dispatchRoster)
      .where(and(eq(dispatchRoster.companyId, companyId), eq(dispatchRoster.driverId, file.id)))
      .limit(1);
    const assigned = await this.assignToTeam(principal, {
      driverId: file.id,
      dispatcherId: team.dispatcherId,
      dispatcherName: team.dispatcherName,
      fromWeek: from,
      reason,
      ...(coRow ? { expectedVersion: coRow.version } : {}),
    });
    const [rowNow] = await this.db
      .select()
      .from(dispatchRoster)
      .where(and(eq(dispatchRoster.companyId, companyId), eq(dispatchRoster.id, assigned.id)))
      .limit(1);
    if (!rowNow) throw notFound('No such board row');
    await this.db.transaction(async (tx) => {
      await this.completeHistory(tx, companyId, [rowNow.id], now);
      await this.writeCoDriverFrom(tx, principal, rowNow.id, from, null, returnsOn ? { day: returnsOn, coDriver: before.name } : null, reason, now, { truckUnit });
      const [saved] = await tx
        .update(dispatchRoster)
        .set({ coDriver: null, truckUnit, updatedAt: now, version: rowNow.version + 1 })
        .where(and(eq(dispatchRoster.companyId, companyId), eq(dispatchRoster.id, rowNow.id), eq(dispatchRoster.version, rowNow.version)))
        .returning({ id: dispatchRoster.id });
      if (!saved) throw conflict('This row was changed by someone else. Reload and try again.');
      await this.endPairing(tx, principal, before.driverId, file.id, from, reason, now);
      await audit(tx, principal, now, 'roster', rowNow.id, 'separate-team', { name: before.name, coDriver: partner }, { stays: file.name, leaves: before.name, truckUnit, soloFrom: from, returnsOn, reason });
    });
    return this.rowOrThrow(companyId, rowNow.id);
  }

  /**
   * Puts a row in `team` from `from` on (owner, 2026-10-26: "from that week on"): one assignment
   * dated `from`, carrying the truck, co-driver and pay tag in force that day, and - so nothing
   * dated later puts him back - one more on each later-dated assignment's own date that names
   * another team, carrying that assignment's truck. Nothing is updated or deleted; the newest
   * write on a date is the one in force. Returns what it wrote, for the audit.
   */
  private async writeTeamFrom(
    tx: Db,
    actor: Actor,
    rosterId: string,
    from: string,
    team: { dispatcherId: string; dispatcherName: string },
    reason: string | null,
    now: Date,
    fallback: { truckUnit: string | null; coDriver: string | null; payTag: string | null },
    valuesAtFrom?: { truckUnit: string | null; coDriver: string | null; payTag: string | null },
  ): Promise<{ effectiveFrom: string; dispatcherId: string; truckUnit: string | null }[]> {
    const history = await tx
      .select()
      .from(dispatchRosterAssignments)
      .where(and(eq(dispatchRosterAssignments.companyId, actor.companyId), eq(dispatchRosterAssignments.rosterId, rosterId)));
    const atFrom = assignmentInForce(history, from);
    const written: { effectiveFrom: string; dispatcherId: string; truckUnit: string | null }[] = [];
    const put = async (effectiveFrom: string, v: { truckUnit: string | null; coDriver: string | null; payTag: string | null }) => {
      await tx.insert(dispatchRosterAssignments).values({
        id: newId('dra'),
        companyId: actor.companyId,
        rosterId,
        effectiveFrom,
        dispatcherId: team.dispatcherId,
        dispatcherName: team.dispatcherName,
        truckUnit: v.truckUnit,
        coDriver: v.coDriver,
        payTag: v.payTag,
        reason,
        by: actor.userId,
        at: now,
      });
      written.push({ effectiveFrom, dispatcherId: team.dispatcherId, truckUnit: v.truckUnit });
    };
    await put(
      from,
      valuesAtFrom ??
        (atFrom
          ? { truckUnit: atFrom.truckUnit ?? fallback.truckUnit, coDriver: atFrom.coDriver ?? null, payTag: atFrom.payTag ?? null }
          : fallback),
    );
    const later = [...new Set(history.map((h) => String(h.effectiveFrom).slice(0, 10)).filter((d) => d > from))].sort();
    for (const day of later) {
      const pin = assignmentInForce(history, day)!;
      if (pin.dispatcherId === team.dispatcherId) continue;
      await put(day, { truckUnit: pin.truckUnit ?? null, coDriver: pin.coDriver ?? null, payTag: pin.payTag ?? null });
    }
    return written;
  }

  /** The Monday a team change counts from: never before the row's first day on the board. */
  private async teamChangeFrom(tx: Db, companyId: string, rosterId: string, date: string): Promise<string> {
    const history = await tx
      .select({ effectiveFrom: dispatchRosterAssignments.effectiveFrom, at: dispatchRosterAssignments.at })
      .from(dispatchRosterAssignments)
      .where(and(eq(dispatchRosterAssignments.companyId, companyId), eq(dispatchRosterAssignments.rosterId, rosterId)));
    const first = onBoardFrom(history);
    return first && date < first ? first : date;
  }

  private resolve(
    r: RosterRecord,
    file:
      | {
          driverNumber: string;
          firstName: string;
          lastName: string;
          phone: string;
          driverType: string;
          status: string;
          dispatcherId: string;
          dispatcherName: string;
          cdlExpiresOn: string | Date;
          medicalCardExpiresOn: string | Date | null;
          truckUnit: string | null;
        }
      | undefined,
  ): ResolvedRow | null {
    if (r.driverId && !file) return null; // a driver file that is gone takes its row with it
    if (file && file.status === 'terminated' && !r.unassignedAt) return null;
    return {
      id: r.id,
      driverId: r.driverId,
      name: r.name || (file ? `${file.firstName} ${file.lastName}`.trim() : ''),
      coDriver: r.coDriver,
      sourceName: r.sourceName,
      payTag: r.payTag,
      truckUnit: r.truckUnit ?? file?.truckUnit ?? null,
      phone: r.phone || file?.phone || '',
      // "No dispatcher" is the board's own decision: it never falls back to the driver file's team.
      dispatcherId: isNoDispatcher(r.dispatcherId) ? '' : r.dispatcherId || file?.dispatcherId || '',
      dispatcherName: isNoDispatcher(r.dispatcherId) ? '' : r.dispatcherName || file?.dispatcherName || '',
      comment: r.comment,
      unassignedAt: iso(r.unassignedAt),
      unassignedFrom: r.unassignedFrom ? String(r.unassignedFrom) : null,
      unassignedReason: r.unassignedReason,
      truckConflict: false,
      version: r.version,
      driverNumber: file?.driverNumber ?? '',
      driverType: file?.driverType ?? 'roster',
      cdlExpiresOn: file ? String(file.cdlExpiresOn) : null,
      medicalCardExpiresOn: file ? String(file.medicalCardExpiresOn) : null,
    };
  }

  /** The assignment in force on a date for each row: the latest dated on or before it. */
  async assignmentsOn(companyId: string, date: string): Promise<Map<string, AssignmentRecord>> {
    const out = new Map<string, AssignmentRecord>();
    for (const [rosterId, h] of await this.histories(companyId)) {
      const pin = assignmentInForce(h.history, date);
      if (pin) out.set(rosterId, pin);
    }
    return out;
  }

  // ------------------------------------------------------------------------------ writes

  private manageOrThrow(principal: Principal): void {
    if (!hasPermission(principal, 'dispatch.manage')) throw forbidden('Changing the roster takes dispatch.manage');
  }

  async add(principal: Principal, input: AddRosterRowInput): Promise<RosterRow> {
    this.manageOrThrow(principal);
    const now = this.clock();
    const today = companyToday(principal, now);
    const id = input.driverId ?? newId('dbr');
    if (input.driverId) {
      const [file] = await this.db
        .select({ id: drivers.id })
        .from(drivers)
        .where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, input.driverId)))
        .limit(1);
      if (!file) throw notFound('That driver file is not in this company');
      const [existing] = await this.db
        .select({ id: dispatchRoster.id })
        .from(dispatchRoster)
        .where(and(eq(dispatchRoster.companyId, principal.companyId), eq(dispatchRoster.driverId, input.driverId)))
        .limit(1);
      if (existing) throw conflict('That driver already has a board row');
    }
    const row: typeof dispatchRoster.$inferInsert = {
      id,
      companyId: principal.companyId,
      driverId: input.driverId ?? null,
      name: input.name,
      coDriver: input.coDriver ?? null,
      payTag: input.payTag ?? null,
      truckUnit: cleanTruck(input.truckUnit),
      phone: input.phone ?? '',
      dispatcherId: input.dispatcherId,
      dispatcherName: input.dispatcherName,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.transaction(async (tx) => {
      await tx.insert(dispatchRoster).values(row);
      await tx.insert(dispatchRosterAssignments).values({
        id: newId('dra'),
        companyId: principal.companyId,
        rosterId: id,
        effectiveFrom: today,
        dispatcherId: input.dispatcherId,
        dispatcherName: input.dispatcherName,
        truckUnit: row.truckUnit ?? null,
        coDriver: row.coDriver ?? null,
        payTag: row.payTag ?? null,
        by: principal.userId,
        at: now,
      });
      await audit(tx, principal, now, 'roster', id, 'add', null, row);
    });
    return (await this.rows(principal.companyId)).find((r) => r.id === id)!;
  }

  /**
   * Drivers who are not on the boards today (owner, 2026-10-26): driver files that have no board
   * row, and board rows removed from the boards. Terminated drivers are left out; archived driver
   * files without a row too (they come back from the Drivers page).
   */
  async offBoard(principal: Principal): Promise<OffBoardDriver[]> {
    this.manageOrThrow(principal);
    const companyId = principal.companyId;
    const rows = await this.rows(companyId);
    const files = await this.db
      .select({
        id: drivers.id,
        driverNumber: drivers.driverNumber,
        firstName: drivers.firstName,
        lastName: drivers.lastName,
        phone: drivers.phone,
        status: drivers.status,
        archivedAt: drivers.archivedAt,
        truckUnit: trucks.unitNumber,
      })
      .from(drivers)
      .leftJoin(trucks, eq(trucks.id, drivers.currentTruckId))
      .where(eq(drivers.companyId, companyId));
    const partners = await this.partnerNames(companyId);
    const linked = new Set(rows.map((r) => r.driverId).filter((x): x is string => Boolean(x)));
    // A file whose row is gone from `rows` (its own row resolved away) still counts as linked.
    const anyRow = await this.db
      .select({ driverId: dispatchRoster.driverId })
      .from(dispatchRoster)
      .where(eq(dispatchRoster.companyId, companyId));
    for (const r of anyRow) if (r.driverId) linked.add(r.driverId);
    const byFile = new Map(files.map((f) => [f.id, f]));
    const out: OffBoardDriver[] = [];
    for (const f of files) {
      if (linked.has(f.id) || f.status === 'terminated' || f.archivedAt) continue;
      out.push({
        kind: 'file',
        driverId: f.id,
        rosterId: null,
        version: null,
        name: `${f.firstName} ${f.lastName}`.trim(),
        driverNumber: f.driverNumber,
        truckUnit: f.truckUnit ?? null,
        phone: f.phone ?? '',
        coDriver: partners.get(f.id) ?? null,
        dispatcherId: '',
        dispatcherName: '',
        removedFrom: null,
        removedReason: null,
      });
    }
    for (const r of rows) {
      if (!r.unassignedAt) continue;
      const file = r.driverId ? byFile.get(r.driverId) : undefined;
      if (file?.status === 'terminated') continue;
      out.push({
        kind: 'removed',
        driverId: r.driverId,
        rosterId: r.id,
        version: r.version,
        name: r.name,
        driverNumber: r.driverNumber,
        truckUnit: r.truckUnit,
        phone: r.phone,
        coDriver: r.coDriver,
        dispatcherId: r.dispatcherId,
        dispatcherName: r.dispatcherName,
        removedFrom: r.unassignedFrom,
        removedReason: r.unassignedReason,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Each paired driver's partner name, from the open driver teams. */
  private async partnerNames(companyId: string): Promise<Map<string, string>> {
    const pairs = await this.db
      .select({ driverId: driverTeams.driverId, firstName: drivers.firstName, lastName: drivers.lastName })
      .from(driverTeams)
      .innerJoin(drivers, and(eq(drivers.id, driverTeams.partnerId), eq(drivers.companyId, companyId)))
      .where(and(eq(driverTeams.companyId, companyId), isNull(driverTeams.endedOn)));
    return new Map(pairs.map((p) => [p.driverId, `${p.firstName} ${p.lastName}`.trim()]));
  }

  /**
   * Assign a driver to a dispatcher (owner, 2026-10-26) - the board's Add driver and the driver
   * profile's Assign dispatcher. The driver's board row is found by its id, then by the driver
   * file, then by an unlinked row with the same name (linked to the file, never duplicated); a
   * driver with none gets one, dated from the chosen week's Monday so earlier weeks never show
   * him. A removed row is put back on the boards (Restore), and a row with another team moves the
   * way Edit driver moves it - reason required, version checked, dated from the chosen week.
   */
  async assignToTeam(principal: Principal, input: AssignDriverToTeamInput): Promise<RosterRow> {
    this.manageOrThrow(principal);
    const companyId = principal.companyId;
    if (isNoDispatcher(input.dispatcherId)) throw unprocessable('Use Unassign to take a driver off his dispatcher');
    const now = this.clock();
    const today = companyToday(principal, now);
    const monday = weekStartMonday(input.fromWeek ?? today);
    if (monday > weekStartMonday(today)) throw unprocessable('A move to a dispatcher counts from this week or an earlier one');

    let record: RosterRecord | undefined;
    if (input.rosterId) {
      [record] = await this.db
        .select()
        .from(dispatchRoster)
        .where(and(eq(dispatchRoster.companyId, companyId), eq(dispatchRoster.id, input.rosterId)))
        .limit(1);
      if (!record) throw notFound('No such board row');
      if (input.driverId && record.driverId && record.driverId !== input.driverId) throw unprocessable('That board row belongs to another driver');
    }
    let file: { id: string; firstName: string; lastName: string; phone: string; status: string; archivedAt: Date | null; truckUnit: string | null } | undefined;
    const driverId = input.driverId ?? record?.driverId ?? null;
    if (driverId) {
      [file] = await this.db
        .select({
          id: drivers.id,
          firstName: drivers.firstName,
          lastName: drivers.lastName,
          phone: drivers.phone,
          status: drivers.status,
          archivedAt: drivers.archivedAt,
          truckUnit: trucks.unitNumber,
        })
        .from(drivers)
        .leftJoin(trucks, eq(trucks.id, drivers.currentTruckId))
        .where(and(eq(drivers.companyId, companyId), eq(drivers.id, driverId)))
        .limit(1);
      if (!file) throw notFound('That driver file is not in this company');
      if (file.status === 'terminated') throw unprocessable('A terminated driver cannot be put on the board');
    }
    const fileName = file ? `${file.firstName} ${file.lastName}`.trim() : '';
    let linkedNow = false;
    if (!record && file) {
      [record] = await this.db
        .select()
        .from(dispatchRoster)
        .where(and(eq(dispatchRoster.companyId, companyId), eq(dispatchRoster.driverId, file.id)))
        .limit(1);
      if (!record) {
        // No duplicate: a board row the sheet ran under the same name becomes this driver's row.
        const wanted = normalizeName(fileName);
        const unlinked = (
          await this.db
            .select()
            .from(dispatchRoster)
            .where(and(eq(dispatchRoster.companyId, companyId), isNull(dispatchRoster.driverId)))
        ).filter((r) => wanted && normalizeName((r.name.split('//')[0] ?? r.name)) === wanted);
        if (unlinked.length > 1)
          throw conflict(`${unlinked.length} board rows are called ${fileName}. Link the right one to the driver file under Match drivers first.`);
        if (unlinked.length === 1) {
          const row = unlinked[0]!;
          await this.db.transaction(async (tx) => {
            const [written] = await tx
              .update(dispatchRoster)
              .set({ driverId: file!.id, updatedAt: now, version: row.version + 1 })
              .where(and(eq(dispatchRoster.companyId, companyId), eq(dispatchRoster.id, row.id), eq(dispatchRoster.version, row.version)))
              .returning({ id: dispatchRoster.id });
            if (!written) throw conflict('This row was changed by someone else. Reload and try again.');
            await audit(tx, principal, now, 'roster', row.id, 'link-on-assign', { driverId: null }, { driverId: file!.id });
          });
          record = { ...row, driverId: file.id, version: row.version + 1 };
          linkedNow = true;
        }
      }
    }

    if (!record) {
      if (!file) throw notFound('No such board row');
      if (file.archivedAt) throw unprocessable(`${fileName} is archived. Bring the driver file back on the Drivers page first.`);
      // The row takes the driver's id, as every driver file's row does - unless that id is taken.
      const [taken] = await this.db.select({ id: dispatchRoster.id }).from(dispatchRoster).where(eq(dispatchRoster.id, file.id)).limit(1);
      const id = taken ? newId('dbr') : file.id;
      const partners = await this.partnerNames(companyId);
      const row: typeof dispatchRoster.$inferInsert = {
        id,
        companyId,
        driverId: file.id,
        name: fileName,
        coDriver: partners.get(file.id) ?? null,
        phone: file.phone ?? '',
        dispatcherId: input.dispatcherId,
        dispatcherName: input.dispatcherName,
        createdAt: now,
        updatedAt: now,
      };
      const first = {
        id: newId('dra'),
        companyId,
        rosterId: id,
        // On the board from the chosen week's Monday: earlier weeks never show him.
        effectiveFrom: monday,
        dispatcherId: input.dispatcherId,
        dispatcherName: input.dispatcherName,
        truckUnit: file.truckUnit ?? null,
        coDriver: row.coDriver ?? null,
        payTag: null,
        reason: null,
        by: principal.userId,
        at: now,
      };
      await this.db.transaction(async (tx) => {
        await tx.insert(dispatchRoster).values(row);
        await tx.insert(dispatchRosterAssignments).values(first);
        await audit(tx, principal, now, 'roster', id, 'add-on-assign', null, { ...row, fromWeek: monday });
      });
      return this.rowOrThrow(companyId, id);
    }

    // An existing row is written only against the version the screen saw.
    if (!linkedNow) {
      if (input.expectedVersion === undefined)
        throw conflict(`${record.name || fileName} already has a board row. Reload and try again.`, { currentVersion: record.version });
      if (record.version !== input.expectedVersion)
        throw conflict('This row was changed by someone else. Reload and try again.', { currentVersion: record.version });
    }
    let version = record.version;
    if (record.unassignedAt) version = (await this.restore(principal, record.id, version)).version;
    const current = await this.rowOrThrow(companyId, record.id);
    if (current.dispatcherId === input.dispatcherId) return current;
    return this.update(principal, record.id, {
      dispatcherId: input.dispatcherId,
      dispatcherName: input.dispatcherName,
      reason: current.dispatcherId ? input.reason : undefined,
      fromWeek: monday,
      expectedVersion: version,
    });
  }

  /**
   * Dispatcher rotation (owner, 2026-10-16): who joined and left each dispatcher between two dates,
   * why, and the share of the starting team that left. Read from the assignment history and the
   * unassign records; nothing is stored for it.
   */
  async rotation(principal: Principal, from: string, to: string): Promise<DispatcherRotationReport> {
    this.manageOrThrow(principal);
    // Resolved first (it records changes made outside the board, which the history read must see).
    const resolved = await this.rows(principal.companyId);
    const roster = await this.db.select().from(dispatchRoster).where(eq(dispatchRoster.companyId, principal.companyId));
    const history = await this.db
      .select()
      .from(dispatchRosterAssignments)
      .where(eq(dispatchRosterAssignments.companyId, principal.companyId))
      .orderBy(asc(dispatchRosterAssignments.rosterId), asc(dispatchRosterAssignments.effectiveFrom), asc(dispatchRosterAssignments.at));
    const byRow = new Map<string, (typeof history)[number][]>();
    for (const h of history) byRow.set(h.rosterId, [...(byRow.get(h.rosterId) ?? []), h]);
    const dayBefore = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const rows = new Map<string, DispatcherRotationRow>();
    const rowFor = (id: string, name: string) => {
      let r = rows.get(id);
      if (!r) rows.set(id, (r = { dispatcherId: id, dispatcherName: name, atStart: 0, joined: 0, left: 0, atEnd: 0, rotationPct: null, events: [] }));
      return r;
    };
    // Dispatchers who had a truck in the period (owner, 2026-10-26: no truck, not on the boards).
    // A truck on the driver file counts for the row's current team, as on the boards.
    const withTruck = new Set<string>();
    const truckNow = new Set(resolved.filter((r) => r.truckUnit && r.truckUnit.trim()).map((r) => r.id));
    for (const row of roster) {
      // One segment per dispatcher the driver sat with, in order; a truck or pay change is not a move.
      const segs: { start: string; dispatcherId: string; dispatcherName: string; reason: string | null; by: string | null; truck: boolean }[] = [];
      for (const h of byRow.get(row.id) ?? []) {
        const last = segs[segs.length - 1];
        const truck = Boolean(h.truckUnit && h.truckUnit.trim());
        if (last && last.dispatcherId === h.dispatcherId) {
          last.truck ||= truck;
          continue;
        }
        if (last && last.start === h.effectiveFrom) segs.pop();
        segs.push({ start: h.effectiveFrom, dispatcherId: h.dispatcherId, dispatcherName: h.dispatcherName, reason: h.reason ?? null, by: h.by, truck });
      }
      if (segs.length === 0 && row.dispatcherId) {
        segs.push({ start: row.createdAt.toISOString().slice(0, 10), dispatcherId: row.dispatcherId, dispatcherName: row.dispatcherName ?? row.dispatcherId, reason: null, by: null, truck: Boolean(row.truckUnit && row.truckUnit.trim()) });
      }
      const offFrom = row.unassignedFrom ?? null;
      segs.forEach((seg, i) => {
        // Unassigned drivers is not a dispatcher: leaving to it is a 'left', sitting in it counts for no team.
        if (!seg.dispatcherId || isNoDispatcher(seg.dispatcherId)) return;
        const next = segs[i + 1] ?? null;
        const end = next?.start ?? offFrom; // first day no longer on this team
        const covers = (day: string) => seg.start <= day && (end === null || day < end);
        const r = rowFor(seg.dispatcherId, seg.dispatcherName);
        // The segment reaches into the period [from, to] and carried a truck at some point.
        const truck = seg.truck || (end === null && truckNow.has(row.id));
        if (truck && seg.start <= to && (end === null || end >= from)) withTruck.add(seg.dispatcherId);
        if (covers(dayBefore)) r.atStart += 1;
        if (covers(to)) r.atEnd += 1;
        if (seg.start >= from && seg.start <= to) {
          r.joined += 1;
          r.events.push({ at: seg.start, rosterId: row.id, driverId: row.driverId ?? null, driverName: row.name, kind: 'joined', otherDispatcher: segs[i - 1]?.dispatcherName ?? null, reason: seg.reason, by: null });
        }
        if (end !== null && end >= from && end <= to) {
          r.left += 1;
          r.events.push({ at: end, rosterId: row.id, driverId: row.driverId ?? null, driverName: row.name, kind: 'left', otherDispatcher: next?.dispatcherName ?? null, reason: next ? next.reason : (row.unassignedReason ?? null), by: null });
        }
      });
    }
    const out = [...rows.values()]
      .filter((r) => (r.atStart > 0 || r.atEnd > 0 || r.events.length > 0) && withTruck.has(r.dispatcherId))
      .map((r) => ({ ...r, rotationPct: r.atStart > 0 ? Math.round((r.left / r.atStart) * 1000) / 10 : null, events: r.events.sort((a, b) => b.at.localeCompare(a.at)) }));
    // Nicknames for teams linked to employees, and the board order (owner, 2026-10-26).
    const names = await loadTeamNames(this.db, principal.companyId);
    return { from, to, rows: out.sort(compareTeams(names)).map((r) => withTeamName(r, names)) };
  }

  async update(principal: Principal, id: string, input: UpdateRosterRowInput): Promise<RosterRow> {
    this.manageOrThrow(principal);
    const now = this.clock();
    const today = companyToday(principal, now);
    const [existing] = await this.db
      .select()
      .from(dispatchRoster)
      .where(and(eq(dispatchRoster.companyId, principal.companyId), eq(dispatchRoster.id, id)))
      .limit(1);
    if (!existing) throw notFound('No such board row');
    if (existing.version !== input.expectedVersion)
      throw conflict('This row was changed by someone else. Reload and try again.', { currentVersion: existing.version });
    const before = (await this.rows(principal.companyId)).find((r) => r.id === id)!;
    const patch: Partial<typeof dispatchRoster.$inferInsert> = { updatedAt: now, version: existing.version + 1 };
    if (input.name !== undefined) patch.name = input.name;
    if (input.coDriver !== undefined) patch.coDriver = input.coDriver;
    if (input.payTag !== undefined) patch.payTag = input.payTag;
    if (input.truckUnit !== undefined) patch.truckUnit = cleanTruck(input.truckUnit);
    if (input.phone !== undefined) patch.phone = input.phone;
    if (input.comment !== undefined) patch.comment = input.comment;
    // The team the row is in today: '' for Unassigned drivers (never the hidden "no dispatcher" id).
    const teamChanged = input.dispatcherId !== undefined && input.dispatcherId !== before.dispatcherId;
    let teamFrom = today;
    if (input.dispatcherId !== undefined) {
      if (!input.dispatcherName) throw unprocessable('A team needs its dispatcher name');
      if (isNoDispatcher(input.dispatcherId)) throw unprocessable('Use Unassign to take a driver off his dispatcher');
      // Leaving a dispatcher says why (owner, 2026-10-16): the rotation report reads it.
      if (before.dispatcherId && teamChanged && !input.reason) {
        throw unprocessable(`Say why the driver leaves ${before.dispatcherName}`);
      }
      if (teamChanged && input.fromWeek) {
        teamFrom = weekStartMonday(input.fromWeek);
        if (teamFrom > weekStartMonday(today)) throw unprocessable('A move to a dispatcher counts from this week or an earlier one');
      }
      patch.dispatcherId = input.dispatcherId;
      patch.dispatcherName = input.dispatcherName;
    }
    await this.db.transaction(async (tx) => {
      // A row that has no history yet gets its first assignment (where it sat until now) before the
      // move is written, so the move counts from today and every earlier week keeps the old team.
      await this.completeHistory(tx, principal.companyId, [id], now);
      const [written] = await tx
        .update(dispatchRoster)
        .set(patch)
        .where(and(eq(dispatchRoster.companyId, principal.companyId), eq(dispatchRoster.id, id), eq(dispatchRoster.version, existing.version)))
        .returning({ id: dispatchRoster.id });
      if (!written) throw conflict('This row was changed by someone else. Reload and try again.');
      const after = { ...existing, ...patch };
      // The row's team after the save, as stored: a row in "no dispatcher" stays there.
      const dispatcherId = teamChanged ? input.dispatcherId! : isNoDispatcher(existing.dispatcherId) ? NO_DISPATCHER_ID : before.dispatcherId;
      const dispatcherName = teamChanged ? input.dispatcherName! : isNoDispatcher(existing.dispatcherId) ? NO_DISPATCHER_NAME : before.dispatcherName;
      const truckUnit = after.truckUnit ?? before.truckUnit;
      const details = { truckUnit, coDriver: after.coDriver ?? null, payTag: after.payTag ?? null };
      const detailsMoved = truckUnit !== before.truckUnit || details.coDriver !== before.coDriver || details.payTag !== before.payTag;
      let from: string | null = null;
      if (teamChanged) {
        // The move counts from `teamFrom` and nothing dated later puts him back (owner, 2026-10-26).
        from = await this.teamChangeFrom(tx, principal.companyId, id, teamFrom);
        await this.writeTeamFrom(
          tx,
          principal,
          id,
          from,
          { dispatcherId, dispatcherName },
          input.reason ?? null,
          now,
          details,
          from === today ? details : undefined,
        );
      }
      // A truck, co-driver or pay tag change counts from today, as before; one saved with a team move
      // dated today is already on that move.
      if (detailsMoved && from !== today)
        await tx.insert(dispatchRosterAssignments).values({
          id: newId('dra'),
          companyId: principal.companyId,
          rosterId: id,
          effectiveFrom: today,
          dispatcherId,
          dispatcherName,
          ...details,
          reason: null,
          by: principal.userId,
          at: now,
        });
      await audit(tx, principal, now, 'roster', id, 'update', before, { ...before, ...input, expectedVersion: undefined });
    });
    return (await this.rows(principal.companyId)).find((r) => r.id === id)!;
  }

  /**
   * Unassign (owner, 2026-10-26): from the Monday (US Eastern) of `fromWeek` on the driver has no
   * dispatcher and sits in Unassigned drivers on the Daily board, the Unassigned drivers page and
   * the Weekly board; every earlier week keeps him under his old team, with his data. A week that
   * has begun moves the board row now; a later week is written ahead and takes effect when it
   * comes. Version-checked and audited. Picking a team again (Edit driver) moves him back.
   */
  async unassign(principal: Principal, id: string, input: UnassignRosterRowInput): Promise<RosterRow> {
    this.manageOrThrow(principal);
    const now = this.clock();
    const today = this.today(now);
    const from = weekStartMonday(input.fromWeek);
    // Reading the row first lets the board record anything it noticed before this write is checked.
    const before = await this.rowOrThrow(principal.companyId, id);
    const [existing] = await this.db
      .select()
      .from(dispatchRoster)
      .where(and(eq(dispatchRoster.companyId, principal.companyId), eq(dispatchRoster.id, id)))
      .limit(1);
    if (!existing) throw notFound('No such board row');
    if (existing.version !== input.expectedVersion)
      throw conflict('This row was changed by someone else. Reload and try again.', { currentVersion: existing.version });
    if (existing.unassignedAt) throw unprocessable('This driver is off the boards. Restore him first.');
    const takesEffectNow = from <= today;
    await this.db.transaction(async (tx) => {
      await this.completeHistory(tx, principal.companyId, [id], now);
      const effectiveFrom = await this.teamChangeFrom(tx, principal.companyId, id, from);
      const history = await tx
        .select()
        .from(dispatchRosterAssignments)
        .where(and(eq(dispatchRosterAssignments.companyId, principal.companyId), eq(dispatchRosterAssignments.rosterId, id)));
      const teamThen = teamInForce(assignmentInForce(history, effectiveFrom), before);
      const teamLater = history
        .filter((h) => String(h.effectiveFrom).slice(0, 10) > effectiveFrom)
        .some((h) => teamInForce(h, before).dispatcherId !== '');
      if (teamThen.dispatcherId === '' && !teamLater && (!takesEffectNow || before.dispatcherId === ''))
        throw unprocessable(`${before.name} is already in Unassigned drivers from that week`);
      // An earlier assignment that names no team showed the row's CURRENT team on the boards. Once
      // the row has none, it would show Unassigned there too - so each such date is pinned to the
      // team it showed (insert only; the newest write on a date is the one in force).
      const pinned: string[] = [];
      if (before.dispatcherId) {
        const earlier = [...new Set(history.map((h) => String(h.effectiveFrom).slice(0, 10)).filter((d) => d < effectiveFrom))].sort();
        for (const day of earlier) {
          const pin = assignmentInForce(history, day)!;
          if (pin.dispatcherId) continue;
          await tx.insert(dispatchRosterAssignments).values({
            id: newId('dra'),
            companyId: principal.companyId,
            rosterId: id,
            effectiveFrom: day,
            dispatcherId: before.dispatcherId,
            dispatcherName: before.dispatcherName,
            truckUnit: pin.truckUnit ?? null,
            coDriver: pin.coDriver ?? null,
            payTag: pin.payTag ?? null,
            reason: null,
            by: principal.userId,
            at: now,
          });
          pinned.push(day);
        }
      }
      const written = await this.writeTeamFrom(
        tx,
        principal,
        id,
        effectiveFrom,
        { dispatcherId: NO_DISPATCHER_ID, dispatcherName: NO_DISPATCHER_NAME },
        input.reason,
        now,
        { truckUnit: before.truckUnit, coDriver: before.coDriver, payTag: before.payTag },
      );
      const [saved] = await tx
        .update(dispatchRoster)
        .set({
          ...(takesEffectNow ? { dispatcherId: NO_DISPATCHER_ID, dispatcherName: NO_DISPATCHER_NAME } : {}),
          updatedAt: now,
          version: existing.version + 1,
        })
        .where(and(eq(dispatchRoster.companyId, principal.companyId), eq(dispatchRoster.id, id), eq(dispatchRoster.version, existing.version)))
        .returning({ id: dispatchRoster.id });
      if (!saved) throw conflict('This row was changed by someone else. Reload and try again.');
      await audit(
        tx,
        principal,
        now,
        'roster',
        id,
        'unassign',
        { dispatcherId: before.dispatcherId || null, dispatcherName: before.dispatcherName || null, teamThatWeek: teamThen.dispatcherName || null },
        {
          dispatcherId: null,
          fromWeek: effectiveFrom,
          reason: input.reason,
          takesEffect: takesEffectNow ? 'now' : `on ${effectiveFrom}`,
          assignments: written.map((w) => ({ effectiveFrom: w.effectiveFrom, truckUnit: w.truckUnit })),
          earlierDatesKeptWithTeam: pinned,
        },
      );
    });
    return this.rowOrThrow(principal.companyId, id);
  }

  /**
   * Remove from board (the old Unassign): the row leaves every board from `fromWeek` on - hidden,
   * kept and reversible with Restore. For a row that should not be on the boards at all (a board
   * row nobody drives any more); a driver who only lost his dispatcher is Unassigned instead.
   */
  async removeFromBoard(principal: Principal, id: string, input: UnassignRosterRowInput): Promise<RosterRow> {
    this.manageOrThrow(principal);
    const now = this.clock();
    const [existing] = await this.db
      .select()
      .from(dispatchRoster)
      .where(and(eq(dispatchRoster.companyId, principal.companyId), eq(dispatchRoster.id, id)))
      .limit(1);
    if (!existing) throw notFound('No such board row');
    if (existing.version !== input.expectedVersion)
      throw conflict('This row was changed by someone else. Reload and try again.', { currentVersion: existing.version });
    await this.db.transaction(async (tx) => {
      const [saved] = await tx
        .update(dispatchRoster)
        .set({
          unassignedAt: now,
          unassignedFrom: input.fromWeek,
          unassignedReason: input.reason,
          updatedAt: now,
          version: existing.version + 1,
        })
        .where(and(eq(dispatchRoster.companyId, principal.companyId), eq(dispatchRoster.id, id), eq(dispatchRoster.version, existing.version)))
        .returning({ id: dispatchRoster.id });
      if (!saved) throw conflict('This row was changed by someone else. Reload and try again.');
      await audit(tx, principal, now, 'roster', id, 'remove-from-board', { unassignedAt: iso(existing.unassignedAt) }, { fromWeek: input.fromWeek, reason: input.reason });
    });
    return (await this.rows(principal.companyId)).find((r) => r.id === id)!;
  }

  async restore(principal: Principal, id: string, expectedVersion: number): Promise<RosterRow> {
    this.manageOrThrow(principal);
    const now = this.clock();
    const [existing] = await this.db
      .select()
      .from(dispatchRoster)
      .where(and(eq(dispatchRoster.companyId, principal.companyId), eq(dispatchRoster.id, id)))
      .limit(1);
    if (!existing) throw notFound('No such board row');
    if (existing.version !== expectedVersion)
      throw conflict('This row was changed by someone else. Reload and try again.', { currentVersion: existing.version });
    await this.db.transaction(async (tx) => {
      await tx
        .update(dispatchRoster)
        .set({ unassignedAt: null, unassignedFrom: null, unassignedReason: null, updatedAt: now, version: existing.version + 1 })
        .where(eq(dispatchRoster.id, id));
      await audit(tx, principal, now, 'roster', id, 'restore', { unassignedFrom: existing.unassignedFrom }, null);
      // A row the driver archive took off brings its driver file back with it, so the driver is
      // never on the boards while hidden from the Drivers page.
      if (existing.driverId)
        await unarchiveForRosterRestore(
          tx,
          principal.companyId,
          existing.driverId,
          existing.unassignedReason,
          { userId: principal.userId, userName: principal.userName ?? principal.userId, actorType: 'user' },
          now,
        );
    });
    return (await this.rows(principal.companyId)).find((r) => r.id === id)!;
  }

  /**
   * The sheet's roster, as CSV. Keyed by team + source name, so a second run changes nothing;
   * an existing row keeps its identity, its cells and its history. Trucks shared by two rows are
   * reported, never resolved. Dry run parses and reports without writing.
   */
  async importCsv(principal: Principal, csv: string, dryRun: boolean): Promise<RosterImportReport> {
    this.manageOrThrow(principal);
    const parsed = parseRosterCsv(csv);
    const now = this.clock();
    const today = companyToday(principal, now);
    const report: RosterImportReport = {
      parsed: parsed.rows.length,
      teams: parsed.teams.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      conflicts: parsed.conflicts,
      skipped: parsed.skipped,
      dryRun,
    };
    const existing = await this.db.select().from(dispatchRoster).where(eq(dispatchRoster.companyId, principal.companyId));
    const byKey = new Map(existing.filter((r) => r.importKey).map((r) => [r.importKey!, r]));
    const teamIds = new Map<string, string>();
    for (const r of existing) if (r.dispatcherName && r.dispatcherId) teamIds.set(r.dispatcherName.toLowerCase(), r.dispatcherId);
    const teamId = (team: string) => {
      const key = team.toLowerCase();
      let id = teamIds.get(key);
      if (!id) {
        id = `team_${key.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
        teamIds.set(key, id);
      }
      return id;
    };
    const work = async (tx: Parameters<Parameters<typeof this.db.transaction>[0]>[0] | null) => {
      for (const row of parsed.rows) {
        const found = byKey.get(row.importKey);
        const wanted = {
          name: row.name,
          coDriver: row.coDriver,
          sourceName: row.sourceName,
          payTag: row.payTag,
          truckUnit: row.truckUnit,
          dispatcherId: teamId(row.team),
          dispatcherName: row.team,
        };
        if (!found) {
          report.created += 1;
          if (!tx) continue;
          const id = row.importKey;
          await tx.insert(dispatchRoster).values({
            id,
            companyId: principal.companyId,
            driverId: null,
            importKey: row.importKey,
            phone: row.phone ?? '',
            ...wanted,
            createdAt: now,
            updatedAt: now,
          });
          await tx.insert(dispatchRosterAssignments).values({
            id: newId('dra'),
            companyId: principal.companyId,
            rosterId: id,
            effectiveFrom: today,
            dispatcherId: wanted.dispatcherId,
            dispatcherName: wanted.dispatcherName,
            truckUnit: wanted.truckUnit,
            coDriver: wanted.coDriver,
            payTag: wanted.payTag,
            by: principal.userId,
            at: now,
          });
          await audit(tx, principal, now, 'roster', id, 'import', null, wanted);
          continue;
        }
        const same =
          found.name === wanted.name &&
          (found.coDriver ?? null) === wanted.coDriver &&
          (found.payTag ?? null) === wanted.payTag &&
          (found.truckUnit ?? null) === wanted.truckUnit &&
          found.dispatcherName === wanted.dispatcherName &&
          (found.sourceName ?? null) === wanted.sourceName;
        if (same) {
          report.unchanged += 1;
          continue;
        }
        report.updated += 1;
        if (!tx) continue;
        await this.completeHistory(tx, principal.companyId, [found.id], now);
        await tx
          .update(dispatchRoster)
          .set({ ...wanted, updatedAt: now, version: found.version + 1 })
          .where(eq(dispatchRoster.id, found.id));
        const moved =
          found.dispatcherName !== wanted.dispatcherName ||
          (found.truckUnit ?? null) !== wanted.truckUnit ||
          (found.coDriver ?? null) !== wanted.coDriver ||
          (found.payTag ?? null) !== wanted.payTag;
        if (moved)
          await tx.insert(dispatchRosterAssignments).values({
            id: newId('dra'),
            companyId: principal.companyId,
            rosterId: found.id,
            effectiveFrom: today,
            dispatcherId: wanted.dispatcherId,
            dispatcherName: wanted.dispatcherName,
            truckUnit: wanted.truckUnit,
            coDriver: wanted.coDriver,
            payTag: wanted.payTag,
            by: principal.userId,
            at: now,
          });
        await audit(tx, principal, now, 'roster', found.id, 'import', found, wanted);
      }
    };
    if (dryRun) await work(null);
    else await this.db.transaction((tx) => work(tx));
    return report;
  }

  async rowOrThrow(companyId: string, id: string): Promise<ResolvedRow> {
    const row = (await this.rows(companyId)).find((r) => r.id === id);
    if (!row) throw notFound('No such board row');
    return row;
  }

  /** Assignment history for one row, newest first. */
  async history(companyId: string, rosterId: string) {
    return this.db
      .select()
      .from(dispatchRosterAssignments)
      .where(and(eq(dispatchRosterAssignments.companyId, companyId), eq(dispatchRosterAssignments.rosterId, rosterId)))
      .orderBy(desc(dispatchRosterAssignments.effectiveFrom), asc(dispatchRosterAssignments.at));
  }
}
