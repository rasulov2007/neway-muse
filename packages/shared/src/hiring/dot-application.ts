import { z } from 'zod';

/**
 * The DOT employment application, 49 CFR 391.21.
 *
 * What the rule asks for, and nothing the rule does not: three years of addresses, licences held,
 * the employers of the last three years (ten for anyone who drove a commercial vehicle), accidents
 * and convictions in the last three years, whether a licence was ever denied or revoked, and the
 * applicant's own certification that it is true. The recruiter records it; the system renders it
 * as the PDF the qualification file keeps.
 *
 * Nothing here is a copy of the qualification file. The application row holds the answers and
 * points at the document the answers became; the document is the DQF's, not this module's.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const isoDateTime = z.string().datetime();
const shortText = z.string().trim().min(1).max(200);

/**
 * draft · driver_submitted (the driver certified it through the link; a recruiter has not yet
 * accepted it into the qualification file) · submitted (filed).
 */
export const DOT_APPLICATION_STATUSES = ['draft', 'driver_submitted', 'submitted'] as const;
export const DotApplicationStatusSchema = z.enum(DOT_APPLICATION_STATUSES);
export type DotApplicationStatus = z.infer<typeof DotApplicationStatusSchema>;

/** How far back the rule looks. */
export const ADDRESS_HISTORY_YEARS = 3;
export const EMPLOYMENT_HISTORY_YEARS = 3;
export const CMV_EMPLOYMENT_HISTORY_YEARS = 10;
export const INCIDENT_HISTORY_YEARS = 3;
/** A break between employers this long or longer has to be explained (391.21(b)(10)). */
export const EMPLOYMENT_GAP_DAYS = 30;

export const AddressEntrySchema = z.object({
  street: shortText,
  city: shortText,
  state: z.string().trim().length(2).toUpperCase(),
  zip: z.string().trim().min(3).max(10),
  from: isoDate,
  /** Null while still living there. */
  to: isoDate.nullable(),
});
export type AddressEntry = z.infer<typeof AddressEntrySchema>;

export const LicenseEntrySchema = z.object({
  state: z.string().trim().length(2).toUpperCase(),
  number: shortText,
  licenseClass: z.enum(['A', 'B', 'C']),
  endorsements: z.array(z.string().trim().min(1).max(3)).max(8).default([]),
  expiresOn: isoDate,
});
export type LicenseEntry = z.infer<typeof LicenseEntrySchema>;

/**
 * One employer, or one explained gap. A gap is an entry on purpose: the rule wants the timeline
 * accounted for, and "unemployed, March to May" is an answer, not a missing one.
 */
export const EmploymentEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('employer'),
    employer: shortText,
    address: z.string().trim().max(300).nullable(),
    phone: z.string().trim().max(40).nullable(),
    contactName: z.string().trim().max(120).nullable(),
    position: shortText,
    from: isoDate,
    to: isoDate.nullable(),
    reasonForLeaving: z.string().trim().max(300).nullable(),
    /** Did the job involve driving a commercial motor vehicle? Sets the ten-year window. */
    droveCmv: z.boolean(),
    /** Was the employer subject to the FMCSRs? Those are the ones verified under 391.23. */
    dotRegulated: z.boolean(),
    /** Was the position subject to Part 382 drug and alcohol testing? */
    subjectToDrugTesting: z.boolean(),
  }),
  z.object({
    kind: z.literal('gap'),
    from: isoDate,
    to: isoDate.nullable(),
    explanation: shortText,
  }),
]);
export type EmploymentEntry = z.infer<typeof EmploymentEntrySchema>;
export type EmployerEntry = Extract<EmploymentEntry, { kind: 'employer' }>;

export const AccidentEntrySchema = z.object({
  date: isoDate,
  location: shortText,
  nature: shortText,
  fatalities: z.number().int().nonnegative(),
  injuries: z.number().int().nonnegative(),
  hazmatSpill: z.boolean(),
});
export type AccidentEntry = z.infer<typeof AccidentEntrySchema>;

export const ConvictionEntrySchema = z.object({
  date: isoDate,
  location: shortText,
  offense: shortText,
  penalty: z.string().trim().max(200).nullable(),
});
export type ConvictionEntry = z.infer<typeof ConvictionEntrySchema>;

/**
 * The answers as given. Every list may be empty in a draft; `checkDotApplication` says what a
 * submission still needs.
 */
