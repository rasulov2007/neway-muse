// Accident & Claims v2 — claims contract (phase P2; docs/accidents/API.md §4, adapted — see the P2 report in
// docs/accidents/IMPLEMENTATION-PLAN.md). One claim per coverage line (owner decision Q1, Option A): an accident can
// have many claims, a claim can stand alone. Money in integer cents; null = not known yet (never coerced to 0).
// Claim money comes only from claim payments (one source of truth). Every write names the claim `version` it read.
import { z } from 'zod';
import type { ClaimMoney, ClaimStatus, ClaimType, Stage } from '../safety-rules/index.js';
import type { PersonRef, TaskView } from './api.js';

export const CLAIM_TYPES = ['physical_damage', 'auto_liability', 'cargo', 'recovery', 'workers_comp'] as const;
export const CLAIM_STATUSES_V2 = ['Draft', 'Open', 'Under review', 'Awaiting documents', 'Negotiating', 'Settled', 'Denied', 'Closed'] as const;
export const PAYMENT_DIRECTIONS = ['to_us', 'by_insurer_to_claimant', 'by_us'] as const;
export const CLAIM_LOG_CHANNELS = ['Email', 'Phone', 'Portal', 'Letter', 'Note'] as const;
export const STANDALONE_KINDS = ['Cargo shortage', 'Cargo theft', 'Damaged freight', 'Concealed damage', 'Equipment theft / vandalism', 'Other loss'] as const;
/** Claims board chips (SPEC §1.5). */
export const CLAIM_CHIPS = ['needs_follow_up', 'open', 'money_to_us', 'settled', 'all'] as const;
export type ClaimChip = (typeof CLAIM_CHIPS)[number];
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

/** Default required-documents checklist per coverage (prototype store.tsx defaultDocs). */
export const CLAIM_DEFAULT_DOCS: Record<ClaimType, string[]> = {
  physical_damage: ['Damage photos', 'Repair estimate', 'Police report (if any)', 'Final repair invoice'],
  auto_liability: ['Police report', 'Claimant estimate / demand', 'Our driver statement', 'Release'],
  cargo: ['Bill of lading with exceptions', 'Commercial invoice', 'Photos of damage', 'Salvage / disposition record'],
  recovery: ['Other party insurance details', 'Our repair invoice', 'Police report'],
  workers_comp: ['First report of injury', 'Medical authorizations (restricted)'],
};
/** The first follow-up every new claim gets (3 days out). */
export const FIRST_FOLLOW_UP = 'Confirm insurer claim number and adjuster';

const id = z.string().trim().min(1).max(120);
const version = z.number().int().min(1);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const cents = z.number().int().min(0).max(100_000_000_000).nullable().optional();
const isoInstant = z.string().datetime({ offset: true });

export const ClaimLineSchema = z.object({
  type: z.enum(CLAIM_TYPES),
  insurer: optText(160),
  /** Claimed (or, for a recovery, the amount to recover). Blank = not known yet. */
  claimedCents: cents,
  reserveCents: cents,
  /** Blank = the settings default for the coverage. */
  deductibleCents: cents,
  claimant: optText(200),
  /** Defaults: workers' comp always, auto liability on an accident with injuries. Setting it needs accidents.restricted. */
  restricted: z.boolean().optional(),
});
export type ClaimLineInput = z.infer<typeof ClaimLineSchema>;

export const CreateClaimsSchema = z
  .object({
    accidentId: id.optional(),
    standaloneKind: z.enum(STANDALONE_KINDS).optional(),
    title: optText(300),
    whatWasLost: optText(2000),
    loadId: id.nullable().optional(),
    unitLabel: optText(120),
    /** Open a claim even though an open claim of the same type exists on the accident (G2). */
    confirmDuplicate: z.boolean().optional(),
    /** Reason when a line's restricted flag differs from its default (audited). */
    restrictedReason: optText(500),
    isTest: z.boolean().optional(),
    lines: z.array(ClaimLineSchema).min(1).max(5),
  })
  .refine((v) => Boolean(v.accidentId) || Boolean(v.title?.trim()), { message: 'Pick the accident, or describe the loss', path: ['title'] });
