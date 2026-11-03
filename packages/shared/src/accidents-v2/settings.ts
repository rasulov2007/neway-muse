import { z } from 'zod';
import { DEPTS, type PersonRef } from './api.js';
import { CLAIM_TYPES } from './claims.js';

/**
 * Accidents settings (go-live, IMPLEMENTATION-PLAN §17 item 8): the carrier's own values the v2 pages read from
 * `safety_settings` — default assignee per department, default insurer per coverage and the three deductibles.
 * Safety fills them in; nothing here is invented. The $640/truck-day lost-revenue fallback is shown, not edited.
 */
const dollars = z.number().int().min(0).max(10_000_000_000);

export const AccidentSettingsSchema = z.object({
  /** The `version` the screen read (null when nothing was ever saved); a stale save is refused with 409. */
  version: z.string().max(40).nullable(),
  deptAssignees: z.partialRecord(z.enum(DEPTS), z.string().trim().min(1).max(120).nullable()).optional(),
  insurers: z.partialRecord(z.enum(CLAIM_TYPES), z.string().trim().max(160)).optional(),
  deductibles: z
    .object({
      physicalDamageDeductibleCents: dollars,
      autoLiabilityDeductibleCents: dollars,
      cargoDeductibleCents: dollars,
    })
    .partial()
    .optional(),
});
export type AccidentSettingsInput = z.infer<typeof AccidentSettingsSchema>;

export interface AccidentSettingsResponse {
  version: string | null;
  deptAssignees: Record<(typeof DEPTS)[number], PersonRef | null>;
  insurers: Record<(typeof CLAIM_TYPES)[number], string>;
  deductibles: { physicalDamageDeductibleCents: number; autoLiabilityDeductibleCents: number; cargoDeductibleCents: number };
  /** Read-only here: lost revenue per truck-day when a truck has no contribution of its own. */
  fallbackDailyContributionCents: number;
  /** People who can be picked as a department's default assignee (active accounts of the company). */
  people: PersonRef[];
  canEdit: boolean;
  updatedBy: string | null;
}
