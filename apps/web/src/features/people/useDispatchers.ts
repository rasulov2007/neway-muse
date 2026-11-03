import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Dispatcher } from '@neway/shared';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet } from '@/lib/api-client';

export const DISPATCHERS_KEY = ['employees', 'dispatchers'] as const;

/**
 * The one dispatcher list every picker reads (2026-09-21): employees in a dispatching position,
 * from the company's own records. Invalidated with everything employee-shaped, so a dispatcher
 * created, renamed or made inactive shows up everywhere on the next render.
 */
export function useDispatchers(): UseQueryResult<Dispatcher[]> {
  const account = useAccount();
  return useQuery({
    queryKey: DISPATCHERS_KEY,
    queryFn: () => apiGet<Dispatcher[]>('/employees/dispatchers'),
    enabled: account !== null,
    staleTime: 30_000,
  });
}

/**
 * Picker options: active dispatchers for new work. The one already on the record stays in the
 * list even when inactive, so an old assignment still shows its name and is not silently moved.
 */
export function dispatcherOptions(
  list: readonly Dispatcher[] | undefined,
  keepId?: string | null,
): { value: string; label: string; description?: string }[] {
  return (list ?? [])
    .filter((d) => d.active || d.id === keepId)
    .map((d) => ({
      value: d.id,
      label: d.name,
      // The label stays the name the roster stores; the nickname rides in the description
      // (owner, 2026-10-26) and the boards show it once the team is linked.
      description: [
        d.nickname ? `“${d.nickname}”` : null,
        d.position,
        d.active ? d.employeeNumber : d.status,
      ]
        .filter(Boolean)
        .join(' · '),
    }));
}
