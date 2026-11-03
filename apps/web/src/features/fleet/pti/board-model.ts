import {
  PTI_DEFECT_SEVERITY_RANK,
  queuesFor,
  type PtiBoardRow,
  type PtiDefect,
  type PtiDefectSeverity,
  type PtiQueue,
} from '@neway/shared';

/**
 * The board's reading of a row (§7): which triage group it sits in, what stripe it carries,
 * what its one action is, and what is due next. Pure, so the counts and the rows cannot drift -
 * both come from the same functions over the same server data.
 */

export const TRIAGE_GROUPS = ['oos', 'defects', 'verify', 'missing', 'review', 'clean'] as const;
export type TriageGroup = (typeof TRIAGE_GROUPS)[number];

export const TRIAGE_GROUP_LABEL: Record<TriageGroup, string> = {
  oos: 'Out-of-service risk',
  defects: 'Open defects',
  verify: 'Fixed — awaiting verify',
  missing: 'Missing video',
  review: 'Awaiting review',
  clean: 'Clean',
};

/** The first group that claims the row, in the order the brief sets. */
export function triageGroup(row: PtiBoardRow): TriageGroup {
  const queues = queuesFor(row);
  if (row.openDefects.some((d) => d.severity === 'oos_risk' && d.state !== 'fixed_pending_verify'))
    return 'oos';
  if (queues.includes('defects')) return 'defects';
  if (queues.includes('verify')) return 'verify';
  if (queues.includes('chase')) return 'missing';
  if (queues.includes('review')) return 'review';
  return 'clean';
}

export type Stripe = 'red' | 'amber' | 'blue' | null;

/** 3 px on the left: red = oos_risk/replace_now, amber = replace_soon, blue = needs a human, none = clean. */
export function stripe(row: PtiBoardRow): Stripe {
  const severities = row.openDefects.map((d) => d.severity);
  if (severities.some((s) => s === 'oos_risk' || s === 'replace_now')) return 'red';
  if (severities.some((s) => s === 'replace_soon')) return 'amber';
  const queues = queuesFor(row);
  if (queues.length > 0 || row.openDefects.some((d) => !d.ownerId)) return 'blue';
  return null;
}

export type RowActionKind = 'review' | 'chase' | 'assign' | 'verify' | 'open_ro' | 'open_unit';

export interface RowAction {
  kind: RowActionKind;
  label: string;
  /** The defect the action is about, when it is about one. */
  defect: PtiDefect | null;
}

/**
 * One button per row, named for the job (§7.2). The week's video comes first - it is the thing
 * that goes stale - then the defects in the order they need a person.
 */
export function rowAction(row: PtiBoardRow): RowAction {
  const queues = queuesFor(row);
  if (queues.includes('review')) return { kind: 'review', label: 'Review ▸', defect: null };
  if (queues.includes('chase')) return { kind: 'chase', label: 'Chase driver', defect: null };
  const open = [...row.openDefects].sort(bySeverityThenAge);
  const unowned = open.find((d) => !d.ownerId && d.state !== 'fixed_pending_verify');
  if (unowned) return { kind: 'assign', label: 'Assign owner', defect: unowned };
  const toVerify = open.find((d) => d.state === 'fixed_pending_verify');
  if (toVerify) return { kind: 'verify', label: 'Verify & clear', defect: toVerify };
  const withOrder = open.find((d) => d.workOrderNumber);
  if (withOrder)
    return { kind: 'open_ro', label: `Open ${withOrder.workOrderNumber}`, defect: withOrder };
  return { kind: 'open_unit', label: 'Open unit', defect: null };
}

export interface NextAction {
  ownerName: string | null;
  what: string;
  /** ISO datetime the action is due, when there is one. */
  dueAt: string | null;
  /** True when nobody owns it or nothing is recorded: rendered in red, not implied by a counter. */
  unowned: boolean;
}

