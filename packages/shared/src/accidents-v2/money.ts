// Accident & Claims v2 — equipment, downtime and money contract (phase P3; docs/accidents/API.md §5, adapted — see the P3
// report in docs/accidents/IMPLEMENTATION-PLAN.md). Costs are never copied into Safety: the case reads Fleet's work
// orders (estimates, approval, invoice) and Accounting's AP bills where they live. Money in integer cents.
import { z } from 'zod';
import type { FinLine, WOStatus } from '../safety-rules/index.js';

const id = z.string().trim().min(1).max(120);
const version = z.number().int().min(1);
const isoInstant = z.string().datetime({ offset: true });
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const cents = z.number().int().min(0).max(100_000_000_000);
/** Fleet's work orders carry no version column: a write names the `updatedAt` it read (stale → 409). */
const woToken = z.string().datetime({ offset: true });

/** Categories an AP bill can carry on a case (DATA-MODEL `accident_cost_category`). Repairs come only from work orders. */
export const CASE_BILL_CATEGORIES = ['Towing', 'Storage', 'Transload / recovery', 'Rental equipment', 'Other'] as const;
export type CaseBillCategory = (typeof CASE_BILL_CATEGORIES)[number];

export const CreateCaseWorkOrderSchema = z.object({
  version,
  unitKind: z.enum(['truck', 'trailer']),
  vendorId: id.nullable().optional(),
  vendorName: z.string().trim().max(200).optional(),
  title: optText(160),
  eta: isoInstant.nullable().optional(),
});
export type CreateCaseWorkOrderInput = z.infer<typeof CreateCaseWorkOrderSchema>;

export const LinkWorkOrderSchema = z.object({ updatedAt: woToken, accidentId: id });
export type LinkWorkOrderInput = z.infer<typeof LinkWorkOrderSchema>;

export const AddEstimateSchema = z.object({ updatedAt: woToken, vendor: z.string().trim().min(1).max(200), amountCents: cents, fileId: id.nullable().optional() });
export type AddEstimateInput = z.infer<typeof AddEstimateSchema>;

export const ApproveEstimateSchema = z.object({
  updatedAt: woToken,
  estimateId: id,
  /** Required when fewer estimates than required were received (policy exception, logged). */
  exceptionReason: optText(1000),
  eta: isoInstant.nullable().optional(),
});
export type ApproveEstimateInput = z.infer<typeof ApproveEstimateSchema>;

export const StartRepairSchema = z.object({ updatedAt: woToken });
export type StartRepairInput = z.infer<typeof StartRepairSchema>;

export const CompleteRepairSchema = z.object({
  updatedAt: woToken,
  invoiceNumber: z.string().trim().min(1).max(60),
  invoiceTotalCents: cents,
  /** What the shop did; defaults to the work order's title. */
  workDone: optText(500),
});
export type CompleteRepairInput = z.infer<typeof CompleteRepairSchema>;

export const VerifyDowntimeSchema = z.object({ version, note: optText(500) });
export type VerifyDowntimeInput = z.infer<typeof VerifyDowntimeSchema>;

export const PatchDowntimeSchema = z.object({ version, startedAt: isoInstant.optional(), endedAt: isoInstant.nullable().optional(), note: optText(500) });
export type PatchDowntimeInput = z.infer<typeof PatchDowntimeSchema>;

export const CaseBillSchema = z.object({
  version,
  vendorId: id,
  category: z.enum(CASE_BILL_CATEGORIES),
  amountCents: z.number().int().min(1).max(100_000_000_000),
  memo: z.string().trim().min(2).max(500),
  invoiceNumber: optText(60),
  /** A bill that belongs to a claim counts through that claim, never twice. */
  claimId: id.nullable().optional(),
});
export type CaseBillInput = z.infer<typeof CaseBillSchema>;

// ------------------------------------------------------------------------------------------------ responses

export interface EstimateView {
  id: string;
  vendor: string;
  amountCents: number | null;
  receivedAt: string;
  selected: boolean;
}

export interface WorkOrderView {
  id: string;
  number: string;
  unitKind: 'truck' | 'trailer';
  unit: string;
  shop: string;
  status: WOStatus;
  title: string;
  estimates: EstimateView[];
  estimatesRequired: number;
  /** null when the viewer may not see repair costs (the shop-floor role). */
  approvedAmountCents: number | null;
  approvedBy: string | null;
  policyExceptionReason: string | null;
  eta: string | null;
  invoiceNumber: string | null;
  invoiceTotalCents: number | null;
  bill: { id: string; number: string } | null;
  shopInAt: string;
  completedAt: string | null;
  /** Concurrency token for writes (work orders carry no version column). */
  updatedAt: string;
}

export interface FinancialsView {
  lines: FinLine[];
  actualCents: number;
  estimateCents: number;
  recoveredCents: number;
  expectedCents: number;
  exposureCents: number;
  netToDateCents: number;
  projectedNetCents: number;
  finalized: boolean;
  lostRevenue: { days: number; perDayCents: number; amountCents: number; fallback: boolean };
  restrictedClaimsExcluded: number;
  byCategory: { category: string; spentCents: number; estimateCents: number; recoveredCents: number; expectedCents: number }[];
}

export interface UnitStatusView {
  unitKind: 'truck' | 'trailer';
  unitId: string;
  status: string;
  since: string;
  setBy: string | null;
  accidentId: string | null;
}

export interface VendorOption {
  id: string;
  name: string;
}

export interface CaseMoneyBlock {
  /** null for a viewer who may not see repair costs. */
  financials: FinancialsView | null;
  workOrders: WorkOrderView[];
  unitStatus: UnitStatusView[];
  apBills: { id: string; number: string; vendor: string; amountCents: number | null; category: string; status: string; claimNumber: string | null; workOrderNumber: string | null }[];
}

export interface CompleteRepairResponse {
  workOrderId: string;
  bill: { id: string; number: string } | null;
  /** Set when the AP bill could not be created (Accounting creates it from Repair orders). */
  billWarning: string | null;
  readyRequestId: string | null;
  tasksCompleted: number;
}

/** The work-order page banner (SPEC §6.5): an accident repair with no case says so and offers to link one. */
export interface WorkOrderAccidentLink {
  workOrderId: string;
  number: string;
  accidentRepair: boolean;
  accident: { id: string; number: string } | null;
  needsAccidentLink: boolean;
  updatedAt: string;
}
