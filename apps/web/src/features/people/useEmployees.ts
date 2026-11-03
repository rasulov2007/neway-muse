import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  ChangeEmployeeStatusRequest,
  CompensationHistoryEntry,
  CreateEmployeeRequest,
  EmployeePage,
  EmployeeRecord,
  PositionHistoryEntry,
  ReassignEmployeeRequest,
  SetCompensationRequest,
  UpdateEmployeeRequest,
  WorkforceSummary,
} from '@neway/shared';
import { apiGet, apiPatch, apiPost } from '@/lib/api-client';
import type { EmployeesSearch } from './employees-search';

/**
 * The employee data layer.
 *
 * Paging, filtering and sorting are all parameters on the request rather than work done in the
 * browser: this list is built for a carrier with thousands of people, and a page that fetches
 * everything to filter five rows out of it stops working long before that.
 *
 * The summary counts come from the same endpoint family and the same filters, so a tile and the
 * list it opens are two views of one query rather than two independent calculations.
 */

export interface EmployeeActivityEntry {
  id: string;
  at: string;
  actorName: string;
  actorType: string;
  /** `create` | `update` | `assign` | `status_change`, and whatever later modules write. */
  action: string;
  summary: string;
  changes: { field: string; old: string | null; new: string | null }[];
  reason: string | null;
}

export type EmployeesPageScope = 'profile_complete' | 'profile_incomplete';

/**
 * The Employees page lists only people who filled in Complete your profile, unless the "Not yet
 * filled" view is open (owner, 2026-10-26). Drivers are on neither: they are on the Drivers page.
 */
export function employeesPageScope(search: EmployeesSearch): EmployeesPageScope {
  return search.view === 'incomplete' ? 'profile_incomplete' : 'profile_complete';
}

/**
 * Turns the URL state into the query string the API expects, dropping anything unset. `scope` is
 * passed only by the Employees page; every other reader of the list leaves it out.
 */
export function toEmployeeQuery(
  search: EmployeesSearch,
  scope?: EmployeesPageScope,
): Record<string, unknown> {
  return {
    scope,
    page: search.page ?? 1,
    pageSize: search.pageSize ?? 25,
    search: search.q,
    status: search.status,
    department: search.department,
    position: search.position,
    employmentType: search.employmentType,
    location: search.location,
    managerEmployeeId: search.manager,
    workforce: search.workforce,
    hiredFrom: search.hiredFrom,
    hiredTo: search.hiredTo,
    sort: search.sort ?? 'name',
    sortDir: search.sortDir ?? 'asc',
    includeInactive: search.includeInactive ? 'true' : undefined,
  };
}

export function useEmployees(
  search: EmployeesSearch,
  scope?: EmployeesPageScope,
): UseQueryResult<EmployeePage> {
  const params = toEmployeeQuery(search, scope);
  return useQuery({
    queryKey: ['employees', 'list', params],
    queryFn: () => apiGet<EmployeePage>('/employees', params),
    // A list that flickers back to the previous page while the next one loads is worse than one
    // that holds still, so the old page stays on screen until the new one lands.
    placeholderData: (previous) => previous,
  });
}

export function useWorkforceSummary(
  search: EmployeesSearch,
  scope?: EmployeesPageScope,
): UseQueryResult<WorkforceSummary> {
  const params = { includeInactive: search.includeInactive ? 'true' : undefined, scope };
  return useQuery({
    queryKey: ['employees', 'summary', params],
    queryFn: () => apiGet<WorkforceSummary>('/employees/summary', params),
  });
}

/**
 * Every row of the current view, page by page at the server's largest page, for Export. The
 * filters, sort and scope are exactly the list's, so the file matches what is on screen.
 */
export async function fetchAllEmployees(
  search: EmployeesSearch,
  scope?: EmployeesPageScope,
): Promise<EmployeeRecord[]> {
  const out: EmployeeRecord[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const params = { ...toEmployeeQuery(search, scope), page, pageSize: 200 };
    const result = await apiGet<EmployeePage>('/employees', params);
    out.push(...result.data);
    if (out.length >= result.total || result.data.length === 0) break;
  }
  return out;
}

