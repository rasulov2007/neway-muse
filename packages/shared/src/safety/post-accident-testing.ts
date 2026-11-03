/**
 * Post-accident drug and alcohol testing (49 CFR 382.303), assessed and tracked.
 *
 * Owner decisions (2026-10-02):
 *  - Alcohol and drug are assessed SEPARATELY from the accident facts: a fatality; or bodily injury
 *    treated away from the scene; or a vehicle towed for disabling damage — the last two only when
 *    the driver was cited for a moving violation arising from the accident within 8 hours
 *    (alcohol) or 32 hours (drug) of it. The citation timestamp therefore matters, and a citation
 *    with no time recorded is `undetermined` rather than guessed.
 *  - Alcohol: if not given within 2 hours a reason must be documented; attempts stop at 8 hours
 *    and a reason is documented. Drug: within 32 hours, else a documented reason.
 *  - Missed, refused or could-not-complete needs a documented reason AND an authorised Safety
 *    review before it counts as resolved. Nothing is silently dropped.
 *  - Normal accident closure is blocked while any required test is unresolved. Closing never
 *    clears a driver to operate; eligibility is a separate derived state.
 *
 * Pure. `now` is an input; the API and the screens run the same functions over the same rows.
 */

export const TEST_SUBSTANCES = ['alcohol', 'drug'] as const;
export type TestSubstance = (typeof TEST_SUBSTANCES)[number];

export const DRUG_ALCOHOL_TEST_TYPES = [
  'pre_employment',
  'random',
  'post_accident',
  'reasonable_suspicion',
  'return_to_duty',
  'follow_up',
  /**
   * The company's own check after 30+ days of vacation (owner, 2026-10-17). Not the DOT
   * return-to-duty programme, and not a finding that the driver left the random pool.
   */
  'vacation_return',
] as const;
export type DrugAlcoholTestType = (typeof DRUG_ALCOHOL_TEST_TYPES)[number];

export const DRUG_ALCOHOL_TEST_TYPE_LABEL: Record<DrugAlcoholTestType, string> = {
  pre_employment: 'Pre-employment',
  random: 'Random',
  post_accident: 'Post-accident',
  reasonable_suspicion: 'Reasonable suspicion',
  return_to_duty: 'Return-to-duty',
  follow_up: 'Follow-up',
  vacation_return: 'Vacation return (company policy)',
};

export const TEST_RESULTS = ['pending', 'negative', 'positive', 'refused', 'cancelled'] as const;
export type TestResult = (typeof TEST_RESULTS)[number];

const HOUR = 3_600_000;

/** Hours after the accident within which a citation makes a test required, and testing stops. */
export const POST_ACCIDENT_WINDOW_HOURS: Record<TestSubstance, number> = { alcohol: 8, drug: 32 };
/** Alcohol given later than this needs a documented reason (382.303(d)(1)). */
export const ALCOHOL_PROMPT_HOURS = 2;

export interface PostAccidentFacts {
  occurredAt: string;
  fatalities: number;
  /** People who received medical treatment away from the scene. */
  injuriesTreatedAway: number;
  /** A vehicle was towed from the scene because of disabling damage. */
  disablingTow: boolean;
  /** The CMV driver was cited for a moving traffic violation arising from the accident. */
  citationIssued: boolean;
  citationAt: string | null;
}

export type TestRequirement = 'yes' | 'no' | 'undetermined';

export interface SubstanceAssessment {
  substance: TestSubstance;
  required: TestRequirement;
  /** The rule's working, in words a person can argue with. */
  reasons: string[];
  /** When testing stops (8 h alcohol, 32 h drug). */
  deadlineAt: string;
  /** Alcohol only: after this, a reason for the delay must be documented. */
  promptBy: string | null;
}

export interface PostAccidentAssessment {
  alcohol: SubstanceAssessment;
  drug: SubstanceAssessment;
}

function plus(iso: string, hours: number): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t + hours * HOUR).toISOString();
}

