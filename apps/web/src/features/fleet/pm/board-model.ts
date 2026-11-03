import type { PmBoardRow, PmBoardSummary } from '@neway/shared';

/**
 * What the board does with the rows it was given: the view segments, the chips and the search.
 * Pure, so a test can run it; every count is a count of the rows a segment filters to, from the
 * same function the table uses, so a tile and the list cannot disagree.
 */
export const BOARD_VIEWS = ['all', 'overdue', 'due_soon', 'booked', 'no_reading'] as const;
export type BoardView = (typeof BOARD_VIEWS)[number];

export const BOARD_VIEW_LABEL: Record<BoardView, string> = {
  all: 'All',
  overdue: 'Overdue',
  due_soon: 'Due soon',
  booked: 'Booked',
  no_reading: 'No reading',
};

export interface BoardFilters {
  view: BoardView;
  group: string;
  responsible: string;
  shop: string;
}

export const EMPTY_FILTERS: BoardFilters = { view: 'all', group: '', responsible: '', shop: '' };

export function isOverdue(row: Pick<PmBoardRow, 'dueStatus'>): boolean {
  return row.dueStatus === 'overdue' || row.dueStatus === 'overdue_at_least';
}

export function inView(row: PmBoardRow, view: BoardView): boolean {
  switch (view) {
    case 'all':
      return true;
    case 'overdue':
      return isOverdue(row);
    case 'due_soon':
      return row.dueStatus === 'due_soon';
    case 'booked':
      return row.appointment !== null;
    case 'no_reading':
      return row.dueStatus === 'no_reading';
  }
}

export function matchesFilters(row: PmBoardRow, filters: BoardFilters): boolean {
  if (!inView(row, filters.view)) return false;
  if (filters.group && (row.groupName ?? '') !== filters.group) return false;
  if (filters.responsible && (row.appointment?.responsibleUserId ?? '') !== filters.responsible)
    return false;
  if (
    filters.shop &&
    (row.appointment?.vendorId ?? row.lastService?.vendorName ?? '') !== filters.shop &&
    (row.lastService?.vendorName ?? '') !== filters.shop
  )
    return false;
  return true;
}

export function matchesSearch(row: PmBoardRow, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return [
    row.unitNumber,
    row.driverName,
    row.appointment?.vendorName,
    row.lastService?.vendorName,
    row.location?.city,
    row.groupName,
    row.lessorName,
  ]
    .filter((v): v is string => Boolean(v))
    .some((v) => v.toLowerCase().includes(q));
}

export function viewCounts(rows: readonly PmBoardRow[]): Record<BoardView, number> {
  const counts: Record<BoardView, number> = {
    all: 0,
    overdue: 0,
    due_soon: 0,
    booked: 0,
    no_reading: 0,
  };
  for (const row of rows) for (const view of BOARD_VIEWS) if (inView(row, view)) counts[view] += 1;
  return counts;
}

/** The lead line of the "Oil change due" cell (mockup A, note 2 and 5). */
export function dueText(
  row: Pick<PmBoardRow, 'dueStatus' | 'milesRemaining' | 'milesOverAtReading'>,
): string {
  const n = (v: number) => v.toLocaleString('en-US');
  switch (row.dueStatus) {
    case 'overdue':
      return `${n(Math.max(0, -(row.milesRemaining ?? 0)))} mi over`;
    case 'overdue_at_least':
      return `≥ ${n(row.milesOverAtReading ?? 0)} mi over`;
    case 'due_soon':
    case 'ok':
      return row.milesRemaining === null ? '' : `${n(row.milesRemaining)} mi left`;
    case 'no_reading':
      return "can't tell";
    case 'no_baseline':
    case 'no_interval':
      return '';
  }
}

