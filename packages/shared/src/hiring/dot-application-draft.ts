import { z } from 'zod';
import { DotApplicationFormSchema, checkDotApplication } from './dot-application.js';

// ------------------------------------------------------------------------------------- drafts

/**
 * A draft as the desk keeps it: the same answers, but any of them may still be blank. Saving a
 * half-finished application is allowed (owner, 2026-09-30); submission still takes the full
 * contract (`DotApplicationFormSchema`) plus `checkDotApplication`, so nothing incomplete reaches
 * the qualification file.
 */
const draftText = (max: number) => z.string().trim().max(max);
const draftDate = z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Expected YYYY-MM-DD');
const draftState = z.string().trim().max(2).toUpperCase();

export const DotApplicationDraftFormSchema = z.object({
  legalFirstName: draftText(200).default(''),
  legalMiddleName: z.string().trim().max(100).nullable().default(null),
  legalLastName: draftText(200).default(''),
  dateOfBirth: draftDate.default(''),
  addresses: z
    .array(
      z.object({
        street: draftText(200),
        city: draftText(200),
        state: draftState,
        zip: draftText(10),
        from: draftDate,
        to: draftDate.nullable(),
      }),
    )
    .max(20)
    .default([]),
  licenses: z
    .array(
      z.object({
        state: draftState,
        number: draftText(200),
        licenseClass: z.enum(['A', 'B', 'C']),
        endorsements: z.array(z.string().trim().min(1).max(3)).max(8).default([]),
        expiresOn: draftDate,
      }),
    )
    .max(10)
    .default([]),
  employment: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('employer'),
          employer: draftText(200),
          address: z.string().trim().max(300).nullable(),
          phone: z.string().trim().max(40).nullable(),
          contactName: z.string().trim().max(120).nullable(),
          position: draftText(200),
          from: draftDate,
          to: draftDate.nullable(),
          reasonForLeaving: z.string().trim().max(300).nullable(),
          droveCmv: z.boolean(),
          dotRegulated: z.boolean(),
          subjectToDrugTesting: z.boolean(),
        }),
        z.object({
          kind: z.literal('gap'),
          from: draftDate,
          to: draftDate.nullable(),
          explanation: draftText(200),
        }),
      ]),
    )
    .max(40)
    .default([]),
  accidents: z
    .array(
      z.object({
        date: draftDate,
        location: draftText(200),
        nature: draftText(200),
        fatalities: z.number().int().nonnegative(),
        injuries: z.number().int().nonnegative(),
        hazmatSpill: z.boolean(),
      }),
    )
    .max(20)
    .default([]),
  convictions: z
    .array(
      z.object({
        date: draftDate,
        location: draftText(200),
        offense: draftText(200),
        penalty: z.string().trim().max(200).nullable(),
      }),
    )
    .max(20)
    .default([]),
  licenseDeniedOrRevoked: z.boolean().default(false),
  licenseDeniedOrRevokedDetail: z.string().trim().max(500).nullable().default(null),
  certifiedName: z.string().trim().max(120).nullable().default(null),
  certifiedOn: draftDate.nullable().default(null),
});
export type DotApplicationDraftForm = z.infer<typeof DotApplicationDraftFormSchema>;
export type DotApplicationDraftFormInput = z.input<typeof DotApplicationDraftFormSchema>;

/** What the desk sends on Save draft. The SSN rule is unchanged: nine digits, or left out. */
export const SaveDotApplicationDraftSchema = DotApplicationDraftFormSchema.extend({
  ssn: z
    .string()
    .trim()
    .regex(/^\d{3}-?\d{2}-?\d{4}$/, 'A social security number is nine digits')
    .nullish(),
});
export type SaveDotApplicationDraftInput = z.input<typeof SaveDotApplicationDraftSchema>;
export type SaveDotApplicationDraftRequest = z.infer<typeof SaveDotApplicationDraftSchema>;

export const DOT_SECTIONS = [
  'identity',
  'addresses',
  'licenses',
  'employment',
  'incidents',
  'certification',
] as const;
export type DotSection = (typeof DOT_SECTIONS)[number];
export const DOT_SECTION_LABELS: Readonly<Record<DotSection, string>> = {
  identity: 'Personal information',
  addresses: 'Address history',
  licenses: 'Driver licenses',
  employment: 'Employment history',
  incidents: 'Accidents & violations',
  certification: 'Review & certify',
};

/** A problem the form can put beside its field: the section, the field path, and what is wrong. */
export interface DotFieldProblem {
  section: DotSection;
  /** e.g. `addresses.0.from`, or null for a section-wide rule (a gap in the history). */
  path: string | null;
  detail: string;
}

const FIELD_WORDS: Record<string, string> = {
  legalFirstName: 'Legal first name',
  legalLastName: 'Legal last name',
  dateOfBirth: 'Date of birth',
  street: 'Street',
  city: 'City',
  state: 'State',
  zip: 'ZIP',
  from: 'From date',
  to: 'To date',
  number: 'Licence number',
  expiresOn: 'Expiry date',
  employer: 'Employer',
  position: 'Position',
  explanation: 'Explanation',
  date: 'Date',
  location: 'Location',
  nature: 'Nature of the accident',
  offense: 'Offense',
  certifiedOn: 'Certification date',
};

const ENTRY_WORDS: Record<string, string> = {
  addresses: 'address',
  licenses: 'licence',
  employment: 'employment entry',
  accidents: 'accident',
  convictions: 'conviction',
};