export type CreateClaimsInput = z.infer<typeof CreateClaimsSchema>;

export const PatchClaimSchema = z.object({
  version,
  status: z.enum(CLAIM_STATUSES_V2).optional(),
  title: z.string().trim().min(2).max(300).optional(),
  insurer: optText(160),
  insurerClaimNo: optText(80),
  adjusterName: optText(160),
  adjusterPhone: optText(40),
  adjusterEmail: optText(160),
  claimant: optText(200),
  responsibleParty: optText(200),
  ownerId: id.optional(),
  reportedToInsurerAt: isoInstant.nullable().optional(),
  /** Money: needs accidents.claim_money. */
  claimedCents: cents,
  reserveCents: cents,
  deductibleCents: cents,
  settlementCents: cents,
  disputed: z.boolean().optional(),
  nextFollowUp: z.object({ at: isoInstant, assigneeId: id, what: z.string().trim().min(2).max(300) }).nullable().optional(),
  /** Needs accidents.restricted and a reason (audited). */
  restricted: z.boolean().optional(),
  restrictedReason: optText(500),
  note: optText(500),
});
export type PatchClaimInput = z.infer<typeof PatchClaimSchema>;

export const ClaimPaymentSchema = z.object({
  version,
  direction: z.enum(PAYMENT_DIRECTIONS),
  amountCents: z.number().int().min(1).max(100_000_000_000),
  party: z.string().trim().min(1).max(200),
  paidAt: isoInstant.optional(),
  note: optText(500),
});
export type ClaimPaymentInput = z.infer<typeof ClaimPaymentSchema>;

export const VoidClaimPaymentSchema = z.object({ version, reason: z.string().trim().min(3, 'Give a reason').max(500) });
export type VoidClaimPaymentInput = z.infer<typeof VoidClaimPaymentSchema>;

export const ClaimDocumentSchema = z.object({ version, received: z.boolean() });
export type ClaimDocumentInput = z.infer<typeof ClaimDocumentSchema>;

export const ClaimLogSchema = z.object({ version, channel: z.enum(CLAIM_LOG_CHANNELS), text: z.string().trim().min(1).max(4000) });
export type ClaimLogInput = z.infer<typeof ClaimLogSchema>;

export const LinkAccidentSchema = z.object({ version, accidentId: id });
export type LinkAccidentInput = z.infer<typeof LinkAccidentSchema>;

/** "Record no claim" on a case (SPEC §1.4 Claims & costs); text null clears it. */
export const ClaimDecisionSchema = z.object({ version, text: z.string().trim().min(3).max(1000).nullable() });
export type ClaimDecisionInput = z.infer<typeof ClaimDecisionSchema>;

export const ClaimListQuerySchema = z.object({
  chip: z.enum(CLAIM_CHIPS).optional(),
  origin: z.enum(['all', 'accident', 'standalone']).optional(),
  q: z.string().trim().max(120).optional(),
  type: z.enum(CLAIM_TYPES).optional(),
  status: z.enum(CLAIM_STATUSES_V2).optional(),
  insurer: z.string().trim().max(160).optional(),
  accidentId: z.string().max(120).optional(),
});
export type ClaimListQuery = z.infer<typeof ClaimListQuerySchema>;

// ------------------------------------------------------------------------------------------------ responses

/** Fields a viewer without accidents.restricted never receives on a restricted claim (API.md §4). */
export const CLAIM_REDACTED_FIELDS = [
  'claimedCents',
  'reserveCents',
  'deductibleCents',
  'settlementCents',
  'payments',
  'claimant',
  'responsibleParty',
  'adjuster',
  'log',
  'documents.attachments',
  'nextFollowUp.what',
] as const;

export interface ClaimAccidentRef {
  id: string;
  number: string;
  stage: Stage;
}

