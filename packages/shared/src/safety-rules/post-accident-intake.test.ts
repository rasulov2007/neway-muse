// Owner, 2026-10-24: the quick report asks "Post-accident alcohol and drug test required?"; a required test that is
// not submitted needs a reason why it was not done. The 382.303 rule still runs on the facts.
import { describe, expect, it } from 'vitest';
import { POST_ACCIDENT_TEST_QUESTION, postAccidentIntakeHint, postAccidentIntakeIssues } from './report.js';

describe('postAccidentIntakeIssues', () => {
  it('a draft may leave the question open', () => {
    expect(postAccidentIntakeIssues(null, { submit: false })).toEqual([]);
    expect(postAccidentIntakeIssues({ required: 'yes', submitted: false }, { submit: false })).toEqual([]);
  });

  it('submitting asks for the answer', () => {
    expect(postAccidentIntakeIssues({ required: null, submitted: false }, { submit: true })).toEqual([
      { path: 'postAccidentTest.required', message: `Answer: ${POST_ACCIDENT_TEST_QUESTION}` },
    ]);
  });

  it('required but not submitted needs a reason why it was not done', () => {
    const issues = postAccidentIntakeIssues({ required: 'yes', submitted: false }, { submit: true });
    expect(issues.map((i) => i.path)).toEqual(['postAccidentTest.notDoneReason']);
    expect(postAccidentIntakeIssues({ required: 'yes', submitted: false, notDoneReason: '   ok ' }, { submit: true })).toHaveLength(1);
    expect(
      postAccidentIntakeIssues({ required: 'yes', submitted: false, notDoneReason: 'Driver taken to hospital; collector could not reach him in 32 h' }, { submit: true }),
    ).toEqual([]);
  });

  it('a submitted test, or No, needs no reason', () => {
    expect(postAccidentIntakeIssues({ required: 'yes', submitted: true }, { submit: true })).toEqual([]);
    expect(postAccidentIntakeIssues({ required: 'no', submitted: false }, { submit: true })).toEqual([]);
  });
});

describe('postAccidentIntakeHint', () => {
  const yes = { required: 'yes' as const, reason: 'Fatality — test required whether or not a citation is issued' };
  const no = { required: 'no' as const, reason: 'No fatality, no injury treated away from the scene and no disabling-damage tow' };
  const pending = { required: 'pending' as const, reason: 'Waiting on injury status' };

  it('suggests the rule and flags No against a required test', () => {
    expect(postAccidentIntakeHint({ alcohol: yes, drug: yes }, 'no')).toEqual({ suggested: 'yes', text: `49 CFR 382.303: required — ${yes.reason}`, conflict: true });
    expect(postAccidentIntakeHint({ alcohol: no, drug: no }, 'no')).toMatchObject({ suggested: 'no', conflict: false });
    expect(postAccidentIntakeHint({ alcohol: pending, drug: pending }, null)).toMatchObject({ suggested: null, conflict: false });
    expect(postAccidentIntakeHint({ alcohol: no, drug: yes }, 'yes').text).toContain(yes.reason);
  });
});
