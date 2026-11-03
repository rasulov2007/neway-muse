import type {
  AccidentStage,
  CitationDisposition,
  ClaimDecision,
  ClaimStage,
  CorrectionStatus,
  DataqsStatus,
  PreventabilityDecision,
  RoadsideStage,
  SafetyReviewKind,
} from './cases.js';
import type { PostAccidentAssessment, TestStatus } from './post-accident-testing.js';

/**
 * How each Safety case moves, as rules the server enforces and the screens read.
 *
 * Every stage has a default next action and a number of days it is due in; a person can change
 * either. "Mark complete" on the next action moves the case to its next stage, and a move a rule
 * forbids is refused with the sentence that says why — the same sentence the screen shows.
 */

// ---------------------------------------------------------------------------------------------
// Accidents
// ---------------------------------------------------------------------------------------------

export const ACCIDENT_NEXT_ACTION: Record<AccidentStage, { text: string; days: number } | null> = {
  reported: { text: 'Confirm the facts and assign an investigator', days: 1 },
  evidence: { text: 'Collect the police report, photos and driver statement', days: 2 },
  testing: { text: 'Resolve post-accident drug and alcohol testing', days: 1 },
  repairs_claim: { text: 'Arrange repairs and open the insurance claim', days: 3 },
  review: { text: 'Complete the driver review and decide preventability', days: 7 },
  closed: null,
};

export interface AccidentFlowInput {
  stage: AccidentStage;
  testing: PostAccidentAssessment;
  /** Status of each post-accident test row on file (not voided), with whether it is required. */
  tests: { substance: 'alcohol' | 'drug'; required: boolean; status: TestStatus }[];
  preventability: PreventabilityDecision;
  reviewCompleted: boolean;
  closedAt: string | null;
}

/** Required tests that are not resolved yet, as sentences. Empty when testing is settled. */
export function unresolvedTesting(input: Pick<AccidentFlowInput, 'testing' | 'tests'>): string[] {
  const out: string[] = [];
  for (const substance of ['alcohol', 'drug'] as const) {
    const assessment = input.testing[substance];
    if (assessment.required === 'undetermined') {
      out.push(`${cap(substance)} testing cannot be assessed yet: ${assessment.reasons[0] ?? 'facts missing'}`);
      continue;
    }
    if (assessment.required === 'no') continue;
    const test = input.tests.find((t) => t.substance === substance && t.required);
    if (!test) {
      out.push(`${cap(substance)} test is required and has no record`);
      continue;
    }
    if (!test.status.resolved) {
      out.push(`${cap(substance)} test: ${test.status.blockers[0] ?? 'not resolved'}`);
    }
  }
  return out;
}

/** Whether "Testing assessed" is done: every required test collected or excepted with a reason. */
function testingAssessed(input: AccidentFlowInput): string[] {
  const out: string[] = [];
  for (const substance of ['alcohol', 'drug'] as const) {
    const assessment = input.testing[substance];
    if (assessment.required === 'undetermined') {
      out.push(`${cap(substance)} testing cannot be assessed yet: ${assessment.reasons[0] ?? 'facts missing'}`);
    } else if (assessment.required === 'yes') {
      const test = input.tests.find((t) => t.substance === substance && t.required);
      const p = test?.status.progress;
      const settledEnough =
        p === 'collected' ||
        p === 'result_pending' ||
        p === 'result_recorded' ||
        p === 'exception_reviewed' ||
        (p === 'not_completed' && (test?.status.blockers.every((b) => !b.startsWith('Document')) ?? false));
      if (!settledEnough) out.push(`${cap(substance)} test is required: collect it or document why it was not given`);
    }
  }
  return out;
}

export function accidentAdvanceBlockers(input: AccidentFlowInput): string[] {
  switch (input.stage) {
    case 'testing':
      return testingAssessed(input);
    case 'review':
      return accidentCloseBlockers(input);
    case 'closed':
      return ['The accident is closed'];
    default:
      return [];
  }
}

/** What stands between the file and a normal close. Administrative closure is separate. */
export function accidentCloseBlockers(input: AccidentFlowInput): string[] {
  const out = unresolvedTesting(input);
  if (input.preventability === 'undetermined') out.push('Preventability has not been decided');
  if (!input.reviewCompleted) out.push('The driver review is not complete');
  return out;
}

export function nextAccidentStage(stage: AccidentStage): AccidentStage | null {
  const order: AccidentStage[] = ['reported', 'evidence', 'testing', 'repairs_claim', 'review', 'closed'];
  const i = order.indexOf(stage);
  return i >= 0 && i < order.length - 1 ? (order[i + 1] as AccidentStage) : null;
}

// ---------------------------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------------------------

export const CLAIM_NEXT_ACTION: Record<ClaimStage, { text: string; days: number } | null> = {
  opened: { text: 'Gather the documents and submit the claim to the insurer', days: 3 },
  submitted: { text: 'Confirm the insurer received the claim and assigned an adjuster', days: 5 },
  insurer_review: { text: 'Answer the adjuster and send the repair estimate', days: 7 },
  decision: { text: 'Record the insurer decision and approved amount', days: 7 },
  payment: { text: 'Confirm the payment details', days: 14 },
  closed: null,
};

export interface ClaimFlowInput {
  stage: ClaimStage;
  decision: ClaimDecision | null;
  approvedCents: number | null;
  receivedCents: number;
  submittedOn: string | null;
  insurer: string | null;
}