function assessOne(substance: TestSubstance, facts: PostAccidentFacts): SubstanceAssessment {
  const window = POST_ACCIDENT_WINDOW_HOURS[substance];
  const base = {
    substance,
    deadlineAt: plus(facts.occurredAt, window),
    promptBy: substance === 'alcohol' ? plus(facts.occurredAt, ALCOHOL_PROMPT_HOURS) : null,
  };
  if (facts.fatalities > 0) {
    return {
      ...base,
      required: 'yes',
      reasons: ['382.303(a)(1): the accident involved a human fatality — test whether or not a citation was issued'],
    };
  }
  const injury = facts.injuriesTreatedAway > 0;
  const tow = facts.disablingTow;
  if (!injury && !tow) {
    return {
      ...base,
      required: 'no',
      reasons: ['No fatality, no injury treated away from the scene and no disabling-damage tow'],
    };
  }
  const trigger = injury ? 'bodily injury treated away from the scene' : 'a vehicle towed for disabling damage';
  if (!facts.citationIssued) {
    return {
      ...base,
      required: 'no',
      reasons: [
        `There was ${trigger}, but no citation has been recorded for the driver; re-assessed if one is issued within ${window} hours`,
      ],
    };
  }
  if (!facts.citationAt) {
    return {
      ...base,
      required: 'undetermined',
      reasons: [`There was ${trigger} and a citation; record when the citation was issued — within ${window} hours requires a ${substance} test`],
    };
  }
  const hours = (Date.parse(facts.citationAt) - Date.parse(facts.occurredAt)) / HOUR;
  if (Number.isNaN(hours)) {
    return { ...base, required: 'undetermined', reasons: ['The citation time could not be read'] };
  }
  if (hours <= window) {
    return {
      ...base,
      required: 'yes',
      reasons: [
        `382.303(a)(${injury ? 2 : 3}): ${trigger}, and the driver was cited ${Math.max(0, Math.round(hours * 10) / 10)} h after the accident (within ${window} h)`,
      ],
    };
  }
  return {
    ...base,
    required: 'no',
    reasons: [`The citation came ${Math.round(hours * 10) / 10} h after the accident, outside the ${window}-hour window`],
  };
}

/** Alcohol and drug, each on its own rule. */
export function assessPostAccidentTesting(facts: PostAccidentFacts): PostAccidentAssessment {
  return { alcohol: assessOne('alcohol', facts), drug: assessOne('drug', facts) };
}

// ---------------------------------------------------------------------------------------------
// One test's progress
// ---------------------------------------------------------------------------------------------

export const TEST_PROGRESS = [
  'not_required',
  'required',
  'scheduled',
  'collected',
  'result_pending',
  'result_recorded',
  'not_completed',
  'exception_reviewed',
] as const;
export type TestProgress = (typeof TEST_PROGRESS)[number];

export const TEST_PROGRESS_LABEL: Record<TestProgress, string> = {
  not_required: 'Not required',
  required: 'Required — not scheduled',
  scheduled: 'Scheduled',
  collected: 'Collected',
  result_pending: 'Result pending',
  result_recorded: 'Result recorded',
  not_completed: 'Not completed — needs review',
  exception_reviewed: 'Exception reviewed',
};

export interface TestFacts {
  substance: TestSubstance;
  testType: DrugAlcoholTestType;
  /** For post-accident tests: the accident time the clock runs from. */
  occurredAt: string | null;
  /** Whether a test is required (post-accident: from the assessment; other types: always). */
  required: boolean;
  scheduledAt: string | null;
  collectedAt: string | null;
  result: TestResult;
  /** Why it was not given in time, or not at all (missed, refused, could not complete). */
  notCompletedReason: string | null;
  /** Alcohol given after 2 hours: why. */
  lateReason: string | null;
  exceptionReviewedAt: string | null;
}

