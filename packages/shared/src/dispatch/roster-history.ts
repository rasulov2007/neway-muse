import { addDays, weekStartMonday } from './periods.js';

/**
 * Where a board row sat on a date, and whether it was on the board at all (owner, 2026-10-01).
 *
 *  1. Unassigned from a week: gone from that week on, still in every earlier week.
 *  2. Moved to another dispatcher: earlier weeks stay with the old team, the move counts from its
 *     own week on. The weekly board reads the assignment in force on the week's Sunday, so a move
 *     dated any day of a week counts for that whole week; the daily board reads its own day.
 *  3. A new driver is on the board from the day they were added (the weekly board: from that
 *     week), never in earlier weeks.
 *
 * "On the board from" is the earliest dated assignment row. A row with no assignment history at
 * all (rows from before the history was complete) is on every date, which is how it behaved
 * before - the history backfill gives every such row a first assignment.
 */

/** The fields of an assignment row these rules read. `at` breaks ties between rows of one date. */
export interface DatedAssignment {
  effectiveFrom: string;
  at: Date | string;
}

function atMs(at: Date | string): number {
  return at instanceof Date ? at.getTime() : Date.parse(at);
}

/** The assignment in force on `date`: the latest dated on or before it (latest saved wins a tie). */
export function assignmentInForce<T extends DatedAssignment>(history: readonly T[], date: string): T | null {
  let best: T | null = null;
  for (const a of history) {
    const from = String(a.effectiveFrom).slice(0, 10);
    if (from > date) continue;
    if (!best) {
      best = a;
      continue;
    }
    const bestFrom = String(best.effectiveFrom).slice(0, 10);
    if (from > bestFrom || (from === bestFrom && atMs(a.at) > atMs(best.at))) best = a;
  }
  return best;
}

/** The first date a row is on the board: its earliest assignment, or null when it has no history. */
export function onBoardFrom(history: readonly DatedAssignment[]): string | null {
  let first: string | null = null;
  for (const a of history) {
    const from = String(a.effectiveFrom).slice(0, 10);
    if (first === null || from < first) first = from;
  }
  return first;
}

export type BoardPresence = 'on' | 'not-yet' | 'unassigned';

/**
 * Is a row on the daily board for `day`? Not yet before its first assignment; unassigned from the
 * week it was unassigned from. `hasDataThatDay` keeps a row that somebody typed into on that day,
 * so a late-dated history can never hide work already on the board.
 */
export function presenceOnDay(
  row: { onBoardFrom: string | null; unassignedFrom: string | null },
  day: string,
  hasDataThatDay = false,
): BoardPresence {
  if (row.unassignedFrom && row.unassignedFrom <= day) return 'unassigned';
  if (row.onBoardFrom && row.onBoardFrom > day && !hasDataThatDay) return 'not-yet';
  return 'on';
}

/**
 * Is a row on the weekly board for the week starting `weekStart` (a Monday)? On when its first
 * assignment falls on or before the week's Sunday; unassigned from the week it was unassigned
 * from. `hasDataThatWeek` (a typed cell, a fill, an override, a flag or a load's money in the
 * week) keeps the row, so existing earnings never vanish.
 */
export function presenceInWeek(
  row: { onBoardFrom: string | null; unassignedFrom: string | null },
  weekStart: string,
  hasDataThatWeek = false,
): BoardPresence {
  const monday = weekStartMonday(weekStart);
  if (row.unassignedFrom && row.unassignedFrom <= monday) return 'unassigned';
  if (row.onBoardFrom && row.onBoardFrom > addDays(monday, 6) && !hasDataThatWeek) return 'not-yet';
  return 'on';
}

/**
 * A dispatcher is on the boards only once a truck is assigned to them (owner, 2026-10-26): a team
 * none of whose rows carries a truck on the day / in the week shown is left out, rows and band.
 * `hasWork` keeps a team that holds work anyway - money or a load in a past week, a live load on
 * the day - so a truck taken away later never hides earnings already made. Rows without a team
 * (Unassigned drivers, `dispatcherId` '') are never dropped here. Inside a team that has a truck,
 * a driver row without one stays as before.
 */
