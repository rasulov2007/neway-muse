import { z } from 'zod';

/**
 * Campaigns and the cost ledger: what it cost to find, check, bring in and start each driver.
 *
 * A campaign is where leads come from and what was spent to get them. A cost entry is one dollar
 * amount against one lead or one case — a check ordered, a bus ticket, three days of orientation
 * pay, a sign-on bonus — with where it came from: typed in by a person, or filled in by the system
 * when the thing it prices happened. Auto entries carry a `sourceRef` that names the record they
 * were priced from, so the same report or ticket is never charged twice and a corrected orientation
 * replaces its own line rather than adding one.
 *
 * Nothing here is derived at write time from anything but the record it prices. Totals, cost per
 * hire and true cost per hire are computed on read by `sumCosts` and the analytics; none of them is
 * stored.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const isoDateTime = z.string().datetime();
const money = z.number().min(0).max(10_000_000);

// -------------------------------------------------------------------------------- campaigns

export const CAMPAIGN_CHANNELS = [
  'job_board',
  'referral',
  'social',
  'website',
  'agency',
  'radio',
  'billboard',
  'event',
  'other',
] as const;
export const CampaignChannelSchema = z.enum(CAMPAIGN_CHANNELS);
export type CampaignChannel = z.infer<typeof CampaignChannelSchema>;

export const CAMPAIGN_CHANNEL_LABELS: Readonly<Record<CampaignChannel, string>> = {
  job_board: 'Job board',
  referral: 'Driver referral',
  social: 'Social',
  website: 'Website',
  agency: 'Agency',
  radio: 'Radio',
  billboard: 'Billboard',
  event: 'Event',
  other: 'Other',
};

export const CampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  channel: CampaignChannelSchema,
  periodStart: isoDate,
  /** Null while the campaign is still running. */
  periodEnd: isoDate.nullable(),
  /**
   * Spend to date: the live (not voided) dated spend entries added up on read. Since migration
   * 0038 spend is entered by date (`CampaignSpendEntry`), so a reporting period can take its own
   * share; the old single total became one entry dated at the campaign's start.
   */
  spend: z.number(),
  /** Live dated spend entries behind `spend`. */
  spendEntryCount: z.number().int().nonnegative(),
  ownerEmployeeId: z.string().nullable(),
  ownerName: z.string().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
  /** Leads attributed to it, counted on read. */
  leadCount: z.number().int().nonnegative(),
  /** Of those leads, how many were converted into a candidate (a hiring case), to date. */
  candidateCount: z.number().int().nonnegative(),
  /** Of those leads, how many reached a hire (Hired or Active driver), to date. */
  hireCount: z.number().int().nonnegative(),
  /** Live (not voided) cost entries charged to the campaign itself, e.g. per-lead fees. */
  acquisitionCost: z.number(),
  /** Spend as entered plus the campaign's own cost entries. */
  totalCost: z.number(),
  /** totalCost over leads to date; null with no leads (never a zero standing in for "unknown"). */
  costPerLead: z.number().nullable(),
  /** totalCost over hires to date; null with no hires. */
  costPerHire: z.number().nullable(),
  createdAt: isoDateTime,
});
export type Campaign = z.infer<typeof CampaignSchema>;

/** The editable fields, without defaults: an edit carries only what it changes. */
const CampaignFieldsBase = z.object({
  name: z.string().trim().min(1, 'Give the campaign a name').max(120),
  channel: CampaignChannelSchema,
  periodStart: isoDate,
  periodEnd: isoDate.nullable(),
  ownerEmployeeId: z.string().nullable(),
  notes: z.string().trim().max(2000).nullable(),
  active: z.boolean(),
});
const CampaignFieldsSchema = CampaignFieldsBase.extend({
  periodEnd: isoDate.nullable().default(null),
  /**
   * Create only: what was already spent when the campaign is set up. Recorded as the campaign's
   * first dated spend entry, on its start date. Later spend is added as entries of its own.
   */
  spend: money.default(0),
  ownerEmployeeId: z.string().nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
  active: z.boolean().default(true),
});
const endNotBeforeStart = (v: { periodStart?: string; periodEnd?: string | null }) =>
  !v.periodStart || !v.periodEnd || v.periodEnd >= v.periodStart;
