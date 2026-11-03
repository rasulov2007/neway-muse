import { z } from 'zod';
import { APPLICANT_SOURCES } from '../hr/recruiting.js';
import { CDL_CLASSES, DRIVER_TYPES } from '../roster/roster.js';
import { LeadApplicationSummarySchema } from './apply.js';

/**
 * The front of the funnel: a lead, and whether they prequalify.
 *
 * A lead is a phone number and a name. It is deliberately less than an applicant: nothing here
 * creates an employee, a driver or a qualification file. Converting a lead is what creates the
 * applicant and the hiring case; until then the lead is a record of a conversation and its cost.
 *
 * Prequalification stores the answers, not a verdict. The verdict is derived by `prequalify()`
 * from the company's rules — which live in Admin → Settings with their provenance line — so a rule
 * change re-reads every lead the same way, and the screen can say which rule failed rather than
 * "does not qualify".
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/** `no_answer`: called, nobody answered (owner, 2026-10-12); calling again is the next step. */
export const LEAD_STATUSES = ['new', 'no_answer', 'contacted', 'prequalified', 'converted', 'dead'] as const;
export const LeadStatusSchema = z.enum(LEAD_STATUSES);
export type LeadStatus = z.infer<typeof LeadStatusSchema>;

export const LEAD_STATUS_LABELS: Readonly<Record<LeadStatus, string>> = {
  new: 'New',
  no_answer: 'Called · no answer',
  contacted: 'Contacted',
  prequalified: 'Prequalified',
  converted: 'Converted',
  dead: 'Dead',
};

/** The endorsements a CDL can carry, as the driver record stores them. */
export const CDL_ENDORSEMENTS = ['H', 'N', 'T', 'X'] as const;
export const CdlEndorsementSchema = z.enum(CDL_ENDORSEMENTS);

export const CDL_ENDORSEMENT_LABELS: Readonly<Record<(typeof CDL_ENDORSEMENTS)[number], string>> = {
  H: 'Hazmat',
  N: 'Tank',
  T: 'Doubles/triples',
  X: 'Tank + hazmat',
};

/** The answers a recruiter records on the first real call. Stored as given; never a verdict. */
export const PrequalificationSchema = z.object({
  /** Stored as the fact the rule needs, not the date of birth. */
  age23Plus: z.boolean(),
  cdlHeldYears: z.number().min(0).max(60),
  otrExperienceYears: z.number().min(0).max(60),
  accidents36mo: z.number().int().min(0).max(50),
  movingViolations36mo: z.number().int().min(0).max(50),
  duiEver: z.boolean(),
  endorsements: z.array(CdlEndorsementSchema).default([]),
  /** The company's real pay types; there is no fourth. */
  payTypePreference: z.enum(DRIVER_TYPES).nullable().default(null),
  homeState: z.string().trim().length(2).toUpperCase(),
  earliestStartDate: isoDate.nullable().default(null),
  recordedAt: z.string().datetime().optional(),
  recordedBy: z.string().optional(),
});
export type Prequalification = z.infer<typeof PrequalificationSchema>;
export type PrequalificationInput = z.input<typeof PrequalificationSchema>;

/**
 * The company's auto-flag rules. Each is a setting key; the values shown here are defaults for a
 * company that has never changed them. `null` on a threshold means the rule is switched off.
 */
export interface PrequalificationRules {
  requireAge23: boolean;
  minCdlYears: number | null;
  minExperienceYears: number | null;
  maxAccidents36mo: number | null;
  maxViolations36mo: number | null;
  duiDisqualifies: boolean;
}

export const DEFAULT_PREQUALIFICATION_RULES: PrequalificationRules = {
  requireAge23: true,
  minCdlYears: 2,
  minExperienceYears: 2,
  maxAccidents36mo: 2,
  maxViolations36mo: 3,
  duiDisqualifies: true,
};

