import { and, eq, inArray, min, sql } from 'drizzle-orm';
import {
  localParts,
  planHistoryBackfill,
  type HistoryBackfillRow,
  type StoredLoad,
} from '@neway/shared';
import type { Database } from '../../database/client';
import { dispatchBoardCells, dispatchBoardEdits, dispatchBoardFills } from '../../database/schema/dispatch-board';
import {
  dispatchRoster,
  dispatchRosterAssignments,
  dispatchWeekFlags,
  dispatchWeekOverrides,
} from '../../database/schema/dispatch-ops';
import { loads } from '../../database/schema/loads';
import { drivers, trucks } from '../../database/schema/roster';
import { audit, newId } from './ops.helpers';

/**
 * Completing the board roster's assignment history (owner, 2026-10-01).
 *
 * The weekly board reads the assignment in force for its week, and a row with no assignment
 * history falls back to its CURRENT team - so moving such a row today moved every past week with
 * it. This gives every row whose history does not reach back to its first data ONE first
 * assignment, dated the Monday of its earliest known date. Shared by the history script
 * (`scripts/backfill-roster-history.ts`) and by the roster service, which runs it for a row the
 * moment it is moved, so a move can never rewrite the past even before the script has run.
 */

/** Every clock in the product is US Eastern (owner, 2026-09-25). */
const ZONE = 'America/New_York';

/** A database or a transaction: both read and write the same way. */
export type Db = Pick<Database, 'select' | 'insert'>;

/** Who the audit names for a history row nobody typed. */
export interface HistoryActor {
  userId: string;
  userName: string;
}

