import { z } from 'zod';
import { REIMBURSEMENT_CATEGORIES, type ReimbursementCategory } from '../accounting/reimbursements.js';
import { DriverLocationSchema, type DriverLocation } from './breakdowns.js';

/**
 * Money in the driver app (mobile M3, docs/mobile/API.md §8–§9): receipts the driver files, and
 * the driver's own pay statements.
 *
 * A receipt the driver paid goes to Accounting as a reimbursement (the existing expense with a
 * review block, `ReimbursementsService`), pending review. A receipt the company card paid is a
 * company expense (a draft Fleet expense) and is never owed back. Filing one never approves it and
 * never makes a deduction.
 */

export const DRIVER_RECEIPT_PAYERS = ['driver', 'company_card'] as const;
export type DriverReceiptPayer = (typeof DRIVER_RECEIPT_PAYERS)[number];

export const DriverReimbursementCreateSchema = z
  .object({
    /** From POST /driver/files (photo or PDF of the receipt). */
    receiptFileId: z.string().min(1),
    amountCents: z.number().int().positive().max(10_000_000),
    currency: z.literal('USD').default('USD'),
    category: z.enum(REIMBURSEMENT_CATEGORIES),
    /** The day on the receipt (YYYY-MM-DD). */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    location: DriverLocationSchema.nullable().optional(),
    truckId: z.string().min(1).nullable().optional(),
    trailerId: z.string().min(1).nullable().optional(),
    loadId: z.string().min(1).nullable().optional(),
    paidBy: z.enum(DRIVER_RECEIPT_PAYERS),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();
export type DriverReimbursementCreateInput = z.input<typeof DriverReimbursementCreateSchema>;

/** The driver's words for where a receipt is. Paid only when the settlement carrying it is paid. */
export const DRIVER_REIMBURSEMENT_STATES = ['received', 'under_review', 'approved', 'rejected', 'added_to_settlement', 'paid', 'company_expense'] as const;
export type DriverReimbursementState = (typeof DRIVER_REIMBURSEMENT_STATES)[number];

export const DRIVER_REIMBURSEMENT_STATE_LABEL: Record<DriverReimbursementState, string> = {
  received: 'Received',
  under_review: 'Under review',
  approved: 'Approved',
  rejected: 'Rejected',
  added_to_settlement: 'Added to settlement',
  paid: 'Paid',
  company_expense: 'Company expense — nothing owed to you',
};

export interface DriverReimbursement {
  id: string;
  /** EX-00012 (reimbursement) or EXP-00012 (company-card expense). */
  number: string;
  kind: 'reimbursement' | 'company_expense';
  category: ReimbursementCategory;
  amountCents: number;
  /** What is owed back to the driver: 0 for a company-card receipt. */
  reimbursableCents: number;
  currency: 'USD';
  date: string;
  state: DriverReimbursementState;
  stateLabel: string;
  steps: Array<{ state: DriverReimbursementState; label: string; reachedAt: string | null; current: boolean }>;
  rejectedReason: string | null;
  reviewer: { name: string } | null;
  settlement: { id: string; number: string; status: string; paidAt: string | null } | null;
  load: { id: string; loadNumber: string | null } | null;
  truckId: string | null;
  location: DriverLocation | null;
  receiptFileId: string | null;
  lastUpdate: string;
  createdAt: string;
}

export interface DriverReimbursementList {
  reimbursements: DriverReimbursement[];
}

// ------------------------------------------------------------------------------ settlements

/** Only finalized (approved) and paid statements reach the app; a draft is still being worked. */
export const DRIVER_SETTLEMENT_STATES = ['finalized', 'paid'] as const;
export type DriverSettlementState = (typeof DRIVER_SETTLEMENT_STATES)[number];

export interface DriverSettlementSummary {
  id: string;
  number: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  state: DriverSettlementState;
  stateLabel: string;
  grossCents: number;
  reimbursementsCents: number;
  deductionsCents: number;
  netCents: number;
  payableCents: number;
  paidAt: string | null;
}

export interface DriverSettlementDetail extends DriverSettlementSummary {
  earnings: Array<{ loadNumber: string | null; description: string; amountCents: number }>;
  deductions: Array<{ description: string; amountCents: number }>;
  reimbursements: Array<{ loadNumber: string | null; description: string; amountCents: number }>;
  carryCents: number;
  escrowCents: number;
  loadCount: number;
  totalMiles: number;
  notes: string[];
}

export interface DriverSettlementList {
  settlements: DriverSettlementSummary[];
}

export interface DriverSettlementPdfLink {
  url: string;
  expiresAt: string;
}
