/**
 * Where an inspection stands.
 *
 * The stored record (`inspections` in docs/DATABASE.md §3.9) has a `result` of pass or fail and no
 * status column, deliberately: a status column would be a second copy of facts already present in
 * the timestamps and the defects, and a second copy is a thing that goes stale. So the lifecycle a
 * safety manager works from is **derived** here, from when the inspection was scheduled, when it
 * was performed, what it found, and whether the defects it found have been cleared.
 *
 * Honesty rules:
 *  - An inspection with no result yet is `scheduled` or `in_progress`, never optimistically passed.
 *  - `corrective_action_required` outranks `failed` in the queue, because it is the state that
 *    still needs someone to do something.
 *  - A missed appointment is `overdue`, not silently still `scheduled`.
 */

/** `inspections.kind`. */
export const INSPECTION_KINDS = [
  'annual_dot',
  'pre_trip',
  'post_trip',
  'roadside',
  'other',
] as const;
export type InspectionKind = (typeof INSPECTION_KINDS)[number];

/** `inspections.result`. Null until the inspection has actually been performed. */
export type InspectionResult = 'pass' | 'fail';

/** `inspections.asset_type` / `defects.asset_type`. */
export const INSPECTION_ASSET_TYPES = ['truck', 'trailer'] as const;
export type InspectionAssetType = (typeof INSPECTION_ASSET_TYPES)[number];

export const INSPECTION_STATES = [
  'scheduled',
  'in_progress',
  'passed',
  'failed',
  'corrective_action_required',
  'overdue',
  'cancelled',
] as const;
export type InspectionState = (typeof INSPECTION_STATES)[number];

export interface InspectionStateInput {
  /** When the inspection is booked for, or was performed. */
  at: string;
  /** Set once someone begins the walk-around. */
  startedAt?: string | null;
  /** Set when the inspector signs it off. */
  completedAt?: string | null;
  cancelledAt?: string | null;
  result?: InspectionResult | null;
  /** Defects raised by this inspection that are still open or merely scheduled. */
  openDefects?: number;
  /** Defects raised by this inspection in total. */
  totalDefects?: number;
}

export interface InspectionStateResult {
  state: InspectionState;
  /** True when a person still has to do something about this inspection. */
  actionable: boolean;
  /** Why this answer, in the operator's language. */
  reasons: string[];
}

export interface InspectionPolicy {
  /** Hours past its appointment before an unperformed inspection is called overdue. */
  overdueAfterHours: number;
}

export const DEFAULT_INSPECTION_POLICY: InspectionPolicy = { overdueAfterHours: 24 };

const MS_PER_HOUR = 3_600_000;

export function inspectionState(
  input: InspectionStateInput,
  nowIso: string,
  policy: InspectionPolicy = DEFAULT_INSPECTION_POLICY,
): InspectionStateResult {
  if (input.cancelledAt) {
    return { state: 'cancelled', actionable: false, reasons: ['Inspection was cancelled'] };
  }

  const now = Date.parse(nowIso);

  if (input.completedAt && input.result) {
    if (input.result === 'pass') {
      const reasons = ['Inspection passed'];
      if ((input.totalDefects ?? 0) > 0) {
        reasons.push(
          `${input.totalDefects} defect${input.totalDefects === 1 ? '' : 's'} noted but none out-of-service`,
        );
      }
      // A passed inspection that still left open defects is not finished work.
      if ((input.openDefects ?? 0) > 0) {
        return {
          state: 'corrective_action_required',
          actionable: true,
          reasons: [
            ...reasons,
            `${input.openDefects} defect${input.openDefects === 1 ? '' : 's'} still open`,
          ],
        };
      }
      return { state: 'passed', actionable: false, reasons };
    }

    if ((input.openDefects ?? 0) > 0) {
      return {
        state: 'corrective_action_required',
        actionable: true,
        reasons: [
          'Inspection failed',
          `${input.openDefects} defect${input.openDefects === 1 ? '' : 's'} still open`,
        ],
      };
    }
    return {
      state: 'failed',
      actionable: false,
      reasons: ['Inspection failed', 'Every defect it raised has been cleared'],
    };
  }

  if (input.startedAt) {
    return { state: 'in_progress', actionable: true, reasons: ['Inspection is under way'] };
  }

  const due = Date.parse(input.at);
  if (!Number.isNaN(due) && now - due > policy.overdueAfterHours * MS_PER_HOUR) {
    const hours = Math.floor((now - due) / MS_PER_HOUR);
    return {
      state: 'overdue',
      actionable: true,
      reasons: [`Booked for ${input.at.slice(0, 10)} and not performed`, `${hours} hours past due`],
    };
  }

  return { state: 'scheduled', actionable: false, reasons: ['Booked and not yet performed'] };
}

/** Worst first, for a queue a safety manager works top-down. */
export const INSPECTION_STATE_ORDER: readonly InspectionState[] = [
  'corrective_action_required',
  'overdue',
  'failed',
  'in_progress',
  'scheduled',
  'passed',
  'cancelled',
];

export function inspectionStateRank(state: InspectionState): number {
  const index = INSPECTION_STATE_ORDER.indexOf(state);
  return index === -1 ? INSPECTION_STATE_ORDER.length : index;
}

// ---------------------------------------------------------------------------------------------
// Defects — the findings an inspection raises (`defects` in docs/DATABASE.md §3.9)
// ---------------------------------------------------------------------------------------------

export const DEFECT_SOURCES = ['inspection', 'telematics', 'driver_report', 'mpg_drop'] as const;
export type DefectSource = (typeof DEFECT_SOURCES)[number];

export const DEFECT_STATUSES = ['open', 'scheduled', 'resolved', 'deferred'] as const;
export type DefectStatus = (typeof DEFECT_STATUSES)[number];

export const DEFECT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type DefectSeverity = (typeof DEFECT_SEVERITIES)[number];

export interface DefectUrgencyInput {
  severity: DefectSeverity;
  status: DefectStatus;
  /** When the shop is booked to fix it, when it is booked. */
  dueOn?: string | null;
  /** True when this defect put the unit out of service at the roadside. */
  outOfService?: boolean;
}

export interface DefectUrgency {
  /** Rank in a worst-first queue. Lower is worse. */
  rank: number;
  /** True when this defect stops the unit being dispatched. */
  blocksDispatch: boolean;
  overdue: boolean;
  summary: string;
}

const SEVERITY_RANK: Record<DefectSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * How urgent one defect is.
 *
 * A critical defect and an out-of-service defect are not decoration: both stop the unit moving, so
 * they say so rather than merely rendering red.
 */
export function defectUrgency(input: DefectUrgencyInput, today: string): DefectUrgency {
  const resolved = input.status === 'resolved';
  const overdue =
    !resolved &&
    input.dueOn !== null &&
    input.dueOn !== undefined &&
    input.dueOn.slice(0, 10) < today.slice(0, 10);

  const blocksDispatch =
    !resolved && (input.outOfService === true || input.severity === 'critical');

  const parts: string[] = [];
  if (input.outOfService) parts.push('Placed out of service at the roadside');
  else if (input.severity === 'critical') parts.push('Critical defect');
  if (overdue) parts.push(`Repair was due ${input.dueOn}`);
  if (resolved) parts.push('Resolved');
  else if (input.status === 'scheduled') parts.push('Repair booked');
  else if (input.status === 'deferred') parts.push('Deferred');

  return {
    rank: resolved ? 99 : SEVERITY_RANK[input.severity] + (overdue ? -0.5 : 0),
    blocksDispatch,
    overdue,
    summary: parts.length > 0 ? parts.join(' · ') : 'Open',
  };
}
