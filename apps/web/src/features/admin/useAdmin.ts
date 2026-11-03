import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  AdminAccount,
  AuditCoverage,
  AuditEntry,
  Department,
  DepartmentNode,
  IntegrationAccount,
  IntegrationProvider,
  SyncReport,
  SyncRequest,
  SyncRun,
  PermissionGroup,
  Role,
  SettingDefinition,
  WorkflowAction,
  WorkflowRule,
  WorkflowRun,
  WorkflowTrigger,
} from '@neway/shared';
import { apiGet, apiPatch, apiPost } from '@/lib/api-client';

/**
 * The Administration data layer.
 *
 * One file, because these seven screens are one control plane and share a cache: assigning a role
 * changes what the Users list shows, what the Roles list counts, and what the audit trail contains.
 * A mutation therefore invalidates `['admin']` as a whole rather than trying to predict which of
 * the seven it touched — the alternative is a Roles page still showing "3 accounts" after the third
 * was moved elsewhere.
 */

const BASE = '/admin';

export interface Paged<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Principal {
  userId: string;
  name: string;
  companyId: string;
  timezone: string;
  roles: string[];
  permissions: string[];
}

export interface AccountSummary {
  /** Every account that is not archived. */
  total: number;
  active: number;
  invited: number;
  suspended: number;
  disabled: number;
  /** Archived accounts: kept for the audit trail, never part of `total`. */
  archived: number;
}

export interface LinkableEmployee {
  id: string;
  name: string;
  employeeNumber: string;
  position: string;
  email: string;
}

/** A provider and every account the company holds with it. Two Samsaras are two accounts. */
export interface IntegrationView extends IntegrationProvider {
  accounts: IntegrationAccount[];
  /** Archived accounts: hidden, kept, shown only behind "Show archived". Absent from older servers. */
  archivedAccounts?: IntegrationAccount[];
}

/** One account, as the account routes answer: the provider with that account alone. */
export interface IntegrationAccountView extends IntegrationView {
  account: IntegrationAccount;
}

export interface IntegrationList {
  integrations: IntegrationView[];
  connectorsImplemented: boolean;
  note: string;
}

export interface ResolvedSetting extends SettingDefinition {
  value: unknown;
  isDefault: boolean;
  updatedByName: string | null;
  updatedAt: string | null;
}

export interface SettingsResponse {
  settings: ResolvedSetting[];
  notEnforced: { key: string; label: string; reason: string }[];
}

export interface AuditPage extends Paged<AuditEntry> {
  coverage: AuditCoverage;
}

export interface AuditFacets {
  actions: { value: string; label: string }[];
  entityTypes: string[];
  actors: { id: string; name: string }[];
}

export interface WorkflowCatalog {
  triggers: WorkflowTrigger[];
  actions: {
    type: string;
    label: string;
    description: string;
    implemented: boolean;
    reason?: string;
  }[];
}

export interface WorkflowSummary {
  rules: { total: number; active: number };
  runs: { total: number; matched: number; skipped: number; failed: number };
}

export interface NotificationRecord {
  id: string;
  severity: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  source: string;
  readAt: string | null;
  createdAt: string;
}

function query<T>(key: unknown[], path: string, params?: Record<string, unknown>) {
  return { queryKey: key, queryFn: () => apiGet<T>(path, params) };
}

// ================================================================================= the principal

/**
 * Who this browser is acting as, and what the server says they may do.
 *
 * The permission list is fetched, never assembled in the browser. A hardcoded role table on the
 * client drifts from the roles an administrator actually configured, and the day it drifts the UI
 * either hides a button the user is allowed to press or shows one the server will refuse.
 */
export function usePrincipal(): UseQueryResult<Principal> {
  return useQuery({
    ...query<Principal>(['admin', 'me'], `${BASE}/me`),
    staleTime: 60_000,
  });
}

/** True when the principal holds every listed permission. `false` while it is still loading. */
export function useHasPermission(...permissions: string[]): boolean {
  const principal = usePrincipal();
  if (!principal.data) return false;
  const held = new Set(principal.data.permissions);
  return permissions.every((permission) => held.has(permission));
}

export type PermissionCheck =
  | { status: 'loading' }
  | { status: 'error'; error: unknown; retry: () => void }
  | { status: 'granted' }
  | { status: 'denied' };

/**
 * The same check, but able to tell "you may not" apart from "I could not ask".
 *
 * `useHasPermission` collapses both into `false`, which is right for hiding a button and wrong for
 * a whole page: an unreachable server rendered as "you do not have permission" sends the user to
 * an administrator to fix something that is not broken.
 */
export function usePermissionCheck(...permissions: string[]): PermissionCheck {
  const principal = usePrincipal();
  if (principal.isPending) return { status: 'loading' };
  if (principal.isError || !principal.data) {
    return { status: 'error', error: principal.error, retry: () => void principal.refetch() };
  }
  const held = new Set(principal.data.permissions);
  return permissions.every((permission) => held.has(permission))
    ? { status: 'granted' }
    : { status: 'denied' };
}

// ======================================================================================= users