/** Owner + what is due + when, from the worst open defect, or from the week's video. */
export function nextAction(row: PtiBoardRow): NextAction | null {
  const open = [...row.openDefects].sort(bySeverityThenAge);
  const worst = open[0];
  if (worst) {
    const what =
      worst.state === 'fixed_pending_verify'
        ? `Verify ${worst.defectNumber}`
        : worst.state === 'in_repair'
          ? `In repair${worst.workOrderNumber ? ` · ${worst.workOrderNumber}` : ''}`
          : worst.state === 'scheduled'
            ? `Scheduled${worst.workOrderNumber ? ` · ${worst.workOrderNumber}` : ''}`
            : worst.ownerId
              ? `Fix ${worst.defectNumber} · ${worst.componentName}`
              : 'No action recorded';
    return { ownerName: worst.ownerName, what, dueAt: worst.dueAt, unowned: !worst.ownerId };
  }
  const queues = queuesFor(row);
  if (queues.includes('chase'))
    return {
      ownerName: row.inspection.dispatcherName,
      what: 'Chase the driver for the video',
      dueAt: null,
      unowned: !row.inspection.dispatcherName,
    };
  if (queues.includes('review'))
    return { ownerName: null, what: 'Review the video', dueAt: null, unowned: false };
  return null;
}