export function claimAdvanceBlockers(input: ClaimFlowInput): string[] {
  switch (input.stage) {
    case 'opened':
      return input.insurer ? [] : ['Name the insurer before submitting'];
    case 'submitted':
      return input.submittedOn ? [] : ['Record the date the claim was submitted'];
    case 'insurer_review':
      return [];
    case 'decision':
      if (!input.decision) return ['Record the insurer decision'];
      if (input.decision !== 'denied' && (input.approvedCents === null || input.approvedCents <= 0)) {
        return ['Record the approved amount'];
      }
      return [];
    case 'payment':
      if (input.decision === 'denied') return [];
      if ((input.approvedCents ?? 0) > input.receivedCents) {
        return ['The approved amount has not all been received; record the payments or close with a note'];
      }
      return [];
    case 'closed':
      return ['The claim is closed'];
  }
}

export function nextClaimStage(stage: ClaimStage, decision: ClaimDecision | null): ClaimStage | null {
  if (stage === 'decision' && decision === 'denied') return 'closed';
  const order: ClaimStage[] = ['opened', 'submitted', 'insurer_review', 'decision', 'payment', 'closed'];
  const i = order.indexOf(stage);
  return i >= 0 && i < order.length - 1 ? (order[i + 1] as ClaimStage) : null;
}

// ---------------------------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------------------------

export interface ViolationTracksInput {
  correctionStatus: CorrectionStatus;
  citationDisposition: CitationDisposition;
  dataqsStatus: DataqsStatus;
}

/** The tracks still open. A violation can be closed when this is empty. */
export function violationOpenTracks(input: ViolationTracksInput): string[] {
  const out: string[] = [];
  if (input.correctionStatus !== 'not_required' && input.correctionStatus !== 'certified') {
    out.push('Correction');
  }
  if (input.citationDisposition === 'pending' || input.citationDisposition === 'contested') {
    out.push('Citation');
  }
  if (input.dataqsStatus === 'filed' || input.dataqsStatus === 'under_review') out.push('DataQs');
  return out;
}

export function violationNextAction(input: ViolationTracksInput & { oos: boolean }): string | null {
  if (input.correctionStatus === 'open') return input.oos ? 'Repair the out-of-service defect and get proof' : 'Correct the violation and get proof';
  if (input.correctionStatus === 'repaired') return 'Upload the repair evidence';
  if (input.correctionStatus === 'proof_submitted') return 'Certify the correction';
  if (input.citationDisposition === 'pending') return 'Pay or contest the citation';
  if (input.citationDisposition === 'contested') return 'Record the court outcome';
  if (input.dataqsStatus === 'filed' || input.dataqsStatus === 'under_review') return 'Follow up on the DataQs request';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Roadside inspections
// ---------------------------------------------------------------------------------------------

export const ROADSIDE_NEXT_ACTION: Record<RoadsideStage, string> = {
  received: 'Review the inspection report',
  reviewed: 'Correct the defects',
  defects_corrected: 'Certify the corrections',
  certified: 'Return the signed report to the agency',
  returned: '',
};

/** The stage after which nothing more is owed. */
export function roadsideFinalStage(input: { violationCount: number; returnRequired: boolean; oos: boolean }): RoadsideStage {
  if (input.violationCount === 0 && !input.oos) return 'reviewed';
  return input.returnRequired ? 'returned' : 'certified';
}

export function roadsideStatus(input: { stage: RoadsideStage; violationCount: number; returnRequired: boolean; oos: boolean }): 'clean' | 'open' | 'closed' {
  const order: RoadsideStage[] = ['received', 'reviewed', 'defects_corrected', 'certified', 'returned'];
  const final = roadsideFinalStage(input);
  if (order.indexOf(input.stage) >= order.indexOf(final)) {
    return input.violationCount === 0 && !input.oos ? 'clean' : 'closed';
  }
  return 'open';
}

// ---------------------------------------------------------------------------------------------
// Safety reviews
// ---------------------------------------------------------------------------------------------

export interface ReviewCompleteInput {
  kind: SafetyReviewKind;
  preventabilityRequired: boolean;
  preventability: PreventabilityDecision;
  requiredTraining: string | null;
  trainingCompletedOn: string | null;
  outcome: string | null;
}

export function reviewCompleteBlockers(input: ReviewCompleteInput): string[] {
  const out: string[] = [];
  if (input.preventabilityRequired && input.preventability === 'undetermined') out.push('Decide preventability');
  if (input.requiredTraining && !input.trainingCompletedOn) out.push(`Complete the required training: ${input.requiredTraining}`);
  if (!input.outcome || input.outcome.trim().length < 3) out.push('Write down the outcome');
  return out;
}

export const REVIEW_NEXT_ACTION: Record<SafetyReviewKind, string> = {
  driver_review: 'Complete the driver review',
  coaching: 'Schedule and deliver the coaching',
  corrective_action: 'Complete the corrective action',
  vacation_return: 'Schedule the vacation-return drug test and review the result',
};

// ---------------------------------------------------------------------------------------------

/** `YYYY-MM-DD` in America/New_York for an instant: every business date in the product. */
export function easternDate(at: Date | string): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Adds whole days to a `YYYY-MM-DD`. */
export function addDaysIso(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
