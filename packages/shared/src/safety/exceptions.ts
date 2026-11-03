/**
 * What in Safety needs a person today.
 *
 * Same discipline as the dispatch attention queue and the fleet exception panel: every finding
 * carries the ids of the exact records behind its count, so the tile and the list it opens can
 * never disagree, and a finding with a count of zero is not produced at all. An empty queue means
 * there is nothing outstanding — the panel is meant to disappear, not to reassure.
 *
 * A check that cannot run says so in `unavailable`, with what it would need.
 */

import { correctiveActionState, type TaskStatus } from './corrective-action.js';
import {
  defectUrgency,
  inspectionState,
  type DefectSeverity,
  type DefectStatus,
} from './inspection.js';
import { isAccidentOpen, type AccidentStatus, type Preventability } from './accident.js';
import { violationState, type ViolationSeverity } from './violation.js';

export type SafetyExceptionGroup = 'inspection' | 'defect' | 'violation' | 'accident' | 'action';
export type SafetyExceptionSeverity = 'critical' | 'warning' | 'info';

export interface SafetyExceptionTarget {
  to: string;
  search?: Record<string, string>;
}

export interface SafetyException {
  key: string;
  group: SafetyExceptionGroup;
  severity: SafetyExceptionSeverity;
  /** The finding without its count, e.g. "inspections failed with defects still open". */
  label: string;
  count: number;
  /** Ids of the exact records behind the count. */
  ids: string[];
  target: SafetyExceptionTarget;
  /** Why this costs the carrier something. */
  reason: string;
}

export interface SafetyUnavailableCheck {
  key: string;
  label: string;
  requires: string;
}

export interface ExceptionInspection {
  id: string;
  at: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  result: 'pass' | 'fail' | null;
  openDefects: number;
  totalDefects: number;
}

export interface ExceptionDefect {
  id: string;
  severity: DefectSeverity;
  status: DefectStatus;
  dueOn: string | null;
  outOfService: boolean;
}

export interface ExceptionViolation {
  id: string;
  severity: ViolationSeverity;
  resolvedAt: string | null;
  contested: boolean;
  hasOpenCorrectiveAction: boolean;
  correctiveActionDueOn: string | null;
}

export interface ExceptionAccident {
  id: string;
  status: AccidentStatus;
  preventable: Preventability;
  recordable: boolean;
  ownerId: string | null;
  missingEvidence: number;
}

export interface ExceptionCorrectiveAction {
  id: string;
  status: TaskStatus;
  assigneeId: string | null;
  dueAt: string;
  completedAt: string | null;
}

export interface SafetyExceptionInput {
  inspections: ExceptionInspection[];
  defects: ExceptionDefect[];
  violations: ExceptionViolation[];
  accidents: ExceptionAccident[];
  correctiveActions: ExceptionCorrectiveAction[];
}

export interface SafetyExceptionQueue {
  items: SafetyException[];
  unavailable: SafetyUnavailableCheck[];
}