export const CreateCampaignSchema = CampaignFieldsSchema.refine(endNotBeforeStart, {
  message: 'The end date is before the start date',
  path: ['periodEnd'],
});
export type CreateCampaignInput = z.input<typeof CreateCampaignSchema>;
export type CreateCampaignRequest = z.infer<typeof CreateCampaignSchema>;
/**
 * Spend is not edited here: it is the sum of the dated entries (`/campaigns/:id/spend`). Built
 * from the fields without defaults - zod 4 fills a default inside `.partial()`, which made an
 * edit that left out the notes, owner or end date wipe them.
 */
export const UpdateCampaignSchema = CampaignFieldsBase.partial().refine(endNotBeforeStart, {
  message: 'The end date is before the start date',
  path: ['periodEnd'],
});
export type UpdateCampaignRequest = z.infer<typeof UpdateCampaignSchema>;

// ------------------------------------------------------------------------- campaign spend

/**
 * One dated payment on a campaign: an invoice from the job board, a month of an agency's fee. The
 * campaign's spend is these added up on read; a reporting period takes the entries dated inside
 * it. Wrong entries are voided (kept, with who, when and why), never deleted; an edit names the
 * version it read and a stale one is refused.
 */
export const CampaignSpendEntrySchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  /** The business date the money was spent (US Eastern calendar date). */
  spentOn: isoDate,
  amount: z.number(),
  note: z.string().nullable(),
  recordedBy: z.string(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  version: z.number().int().positive(),
  voidedAt: isoDateTime.nullable(),
  voidedBy: z.string().nullable(),
  voidReason: z.string().nullable(),
});
export type CampaignSpendEntry = z.infer<typeof CampaignSpendEntrySchema>;

const positiveMoney = money.refine((v) => v > 0, 'Enter an amount above $0');

export const CreateCampaignSpendSchema = z.object({
  spentOn: isoDate,
  amount: positiveMoney,
  note: z.string().trim().max(500).nullable().default(null),
  /** One key per form: a double click or a resend finds the first entry instead of adding one. */
  clientKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,80}$/, 'Not a request key')
    .nullable()
    .default(null),
});
export type CreateCampaignSpendInput = z.input<typeof CreateCampaignSpendSchema>;
export type CreateCampaignSpendRequest = z.infer<typeof CreateCampaignSpendSchema>;

export const UpdateCampaignSpendSchema = z.object({
  /** The version the editor read; a save against an older one is refused as a conflict. */
  version: z.number().int().positive(),
  spentOn: isoDate.optional(),
  amount: positiveMoney.optional(),
  note: z.string().trim().max(500).nullable().optional(),
});
export type UpdateCampaignSpendRequest = z.infer<typeof UpdateCampaignSpendSchema>;

export const VoidCampaignSpendSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().min(1, 'Say why the entry is voided').max(400),
});
export type VoidCampaignSpendRequest = z.infer<typeof VoidCampaignSpendSchema>;

// ----------------------------------------------------------------------------------- ledger

export const COST_TYPES = [
  'lead_acquisition',
  'mvr',
  'psp',
  'clearinghouse',
  'drug_test',
  'background_check',
  'travel',
  'lodging',
  'orientation_pay',
  'sign_on_bonus',
  'referral_bonus',
  'other',
] as const;
export const CostTypeSchema = z.enum(COST_TYPES);
export type CostType = z.infer<typeof CostTypeSchema>;

export const COST_TYPE_LABELS: Readonly<Record<CostType, string>> = {
  lead_acquisition: 'Lead acquisition',
  mvr: 'MVR',
  psp: 'PSP',
  clearinghouse: 'Clearinghouse query',
  drug_test: 'Drug test',
  background_check: 'Background check',
  travel: 'Travel',
  lodging: 'Lodging',
  orientation_pay: 'Orientation pay',
  sign_on_bonus: 'Sign-on bonus',
  referral_bonus: 'Referral bonus',
  other: 'Other',
};

