import { describe, expect, it } from 'vitest';
import { onboardingCaseState, type OnboardingCaseInput } from './onboarding-case.js';

/**
 * The state answers one question: who is this case waiting on? The order the rules fire in is the
 * order things actually block each other, which is why a rejection outranks everything — it is the
 * one state where the file looks complete and somebody still has to act.
 */
function caseOf(over: Partial<OnboardingCaseInput> = {}): OnboardingCaseInput {
  return {
    status: 'in_progress',
    completedItems: 0,
    totalItems: 12,
    documentsMissing: 0,
    documentsPending: 0,
    documentsRejected: 0,
    documentsVerified: 4,
    isAvailable: false,
    ...over,
  };
}

describe('where an onboarding case has got to', () => {
  it('is new when nothing has been collected and nothing done', () => {
    expect(
      onboardingCaseState(
        caseOf({ status: 'not_started', documentsMissing: 4, documentsVerified: 0 }),
      ),
    ).toBe('new');
  });

  it('is missing documents once some are in and others are not', () => {
    expect(onboardingCaseState(caseOf({ documentsMissing: 2, documentsVerified: 2 }))).toBe(
      'missing_documents',
    );
    // Work started on the plan counts as started, even with nothing filed yet.
    expect(
      onboardingCaseState(caseOf({ completedItems: 3, documentsMissing: 4, documentsVerified: 0 })),
    ).toBe('missing_documents');
  });

  it('waits for Safety while they hold something', () => {
    expect(onboardingCaseState(caseOf({ documentsPending: 1 }))).toBe('waiting_for_safety');
  });

  it('reads as rejected whatever else is true', () => {
    expect(
      onboardingCaseState(
        caseOf({ documentsRejected: 1, documentsPending: 2, completedItems: 12, totalItems: 12 }),
      ),
    ).toBe('rejected');
    // Even for somebody already dispatchable: a rejected document is the thing to deal with.
    expect(onboardingCaseState(caseOf({ documentsRejected: 1, isAvailable: true }))).toBe(
      'rejected',
    );
  });

  it('is ready when the paperwork is verified and the plan is finished', () => {
    expect(onboardingCaseState(caseOf({ completedItems: 12, totalItems: 12 }))).toBe('ready');
  });

  it('is still in progress when the paperwork is done and tasks are not', () => {
    expect(onboardingCaseState(caseOf({ completedItems: 5, totalItems: 12 }))).toBe('in_progress');
  });

  it('is available once the person is cleared to work', () => {
    expect(onboardingCaseState(caseOf({ isAvailable: true, completedItems: 12 }))).toBe(
      'available',
    );
  });

  it('is on hold when the plan was blocked or cancelled', () => {
    expect(onboardingCaseState(caseOf({ status: 'blocked' }))).toBe('on_hold');
    expect(onboardingCaseState(caseOf({ status: 'cancelled' }))).toBe('on_hold');
    // But not ahead of a rejection, which somebody has to act on either way.
    expect(onboardingCaseState(caseOf({ status: 'blocked', documentsRejected: 1 }))).toBe(
      'rejected',
    );
  });
});
