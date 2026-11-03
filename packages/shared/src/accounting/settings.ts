import { z } from 'zod';

/**
 * Company accounting settings (§5, §8, §9, §11). A value nobody has confirmed is `null`, and
 * the screens say "Needs configuration" beside the thing it blocks - the setting blocks only
 * that finalisation, never the rest of the module. Nothing here ships a guessed number: the RTS
 * fee was quoted two contradictory ways, so it is null until somebody enters the verified one.
 */
export const AccountingSettingsSchema = z.object({
  /** Factoring provider name; RTS per the owner. */
  factoringProvider: z.string().trim().max(80).default('RTS'),
  /** Verified factoring fee in basis points of gross (75 = 0.75%; 7.5 bps cannot be entered as an integer, say so). */
  factoringFeeBps: z.number().int().min(0).max(5000).nullable().default(null),
  /** Reserve / holdback held by the factor, in basis points; 0 when there is none. */
  factoringReserveBps: z.number().int().min(0).max(10_000).nullable().default(null),
  /** Holiday fees the factor charges, cents, and what each applies to. */
  holidayFees: z
    .array(z.object({ label: z.string().trim().min(1).max(60), amountCents: z.number().int().min(0), scope: z.enum(['per_batch', 'per_payment', 'per_load']).nullable() }))
    .default([{ label: 'Holiday fee (15)', amountCents: 1500, scope: null }, { label: 'Holiday fee (25)', amountCents: 2500, scope: null }]),
  /** Customer payment terms when the customer record does not say. */
  defaultPaymentTermsDays: z.number().int().min(0).max(180).default(30),
  /** Settlement week (§8). */
  settlementWeekStart: z.enum(['monday']).default('monday'),
  /** Cutoff: loads completed before this local time on the day after the week ends belong to the week. */
  cutoffDay: z.enum(['monday']).default('monday'),
  /**
   * The cutoff time the settlement module used before the pay-week rule of 2026-10-21. Kept so a
   * stored record still reads and the history explains itself; nothing computes from it any more.
   */
  cutoffTime: z.string().regex(/^\d{2}:\d{2}$/).default('14:00'),
  /**
   * The pay week (owner, 2026-10-21): Monday at this time to the next Monday at this time, on
   * `payPeriodTimezone`. A load completed at 11:59 belongs to the week that is ending; at 12:00,
   * to the new one. A new key, so every company starts on noon without its record being rewritten.
   */
  payPeriodCutoffTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time as HH:MM (24-hour)').default('12:00'),
  /** The settlement clock. Every clock in the product is US Eastern (owner, 2026-09-25). */
  payPeriodTimezone: z.literal('America/New_York').default('America/New_York'),
  /** Which timestamp the cutoff reads. Unconfirmed by the owner: null blocks batch generation until chosen. */
  cutoffBasis: z.enum(['delivered_at', 'status_updated_at']).nullable().default(null),
  /** The owner confirms the company clock is the settlement cutoff clock. null = not confirmed; a batch waits. */
  cutoffTimezoneConfirmed: z.boolean().nullable().default(null),
  payDay: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']).default('thursday'),
  /** Whether a driver's pay waits for the broker/RTS to fund the load. Unconfirmed: null. */
  payOnFundingOnly: z.boolean().nullable().default(null),
  /** Escrow defaults (§7). */
  escrowTargetCents: z.number().int().min(0).default(250_000),
  escrowPerSettlementCents: z.number().int().min(0).default(35_000),
  /** Team base-mileage split is unresolved: null blocks team base pay until chosen. */
  teamBaseMileageSplit: z.enum(['each_full', 'split_50_50']).nullable().default(null),
  /** Vendor share of gross when the arrangement does not say; null = every arrangement must say. */
  vendorDefaultPercentBps: z.number().int().min(0).max(10_000).nullable().default(null),
  /** Dispatcher commission: four-week periods; the formula comes from the dispatch policy in force. */
  dispatcherPeriodWeeks: z.literal(4).default(4),
  payrollCurrency: z.string().length(3).default('USD'),
  /** QuickBooks: who owns postings. Unknown until the owner says. */
  quickbooksOwnsPostings: z.boolean().nullable().default(null),
});
export type AccountingSettings = z.infer<typeof AccountingSettingsSchema>;

export const DEFAULT_ACCOUNTING_SETTINGS: AccountingSettings = AccountingSettingsSchema.parse({});

export interface SettingsProblem {
  key: keyof AccountingSettings;
  label: string;
  blocks: string;
}

/** What is still unconfirmed, and exactly which action each one blocks. */
export function settingsProblems(s: AccountingSettings): SettingsProblem[] {
  const out: SettingsProblem[] = [];
  if (s.factoringFeeBps === null) out.push({ key: 'factoringFeeBps', label: 'RTS factoring fee', blocks: 'Recording an RTS funding without an actual statement fee' });
  if (s.factoringReserveBps === null) out.push({ key: 'factoringReserveBps', label: 'RTS reserve / holdback', blocks: 'Reserve tracking on fundings (0 if none)' });
  if (s.holidayFees.some((f) => f.scope === null)) out.push({ key: 'holidayFees', label: 'Holiday fee scope', blocks: 'Allocating holiday fees per batch, payment or load' });
  if (s.cutoffBasis === null) out.push({ key: 'cutoffBasis', label: 'Cutoff time source', blocks: 'Generating settlement batches' });
  if (s.cutoffTimezoneConfirmed !== true) out.push({ key: 'cutoffTimezoneConfirmed', label: 'Cutoff clock (US Eastern)', blocks: 'Generating settlement batches' });
  if (s.payOnFundingOnly === null) out.push({ key: 'payOnFundingOnly', label: 'Pay LO/OO only after funding', blocks: 'Approving LO/OO statements with unfunded loads' });
  if (s.teamBaseMileageSplit === null) out.push({ key: 'teamBaseMileageSplit', label: 'Team base-mileage split', blocks: 'Base mileage pay on team loads' });
  if (s.vendorDefaultPercentBps === null) out.push({ key: 'vendorDefaultPercentBps', label: 'Vendor share', blocks: 'Vendor statements for trucks whose arrangement has no percentage' });
  if (s.quickbooksOwnsPostings === null) out.push({ key: 'quickbooksOwnsPostings', label: 'QuickBooks ownership', blocks: 'Nothing today; decides whether the ledger here is authoritative' });
  return out;
}
