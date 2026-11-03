/**
 * The office side of the NeWay app (mobile M4, docs/mobile/API.md §9). Aggregations over the
 * existing services; every block is present only when the caller holds the permission of the
 * records it reads. Money comes only from the existing analytics service, labelled with its period
 * and whether it includes estimates.
 */

export const OFFICE_ROLES = ['dispatcher', 'safety', 'fleet', 'accounting', 'recruiting', 'owner'] as const;
export type OfficeRole = (typeof OFFICE_ROLES)[number];

export const OFFICE_ROLE_LABEL: Record<OfficeRole, string> = {
  dispatcher: 'Dispatcher',
  safety: 'Safety',
  fleet: 'Fleet',
  accounting: 'Accounting',
  recruiting: 'Recruiting',
  owner: 'Owner',
};

/** What opens each Today view (any one of the codes). */
export const OFFICE_ROLE_PERMISSIONS: Record<OfficeRole, readonly string[]> = {
  dispatcher: ['loads.view'],
  safety: ['safety.view', 'compliance.view'],
  fleet: ['maintenance.view'],
  accounting: ['accounting.view'],
  recruiting: ['recruiting.view'],
  owner: ['analytics.view'],
};

export const OFFICE_WORKSPACES = ['today', 'dispatch', 'inbox', 'approvals', 'my_work', 'safety', 'fleet', 'accounting', 'recruiting', 'owner'] as const;
export type OfficeWorkspace = (typeof OFFICE_WORKSPACES)[number];

export interface OfficeMe {
  user: { id: string; name: string; email: string };
  company: { id: string; name: string | null };
  companies: Array<{ companyId: string; companyName: string }>;
  roles: string[];
  isOwner: boolean;
  /** Today views the caller may open, best first. */
  todayRoles: OfficeRole[];
  /** Departments whose conversations the caller may open and answer for. */
  departments: Array<{ key: string; label: string }>;
  workspaces: OfficeWorkspace[];
  serverNow: string;
  /** The company (Eastern) day. */
  today: string;
}

export type OfficeSeverity = 'critical' | 'warning' | 'info';

/** One attention line (sheet 13 "needs attention"). */
export interface OfficeAttentionItem {
  kind: string;
  label: string;
  severity: OfficeSeverity;
  title: string;
  subtitle: string | null;
  /** When it became a problem (late since, delivered at, reported at). */
  since: string | null;
  target: { type: string; id: string } | null;
}

export interface OfficeCounter {
  key: string;
  label: string;
  value: number;
}

export interface OfficeSection {
  key: string;
  title: string;
  counters: OfficeCounter[];
  items: OfficeAttentionItem[];
}

export interface OfficeMoney {
  amount: number | null;
  /** posted = only posted records · includes_estimates = some cost is an estimate (statements not approved). */
  basis: 'posted' | 'includes_estimates';
}

export interface OfficeOwnerOverview {
  period: { preset: string; from: string; to: string; label: string };
  revenue: OfficeMoney;
  expenses: OfficeMoney;
  net: OfficeMoney & { hiddenReason: string | null };
  notes: string[];
  source: 'demo' | 'database';
  fleet: { active: number; inShop: number; outOfService: number; total: number } | null;
}

export interface OfficeToday {
  role: OfficeRole;
  availableRoles: OfficeRole[];
  serverNow: string;
  today: string;
  attention: OfficeAttentionItem[];
  sections: OfficeSection[];
  owner: OfficeOwnerOverview | null;
  /** Blocks left out, and why (a flag is off, a permission is missing). */
  omitted: Array<{ key: string; reason: string }>;
}

export const OFFICE_DISPATCH_TABS = ['trucks', 'drivers', 'loads'] as const;
export type OfficeDispatchTab = (typeof OFFICE_DISPATCH_TABS)[number];

export interface OfficeDispatchRow {
  id: string;
  title: string;
  subtitle: string | null;
  status: string;
  /** Loads: pickup → delivery. Trucks: the current load's lane. */
  lane: string | null;
  loadId: string | null;
  loadNumber: string | null;
}

export interface OfficeDispatch {
  tab: OfficeDispatchTab;
  q: string;
  active: OfficeDispatchRow[];
  unassigned: OfficeDispatchRow[];
  counts: { active: number; unassigned: number };
}

export const OFFICE_APPROVAL_KINDS = ['expenses', 'pto', 'repairs', 'vacations'] as const;
export type OfficeApprovalKind = (typeof OFFICE_APPROVAL_KINDS)[number];

/** The existing route that decides the item; the app calls it, nothing parallel. */
export interface OfficeApprovalAction {
  method: 'POST';
  path: string;
  /** What the body carries, e.g. `{ decision: 'approve'|'reject', reason }`. */
  body: string;
  permission: string;
}

export interface OfficeApprovalItem {
  id: string;
  kind: OfficeApprovalKind;
  title: string;
  subtitle: string | null;
  amount: number | null;
  currency: string | null;
  submittedAt: string | null;
  status: string;
  approve: OfficeApprovalAction | null;
  reject: OfficeApprovalAction | null;
  /** Why no action is offered (no decision route exists yet). */
  note: string | null;
  /** The record's version, for decision routes that take one (vacation requests). */
  version?: number | null;
}

export interface OfficeApprovalTab {
  kind: OfficeApprovalKind;
  label: string;
  count: number;
}

export interface OfficeApprovals {
  kind: OfficeApprovalKind | null;
  tabs: OfficeApprovalTab[];
  items: OfficeApprovalItem[];
  omitted: Array<{ key: string; reason: string }>;
}

export interface OfficeTask {
  id: string;
  source: 'safety_task' | 'workspace_task' | 'recruiting_lead';
  title: string;
  priority: string | null;
  dueAt: string | null;
  status: string;
  target: { type: string; id: string } | null;
}

export interface OfficeMyWork {
  today: string;
  tasks: OfficeTask[];
  attendance: { status: 'checked_in' | 'checked_out' | 'not_checked_in' | 'no_employee'; since: string | null; entryStatus: string | null };
  pto: { employeeLinked: boolean; balances: Array<{ policyName: string; balanceHours: number; pendingHours: number | null }> };
  /** Never an amount: a private link when the caller may open pay reports. */
  salaryReport: { visibility: 'private'; link: string } | null;
}