export const COST_SOURCES = ['manual', 'auto'] as const;
export type CostSource = (typeof COST_SOURCES)[number];

// ------------------------------------------------------------------- posting to Accounting

/**
 * Candidate costs are posted to Accounting as expenses (owner, 2026-10-01). The permission a
 * person needs to post: the one Accounting's own expense route asks for.
 */
export const ACCOUNTING_POST_PERMISSION = 'accounting.edit';
/** The Accounting expense category a candidate cost posts under (account 6700). */
export const RECRUITING_EXPENSE_CATEGORY = 'recruiting';
/** Where the expense says it came from; its source key is `recruiting:<cost id>`. */
export const RECRUITING_EXPENSE_SOURCE = 'recruiting';

/**
 * Which automatic costs post: the real money spent on the candidate — travel, lodging,
 * orientation pay and the offer's bonuses at hire. Every cost a person enters posts too.
 * Automatic screening lines are priced from the unit costs in Settings; the screening vendor's
 * invoice is the expense, booked in Accounting on its own, so posting the estimate as well would
 * count the same check twice.
 */
export const AUTO_POSTED_COST_TYPES: ReadonlySet<CostType> = new Set<CostType>([
  'travel',
  'lodging',
  'orientation_pay',
  'sign_on_bonus',
  'referral_bonus',
]);

export function costPostsToAccounting(entry: { source: string; type: string; costOwner?: string; approvalStatus?: string }): boolean {
  // Journey v2 (owner, 2026-10-11): only the company's own cost, once approved, is a company
  // expense. The driver's own cost never is; a planned or rejected one is not booked yet.
  if (entry.costOwner && entry.costOwner !== 'company') return false;
  if (entry.approvalStatus && entry.approvalStatus !== 'approved') return false;
  return entry.source === 'manual' || AUTO_POSTED_COST_TYPES.has(entry.type as CostType);
}

/**
 *   posted          posted to Accounting from this cost, and the expense matches it
 *   attributed      this cost was attributed from an expense Accounting already had
 *   not_posted      should be in Accounting and is not (nobody with the permission has saved it
 *                   yet, or Accounting refused); `message` says which
 *   needs_update    posted, but the cost was re-priced from its record since; the expense still
 *                   shows the old amount or date
 *   needs_void      the cost is voided and the expense it posted is still live in Accounting
 *   voided          the cost is voided, and so is the expense it posted (or it never posted)
 *   not_applicable  an automatic screening estimate; not an Accounting expense
 */
export const COST_ACCOUNTING_STATES = [
  'posted',
  'attributed',
  'not_posted',
  'needs_update',
  'needs_void',
  'voided',
  'not_applicable',
] as const;
export type CostAccountingState = (typeof COST_ACCOUNTING_STATES)[number];

export const CostAccountingSchema = z.object({
  state: z.enum(COST_ACCOUNTING_STATES),
  expenseId: z.string().nullable(),
  expenseNumber: z.string().nullable(),
  /** The expense's status in Accounting: posted, draft or void. */
  expenseStatus: z.string().nullable(),
  /** In words: what was posted, why it is not, or what putting it right needs. */
  message: z.string().nullable(),
  /** Someone with `accounting.edit` can put it right with one click (post, update or void). */
  actionable: z.boolean(),
});
export type CostAccounting = z.infer<typeof CostAccountingSchema>;