/** Worst severity first, then the oldest. */
export function bySeverityThenAge(a: PtiDefect, b: PtiDefect): number {
  const rank = PTI_DEFECT_SEVERITY_RANK[b.severity] - PTI_DEFECT_SEVERITY_RANK[a.severity];
  if (rank !== 0) return rank;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/** Risk, then age, then unit: a 5-day-old oos_risk defect sorts above a clean video from yesterday. */
export function sortRows(rows: readonly PtiBoardRow[]): PtiBoardRow[] {
  return [...rows].sort((a, b) => {
    const group = TRIAGE_GROUPS.indexOf(triageGroup(a)) - TRIAGE_GROUPS.indexOf(triageGroup(b));
    if (group !== 0) return group;
    if (b.ageDays !== a.ageDays) return b.ageDays - a.ageDays;
    return a.inspection.unitNumber.localeCompare(b.inspection.unitNumber, undefined, {
      numeric: true,
    });
  });
}

export interface BoardFilters {
  queue: PtiQueue | '';
  severity: PtiDefectSeverity | '';
  component: string;
  dispatcher: string;
  /** An account id, or `nobody`. */
  owner: string;
  /** Minimum age in days, as a string, or empty. */
  age: string;
}

export const EMPTY_FILTERS: BoardFilters = {
  queue: '',
  severity: '',
  component: '',
  dispatcher: '',
  owner: '',
  age: '',
};

/** Search covers unit, driver, defect text and RO number (§7.2). */
export function matchesSearch(row: PtiBoardRow, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  // A bare number is a unit (owner, 2026-10-27: "0016" found 0041 through its defect DEF-0016).
  // Defects and ROs are still found by their prefix, e.g. "DEF-0016".
  if (/^\d+$/.test(needle)) return row.inspection.unitNumber.toLowerCase().includes(needle);
  const haystack = [
    row.inspection.unitNumber,
    row.inspection.driverName ?? '',
    ...row.openDefects.flatMap((d) => [
      d.defectNumber,
      d.componentName,
      d.description,
      d.workOrderNumber ?? '',
    ]),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

export function matchesFilters(row: PtiBoardRow, filters: BoardFilters): boolean {
  if (filters.queue && !queuesFor(row).includes(filters.queue)) return false;
  if (filters.severity && !row.openDefects.some((d) => d.severity === filters.severity))
    return false;
  if (filters.component && !row.openDefects.some((d) => d.component === filters.component))
    return false;
  if (filters.dispatcher && row.inspection.dispatcherId !== filters.dispatcher) return false;
  if (filters.owner === 'nobody' && !row.openDefects.some((d) => !d.ownerId)) return false;
  if (
    filters.owner &&
    filters.owner !== 'nobody' &&
    !row.openDefects.some((d) => d.ownerId === filters.owner)
  )
    return false;
  if (filters.age && row.ageDays < Number(filters.age)) return false;
  return true;
}

/** The driver type flags, as words (§7.2). */
export function driverTypeLabel(type: string | null): string | null {
  switch ((type ?? '').toLowerCase()) {
    case 'c':
    case 'company':
      return 'Company driver';
    case 'lo':
    case 'lease_operator':
    case 'lease':
      return 'Lease-operator';
    case 'oo':
    case 'owner_operator':
    case 'owner':
      return 'Owner-operator';
    default:
      return type;
  }
}

// ---------------------------------------------------------------------------------------------
// The board as the owner drew it (2026-09-20): four segments, two groups, five cells.
// ---------------------------------------------------------------------------------------------

export const BOARD_SEGMENTS = ['all', 'needs_action', 'missing', 'pending'] as const;
export type BoardSegment = (typeof BOARD_SEGMENTS)[number];

export const BOARD_SEGMENT_LABEL: Record<BoardSegment, string> = {
  all: 'All trucks',
  needs_action: 'Needs action',
  missing: 'Missing',
  pending: 'Pending review',
};

/** A segment is a filter on the same rows; its count is the count of rows it shows. */
export function inSegment(row: PtiBoardRow, segment: BoardSegment): boolean {
  switch (segment) {
    case 'all':
      return true;
    case 'needs_action':
      return queuesFor(row).length > 0;
    case 'missing':
      return row.inspection.receiptStatus === 'missing' || row.inspection.receiptStatus === 'late';
    case 'pending':
      return row.inspection.receivedAt !== null && row.inspection.reviewState !== 'reviewed';
  }
}

export function segmentCounts(rows: readonly PtiBoardRow[]): Record<BoardSegment, number> {
  const counts: Record<BoardSegment, number> = { all: 0, needs_action: 0, missing: 0, pending: 0 };
  for (const row of rows)
    for (const segment of BOARD_SEGMENTS) if (inSegment(row, segment)) counts[segment] += 1;
  return counts;
}

export const BOARD_GROUPS = ['road', 'shop'] as const;
export type BoardGroup = (typeof BOARD_GROUPS)[number];

/** In the shop, the walk-around is not owed; everybody else is on the road or at home. */
export function boardGroup(row: PtiBoardRow): BoardGroup {
  return row.inShop || row.inspection.receiptStatus === 'exempt_in_shop' ? 'shop' : 'road';
}

export interface Finding {
  /** The component of the worst open defect, or what the week is waiting on. */
  title: string;
  /** What has been done about it - the last note, or "No action recorded". */
  note: string;
  tone: 'urgent' | 'muted' | 'plain';
}

/**
 * The "Finding" cell: the worst open defect and whether anybody has acted on it; otherwise
 * whether the truck owes a walk-around this week. A clean, reviewed week says nothing.
 */
export function findingOf(row: PtiBoardRow, weekStart: string): Finding | null {
  const worst = [...row.openDefects].sort(bySeverityThenAge)[0];
  if (worst) {
    const acted = [...worst.history].reverse().find((h) => h.note);
    return {
      title: worst.componentName,
      note:
        worst.state === 'fixed_pending_verify'
          ? 'Fixed — awaiting verify'
          : worst.workOrderNumber
            ? `Repair ${worst.workOrderNumber}`
            : (acted?.note ?? 'No action recorded'),
      tone:
        acted || worst.workOrderNumber || worst.state === 'fixed_pending_verify'
          ? 'plain'
          : 'urgent',
    };
  }
  const { inspection, latestReviewed } = row;
  if (
    inspection.reviewState !== 'reviewed' &&
    inspection.receivedAt === null &&
    inspection.receiptStatus !== 'exempt_in_shop' &&
    inspection.receiptStatus !== 'not_due'
  ) {
    return {
      title:
        latestReviewed && latestReviewed.weekStart !== weekStart
          ? 'Owes a fresh walk-around'
          : 'Owes a walk-around',
      note: '',
      tone: 'muted',
    };
  }
  return null;
}

/** "2d" - how long the oldest open defect has been open; nothing when there is none. */
export function openAgeLabel(row: PtiBoardRow): string | null {
  if (row.openDefects.length === 0) return null;
  return `${row.ageDays}d`;
}
