import { z } from 'zod';
import type { VerificationDecision, VerificationStage } from '../compliance/records.js';

/**
 * The driver hiring funnel: one stage model from lead to active driver.
 *
 * The middle of it — Checks and Safety review — is not a new thing. It *is* the verification case
 * in the qualification file, read through `hiringStageFromVerification`. A hiring case wraps a
 * verification case; it never stores a copy of its consents, documents or decision.
 *
 * Every transition is an appended event, never an update. That gives days-in-stage and funnel
 * conversion for free, and it is why a disqualified candidate keeps their whole history (and, in
 * the ledger, their whole cost).
 */

export const HIRING_STAGES = [
  'lead',
  'prequalified',
  'application',
  'checks',
  'safety_review',
  'offer',
  'ticketed',
  'orientation',
  'hired',
  'active_driver',
] as const;
export const HiringStageSchema = z.enum(HIRING_STAGES);
export type HiringStage = z.infer<typeof HiringStageSchema>;

export const HIRING_TERMINAL_STATES = [
  'disqualified',
  'withdrawn',
  'no_show',
  'declined_offer',
] as const;
export const HiringTerminalStateSchema = z.enum(HIRING_TERMINAL_STATES);
export type HiringTerminalState = z.infer<typeof HiringTerminalStateSchema>;

/** Where a case is: a live stage, or the terminal state it ended in. */
export const HIRING_STATES = [...HIRING_STAGES, ...HIRING_TERMINAL_STATES] as const;
export const HiringStateSchema = z.enum(HIRING_STATES);
export type HiringState = z.infer<typeof HiringStateSchema>;

export const HIRING_STAGE_LABELS: Readonly<Record<HiringState, string>> = {
  lead: 'Lead',
  prequalified: 'Prequalified',
  application: 'Application',
  checks: 'Checks',
  safety_review: 'Safety review',
  offer: 'Offer',
  ticketed: 'Ticketed',
  orientation: 'Orientation',
  hired: 'Hired',
  active_driver: 'Active driver',
  disqualified: 'Disqualified',
  withdrawn: 'Withdrawn',
  no_show: 'No-show',
  declined_offer: 'Declined offer',
};

/**
 * Why a case ended. Every terminal transition carries one of these plus free text; "other" exists
 * so the free text is never forced into a wrong category, not so it can be skipped.
 */
export const HIRING_END_REASONS = [
  'failed_prequalification',
  'failed_mvr',
  'failed_psp',
  'failed_clearinghouse',
  'failed_drug_test',
  'failed_background_check',
  'failed_employment_verification',
  'safety_review_rejected',
  'unresponsive',
  'took_another_job',
  'pay',
  'home_time',
  'no_show_orientation',
  'declined_offer',
  /** A Yes on the consent's safety questions (owner, 2026-10-13). */
  'failed_safety_screening',
  'other',
] as const;
export const HiringEndReasonSchema = z.enum(HIRING_END_REASONS);
export type HiringEndReason = z.infer<typeof HiringEndReasonSchema>;

export const HIRING_END_REASON_LABELS: Readonly<Record<HiringEndReason, string>> = {
  failed_prequalification: 'Did not prequalify',
  failed_safety_screening: 'Safety questions (company policy)',
  failed_mvr: 'MVR',
  failed_psp: 'PSP',
  failed_clearinghouse: 'Clearinghouse',
  failed_drug_test: 'Drug test',
  failed_background_check: 'Background check',
  failed_employment_verification: 'Employer verification',
  safety_review_rejected: 'Safety review',
  unresponsive: 'Stopped responding',
  took_another_job: 'Took another job',
  pay: 'Pay',
  home_time: 'Home time',
  no_show_orientation: 'No-show at orientation',
  declined_offer: 'Declined the offer',
  other: 'Other',
};

export const HIRING_EVENT_SOURCES = ['user', 'system', 'verification'] as const;

