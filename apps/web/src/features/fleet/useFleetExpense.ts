import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { FleetExpenseSummary, FleetSpendPeriod, FleetUnitTypeFilter } from '@neway/shared';
import { listTrucks, type Truck } from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet } from '@/lib/api-client';

export interface FleetExpenseParams {
  period: FleetSpendPeriod;
  units: string[];
  unitType: FleetUnitTypeFilter;
  /** Any day of the chosen period; absent = the current one (to date). */
  at?: string;
  /** Maintenance only (default) or all fleet costs. */
  scope?: 'maintenance' | 'all';
  /** A rolling window to today instead of the period (the tire map's 30 days / 90 days / 12 months). */
  window?: '7d' | '30d' | '90d' | '12m';
}

/**
 * `['fleet', 'expense-summary', company, period, units]`.
 *
 * Under the `fleet` prefix on purpose: `useInvalidateFleet` clears that prefix after every fleet
 * write, which is what makes an invoice attached on the work order page move the total here. The
 * company is in the key so a cache from one sign-in never answers for another.
 */
export function fleetExpenseKey(companyId: string | null, params: FleetExpenseParams): unknown[] {
  return [
    'fleet',
    'expense-summary',
    companyId,
    params.period,
    params.unitType,
    [...params.units].sort().join(','),
    params.at ?? 'current',
    params.scope ?? 'maintenance',
    params.window ?? 'period',
  ];
}

/** The summary the API aggregated for this company, period and unit selection. */
export function useFleetExpense(params: FleetExpenseParams): UseQueryResult<FleetExpenseSummary> {
  const account = useAccount();
  return useQuery({
    queryKey: fleetExpenseKey(account?.companyId ?? null, params),
    queryFn: () =>
      apiGet<FleetExpenseSummary>('/fleet/expense-summary', {
        period: params.period,
        unitType: params.unitType,
        units: params.units.length > 0 ? params.units.join(',') : undefined,
        at: params.at,
        scope: params.scope === 'all' ? 'all' : undefined,
        window: params.window,
      }),
    // Spend is the cost view; an account without it would only collect a 403 here.
    enabled: account !== null && (account.isOwner || account.permissions.includes('maintenance_costs.view')),
    // A period change keeps the last figures on screen while the next ones load.
    placeholderData: (previous) => previous,
    staleTime: 15_000,
  });
}

/** The roster, for the unit typeahead. Paged the way the real API pages; never one huge request. */
export function useTruckOptions(): UseQueryResult<Truck[]> {
  return useQuery({
    queryKey: ['trucks', 'options'],
    queryFn: async () => {
      const pageSize = 200;
      const first = await listTrucks({ page: 1, pageSize });
      const rows = [...first.data];
      for (let page = 2; page <= Math.ceil(first.total / pageSize); page += 1) {
        rows.push(...(await listTrucks({ page, pageSize })).data);
      }
      return rows;
    },
    staleTime: 60_000,
  });
}