export function useAccounts(params: Record<string, unknown>): UseQueryResult<Paged<AdminAccount>> {
  return useQuery(query<Paged<AdminAccount>>(['admin', 'users', params], `${BASE}/users`, params));
}

export function useAccount(membershipId: string | null): UseQueryResult<AdminAccount> {
  return useQuery({
    ...query<AdminAccount>(['admin', 'users', membershipId], `${BASE}/users/${membershipId}`),
    enabled: membershipId !== null,
  });
}

export function useAccountPermissions(membershipId: string | null): UseQueryResult<string[]> {
  return useQuery({
    ...query<string[]>(
      ['admin', 'users', membershipId, 'permissions'],
      `${BASE}/users/${membershipId}/permissions`,
    ),
    enabled: membershipId !== null,
  });
}

export function useAccountActivity(membershipId: string | null): UseQueryResult<AuditEntry[]> {
  return useQuery({
    ...query<AuditEntry[]>(
      ['admin', 'users', membershipId, 'activity'],
      `${BASE}/users/${membershipId}/activity`,
    ),
    enabled: membershipId !== null,
  });
}

export function useAccountSummary(): UseQueryResult<AccountSummary> {
  return useQuery(query<AccountSummary>(['admin', 'users', 'summary'], `${BASE}/users/summary`));
}

export function useLinkableEmployees(enabled: boolean): UseQueryResult<LinkableEmployee[]> {
  return useQuery({
    ...query<LinkableEmployee[]>(
      ['admin', 'users', 'linkable'],
      `${BASE}/users/linkable-employees`,
    ),
    enabled,
  });
}

export function useInvitationDelivery(): UseQueryResult<{ available: boolean; reason: string }> {
  return useQuery({
    ...query<{ available: boolean; reason: string }>(
      ['admin', 'users', 'invitation-delivery'],
      `${BASE}/users/invitation-delivery`,
    ),
    staleTime: Infinity,
  });
}

// ======================================================================================= roles

export function useRoles(includeArchived = false): UseQueryResult<Role[]> {
  return useQuery(
    query<Role[]>(['admin', 'roles', includeArchived], `${BASE}/roles`, { includeArchived }),
  );
}

export function usePermissionMatrix(): UseQueryResult<PermissionGroup[]> {
  return useQuery({
    ...query<PermissionGroup[]>(['admin', 'permissions'], `${BASE}/permissions`),
    staleTime: Infinity,
  });
}

// ================================================================================= departments

export function useDepartments(): UseQueryResult<Department[]> {
  return useQuery(query<Department[]>(['admin', 'departments'], `${BASE}/departments`));
}

export function useDepartmentTree(): UseQueryResult<DepartmentNode[]> {
  return useQuery(
    query<DepartmentNode[]>(['admin', 'departments', 'tree'], `${BASE}/departments/tree`),
  );
}

// ================================================================================ integrations

export function useIntegrations(): UseQueryResult<IntegrationList> {
  return useQuery(query<IntegrationList>(['admin', 'integrations'], `${BASE}/integrations`));
}

export function useIntegrationRuns(accountId: string | null) {
  return useQuery({
    ...query<SyncRun[]>(
      ['admin', 'integrations', 'accounts', accountId, 'runs'],
      `${BASE}/integrations/accounts/${accountId ?? ''}/runs`,
    ),
    enabled: accountId !== null,
  });
}

// =================================================================================== workflows

export function useWorkflows(): UseQueryResult<WorkflowRule[]> {
  return useQuery(query<WorkflowRule[]>(['admin', 'workflows'], `${BASE}/workflows`));
}

export function useWorkflowCatalog(): UseQueryResult<WorkflowCatalog> {
  return useQuery({
    ...query<WorkflowCatalog>(['admin', 'workflows', 'catalog'], `${BASE}/workflows/catalog`),
    staleTime: Infinity,
  });
}

export function useWorkflowSummary(): UseQueryResult<WorkflowSummary> {
  return useQuery(
    query<WorkflowSummary>(['admin', 'workflows', 'summary'], `${BASE}/workflows/summary`),
  );
}

export function useWorkflowRuns(ruleId?: string): UseQueryResult<WorkflowRun[]> {
  return useQuery(
    query<WorkflowRun[]>(
      ['admin', 'workflows', 'runs', ruleId ?? 'all'],
      `${BASE}/workflows/runs`,
      {
        ruleId,
      },
    ),
  );
}

// ==================================================================================== audit

export function useAuditLog(params: Record<string, unknown>): UseQueryResult<AuditPage> {
  return useQuery(query<AuditPage>(['admin', 'audit', params], `${BASE}/audit`, params));
}

export function useAuditFacets(): UseQueryResult<AuditFacets> {
  return useQuery(query<AuditFacets>(['admin', 'audit', 'facets'], `${BASE}/audit/facets`));
}

// ==================================================================================== settings

export function useSettings(): UseQueryResult<SettingsResponse> {
  return useQuery(query<SettingsResponse>(['admin', 'settings'], `${BASE}/settings`));
}

// =============================================================================== notifications