const SEVERITY_RANK: Record<SafetyExceptionSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function buildSafetyExceptions(
  input: SafetyExceptionInput,
  nowIso: string,
): SafetyExceptionQueue {
  const today = nowIso.slice(0, 10);
  const items: SafetyException[] = [];

  const push = (item: Omit<SafetyException, 'count'>) => {
    if (item.ids.length === 0) return;
    items.push({ ...item, count: item.ids.length });
  };

  // --- Defects that stop a unit moving ---------------------------------------------------------
  const blocking = input.defects
    .filter((d) => defectUrgency(d, today).blocksDispatch)
    .map((d) => d.id);
  push({
    key: 'defects_out_of_service',
    group: 'defect',
    severity: 'critical',
    label: 'defects have a unit out of service',
    ids: blocking,
    target: { to: '/safety/inspections', search: { defects: 'blocking' } },
    reason:
      'An out-of-service defect is a unit that cannot legally move and a roadside stop that will find it again.',
  });

  const overdueDefects = input.defects
    .filter((d) => defectUrgency(d, today).overdue)
    .map((d) => d.id);
  push({
    key: 'defects_overdue',
    group: 'defect',
    severity: 'warning',
    label: 'defect repairs are past their due date',
    ids: overdueDefects,
    target: { to: '/safety/inspections', search: { defects: 'overdue' } },
    reason: 'A defect left past its repair date is the one an auditor asks about first.',
  });

  // --- Inspections -----------------------------------------------------------------------------
  const needsAction: string[] = [];
  const overdueInspections: string[] = [];
  for (const inspection of input.inspections) {
    const state = inspectionState(inspection, nowIso).state;
    if (state === 'corrective_action_required') needsAction.push(inspection.id);
    else if (state === 'overdue') overdueInspections.push(inspection.id);
  }

  push({
    key: 'inspections_need_action',
    group: 'inspection',
    severity: 'critical',
    label: 'inspections have defects still open',
    ids: needsAction,
    target: { to: '/safety/inspections', search: { state: 'corrective_action_required' } },
    reason: 'The inspection is done; the work it found is not.',
  });

  push({
    key: 'inspections_overdue',
    group: 'inspection',
    severity: 'warning',
    label: 'inspections were booked and never performed',
    ids: overdueInspections,
    target: { to: '/safety/inspections', search: { state: 'overdue' } },
    reason: 'A missed annual inspection takes the unit out of service the day it lapses.',
  });

  // --- Violations ------------------------------------------------------------------------------
  const criticalViolations = input.violations
    .filter((v) => violationState(v, today).state !== 'resolved' && v.severity === 'critical')
    .map((v) => v.id);
  push({
    key: 'violations_critical_open',
    group: 'violation',
    severity: 'critical',
    label: 'critical violations are unresolved',
    ids: criticalViolations,
    target: { to: '/safety/violations', search: { severity: 'critical', state: 'open' } },
    reason: 'Critical violations weigh heaviest in the BASIC they land in.',
  });

  const overdueViolations = input.violations
    .filter((v) => violationState(v, today).state === 'overdue')
    .map((v) => v.id);
  push({
    key: 'violations_overdue',
    group: 'violation',
    severity: 'warning',
    label: 'violations have an overdue corrective action',
    ids: overdueViolations,
    target: { to: '/safety/violations', search: { state: 'overdue' } },
    reason: 'An unfinished corrective action is what turns one violation into a pattern.',
  });

  // --- Accidents -------------------------------------------------------------------------------
  const undetermined = input.accidents
    .filter((a) => isAccidentOpen(a.status) && a.preventable === 'undetermined')
    .map((a) => a.id);
  push({
    key: 'accidents_preventability_undecided',
    group: 'accident',
    severity: 'warning',
    label: 'open accidents have no preventability decision',
    ids: undetermined,
    target: { to: '/safety/accidents', search: { preventable: 'undetermined' } },
    reason:
      'Preventability drives the driver record and the insurer conversation; an undecided file settles neither.',
  });

  const unassigned = input.accidents
    .filter((a) => isAccidentOpen(a.status) && !a.ownerId)
    .map((a) => a.id);
  push({
    key: 'accidents_unassigned',
    group: 'accident',
    severity: 'critical',
    label: 'open accidents have no investigator',
    ids: unassigned,
    target: { to: '/safety/accidents', search: { owner: 'unassigned' } },
    reason: 'A file nobody owns is a file nobody is working.',
  });

  const missingEvidence = input.accidents
    .filter((a) => a.recordable && a.missingEvidence > 0)
    .map((a) => a.id);
  push({
    key: 'accidents_missing_evidence',
    group: 'accident',
    severity: 'warning',
    label: 'DOT recordable accidents are missing required evidence',
    ids: missingEvidence,
    target: { to: '/safety/accidents', search: { evidence: 'missing' } },
    reason:
      'A recordable crash file without its police report and driver statement is the one that fails an audit.',
  });

  // --- Corrective actions ----------------------------------------------------------------------
  const lateActions = input.correctiveActions
    .filter((a) => correctiveActionState(a, nowIso).state === 'overdue')
    .map((a) => a.id);
  push({
    key: 'corrective_actions_overdue',
    group: 'action',
    severity: 'critical',
    label: 'corrective actions are overdue',
    ids: lateActions,
    target: { to: '/safety', search: { actions: 'overdue' } },
    reason:
      'Every one of these was raised because something went wrong and someone agreed to fix it.',
  });

  const unownedActions = input.correctiveActions
    .filter((a) => correctiveActionState(a, nowIso).state === 'open')
    .map((a) => a.id);
  push({
    key: 'corrective_actions_unassigned',
    group: 'action',
    severity: 'warning',
    label: 'corrective actions have nobody assigned',
    ids: unownedActions,
    target: { to: '/safety', search: { actions: 'unassigned' } },
    reason: 'An unassigned action is a decision that has not been made yet.',
  });

  items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count);

  return {
    items,
    unavailable: [
      {
        key: 'csa_percentiles',
        label: 'CSA BASIC percentiles',
        requires: "FMCSA SMS data for the carrier's DOT number",
      },
      {
        key: 'mvr_psp_monitoring',
        label: 'MVR and PSP monitoring',
        requires: 'A connected MVR/PSP provider',
      },
      {
        key: 'drug_alcohol',
        label: 'Drug and alcohol testing programme',
        requires: 'The drug_alcohol_tests module and a connected consortium',
      },
    ],
  };
}