export const DotApplicationFormSchema = z.object({
  legalFirstName: shortText,
  legalMiddleName: z.string().trim().max(100).nullable(),
  legalLastName: shortText,
  dateOfBirth: isoDate,
  addresses: z.array(AddressEntrySchema).max(20).default([]),
  licenses: z.array(LicenseEntrySchema).max(10).default([]),
  employment: z.array(EmploymentEntrySchema).max(40).default([]),
  accidents: z.array(AccidentEntrySchema).max(20).default([]),
  convictions: z.array(ConvictionEntrySchema).max(20).default([]),
  licenseDeniedOrRevoked: z.boolean(),
  licenseDeniedOrRevokedDetail: z.string().trim().max(500).nullable(),
  /** The applicant's typed name under the certification statement. Null until they sign. */
  certifiedName: z.string().trim().max(120).nullable(),
  certifiedOn: isoDate.nullable(),
});
export type DotApplicationForm = z.infer<typeof DotApplicationFormSchema>;
export type DotApplicationFormInput = z.input<typeof DotApplicationFormSchema>;

/** What the desk sends. The SSN travels once, on save; it never comes back. */
export const SaveDotApplicationSchema = DotApplicationFormSchema.extend({
  ssn: z
    .string()
    .trim()
    .regex(/^\d{3}-?\d{2}-?\d{4}$/, 'A social security number is nine digits')
    .nullish(),
});
export type SaveDotApplicationInput = z.input<typeof SaveDotApplicationSchema>;

export const DotApplicationSchema = z.object({
  id: z.string(),
  hiringCaseId: z.string(),
  applicantId: z.string(),
  status: DotApplicationStatusSchema,
  form: DotApplicationFormSchema,
  /**
   * The last four digits, or null if none was given. The full number is sealed at rest and
   * printed only on the PDF.
   */
  ssnLast4: z.string().nullable(),
  /** The qualification-file document the submission produced. */
  documentId: z.string().nullable(),
  /** The driver id the file is keyed by, reserved at submission. */
  driverId: z.string().nullable(),
  verificationCaseId: z.string().nullable(),
  /** Previous-employer verification consents drafted from the DOT-regulated employers listed. */
  consentIds: z.array(z.string()),
  submittedAt: isoDateTime.nullable(),
  submittedBy: z.string().nullable(),
  /** 'driver_link' when the driver certified it through the link sent by recruiting. */
  submittedVia: z.string().nullable(),
  /** The driver's certification as it was frozen at Submit. */
  certifiedAt: isoDateTime.nullable(),
  certifiedName: z.string().nullable(),
  /** Who accepted the driver's submission into the qualification file. */
  reviewedAt: isoDateTime.nullable(),
  reviewedBy: z.string().nullable(),
  /** The latest return to the driver, with the recruiter's note. */
  returnedAt: isoDateTime.nullable(),
  returnedBy: z.string().nullable(),
  returnNote: z.string().nullable(),
  updatedAt: isoDateTime,
});
export type DotApplication = z.infer<typeof DotApplicationSchema>;

// ------------------------------------------------------------------------------------ checks

export interface DotApplicationIssue {
  /** Which section the issue is in, so the form can point at it. */
  section: 'identity' | 'addresses' | 'licenses' | 'employment' | 'incidents' | 'certification';
  detail: string;
}

const DAY = 86_400_000;

function parse(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The same calendar date `years` earlier (29 February falls back to 1 March). */
export function yearsBefore(date: string, years: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/**
 * Whether a set of dated entries covers `start` to `end`, and where it does not. Entries may
 * overlap; an open `to` runs to `end`. Gaps of `toleranceDays` or less are ignored.
 */
export function coverage(
  entries: readonly { from: string; to: string | null }[],
  window: { start: string; end: string },
  toleranceDays: number,
): { covered: boolean; gaps: { from: string; to: string }[] } {
  const today = parse(window.end);
  const start = parse(window.start);
  const spans = entries
    .map((e) => ({ from: parse(e.from), to: e.to ? parse(e.to) : today }))
    .filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to) && s.to >= s.from)
    .sort((a, b) => a.from - b.from);
  const gaps: { from: string; to: string }[] = [];
  let cursor = start;
  for (const span of spans) {
    if (span.to < cursor) continue;
    if (span.from - cursor > toleranceDays * DAY) {
      gaps.push({ from: iso(cursor), to: iso(span.from) });
    }
    cursor = Math.max(cursor, span.to);
  }
  if (today - cursor > toleranceDays * DAY) gaps.push({ from: iso(cursor), to: iso(today) });
  return { covered: gaps.length === 0 && spans.length > 0, gaps };
}

/**
 * Everything a submission still needs. Empty means the application can be submitted.
 *
 * The rule is read literally: three years of addresses with no gap, at least one licence,
 * employment accounted for across three years with any break of a month or more explained, ten
 * years of commercial-driving employers when the applicant has driven one, incidents inside their
 * three-year window, and a signed certification. A draft can fail every one of these.
 */