export function useNotifications(): UseQueryResult<NotificationRecord[]> {
  return useQuery(query<NotificationRecord[]>(['admin', 'notifications'], `${BASE}/notifications`));
}

/**
 * Creating an account, or reissuing its credential, answers with the password once.
 *
 * Nothing else in the API ever returns it, so this shape exists only here and only for the dialog
 * that shows it.
 */
export interface CreatedAdminAccount {
  account: AdminAccount;
  temporaryPassword: string;
}

// ==================================================================================== mutations

export const adminApi = {
  createAccount: (body: unknown) =>
    apiPost<CreatedAdminAccount>(`${BASE}/users`, body),
  issueTemporaryPassword: (membershipId: string) =>
    apiPost<CreatedAdminAccount>(`${BASE}/users/${membershipId}/temporary-password`, {}),
  setAccountStatus: (membershipId: string, body: unknown) =>
    apiPatch<AdminAccount>(`${BASE}/users/${membershipId}/status`, body),
  setAccountPassword: (membershipId: string, password: string) =>
    apiPost<AdminAccount>(`${BASE}/users/${membershipId}/password`, { password }),
  changeEmail: (membershipId: string, email: string) =>
    apiPatch<AdminAccount>(`${BASE}/users/${membershipId}/email`, { email }),
  /** Links the account to its employee record (or unlinks it with null). */
  setAccountEmployee: (membershipId: string, employeeId: string | null) =>
    apiPatch<AdminAccount>(`${BASE}/users/${membershipId}/employee`, { employeeId }),
  setAccountRoles: (membershipId: string, roleIds: string[]) =>
    apiPatch<AdminAccount>(`${BASE}/users/${membershipId}/roles`, { roleIds }),

  createRole: (body: unknown) => apiPost<Role>(`${BASE}/roles`, body),
  updateRole: (id: string, body: unknown) => apiPatch<Role>(`${BASE}/roles/${id}`, body),
  archiveRole: (id: string) => apiPost<Role>(`${BASE}/roles/${id}/archive`, {}),

  createDepartment: (body: unknown) => apiPost<Department>(`${BASE}/departments`, body),
  updateDepartment: (id: string, body: unknown) =>
    apiPatch<Department>(`${BASE}/departments/${id}`, body),

  // Keyed on the account, never the provider: a company may hold two Samsara organisations.
  connectIntegration: (body: unknown) =>
    apiPost<IntegrationAccountView>(`${BASE}/integrations/connect`, body),
  replaceIntegrationCredential: (accountId: string, credentials: Record<string, string>) =>
    apiPost<IntegrationAccountView>(`${BASE}/integrations/accounts/${accountId}/credentials`, {
      credentials,
    }),
  renameIntegration: (accountId: string, name: string) =>
    apiPatch<IntegrationAccountView>(`${BASE}/integrations/accounts/${accountId}`, { name }),
  setIntegrationStatus: (accountId: string, status: string) =>
    apiPatch<IntegrationAccountView>(`${BASE}/integrations/accounts/${accountId}/status`, {
      status,
    }),
  disconnectIntegration: (accountId: string) =>
    apiPost<IntegrationAccountView>(`${BASE}/integrations/accounts/${accountId}/disconnect`, {}),
  archiveIntegration: (accountId: string, reason?: string) =>
    apiPost<IntegrationAccountView>(`${BASE}/integrations/accounts/${accountId}/archive`, reason ? { reason } : {}),
  unarchiveIntegration: (accountId: string) =>
    apiPost<IntegrationAccountView>(`${BASE}/integrations/accounts/${accountId}/unarchive`, {}),
  testIntegration: (accountId: string) =>
    apiPost<{ organisation: string }>(`${BASE}/integrations/accounts/${accountId}/test`, {}),
  syncIntegration: (accountId: string, body: SyncRequest) =>
    apiPost<SyncReport>(`${BASE}/integrations/accounts/${accountId}/sync`, body),

  createWorkflow: (body: unknown) => apiPost<WorkflowRule>(`${BASE}/workflows`, body),
  updateWorkflow: (id: string, body: unknown) =>
    apiPatch<WorkflowRule>(`${BASE}/workflows/${id}`, body),

  updateSettings: (values: Record<string, unknown>) =>
    apiPatch<ResolvedSetting[]>(`${BASE}/settings`, { values }),

  markNotificationRead: (id: string) => apiPost<void>(`${BASE}/notifications/${id}/read`, {}),
  markAllNotificationsRead: () => apiPost<number>(`${BASE}/notifications/read-all`, {}),
};

/**
 * A mutation that refreshes the whole control plane on success.
 *
 * Coarse on purpose. Roles, accounts and the audit trail are entangled enough that a targeted
 * invalidation is a bug waiting for the second reader; this data is small and rarely written.
 */
export function useAdminMutation<TInput, TResult>(
  fn: (input: TInput) => Promise<TResult>,
): ReturnType<typeof useMutation<TResult, unknown, TInput>> {
  const client = useQueryClient();
  return useMutation<TResult, unknown, TInput>({
    mutationFn: fn,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export type { WorkflowAction };
