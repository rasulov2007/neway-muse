import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { InvestigationList, InvestigationQuery } from '@neway/shared';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet } from '@/lib/api-client';

/** Who may read the list: the fleet's cost view, Accounting, or Safety. */
export function useCanSeeInvestigations(): boolean {
  const account = useAccount();
  return (
    account !== null &&
    (account.isOwner ||
      ['maintenance_costs.view', 'accounting.view', 'compliance.manage'].some((p) => account.permissions.includes(p)))
  );
}

export function useInvestigations(query: InvestigationQuery, enabled = true): UseQueryResult<InvestigationList> {
  const account = useAccount();
  const allowed = useCanSeeInvestigations();
  return useQuery({
    // Under `fleet` so every fleet write (a repair saved, an expense recorded) refreshes it.
    queryKey: ['fleet', 'investigations', account?.companyId ?? null, query],
    queryFn: () => apiGet<InvestigationList>('/fleet/expenses/investigations', query as Record<string, unknown>),
    enabled: allowed && enabled,
    staleTime: 15_000,
  });
}