/** Setting keys, so the settings registry and this evaluator cannot disagree on a name. */
export const PREQUAL_SETTING_KEYS = {
  requireAge23: 'hiring.prequal.require_age_23',
  minCdlYears: 'hiring.prequal.min_cdl_years',
  minExperienceYears: 'hiring.prequal.min_experience_years',
  maxAccidents36mo: 'hiring.prequal.max_accidents_36mo',
  maxViolations36mo: 'hiring.prequal.max_violations_36mo',
  duiDisqualifies: 'hiring.prequal.dui_disqualifies',
} as const;

export interface FailedRule {
  /** The setting key of the rule that failed. */
  rule: string;
  label: string;
  /** What was answered against what the rule allows, e.g. "3 accidents in 36 months; at most 2". */
  detail: string;
}

export interface PrequalificationResult {
  qualifies: boolean;
  failed: FailedRule[];
}

/** Pure. The same answers and the same rules always give the same verdict, with the reasons. */
export function prequalify(
  answers: Prequalification,
  rules: PrequalificationRules,
): PrequalificationResult {
  const failed: FailedRule[] = [];
  if (rules.requireAge23 && !answers.age23Plus) {
    failed.push({
      rule: PREQUAL_SETTING_KEYS.requireAge23,
      label: 'Under 23',
      detail: 'Must be 23 or older',
    });
  }
  if (rules.minCdlYears !== null && answers.cdlHeldYears < rules.minCdlYears) {
    failed.push({
      rule: PREQUAL_SETTING_KEYS.minCdlYears,
      label: 'CDL held too briefly',
      detail: `CDL held ${answers.cdlHeldYears} yr; at least ${rules.minCdlYears} required`,
    });
  }
  if (rules.minExperienceYears !== null && answers.otrExperienceYears < rules.minExperienceYears) {
    failed.push({
      rule: PREQUAL_SETTING_KEYS.minExperienceYears,
      label: 'Not enough OTR experience',
      detail: `${answers.otrExperienceYears} yr verifiable OTR; at least ${rules.minExperienceYears} required`,
    });
  }
  if (rules.maxAccidents36mo !== null && answers.accidents36mo > rules.maxAccidents36mo) {
    failed.push({
      rule: PREQUAL_SETTING_KEYS.maxAccidents36mo,
      label: 'Too many accidents',
      detail: `${answers.accidents36mo} accidents in 36 months; at most ${rules.maxAccidents36mo}`,
    });
  }
  if (rules.maxViolations36mo !== null && answers.movingViolations36mo > rules.maxViolations36mo) {
    failed.push({
      rule: PREQUAL_SETTING_KEYS.maxViolations36mo,
      label: 'Too many moving violations',
      detail: `${answers.movingViolations36mo} moving violations in 36 months; at most ${rules.maxViolations36mo}`,
    });
  }
  if (rules.duiDisqualifies && answers.duiEver) {
    failed.push({
      rule: PREQUAL_SETTING_KEYS.duiDisqualifies,
      label: 'DUI on record',
      detail: 'A DUI disqualifies under company policy',
    });
  }
  return { qualifies: failed.length === 0, failed };
}

// -------------------------------------------------------------------------------------- leads

export const LeadSchema = z.object({
  id: z.string(),
  leadNumber: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  cdlClass: z.enum(CDL_CLASSES).nullable(),
  state: z.string().nullable(),
  /** Self-reported on first contact; the prequalification answer supersedes it. */
  yearsExperience: z.number().nullable(),
  source: z.enum(APPLICANT_SOURCES),
  /** Arrives with the cost ledger; a column now so early leads can be attributed later. */
  campaignId: z.string().nullable(),
  recruiterEmployeeId: z.string().nullable(),
  recruiterName: z.string().nullable(),
  notes: z.string().nullable(),
  status: LeadStatusSchema,
  prequalification: PrequalificationSchema.nullable(),
  /** The verdict against the rules in force when it was last evaluated. Null until prequalified. */
  prequalResult: z
    .object({
      qualifies: z.boolean(),
      failed: z.array(z.object({ rule: z.string(), label: z.string(), detail: z.string() })),
      evaluatedAt: z.string(),
    })
    .nullable(),
  applicantId: z.string().nullable(),
  hiringCaseId: z.string().nullable(),
  deadReason: z.string().nullable(),
  /** Online applications on file for this lead; 0 for a lead added by hand. */
  applicationCount: z.number().int(),
  /** When the most recent online application arrived. */
  lastAppliedAt: z.string().nullable(),
  /** The most recent online application's answers, so the list can show them unopened. */
  latestApplication: LeadApplicationSummarySchema.nullable(),
  createdAt: z.string(),
  contactedAt: z.string().nullable(),
  prequalifiedAt: z.string().nullable(),
  convertedAt: z.string().nullable(),
  deadAt: z.string().nullable(),
});
export type Lead = z.infer<typeof LeadSchema>;

