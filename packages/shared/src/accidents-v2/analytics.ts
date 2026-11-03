// Accident & Claims v2 — analytics, profile sections and the sidebar count (phase P5; API.md §5–§6, SPEC §1.6, §6.2,
// §6.3, §6.7). The numbers come from `safetyRules.analytics` on the server; the screens never compute them.
import type { AnalyticsResult, Severity, Stage } from '../safety-rules/index.js';

export type AnalyticsResponse = AnalyticsResult & {
  /** Display names for the drill-down drawer (case, date, truck · driver, type, severity, preventable, net cost). */
  cases: Record<string, AnalyticsCaseRef>;
};

export interface AnalyticsCaseRef {
  id: string;
  number: string;
  occurredAt: string;
  tz: string;
  truckUnit: string | null;
  driverName: string | null;
  type: string;
  severity: Severity;
  preventability: 'not_determined' | 'non_preventable' | 'preventable';
  /** null for a role that may not see repair costs. */
  netCostCents: number | null;
}

/** Sidebar badge on Accidents: urgent attention items (prototype Shell "Urgent items"). */
export interface AccidentCounts {
  urgent: number;
  needsAttention: number;
  openCases: number;
}

export interface ProfileAccidentRow {
  id: string;
  number: string;
  occurredAt: string;
  tz: string;
  type: string;
  severity: Severity;
  stage: Stage;
  dotRecordable: 'yes' | 'no' | 'pending';
  preventability: 'not_determined' | 'non_preventable' | 'preventable';
  outcome: string | null;
  /** Downtime of this unit kind (truck days for a truck or a driver, trailer days for a trailer). */
  downtimeDays: number;
  netCostCents: number | null;
  workOrders: { id: string; number: string; status: string; title: string }[];
}

export interface ProfileCorrectiveAction {
  id: string;
  caseId: string;
  caseNumber: string;
  kind: string;
  /** "Restricted personnel action" for a disciplinary item the viewer may not see. */
  title: string;
  locked: boolean;
  status: string;
  dueAt: string;
  completedAt: string | null;
}

export interface ProfileAccidentsResponse {
  kind: 'truck' | 'trailer' | 'driver';
  id: string;
  cases: ProfileAccidentRow[];
  kpis: {
    total: number;
    last12m: number;
    preventable12m: number;
    nonPreventable12m: number;
    dotRecordable12m: number;
    /** ≥ 2 cases in 12 months (SPEC §6.2). */
    reviewSuggested: boolean;
    spendCents: number | null;
    downtimeDays: number;
    openCorrectiveActions: number;
  };
  /** SPEC §6.3 wording when ≥ 2 cases in 12 months, else null. */
  note: string | null;
  /** Driver profile only (SPEC §6.3); test results are never part of this response. */
  correctiveActions: ProfileCorrectiveAction[];
}
