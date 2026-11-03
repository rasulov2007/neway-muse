import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TruckAssignmentView } from '@neway/shared';
import { invalidateRoster } from '@/demo/roster-api';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet } from '@/lib/api-client';
import { boardKeys } from '@/features/dispatch/board/api';
import { useInvalidateFleet } from './useFleet';

export function assignmentKey(truckId: string) {
  return ['fleet', 'assignment', truckId] as const;
}

/** Who is in the truck, since when, and what went with it; plus the earlier tenancies. */
export function useTruckAssignment(truckId: string) {
  const account = useAccount();
  return useQuery({
    queryKey: assignmentKey(truckId),
    queryFn: () => apiGet<TruckAssignmentView>(`/trucks/${truckId}/assignment`),
    enabled: account !== null,
  });
}

/**
 * What every assignment write does once the server answered (2026-10-08).
 *
 * The truck page reads the assignment; the Vehicles list, the unit header, the Overview and the
 * global search read the roster the client caches in memory (`ensureRoster`), and the dispatch
 * boards read their own queries. A write that refreshed only the first left the rest showing the
 * old driver until a reload. This drops the in-memory roster first (so the refetches below read
 * the server, not the memo) and then invalidates every query that shows who drives what.
 */
export function useAfterAssignmentChange(truckId: string) {
  const queryClient = useQueryClient();
  const invalidateFleet = useInvalidateFleet();
  return async (next?: TruckAssignmentView) => {
    if (next) queryClient.setQueryData(assignmentKey(truckId), next);
    invalidateRoster();
    await Promise.all([
      invalidateFleet(),
      queryClient.invalidateQueries({ queryKey: ['drivers'] }),
      queryClient.invalidateQueries({ queryKey: ['roster'] }),
      queryClient.invalidateQueries({ queryKey: boardKeys.all }),
      // Another unit's card (the one a moved driver left) reads its own assignment query.
      queryClient.invalidateQueries({ queryKey: ['fleet', 'assignment'] }),
    ]);
  };
}
