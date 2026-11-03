import { z } from 'zod';
import type { DriverApplicationView } from './driver-application.js';
import type { HiringState } from './stages.js';

/**
 * Recruiting home and candidate view (owner's redesign, 2026-10-08).
 *
 * One candidate list for HR: every lead, and every candidate that came from a lead or was opened
 * for an applicant. Progress is a *reading* of the stored records — the lead status, the hiring
 * case state, the DOT application and the Safety request — never a stored copy, so nothing here
 * flattens the funnel's own stages. Four badges cover the working range; Hired and Closed end it.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const RECRUIT_PROGRESS = [
  'new',
  // Called, nobody answered (owner, 2026-10-12).
  'no_answer',
  // Reached by a recruiter but nothing signed yet (owner, 2026-10-08).
  'contacted',
  // Prequalification answers recorded and passed (owner, 2026-10-09).
  'prequalified',
  // The 9-step journey (owner, 2026-10-11): consent first, Safety, then the application.
  'consent_sent',
  'consent_received',
  'safety_review',
  'application_sent',
  'application_received',
  'onboarding',
  'ready_to_hire',
  'hired',
  'closed',
] as const;
export type RecruitProgress = (typeof RECRUIT_PROGRESS)[number];

export const RECRUIT_PROGRESS_LABELS: Readonly<Record<RecruitProgress, string>> = {
  new: 'New lead',
  no_answer: 'Called · no answer',
  contacted: 'Contacted',
  prequalified: 'Prequalified',
  consent_sent: 'Consent sent',
  consent_received: 'Consent received',
  safety_review: 'Safety review',
  application_sent: 'Application sent',
  application_received: 'Application received',
  onboarding: 'Onboarding',
  ready_to_hire: 'Ready to hire',
  hired: 'Hired',
  closed: 'Closed',
};

/**
 * The dashboard's stages: each progress value falls in exactly one, so the stage counts add up to
 * the total of the cohort (owner's brief, 2026-10-11).
 */
export const RECRUIT_STAGES = [
  'new_lead',
  'consent_pending',
  'safety_review',
  'application_pending',
  'onboarding',
  'hired',
  'closed',
] as const;
export type RecruitStage = (typeof RECRUIT_STAGES)[number];

export const RECRUIT_STAGE_LABELS: Readonly<Record<RecruitStage, string>> = {
  new_lead: 'New lead',
  consent_pending: 'Consent pending',
  safety_review: 'Safety review',
  application_pending: 'Application pending',
  onboarding: 'Onboarding',
  hired: 'Hired',
  closed: 'Closed',
};

export function recruitStageOf(progress: RecruitProgress): RecruitStage {
  switch (progress) {
    case 'new':
    case 'no_answer':
    case 'contacted':
    case 'prequalified':
      return 'new_lead';
    case 'consent_sent':
      return 'consent_pending';
    case 'consent_received':
    case 'safety_review':
      return 'safety_review';
    case 'application_sent':
      return 'application_pending';
    case 'application_received':
    case 'onboarding':
    case 'ready_to_hire':
      return 'onboarding';
    case 'hired':
      return 'hired';
    case 'closed':
      return 'closed';
  }
}

/** The list filters. "In progress" groups the working range; stored stages stay as they are. */
// `active` (not hired, not closed) is what the dashboard's "In progress" counts.
export const RECRUIT_FILTERS = ['all', 'new', 'in_progress', 'hired', 'closed', 'active'] as const;
export type RecruitFilter = (typeof RECRUIT_FILTERS)[number];

export const RECRUIT_FILTER_LABELS: Readonly<Record<RecruitFilter, string>> = {
  all: 'All',
  new: 'New',
  in_progress: 'In progress',
  hired: 'Hired',
  closed: 'Closed',
  active: 'Active',
};

export const IN_PROGRESS: readonly RecruitProgress[] = RECRUIT_PROGRESS.filter(
  (p) => p !== 'new' && p !== 'hired' && p !== 'closed',
);

/** Which filter a progress value falls under. "All" is every candidate that is not closed. */
export function recruitFilterOf(progress: RecruitProgress): Exclude<RecruitFilter, 'all' | 'active'> {
  if (progress === 'new') return 'new';
  if (progress === 'hired') return 'hired';
  if (progress === 'closed') return 'closed';
  return 'in_progress';
}

