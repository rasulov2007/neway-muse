import { isMandatoryRequirement, requirementsFor } from './catalog.js';
import type { QualificationItem } from './item.js';
import {
  CONSENT_PURPOSE_BY_REQUIREMENT,
  CONSENT_PURPOSE_LABELS,
  POST_OFFER_REQUIREMENTS,
  VERIFICATION_LADDER,
  type ConsentRequest,
  type VerificationCase,
  type VerificationCaseRecord,
  type VerificationStage,
  type VerificationStep,
} from './records.js';
import type { QualificationRequirement } from './requirement.js';

/**
 * The verification pipeline, derived.
 *
 * A case's steps are a function of four things: the ladder, the driver's qualification items, the
 * driver's consents, and the handful of human facts the case record itself holds (application
 * received, safety review, decision). None of that is stored as "steps". It is computed on every
 * read, so the pipeline view can never say "CDL on file: blocked" about a driver whose CDL was
 * verified an hour ago — the same rule the qualification item follows for its own status.
 *
 * Pure. The API and the seed call it with the same inputs and get the same case.
 */

const DAY = 86_400_000;

export interface DeriveVerificationInput {
  record: VerificationCaseRecord;
  /** This driver's qualification items only. */
  items: readonly QualificationItem[];
  /** This driver's consent requests only. */
  consents: readonly ConsentRequest[];
  requirements: readonly QualificationRequirement[];
  now: Date;
  /** First name, for the wording of a declined-consent blocker. Falls back to the full name. */
  driverFirstName?: string;
}

interface StepResult {
  status: VerificationStep['status'];
  blocker: string | null;
  at: string | null;
  by: string | null;
}

function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`verification: missing ${what}`);
  return value;
}