export const CostEntrySchema = z.object({
  id: z.string(),
  hiringCaseId: z.string().nullable(),
  leadId: z.string().nullable(),
  campaignId: z.string().nullable(),
  type: CostTypeSchema,
  amount: z.number(),
  incurredOn: isoDate,
  /** `auto` when the system priced it from a record; `manual` when a person typed it. */
  source: z.enum(COST_SOURCES),
  /** The record an auto entry was priced from (`doc:…`, `ticket:…`, `orientation:…`, `offer:…`). */
  sourceRef: z.string().nullable(),
  note: z.string().nullable(),
  recordedBy: z.string(),
  /** The receipt, in stored files (`GET /files/:id`). */
  receiptFileId: z.string().nullable(),
  /**
   * The Accounting expense behind this cost: the one it was attributed from, or the one posting
   * it created (`accounting.state` says which).
   */
  accountingExpenseId: z.string().nullable(),
  /** Where the cost stands in Accounting, derived on read from the linked expense. */
  accounting: CostAccountingSchema,
  /** A voided entry is kept for the record and left out of every total. */
  voidedAt: isoDateTime.nullable(),
  voidedBy: z.string().nullable(),
  voidReason: z.string().nullable(),
  createdAt: isoDateTime,
});
export type CostEntry = z.infer<typeof CostEntrySchema>;

export const CreateCostEntrySchema = z
  .object({
    hiringCaseId: z.string().nullable().default(null),
    leadId: z.string().nullable().default(null),
    campaignId: z.string().nullable().default(null),
    type: CostTypeSchema,
    amount: money,
    incurredOn: isoDate,
    note: z.string().trim().max(500).nullable().default(null),
    /**
     * Generated once per form by the client and sent with every retry of the same save, so a
     * double click or a resend after a timeout finds the first entry instead of adding a second.
     */
    clientKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,80}$/, 'Not a request key')
      .nullable()
      .default(null),
    /** A receipt already uploaded through `POST /files`. */
    receiptFileId: z.string().max(80).nullable().default(null),
    /**
     * The cost was already booked in Accounting: attribute that expense to the candidate instead
     * of typing a second copy. Amount and date are then taken from the expense.
     */
    accountingExpenseId: z.string().max(80).nullable().default(null),
  })
  .refine((v) => v.hiringCaseId !== null || v.leadId !== null, {
    message: 'A cost is against a case or a lead',
  })
  .refine((v) => v.accountingExpenseId !== null || v.amount > 0, {
    message: 'Enter an amount above $0',
    path: ['amount'],
  });
export type CreateCostEntryInput = z.input<typeof CreateCostEntrySchema>;
export type CreateCostEntryRequest = z.infer<typeof CreateCostEntrySchema>;

export const CostQuerySchema = z.object({
  hiringCaseId: z.string().optional(),
  leadId: z.string().optional(),
  campaignId: z.string().optional(),
  type: CostTypeSchema.optional(),
});
export type CostQuery = z.infer<typeof CostQuerySchema>;

export const VoidCostEntrySchema = z.object({
  reason: z.string().trim().min(1, 'Say why the entry is voided').max(400),
});
export type VoidCostEntryRequest = z.infer<typeof VoidCostEntrySchema>;

// ------------------------------------------------------------------------------- categories

/**
 * The five groups the candidate's Costs tab shows. A grouping of the stored cost types, not a new
 * field: every type belongs to exactly one group.
 */
export const COST_CATEGORIES = ['screening', 'travel', 'orientation', 'bonuses', 'other'] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export const COST_CATEGORY_LABELS: Readonly<Record<CostCategory, string>> = {
  screening: 'Screening',
  travel: 'Travel',
  orientation: 'Orientation',
  bonuses: 'Bonuses',
  other: 'Other',
};

export const COST_CATEGORY_OF_TYPE: Readonly<Record<CostType, CostCategory>> = {
  mvr: 'screening',
  psp: 'screening',
  clearinghouse: 'screening',
  drug_test: 'screening',
  background_check: 'screening',
  travel: 'travel',
  lodging: 'travel',
  orientation_pay: 'orientation',
  sign_on_bonus: 'bonuses',
  referral_bonus: 'bonuses',
  lead_acquisition: 'other',
  other: 'other',
};

// -------------------------------------------------------------------------- unit costs