export function matchesRecruitFilter(progress: RecruitProgress, filter: RecruitFilter): boolean {
  if (filter === 'all') return progress !== 'closed';
  if (filter === 'active') return isActiveProgress(progress);
  return recruitFilterOf(progress) === filter;
}

/** Active = still being worked: not hired and not closed. */
export function isActiveProgress(progress: RecruitProgress): boolean {
  return progress !== 'hired' && progress !== 'closed';
}

export type DotApplicationState = 'none' | 'draft' | 'driver_submitted' | 'submitted';

/** The candidate's consent (steps 2-3): a live link out, or a signed submission received. */
export type RecruitConsentState = 'none' | 'sent' | 'received';

/** Safety's decision on a candidate (step 4). */
/**
 * `preparing`: Recruiting is filing the MVR / PSP reports and has not sent the candidate to
 * Safety yet (owner, 2026-10-13: reports first, then Send to Safety). Safety does not see it.
 */
export const CANDIDATE_SAFETY_STATUSES = ['preparing', 'pending', 'in_review', 'needs_follow_up', 'approved', 'declined'] as const;
export type CandidateSafetyStatus = (typeof CANDIDATE_SAFETY_STATUSES)[number];

export const CANDIDATE_SAFETY_LABELS: Readonly<Record<CandidateSafetyStatus, string>> = {
  preparing: 'Preparing reports',
  pending: 'Pending',
  in_review: 'In review',
  needs_follow_up: 'Needs follow-up',
  approved: 'Approved',
  declined: 'Declined',
};

export interface RecruitProgressInput {
  lead: { status: string } | null;
  hiringCase: { state: HiringState; safetyRequestedAt: string | null } | null;
  application: DotApplicationState;
  /** An application received through the external intake or the personal application page. */
  externalReceived: boolean;
  /** A live private application link exists for the case. */
  linkLive: boolean;
  /** Journey v2 (optional so older callers keep working). */
  consent?: RecruitConsentState;
  /** The candidate safety review, when one was opened. */
  safety?: CandidateSafetyStatus | null;
  /** A recruiter reviewed the received application (step 6). */
  applicationReviewed?: boolean;
  /** Every Ready-to-hire prerequisite is met (step 8). */
  hireReady?: boolean;
  /** Onboarding was started on this candidate (step 7). */
  onboardingStarted?: boolean;
}

const CLOSED_CASE: readonly HiringState[] = ['disqualified', 'withdrawn', 'no_show', 'declined_offer'];
const ONBOARDING_CASE: readonly HiringState[] = ['offer', 'ticketed', 'orientation'];

/**
 * Where a candidate is, read from the records (never stored). The journey (owner, 2026-10-11) is
 * Lead → Consent → Safety → Application → Onboarding → Hire. Candidates that started under the
 * earlier order (application first, then Safety) read through the same steps: a received
 * application stays "Application received" until it is sent to Safety, as before.
 */
export function recruitProgressOf(input: RecruitProgressInput): RecruitProgress {
  const c = input.hiringCase;
  const consent = input.consent ?? 'none';
  // Reports being filed by Recruiting are not with Safety yet.
  const safety = input.safety === 'preparing' ? null : (input.safety ?? null);
  if (c) {
    if (c.state === 'hired' || c.state === 'active_driver') return 'hired';
    if (CLOSED_CASE.includes(c.state)) return 'closed';
    if (safety === 'declined') return 'closed';
    if (ONBOARDING_CASE.includes(c.state) || input.onboardingStarted) return input.hireReady ? 'ready_to_hire' : 'onboarding';
  } else if (input.lead?.status === 'dead') {
    return 'closed';
  }
  const submitted =
    input.application === 'driver_submitted' || input.application === 'submitted' || input.externalReceived;
  if (submitted) {
    // The earlier order: application first, then Safety. A Safety approval came first here.
    const legacySafety = c?.state === 'safety_review' || c?.state === 'checks' || Boolean(c?.safetyRequestedAt);
    if (safety !== 'approved' && (legacySafety || (safety !== null && consent === 'none')))
      return 'safety_review';
    return 'application_received';
  }
  if (safety === 'approved') return 'application_sent';
  if (safety || c?.state === 'safety_review') return 'safety_review';
  if (consent === 'received') return 'consent_received';
  if (consent === 'sent') return 'consent_sent';
  // An application link already out (the earlier order) reads as sent, for a lead or a case.
  if (input.linkLive) return 'application_sent';
  if (c) return 'prequalified';
  if (!input.lead || input.lead.status === 'new') return 'new';
  if (input.lead.status === 'no_answer') return 'no_answer';
  return input.lead.status === 'prequalified' || input.lead.status === 'converted' ? 'prequalified' : 'contacted';
}

