import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  BreakdownAssignInput,
  BreakdownNoteInput,
  BreakdownShopInput,
  BreakdownStatus,
  BreakdownStatusInput,
  BreakdownWorkOrderInput,
  FleetBreakdown,
  FleetBreakdownList,
} from '@neway/shared';
import type { BadgeTone } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet, apiPatch, apiPost } from '@/lib/api-client';

/**
 * Fleet → Breakdowns (mobile M3): the cases drivers report from the road. Keys sit under `fleet`
 * so a work order written anywhere refreshes them, and a breakdown written here refreshes Today.
 */
export const breakdownsKey = (companyId: string | null) => ['fleet', 'breakdowns', companyId];
export const breakdownKey = (companyId: string | null, id: string) => ['fleet', 'breakdowns', companyId, id];

export function useBreakdowns(open: boolean): UseQueryResult<FleetBreakdownList> {
  const account = useAccount();
  return useQuery({
    queryKey: [...breakdownsKey(account?.companyId ?? null), open ? 'open' : 'all'],
    queryFn: () => apiGet<FleetBreakdownList>(`/fleet/breakdowns${open ? '?open=true' : ''}`),
    enabled: account !== null,
    refetchInterval: 60_000,
  });
}

export function useBreakdown(id: string): UseQueryResult<FleetBreakdown> {
  const account = useAccount();
  return useQuery({
    queryKey: breakdownKey(account?.companyId ?? null, id),
    queryFn: () => apiGet<FleetBreakdown>(`/fleet/breakdowns/${encodeURIComponent(id)}`),
    enabled: account !== null,
  });
}

export interface BreakdownShop {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
}

export function useBreakdownShops(enabled: boolean): UseQueryResult<BreakdownShop[]> {
  const account = useAccount();
  return useQuery({
    queryKey: ['fleet', 'breakdowns', account?.companyId ?? null, 'shops'],
    queryFn: () => apiGet<BreakdownShop[]>('/fleet/breakdowns/shops'),
    enabled: account !== null && enabled,
    staleTime: 5 * 60_000,
  });
}

export function useBreakdownPeople(enabled: boolean): UseQueryResult<Array<{ id: string; name: string }>> {
  const account = useAccount();
  return useQuery({
    queryKey: ['fleet', 'breakdowns', account?.companyId ?? null, 'people'],
    queryFn: () => apiGet<Array<{ id: string; name: string }>>('/fleet/breakdowns/people'),
    enabled: account !== null && enabled,
    staleTime: 5 * 60_000,
  });
}

type Action =
  | { kind: 'assign'; body: BreakdownAssignInput }
  | { kind: 'shop'; body: BreakdownShopInput }
  | { kind: 'work-order'; body: BreakdownWorkOrderInput }
  | { kind: 'status'; body: BreakdownStatusInput }
  | { kind: 'note'; body: BreakdownNoteInput };

/** Every office action on a case: version-checked on the server, the answer is the case as saved. */
export function useBreakdownAction(id: string) {
  const qc = useQueryClient();
  const account = useAccount();
  return useMutation({
    mutationFn: (a: Action): Promise<FleetBreakdown> => {
      const base = `/fleet/breakdowns/${encodeURIComponent(id)}`;
      if (a.kind === 'status') return apiPatch<FleetBreakdown>(`${base}/status`, a.body);
      return apiPost<FleetBreakdown>(`${base}/${a.kind === 'note' ? 'notes' : a.kind}`, a.body);
    },
    onSuccess: (saved) => {
      qc.setQueryData(breakdownKey(account?.companyId ?? null, id), saved);
      void qc.invalidateQueries({ queryKey: ['fleet'] });
    },
  });
}

/**
 * Status = symbol + word + colour. Breakdown statuses are new (not in SPEC §7's table), so their
 * families are listed for the owner's decision: a new case needs someone (warning), work under way
 * is moving, ready is done, closed is neutral.
 */
export const BREAKDOWN_TONE: Record<BreakdownStatus, BadgeTone> = {
  received: 'warning',
  assigned: 'info',
  shop_arranged: 'info',
  in_repair: 'info',
  ready: 'success',
  closed: 'neutral',
};
