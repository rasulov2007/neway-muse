import type {
  AccidentSeverity,
  CorrectiveActionState,
  DefectSeverity,
  InspectionKind,
  InspectionState,
  ViolationCategory,
  ViolationSeverity,
  ViolationState,
} from '@neway/shared';
import type { BadgeTone } from '@/design-system';
import type { AccidentKind } from '@/demo';

/**
 * Presentation for the Safety vocabulary.
 *
 * Only the enums the design system's status registry does not already own live here. Every stored
 * status — an accident's `reported`/`investigating`/`closed`, a claim's `settled` — goes through
 * `StatusBadge`, so this file never becomes a second opinion about what a status looks like. What
 * it does own is the *derived* vocabularies (inspection state, violation state, corrective-action
 * state) and the domain taxonomies (CSA BASICs, inspection kinds, accident kinds).
 */

export const INSPECTION_KIND_LABEL: Record<InspectionKind, string> = {
  annual_dot: 'Annual DOT',
  pre_trip: 'Pre-trip',
  post_trip: 'Post-trip',
  roadside: 'Roadside',
  other: 'Other',
};

export const INSPECTION_STATE_LABEL: Record<InspectionState, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  passed: 'Passed',
  failed: 'Failed',
  corrective_action_required: 'Corrective action',
  overdue: 'Overdue',
  cancelled: 'Cancelled',
};

export const INSPECTION_STATE_TONE: Record<InspectionState, BadgeTone> = {
  scheduled: 'info',
  in_progress: 'info',
  passed: 'success',
  failed: 'danger',
  corrective_action_required: 'warning',
  overdue: 'danger',
  cancelled: 'neutral',
};

/**
 * The seven FMCSA CSA BASICs (`violations.category`).
 *
 * Spelled the way FMCSA spells them, because these labels are what a safety manager compares
 * against an SMS report.
 */
export const VIOLATION_CATEGORY_LABEL: Record<ViolationCategory, string> = {
  unsafe_driving: 'Unsafe driving',
  hos: 'Hours of service',
  driver_fitness: 'Driver fitness',
  controlled_substances: 'Controlled substances',
  vehicle_maintenance: 'Vehicle maintenance',
  hazmat: 'Hazmat',
  crash: 'Crash indicator',
};

export const VIOLATION_STATE_LABEL: Record<ViolationState, string> = {
  open: 'Open',
  corrective_action_required: 'Corrective action',
  disputed: 'Contested',
  overdue: 'Overdue',
  resolved: 'Resolved',
};

export const VIOLATION_STATE_TONE: Record<ViolationState, BadgeTone> = {
  open: 'info',
  corrective_action_required: 'warning',
  disputed: 'violet',
  overdue: 'danger',
  resolved: 'success',
};

/** One severity scale across defects, violations and accidents, so red means the same thing. */
export type SafetySeverityLevel = DefectSeverity | ViolationSeverity;

export const SEVERITY_LABEL: Record<SafetySeverityLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export const SEVERITY_TONE: Record<SafetySeverityLevel, BadgeTone> = {
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'danger',
};

export const ACCIDENT_SEVERITY_LABEL: Record<AccidentSeverity, string> = {
  minor: 'Minor',
  moderate: 'Moderate',
  serious: 'Serious',
  critical: 'Critical',
};

export const ACCIDENT_SEVERITY_TONE: Record<AccidentSeverity, BadgeTone> = {
  minor: 'neutral',
  moderate: 'info',
  serious: 'warning',
  critical: 'danger',
};

export const ACCIDENT_KIND_LABEL: Record<AccidentKind, string> = {
  collision: 'Collision',
  rear_end: 'Rear-end',
  side_impact: 'Side impact',
  backing: 'Backing',
  rollover: 'Rollover',
  jackknife: 'Jackknife',
  fixed_object: 'Fixed object',
  cargo_loss: 'Cargo loss',
  weather: 'Weather related',
  mechanical: 'Mechanical failure',
  animal_strike: 'Animal strike',
  other: 'Other',
};

export const PREVENTABILITY_LABEL: Record<string, string> = {
  yes: 'Preventable',
  no: 'Non-preventable',
  undetermined: 'Undetermined',
};

export const PREVENTABILITY_TONE: Record<string, BadgeTone> = {
  yes: 'danger',
  no: 'success',
  // Undetermined is a decision nobody has made, which is a state to act on, not a neutral one.
  undetermined: 'warning',
};

export const CORRECTIVE_ACTION_LABEL: Record<CorrectiveActionState, string> = {
  open: 'Unassigned',
  assigned: 'Assigned',
  in_progress: 'In progress',
  overdue: 'Overdue',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const CORRECTIVE_ACTION_TONE: Record<CorrectiveActionState, BadgeTone> = {
  open: 'warning',
  assigned: 'info',
  in_progress: 'info',
  overdue: 'danger',
  completed: 'success',
  cancelled: 'neutral',
};

export const EVIDENCE_LABEL: Record<string, string> = {
  police_report: 'Police report',
  driver_statement: 'Driver statement',
  photos: 'Photos',
  dashcam: 'Dashcam video',
  witness_statement: 'Witness statement',
  telematics: 'Telematics data',
  repair_estimate: 'Repair estimate',
  insurance_correspondence: 'Insurance correspondence',
};

export const CLAIM_KIND_LABEL: Record<string, string> = {
  cargo: 'Cargo',
  liability: 'Liability',
  physical_damage: 'Physical damage',
  workers_comp: "Workers' compensation",
};

/** Placeholder for a figure that has no value, so every Safety table agrees on what nothing is. */
export const DASH = '—';
