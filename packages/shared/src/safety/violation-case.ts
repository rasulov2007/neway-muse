import type { SafetyViolation, SafetyViolationCase, ViolationStatus } from './cases.js';

/**
 * One paper, one case (owner, 2026-10-21).
 *
 * An inspection report with three violations on it is one case: one row in the list, one driver
 * review, one follow-up (status, charge or bonus, training, notes) held on the lead violation - the
 * first one recorded. Each violation keeps what is its own: the rule, what it was, the category,
 * OOS and its correction. Violations share a case through `caseId`; one without it is a case of
 * its own, exactly as before.
 */

/** The key a violation is grouped under: its case id, or its own id when it stands alone. */
export function violationCaseKey(v: Pick<SafetyViolation, 'id' | 'caseId'>): string {
  return v.caseId ?? v.id;
}

/** "392.9A2-C (OOS)": the rule, or what it was when no rule was written. */
export function violationLineLabel(v: Pick<SafetyViolation, 'code' | 'description' | 'oos'>): string {
  const label = v.code?.trim() || v.description.trim();
  return v.oos ? `${label} (OOS)` : label;
}

/** "3 violations: 392.9A2-C (OOS), 393.47E, 393.53B-B"; one violation reads as its own label. */
export function violationCaseSummary(violations: Pick<SafetyViolation, 'code' | 'description' | 'oos'>[]): string {
  if (violations.length === 1) return violationLineLabel(violations[0]!);
  return `${violations.length} violations: ${violations.map(violationLineLabel).join(', ')}`;
}

/**
 * The case's one status: the lead's follow-up decision. Closed only once every violation is
 * closed; Ready to close only once every violation's tracks are finished.
 */
export function violationCaseStatus(violations: Pick<SafetyViolation, 'status' | 'closedAt' | 'openTracks'>[]): ViolationStatus {
  if (violations.length === 0) return 'undecided';
  if (violations.every((v) => v.closedAt)) return 'closed';
  const lead = violations[0]!;
  const status = lead.closedAt ? (violations.find((v) => !v.closedAt)?.status ?? 'undecided') : lead.status;
  if (status === 'ready_to_close' && violations.some((v) => !v.closedAt && v.openTracks.length > 0)) return 'not_charged';
  return status;
}

const byRecorded = (a: SafetyViolation, b: SafetyViolation) => a.createdAt.localeCompare(b.createdAt) || a.number.localeCompare(b.number, undefined, { numeric: true });

/** Violations folded into cases, in the order their first violation appears. */
export function groupViolationCases(violations: SafetyViolation[]): SafetyViolationCase[] {
  const groups = new Map<string, SafetyViolation[]>();
  for (const v of violations) {
    const key = violationCaseKey(v);
    const bucket = groups.get(key);
    if (bucket) bucket.push(v);
    else groups.set(key, [v]);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const sorted = [...rows].sort(byRecorded);
    const lead = sorted[0]!;
    const withMoney = sorted.filter((v) => v.moneyKind && v.moneyCents);
    const moneyKind = withMoney[0]?.moneyKind ?? null;
    return {
      id: key,
      caseId: lead.caseId,
      leadId: lead.id,
      number: lead.number,
      occurredAt: lead.occurredAt,
      violationType: lead.violationType,
      reportNumber: sorted.find((v) => v.reportNumber)?.reportNumber ?? null,
      state: sorted.find((v) => v.state)?.state ?? null,
      inspectionLevel: sorted.find((v) => v.inspectionLevel)?.inspectionLevel ?? null,
      agency: sorted.find((v) => v.agency)?.agency ?? '',
      issuedTo: lead.issuedTo,
      driverId: lead.driverId,
      driverName: lead.driverName,
      truckId: lead.truckId,
      truckNumber: lead.truckNumber,
      isTest: sorted.every((v) => v.isTest),
      reviewId: lead.reviewId ?? sorted.find((v) => v.reviewId)?.reviewId ?? null,
      reviewNumber: lead.reviewNumber ?? sorted.find((v) => v.reviewNumber)?.reviewNumber ?? null,
      oos: sorted.some((v) => v.oos),
      status: violationCaseStatus(sorted),
      trainingStatus: lead.trainingStatus,
      moneyKind,
      moneyCents: moneyKind ? withMoney.filter((v) => v.moneyKind === moneyKind).reduce((sum, v) => sum + (v.moneyCents ?? 0), 0) : null,
      closed: sorted.every((v) => v.closedAt),
      summary: violationCaseSummary(sorted),
      violations: sorted,
    };
  });
}