/** The next thing to do, as the list and the header say it. */
export function recruitNextStep(input: RecruitProgressInput): string {
  const progress = recruitProgressOf(input);
  switch (progress) {
    case 'new':
      return 'Contact driver';
    case 'no_answer':
      return 'Call again';
    case 'contacted':
    case 'prequalified':
      return 'Send consent';
    case 'consent_sent':
      return 'Waiting for consent';
    case 'consent_received':
      return 'Send to Safety';
    case 'safety_review':
      return input.safety === 'needs_follow_up' ? 'Safety follow-up' : 'Safety review';
    case 'application_sent':
      return input.linkLive ? 'Waiting for application' : 'Send application';
    case 'application_received':
      // The earlier order: the driver's own submission is reviewed, then the file goes to Safety.
      if ((input.consent ?? 'none') === 'none' && !input.safety) {
        return input.application === 'driver_submitted' || (input.externalReceived && input.application !== 'submitted')
          ? 'Review application'
          : 'Send to Safety';
      }
      return input.applicationReviewed ? 'Start onboarding' : 'Review application';
    case 'onboarding':
      return 'Onboarding';
    case 'ready_to_hire':
      return 'Hire driver';
    case 'hired':
      return 'Driver profile';
    case 'closed':
      return 'No action';
  }
}

export type FollowUpState = 'overdue' | 'today' | 'upcoming';

/** A follow-up date against the company's (Eastern) today. */
export function followUpStateOf(on: string | null, today: string): FollowUpState | null {
  if (!on) return null;
  if (on < today) return 'overdue';
  if (on === today) return 'today';
  return 'upcoming';
}

// ---------------------------------------------------------------------------------- the list

export const RECRUIT_SCOPES = ['mine', 'all'] as const;
export type RecruitScope = (typeof RECRUIT_SCOPES)[number];

export const RecruitListQuerySchema = z.object({
  scope: z.enum(RECRUIT_SCOPES).default('mine'),
  /** All leads only: one recruiter (employee id); 'none' = unassigned. A filter, never a reassignment. */
  recruiter: z.string().trim().min(1).max(80).optional(),
  filter: z.enum(RECRUIT_FILTERS).default('all'),
  /** Only candidates whose follow-up is due today or overdue. */
  followUp: z.enum(['due']).optional(),
  q: z.string().trim().max(120).optional(),
  /** From the dashboard: leads received in this period (Eastern dates), one stage, one source. */
  from: isoDate.optional(),
  to: isoDate.optional(),
  stage: z.enum(RECRUIT_STAGES).optional(),
  source: z.string().trim().min(1).max(40).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(10),
});
export type RecruitListQuery = z.infer<typeof RecruitListQuerySchema>;
export type RecruitListQueryInput = z.input<typeof RecruitListQuerySchema>;

export interface RecruitRecruiter {
  employeeId: string;
  name: string;
  /** The signed-in person's own employee record: Add lead picks them first (owner, 2026-10-12). */
  isMe?: boolean;
}

export interface RecruitRow {
  /** The route key: the applicant id once the person is a candidate, else the lead id. */
  key: string;
  leadId: string | null;
  caseId: string | null;
  applicantId: string | null;
  name: string;
  source: string;
  sourceLabel: string;
  progress: RecruitProgress;
  /** The dashboard stage the progress falls in. */
  stage: RecruitStage;
  nextStep: string;
  followUpOn: string | null;
  followUpState: FollowUpState | null;
  recruiter: RecruitRecruiter | null;
  createdAt: string;
  /** The newest note or call note on the person, shown on the list row (owner, 2026-10-09). */
  lastNote: { text: string; byName: string; at: string } | null;
}

