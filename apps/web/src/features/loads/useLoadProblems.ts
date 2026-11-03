import { useQuery } from '@tanstack/react-query';
import { useAccount } from '@/features/auth/auth-context';
import type { LoadProblem } from '@neway/shared';
import { apiGet } from '@/lib/api-client';

/** The open flags across the company, for the lists and the board. Empty until the server answers. */
export function useOpenProblems() {
  // Load flags are for accounts that can see loads; polling without it is a 403 a minute.
  const canSee = useAccount()?.permissions.includes('loads.view') ?? false;
  return useQuery({
    queryKey: ['load-problems', 'open'],
    queryFn: () => apiGet<LoadProblem[]>('/load-problems?open=true'),
    refetchInterval: 60_000,
    enabled: canSee,
  });
}

/** Every flag on one load, open and closed. */
export function useLoadProblems(loadId: string | null) {
  return useQuery({
    queryKey: ['load-problems', 'load', loadId],
    queryFn: () => apiGet<LoadProblem[]>(`/loads/${loadId}/problems`),
    enabled: loadId !== null,
  });
}