export const HiringStageEventSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  fromState: HiringStateSchema.nullable(),
  toState: HiringStateSchema,
  at: z.string().datetime(),
  byId: z.string().nullable(),
  byName: z.string(),
  reason: HiringEndReasonSchema.nullable(),
  note: z.string().nullable(),
  /** `verification` when the move was derived from the qualification file, not clicked. */
  source: z.enum(HIRING_EVENT_SOURCES),
});
export type HiringStageEvent = z.infer<typeof HiringStageEventSchema>;

export const HiringCaseSchema = z.object({
  id: z.string(),
  /** The recruiting applicant, once the front of the funnel exists. */
  applicantId: z.string().nullable(),
  /** The driver record, once one exists — set at hire, or at import for drivers already hired. */
  driverId: z.string().nullable(),
  /** The verification case that *is* this candidate's Checks and Safety review. */
  verificationCaseId: z.string().nullable(),
  candidateName: z.string(),
  state: HiringStateSchema,
  stateSince: z.string().datetime(),
  daysInState: z.number().int().nonnegative(),
  openedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  endReason: HiringEndReasonSchema.nullable(),
  endNote: z.string().nullable(),
  recruiterId: z.string().nullable(),
  recruiterName: z.string().nullable(),
  /** The DOT application's state, if one was started. The answers live on the application. */
  dotApplication: z
    .object({
      id: z.string(),
      status: z.enum(['draft', 'driver_submitted', 'submitted']),
      submittedAt: z.string().datetime().nullable(),
      documentId: z.string().nullable(),
    })
    .nullable(),
  /** The driver offer on the recruiting offers table, once one exists. */
  offerId: z.string().nullable(),
  /** The employee the hire created; the driver row carries the case's `driverId`. */
  employeeId: z.string().nullable(),
  hiredAt: z.string().datetime().nullable(),
  /** The first time the roster showed this driver dispatched or driving, if it has. */
  firstDispatchAt: z.string().datetime().nullable(),
  /** What still holds a hired driver at Hired: the onboarding plan's open blocking items. */
  onboardingGate: z
    .object({
      checklistId: z.string(),
      blockingOpen: z.number().int(),
      blockingTitles: z.array(z.string()),
    })
    .nullable(),
  events: z.array(HiringStageEventSchema),
});
export type HiringCase = z.infer<typeof HiringCaseSchema>;

export function isTerminal(state: HiringState): state is HiringTerminalState {
  return (HIRING_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * The states the qualification file decides. Up to and including the safety decision, a case
 * moves because the file moved; from Offer on, it moves because a recruiter did something — an
 * offer went out, a ticket was booked, orientation was attended, the hire happened — and a later
 * document event in the file does not pull it back.
 */
export const VERIFICATION_OWNED_STATES: readonly HiringState[] = [
  'application',
  'checks',
  'safety_review',
];

/**
 * Where a verification case puts the candidate in the funnel.
 *
 * `driverIsActive` is for the drivers who were already hired and dispatched when the funnel was
 * introduced: their case says "approved", but they are not sitting at Offer waiting for a ticket —
 * they are driving, and the funnel should say so.
 */
export function hiringStageFromVerification(
  stage: VerificationStage,
  decision: VerificationDecision | null,
  options: { driverIsActive?: boolean } = {},
): HiringState {
  switch (stage) {
    case 'recruiting':
      return 'application';
    case 'document_collection':
    case 'consent':
    case 'screening':
    case 'verification':
      return 'checks';
    case 'safety_review':
      return 'safety_review';
    case 'decision':
      return decision === 'rejected' ? 'disqualified' : 'safety_review';
    case 'active':
      return options.driverIsActive ? 'active_driver' : 'offer';
    default:
      return 'checks';
  }
}

/** The stages, in order, for a funnel chart; terminal states are counted beside it, not on it. */
export const HIRING_FUNNEL: readonly HiringStage[] = HIRING_STAGES;
