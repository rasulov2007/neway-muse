/**
 * Violations, and what a run of them actually says about a driver or a unit.
 *
 * The categories are the seven FMCSA CSA BASICs, exactly as `violations.category` commits them in
 * docs/DATABASE.md §3.10. That is not an arbitrary taxonomy: it is what a carrier's SMS percentile
 * is computed from and what a DOT auditor asks about, so a parallel "friendlier" set of categories
 * would make this data un-reportable to the only audience that matters.
 *
 * Honesty rules — the ones that matter most in this file:
 *  - **No risk score is invented.** FMCSA's severity weights and time-weighting are published data
 *    this system does not hold, so `summarizeViolations` reports counts, recency and repetition —
 *    facts — and names the score as unavailable with what it would need. When the Phase 8 scoring
 *    engine arrives it plugs in here without any page changing.
 *  - A contested violation still counts until it is actually dismissed, because that is how it
 *    counts against the carrier.
 *  - Zero violations in a window is reported as zero. Absence of records is `null`.
 */

/** `violations.category` — the FMCSA CSA BASICs. */
export const VIOLATION_CATEGORIES = [
  'unsafe_driving',
  'hos',
  'driver_fitness',
  'controlled_substances',
  'vehicle_maintenance',
  'hazmat',
  'crash',
] as const;
export type ViolationCategory = (typeof VIOLATION_CATEGORIES)[number];

/** `violations.source`. */
export const VIOLATION_SOURCES = ['roadside', 'company'] as const;
export type ViolationSource = (typeof VIOLATION_SOURCES)[number];

export const VIOLATION_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type ViolationSeverity = (typeof VIOLATION_SEVERITIES)[number];

/**
 * Where a violation stands.
 *
 * Derived from `resolved_at`, `contested` and the corrective action attached to it, the same way
 * inspection state is derived — the stored row carries the facts, not a status word.
 */
export const VIOLATION_STATES = [
  'open',
  'corrective_action_required',
  'disputed',
  'overdue',
  'resolved',
] as const;
export type ViolationState = (typeof VIOLATION_STATES)[number];

export interface ViolationStateInput {
  /** `violations.resolved_at`. */
  resolvedAt?: string | null;
  /** `violations.contested`. */
  contested?: boolean;
  /** True when a corrective action is attached and still outstanding. */
  hasOpenCorrectiveAction?: boolean;
  /** Due date of that corrective action, when it has one. */
  correctiveActionDueOn?: string | null;
  severity: ViolationSeverity;
}

export interface ViolationStateResult {
  state: ViolationState;
  actionable: boolean;
  reasons: string[];
}

export function violationState(input: ViolationStateInput, today: string): ViolationStateResult {
  if (input.resolvedAt) {
    return { state: 'resolved', actionable: false, reasons: ['Resolved'] };
  }

  const overdue =
    input.hasOpenCorrectiveAction === true &&
    !!input.correctiveActionDueOn &&
    input.correctiveActionDueOn.slice(0, 10) < today.slice(0, 10);

  if (overdue) {
    return {
      state: 'overdue',
      actionable: true,
      reasons: [`Corrective action was due ${input.correctiveActionDueOn}`],
    };
  }

  if (input.contested) {
    // Contested is a position the carrier has taken, not an outcome. It still counts until the
    // challenge succeeds, which is why it stays actionable.
    return {
      state: 'disputed',
      actionable: true,
      reasons: ['Contested; still counts against the carrier until it is dismissed'],
    };
  }

  if (input.hasOpenCorrectiveAction) {
    return {
      state: 'corrective_action_required',
      actionable: true,
      reasons: ['A corrective action is open against this violation'],
    };
  }

  return {
    state: 'open',
    actionable: true,
    reasons:
      input.severity === 'critical'
        ? ['Open, and critical: it needs a corrective action']
        : ['Open with no corrective action recorded'],
  };
}

export const VIOLATION_STATE_ORDER: readonly ViolationState[] = [
  'overdue',
  'corrective_action_required',
  'open',
  'disputed',
  'resolved',
];

export function violationStateRank(state: ViolationState): number {
  const index = VIOLATION_STATE_ORDER.indexOf(state);
  return index === -1 ? VIOLATION_STATE_ORDER.length : index;
}

// ---------------------------------------------------------------------------------------------
// What a run of violations says
// ---------------------------------------------------------------------------------------------

export interface SummarizableViolation {
  id: string;
  category: ViolationCategory;
  severity: ViolationSeverity;
  /** `violations.on_date` (YYYY-MM-DD). */
  onDate: string;
  resolvedAt?: string | null;
  contested?: boolean;
  points?: number | null;
}

export interface RepeatCategory {
  category: ViolationCategory;
  count: number;
  ids: string[];
}

export interface ViolationRiskIndicator {
  key: string;
  /** The finding, stated as a fact a person could check. */
  label: string;
  /** Ids of the exact records behind it, so a claim and its list can never disagree. */
  ids: string[];
  tone: 'critical' | 'warning' | 'info';
}

export interface UnavailableSignal {
  key: string;
  label: string;
  /** What the signal would need to run. */
  requires: string;
}

