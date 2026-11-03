import { z } from 'zod';

/**
 * Compliance requirement catalog.
 *
 * This is the contract for `qualification_requirements` in docs/DATABASE.md §3.10. A requirement
 * is the *rule* ("every company driver must hold a current DOT medical certificate"); a
 * qualification item (see `./item.ts`) is one entity's standing against that rule.
 *
 * Nothing here is hardcoded policy: lead days, grace periods, escalation and the dispatch effect
 * are all data. A carrier that wants to be warned 120 days out, or that treats a lapsed annual
 * inspection as advisory rather than a hard hold, changes the requirement row, not the code.
 */

export const COMPLIANCE_SCOPES = ['driver', 'truck', 'trailer', 'company'] as const;
export const ComplianceScopeSchema = z.enum(COMPLIANCE_SCOPES);
export type ComplianceScope = z.infer<typeof ComplianceScopeSchema>;

/**
 * What a failed requirement does to operations. `driver_hold` / `unit_hold` are the gates that
 * make `drivers.dispatchable` / `trucks.dispatchable` false with a recorded reason.
 */
export const HOLD_EFFECTS = [
  'none',
  'advisory',
  'driver_hold',
  'unit_hold',
  'company_hold',
] as const;
export const HoldEffectSchema = z.enum(HOLD_EFFECTS);
export type HoldEffect = z.infer<typeof HoldEffectSchema>;

/** Who carries a compliance item, and who it escalates to. Mirrors the RBAC roles. */
export const COMPLIANCE_ROLES = [
  'driver',
  'safety_coordinator',
  'safety_manager',
  'safety_director',
  'operations_manager',
  'fleet_manager',
  'recruiter',
] as const;
export const ComplianceRoleSchema = z.enum(COMPLIANCE_ROLES);
export type ComplianceRole = z.infer<typeof ComplianceRoleSchema>;

export const COMPLIANCE_SEVERITIES = ['ok', 'info', 'warning', 'critical'] as const;
export const ComplianceSeveritySchema = z.enum(COMPLIANCE_SEVERITIES);
export type ComplianceSeverity = z.infer<typeof ComplianceSeveritySchema>;

/**
 * One rung of the escalation ladder. `atDaysRemaining` is inclusive and counts down, so a step at
 * 7 fires while 7 or fewer days remain, until a later step takes over. A negative value describes
 * the period after expiry.
 */
export const EscalationStepSchema = z.object({
  atDaysRemaining: z.number().int(),
  notify: z.array(ComplianceRoleSchema).min(1),
  severity: ComplianceSeveritySchema,
});
export type EscalationStep = z.infer<typeof EscalationStepSchema>;

export const CompliancePolicySchema = z.object({
  /**
   * Warning thresholds in days before expiry, descending (e.g. `[90, 60, 30, 14, 7, 3, 1]`). The
   * first threshold an item falls under decides its warning stage. An empty array means the item
   * only ever reads valid or expired, with no run-up.
   */
  leadDays: z.array(z.number().int().positive()),
  /** Days an expired item stays usable. 0 means expiry bites immediately. */
  gracePeriodDays: z.number().int().nonnegative(),
  /** Escalation rungs, evaluated from the lowest `atDaysRemaining` upward. */
  escalation: z.array(EscalationStepSchema),
});
export type CompliancePolicy = z.infer<typeof CompliancePolicySchema>;

export const QualificationRequirementSchema = z.object({
  /** Stable code, e.g. `cdl`, `medical_card`, `annual_inspection`. */
  code: z.string().min(1),
  name: z.string().min(1),
  /** One-line statement of the rule, shown wherever the requirement is explained. */
  description: z.string().min(1),
  scope: ComplianceScopeSchema,
  /** Regulatory citation or internal policy reference; shown in audit packets. */
  authority: z.string().nullable(),
  /** False for one-off checks (a background check) that never lapse. */
  hasExpiry: z.boolean(),
  /** True when a document must be on file, not merely a date. */
  requiresDocument: z.boolean(),
  /** True when a human must verify the document before the item counts as satisfied. */
  requiresVerification: z.boolean(),
  /** True when the driver must sign a consent before the check can be run (MVR, PSP, background). */
  requiresConsent: z.boolean(),
  holdEffect: HoldEffectSchema,
  owner: ComplianceRoleSchema,
  policy: CompliancePolicySchema,
  /** False for a requirement a company has switched off; kept for history rather than deleted. */
  active: z.boolean(),
  /** True for catalog rows the platform ships; a company may add its own. */
  isSystem: z.boolean(),
  /**
   * True for a type that is a file the unit carries (a title, a bill of sale) rather than a
   * qualification the compliance engine grades. It can be uploaded and tracked on the unit's
   * Documents tab, but its absence is not a finding on the Safety board.
   */
  documentOnly: z.boolean().optional(),
  /**
   * How long a fresh document of this type is good for, in calendar months. When set, entering the
   * issue date fills the expiry (issue + validityMonths) until somebody types an expiry by hand.
   * Only for types with a fixed term (owner, 2026-10-08: annual inspections, MVR review,
   * Clearinghouse query = 12); a registration or a medical card carries its own printed date.
   */
  validityMonths: z.number().int().positive().optional(),
  /**
   * The code of the requirement this one is a part of, when one document is filed as several
   * pieces (owner, 2026-10-24: the CDL is one item with a Front and a Back). The part keeps its
   * own code, documents and verification — nothing filed under it moves — and the screens show it
   * as a slot of the parent instead of a row of its own. See `./combined.ts`.
   */
  partOf: z.string().min(1).optional(),
  /** The slot label when the requirement is shown as a part ("Front", "Back"). */
  partLabel: z.string().min(1).optional(),
});
export type QualificationRequirement = z.infer<typeof QualificationRequirementSchema>;
