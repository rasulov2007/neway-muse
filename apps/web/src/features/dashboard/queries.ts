import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { DashboardRequest } from '@/lib/dashboard-api';
import type { PeriodState } from './period/usePeriod';

export type DashboardSection =
  | 'overview'
  | 'trends'
  | 'ops-net'
  | 'vendors'
  | 'truck-pnl'
  | 'fuel'
  | 'dispatch'
  | 'data-health'
  | 'drilldown';

/** `['dashboard', section, periodKey, role, ...extra]` (docs/DASHBOARD.md §13). */
export function dashboardKey(
  section: DashboardSection,
  period: Pick<PeriodState, 'periodKey' | 'role'>,
  ...extra: unknown[]
): unknown[] {
  return ['dashboard', section, period.periodKey, period.role, ...extra];
}

/** One query per endpoint; a failure stays inside its own widget. */
export function useDashboardSection<T>(
  section: DashboardSection,
  period: PeriodState,
  fetcher: (request: DashboardRequest) => Promise<T>,
  options: { enabled?: boolean; extraKey?: unknown[] } = {},
): UseQueryResult<T> {
  return useQuery({
    queryKey: dashboardKey(section, period, ...(options.extraKey ?? [])),
    queryFn: () => fetcher(period.request),
    enabled: options.enabled,
    placeholderData: (previous) => previous,
  });
}