export interface ViolationSummary {
  total: number;
  open: number;
  critical: number;
  /** Violations dated inside the recent window. */
  recent: number;
  /** Sum of `points` across unresolved violations. Null when no violation carries points. */
  openPoints: number | null;
  /** Categories with more than one violation, worst first. */
  repeats: RepeatCategory[];
  /** Recent count against the count for the immediately preceding window of equal length. */
  trend: { current: number; previous: number; changePct: number | null } | null;
  /** Statements of fact, each carrying the records behind it. Never a score. */
  indicators: ViolationRiskIndicator[];
  /** Signals this engine deliberately does not compute. */
  unavailable: UnavailableSignal[];
}

export interface ViolationSummaryPolicy {
  /** Days that count as "recent". FMCSA's SMS looks back 24 months; 30 days is the working view. */
  recentDays: number;
  /** Occurrences in one category before it is called a repeat. */
  repeatAt: number;
}

export const DEFAULT_VIOLATION_SUMMARY_POLICY: ViolationSummaryPolicy = {
  recentDays: 30,
  repeatAt: 2,
};

const MS_PER_DAY = 86_400_000;

function isOpen(v: SummarizableViolation): boolean {
  return !v.resolvedAt;
}

/**
 * Counts, recency and repetition for one driver, one unit, or the whole carrier.
 *
 * Deliberately not a score. Everything here is arithmetic a safety manager could redo by hand from
 * the same list, which is the only kind of number worth putting next to a person's name.
 */
export function summarizeViolations(
  violations: SummarizableViolation[],
  today: string,
  policy: ViolationSummaryPolicy = DEFAULT_VIOLATION_SUMMARY_POLICY,
): ViolationSummary {
  const todayMs = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  const windowStart = todayMs - policy.recentDays * MS_PER_DAY;
  const previousStart = windowStart - policy.recentDays * MS_PER_DAY;

  const dateOf = (v: SummarizableViolation) => Date.parse(`${v.onDate.slice(0, 10)}T00:00:00Z`);

  const open = violations.filter(isOpen);
  const critical = open.filter((v) => v.severity === 'critical');
  const recent = violations.filter((v) => dateOf(v) >= windowStart);
  const previous = violations.filter((v) => {
    const at = dateOf(v);
    return at >= previousStart && at < windowStart;
  });

  const pointed = open.filter((v) => typeof v.points === 'number');
  const openPoints =
    pointed.length > 0 ? pointed.reduce((sum, v) => sum + (v.points as number), 0) : null;

  const byCategory = new Map<ViolationCategory, SummarizableViolation[]>();
  for (const v of violations) {
    const bucket = byCategory.get(v.category);
    if (bucket) bucket.push(v);
    else byCategory.set(v.category, [v]);
  }
  const repeats: RepeatCategory[] = [...byCategory.entries()]
    .filter(([, rows]) => rows.length >= policy.repeatAt)
    .map(([category, rows]) => ({ category, count: rows.length, ids: rows.map((r) => r.id) }))
    .sort((a, b) => b.count - a.count);

  const indicators: ViolationRiskIndicator[] = [];

  if (critical.length > 0) {
    indicators.push({
      key: 'critical_open',
      label: `${critical.length} open critical violation${critical.length === 1 ? '' : 's'}`,
      ids: critical.map((v) => v.id),
      tone: 'critical',
    });
  }

  if (recent.length > 0) {
    indicators.push({
      key: 'recent',
      label: `${recent.length} violation${recent.length === 1 ? '' : 's'} in the last ${policy.recentDays} days`,
      ids: recent.map((v) => v.id),
      tone: recent.length >= 3 ? 'warning' : 'info',
    });
  }

  for (const repeat of repeats) {
    indicators.push({
      key: `repeat_${repeat.category}`,
      label: `${repeat.count} repeat ${repeat.category.replace(/_/g, ' ')} violations`,
      ids: repeat.ids,
      tone: 'warning',
    });
  }

  const contested = violations.filter((v) => v.contested && isOpen(v));
  if (contested.length > 0) {
    indicators.push({
      key: 'contested',
      label: `${contested.length} contested and still counting`,
      ids: contested.map((v) => v.id),
      tone: 'info',
    });
  }

  // A trend needs both windows to have been observed. With no violation older than the current
  // window there is nothing to compare against, and 0 → 3 is not a "300% rise".
  const trend =
    violations.length > 0 && previous.length + recent.length > 0
      ? {
          current: recent.length,
          previous: previous.length,
          changePct:
            previous.length > 0
              ? Math.round(((recent.length - previous.length) / previous.length) * 100)
              : null,
        }
      : null;

  return {
    total: violations.length,
    open: open.length,
    critical: critical.length,
    recent: recent.length,
    openPoints,
    repeats,
    trend,
    indicators,
    unavailable: [
      {
        key: 'csa_percentile',
        label: 'CSA BASIC percentile',
        requires: "FMCSA severity weights and the carrier's SMS peer group",
      },
      {
        key: 'driver_risk_score',
        label: 'Driver risk score',
        requires: 'The Phase 8 scoring engine and its configured weights',
      },
    ],
  };
}
