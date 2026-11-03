import { z } from 'zod';
import { WorkAuthorizationKindSchema } from '../compliance/work-authorization.js';
import { CdlExtractSchema } from '../compliance/cdl-extract.js';
import type { Lead } from './leads.js';
import type { HiringCase, HiringState } from './stages.js';

/**
 * The hiring journey as the owner reads it (2026-09-29): nine steps from the first call to the
 * first load, plus the two ways out. It is a *reading* of the stored lead and case states, never
 * a copy of them — a lead moves because a recruiter contacted it, a case moves because Safety or
 * a recruiter did something, and this only says which step that puts the person on.
 */

export const JOURNEY_STEPS = [
  'lead',
  'contacted',
  'application',
  'documents',
  'safety_review',
  'offer_travel',
  'orientation',
  'hired',
  'first_load',
] as const;
export type JourneyStep = (typeof JOURNEY_STEPS)[number];

export const JOURNEY_EXITS = ['disqualified', 'dropped'] as const;
export type JourneyExit = (typeof JOURNEY_EXITS)[number];
export type JourneyPlace = JourneyStep | JourneyExit;

export const JOURNEY_LABELS: Readonly<Record<JourneyPlace, string>> = {
  lead: 'New lead',
  contacted: 'Contacted',
  application: 'Application',
  documents: 'Documents & checks',
  safety_review: 'Safety review',
  offer_travel: 'Offer & travel',
  orientation: 'Orientation',
  hired: 'Hired',
  first_load: 'First load',
  disqualified: 'Disqualified',
  dropped: 'Dropped',
};

/** What each step is waiting for, in one line, for the card and the board. */
export const JOURNEY_WAITING_ON: Readonly<Record<JourneyStep, string>> = {
  lead: 'Recruiter to call',
  contacted: 'Prequalify and start the application',
  application: 'Driver to finish the DOT application',
  documents: 'Documents, consents and checks',
  safety_review: 'Safety to approve or disqualify',
  offer_travel: 'Offer accepted and travel booked',
  orientation: 'Orientation and road test',
  hired: 'First dispatch',
  first_load: 'Nothing — driving',
};

/** The next thing to do for a person on each step, as the card says it. */
export const JOURNEY_NEXT_ACTION: Readonly<Record<JourneyStep, string>> = {
  lead: 'Call the lead',
  contacted: 'Prequalify and convert to a candidate',
  application: 'Complete DOT application',
  documents: 'Collect documents and consents',
  safety_review: 'Waiting on Safety to approve or disqualify',
  offer_travel: 'Send the offer and book travel',
  orientation: 'Record orientation and the road test',
  hired: 'First dispatch',
  first_load: 'Driving',
};

/**
 * Days a person may sit on a step before the board calls it stuck. Speed-to-lead is the one that
 * matters most, so a new lead is stuck after a day. First load is where the journey ends; it is
 * never stuck.
 */
export const JOURNEY_STUCK_AFTER_DAYS: Readonly<Record<JourneyStep, number | null>> = {
  lead: 1,
  contacted: 3,
  application: 3,
  documents: 5,
  safety_review: 2,
  offer_travel: 5,
  orientation: 3,
  hired: 7,
  first_load: null,
};

const CASE_STEP: Readonly<Record<HiringState, JourneyPlace>> = {
  lead: 'contacted',
  prequalified: 'contacted',
  application: 'application',
  checks: 'documents',
  safety_review: 'safety_review',
  offer: 'offer_travel',
  ticketed: 'offer_travel',
  orientation: 'orientation',
  hired: 'hired',
  active_driver: 'first_load',
  disqualified: 'disqualified',
  withdrawn: 'dropped',
  no_show: 'dropped',
  declined_offer: 'dropped',
};

export function journeyPlaceOfCase(state: HiringState): JourneyPlace {
  return CASE_STEP[state];
}

/** A lead that became a case is read from the case; this is for the ones that have not. */
export function journeyPlaceOfLead(lead: Pick<Lead, 'status'>): JourneyPlace | null {
  switch (lead.status) {
    case 'new':
    case 'no_answer':
      return 'lead';
    case 'contacted':
    case 'prequalified':
      return 'contacted';
    case 'dead':
      return 'dropped';
    case 'converted':
      return null;
  }
}

