import { z } from 'zod';

/**
 * Where an onboarding case has actually got to.
 *
 * The plan's own status says whether its tasks are done — not started, in progress, blocked. That
 * is not the question anybody asks about a new driver. They ask: is this one waiting on me, on
 * Safety, or on the driver? So the case state is derived from the three facts that decide it: the
 * plan, the required documents behind it, and whether the person is cleared to work.
 *
 * Derived, never stored. A second column holding "waiting for safety" would be right for exactly
 * as long as it took somebody to verify a document without remembering to update it.
 */

export const ONBOARDING_CASE_STATES = [
  'new',
  'in_progress',
  'missing_documents',
  'waiting_for_safety',
  'rejected',
  'ready',
  'available',
  'on_hold',
] as const;
export const OnboardingCaseStateSchema = z.enum(ONBOARDING_CASE_STATES);
export type OnboardingCaseState = (typeof ONBOARDING_CASE_STATES)[number];

export const ONBOARDING_CASE_LABEL: Record<OnboardingCaseState, string> = {
  new: 'New',
  in_progress: 'In progress',
  missing_documents: 'Missing documents',
  waiting_for_safety: 'Waiting for Safety',
  rejected: 'Rejected',
  ready: 'Ready',
  available: 'Available',
  on_hold: 'On hold',
};

/**
 * What each state means on screen, in one sentence, so nobody has to guess what to do next.
 */
export const ONBOARDING_CASE_NEXT_ACTION: Record<OnboardingCaseState, string> = {
  new: 'Nothing has been collected yet. Start with the licence and the medical certificate.',
  in_progress: 'Work through the remaining items on the plan.',
  missing_documents: 'Collect the documents this driver still owes.',
  waiting_for_safety: 'Safety has the documents. Nothing to do until they are reviewed.',
  rejected: 'Safety refused a document. Read the reason and collect a replacement.',
  ready: 'Everything required is verified. Release the driver when the plan is finished.',
  available: 'This driver is cleared and dispatchable.',
  on_hold: 'This plan was put on hold or cancelled.',
};

export interface OnboardingCaseInput {
  /** The plan's own status. */
  status: string;
  completedItems: number;
  totalItems: number;
  /** Required documents, counted by where they have got to. */
  documentsMissing: number;
  documentsPending: number;
  documentsRejected: number;
  documentsVerified: number;
  /** True when the person is already cleared to work — for a driver, dispatchable. */
  isAvailable: boolean;
}

/**
 * The state, decided in the order things actually block each other.
 *
 * A rejection outranks everything: it is the one state where somebody must act and the file looks
 * otherwise complete. Then a hold, then the documents, then the plan.
 */
export function onboardingCaseState(input: OnboardingCaseInput): OnboardingCaseState {
  if (input.documentsRejected > 0) return 'rejected';
  if (input.status === 'cancelled' || input.status === 'blocked') return 'on_hold';
  if (input.isAvailable) return 'available';
  if (input.documentsMissing > 0) {
    // Nothing collected and nothing done: the case has not been started rather than fallen behind.
    return input.completedItems === 0 &&
      input.documentsPending === 0 &&
      input.documentsVerified === 0
      ? 'new'
      : 'missing_documents';
  }
  if (input.documentsPending > 0) return 'waiting_for_safety';
  /*
   * Every required document is verified. Ready means the plan is finished too: a case with tasks
   * still open is in progress, whatever the paperwork says, because somebody still has work to do.
   */
  if (input.totalItems === 0 || input.completedItems >= input.totalItems) return 'ready';
  return 'in_progress';
}