export interface RecruitScopeInfo {
  scope: RecruitScope;
  /** Whose leads: the signed-in recruiter, a chosen recruiter, everyone, or nobody (unassigned). */
  label: string;
  /** The signed-in account's recruiter record, when it has one. */
  own: RecruitRecruiter | null;
  canSeeAll: boolean;
}

export interface RecruitList {
  rows: RecruitRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<RecruitFilter, number>;
  /** Candidates in scope (not hired, not closed) whose follow-up is today or overdue. */
  followUpDue: number;
  scope: RecruitScopeInfo;
  /** The company's (Eastern) today on the server, for Today / Tomorrow labels. */
  today: string;
}

export interface RecruitMetrics {
  /** Not hired and not closed. */
  active: number;
  /** Active candidates whose follow-up is today or overdue. */
  followUpDue: number;
  /** Hire events in the current Eastern calendar month. */
  hiredThisMonth: number;
  month: string;
  today: string;
  scope: RecruitScopeInfo;
}

export const RecruitMetricsQuerySchema = RecruitListQuerySchema.pick({ scope: true, recruiter: true });

// ------------------------------------------------------------------------------- the dashboard

/**
 * The Recruiting dashboard (owner's brief, 2026-10-11). One cohort: the leads received in the
 * period. Hired, in progress, stages and sources all count that same cohort, so the stage counts
 * add up to the total and every number opens the list it was counted from.
 */
export const RecruitDashboardQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  scope: z.enum(RECRUIT_SCOPES).default('all'),
  recruiter: z.string().trim().min(1).max(80).optional(),
});
export type RecruitDashboardQuery = z.infer<typeof RecruitDashboardQuerySchema>;

export interface RecruitDashboard {
  period: { from: string; to: string };
  scope: RecruitScopeInfo;
  total: number;
  hired: number;
  /** hired / total; null with no leads. */
  conversion: number | null;
  /** Not hired and not closed. */
  inProgress: number;
  /** Ranked by leads; a lead with no source counts under Unknown. */
  sources: { key: string; label: string; leads: number; hired: number }[];
  /** One row per stage, in journey order; they add up to `total`. */
  stages: { stage: RecruitStage; label: string; count: number }[];
  /** Leads received per Eastern day of the period, zero days included. */
  trend: { date: string; leads: number }[];
  nextActions: { key: 'consent' | 'safety' | 'onboarding'; label: string; count: number; stage: RecruitStage }[];
  recent: {
    key: string;
    name: string;
    sourceLabel: string;
    stage: RecruitStage;
    stageLabel: string;
    recruiter: string | null;
    receivedAt: string;
  }[];
  today: string;
}

// ------------------------------------------------------------------------------- the candidate

/** The application as the candidate page shows it: masked, never the full numbers. */
export interface RecruitApplicationSummary {
  personal: {
    legalName: string;
    /** Masked (e.g. ••/••/1987) for an account without recruiting.manage. */
    dateOfBirth: string | null;
    dateOfBirthMasked: boolean;
    currentAddress: string | null;
    addressCount: number;
    /** "•••-••-1234" — the only form the API ever returns. */
    ssnMasked: string | null;
  };
  cdl: {
    licenseClass: string | null;
    numberMasked: string | null;
    state: string | null;
    expiresOn: string | null;
    endorsements: string[];
    licenseCount: number;
  };
  experience: {
    employers: number;
    cmvEmployers: number;
    gaps: number;
    mostRecent: { employer: string; position: string; from: string; to: string | null } | null;
  };
  drivingHistory: {
    accidents: { date: string; location: string; nature: string }[];
    convictions: { date: string; location: string; offense: string }[];
    licenseDeniedOrRevoked: boolean;
  };
  consents: { count: number };
  certifiedName: string | null;
  certifiedOn: string | null;
}

export interface RecruitSafetyStep {
  label: string;
  status: string;
  blocker: string | null;
}

export interface RecruitSafety {
  requestedAt: string | null;
  requestedBy: string | null;
  requestNote: string | null;
  verification: {
    id: string;
    stage: string;
    safetyReviewStatus: string;
    safetyReviewBy: string | null;
    safetyReviewAt: string | null;
    decision: string | null;
    decisionAt: string | null;
    decisionBy: string | null;
    decisionNote: string | null;
    steps: RecruitSafetyStep[];
  } | null;
}