export function deriveVerificationCase(input: DeriveVerificationInput): VerificationCase {
  const { record, now } = input;
  const items = new Map(input.items.map((i) => [i.requirementCode, i]));
  // A purpose can have several consents — one previous-employer verification per employer — so
  // they are grouped, and a step reads the group: all signed is complete, any refusal blocks.
  const consents = new Map<string, ConsentRequest[]>();
  for (const c of input.consents) {
    consents.set(c.requirementCode, [...(consents.get(c.requirementCode) ?? []), c]);
  }
  const byCode = new Map(input.requirements.map((r) => [r.code, r]));
  const reqName = (code: string) => byCode.get(code)?.name ?? code;
  const firstName = input.driverFirstName ?? record.driverName.split(' ')[0] ?? record.driverName;

  const itemStep = (code: string, blockerWhenMissing: () => string): StepResult => {
    const item = items.get(code);
    if (!item) return { status: 'blocked', blocker: blockerWhenMissing(), at: null, by: null };
    if (item.notApplicable) {
      // Not applicable is decided at intake; it counts as done when the case opened.
      return { status: 'complete', blocker: null, at: record.openedAt, by: record.ownerName };
    }
    if (item.verificationFailed) {
      return {
        status: 'blocked',
        blocker: item.verificationNote ?? `${reqName(code)} was rejected on review`,
        at: null,
        by: null,
      };
    }
    if (item.verifiedAt) {
      return { status: 'complete', blocker: null, at: item.verifiedAt, by: item.verifiedBy };
    }
    return { status: 'in_progress', blocker: null, at: null, by: null };
  };

  /** The application step is complete once the application is on file; its review is part of
   *  "all verified" later, so a pending application does not hold the candidate at Recruiting. */
  const applicationStep = (code: string): StepResult => {
    const item = items.get(code);
    if (!item || (!item.documentId && !item.verifiedAt) || item.verificationFailed) {
      return {
        status: 'blocked',
        blocker: item?.verificationFailed
          ? (item.verificationNote ?? `${reqName(code)} was rejected on review; re-collect it`)
          : `No ${reqName(code)} on file; the candidate completes it from their record`,
        at: null,
        by: null,
      };
    }
    return {
      status: 'complete',
      blocker: null,
      at: item.verifiedAt ?? record.openedAt,
      by: item.verifiedBy ?? record.ownerName,
    };
  };

  const oneConsentStep = (consent: ConsentRequest, label: string): StepResult => {
    const who = consent.subject ? `${label} (${consent.subject})` : label;
    switch (consent.status) {
      case 'signed':
        return { status: 'complete', blocker: null, at: consent.signedAt, by: consent.signerName };
      case 'sent':
      case 'viewed':
        return { status: 'in_progress', blocker: null, at: null, by: null };
      case 'declined':
        return {
          status: 'blocked',
          blocker: `${firstName} declined the ${who} consent on ${(consent.declinedAt ?? '').slice(0, 10)}; call before re-sending`,
          at: null,
          by: null,
        };
      case 'expired':
        return {
          status: 'blocked',
          blocker: `${who} consent link expired unsigned on ${consent.expiresAt.slice(0, 10)}; re-send it`,
          at: null,
          by: null,
        };
      case 'cancelled':
        return {
          status: 'blocked',
          blocker: `${who} consent was cancelled`,
          at: null,
          by: null,
        };
      default:
        return { status: 'not_started', blocker: null, at: null, by: null };
    }
  };

  const consentStep = (code: string): StepResult => {
    const group = consents.get(code) ?? [];
    const label = CONSENT_PURPOSE_LABELS[must(CONSENT_PURPOSE_BY_REQUIREMENT[code], code)];
    if (group.length === 0) {
      return {
        status: 'blocked',
        blocker: `No ${label} consent has been requested`,
        at: null,
        by: null,
      };
    }
    const results = group.map((c) => oneConsentStep(c, label));
    const blocked = results.find((r) => r.status === 'blocked');
    if (blocked) return blocked;
    if (results.every((r) => r.status === 'complete')) {
      // The group completed when its last signature landed.
      return results.reduce((latest, r) => ((r.at ?? '') > (latest.at ?? '') ? r : latest));
    }
    if (results.some((r) => r.status === 'in_progress' || r.status === 'complete')) {
      return { status: 'in_progress', blocker: null, at: null, by: null };
    }
    return { status: 'not_started', blocker: null, at: null, by: null };
  };

  const steps: VerificationStep[] = [];
  let priorComplete = true;
  let lastCompletedAt = record.openedAt;
  const push = (def: (typeof VERIFICATION_LADDER)[number], result: StepResult) => {
    steps.push({
      key: def.key,
      label: def.label,
      stage: def.stage,
      status: result.status,
      requirementCode: def.requirementCode,
      blocker: result.status === 'blocked' ? result.blocker : null,
      completedAt: result.status === 'complete' ? result.at : null,
      completedBy: result.status === 'complete' ? result.by : null,
    });
    if (result.status === 'complete') {
      if (result.at && result.at > lastCompletedAt) lastCompletedAt = result.at;
    } else {
      priorComplete = false;
    }
  };

  for (const def of VERIFICATION_LADDER) {
    // A retired requirement (background check, 2026-10-24) is no longer a step of the ladder.
    const requirement = def.requirementCode ? byCode.get(def.requirementCode) : undefined;
    if (requirement && !requirement.active) continue;
    switch (def.stage) {
      case 'recruiting':
        push(def, applicationStep(must(def.requirementCode)));
        break;
      case 'document_collection': {
        const code = must(def.requirementCode);
        push(
          def,
          itemStep(
            code,
            () => `No ${reqName(code)} on file; ask the driver to upload it from the portal`,
          ),
        );
        break;
      }
      case 'consent':
        push(def, consentStep(must(def.requirementCode)));
        break;
      case 'screening': {
        const code = must(def.requirementCode);
        push(
          def,
          itemStep(code, () => {
            const unsigned = (consents.get(code) ?? []).find((c) => c.status !== 'signed');
            if (unsigned) {
              return `${reqName(code)} cannot be ordered until the consent is signed (currently ${unsigned.status})`;
            }
            return `No ${reqName(code)} on file; order it`;
          }),
        );
        break;
      }
      case 'verification': {
        // Mandatory checks only: an optional item (no hold effect) never holds the case.
        const driverRules = requirementsFor('driver', input.requirements).filter(
          (r) => !POST_OFFER_REQUIREMENTS.has(r.code) && isMandatoryRequirement(r),
        );
        const allVerified = driverRules.every((r) => {
          const item = items.get(r.code);
          return (
            item !== undefined &&
            (item.notApplicable || (item.verifiedAt !== null && !item.verificationFailed))
          );
        });
        push(def, {
          status: allVerified ? 'complete' : priorComplete ? 'in_progress' : 'not_started',
          blocker: null,
          at: allVerified ? lastCompletedAt : null,
          by: allVerified ? (record.safetyReviewBy ?? record.ownerName) : null,
        });
        break;
      }
      case 'safety_review':
        push(def, {
          status: record.safetyReviewStatus,
          blocker: null,
          at: record.safetyReviewStatus === 'complete' ? record.safetyReviewAt : null,
          by: record.safetyReviewStatus === 'complete' ? record.safetyReviewBy : null,
        });
        break;
      case 'decision':
        push(def, {
          status: record.decisionAt !== null ? 'complete' : 'not_started',
          blocker: null,
          at: record.decisionAt,
          by: record.decisionBy,
        });
        break;
      default:
        break;
    }
  }

  // A decided case is at Active (hired) or stays at Decision (rejected), whatever an item does
  // afterwards: the pipeline ends at the decision. Before that, the stage is the first open step.
  let stage: VerificationStage;
  if (record.decision !== null) {
    stage = record.decision === 'rejected' ? 'decision' : 'active';
  } else {
    const firstOpen = steps.find((s) => s.status !== 'complete');
    stage = firstOpen ? firstOpen.stage : 'active';
  }
  const stageSince = record.decisionAt ?? lastCompletedAt;
  const daysInStage = Math.max(
    0,
    Math.floor((now.getTime() - new Date(stageSince).getTime()) / DAY),
  );

  return { ...record, stage, steps, daysInStage };
}