export function isJourneyExit(place: JourneyPlace): place is JourneyExit {
  return place === 'disqualified' || place === 'dropped';
}

/** One person on the board, whichever record they are still on. */
export interface JourneyPerson {
  key: string;
  kind: 'lead' | 'case';
  /** The lead id or the case id. */
  id: string;
  /** Where the card opens: the candidate record for a case, the lead for a lead. */
  applicantId: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  /** The lead behind the person, when there is one (a case converted from a lead, or a lead). */
  leadId: string | null;
  source: string | null;
  recruiterName: string | null;
  place: JourneyPlace;
  /** When the person arrived on this step (ISO). */
  since: string;
  daysOnStep: number;
  stuck: boolean;
  /** Why it ended, for the two exits. */
  endReason: string | null;
  /** When the journey started: the lead's creation, or the case's opening. */
  startedAt: string;
}

function daysBetween(fromIso: string, today: string): number {
  const from = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${today}T00:00:00Z`);
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

export function isStuck(place: JourneyPlace, daysOnStep: number): boolean {
  if (isJourneyExit(place)) return false;
  const limit = JOURNEY_STUCK_AFTER_DAYS[place];
  return limit !== null && daysOnStep > limit;
}

/**
 * Everyone on the journey, each once: a converted lead is represented by its case, and a case is
 * the source of truth from conversion on. `today` is the company's (Eastern) business date.
 */
export function journeyPeople(
  leads: readonly Lead[],
  cases: readonly HiringCase[],
  today: string,
): JourneyPerson[] {
  const people: JourneyPerson[] = [];
  const leadByCase = new Map(leads.filter((l) => l.hiringCaseId).map((l) => [l.hiringCaseId!, l]));
  for (const lead of leads) {
    const place = journeyPlaceOfLead(lead);
    if (place === null || lead.hiringCaseId) continue;
    const since =
      place === 'dropped'
        ? (lead.deadAt ?? lead.createdAt)
        : place === 'contacted'
          ? (lead.prequalifiedAt ?? lead.contactedAt ?? lead.createdAt)
          : lead.createdAt;
    const days = daysBetween(since, today);
    people.push({
      key: `lead:${lead.id}`,
      kind: 'lead',
      id: lead.id,
      applicantId: lead.applicantId,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      leadId: lead.id,
      source: lead.source,
      recruiterName: lead.recruiterName,
      place,
      since,
      daysOnStep: days,
      stuck: isStuck(place, days),
      endReason: place === 'dropped' ? lead.deadReason : null,
      startedAt: lead.createdAt,
    });
  }
  for (const c of cases) {
    const place = journeyPlaceOfCase(c.state);
    const lead = leadByCase.get(c.id);
    const days = daysBetween(c.stateSince, today);
    people.push({
      key: `case:${c.id}`,
      kind: 'case',
      id: c.id,
      applicantId: c.applicantId,
      name: c.candidateName,
      phone: lead?.phone ?? null,
      email: lead?.email ?? null,
      leadId: lead?.id ?? null,
      source: lead?.source ?? null,
      recruiterName: c.recruiterName,
      place,
      since: c.stateSince,
      daysOnStep: days,
      stuck: isStuck(place, days),
      endReason: isJourneyExit(place) ? (c.endNote ?? c.endReason) : null,
      startedAt: lead?.createdAt ?? c.openedAt,
    });
  }
  return people;
}

export interface JourneySummary {
  /** People who started the journey inside the period. */
  started: number;
  /** Everyone currently on each step (not bounded by the period: a queue is a queue). */
  onStep: Record<JourneyStep, number>;
  stuck: number;
  /** Of those who started in the period: reached Hired or First load. */
  passed: number;
  disqualified: number;
  dropped: number;
  /** Still somewhere between New lead and Orientation. */
  inProgress: number;
  bySource: { source: string; started: number; passed: number; dropped: number; disqualified: number }[];
}

/** Counts for the dashboard. `from`/`to` are business dates bounding when a journey started. */
export function summarizeJourney(people: readonly JourneyPerson[], from: string, to: string): JourneySummary {
  const onStep = Object.fromEntries(JOURNEY_STEPS.map((s) => [s, 0])) as Record<JourneyStep, number>;
  let stuck = 0;
  for (const p of people) {
    if (!isJourneyExit(p.place)) onStep[p.place] += 1;
    if (p.stuck) stuck += 1;
  }
  const inPeriod = people.filter((p) => {
    const day = p.startedAt.slice(0, 10);
    return day >= from && day <= to;
  });
  const passedPlace = (p: JourneyPerson) => p.place === 'hired' || p.place === 'first_load';
  const sources = new Map<string, JourneySummary['bySource'][number]>();
  for (const p of inPeriod) {
    const key = p.source ?? 'unknown';
    const row = sources.get(key) ?? { source: key, started: 0, passed: 0, dropped: 0, disqualified: 0 };
    row.started += 1;
    if (passedPlace(p)) row.passed += 1;
    if (p.place === 'dropped') row.dropped += 1;
    if (p.place === 'disqualified') row.disqualified += 1;
    sources.set(key, row);
  }
  return {
    started: inPeriod.length,
    onStep,
    stuck,
    passed: inPeriod.filter(passedPlace).length,
    disqualified: inPeriod.filter((p) => p.place === 'disqualified').length,
    dropped: inPeriod.filter((p) => p.place === 'dropped').length,
    inProgress: inPeriod.filter((p) => !isJourneyExit(p.place) && !passedPlace(p)).length,
    bySource: [...sources.values()].sort((a, b) => b.started - a.started),
  };
}

/** The steps as a stepper for one person: done before their step, current on it, todo after. */
export function journeySteps(place: JourneyPlace, lastStep: JourneyStep | null = null) {
  const at = isJourneyExit(place) ? (lastStep ? JOURNEY_STEPS.indexOf(lastStep) : -1) : JOURNEY_STEPS.indexOf(place);
  return JOURNEY_STEPS.map((step, i) => ({
    step,
    label: JOURNEY_LABELS[step],
    state: (i < at ? 'done' : i === at ? (isJourneyExit(place) ? 'stopped' : 'current') : 'todo') as
      | 'done'
      | 'current'
      | 'stopped'
      | 'todo',
  }));
}

/** The last live step a case reached before it ended, from its appended events. */
export function lastLiveStep(c: Pick<HiringCase, 'events' | 'state'>): JourneyStep | null {
  const live = [...c.events]
    .reverse()
    .map((e) => journeyPlaceOfCase(e.toState))
    .find((p): p is JourneyStep => !isJourneyExit(p));
  return live ?? null;
}

// ------------------------------------------------------------------------------ sources, exits

export const LEAD_SOURCE_LABELS: Readonly<Record<string, string>> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  referral: 'Driver referral',
  job_board: 'Job board',
  phone_call: 'Phone call',
  website: 'Website',
  walk_in: 'Walk-in',
  agency: 'Agency',
  social: 'Social (other)',
  other: 'Other',
  unknown: 'Not recorded',
};

/**
 * A recruiter ending a case that is not Safety's to end: the driver stopped answering, took
 * another job, or did not come. Disqualification stays Safety's decision in the qualification file.
 */
export const DROP_REASONS = ['unresponsive', 'took_another_job', 'pay', 'home_time', 'no_show_orientation', 'other'] as const;
export const DropHiringCaseSchema = z.object({
  reason: z.enum(DROP_REASONS),
  note: z.string().trim().max(400).nullable().default(null),
});
export type DropHiringCaseInput = z.input<typeof DropHiringCaseSchema>;
export type DropHiringCaseRequest = z.infer<typeof DropHiringCaseSchema>;

/** A dated thing on the hiring calendar: travel, orientation, a hire. */
export const HiringCalendarEventSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  applicantId: z.string().nullable(),
  candidateName: z.string(),
  kind: z.enum(['travel', 'orientation', 'hired']),
  /** Business date (YYYY-MM-DD, Eastern). */
  date: z.string(),
  /** ISO time when the thing has one (a departure), else null. */
  at: z.string().nullable(),
  detail: z.string().nullable(),
});
export type HiringCalendarEvent = z.infer<typeof HiringCalendarEventSchema>;

// ---------------------------------------------------------------------------- hiring documents

/**
 * The papers a driver's hire needs, and when (49 CFR 391 / 382). HR collects and uploads them;
 * each lands in the driver's qualification file as "pending review" and Safety approves or
 * rejects it there. Nothing here decides the hire: Safety's approval of the case does.
 */
export const HIRING_DOCUMENT_TIMING = ['before_hire', 'within_30_days', 'optional'] as const;
export type HiringDocumentTiming = (typeof HIRING_DOCUMENT_TIMING)[number];

export const HIRING_DOCUMENTS: readonly { code: string; label: string; timing: HiringDocumentTiming; rule: string | null }[] = [
  { code: 'dot_application', label: 'DOT employment application', timing: 'before_hire', rule: '391.21' },
  { code: 'cdl', label: 'CDL — front', timing: 'before_hire', rule: '391.33' },
  { code: 'cdl_back', label: 'CDL — back', timing: 'optional', rule: null },
  { code: 'medical_card', label: 'DOT medical certificate', timing: 'before_hire', rule: '391.43' },
  { code: 'clearinghouse_query', label: 'Clearinghouse full query', timing: 'before_hire', rule: '382.701' },
  { code: 'pre_employment_drug_test', label: 'Pre-employment drug test (negative)', timing: 'before_hire', rule: '382.301' },
  { code: 'road_test', label: 'Road test certificate', timing: 'before_hire', rule: '391.31' },
  { code: 'mvr_review', label: 'MVR — every state, 3 years', timing: 'within_30_days', rule: '391.23' },
  { code: 'employment_verification', label: 'Previous employers — 3 years', timing: 'within_30_days', rule: '391.23(d)' },
  { code: 'psp_review', label: 'PSP report', timing: 'optional', rule: null },
  // Background check and driver photo retired 2026-10-24 (owner); filed ones stay in the file.
  { code: 'work_authorization', label: 'Work authorization', timing: 'optional', rule: null },
  // Tax paper for 1099 pay (owner, 2026-10-25); never blocks a hire.
  { code: 'w9', label: 'W-9', timing: 'optional', rule: null },
];

export const HIRING_DOCUMENT_TIMING_LABELS: Readonly<Record<HiringDocumentTiming, string>> = {
  before_hire: 'Needed before hire',
  within_30_days: 'Within 30 days of hire',
  optional: 'Also useful',
};

export type HiringDocumentState = 'missing' | 'waiting_for_safety' | 'approved' | 'rejected' | 'expired';

export const HIRING_DOCUMENT_STATE_LABELS: Readonly<Record<HiringDocumentState, string>> = {
  missing: 'Missing',
  waiting_for_safety: 'Waiting for Safety',
  approved: 'Approved by Safety',
  rejected: 'Rejected by Safety',
  expired: 'Expired',
};

/** The newest document for a requirement decides its state; a replaced one no longer counts. */
export function hiringDocumentState(
  docs: readonly { requirementCode: string; status: string; uploadedAt?: string; createdAt?: string }[],
  code: string,
): HiringDocumentState {
  const mine = docs
    .filter((d) => d.requirementCode === code)
    .sort((a, b) => (b.uploadedAt ?? b.createdAt ?? '').localeCompare(a.uploadedAt ?? a.createdAt ?? ''));
  const latest = mine[0];
  if (!latest) return 'missing';
  if (latest.status === 'verified') return 'approved';
  if (latest.status === 'rejected') return 'rejected';
  if (latest.status === 'expired') return 'expired';
  return 'waiting_for_safety';
}

export const HiringDocumentUploadSchema = z.object({
  requirementCode: z.string().refine((c) => HIRING_DOCUMENTS.some((d) => d.code === c), 'Not a hiring document'),
  title: z.string().trim().min(1).max(200),
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().positive(),
  issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
  /** The file, base64, on the same JSON body (as the qualification file's own upload takes it). */
  content: z.string().min(1),
  /** Which paper a Work authorization is (owner, 2026-10-26); ignored for every other type. */
  workAuthorizationKind: WorkAuthorizationKindSchema.nullish(),
  /**
   * On a CDL only: what was read off the card (Read with Muse) as the recruiter checked and
   * confirmed it. Ignored for every other type.
   */
  extracted: CdlExtractSchema.nullish(),
});
export type HiringDocumentUploadInput = z.input<typeof HiringDocumentUploadSchema>;
export type HiringDocumentUploadRequest = z.infer<typeof HiringDocumentUploadSchema>;