export interface SendToSafetyCheck {
  code: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface SendToSafetyReadiness {
  ready: boolean;
  alreadyRequested: boolean;
  checks: SendToSafetyCheck[];
}

export interface RecruitHireReadiness {
  ready: boolean;
  missing: string[];
  hiredAt: string | null;
  driverId: string | null;
  employeeId: string | null;
}

export interface RecruitCandidate {
  key: string;
  leadId: string | null;
  caseId: string | null;
  applicantId: string | null;
  leadNumber: string | null;
  applicantNumber: string | null;
  name: string;
  /** The name as it is stored, split, for the rename form. */
  firstName: string;
  lastName: string;
  /** The records behind the candidate as read; a rename sends it back (stale = 409). */
  version: string;
  phone: string | null;
  email: string | null;
  location: string | null;
  source: string;
  sourceLabel: string;
  createdAt: string;
  recruiter: RecruitRecruiter | null;
  progress: RecruitProgress;
  nextStep: string;
  followUp: { on: string; state: FollowUpState; setBy: string | null; setAt: string | null } | null;
  lead: {
    status: string;
    prequalified: boolean;
    prequalFailed: string[] | null;
    deadReason: string | null;
  } | null;
  caseState: HiringState | null;
  driverId: string | null;
  application: {
    state: DotApplicationState;
    submittedAt: string | null;
    certifiedAt: string | null;
    certifiedName: string | null;
    submittedVia: string | null;
    reviewedAt: string | null;
    reviewedBy: string | null;
    returnedAt: string | null;
    returnNote: string | null;
    documentId: string | null;
    link: {
      state: string;
      createdAt: string;
      expiresAt: string;
      firstOpenedAt: string | null;
      lastSavedAt: string | null;
      submittedAt: string | null;
    } | null;
    /** The last time a recruiter recorded that they sent the link by hand ("Mark as sent"). */
    markedSentAt: string | null;
    markedSentBy: string | null;
    /** An application received through the external intake adapter: its answers, masked, for review. */
    external: {
      receivedAt: string;
      provider: string;
      reference: string;
      answers: { label: string; value: string }[];
      files: { code: string; fileName: string }[];
    } | null;
    summary: RecruitApplicationSummary | null;
  };
  /** The personal driver application (/application/#token=…): the link session and what was received. */
  driverApplication: DriverApplicationView;
  safety: RecruitSafety;
  sendToSafety: SendToSafetyReadiness;
  hire: RecruitHireReadiness;
  /** The journey's own facts (owner brief, 2026-10-11), for the status menu and the header. */
  journeyState: {
    consent: RecruitConsentState;
    safety: CandidateSafetyStatus | null;
    applicationReviewed: boolean;
    onboardingStarted: boolean;
    hireReady: boolean;
    onHold: boolean;
    consentFirst: boolean;
  };
  permissions: { canManage: boolean; canSeeSensitive: boolean; canReassign: boolean };
}

// ---------------------------------------------------------------------------------- notes

/**
 * A note on a candidate, with an optional follow-up date (Eastern business date). The note is an
 * append-only audit entry; the date also becomes the candidate's current follow-up, which the list,
 * the metric and the calendar read.
 */
export const RecruitNoteSchema = z.object({
  note: z.string().trim().min(1, 'Write the note first').max(2000),
  followUpOn: isoDate.nullish().transform((v) => v ?? null),
});
export type RecruitNoteInput = z.input<typeof RecruitNoteSchema>;
export type RecruitNoteRequest = z.infer<typeof RecruitNoteSchema>;

export interface RecruitNote {
  id: string;
  at: string;
  byName: string;
  kind: 'note' | 'follow_up' | 'follow_up_done';
  text: string | null;
  summary: string | null;
  followUpOn: string | null;
}

export const SendToSafetySchema = z.object({
  note: z.string().trim().max(1000).nullish().transform((v) => v || null),
});
export type SendToSafetyInput = z.input<typeof SendToSafetySchema>;
export type SendToSafetyRequest = z.infer<typeof SendToSafetySchema>;

export const ReassignCandidateSchema = z.object({ employeeId: z.string().min(1).nullable() });
export type ReassignCandidateRequest = z.infer<typeof ReassignCandidateSchema>;

/**
 * Renames a candidate (owner, 2026-10-21): the first and last name as the lead and the candidate
 * record keep them (40 characters each, like Add lead), or one full name split on the first space.
 * `version` is the candidate's `version` as read; a stale one is a 409, never an overwrite.
 */
export const RenameCandidateSchema = z
  .object({
    firstName: z.string().trim().max(40, 'At most 40 characters').optional(),
    lastName: z.string().trim().max(40, 'At most 40 characters').optional(),
    name: z.string().trim().max(81, 'At most 81 characters').optional(),
    version: z.string().min(1, 'Reload the candidate and try again'),
  })
  .superRefine((v, ctx) => {
    const first = v.firstName ?? (v.name ? v.name.split(/\s+/)[0] : '');
    if (!first) ctx.addIssue({ code: 'custom', path: [v.name !== undefined ? 'name' : 'firstName'], message: 'Enter the first name' });
  });
export type RenameCandidateInput = z.input<typeof RenameCandidateSchema>;
export type RenameCandidateRequest = z.infer<typeof RenameCandidateSchema>;

export interface RenameCandidateResult {
  candidate: RecruitCandidate;
  /** Set when the candidate is already hired: the driver profile is renamed in Drivers, not here. */
  driverNotice: string | null;
}

// ---------------------------------------------------------------------------- the HR rotation

export interface RotationMember {
  userId: string;
  employeeId: string;
  name: string;
  position: number;
  excluded: boolean;
  excludedReason: string | null;
  /** Meets the eligibility rule right now (active account, active membership, recruiter employee). */
  eligible: boolean;
  /** Why not, when not eligible. */
  ineligibleReason: string | null;
  joinedAt: string;
  joinedVia: string;
}

export interface RotationSettings {
  members: RotationMember[];
  next: { userId: string; employeeId: string; name: string } | null;
  last: { userId: string | null; employeeId: string | null; name: string | null; at: string | null };
  /** No eligible recruiter: new online leads arrive unassigned. */
  unassignedWarning: boolean;
  unassignedLeads: number;
  canManage: boolean;
  rule: string;
}

export const RotationOrderSchema = z.object({
  /** Every member's user id, in the new order. */
  userIds: z.array(z.string().min(1)).min(1).max(100),
});
export type RotationOrderRequest = z.infer<typeof RotationOrderSchema>;

export const RotationExcludeSchema = z.object({
  excluded: z.boolean(),
  reason: z.string().trim().max(300).nullish().transform((v) => v || null),
});
export type RotationExcludeRequest = z.infer<typeof RotationExcludeSchema>;

/** Add lead: who gets it. Automatic takes the next turn; a named recruiter needs recruiting.manage. */
export const RecruitAddLeadSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter the full name').max(81),
  phone: z.string().trim().min(7, 'A phone number is required').max(20),
  email: z
    .string()
    .trim()
    .email('Enter a valid email')
    .nullish()
    .or(z.literal(''))
    .transform((v) => v || null),
  source: z.string().trim().min(1).max(40),
  assignment: z.enum(['auto', 'recruiter']).default('auto'),
  recruiterEmployeeId: z.string().min(1).nullish().transform((v) => v ?? null),
});
export type RecruitAddLeadInput = z.input<typeof RecruitAddLeadSchema>;
export type RecruitAddLeadRequest = z.infer<typeof RecruitAddLeadSchema>;