function day(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function keepEarliest(out: Map<string, string>, id: string, date: string | null): void {
  if (!date) return;
  const had = out.get(id);
  if (!had || date < had) out.set(id, date);
}

/**
 * The earliest date each roster row has anything on the boards: a typed cell, an edit, a fill,
 * a week override or flag, or a load's pickup (the Eastern day the weekly board counts it on).
 */
export async function firstDataDates(db: Db, companyId: string, rosterIds?: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const only = rosterIds && rosterIds.length > 0 ? rosterIds : null;
  if (rosterIds && rosterIds.length === 0) return out;

  const byDay = [
    { table: dispatchBoardCells, driver: dispatchBoardCells.driverId, date: dispatchBoardCells.day, company: dispatchBoardCells.companyId },
    { table: dispatchBoardEdits, driver: dispatchBoardEdits.driverId, date: dispatchBoardEdits.day, company: dispatchBoardEdits.companyId },
    { table: dispatchBoardFills, driver: dispatchBoardFills.driverId, date: dispatchBoardFills.day, company: dispatchBoardFills.companyId },
    { table: dispatchWeekOverrides, driver: dispatchWeekOverrides.rosterId, date: dispatchWeekOverrides.weekStart, company: dispatchWeekOverrides.companyId },
    { table: dispatchWeekFlags, driver: dispatchWeekFlags.rosterId, date: dispatchWeekFlags.weekStart, company: dispatchWeekFlags.companyId },
  ] as const;
  for (const t of byDay) {
    const rows = await db
      .select({ id: t.driver, first: min(t.date) })
      .from(t.table)
      .where(only ? and(eq(t.company, companyId), inArray(t.driver, only)) : eq(t.company, companyId))
      .groupBy(t.driver);
    for (const r of rows) keepEarliest(out, r.id, day(r.first));
  }

  // Loads count on the row of the driver file they name.
  const linked = await db
    .select({ id: dispatchRoster.id, driverId: dispatchRoster.driverId })
    .from(dispatchRoster)
    .where(
      only
        ? and(eq(dispatchRoster.companyId, companyId), inArray(dispatchRoster.id, only))
        : eq(dispatchRoster.companyId, companyId),
    );
  const rowOfDriver = new Map<string, string>();
  for (const r of linked) if (r.driverId) rowOfDriver.set(r.driverId, r.id);
  if (rowOfDriver.size > 0) {
    const records = await db
      .select({ driverId: loads.driverId, record: loads.record })
      .from(loads)
      .where(
        and(
          eq(loads.companyId, companyId),
          eq(loads.isDemo, false),
          sql`${loads.status} not in ('cancelled', 'tonu')`,
          inArray(loads.driverId, [...rowOfDriver.keys()]),
        ),
      );
    for (const l of records) {
      const rowId = l.driverId ? rowOfDriver.get(l.driverId) : undefined;
      if (!rowId) continue;
      const record = (typeof l.record === 'string' ? JSON.parse(l.record) : l.record) as StoredLoad;
      const pickup = record.stops?.[0]?.appointmentStartAt ?? (record['pickupAt'] as string | undefined) ?? '';
      keepEarliest(out, rowId, pickup ? (localParts(pickup, ZONE)?.date ?? null) : null);
    }
  }
  return out;
}

/** The plan for a company, or for some of its rows: which rows get a first assignment, dated when, saying what. */
export async function planRosterHistory(
  db: Db,
  companyId: string,
  rosterIds?: string[],
): Promise<{ plan: HistoryBackfillRow[]; rows: number; withHistory: number }> {
  if (rosterIds && rosterIds.length === 0) return { plan: [], rows: 0, withHistory: 0 };
  const rowFilter = rosterIds
    ? and(eq(dispatchRoster.companyId, companyId), inArray(dispatchRoster.id, rosterIds))
    : eq(dispatchRoster.companyId, companyId);
  // The row's team, truck, co-driver and pay tag as the board resolves them today (RosterService.resolve).
  const current = await db
    .select({
      id: dispatchRoster.id,
      createdOn: sql<string>`to_char(${dispatchRoster.createdAt} at time zone ${ZONE}, 'YYYY-MM-DD')`,
      dispatcherId: sql<string>`coalesce(nullif(${dispatchRoster.dispatcherId}, ''), ${drivers.dispatcherId}, '')`,
      dispatcherName: sql<string>`coalesce(nullif(${dispatchRoster.dispatcherName}, ''), ${drivers.dispatcherName}, '')`,
      truckUnit: sql<string | null>`coalesce(${dispatchRoster.truckUnit}, ${trucks.unitNumber})`,
      coDriver: dispatchRoster.coDriver,
      payTag: dispatchRoster.payTag,
    })
    .from(dispatchRoster)
    .leftJoin(drivers, and(eq(drivers.id, dispatchRoster.driverId), eq(drivers.companyId, companyId)))
    .leftJoin(trucks, eq(trucks.id, drivers.currentTruckId))
    .where(rowFilter);
  const ids = current.map((r) => r.id);
  if (ids.length === 0) return { plan: [], rows: 0, withHistory: 0 };
  const history = await db
    .select()
    .from(dispatchRosterAssignments)
    .where(
      rosterIds
        ? and(eq(dispatchRosterAssignments.companyId, companyId), inArray(dispatchRosterAssignments.rosterId, ids))
        : eq(dispatchRosterAssignments.companyId, companyId),
    );
  const firstData = await firstDataDates(db, companyId, rosterIds ? ids : undefined);
  const plan = planHistoryBackfill({
    rows: current.map((r) => ({
      id: r.id,
      createdOn: r.createdOn,
      dispatcherId: r.dispatcherId ?? '',
      dispatcherName: r.dispatcherName ?? '',
      truckUnit: r.truckUnit ?? null,
      coDriver: r.coDriver ?? null,
      payTag: r.payTag ?? null,
    })),
    history: history.map((h) => ({ ...h, effectiveFrom: String(h.effectiveFrom).slice(0, 10) })),
    firstData,
  });
  const withHistory = new Set(history.map((h) => h.rosterId)).size;
  return { plan, rows: ids.length, withHistory };
}

/** Writes a plan: one assignment row and one audit line per planned row. The caller passes its transaction. */
export async function applyRosterHistory(
  tx: Db,
  companyId: string,
  plan: HistoryBackfillRow[],
  actor: HistoryActor,
  now: Date,
  action = 'history-backfill',
): Promise<number> {
  for (const p of plan) {
    const row = {
      id: newId('dra'),
      companyId,
      rosterId: p.rosterId,
      effectiveFrom: p.effectiveFrom,
      dispatcherId: p.dispatcherId,
      dispatcherName: p.dispatcherName,
      truckUnit: p.truckUnit,
      coDriver: p.coDriver,
      payTag: p.payTag,
      by: actor.userId,
      // Saved before anything else on its date, so a move written in the same breath still wins.
      at: new Date(now.getTime() - 1),
    };
    await tx.insert(dispatchRosterAssignments).values(row);
    await audit(tx as Parameters<typeof audit>[0], { companyId, ...actor }, now, 'roster', p.rosterId, action, null, { ...row, reason: p.reason });
  }
  return plan.length;
}
