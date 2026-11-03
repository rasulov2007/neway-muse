import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { FleetToday, WorkOrder, WorkOrderDetail, WorkOrderWithCost } from '@neway/shared';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet } from '@/lib/api-client';

/** `['fleet', 'today', company]` — under the `fleet` prefix, so a write anywhere refreshes it. */
export function fleetTodayKey(companyId: string | null): unknown[] {
  return ['fleet', 'today', companyId];
}

/**
 * The Today board.
 *
 * Refetched every five minutes because a shop calls, a mechanic finishes something, and the board
 * is read from a phone that has been in a pocket. The downtime counters tick on the client between
 * refetches, so a number on screen is never older than a second even though the data is.
 */
export function useFleetToday(): UseQueryResult<FleetToday> {
  const account = useAccount();
  return useQuery({
    queryKey: fleetTodayKey(account?.companyId ?? null),
    queryFn: () => apiGet<FleetToday>('/fleet/today'),
    enabled: account !== null,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    staleTime: 60_000,
  });
}

/** `['fleet', 'work-order', company, id]` — the key a write updates in place. */
export function workOrderKey(companyId: string | null, id: string | null): unknown[] {
  return ['fleet', 'work-order', companyId, id];
}

/** One work order with its whole action history. */
export function useWorkOrder(id: string | null): UseQueryResult<WorkOrderDetail> {
  const account = useAccount();
  return useQuery({
    queryKey: workOrderKey(account?.companyId ?? null, id),
    queryFn: () => apiGet<WorkOrderDetail>(`/fleet/work-orders/${id ?? ''}`),
    enabled: account !== null && id !== null,
    staleTime: 15_000,
  });
}

/** Every work order the company has, newest first; the cost-bearing shape only for those who may see money. */
export function useWorkOrders(): UseQueryResult<(WorkOrder | WorkOrderWithCost)[]> {
  const account = useAccount();
  return useQuery({
    queryKey: ['work-orders', 'all', account?.companyId ?? null],
    queryFn: () => apiGet<(WorkOrder | WorkOrderWithCost)[]>('/fleet/work-orders'),
    enabled: account !== null,
  });
}