/** The Admin → Settings keys that price a check when its report is filed. */
export const UNIT_COST_SETTING_KEYS = {
  mvr: 'hiring.cost.mvr',
  psp: 'hiring.cost.psp',
  clearinghouse: 'hiring.cost.clearinghouse',
  drug_test: 'hiring.cost.drug_test',
} as const;

export const DEFAULT_UNIT_COSTS: Readonly<Record<keyof typeof UNIT_COST_SETTING_KEYS, number>> = {
  mvr: 18,
  psp: 10,
  clearinghouse: 1.25,
  drug_test: 65,
};

/** Which filed report prices which cost type. Background checks are invoiced per vendor, so no default. */
export const COST_TYPE_BY_REQUIREMENT: Readonly<
  Record<string, keyof typeof UNIT_COST_SETTING_KEYS>
> = {
  mvr_review: 'mvr',
  psp_review: 'psp',
  clearinghouse_query: 'clearinghouse',
  pre_employment_drug_test: 'drug_test',
};

// ------------------------------------------------------------------------------- arithmetic

export interface CostSummary {
  total: number;
  byType: Partial<Record<CostType, number>>;
  entries: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Totals on read; nothing stores them. A voided entry counts for nothing. */
export function sumCosts(
  entries: readonly (Pick<CostEntry, 'type' | 'amount'> & { voidedAt?: string | null })[],
): CostSummary {
  const byType: Partial<Record<CostType, number>> = {};
  let total = 0;
  let counted = 0;
  for (const e of entries) {
    if (e.voidedAt) continue;
    counted += 1;
    byType[e.type] = round((byType[e.type] ?? 0) + e.amount);
    total += e.amount;
  }
  return { total: round(total), byType, entries: counted };
}

// --------------------------------------------------------------------- campaign performance

/**
 * Spend entries added up: the live ones, optionally only those dated inside `[from, to]`
 * (inclusive calendar dates). The one definition of "campaign spend in a period".
 */
export function sumSpend(
  entries: readonly { campaignId: string; amount: number; spentOn: string; voidedAt?: string | null }[],
  campaignId: string | null,
  period?: { from: string; to: string },
): number {
  let total = 0;
  for (const e of entries) {
    if (e.voidedAt) continue;
    if (campaignId !== null && e.campaignId !== campaignId) continue;
    if (period && (e.spentOn < period.from || e.spentOn > period.to)) continue;
    total += e.amount;
  }
  return round(total);
}

/**
 * One campaign's results to date: the single definition the Campaigns tab shares with the
 * to-date figures in Analytics. `spend` is the campaign's dated spend entries added up (all of
 * them); Analytics scopes the same entries to its period with `sumSpend`.
 */
export function campaignPerformance(input: {
  campaignId: string;
  spend: number;
  leads: readonly { campaignId: string | null; hiringCaseId: string | null }[];
  hiredCaseIds: ReadonlySet<string>;
  /** Cost entries already filtered to live (not voided) ones. */
  costs: readonly { campaignId: string | null; amount: number }[];
}): Pick<
  Campaign,
  | 'leadCount'
  | 'candidateCount'
  | 'hireCount'
  | 'acquisitionCost'
  | 'totalCost'
  | 'costPerLead'
  | 'costPerHire'
> {
  const mine = input.leads.filter((l) => l.campaignId === input.campaignId);
  const candidates = mine.filter((l) => l.hiringCaseId !== null);
  const hires = candidates.filter((l) => input.hiredCaseIds.has(l.hiringCaseId as string));
  const acquisitionCost = round(
    input.costs
      .filter((c) => c.campaignId === input.campaignId)
      .reduce((s, c) => s + c.amount, 0),
  );
  const totalCost = round(input.spend + acquisitionCost);
  return {
    leadCount: mine.length,
    candidateCount: candidates.length,
    hireCount: hires.length,
    acquisitionCost,
    totalCost,
    costPerLead: mine.length > 0 ? round(totalCost / mine.length) : null,
    costPerHire: hires.length > 0 ? round(totalCost / hires.length) : null,
  };
}