export function checkDotApplication(form: DotApplicationForm, now: Date): DotApplicationIssue[] {
  const issues: DotApplicationIssue[] = [];
  const today = now.toISOString().slice(0, 10);

  if (form.dateOfBirth >= today) {
    issues.push({ section: 'identity', detail: 'Date of birth must be in the past' });
  }

  if (form.addresses.length === 0) {
    issues.push({ section: 'addresses', detail: 'At least one address is required' });
  } else {
    const window = { start: yearsBefore(today, ADDRESS_HISTORY_YEARS), end: today };
    for (const gap of coverage(form.addresses, window, 1).gaps) {
      issues.push({
        section: 'addresses',
        detail: `Addresses do not cover ${gap.from} to ${gap.to}; the last ${ADDRESS_HISTORY_YEARS} years must be accounted for`,
      });
    }
  }

  if (form.licenses.length === 0) {
    issues.push({ section: 'licenses', detail: 'At least one licence is required' });
  }

  if (form.employment.length === 0) {
    issues.push({ section: 'employment', detail: 'Employment history is required' });
  } else {
    const window = { start: yearsBefore(today, EMPLOYMENT_HISTORY_YEARS), end: today };
    for (const gap of coverage(form.employment, window, EMPLOYMENT_GAP_DAYS).gaps) {
      issues.push({
        section: 'employment',
        detail: `Employment is not accounted for from ${gap.from} to ${gap.to}; add the employer or explain the gap`,
      });
    }
    const cmvJobs = form.employment.filter((e) => e.kind === 'employer' && e.droveCmv);
    const earliestCmv = cmvJobs.map((e) => e.from).sort()[0];
    if (earliestCmv !== undefined) {
      // Every CMV employer of the last ten years must be listed. The check is on the stretch
      // between ten years ago and the first CMV job listed: if it is longer than a month and
      // nothing (an employer or an explained gap) covers it, something is missing.
      const tenYearsAgo = yearsBefore(today, CMV_EMPLOYMENT_HISTORY_YEARS);
      if (earliestCmv > tenYearsAgo) {
        const before = coverage(
          form.employment.filter((e) => e.from < earliestCmv),
          { start: tenYearsAgo, end: earliestCmv },
          EMPLOYMENT_GAP_DAYS,
        );
        if (!before.covered) {
          issues.push({
            section: 'employment',
            detail: `Commercial driving history goes back ${CMV_EMPLOYMENT_HISTORY_YEARS} years; account for ${tenYearsAgo} to ${earliestCmv} with earlier employers, non-driving work or an explained gap`,
          });
        }
      }
    }
  }

  const windowStart = yearsBefore(today, INCIDENT_HISTORY_YEARS);
  for (const a of form.accidents) {
    if (a.date < windowStart || a.date > today) {
      issues.push({
        section: 'incidents',
        detail: `Accident on ${a.date} is outside the ${INCIDENT_HISTORY_YEARS}-year window`,
      });
    }
  }
  for (const c of form.convictions) {
    if (c.date < windowStart || c.date > today) {
      issues.push({
        section: 'incidents',
        detail: `Conviction on ${c.date} is outside the ${INCIDENT_HISTORY_YEARS}-year window`,
      });
    }
  }
  if (form.licenseDeniedOrRevoked && !form.licenseDeniedOrRevokedDetail) {
    issues.push({
      section: 'incidents',
      detail: 'Say which licence was denied, revoked or suspended, and why',
    });
  }

  if (!form.certifiedName || !form.certifiedOn) {
    issues.push({ section: 'certification', detail: 'The applicant must sign the certification' });
  } else if (form.certifiedOn > today) {
    issues.push({
      section: 'certification',
      detail: 'The certification date cannot be in the future',
    });
  }

  return issues;
}

/**
 * The employers a previous-employer verification is owed to: DOT-regulated, within the last
 * three years (391.23(a)(2)), most recent first.
 */
export function employersToVerify(form: DotApplicationForm, now: Date): EmployerEntry[] {
  const windowStart = yearsBefore(now.toISOString().slice(0, 10), EMPLOYMENT_HISTORY_YEARS);
  const open = '9999-12-31';
  return form.employment
    .filter((e): e is EmployerEntry => e.kind === 'employer' && e.dotRegulated)
    .filter((e) => (e.to ?? open) >= windowStart)
    .sort((a, b) => (b.to ?? open).localeCompare(a.to ?? open));
}

export const CERTIFICATION_STATEMENT =
  'This certifies that this application was completed by me, and that all entries on it and information in it are true and complete to the best of my knowledge.';
