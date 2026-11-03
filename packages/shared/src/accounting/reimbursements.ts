import { z } from 'zod';

/**
 * Money a driver spent out of their own pocket, and getting it back to them.
 *
 * A reimbursement is not a record of its own. It is an expense the company already carries -
 * the same `acct_expenses` row, with the same receipt, the same load and truck, the same one
 * posting - marked as one the driver paid for. That is deliberate: a receipt, an expense, a
 * reimbursement and the settlement line that pays it are four views of one cost, and the way to
 * keep them honest is to link them, never to copy them.
 *
 * Two rules do the real work here:
 *
 *   Only what the driver actually funded is reimbursable. A $150 lumper paid on the company
 *   card owes the driver nothing; a $150 lumper the driver paid owes them $150; a $150 lumper
 *   where the company card covered $90 owes them $60. Split funding is stated, never assumed.
 *
 *   A reimbursement reaches exactly one statement. It is approved, included on a draft, and
 *   only becomes paid when that settlement is actually paid - not when it is approved, and not
 *   when it is put on a statement. A draft that is regenerated releases its items rather than
 *   stranding them.
 */

// ------------------------------------------------------------------ vocabulary

export const REIMBURSEMENT_CATEGORIES = ['lumper', 'scale', 'parking', 'repair_supplies', 'other'] as const;
export type ReimbursementCategory = (typeof REIMBURSEMENT_CATEGORIES)[number];

export const REIMBURSEMENT_CATEGORY_LABEL: Record<ReimbursementCategory, string> = {
  lumper: 'Lumper',
  scale: 'Scale',
  parking: 'Parking',
  repair_supplies: 'Repair and supplies',
  other: 'Other',
};

/** The expense account each reimbursement category posts to, in the existing chart. */
export const REIMBURSEMENT_ACCOUNT: Record<ReimbursementCategory, string> = {
  lumper: '5500',
  scale: '6900',
  parking: '6900',
  repair_supplies: '5300',
  other: '6900',
};

export const PAYMENT_SOURCES = ['driver_personal', 'company_card', 'efs_advance', 'other'] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

export const PAYMENT_SOURCE_LABEL: Record<PaymentSource, string> = {
  driver_personal: 'Driver personal funds',
  company_card: 'Company card',
  efs_advance: 'EFS / company advance',
  other: 'Other verified source',
};

/** Whether money from this source is the driver's own, and so owed back to them. */
export const SOURCE_IS_DRIVER_FUNDED: Record<PaymentSource, boolean> = {
  driver_personal: true,
  company_card: false,
  efs_advance: false,
  other: true,
};

export const REIMBURSEMENT_STATUSES = ['pending', 'approved', 'included', 'paid', 'rejected'] as const;
export type ReimbursementStatus = (typeof REIMBURSEMENT_STATUSES)[number];

export const REIMBURSEMENT_STATUS_LABEL: Record<ReimbursementStatus, string> = {
  pending: 'Pending review',
  approved: 'Approved',
  included: 'On a statement',
  paid: 'Paid',
  rejected: 'Rejected',
};

// ------------------------------------------------------------------ the record

/** The review block an expense carries when a driver funded some or all of it. */
export interface ReimbursementBlock {
  status: ReimbursementStatus;
  category: ReimbursementCategory;
  /** The whole receipt, in cents - what was spent, whoever paid it. */
  receiptCents: number;
  /** The part of it the driver funded: the only part that is ever reimbursed. */
  driverFundedCents: number;
  currency: string;
  paymentSource: PaymentSource;
  /** The driver who actually paid. On a team load this is one driver, never both. */
  payerDriverId: string;
  payerDriverName: string | null;
  /** An expense with no receipt needs someone to say so, and why. */
  missingReceipt: { reason: string; authorizedBy: string; authorizedAt: string } | null;
  note: string | null;
  submittedBy: string;
  submittedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectedReason: string | null;
  /** The statement carrying it, once it is on one; cleared if that draft is regenerated. */
  settlementId: string | null;
  settlementNumber: string | null;
  includedAt: string | null;
  paidAt: string | null;
  /** Filed by the driver from the driver app (mobile M3); absent = recorded by Accounting. */
  source?: 'driver_app';
  submittedByDriverId?: string;
  /** Where the driver was, as they gave it (text). */
  location?: string | null;
}

// ------------------------------------------------------------------ what is owed

/**
 * What the company owes the driver for one receipt.
 *
 * The driver-funded amount is the answer, and it is capped by the receipt: a statement can never
 * pay out more than was spent. A source that is not the driver's own money owes nothing at all,
 * however the amounts were typed - which is what stops a company-card expense from quietly
 * becoming a second payment to the driver.
 */
export function reimbursableCents(input: { receiptCents: number; driverFundedCents: number; paymentSource: PaymentSource }): number {
  if (!SOURCE_IS_DRIVER_FUNDED[input.paymentSource]) return 0;
  const funded = Math.max(0, Math.round(input.driverFundedCents));
  return Math.min(funded, Math.max(0, Math.round(input.receiptCents)));
}