// ------------------------------------------------------------------------- recruiter analytics

export interface RecruiterResult {
  employeeId: string | null;
  name: string;
  leads: number;
  hired: number;
  /** hired / leads, of the leads added in the period; null when no leads. */
  conversion: number | null;
}

export interface RecruitAnalytics {
  period: { from: string; to: string };
  leads: number;
  hired: number;
  /** Of the leads added in the period, the share already hired; null with no leads. */
  conversion: number | null;
  conversionDefinition: string;
  sources: { key: string; label: string; leads: number; hired: number }[];
  recruiters: RecruiterResult[];
}

// ------------------------------------------------------------------- the external application

/**
 * The shape the external driver application (external-driver-application) sends, field for field,
 * as JSON. Files come as base64 with their name and type (the TMS's own upload convention). The
 * SSN is sealed on arrival and only its last four digits are ever read back.
 */
const extText = (max: number) => z.string().trim().max(max);
const extFile = z
  .object({ name: z.string().trim().min(1).max(200), contentType: z.string().max(80), content: z.string().min(1) })
  .nullish()
  .transform((v) => v ?? null);

export const ExternalApplicationSchema = z.object({
  submissionKey: z.string().trim().min(8).max(100),
  firstName: extText(60).min(1),
  lastName: extText(60).min(1),
  phone: extText(30).min(7),
  email: extText(160).email().nullish().or(z.literal('')).transform((v) => v || null),
  address: extText(200).nullish().transform((v) => v ?? null),
  city: extText(80).nullish().transform((v) => v ?? null),
  stateZip: extText(40).nullish().transform((v) => v ?? null),
  cdlClass: extText(20).nullish().transform((v) => v ?? null),
  cdlState: extText(20).nullish().transform((v) => v ?? null),
  cdlExpiration: isoDate.nullish().or(z.literal('')).transform((v) => v || null),
  ssn: z
    .string()
    .trim()
    .regex(/^\d{3}-?\d{2}-?\d{4}$/, 'Expected a 9-digit SSN')
    .nullish()
    .or(z.literal(''))
    .transform((v) => v || null),
  medicalExpiration: isoDate.nullish().or(z.literal('')).transform((v) => v || null),
  experience: extText(60).nullish().transform((v) => v ?? null),
  endorsements: extText(120).nullish().transform((v) => v ?? null),
  position: extText(60).nullish().transform((v) => v ?? null),
  preference: extText(60).nullish().transform((v) => v ?? null),
  startDate: isoDate.nullish().or(z.literal('')).transform((v) => v || null),
  routes: extText(200).nullish().transform((v) => v ?? null),
  employer: extText(160).nullish().transform((v) => v ?? null),
  employmentStart: extText(10).nullish().transform((v) => v ?? null),
  employmentEnd: extText(10).nullish().transform((v) => v ?? null),
  leavingReason: extText(300).nullish().transform((v) => v ?? null),
  accidents: extText(20).nullish().transform((v) => v ?? null),
  violations: extText(20).nullish().transform((v) => v ?? null),
  suspended: extText(20).nullish().transform((v) => v ?? null),
  source: extText(40).nullish().transform((v) => v ?? null),
  consent: z.union([z.boolean(), z.literal('on'), z.literal('true')]).transform((v) => v === true || v === 'on' || v === 'true'),
  authorizations: z
    .record(
      z.string().max(20),
      z.object({
        authorized: z.boolean(),
        name: z.string().max(120).optional(),
        signedAt: z.string().max(40).optional(),
        signatureMethod: z.string().max(20).optional(),
        disclosureOpened: z.boolean().optional(),
        electronicSignature: z.boolean().optional(),
        // The drawn signature image is not kept by the adapter; the signed fact and time are.
        drawing: z.string().nullish(),
        signature: z.string().max(120).optional(),
      }),
    )
    .nullish()
    .transform((v) => v ?? {}),
  files: z
    .object({ cdlFront: extFile, cdlBack: extFile, medicalCard: extFile })
    .partial()
    .nullish()
    .transform((v) => v ?? {}),
});
export type ExternalApplicationInput = z.input<typeof ExternalApplicationSchema>;
export type ExternalApplication = z.infer<typeof ExternalApplicationSchema>;

