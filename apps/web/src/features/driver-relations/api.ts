import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CareLink,
  ContactMethod,
  CreateCareLinkInput,
  DriverRelationAssignee,
  DriverRelationCounts,
  DriverRelationDetail,
  DriverRelationIntegrationStatus,
  DriverRelationListQuery,
  DriverRelationPage,
  DriverRelationRosterOption,
} from '@neway/shared';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet, apiPatch, apiPost } from '@/lib/api-client';

/**
 * Driver Relations' data layer.
 *
 * There is no push channel in this product (no SSE or WebSocket), so the counts and the list are
 * polled every 20 seconds, and refetched when the window regains focus or the network comes back.
 * A poll is never treated as truth beyond what the server said: every count on the page and in
 * the sidebar is the server's `needs_contact` total, refetched after every write.
 */

const BASE = '/driver-relations';
export const DR_POLL_MS = 20_000;
const live = {
  refetchInterval: DR_POLL_MS,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  staleTime: 5_000,
} as const;

export const drKeys = {
  all: ['driver-relations'] as const,
  counts: ['driver-relations', 'counts'] as const,
  list: (q: DriverRelationListQuery) => ['driver-relations', 'list', q] as const,
  detail: (id: string) => ['driver-relations', 'detail', id] as const,
};

/** True when the signed-in account may open Driver Relations. */
export function useCanSeeDriverRelations(): boolean {
  const account = useAccount();
  return Boolean(account && (account.isOwner || account.permissions.includes('driver_relations.view')));
}

export function useCanContact(): boolean {
  const account = useAccount();
  return Boolean(account && (account.isOwner || account.permissions.includes('driver_relations.contact')));
}

export function useCanManageLinks(): boolean {
  const account = useAccount();
  return Boolean(account && (account.isOwner || account.permissions.includes('driver_relations.manage')));
}

export function useDriverRelationCounts(enabled = true) {
  return useQuery({
    queryKey: drKeys.counts,
    queryFn: () => apiGet<DriverRelationCounts>(`${BASE}/counts`, undefined, { background: true }),
    enabled,
    ...live,
  });
}

export function useDriverRelationList(query: DriverRelationListQuery) {
  return useQuery({
    queryKey: drKeys.list(query),
    queryFn: () => apiGet<DriverRelationPage>(`${BASE}/requests`, query as Record<string, unknown>),
    placeholderData: (previous) => previous,
    ...live,
  });
}

export function useDriverRelationDetail(id: string | null) {
  return useQuery({
    queryKey: drKeys.detail(id ?? ''),
    queryFn: () => apiGet<DriverRelationDetail>(`${BASE}/requests/${encodeURIComponent(id ?? '')}`),
    enabled: id !== null,
    ...live,
  });
}

export function useAssignees() {
  return useQuery({
    queryKey: ['driver-relations', 'assignees'],
    queryFn: () => apiGet<DriverRelationAssignee[]>(`${BASE}/assignees`),
    staleTime: 5 * 60_000,
  });
}

export function useIntegrationStatus() {
  return useQuery({
    queryKey: ['driver-relations', 'integration'],
    queryFn: () => apiGet<DriverRelationIntegrationStatus>(`${BASE}/integration`),
    staleTime: 5 * 60_000,
  });
}

export function useCareLinks() {
  return useQuery({
    queryKey: ['driver-relations', 'care-links'],
    queryFn: () => apiGet<CareLink[]>(`${BASE}/care-links`),
    staleTime: 60_000,
  });
}

export function useRosterOptions(q: string, enabled: boolean) {
  return useQuery({
    queryKey: ['driver-relations', 'roster', q],
    queryFn: () => apiGet<DriverRelationRosterOption[]>(`${BASE}/roster-options`, { q }),
    enabled,
    staleTime: 60_000,
  });
}

/** Every write answers with the request's new detail; the counts and lists are refetched. */
function useRequestWrite<TBody>(path: (id: string) => string, method: 'POST' | 'PATCH' = 'POST') {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: TBody }) =>
      method === 'POST'
        ? apiPost<DriverRelationDetail>(path(id), body)
        : apiPatch<DriverRelationDetail>(path(id), body),
    onSuccess: (detail) => {
      client.setQueryData(drKeys.detail(detail.request.id), detail);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: drKeys.all });
    },
  });
}

const req = (id: string) => `${BASE}/requests/${encodeURIComponent(id)}`;

export const useRecordContact = () =>
  useRequestWrite<{ method: ContactMethod; note: string; expectedVersion: number }>((id) => `${req(id)}/contact`);
export const useRecordAttempt = () =>
  useRequestWrite<{ method: ContactMethod; note: string }>((id) => `${req(id)}/attempts`);
export const useAddNote = () =>
  useRequestWrite<{ note: string; correctsActivityId?: string; shareWithDriver?: boolean }>((id) => `${req(id)}/notes`);
export const useResolve = () =>
  useRequestWrite<{ note: string; expectedVersion: number }>((id) => `${req(id)}/resolve`);
export const useReopen = () =>
  useRequestWrite<{ note: string; expectedVersion: number }>((id) => `${req(id)}/reopen`);
export const useDriverMessage = () =>
  useRequestWrite<{ message: string; method: ContactMethod; expectedVersion: number }>(
    (id) => `${req(id)}/driver-messages`,
  );
export const useAssign = () =>
  useRequestWrite<{ assigneeUserId: string | null; expectedVersion: number }>(
    (id) => `${req(id)}/assignment`,
    'PATCH',
  );
export const useLinkRecords = () =>
  useRequestWrite<{
    driverId?: string | null;
    truckId?: string | null;
    accountingExpenseId?: string | null;
    expectedVersion: number;
  }>((id) => `${req(id)}/links`, 'PATCH');

export function useCreateCareLink() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCareLinkInput) => apiPost<CareLink>(`${BASE}/care-links`, body),
    onSettled: () => void client.invalidateQueries({ queryKey: ['driver-relations', 'care-links'] }),
  });
}

export function useUpdateCareLink() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name?: string; active?: boolean } }) =>
      apiPatch<CareLink>(`${BASE}/care-links/${encodeURIComponent(id)}`, body),
    onSettled: () => void client.invalidateQueries({ queryKey: ['driver-relations', 'care-links'] }),
  });
}
