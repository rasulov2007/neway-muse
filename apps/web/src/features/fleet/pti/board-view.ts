import { queuesFor, type PtiBoardRow, type PtiDefect } from '@neway/shared';
import { bySeverityThenAge, rowAction, type RowAction } from './board-model';

/**
 * The board as the owner drew it (2026-09-22): four counters that are also the filters, one
 * group per counter, and one button per row. Pure, so the counters and the rows cannot drift.
 */

export const BOARD_KINDS = ['miss', 'rev', 'open', 'clean'] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];

export const BOARD_KIND_LABEL: Record<BoardKind, { title: string; group: string; sub: string }> = {
  miss: { title: 'Nothing sent', group: 'Nothing sent', sub: 'Chase the driver' },
  rev: { title: 'To review', group: 'To review', sub: 'Sent, nobody looked' },
  open: { title: 'Open issues', group: 'Open issues', sub: '' },
  clean: { title: 'Clean', group: 'Clean this week', sub: 'Done this week' },
};

/** The one group a row belongs to: issues first, then the video that is owed, then the review. */
export function boardKind(row: PtiBoardRow): BoardKind {
  const queues = queuesFor(row);
  if (queues.includes('defects') || queues.includes('verify')) return 'open';
  if (queues.includes('chase')) return 'miss';
  if (queues.includes('review')) return 'rev';
  return 'clean';
}

/**
 * The sections of the table: the four counters, with Clean split into the units still waiting
 * for this week's video and the ones already reviewed clean (owner, 2026-09-22: a line between
 * them). The Clean counter counts both.
 */
export type GroupKind = BoardKind | 'awaiting';
export const GROUP_ORDER: GroupKind[] = ['open', 'miss', 'rev', 'awaiting', 'clean'];
export const GROUP_LABEL: Record<GroupKind, string> = {
  open: 'Open issues',
  miss: 'Nothing sent',
  rev: 'To review',
  awaiting: 'Awaiting video',
  clean: 'Clean this week',
};

export function groupOf(row: PtiBoardRow): GroupKind {
  const kind = boardKind(row);
  if (
    kind === 'clean' &&
    row.inspection.reviewState !== 'reviewed' &&
    (row.inspection.receiptStatus === 'awaiting' || row.inspection.receiptStatus === 'not_due')
  )
    return 'awaiting';
  return kind;
}

/** Which sections a counter shows: Clean shows both of its halves. */
export function groupInFilter(group: GroupKind, active: BoardKind | 'all'): boolean {
  if (active === 'all') return true;
  if (active === 'clean') return group === 'clean' || group === 'awaiting';
  return group === active;
}

export function kindCounts(rows: readonly PtiBoardRow[]): Record<BoardKind, number> {
  const counts: Record<BoardKind, number> = { miss: 0, rev: 0, open: 0, clean: 0 };
  for (const row of rows) counts[boardKind(row)] += 1;
  return counts;
}

/** Trucks a defect is holding: an out-of-service risk that is not yet proposed as fixed. */
export function holdingCount(rows: readonly PtiBoardRow[]): number {
  return rows.filter((r) => onHold(r)).length;
}

export function onHold(row: PtiBoardRow): boolean {
  return row.openDefects.some(
    (d) => d.severity === 'oos_risk' && d.state !== 'fixed_pending_verify',
  );
}

export type Pill = { tone: 'danger' | 'warning' | 'info' | 'success' | 'neutral'; label: string };

/** The status pill, one per row. */
export function statusPill(row: PtiBoardRow): Pill {
  const { inspection } = row;
  if (onHold(row)) return { tone: 'danger', label: 'On hold' };
  const open = row.openDefects.filter((d) => d.state !== 'fixed_pending_verify').length;
  if (open > 0) return { tone: 'warning', label: `${open} issue${open === 1 ? '' : 's'}` };
  if (row.openDefects.some((d) => d.state === 'fixed_pending_verify'))
    return { tone: 'info', label: 'Repaired' };
  if (inspection.receiptStatus === 'exempt_in_shop') return { tone: 'neutral', label: 'In shop' };
  if (inspection.receiptStatus === 'not_due') return { tone: 'neutral', label: 'Not due' };
  if (inspection.receiptStatus === 'missing') return { tone: 'danger', label: 'Missing' };
  if (inspection.reviewState === 'reviewed')
    return inspection.reviewResult === 'issues_found'
      ? { tone: 'warning', label: 'Issue found' }
      : { tone: 'success', label: 'No issues' };
  if (inspection.receivedAt !== null) return { tone: 'info', label: 'Not reviewed' };
  return { tone: 'neutral', label: 'Awaiting' };
}

