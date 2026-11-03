/**
 * The one status system used across the whole application (DESIGN_SYSTEM.md §6).
 *
 * Every status shown anywhere (tables, badges, drawers, charts, timelines) resolves through this
 * map. Modules never invent their own colors for a status; they add a code here if one is missing.
 */

export type StatusTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral' | 'violet';

/**
 * Porcelain status families (design/porcelain/SPEC.md §7 Status). Every status is a symbol plus a
 * word: the family picks the colour tokens (`--nw-<family>-*`) and, by default, the symbol.
 */
export type StatusFamily = 'urgent' | 'warning' | 'done' | 'moving' | 'neutral';
/** Symbol drawn before the word. `inShop` and `info` sit on the neutral family. */
export type StatusSymbolKind = StatusFamily | 'inShop' | 'info';

/** Product tone → Porcelain family (violet has no family of its own; it rides on moving). */
export const TONE_FAMILY: Record<StatusTone, StatusFamily> = {
  success: 'done',
  info: 'moving',
  warning: 'warning',
  danger: 'urgent',
  neutral: 'neutral',
  violet: 'moving',
};

export interface StatusDefinition {
  label: string;
  tone: StatusTone;
}

export const STATUS = {
  // success — healthy / active / done
  active: { label: 'Active', tone: 'success' },
  available: { label: 'Available', tone: 'success' },
  delivered: { label: 'Delivered', tone: 'success' },
  completed: { label: 'Completed', tone: 'success' },
  paid: { label: 'Paid', tone: 'success' },
  healthy: { label: 'Healthy', tone: 'success' },
  passed: { label: 'Passed', tone: 'success' },
  on_time: { label: 'On time', tone: 'success' },
  verified: { label: 'Verified', tone: 'success' },
  connected: { label: 'Connected', tone: 'success' },
  ok: { label: 'OK', tone: 'success' },
  resolved: { label: 'Resolved', tone: 'success' },
  settled: { label: 'Settled', tone: 'success' },

  // info — in motion / action
  booked: { label: 'Booked', tone: 'info' },
  assigned: { label: 'Assigned', tone: 'info' },
  dispatched: { label: 'Dispatched', tone: 'violet' },
  in_transit: { label: 'In transit', tone: 'warning' },
  driving: { label: 'Driving', tone: 'info' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  issued: { label: 'Issued', tone: 'info' },
  sent: { label: 'Sent', tone: 'info' },
  in_progress: { label: 'In progress', tone: 'info' },
  open: { label: 'Open', tone: 'info' },
  // Safety file lifecycle (docs/DATABASE.md §3.10 `accidents.status`, `claims.status`).
  reported: { label: 'Reported', tone: 'info' },
  under_review: { label: 'Under review', tone: 'info' },
  investigating: { label: 'Investigating', tone: 'info' },
  safety_review: { label: 'Safety review', tone: 'info' },
  management_review: { label: 'Management review', tone: 'info' },
  submitted: { label: 'Submitted', tone: 'info' },
  acknowledged: { label: 'Acknowledged', tone: 'info' },
  loaded: { label: 'Loaded', tone: 'violet' },

  // warning — attention
  at_pickup: { label: 'At pickup', tone: 'violet' },
  at_delivery: { label: 'At delivery', tone: 'warning' },
  loading: { label: 'Loading', tone: 'violet' },
  unloading: { label: 'Unloading', tone: 'warning' },
  due_soon: { label: 'Due soon', tone: 'warning' },
  expiring: { label: 'Expiring', tone: 'warning' },
  delayed: { label: 'Delayed', tone: 'warning' },
  pending: { label: 'Pending', tone: 'warning' },
  on_hold: { label: 'On hold', tone: 'warning' },
  pending_documents: { label: 'Pending documents', tone: 'warning' },
  corrective_action_required: { label: 'Corrective action', tone: 'warning' },
  deferred: { label: 'Deferred', tone: 'warning' },
  partially_paid: { label: 'Partially paid', tone: 'warning' },
  // Invoice states added with the accounting module (2026-09-27): families kept until the owner decides.
  accepted: { label: 'Accepted', tone: 'info' },
  funded: { label: 'Funded', tone: 'success' },
  superseded: { label: 'Superseded', tone: 'neutral' },
  needs_attention: { label: 'Needs attention', tone: 'warning' },
  idle: { label: 'Idle', tone: 'warning' },
  warning: { label: 'Warning', tone: 'warning' },
  at_risk: { label: 'At risk', tone: 'warning' },

  // danger — critical
  overdue: { label: 'Overdue', tone: 'danger' },
  expired: { label: 'Expired', tone: 'danger' },
  out_of_service: { label: 'Out of service', tone: 'danger' },
  critical: { label: 'Critical', tone: 'danger' },
  problem: { label: 'Problem', tone: 'danger' },
  denied: { label: 'Denied', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
  disputed: { label: 'Disputed', tone: 'danger' },
  accident: { label: 'Accident', tone: 'danger' },
  suspended: { label: 'Suspended', tone: 'danger' },
  missing: { label: 'Missing', tone: 'danger' },
  error: { label: 'Error', tone: 'danger' },

  // neutral — inactive / final / unknown
  draft: { label: 'Draft', tone: 'neutral' },
  inactive: { label: 'Inactive', tone: 'neutral' },
  archived: { label: 'Archived', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  tonu: { label: 'TONU', tone: 'neutral' },
  closed: { label: 'Closed', tone: 'neutral' },
  void: { label: 'Void', tone: 'neutral' },
  onboarding: { label: 'Onboarding', tone: 'info' },
  off_duty: { label: 'Off duty', tone: 'neutral' },
  // Away, not inactive (owner, 2026-10-16); neutral like Off duty until the owner picks a family.
  vacation: { label: 'Vacation', tone: 'neutral' },
  sleeper: { label: 'Sleeper', tone: 'neutral' },
  sold: { label: 'Sold', tone: 'neutral' },
  terminated: { label: 'Terminated', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'neutral' },
  disconnected: { label: 'Disconnected', tone: 'neutral' },
  info: { label: 'Info', tone: 'info' },

  // violet — secondary categorisation (never for status severity)
  in_shop: { label: 'In shop', tone: 'violet' },
  maintenance: { label: 'Maintenance', tone: 'violet' },

  // PTI (docs/pti-rebuild-brief.md §3.1): the unit's derived service status, a defect's severity
  // and a defect's state. `cleared`, `out_of_service`, `verified` and `fixed_pending_verify`
  // ("waiting for review") are in SPEC §7's table; `restricted`, `watch`, `replace_now`,
  // `replace_soon`, `monitor` and `in_repair` are placed on the nearest family and listed for a
  // decision (see the WP3 report).
  cleared: { label: 'Cleared', tone: 'success' },
  restricted: { label: 'Restricted', tone: 'warning' },
  watch: { label: 'Watch', tone: 'info' },
  monitor: { label: 'Monitor', tone: 'info' },
  replace_soon: { label: 'Replace soon', tone: 'warning' },
  replace_now: { label: 'Replace now', tone: 'warning' },
  oos_risk: { label: 'Out-of-service risk', tone: 'danger' },
  in_repair: { label: 'In repair', tone: 'violet' },
  fixed_pending_verify: { label: 'Fixed — awaiting verify', tone: 'info' },
  dismissed: { label: 'Dismissed', tone: 'neutral' },
  // The walk-around's receipt (§4.6) and its review result. `missing` is above (danger).
  not_due: { label: 'Not due yet', tone: 'neutral' },
  awaiting: { label: 'Awaiting video', tone: 'neutral' },
  received: { label: 'Received', tone: 'success' },
  late: { label: 'Late', tone: 'warning' },
  exempt_in_shop: { label: 'In shop — exempt', tone: 'violet' },
  no_issues: { label: 'No issues', tone: 'success' },
  issues_found: { label: 'Issue found', tone: 'warning' },

  // safety & compliance — qualification items (@neway/shared ComplianceStatus), entity roll-ups,
  // consent lifecycle and verification steps/decisions
  pending_verification: { label: 'Pending verification', tone: 'warning' },
  verification_failed: { label: 'Verification failed', tone: 'danger' },
  waived: { label: 'Waived', tone: 'neutral' },
  not_applicable: { label: 'Not applicable', tone: 'neutral' },
  compliant: { label: 'Compliant', tone: 'success' },
  non_compliant: { label: 'Non-compliant', tone: 'danger' },
  viewed: { label: 'Viewed', tone: 'info' },
  signed: { label: 'Signed', tone: 'success' },
  declined: { label: 'Declined', tone: 'danger' },
  not_started: { label: 'Not started', tone: 'neutral' },
  blocked: { label: 'Blocked', tone: 'danger' },
  approved: { label: 'Approved', tone: 'success' },
  conditional: { label: 'Conditional', tone: 'warning' },
  rejected: { label: 'Rejected', tone: 'danger' },

  // Driver Relations (owner brief 2026-10-06). Not in SPEC §7's table: needs_contact sits on
  // urgent (the owner's red alert) and contacted on moving; both listed for a decision.
  needs_contact: { label: 'Needs contact', tone: 'danger' },
  contacted: { label: 'Contacted', tone: 'info' },

  // Safety v2 (docs/safety/SAFETY-V2.md, 2026-10-02). None of these is in SPEC §7's table: each is
  // placed on the family the owner's mockups draw it in and listed in SAFETY-V2.md for a decision.
  // Accident stages
  evidence: { label: 'Evidence', tone: 'warning' },
  testing: { label: 'Testing assessed', tone: 'warning' },
  repairs_claim: { label: 'Repairs and insurance', tone: 'info' },
  review: { label: 'Review', tone: 'info' },
  // Claim stages and decisions
  opened: { label: 'Open', tone: 'danger' },
  insurer_review: { label: 'Under review', tone: 'info' },
  decision: { label: 'Awaiting decision', tone: 'warning' },
  payment: { label: 'Payment pending', tone: 'success' },
  partially_approved: { label: 'Partially approved', tone: 'warning' },
  // Post-accident testing
  not_required: { label: 'Not required', tone: 'neutral' },
  required: { label: 'Required', tone: 'danger' },
  collected: { label: 'Collected', tone: 'success' },
  result_pending: { label: 'Result pending', tone: 'warning' },
  result_recorded: { label: 'Result recorded', tone: 'success' },
  not_completed: { label: 'Not completed', tone: 'danger' },
  exception_reviewed: { label: 'Exception reviewed', tone: 'neutral' },
  result_restricted: { label: 'Restricted', tone: 'neutral' },
  // Violation tracks
  correction_open: { label: 'Repair proof needed', tone: 'warning' },
  repaired: { label: 'Repaired', tone: 'info' },
  proof_submitted: { label: 'Evidence submitted', tone: 'info' },
  certified: { label: 'Closed — corrected', tone: 'success' },
  oos: { label: 'Vehicle OOS', tone: 'danger' },
  no_oos: { label: 'No OOS', tone: 'neutral' },
  clean: { label: 'Clean', tone: 'success' },
  // Roadside stage checklist
  defects_corrected: { label: 'Defects corrected', tone: 'info' },
  returned: { label: 'Returned', tone: 'success' },
  // Accounting suggestions
  pending_review: { label: 'Pending review', tone: 'warning' },
  confirmed: { label: 'Confirmed', tone: 'success' },
  // Priorities on the overview
  priority_high: { label: 'High', tone: 'danger' },
  priority_medium: { label: 'Medium', tone: 'warning' },
  priority_low: { label: 'Low', tone: 'neutral' },
} as const satisfies Record<string, StatusDefinition>;

export type StatusCode = keyof typeof STATUS;

export function getStatus(code: string): StatusDefinition {
  return (STATUS as Record<string, StatusDefinition>)[code] ?? { label: code, tone: 'neutral' };
}

/**
 * Per-status overrides from the SPEC status table. Codes not listed here keep the family their
 * tone maps to (TONE_FAMILY); the design owner decides the rest — nothing is invented here.
 */
interface StatusOverride {
  family: StatusFamily;
  symbol?: StatusSymbolKind;
}

const STATUS_FAMILY_OVERRIDES: Partial<Record<StatusCode, StatusOverride>> = {
  // Neutral — ring with dash
  booked: { family: 'neutral' },
  assigned: { family: 'neutral' },
  draft: { family: 'neutral' },
  inactive: { family: 'neutral' },
  // In motion — circle with arrow
  in_transit: { family: 'moving' },
  loaded: { family: 'moving' },
  dispatched: { family: 'moving' },
  // At a stop — amber with the arrow (owner, 2026-10-27: At delivery looked the same as In transit;
  // the owner's own mobile sheets draw "At Pickup" amber). On the road stays blue.
  at_pickup: { family: 'warning', symbol: 'moving' },
  loading: { family: 'warning', symbol: 'moving' },
  at_delivery: { family: 'warning', symbol: 'moving' },
  unloading: { family: 'warning', symbol: 'moving' },
  // Done — circle with check
  delivered: { family: 'done' },
  available: { family: 'done' },
  paid: { family: 'done' },
  // Warning — diamond
  delayed: { family: 'warning' },
  expiring: { family: 'warning' },
  idle: { family: 'warning' },
  // Urgent — octagon
  on_hold: { family: 'urgent' },
  expired: { family: 'urgent' },
  out_of_service: { family: 'urgent' },
  // In shop — wrench on the neutral family
  in_shop: { family: 'neutral', symbol: 'inShop' },
  // Info — "i" on the neutral family (notes, waiting for review)
  under_review: { family: 'neutral', symbol: 'info' },
  info: { family: 'neutral', symbol: 'info' },
  // PTI
  cleared: { family: 'done' },
  oos_risk: { family: 'urgent' },
  watch: { family: 'neutral', symbol: 'info' },
  monitor: { family: 'neutral', symbol: 'info' },
  in_repair: { family: 'neutral', symbol: 'inShop' },
  fixed_pending_verify: { family: 'neutral', symbol: 'info' },
  exempt_in_shop: { family: 'neutral', symbol: 'inShop' },
  awaiting: { family: 'neutral', symbol: 'info' },
};

export interface StatusLook {
  family: StatusFamily;
  symbol: StatusSymbolKind;
}

/** Family and symbol for a status code (unknown codes are neutral). */
export function getStatusLook(code: string): StatusLook {
  const override = (STATUS_FAMILY_OVERRIDES as Record<string, StatusOverride | undefined>)[code];
  if (override) return { family: override.family, symbol: override.symbol ?? override.family };
  const family = TONE_FAMILY[getStatus(code).tone];
  return { family, symbol: family };
}

/** Family for a bare tone (Badge, Alert, Toast); no per-status overrides apply. */
export function toneFamily(tone: StatusTone): StatusFamily {
  return TONE_FAMILY[tone];
}

export const STATUS_CODES = Object.keys(STATUS) as StatusCode[];