export interface TestStatus {
  progress: TestProgress;
  /** True when nothing more is owed on this test. */
  resolved: boolean;
  /** What still stands between this test and resolved. */
  blockers: string[];
  nextAction: string | null;
  /** When the next action is due: the testing window for post-accident tests. */
  dueAt: string | null;
  /** True once the testing window has passed with no collection. */
  windowClosed: boolean;
}

export function testStatus(test: TestFacts, nowIso: string): TestStatus {
  const now = Date.parse(nowIso);
  const isPostAccident = test.testType === 'post_accident' && test.occurredAt !== null;
  const deadline = isPostAccident
    ? plus(test.occurredAt as string, POST_ACCIDENT_WINDOW_HOURS[test.substance])
    : null;
  const promptBy = isPostAccident && test.substance === 'alcohol' ? plus(test.occurredAt as string, ALCOHOL_PROMPT_HOURS) : null;
  const windowClosed = deadline !== null && !test.collectedAt && now > Date.parse(deadline);

  if (!test.required) {
    return { progress: 'not_required', resolved: true, blockers: [], nextAction: null, dueAt: null, windowClosed: false };
  }

  const exception = test.result === 'refused' || test.result === 'cancelled' || (test.notCompletedReason !== null && !test.collectedAt);
  if (exception) {
    const blockers: string[] = [];
    if (!test.notCompletedReason) blockers.push(`Document why the ${test.substance} test was ${test.result === 'refused' ? 'refused' : 'not completed'}`);
    if (!test.exceptionReviewedAt) blockers.push('An authorised Safety review of the exception is needed');
    return {
      progress: test.exceptionReviewedAt ? 'exception_reviewed' : 'not_completed',
      resolved: blockers.length === 0,
      blockers,
      nextAction: blockers[0] ?? null,
      dueAt: null,
      windowClosed,
    };
  }

  if (test.collectedAt) {
    const blockers: string[] = [];
    if (promptBy && Date.parse(test.collectedAt) > Date.parse(promptBy) && !test.lateReason) {
      blockers.push('Alcohol was given more than 2 hours after the accident: document why');
    }
    if (test.result === 'pending') {
      blockers.unshift(`Record the ${test.substance} result`);
      return { progress: 'result_pending', resolved: false, blockers, nextAction: blockers[0] ?? null, dueAt: null, windowClosed: false };
    }
    return {
      progress: 'result_recorded',
      resolved: blockers.length === 0,
      blockers,
      nextAction: blockers[0] ?? null,
      dueAt: null,
      windowClosed: false,
    };
  }

  if (windowClosed) {
    const blockers = [`The ${POST_ACCIDENT_WINDOW_HOURS[test.substance]}-hour ${test.substance} window has passed: document why it was not given`, 'An authorised Safety review of the exception is needed'];
    return { progress: 'not_completed', resolved: false, blockers, nextAction: blockers[0] ?? null, dueAt: null, windowClosed };
  }

  const late = promptBy !== null && now > Date.parse(promptBy);
  return {
    progress: test.scheduledAt ? 'scheduled' : 'required',
    resolved: false,
    blockers: [`Collect the ${test.substance} test${deadline ? ` within the ${POST_ACCIDENT_WINDOW_HOURS[test.substance]}-hour window` : ''}`],
    nextAction: test.scheduledAt
      ? `Collect the ${test.substance} test`
      : late
        ? `Give the alcohol test now and document why it is past 2 hours`
        : `Schedule the ${test.substance} test`,
    dueAt: deadline,
    windowClosed: false,
  };
}

/**
 * The latest moment a collection may be recorded, or null when there is no limit. The server
 * refuses a collection after it: past 8 h (alcohol) or 32 h (drug) the rule is to stop trying and
 * document why.
 */
export function collectionLimit(test: Pick<TestFacts, 'substance' | 'testType' | 'occurredAt'>): string | null {
  if (test.testType !== 'post_accident' || !test.occurredAt) return null;
  return plus(test.occurredAt, POST_ACCIDENT_WINDOW_HOURS[test.substance]);
}
