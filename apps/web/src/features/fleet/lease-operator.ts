import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api-client';

/**
 * Trucks a lease operator drives (owner, 2026-11-03): on these the invoice is optional - a work
 * order completes and an oil change saves without one, and nothing lists it as missing. The
 * oil-change clock is the same as on every truck.
 */
export function useLeaseOperatorTrucks(): Set<string> {
  const query = useQuery({
    queryKey: ['fleet', 'lease-operator-units'],
    queryFn: () => apiGet<{ truckIds: string[] }>('/fleet/work-orders/lease-operator-units'),
    staleTime: 5 * 60_000,
  });
  return new Set(query.data?.truckIds ?? []);
}
