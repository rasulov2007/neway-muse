import { z } from 'zod';
import { IsoDateSchema } from '../dashboard/period.js';
import {
  ComplianceRoleSchema,
  ComplianceScopeSchema,
  ComplianceSeveritySchema,
} from './requirement.js';

/**
 * Where an entity stands against one requirement.
 *
 * The status vocabulary is deliberately wider than "valid / expired" because the operational
 * answers differ: a *missing* medical card needs a document collected, a *pending_verification*
 * one needs a safety reviewer, and a *verification_failed* one needs the driver contacted. Rolling
 * these into one "non-compliant" bucket would tell the safety desk nothing about what to do.
 *
 * Maps to `qualification_items.status` in docs/DATABASE.md §3.10, which spells `pending` for
 * `pending_verification` and `invalid` for `verification_failed`.
 */
export const COMPLIANCE_STATUSES = [
  'verified',
  'valid',
  'expiring',
  'expired',
  'missing',
  'pending_verification',
  'verification_failed',
  'waived',
  'not_applicable',
] as const;
export const ComplianceStatusSchema = z.enum(COMPLIANCE_STATUSES);
export type ComplianceStatus = z.infer<typeof ComplianceStatusSchema>;

/** Statuses that satisfy the requirement right now. */
export const SATISFIED_STATUSES: readonly ComplianceStatus[] = [
  'verified',
  'valid',
  'waived',
  'not_applicable',
];

/** Statuses that fail the requirement outright, as opposed to merely running down. */
export const FAILING_STATUSES: readonly ComplianceStatus[] = [
  'expired',
  'missing',
  'verification_failed',
];

/**
 * The stored record. Dates only — no derived status — because status is a function of the record
 * and the clock, and storing it would let the two drift. `evaluateItem` derives it.
 */
export const QualificationItemSchema = z.object({
  id: z.string().min(1),
  requirementCode: z.string().min(1),
  scope: ComplianceScopeSchema,
  /** Id of the driver, truck, trailer or company this item belongs to. */
  entityId: z.string().min(1),
  /** Denormalized for display only; the entity record stays the source of truth. */
  entityLabel: z.string().min(1),
  documentId: z.string().nullable(),
  issuedOn: IsoDateSchema.nullable(),
  expiresOn: IsoDateSchema.nullable(),
  /** Set once a human has checked the document against the requirement. */
  verifiedAt: z.string().datetime().nullable(),
  verifiedBy: z.string().nullable(),
  /** True when a reviewer looked and rejected it; distinct from never having been reviewed. */
  verificationFailed: z.boolean(),
  verificationNote: z.string().nullable(),
  /** Set when management accepts the gap knowingly; carries who and why. */
  waivedUntil: IsoDateSchema.nullable(),
  waivedReason: z.string().nullable(),
  /** True when the requirement does not apply to this entity (e.g. hazmat for a dry-van-only driver). */
  notApplicable: z.boolean(),
  notes: z.string().nullable(),
  /**
   * The Eastern date the document on file was received (uploaded), when the reader knows it. Only
   * the fixed-term reviews use it, and only when no report date was recorded: an MVR or PSP is
   * good for its term from the day it was dated, else from the day it arrived (owner, 2026-10-24).
   */
  receivedOn: IsoDateSchema.nullable().optional(),
});
export type QualificationItem = z.infer<typeof QualificationItemSchema>;

/**
 * A requirement evaluated against the clock: the status, how urgent it is, who owns it, what to do
 * about it, and the evidence behind every one of those. `reasons` follows the convention in
 * docs/AI_ARCHITECTURE.md — a human can check the conclusion without re-deriving it.
 */
export const EvaluatedItemSchema = z.object({
  itemId: z.string().nullable(),
  requirementCode: z.string().min(1),
  requirementName: z.string().min(1),
  scope: ComplianceScopeSchema,
  entityId: z.string().min(1),
  entityLabel: z.string().min(1),
  status: ComplianceStatusSchema,
  severity: ComplianceSeveritySchema,
  expiresOn: IsoDateSchema.nullable(),
  /** Whole days until expiry; negative once past. Null when the requirement never expires. */
  daysRemaining: z.number().int().nullable(),
  /** The lead-day threshold this item has fallen under, e.g. 30. Null outside any window. */
  warningStage: z.number().int().nullable(),
  /** True while an expired item is still inside its grace period. */
  inGracePeriod: z.boolean(),
  /** True when this item alone stops the entity being dispatched. */
  blocksDispatch: z.boolean(),
  owner: ComplianceRoleSchema,
  /** Who the current escalation rung notifies. */
  notify: z.array(ComplianceRoleSchema),
  /** Evidence: why this status and this severity. Never empty for a non-satisfied item. */
  reasons: z.array(z.string()),
  /** The single next step, phrased as an instruction. Null when nothing is required. */
  requiredAction: z.string().nullable(),
  /** When the action must be done by: the expiry, or today if already past. */
  deadline: IsoDateSchema.nullable(),
});
export type EvaluatedItem = z.infer<typeof EvaluatedItemSchema>;

export const ENTITY_COMPLIANCE_STATES = ['compliant', 'at_risk', 'non_compliant'] as const;
export const EntityComplianceStateSchema = z.enum(ENTITY_COMPLIANCE_STATES);
export type EntityComplianceState = z.infer<typeof EntityComplianceStateSchema>;

/** One driver, truck or trailer rolled up across every requirement that applies to it. */
export const EntityComplianceSchema = z.object({
  scope: ComplianceScopeSchema,
  entityId: z.string().min(1),
  entityLabel: z.string().min(1),
  state: EntityComplianceStateSchema,
  /** False when any applicable requirement places a hold. Mirrors `drivers.dispatchable`. */
  dispatchable: z.boolean(),
  /** Why not, in the order the gates fired. Mirrors `gate_reasons text[]`. */
  gateReasons: z.array(z.string()),
  /** The worst severity across the entity's items, for sorting a worklist. */
  severity: ComplianceSeveritySchema,
  /** Soonest deadline across unsatisfied items, so a queue can be sorted by urgency. */
  nextDeadline: IsoDateSchema.nullable(),
  items: z.array(EvaluatedItemSchema),
  counts: z.object({
    total: z.number().int().nonnegative(),
    satisfied: z.number().int().nonnegative(),
    expiring: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    pendingVerification: z.number().int().nonnegative(),
    verificationFailed: z.number().int().nonnegative(),
    waived: z.number().int().nonnegative(),
  }),
});
export type EntityCompliance = z.infer<typeof EntityComplianceSchema>;