export const SEVERITY_WORD: Record<PtiDefect['severity'], string> = {
  oos_risk: 'Urgent',
  replace_now: 'Now',
  replace_soon: 'Soon',
  monitor: 'Watch',
};

/** "Urgent · open 20 days · RO-2031": the defect's second line. */
export function defectMeta(defect: PtiDefect, today: string): string {
  const days = Math.max(
    0,
    Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(defect.createdAt)) / 86_400_000),
  );
  const state =
    defect.state === 'fixed_pending_verify'
      ? `repaired · not yet confirmed`
      : defect.state === 'in_repair'
        ? 'in repair'
        : defect.state === 'scheduled'
          ? 'scheduled'
          : `open ${days} ${days === 1 ? 'day' : 'days'}`;
  return [SEVERITY_WORD[defect.severity], state, defect.workOrderNumber ?? null]
    .filter(Boolean)
    .join(' · ');
}

/** The defects a row lists, worst first. */
export function listedDefects(row: PtiBoardRow): PtiDefect[] {
  return [...row.openDefects].sort(bySeverityThenAge);
}

/** The row's button, in the words the owner wrote on it. */
export function rowButton(row: PtiBoardRow): RowAction & { look: 'primary' | 'danger' | 'plain' } {
  const action = rowAction(row);
  switch (action.kind) {
    case 'review':
      return { ...action, label: 'Review', look: 'primary' };
    case 'chase':
      return { ...action, label: 'Chase driver', look: 'danger' };
    case 'assign':
      return { ...action, label: 'Open', look: onHold(row) ? 'danger' : 'plain' };
    case 'verify':
      return { ...action, label: 'Confirm & clear', look: 'primary' };
    case 'open_ro':
      return { ...action, look: 'plain' };
    case 'open_unit':
      return { ...action, label: boardKind(row) === 'clean' ? 'View' : 'Open', look: 'plain' };
  }
}

/** One driver's PTI for the week: sent, still to come, or missed. */
export type DriverPtiState = 'sent' | 'waiting' | 'missed';
export interface DriverPtiRow {
  driverId: string;
  driverName: string;
  unitNumber: string;
  unitId: string;
  state: DriverPtiState;
}

/**
 * How many drivers sent this week's PTI (owner, 2026-10-12). Counted per driver, not per truck:
 * a unit with nobody on it is not a driver who failed to send, and a truck in the shop is exempt.
 * A driver on two units counts once, with the best of their states.
 */
export function driverPti(rows: readonly PtiBoardRow[]): { sent: DriverPtiRow[]; waiting: DriverPtiRow[]; missed: DriverPtiRow[]; total: number } {
  const rank: Record<DriverPtiState, number> = { sent: 0, waiting: 1, missed: 2 };
  const byDriver = new Map<string, DriverPtiRow>();
  for (const row of rows) {
    const i = row.inspection;
    if (!i.driverId || i.receiptStatus === 'exempt_in_shop' || row.inShop) continue;
    const state: DriverPtiState = i.receiptStatus === 'received' || i.receiptStatus === 'late' ? 'sent' : i.receiptStatus === 'missing' ? 'missed' : 'waiting';
    const prev = byDriver.get(i.driverId);
    if (prev && rank[prev.state] <= rank[state]) continue;
    byDriver.set(i.driverId, { driverId: i.driverId, driverName: i.driverName ?? 'Unnamed driver', unitNumber: i.unitNumber, unitId: i.unitId, state });
  }
  const all = [...byDriver.values()].sort((a, b) => a.driverName.localeCompare(b.driverName));
  return { sent: all.filter((d) => d.state === 'sent'), waiting: all.filter((d) => d.state === 'waiting'), missed: all.filter((d) => d.state === 'missed'), total: all.length };
}
