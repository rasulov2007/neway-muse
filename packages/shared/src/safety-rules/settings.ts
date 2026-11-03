// Carrier-configurable values the rules read (SPEC §12 — `safety_settings`). The prototype hard-coded
// them (SPEC §11 shortcut 4); here they are data. All money is integer cents.
import type { Severity } from './types.js';

export interface SafetyRuleSettings {
  /** Physical damage deductible used for new PD claims (SPEC §12: $5,000). */
  physicalDamageDeductibleCents: number;
  /** Auto liability deductible (SPEC §12: $2,500). */
  autoLiabilityDeductibleCents: number;
  /** Cargo deductible (SPEC §12: $2,500). */
  cargoDeductibleCents: number;
  /** A repair estimate above this needs `estimatesRequired` estimates (SPEC §12: $25,000). */
  estimatesRequiredThresholdCents: number;
  /** Number of estimates required above the threshold (SPEC §12: 3). */
  estimatesRequired: number;
  /** Initial estimate at or above this suggests severity "serious" (SPEC §7.4: $25,000). */
  severitySeriousEstimateCents: number;
  /** Initial estimate at or above this suggests severity "moderate" (SPEC §7.4: $5,000). */
  severityModerateEstimateCents: number;
  /** Severities that get a management-review task / attention item (SPEC §12: serious, critical). */
  managementReviewSeverities: Severity[];
  /** Lost revenue per truck-day when the truck has no contribution of its own (SPEC §12: $640). */
  fallbackDailyContributionCents: number;
  /** Odometer coverage needed for a month's rate per 1M miles (SPEC §12: 70%). */
  mileageCoverageThreshold: number;
  /** Claim with no update for this many days → attention (SPEC §12: 7). */
  claimNoUpdateDays: number;
  /** Draft older than this → attention (SPEC §12: 2 h). */
  draftReminderHours: number;
  /** 49 CFR 382.303 windows — fixed by regulation, kept here so every caller reads the same numbers. */
  alcoholWindowHours: number;
  alcoholPromptHours: number;
  drugWindowHours: number;
}

export const DEFAULT_SAFETY_RULE_SETTINGS: Readonly<SafetyRuleSettings> = Object.freeze({
  physicalDamageDeductibleCents: 500_000,
  autoLiabilityDeductibleCents: 250_000,
  cargoDeductibleCents: 250_000,
  estimatesRequiredThresholdCents: 2_500_000,
  estimatesRequired: 3,
  severitySeriousEstimateCents: 2_500_000,
  severityModerateEstimateCents: 500_000,
  managementReviewSeverities: ['serious', 'critical'] as Severity[],
  fallbackDailyContributionCents: 64_000,
  mileageCoverageThreshold: 0.7,
  claimNoUpdateDays: 7,
  draftReminderHours: 2,
  alcoholWindowHours: 8,
  alcoholPromptHours: 2,
  drugWindowHours: 32,
});

export function resolveSettings(s?: Partial<SafetyRuleSettings>): SafetyRuleSettings {
  return { ...DEFAULT_SAFETY_RULE_SETTINGS, ...(s ?? {}) };
}