export interface ExternalApplicationReceipt {
  status: 'received';
  reference: string;
  /** True when this exact submission had already been received (a retry); nothing new was saved. */
  duplicate: boolean;
}

export interface ExternalApplicationPrefill {
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  companyName: string;
  alreadySubmitted: boolean;
}

// ------------------------------------------------------------------------------- the calendar

/**
 * The recruiting calendar: follow-up dates set on notes, plus the travel, orientation and hire
 * dates the funnel already records. There is no separate event store — a follow-up *is* the
 * date on a note, and the other three are the pipeline's own records.
 */
export interface RecruitCalendarEvent {
  id: string;
  kind: 'follow_up' | 'travel' | 'orientation' | 'hired';
  /** Business date, Eastern. */
  date: string;
  at: string | null;
  candidateKey: string;
  candidateName: string;
  detail: string | null;
  recruiter: RecruitRecruiter | null;
  overdue: boolean;
}

export const RecruitCalendarQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  scope: z.enum(RECRUIT_SCOPES).default('mine'),
  recruiter: z.string().trim().min(1).max(80).optional(),
});
export type RecruitCalendarQuery = z.infer<typeof RecruitCalendarQuerySchema>;

export const RecruitAnalyticsQuerySchema = z.object({ from: isoDate, to: isoDate });

