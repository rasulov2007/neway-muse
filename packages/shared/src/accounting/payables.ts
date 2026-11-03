/**
 * What the carrier owes, and when.
 *
 * The mirror of receivables, with one asymmetry that matters: a receivable is aged to chase it, a
 * payable is aged to *schedule* it. So the buckets here run forward as well as back — due today,
 * due this week — because the useful question about a bill is usually "when must this leave the
 * account", not "how late am I".
 */

import { daysPastDue } from './receivables.js';

/** `bills.status` in docs/DATABASE.md §3.13, plus the approval step the brief asks for. */
export const BILL_STATUSES = [
  'draft',
  'pending_approval',
  'open',
  'scheduled',
  'partially_paid',
  'paid',
  'disputed',
  'void',
] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

/** Statuses that still represent money owed. */
const OUTSTANDING = new Set<BillStatus>([
  'open',
  'scheduled',
  'partially_paid',
  'pending_approval',
  'disputed',
]);

export function isOutstanding(status: BillStatus): boolean {
  return OUTSTANDING.has(status);
}

export const BILL_FLOW: Record<BillStatus, readonly BillStatus[]> = {
  draft: ['pending_approval', 'void'],
  pending_approval: ['open', 'draft', 'disputed'],
  open: ['scheduled', 'partially_paid', 'paid', 'disputed', 'void'],
  scheduled: ['partially_paid', 'paid', 'open', 'disputed'],
  partially_paid: ['paid', 'disputed'],
  paid: [],
  disputed: ['open', 'void'],
  void: [],
};

export function billTransitions(status: BillStatus): readonly BillStatus[] {
  return BILL_FLOW[status] ?? [];
}

export interface AgeablePayable {
  id: string;
  vendorId: string;
  vendorName: string;
  dueOn: string | null;
  amount: number;
  paid: number;
  balance: number;
  status: BillStatus;
  approvedAt: string | null;
}

export interface PayablesSummary {
  total: number;
  dueToday: number;
  dueThisWeek: number;
  overdue: number;
  pendingApproval: number;
  scheduled: number;
  disputed: number;
  /** Bill ids behind each figure, so a tile and the list it opens cannot disagree. */
  ids: {
    overdue: string[];
    dueToday: string[];
    dueThisWeek: string[];
    pendingApproval: string[];
    scheduled: string[];
    disputed: string[];
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function summarizePayables(
  bills: readonly AgeablePayable[],
  today: string,
): PayablesSummary {
  const summary: PayablesSummary = {
    total: 0,
    dueToday: 0,
    dueThisWeek: 0,
    overdue: 0,
    pendingApproval: 0,
    scheduled: 0,
    disputed: 0,
    ids: {
      overdue: [],
      dueToday: [],
      dueThisWeek: [],
      pendingApproval: [],
      scheduled: [],
      disputed: [],
    },
  };

  for (const bill of bills) {
    if (!isOutstanding(bill.status) || bill.balance <= 0) continue;
    summary.total += bill.balance;

    const late = daysPastDue(bill.dueOn, today);
    if (late !== null) {
      if (late > 0) {
        summary.overdue += bill.balance;
        summary.ids.overdue.push(bill.id);
      } else if (late === 0) {
        summary.dueToday += bill.balance;
        summary.ids.dueToday.push(bill.id);
      } else if (late >= -7) {
        summary.dueThisWeek += bill.balance;
        summary.ids.dueThisWeek.push(bill.id);
      }
    }

    if (bill.status === 'pending_approval') {
      summary.pendingApproval += bill.balance;
      summary.ids.pendingApproval.push(bill.id);
    }
    if (bill.status === 'scheduled') {
      summary.scheduled += bill.balance;
      summary.ids.scheduled.push(bill.id);
    }
    if (bill.status === 'disputed') {
      summary.disputed += bill.balance;
      summary.ids.disputed.push(bill.id);
    }
  }

  summary.total = round(summary.total);
  summary.dueToday = round(summary.dueToday);
  summary.dueThisWeek = round(summary.dueThisWeek);
  summary.overdue = round(summary.overdue);
  summary.pendingApproval = round(summary.pendingApproval);
  summary.scheduled = round(summary.scheduled);
  summary.disputed = round(summary.disputed);
  return summary;
}

export interface VendorPayable {
  vendorId: string;
  vendorName: string;
  openBills: number;
  outstanding: number;
  overdue: number;
  /** The soonest unpaid due date, so a scheduler knows what is next. */
  nextDueOn: string | null;
}

export function payablesByVendor(bills: readonly AgeablePayable[], today: string): VendorPayable[] {
  const byVendor = new Map<string, AgeablePayable[]>();
  for (const bill of bills) {
    if (!isOutstanding(bill.status) || bill.balance <= 0) continue;
    const bucket = byVendor.get(bill.vendorId);
    if (bucket) bucket.push(bill);
    else byVendor.set(bill.vendorId, [bill]);
  }

  return [...byVendor.entries()]
    .map(([vendorId, rows]) => {
      const overdue = rows
        .filter((b) => (daysPastDue(b.dueOn, today) ?? -1) > 0)
        .reduce((sum, b) => sum + b.balance, 0);
      const dates = rows
        .map((b) => b.dueOn)
        .filter((d): d is string => d !== null)
        .sort();
      return {
        vendorId,
        vendorName: rows[0]?.vendorName ?? vendorId,
        openBills: rows.length,
        outstanding: round(rows.reduce((sum, b) => sum + b.balance, 0)),
        overdue: round(overdue),
        nextDueOn: dates[0] ?? null,
      };
    })
    .sort((a, b) => b.overdue - a.overdue || b.outstanding - a.outstanding);
}

// ---------------------------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------------------------

export interface ApprovalPolicy {
  /** Bills at or above this amount need a second pair of eyes. */
  reviewAbove: number;
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = { reviewAbove: 2_500 };

export interface ApprovalCheck {
  required: boolean;
  reason: string | null;
}

/**
 * Whether a bill needs approval before it can be scheduled for payment.
 *
 * A threshold, not a ceremony: below it, a bill from a known vendor for a routine category is
 * approved on posting. Above it, or from a vendor with nothing on record, somebody looks.
 */
export function needsApproval(
  bill: { amount: number; vendorId: string | null },
  knownVendorIds: ReadonlySet<string>,
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
): ApprovalCheck {
  if (!bill.vendorId || !knownVendorIds.has(bill.vendorId)) {
    return { required: true, reason: 'The vendor is not on file' };
  }
  if (bill.amount >= policy.reviewAbove) {
    return {
      required: true,
      reason: `Over the $${policy.reviewAbove.toLocaleString('en-US')} review threshold`,
    };
  }
  return { required: false, reason: null };
}