/** Why this reimbursement cannot be filed as written. An empty list means it can. */
export function reimbursementProblems(input: {
  receiptCents: number;
  driverFundedCents: number;
  paymentSource: PaymentSource;
  payerDriverId: string;
  hasReceiptFile: boolean;
  missingReceiptReason: string | null;
}): string[] {
  const problems: string[] = [];
  if (input.receiptCents <= 0) problems.push('The receipt total must be more than zero.');
  if (input.driverFundedCents < 0) problems.push('The driver-funded amount cannot be negative.');
  if (input.driverFundedCents > input.receiptCents) problems.push('The driver cannot have funded more than the receipt total.');
  if (!input.payerDriverId) problems.push('Name the driver who actually paid.');
  if (SOURCE_IS_DRIVER_FUNDED[input.paymentSource] && input.driverFundedCents <= 0) {
    problems.push('This was paid from the driver’s own funds, so say how much of it they funded.');
  }
  if (!SOURCE_IS_DRIVER_FUNDED[input.paymentSource] && input.driverFundedCents > 0) {
    problems.push('This was paid by the company, so none of it is reimbursable to the driver. Record a split instead if the driver funded part of it.');
  }
  if (!input.hasReceiptFile && !input.missingReceiptReason) {
    problems.push('Attach the receipt, or record an authorised reason for it being missing.');
  }
  return problems;
}

/** The part of a split the company itself paid; shown so a split is never silently rounded away. */
export function companyFundedCents(input: { receiptCents: number; driverFundedCents: number; paymentSource: PaymentSource }): number {
  return Math.max(0, Math.round(input.receiptCents) - reimbursableCents(input));
}

// ------------------------------------------------------------------ the workflow

export const REIMBURSEMENT_TRANSITIONS: Record<ReimbursementStatus, readonly ReimbursementStatus[]> = {
  pending: ['approved', 'rejected'],
  approved: ['included', 'rejected'],
  // A draft that is regenerated hands its items back, so `included` can return to `approved`.
  included: ['paid', 'approved'],
  paid: [],
  rejected: ['pending'],
};

export function canTransitionReimbursement(from: ReimbursementStatus, to: ReimbursementStatus): boolean {
  return REIMBURSEMENT_TRANSITIONS[from].includes(to);
}

/**
 * Whether this item may be put on the statement being built.
 *
 * Approved and not yet spoken for, or already on this very statement - which is what makes
 * recomputing a draft idempotent: the same item lands on the same statement, once, however many
 * times the draft is recalculated.
 */
export function isEligibleFor(block: Pick<ReimbursementBlock, 'status' | 'settlementId'>, settlementId: string): boolean {
  if (block.status === 'approved' && !block.settlementId) return true;
  return (block.status === 'approved' || block.status === 'included') && block.settlementId === settlementId;
}

// ------------------------------------------------------------------ the four cards

export interface ReimbursementTotals {
  pendingCount: number;
  pendingCents: number;
  approvedCount: number;
  approvedCents: number;
  includedCount: number;
  includedCents: number;
  paidCount: number;
  paidCents: number;
}

/**
 * The summary over one currency's worth of items.
 *
 * Amounts are the reimbursable part, never the receipt total: a card headed "approved, not yet
 * on a statement" has to say what the company will actually pay out, not what was spent.
 */
export function reimbursementTotals(items: readonly ReimbursementBlock[]): ReimbursementTotals {
  const owed = (b: ReimbursementBlock) => reimbursableCents(b);
  const of = (status: ReimbursementStatus) => items.filter((b) => b.status === status);
  const sum = (list: readonly ReimbursementBlock[]) => list.reduce((t, b) => t + owed(b), 0);
  return {
    pendingCount: of('pending').length,
    pendingCents: sum(of('pending')),
    approvedCount: of('approved').length,
    approvedCents: sum(of('approved')),
    includedCount: of('included').length,
    includedCents: sum(of('included')),
    paidCount: of('paid').length,
    paidCents: sum(of('paid')),
  };
}

/** The same summary per currency, because two currencies must never be added together. */
export function totalsByCurrency(items: readonly ReimbursementBlock[]): Array<{ currency: string; totals: ReimbursementTotals }> {
  const currencies = [...new Set(items.map((b) => b.currency || 'USD'))].sort();
  return currencies.map((currency) => ({ currency, totals: reimbursementTotals(items.filter((b) => (b.currency || 'USD') === currency)) }));
}

// ------------------------------------------------------------------ input

export const CreateReimbursementSchema = z.object({
  payerDriverId: z.string().min(1),
  truckId: z.string().nullable().default(null),
  loadId: z.string().nullable().default(null),
  onDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: z.enum(REIMBURSEMENT_CATEGORIES),
  receiptCents: z.number().int().positive(),
  driverFundedCents: z.number().int().min(0),
  currency: z.string().trim().length(3).default('USD'),
  description: z.string().trim().min(2).max(200),
  paymentSource: z.enum(PAYMENT_SOURCES),
  receiptFileId: z.string().nullable().default(null),
  missingReceiptReason: z.string().trim().min(3).max(500).nullable().default(null),
  note: z.string().trim().max(1000).nullable().default(null),
});
export type CreateReimbursementInput = z.infer<typeof CreateReimbursementSchema>;

export const ReviewReimbursementSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(500).nullable().default(null),
});
export type ReviewReimbursementInput = z.infer<typeof ReviewReimbursementSchema>;
