import { describe, expect, it } from 'vitest';
import { accidentCloseBlockers, roadsideStatus, violationOpenTracks } from './case-flow.js';
import { assessPostAccidentTesting, testStatus, type PostAccidentFacts, type TestFacts } from './post-accident-testing.js';

const AT = '2026-10-01T12:00:00.000Z';
const H = (h: number) => new Date(Date.parse(AT) + h * 3_600_000).toISOString();
const facts = (over: Partial<PostAccidentFacts> = {}): PostAccidentFacts => ({
  occurredAt: AT,
  fatalities: 0,
  injuriesTreatedAway: 0,
  disablingTow: false,
  citationIssued: false,
  citationAt: null,
  ...over,
});

describe('assessPostAccidentTesting (49 CFR 382.303)', () => {
  it('requires both tests after a fatality, citation or not', () => {
    const a = assessPostAccidentTesting(facts({ fatalities: 1 }));
    expect(a.alcohol.required).toBe('yes');
    expect(a.drug.required).toBe('yes');
  });

  it('requires nothing without a fatality, an injury treated away or a disabling tow', () => {
    const a = assessPostAccidentTesting(facts({ citationIssued: true, citationAt: H(1) }));
    expect(a.alcohol.required).toBe('no');
    expect(a.drug.required).toBe('no');
  });

  it('needs a citation for injury or tow, and judges each substance on its own window', () => {
    expect(assessPostAccidentTesting(facts({ disablingTow: true })).alcohol.required).toBe('no');
    const tenHours = assessPostAccidentTesting(facts({ disablingTow: true, citationIssued: true, citationAt: H(10) }));
    expect(tenHours.alcohol.required).toBe('no'); // outside 8 h
    expect(tenHours.drug.required).toBe('yes'); // inside 32 h
    const fortyHours = assessPostAccidentTesting(facts({ injuriesTreatedAway: 1, citationIssued: true, citationAt: H(40) }));
    expect(fortyHours.drug.required).toBe('no');
  });

  it('does not guess when the citation time is missing', () => {
    const a = assessPostAccidentTesting(facts({ injuriesTreatedAway: 1, citationIssued: true }));
    expect(a.alcohol.required).toBe('undetermined');
    expect(a.alcohol.reasons[0]).toMatch(/citation/);
  });

  it('runs the clock from the accident: 2 h prompt, 8 h alcohol, 32 h drug', () => {
    const a = assessPostAccidentTesting(facts({ fatalities: 1 }));
    expect(a.alcohol.promptBy).toBe(H(2));
    expect(a.alcohol.deadlineAt).toBe(H(8));
    expect(a.drug.deadlineAt).toBe(H(32));
  });
});

describe('testStatus', () => {
  const base = (over: Partial<TestFacts> = {}): TestFacts => ({
    substance: 'alcohol',
    testType: 'post_accident',
    occurredAt: AT,
    required: true,
    scheduledAt: null,
    collectedAt: null,
    result: 'pending',
    notCompletedReason: null,
    lateReason: null,
    exceptionReviewedAt: null,
    ...over,
  });

  it('is resolved with a recorded result in time', () => {
    expect(testStatus(base({ collectedAt: H(1), result: 'negative' }), H(3)).resolved).toBe(true);
  });

  it('wants a reason when alcohol was given after 2 hours', () => {
    const late = testStatus(base({ collectedAt: H(3), result: 'negative' }), H(4));
    expect(late.resolved).toBe(false);
    expect(late.blockers[0]).toMatch(/2 hours/);
    expect(testStatus(base({ collectedAt: H(3), result: 'negative', lateReason: 'Scene clearance' }), H(4)).resolved).toBe(true);
  });

  it('turns into an exception once the window passes, and needs a reason and a review', () => {
    const missed = testStatus(base(), H(9));
    expect(missed.progress).toBe('not_completed');
    expect(missed.windowClosed).toBe(true);
    const reasoned = testStatus(base({ notCompletedReason: 'Driver hospitalised' }), H(9));
    expect(reasoned.resolved).toBe(false);
    const reviewed = testStatus(base({ notCompletedReason: 'Driver hospitalised', exceptionReviewedAt: H(10) }), H(11));
    expect(reviewed.resolved).toBe(true);
    expect(reviewed.progress).toBe('exception_reviewed');
  });

  it('treats a refusal as an exception, never as resolved by itself', () => {
    const refused = testStatus(base({ result: 'refused' }), H(1));
    expect(refused.resolved).toBe(false);
    expect(refused.blockers.length).toBe(2);
  });
});

describe('case flow rules', () => {
  it('blocks a normal accident close on testing, preventability and the review', () => {
    const blockers = accidentCloseBlockers({
      stage: 'review',
      testing: assessPostAccidentTesting(facts({ fatalities: 1 })),
      tests: [],
      preventability: 'undetermined',
      reviewCompleted: false,
      closedAt: null,
    });
    expect(blockers.join(' | ')).toMatch(/Alcohol test is required/);
    expect(blockers.join(' | ')).toMatch(/Preventability/);
    expect(blockers.join(' | ')).toMatch(/review/);
  });

  it('keeps the three violation tracks apart', () => {
    expect(violationOpenTracks({ correctionStatus: 'open', citationDisposition: 'pending', dataqsStatus: 'filed' })).toEqual(['Correction', 'Citation', 'DataQs']);
    expect(violationOpenTracks({ correctionStatus: 'certified', citationDisposition: 'paid', dataqsStatus: 'denied' })).toEqual([]);
  });

  it('closes a clean roadside inspection at Reviewed and an OOS one at Certified or Returned', () => {
    expect(roadsideStatus({ stage: 'reviewed', violationCount: 0, returnRequired: false, oos: false })).toBe('clean');
    expect(roadsideStatus({ stage: 'reviewed', violationCount: 1, returnRequired: false, oos: true })).toBe('open');
    expect(roadsideStatus({ stage: 'certified', violationCount: 1, returnRequired: true, oos: true })).toBe('open');
    expect(roadsideStatus({ stage: 'returned', violationCount: 1, returnRequired: true, oos: true })).toBe('closed');
  });
});