// ---------------------------------------------------------------------------------- the board

/**
 * The candidate pipeline board (owner mockup, 2026-10-15): six columns that group the existing
 * journey. Nothing new is stored - every card's column is read from its derived progress.
 */
// Disqualified last (owner, 2026-10-16): kept on the board so they can still be found.
// Consent sent and Consent received are two columns side by side (owner, 2026-10-26).
export const RECRUIT_BOARD_COLUMNS = ['new_lead', 'lead_screening', 'consent_sent', 'consent_received', 'safety_review', 'application', 'onboarding', 'ready_to_hire', 'disqualified'] as const;
export type RecruitBoardColumn = (typeof RECRUIT_BOARD_COLUMNS)[number];

export const RECRUIT_BOARD_COLUMN_LABELS: Readonly<Record<RecruitBoardColumn, { title: string; subtitle: string }>> = {
  // Its own column before screening (owner, 2026-10-15): nobody has reached them yet.
  new_lead: { title: 'New Lead', subtitle: 'Not contacted yet' },
  lead_screening: { title: 'Lead Screening', subtitle: 'First contact & prequalification' },
  consent_sent: { title: 'Consent sent', subtitle: 'Waiting for the signed consent' },
  consent_received: { title: 'Consent received', subtitle: 'Signed · send to Safety' },
  safety_review: { title: 'Safety Review', subtitle: 'Documents & verification' },
  application: { title: 'Application', subtitle: 'Send · Awaiting · Received' },
  onboarding: { title: 'Onboarding & Costs', subtitle: 'Final review & setup' },
  ready_to_hire: { title: 'Ready to Hire', subtitle: 'Hire → Driver profile' },
  disqualified: { title: 'Disqualified', subtitle: 'Not eligible · kept on record' },
};

/**
 * Every active progress value, in exactly one column. Typed over the whole active set, so a new
 * progress value cannot be added without deciding its column. Hired and closed are not on the board.
 */
export const RECRUIT_BOARD_COLUMN_OF: Readonly<Record<Exclude<RecruitProgress, 'hired' | 'closed'>, RecruitBoardColumn>> = {
  new: 'new_lead',
  no_answer: 'lead_screening',
  contacted: 'lead_screening',
  prequalified: 'lead_screening',
  consent_sent: 'consent_sent',
  consent_received: 'consent_received',
  safety_review: 'safety_review',
  application_sent: 'application',
  application_received: 'application',
  onboarding: 'onboarding',
  ready_to_hire: 'ready_to_hire',
};

export function recruitBoardColumnOf(progress: RecruitProgress): RecruitBoardColumn | null {
  return progress === 'hired' || progress === 'closed' ? null : RECRUIT_BOARD_COLUMN_OF[progress];
}

export const RecruitBoardQuerySchema = RecruitListQuerySchema.pick({ scope: true, recruiter: true, q: true });
export type RecruitBoardQuery = z.infer<typeof RecruitBoardQuerySchema>;

export interface RecruitBoardCard extends RecruitRow {
  column: RecruitBoardColumn;
  phone: string | null;
  /** From the prequalification answers, when recorded: company / lease operator / owner operator. */
  driverType: 'company' | 'owner_operator' | 'lease_operator' | null;
  consent: RecruitConsentState;
  safety: CandidateSafetyStatus | null;
  /** When the candidate entered the current step, only where a stored time says so; else null. */
  stageSince: string | null;
  /** Saved hiring cost records for the person (voided left out), in cents; null when none. */
  costCents: number | null;
}

export interface RecruitBoard {
  cards: RecruitBoardCard[];
  scope: RecruitScopeInfo;
  today: string;
}