export function useEmployee(id: string): UseQueryResult<EmployeeRecord> {
  return useQuery({
    queryKey: ['employees', 'one', id],
    queryFn: () => apiGet<EmployeeRecord>(`/employees/${encodeURIComponent(id)}`),
    enabled: id.length > 0,
  });
}

export function useEmploymentHistory(id: string): UseQueryResult<PositionHistoryEntry[]> {
  return useQuery({
    queryKey: ['employees', 'employment', id],
    queryFn: () =>
      apiGet<PositionHistoryEntry[]>(`/employees/${encodeURIComponent(id)}/employment`),
    enabled: id.length > 0,
  });
}

export function useCompensationHistory(id: string): UseQueryResult<CompensationHistoryEntry[]> {
  return useQuery({
    queryKey: ['employees', 'compensation', id],
    queryFn: () =>
      apiGet<CompensationHistoryEntry[]>(`/employees/${encodeURIComponent(id)}/compensation`),
    enabled: id.length > 0,
  });
}

export function useDirectReports(id: string): UseQueryResult<EmployeeRecord[]> {
  return useQuery({
    queryKey: ['employees', 'reports', id],
    queryFn: () => apiGet<EmployeeRecord[]>(`/employees/${encodeURIComponent(id)}/reports`),
    enabled: id.length > 0,
  });
}

export function useEmployeeActivity(id: string): UseQueryResult<EmployeeActivityEntry[]> {
  return useQuery({
    queryKey: ['employees', 'activity', id],
    queryFn: () => apiGet<EmployeeActivityEntry[]>(`/employees/${encodeURIComponent(id)}/activity`),
    enabled: id.length > 0,
  });
}

/** Every list of people the pickers need — managers, positions, locations — from one fetch. */
export function useEmployeeDirectory(): UseQueryResult<EmployeeRecord[]> {
  return useQuery({
    queryKey: ['employees', 'directory'],
    queryFn: async () => {
      const first = await apiGet<EmployeePage>('/employees', { page: 1, pageSize: 10_000 });
      const pages = Math.ceil(first.total / 200);
      const rows = [...first.data];
      for (let page = 2; page <= pages; page += 1) {
        const next = await apiGet<EmployeePage>('/employees', { page, pageSize: 10_000 });
        rows.push(...next.data);
      }
      return rows;
    },
    staleTime: 60_000,
  });
}

/** Everything employee-shaped is refetched after a write; the server's row is the answer. */
export function useInvalidateEmployees(): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    await client.invalidateQueries({ queryKey: ['employees'] });
  };
}

export function useCreateEmployee() {
  const invalidate = useInvalidateEmployees();
  return useMutation({
    mutationFn: (input: CreateEmployeeRequest) => apiPost<EmployeeRecord>('/employees', input),
    onSuccess: invalidate,
  });
}

export function useUpdateEmployee(id: string) {
  const invalidate = useInvalidateEmployees();
  return useMutation({
    mutationFn: (input: UpdateEmployeeRequest) =>
      apiPatch<EmployeeRecord>(`/employees/${encodeURIComponent(id)}`, input),
    onSuccess: invalidate,
  });
}

export function useReassignEmployee(id: string) {
  const invalidate = useInvalidateEmployees();
  return useMutation({
    mutationFn: (input: ReassignEmployeeRequest) =>
      apiPost<EmployeeRecord>(`/employees/${encodeURIComponent(id)}/reassign`, input),
    onSuccess: invalidate,
  });
}

export function useChangeEmployeeStatus(id: string) {
  const invalidate = useInvalidateEmployees();
  return useMutation({
    mutationFn: (input: ChangeEmployeeStatusRequest) =>
      apiPost<EmployeeRecord>(`/employees/${encodeURIComponent(id)}/status`, input),
    onSuccess: invalidate,
  });
}

export function useSetCompensation(id: string) {
  const invalidate = useInvalidateEmployees();
  return useMutation({
    mutationFn: (input: SetCompensationRequest) =>
      apiPost<EmployeeRecord>(`/employees/${encodeURIComponent(id)}/compensation`, input),
    onSuccess: invalidate,
  });
}