function sectionOfPath(key: string): DotSection {
  if (key === 'addresses') return 'addresses';
  if (key === 'licenses') return 'licenses';
  if (key === 'employment') return 'employment';
  if (key === 'accidents' || key === 'convictions' || key.startsWith('licenseDenied')) {
    return 'incidents';
  }
  if (key.startsWith('certified')) return 'certification';
  return 'identity';
}

/**
 * Everything standing between a draft and a submission, each pinned to its section and, where it
 * is one field, to that field. The same two checks the server runs: the contract, then 391.21.
 */
export function dotApplicationProblems(draft: DotApplicationDraftForm, now: Date): DotFieldProblem[] {
  const parsed = DotApplicationFormSchema.safeParse(draft);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => {
      const path = issue.path.map(String);
      const head = path[0] ?? '';
      const leaf = path[path.length - 1] ?? '';
      const words = FIELD_WORDS[leaf] ?? leaf;
      const entry =
        path.length > 2 && /^\d+$/.test(path[1] ?? '')
          ? ` on ${ENTRY_WORDS[head] ?? 'entry'} ${Number(path[1]) + 1}`
          : '';
      const blank =
        issue.code === 'too_small' ||
        (typeof issue.message === 'string' && issue.message.includes('Expected YYYY'));
      return {
        section: sectionOfPath(head),
        path: path.join('.'),
        detail: blank ? `${words}${entry} is required` : `${words}${entry}: ${issue.message}`,
      };
    });
  }
  return checkDotApplication(parsed.data, now).map((i) => ({
    section: i.section,
    path: null,
    detail: i.detail,
  }));
}

export type DotSectionState = 'not_started' | 'in_progress' | 'complete';

/** Whether anything has been entered in a section, judged on what the applicant can type. */
function touched(draft: DotApplicationDraftForm, section: DotSection): boolean {
  switch (section) {
    case 'identity':
      return Boolean(draft.legalFirstName || draft.legalLastName || draft.dateOfBirth);
    case 'addresses':
      return draft.addresses.some((a) => Boolean(a.street || a.city || a.zip || a.from));
    case 'licenses':
      return draft.licenses.some((l) => Boolean(l.number || l.expiresOn));
    case 'employment':
      return draft.employment.some((e) =>
        Boolean(e.from || (e.kind === 'employer' ? e.employer || e.position : e.explanation)),
      );
    case 'incidents':
      return (
        draft.accidents.length > 0 || draft.convictions.length > 0 || draft.licenseDeniedOrRevoked
      );
    case 'certification':
      return Boolean(draft.certifiedName || draft.certifiedOn);
  }
}

/**
 * Not started / In progress / Complete, per section. "Accidents & violations" may truly be none,
 * so it counts as Complete once the application is under way and it has no problem of its own.
 * While any field anywhere is blank the 391.21 history checks cannot run, so a section is only
 * called Complete when none of its own fields is missing and none of its rules fails.
 */
export function dotSectionStates(
  draft: DotApplicationDraftForm,
  now: Date,
): Record<DotSection, DotSectionState> {
  const problems = dotApplicationProblems(draft, now);
  const contractOk = DotApplicationFormSchema.safeParse(draft).success;
  // With the contract failing, the rule checks did not run; run them per section on what parses.
  const ruleProblems = contractOk
    ? []
    : ruleProblemsLoose(draft, now);
  const bad = new Set([...problems, ...ruleProblems].map((p) => p.section));
  const out = {} as Record<DotSection, DotSectionState>;
  for (const section of DOT_SECTIONS) {
    const started = touched(draft, section);
    const clean = !bad.has(section);
    if (section === 'incidents') {
      const underWay = DOT_SECTIONS.some(
        (s) => s !== 'incidents' && s !== 'certification' && touched(draft, s),
      );
      out[section] = !started && !underWay ? 'not_started' : clean ? 'complete' : 'in_progress';
      continue;
    }
    out[section] = !started ? 'not_started' : clean ? 'complete' : 'in_progress';
  }
  return out;
}

/** The 391.21 checks for the sections whose own fields are all filled, when others are not. */
function ruleProblemsLoose(draft: DotApplicationDraftForm, now: Date): DotFieldProblem[] {
  const filled = <T>(list: T[], ok: (t: T) => boolean) => list.filter(ok);
  const probe = {
    ...draft,
    legalFirstName: draft.legalFirstName || 'x',
    legalLastName: draft.legalLastName || 'x',
    dateOfBirth: draft.dateOfBirth || '1900-01-01',
    addresses: filled(draft.addresses, (a) => Boolean(a.street && a.city && a.state.length === 2 && a.zip.length >= 3 && a.from)),
    licenses: filled(draft.licenses, (l) => Boolean(l.state.length === 2 && l.number && l.expiresOn)),
    employment: filled(draft.employment, (e) =>
      Boolean(e.from && (e.kind === 'employer' ? e.employer && e.position : e.explanation)),
    ),
    accidents: filled(draft.accidents, (a) => Boolean(a.date && a.location && a.nature)),
    convictions: filled(draft.convictions, (c) => Boolean(c.date && c.location && c.offense)),
    certifiedOn: draft.certifiedOn || null,
  };
  const parsed = DotApplicationFormSchema.safeParse(probe);
  if (!parsed.success) return [];
  return checkDotApplication(parsed.data, now).map((i) => ({ section: i.section, path: null, detail: i.detail }));
}
