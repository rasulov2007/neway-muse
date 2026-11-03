import type { DashboardPeriodPreset, DashboardPeriodQuery } from '@neway/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { DEFAULT_DEMO_ROLE, type DashboardRequest, type DemoRole } from '@/lib/dashboard-api';
import { parseDashboardSearch, type DashboardSearch } from './search';

export const DEFAULT_PRESET: DashboardPeriodPreset = 'this_week';

export interface PeriodState {
  /** What the user picked (custom may still be missing its dates). */
  preset: DashboardPeriodPreset;
  from?: string;
  to?: string;
  role: DemoRole;
  /** Query sent to every endpoint; an incomplete custom range falls back to the default preset. */
  query: DashboardPeriodQuery;
  /** Stable cache key for `['dashboard', section, periodKey, role]`. */
  periodKey: string;
  request: DashboardRequest;
  setPreset: (preset: DashboardPeriodPreset) => void;
  setCustomRange: (from: string, to: string) => void;
  setRole: (role: DemoRole) => void;
}

/** Builds the endpoint query from a search selection (docs/DASHBOARD.md §3). */
export function toPeriodQuery(search: DashboardSearch): DashboardPeriodQuery {
  const preset = search.period ?? DEFAULT_PRESET;
  if (preset === 'custom') {
    if (search.from && search.to && search.from <= search.to) {
      return { period: 'custom', from: search.from, to: search.to };
    }
    return { period: DEFAULT_PRESET };
  }
  return { period: preset };
}

export function periodKeyOf(query: DashboardPeriodQuery): string {
  return query.period === 'custom' ? `custom:${query.from}:${query.to}` : query.period;
}

/** The period selection and demo role, stored in the route search params. */
export function usePeriod(): PeriodState {
  const rawSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const search = useMemo(() => parseDashboardSearch(rawSearch), [rawSearch]);

  const update = useCallback(
    (patch: Partial<DashboardSearch>) => {
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => {
          const next: Record<string, unknown> = { ...prev, ...patch };
          for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
          return next;
        },
      } as never);
    },
    [navigate],
  );

  return useMemo(() => {
    const query = toPeriodQuery(search);
    const role = search.role ?? DEFAULT_DEMO_ROLE;
    return {
      preset: search.period ?? DEFAULT_PRESET,
      from: search.from,
      to: search.to,
      role,
      query,
      periodKey: periodKeyOf(query),
      request: { period: query, role },
      setPreset: (preset) =>
        update(
          preset === 'custom'
            ? { period: 'custom' }
            : { period: preset, from: undefined, to: undefined },
        ),
      setCustomRange: (from, to) => update({ period: 'custom', from, to }),
      setRole: (nextRole) => update({ role: nextRole }),
    };
  }, [search, update]);
}