export interface ClaimRow {
  id: string;
  number: string;
  type: ClaimType;
  status: ClaimStatus;
  open: boolean;
  title: string;
  openedAt: string;
  accident: ClaimAccidentRef | null;
  standaloneKind: string | null;
  insurer: string;
  insurerClaimNo: string | null;
  owner: PersonRef | null;
  restricted: boolean;
  isTest: boolean;
  /** Absent (null) on a restricted claim for a viewer without accidents.restricted. */
  claimant: string | null;
  claimedCents: number | null;
  reserveCents: number | null;
  /** Received by us (own damage, recovery) or paid out (insurer + us) for third-party claims. */
  paidOrReceivedCents: number | null;
  nextFollowUp: { at: string; assignee: PersonRef | null; what: string | null; overdue: boolean } | null;
  lastUpdateAt: string;
  /** Whole days since the last update when it is at or past the "no update" threshold on an open claim. */
  staleDays: number | null;
  needsFollowUp: boolean;
  redacted: string[];
}

export interface ClaimListResponse {
  items: ClaimRow[];
  total: number;
  counts: Record<ClaimChip, number>;
  insurers: string[];
}

export interface ClaimsSummaryResponse {
  open: { value: number; fromAccidents: number; standalone: number };
  stillToRecoverCents: number;
  ourShareCents: number;
  insurerReservesCents: number;
  recoveredYear: { year: number; cents: number };
  needsFollowUp: { value: number; noUpdate: number; followUpsOverdue: number };
  noUpdateDays: number;
  /** Restricted claims left out of the money for this viewer (SPEC §7.13 rule 7). */
  restrictedExcluded: number;
}

export interface ClaimPaymentView {
  id: string;
  direction: PaymentDirection;
  amountCents: number;
  party: string;
  paidAt: string;
  note: string | null;
  recordedBy: string;
  voided: { at: string; by: string | null; reason: string | null } | null;
  /** Accounting's review of the payment (existing Claims v2 approval flow); null when nothing goes to Accounting. */
  accounting: 'pending_review' | 'confirmed' | 'rejected' | 'superseded' | null;
}

export interface ClaimDetailResponse {
  claim: ClaimRow & {
    adjuster: { name: string | null; phone: string | null; email: string | null } | null;
    responsibleParty: string | null;
    unitLabel: string | null;
    load: { id: string; number: string } | null;
    reportedToInsurerAt: string | null;
    deductibleCents: number | null;
    settlementCents: number | null;
    disputed: boolean;
    whatWasLost: string | null;
    closedAt: string | null;
    restrictedReason: string | null;
  };
  version: number;
  money: ClaimMoney | null;
  payments: ClaimPaymentView[] | null;
  documents: { id: string; label: string; received: boolean; receivedAt: string | null; version: number }[];
  log: { id: string; at: string; by: string; channel: (typeof CLAIM_LOG_CHANNELS)[number]; text: string }[] | null;
  accident: (ClaimAccidentRef & { occurredAt: string; tz: string; truckUnit: string | null; driverName: string | null; claims: { id: string; number: string; type: ClaimType; status: ClaimStatus }[] }) | null;
  tasks: TaskView[];
  /** The existing Claims v2 flows on the same row (driver charge, notice, Accounting approval). */
  legacy: { stage: string; liabilityParty: string | null; driverCharge: { id: string; number: string; state: string; amountCents: number } | null };
  redacted: string[];
  permissions: { edit: boolean; money: boolean; restricted: boolean };
}

export interface CreateClaimsResponse {
  created: { id: string; number: string; type: ClaimType; restricted: boolean }[];
  accidentId: string | null;
}

/** A claim as the case page shows it (Claims & costs tab, Overview Claims card). */
export interface CaseClaimCard {
  id: string;
  number: string;
  type: ClaimType;
  status: ClaimStatus;
  title: string;
  insurer: string;
  insurerClaimNo: string | null;
  restricted: boolean;
  version: number;
  /** null for a viewer without accidents.restricted on a restricted claim. */
  adjuster: string | null;
  claimedCents: number | null;
  reserveCents: number | null;
  deductibleCents: number | null;
  receivedOrPaidCents: number | null;
  nextFollowUp: { at: string; what: string | null; assignee: PersonRef | null } | null;
}