export function withoutTrucklessTeams<T extends { dispatcherId: string; truckUnit: string | null }>(
  rows: readonly T[],
  hasWork: (row: T) => boolean = () => false,
): T[] {
  const shown = new Set<string>();
  for (const r of rows) {
    if (!r.dispatcherId) continue;
    if ((r.truckUnit ?? '').trim() !== '' || hasWork(r)) shown.add(r.dispatcherId);
  }
  return rows.filter((r) => !r.dispatcherId || shown.has(r.dispatcherId));
}

/** One row of the history backfill's plan. */
export interface HistoryBackfillRow {
  rosterId: string;
  /** The Monday of the row's earliest known date, which the first assignment is dated from. */
  effectiveFrom: string;
  /** "no-history": the row had none. "starts-late": its history began after its first data. */
  reason: 'no-history' | 'starts-late';
  dispatcherId: string;
  dispatcherName: string;
  truckUnit: string | null;
  coDriver: string | null;
  payTag: string | null;
}

export interface HistoryBackfillInput {
  rows: {
    id: string;
    /** The roster row's created date (company day), always known. */
    createdOn: string;
    /** Current team, truck, co-driver and pay tag, resolved against the driver file. */
    dispatcherId: string;
    dispatcherName: string;
    truckUnit: string | null;
    coDriver: string | null;
    payTag: string | null;
  }[];
  /** Existing assignment rows. */
  history: (DatedAssignment & {
    rosterId: string;
    dispatcherId: string;
    dispatcherName: string;
    truckUnit: string | null;
    coDriver: string | null;
    payTag: string | null;
  })[];
  /** The earliest date each row has anything on the boards (cells, fills, overrides, flags, loads). */
  firstData: Map<string, string>;
}

/**
 * The backfill plan: every row whose history does not reach back to its earliest known date gets
 * ONE first assignment dated the Monday of that date. A row with no history takes its current
 * team (nobody moved it yet, so current is what it always was on the board); a row whose history
 * starts late takes the values of its earliest history row (where it sat when history began).
 * A row whose history already reaches its earliest date is left alone, so a second run plans
 * nothing.
 */
export function planHistoryBackfill(input: HistoryBackfillInput): HistoryBackfillRow[] {
  const byRow = new Map<string, HistoryBackfillInput['history']>();
  for (const h of input.history) {
    const list = byRow.get(h.rosterId) ?? [];
    list.push(h);
    byRow.set(h.rosterId, list);
  }
  const out: HistoryBackfillRow[] = [];
  for (const r of input.rows) {
    const data = input.firstData.get(r.id);
    const known = data && data < r.createdOn ? data : r.createdOn;
    const effectiveFrom = weekStartMonday(known);
    const history = byRow.get(r.id) ?? [];
    const first = onBoardFrom(history);
    if (first === null) {
      out.push({
        rosterId: r.id,
        effectiveFrom,
        reason: 'no-history',
        dispatcherId: r.dispatcherId,
        dispatcherName: r.dispatcherName,
        truckUnit: r.truckUnit,
        coDriver: r.coDriver,
        payTag: r.payTag,
      });
      continue;
    }
    // History that starts on or before the row's first data already covers every week with data.
    if (first <= known) continue;
    // The first row saved on the first date: where the row sat when its history began.
    const earliest = history
      .filter((h) => String(h.effectiveFrom).slice(0, 10) === first)
      .sort((a, b) => atMs(a.at) - atMs(b.at))[0]!;
    out.push({
      rosterId: r.id,
      effectiveFrom,
      reason: 'starts-late',
      dispatcherId: earliest.dispatcherId,
      dispatcherName: earliest.dispatcherName,
      truckUnit: earliest.truckUnit,
      coDriver: earliest.coDriver,
      payTag: earliest.payTag,
    });
  }
  return out;
}
