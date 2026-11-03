/**
 * The compliance engine.
 *
 * Pure functions over a requirement catalog and the items recorded against it. No I/O, no clock of
 * its own — `today` is always passed in, so the same inputs always produce the same output and
 * every rule is testable. Both the web app and (when the compliance module lands) the API run this
 * exact code, so a driver's status can never differ between the safety desk and dispatch.
 *
 * Status is derived here rather than stored, because a stored status silently goes stale: a
 * medical card that was `valid` last night is `expired` this morning with no row having changed.
 *
 * Every conclusion carries `reasons` — the evidence convention from docs/AI_ARCHITECTURE.md — so a
 * safety manager can check the engine's answer instead of trusting it.
 */
import type {
  ComplianceRole,
  ComplianceScope,
  ComplianceSeverity,
  EscalationStep,
  QualificationRequirement,
} from './requirement.js';
import {
  FAILING_STATUSES,
  SATISFIED_STATUSES,
  type ComplianceStatus,
  type EntityCompliance,
  type EntityComplianceState,
  type EvaluatedItem,
  type QualificationItem,
} from './item.js';
import { addMonthsClamped, isIsoCalendarDate } from '../dates.js';

const DAY_MS = 86_400_000;

function days(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

/** Parses `YYYY-MM-DD` as a UTC midnight. Both sides of every comparison use the same basis. */
function parseIsoDate(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(time) ? null : time;
}

/** Whole days from `today` to `target`; negative once past. Null when either date is unparseable. */
export function daysBetween(today: string, target: string): number | null {
  const from = parseIsoDate(today);
  const to = parseIsoDate(target);
  if (from === null || to === null) return null;
  return Math.round((to - from) / DAY_MS);
}

const SEVERITY_RANK: Record<ComplianceSeverity, number> = {
  ok: 0,
  info: 1,
  warning: 2,
  critical: 3,
};

export function worstSeverity(severities: readonly ComplianceSeverity[]): ComplianceSeverity {
  return severities.reduce<ComplianceSeverity>(
    (worst, severity) => (SEVERITY_RANK[severity] > SEVERITY_RANK[worst] ? severity : worst),
    'ok',
  );
}

/**
 * The escalation rung in force at `daysRemaining`. Steps are sorted ascending and the last one
 * whose threshold has been crossed wins, so a ladder of 14 → 7 → 3 → 0 escalates as time runs out.
 */
export function escalationFor(
  escalation: readonly EscalationStep[],
  daysRemaining: number | null,
): EscalationStep | null {
  if (daysRemaining === null || escalation.length === 0) return null;
  // Ascending by threshold, so the first rung the value fits under is the tightest one crossed.
  const ordered = [...escalation].sort((a, b) => a.atDaysRemaining - b.atDaysRemaining);
  return ordered.find((step) => daysRemaining <= step.atDaysRemaining) ?? null;
}

/** The lead-day window an item has fallen into, e.g. 30 when 22 days remain of `[90,60,30,7]`. */
export function warningStageFor(
  leadDays: readonly number[],
  daysRemaining: number | null,
): number | null {
  if (daysRemaining === null || daysRemaining < 0) return null;
  const ascending = [...leadDays].sort((a, b) => a - b);
  for (const lead of ascending) {
    if (daysRemaining <= lead) return lead;
  }
  return null;
}

export interface EvaluateOptions {
  /** Today in the company timezone, `YYYY-MM-DD`. Never read from the system clock in here. */
  today: string;
}

function actionFor(
  status: ComplianceStatus,
  requirement: QualificationRequirement,
  expiresOn: string | null,
): string | null {
  switch (status) {
    case 'missing':
      return requirement.requiresDocument
        ? `Collect and upload the ${requirement.name}`
        : `Record the ${requirement.name}`;
    case 'pending_verification':
      return `Verify the ${requirement.name} on file`;
    case 'verification_failed':
      return `Re-collect the ${requirement.name}; the last submission was rejected`;
    case 'expiring':
      return `Renew the ${requirement.name}${expiresOn ? ` before ${expiresOn}` : ''}`;
    case 'expired':
      return `Renew the ${requirement.name}${expiresOn ? `; it lapsed on ${expiresOn}` : ''}`;
    default:
      return null;
  }
}

/**
 * The date a fixed-term requirement falls due: the report date (else the day it was received) plus
 * the requirement's `validityMonths`, never later than an expiry typed on the record.
 *
 * Owner, 2026-10-24: an MVR and a PSP are good for 6 months from the day they were dated, so a
 * report filed when the term was 12 months (expiry stored as issue + 12) still falls due at 6, and
 * a PSP filed when it never expired (no expiry stored) ages from its date like a new one. A type
 * without a fixed term reads the stored expiry unchanged.
 */
export function effectiveExpiresOn(
  requirement: Pick<QualificationRequirement, 'hasExpiry' | 'validityMonths'>,
  item: Pick<QualificationItem, 'issuedOn' | 'expiresOn' | 'receivedOn'> | null,
): string | null {
  if (!item) return null;
  const stored = item.expiresOn ?? null;
  if (!requirement.hasExpiry || !requirement.validityMonths) return stored;
  const datedOn = isIsoCalendarDate(item.issuedOn)
    ? item.issuedOn
    : isIsoCalendarDate(item.receivedOn)
      ? item.receivedOn
      : null;
  const term = datedOn ? addMonthsClamped(datedOn, requirement.validityMonths) : null;
  if (term === null) return stored;
  if (stored === null) return term;
  return term < stored ? term : stored;
}

/**
 * One requirement against one entity, as of `today`.
 *
 * Pass `item = null` for a requirement with nothing on file — that is a real finding (`missing`),
 * not an absence of data, and it is how the zero-miss guarantee is kept: the catalog decides what
 * must exist, so a requirement nobody has ever filled in still shows up.
 */
export function evaluateItem(
  requirement: QualificationRequirement,
  item: QualificationItem | null,
  entity: { id: string; label: string },
  options: EvaluateOptions,
): EvaluatedItem {
  const { today } = options;
  const reasons: string[] = [];

  const expiresOn = effectiveExpiresOn(requirement, item);
  const daysRemaining = requirement.hasExpiry && expiresOn ? daysBetween(today, expiresOn) : null;

  let status: ComplianceStatus;
  let inGracePeriod = false;

  if (item?.notApplicable) {
    status = 'not_applicable';
    reasons.push(`Marked not applicable${item.notes ? `: ${item.notes}` : ''}`);
  } else if (item?.waivedUntil && (daysBetween(today, item.waivedUntil) ?? -1) >= 0) {
    status = 'waived';
    reasons.push(
      `Waived until ${item.waivedUntil}${item.waivedReason ? ` — ${item.waivedReason}` : ''}`,
    );
  } else if (!item) {
    status = 'missing';
    reasons.push('Nothing on file for this requirement');
  } else if (item.verificationFailed) {
    status = 'verification_failed';
    reasons.push(item.verificationNote ?? 'A reviewer rejected the submitted document');
  } else if (requirement.requiresDocument && !item.documentId) {
    status = 'missing';
    reasons.push('This requirement needs a document and none is attached');
  } else if (requirement.hasExpiry && !expiresOn) {
    status = 'missing';
    reasons.push('No expiry date recorded, so the item cannot be shown as current');
  } else if (requirement.requiresVerification && !item.verifiedAt) {
    status = 'pending_verification';
    reasons.push('On file but not yet verified by safety');
  } else if (daysRemaining !== null && daysRemaining < 0) {
    inGracePeriod = Math.abs(daysRemaining) <= requirement.policy.gracePeriodDays;
    status = 'expired';
    reasons.push(`Expired ${days(Math.abs(daysRemaining))} ago on ${expiresOn}`);
    if (inGracePeriod) {
      reasons.push(`Inside the ${requirement.policy.gracePeriodDays}-day grace period`);
    }
  } else if (
    daysRemaining !== null &&
    warningStageFor(requirement.policy.leadDays, daysRemaining) !== null
  ) {
    status = 'expiring';
    reasons.push(`Expires in ${days(daysRemaining)} on ${expiresOn}`);
  } else {
    status = item.verifiedAt ? 'verified' : 'valid';
    if (item.verifiedAt) reasons.push(`Verified${item.verifiedBy ? ` by ${item.verifiedBy}` : ''}`);
    if (expiresOn && daysRemaining !== null) reasons.push(`Current until ${expiresOn}`);
  }

  const warningStage =
    status === 'expiring' ? warningStageFor(requirement.policy.leadDays, daysRemaining) : null;

  const escalation = escalationFor(requirement.policy.escalation, daysRemaining);

  let severity: ComplianceSeverity;
  if (SATISFIED_STATUSES.includes(status)) {
    severity = 'ok';
  } else if (status === 'expiring') {
    severity = escalation?.severity ?? 'info';
  } else if (status === 'pending_verification') {
    severity = 'warning';
  } else if (status === 'expired' && inGracePeriod) {
    severity = 'warning';
  } else {
    // expired past grace, missing, verification_failed
    severity = requirement.holdEffect === 'none' ? 'warning' : 'critical';
  }

  const blocksDispatch =
    FAILING_STATUSES.includes(status) &&
    !inGracePeriod &&
    (requirement.holdEffect === 'driver_hold' ||
      requirement.holdEffect === 'unit_hold' ||
      requirement.holdEffect === 'company_hold');

  if (blocksDispatch) {
    reasons.push(`${requirement.name} blocks dispatch until resolved`);
  }

  const requiredAction = actionFor(status, requirement, expiresOn);
  const deadline =
    status === 'expiring' || status === 'expired' ? expiresOn : requiredAction ? today : null;

  return {
    itemId: item?.id ?? null,
    requirementCode: requirement.code,
    requirementName: requirement.name,
    scope: requirement.scope,
    entityId: entity.id,
    entityLabel: entity.label,
    status,
    severity,
    expiresOn,
    daysRemaining,
    warningStage,
    inGracePeriod,
    blocksDispatch,
    owner: requirement.owner,
    notify: escalation?.notify ?? [requirement.owner],
    reasons,
    requiredAction,
    deadline,
  };
}

/**
 * Every requirement that applies to one entity, rolled up.
 *
 * `requirements` must already be filtered to the ones that apply (scope, and any company rule such
 * as "hazmat endorsement only for hazmat-certified drivers"). Applicability is a data decision, so
 * the engine does not guess at it.
 */
export function evaluateEntity(
  entity: { scope: ComplianceScope; id: string; label: string },
  requirements: readonly QualificationRequirement[],
  items: readonly QualificationItem[],
  options: EvaluateOptions,
): EntityCompliance {
  const byCode = new Map(items.map((item) => [item.requirementCode, item]));
  const evaluated = requirements
    .filter((requirement) => requirement.active)
    .map((requirement) =>
      evaluateItem(requirement, byCode.get(requirement.code) ?? null, entity, options),
    );

  const counts = {
    total: evaluated.length,
    satisfied: evaluated.filter((i) => SATISFIED_STATUSES.includes(i.status)).length,
    expiring: evaluated.filter((i) => i.status === 'expiring').length,
    expired: evaluated.filter((i) => i.status === 'expired').length,
    missing: evaluated.filter((i) => i.status === 'missing').length,
    pendingVerification: evaluated.filter((i) => i.status === 'pending_verification').length,
    verificationFailed: evaluated.filter((i) => i.status === 'verification_failed').length,
    waived: evaluated.filter((i) => i.status === 'waived').length,
  };

  const blocking = evaluated.filter((i) => i.blocksDispatch);
  const failing = evaluated.filter((i) => FAILING_STATUSES.includes(i.status) && !i.inGracePeriod);
  const atRisk = evaluated.filter(
    (i) => i.status === 'expiring' || i.status === 'pending_verification' || i.inGracePeriod,
  );

  let state: EntityComplianceState;
  if (failing.length > 0) state = 'non_compliant';
  else if (atRisk.length > 0) state = 'at_risk';
  else state = 'compliant';

  const deadlines = evaluated
    .filter((i) => i.deadline !== null && !SATISFIED_STATUSES.includes(i.status))
    .map((i) => i.deadline as string)
    .sort();

  return {
    scope: entity.scope,
    entityId: entity.id,
    entityLabel: entity.label,
    state,
    dispatchable: blocking.length === 0,
    gateReasons: blocking.map(
      (i) =>
        `${i.requirementName} ${i.status === 'expired' ? 'expired' : i.status.replace(/_/g, ' ')}`,
    ),
    severity: worstSeverity(evaluated.map((i) => i.severity)),
    nextDeadline: deadlines[0] ?? null,
    items: evaluated,
    counts,
  };
}

export interface ComplianceSummary {
  entities: number;
  compliant: number;
  atRisk: number;
  nonCompliant: number;
  notDispatchable: number;
  expiringSoon: number;
  expired: number;
  missing: number;
  pendingVerification: number;
  verificationFailed: number;
  /** Items whose severity is critical — the "act today" number. */
  critical: number;
}

/**
 * The command-centre headline. Every field is a count of records the UI can list, so a number on
 * screen always has an exact set of rows behind it.
 */
export function summarizeCompliance(
  entities: readonly EntityCompliance[],
  options: { expiringWithinDays?: number } = {},
): ComplianceSummary {
  const within = options.expiringWithinDays ?? 30;
  const items = entities.flatMap((entity) => entity.items);
  return {
    entities: entities.length,
    compliant: entities.filter((e) => e.state === 'compliant').length,
    atRisk: entities.filter((e) => e.state === 'at_risk').length,
    nonCompliant: entities.filter((e) => e.state === 'non_compliant').length,
    notDispatchable: entities.filter((e) => !e.dispatchable).length,
    expiringSoon: items.filter(
      (i) => i.status === 'expiring' && i.daysRemaining !== null && i.daysRemaining <= within,
    ).length,
    expired: items.filter((i) => i.status === 'expired').length,
    missing: items.filter((i) => i.status === 'missing').length,
    pendingVerification: items.filter((i) => i.status === 'pending_verification').length,
    verificationFailed: items.filter((i) => i.status === 'verification_failed').length,
    critical: items.filter((i) => i.severity === 'critical').length,
  };
}

export interface ComplianceAction {
  key: string;
  item: EvaluatedItem;
  severity: ComplianceSeverity;
  owner: ComplianceRole;
  deadline: string | null;
  blocksDispatch: boolean;
}

/**
 * The unified work queue: one entry per unsatisfied item, worst first, then soonest deadline.
 * Sorting is stable on the entity label so the list does not shuffle between renders.
 */
export function buildActionQueue(entities: readonly EntityCompliance[]): ComplianceAction[] {
  const actions = entities.flatMap((entity) =>
    entity.items
      .filter((item) => item.requiredAction !== null)
      .map<ComplianceAction>((item) => ({
        key: `${item.scope}:${item.entityId}:${item.requirementCode}`,
        item,
        severity: item.severity,
        owner: item.owner,
        deadline: item.deadline,
        blocksDispatch: item.blocksDispatch,
      })),
  );

  return actions.sort((a, b) => {
    if (a.blocksDispatch !== b.blocksDispatch) return a.blocksDispatch ? -1 : 1;
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.deadline !== b.deadline) {
      if (a.deadline === null) return 1;
      if (b.deadline === null) return -1;
      return a.deadline < b.deadline ? -1 : 1;
    }
    return a.item.entityLabel.localeCompare(b.item.entityLabel);
  });
}