export const CreateLeadSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required').max(40),
  lastName: z.string().trim().min(1, 'Last name is required').max(40),
  phone: z.string().trim().min(7, 'A phone number is required').max(20),
  email: z
    .string()
    .trim()
    .email()
    .nullish()
    .transform((v) => v || null),
  cdlClass: z
    .enum(CDL_CLASSES)
    .nullish()
    .transform((v) => v ?? null),
  state: z
    .string()
    .trim()
    .length(2)
    .toUpperCase()
    .nullish()
    .transform((v) => v ?? null),
  yearsExperience: z
    .number()
    .min(0)
    .max(60)
    .nullish()
    .transform((v) => v ?? null),
  source: z.enum(APPLICANT_SOURCES),
  campaignId: z
    .string()
    .nullish()
    .transform((v) => v || null),
  recruiterEmployeeId: z
    .string()
    .nullish()
    .transform((v) => v || null),
  notes: z
    .string()
    .trim()
    .max(2000)
    .nullish()
    .transform((v) => v || null),
});
export type CreateLeadInput = z.input<typeof CreateLeadSchema>;

export const UpdateLeadSchema = CreateLeadSchema.partial();

export const DisqualifyLeadSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(400),
});

/** Reopening a disqualified lead needs a note saying why (owner, 2026-10-09). */
export const ReopenLeadSchema = z.object({
  note: z.string().trim().min(3, 'Write a short note saying why').max(1000),
});

/** Columns the leads list can be ordered by. */
export const LEAD_SORT_KEYS = [
  'name',
  'status',
  'source',
  'cdlClass',
  'yearsExperience',
  'recruiter',
  'createdAt',
] as const;
export type LeadSortKey = (typeof LEAD_SORT_KEYS)[number];

export const LeadQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().min(1).optional(),
  status: LeadStatusSchema.optional(),
  source: z.enum(APPLICANT_SOURCES).optional(),
  recruiterEmployeeId: z.string().optional(),
  campaignId: z.string().max(80).optional(),
  /** `flagged` = prequalified with a failed rule and not yet disqualified. */
  flagged: z
    .union([z.boolean(), z.literal('true'), z.literal('false')])
    .transform((v) => v === true || v === 'true')
    .optional(),
  /** Added on or after / on or before these business dates, read in the company's time zone. */
  from: isoDate.optional(),
  to: isoDate.optional(),
  sort: z.enum(LEAD_SORT_KEYS).default('createdAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type LeadQuery = z.infer<typeof LeadQuerySchema>;

/** The period the count tiles cover: leads added between these business dates. */
export const LeadSummaryQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type LeadSummaryQuery = z.infer<typeof LeadSummaryQuerySchema>;

/** The count tiles above the list. `newToday` is against the company's today. */
export const LeadSummarySchema = z.object({
  total: z.number(),
  newToday: z.number(),
  uncontacted: z.number(),
  contacted: z.number(),
  prequalified: z.number(),
  flagged: z.number(),
  converted: z.number(),
  dead: z.number(),
  /** DOT applications a driver submitted through the link, waiting for a recruiter's review. */
  dotReviews: z.number().optional(),
});
export type LeadSummary = z.infer<typeof LeadSummarySchema>;