/** How full the interval bar is, 0–100. */
export function intervalPct(
  row: Pick<PmBoardRow, 'dueStatus' | 'milesSinceService' | 'intervalMiles'>,
): number {
  if (row.dueStatus === 'no_reading' || row.milesSinceService === null || !row.intervalMiles)
    return 0;
  return Math.min(100, Math.round((row.milesSinceService / row.intervalMiles) * 100));
}

/**
 * For a truck whose last reading is too old to judge (`no_reading`): the miles driven since the
 * change as of that last reading, a floor rather than a verdict (owner, 2026-10-05).
 */
export function milesAtLastReading(
  row: Pick<PmBoardRow, 'dueStatus' | 'readingOdometer' | 'lastServiceOdometer'>,
): number | null {
  if (row.dueStatus !== 'no_reading') return null;
  if (row.readingOdometer === null || row.lastServiceOdometer === null) return null;
  const miles = row.readingOdometer - row.lastServiceOdometer;
  return miles >= 0 ? miles : null;
}

export type RowFamily ='urgent' | 'warning' | 'done' | 'neutral';

export function rowFamily(row: Pick<PmBoardRow, 'dueStatus'>): RowFamily {
  if (isOverdue(row)) return 'urgent';
  if (row.dueStatus === 'due_soon') return 'warning';
  if (row.dueStatus === 'ok') return 'done';
  return 'neutral';
}

/** The KPI strip's six cells from the summary, worded as the mockup words them. */
export function kpiCells(summary: PmBoardSummary, seesCost: boolean) {
  const n = (v: number) => v.toLocaleString('en-US');
  const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
  const pct = summary.onTime.done
    ? Math.round((summary.onTime.onTime / summary.onTime.done) * 100)
    : null;
  return {
    overdue: {
      value: summary.overdue,
      note: summary.overdue
        ? `worst ${n(summary.overdueWorstMiles ?? 0)} mi · ${n(summary.overdueTotalMiles)} mi past due in total`
        : 'nothing past its interval',
    },
    dueSoon: {
      value: summary.dueSoon,
      note: `≤ 2,500 mi or 14 days · ${summary.dueSoonThisWeek} this week`,
    },
    booked: {
      value: summary.booked,
      note: `${summary.bookedToday} today · ${summary.bookedAtOwnYard} at our yard · ${summary.bookedOverdue} overdue anyway`,
    },
    noReading: {
      value: summary.noReading,
      note: `${summary.noReadingStale} stale over 7 d · ${summary.noReadingNever} never reported`,
    },
    lease: {
      value: summary.leaseDue,
      note: summary.leaseNames.length
        ? `${summary.leaseNames.join(', ')} · PM covered, no shop cost`
        : 'PM covered by the lessor, no shop cost',
    },
    onTime: {
      value: pct === null ? '—' : `${pct}%`,
      small: summary.onTime.done
        ? `${summary.onTime.onTime} of ${summary.onTime.done}`
        : 'no completions yet',
      note:
        seesCost && summary.avgCost !== null && summary.avgCost !== undefined
          ? `avg ${money(summary.avgCost)} per oil change${summary.ownYardAvgCost !== null && summary.ownYardAvgCost !== undefined ? ` · ${money(summary.ownYardAvgCost)} at our own yard` : ''}`
          : 'completed inside the interval',
    },
  };
}

/** Systems for "other work on this invoice" (mockup C): the repair vocabulary, kept apart from the PM. */
export const OTHER_WORK_SYSTEMS: { value: string; label: string }[] = [
  { value: 'body_doors', label: 'Body & doors' },
  { value: 'brakes', label: 'Brakes' },
  { value: 'electrical', label: 'Electrical & lights' },
  { value: 'tires_wheels', label: 'Tires & wheels' },
  { value: 'engine', label: 'Engine' },
  { value: 'cooling', label: 'Cooling' },
  { value: 'aftertreatment', label: 'Exhaust / aftertreatment' },
  { value: 'hvac', label: 'HVAC' },
  { value: 'suspension', label: 'Suspension & steering' },
  { value: 'other', label: 'Other' },
];
