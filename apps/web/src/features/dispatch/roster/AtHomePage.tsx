import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AtHomeList } from '@neway/shared';
import { EmptyState, ErrorState, Input, Select, cn } from '@/design-system';
import { apiGet } from '@/lib/api-client';
import { formatIsoDate } from '@/lib/format';
import { BoardNav } from '../board/chrome';

/**
 * Drivers at home (owner, 2026-10-30): beside On vacation, the drivers whose status on today's
 * Daily board is HOME - since when and for how many days. HOME is set on the Daily board; a
 * different word there takes the driver off this list.
 */
export function AtHomePage() {
  const list = useQuery({ queryKey: ['dispatch', 'at-home'], queryFn: () => apiGet<AtHomeList>('/dispatch/board/at-home') });
  const [q, setQ] = useState('');
  const [dispatcher, setDispatcher] = useState('all');
  const all = useMemo(() => list.data?.rows ?? [], [list.data]);
  const dispatchers = useMemo(() => [...new Set(all.map((r) => r.dispatcherName).filter(Boolean))].sort(), [all]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((r) => (dispatcher === 'all' || r.dispatcherName === dispatcher) && (!needle || `${r.driverName} ${r.coDriver ?? ''} ${r.unitNumber ?? ''}`.toLowerCase().includes(needle)));
  }, [all, q, dispatcher]);
  const count = (min: number) => (list.data ? all.filter((r) => r.daysHome >= min).length : undefined);

  return (
    <div className="page-surface-workspace flex flex-col gap-5">
      <BoardNav current="/dispatch/at-home" />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-tight font-bold text-nw-text">Drivers at home</h1>
          <p className="mt-1 text-[15px] text-nw-text-2">HOME on today’s Daily board, since when and for how long.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input size="sm" prefix={<Search />} placeholder="Search driver (name or unit #)" aria-label="Search driver" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
          <Select size="sm" aria-label="Dispatcher" value={dispatcher} onValueChange={setDispatcher} className="w-48" options={[{ value: 'all', label: 'All dispatchers' }, ...dispatchers.map((d) => ({ value: d, label: d }))]} />
        </div>
      </header>

      {list.isError ? (
        <ErrorState onRetry={() => void list.refetch()} />
      ) : (
        <>
          <section aria-label="Summary" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Figure label="At home" value={count(0)} edge="border-t-nw-accent" />
            <Figure label="Home 3+ days" value={count(3)} edge="border-t-nw-moving-icon" />
            <Figure label="Home 7+ days" value={count(7)} edge="border-t-nw-warning-icon" />
          </section>

          <section aria-label="Drivers" className="min-w-0 rounded-[12px] border border-nw-border-strong bg-nw-panel p-3">
            {list.isPending ? (
              <p className="text-sm text-nw-text-3">Loading…</p>
            ) : rows.length === 0 ? (
              <EmptyState title={q || dispatcher !== 'all' ? 'No driver matches' : 'No drivers at home'} description={!q && dispatcher === 'all' ? 'A driver shows here when HOME is set on the Daily board.' : undefined} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-sm" data-testid="at-home">
                  <thead className="border-b border-nw-border text-left text-[13px] text-nw-text-2">
                    <tr>
                      <th className="px-3 py-2 font-medium">Driver</th>
                      <th className="px-3 py-2 font-medium">Dispatcher</th>
                      <th className="px-3 py-2 font-medium">Phone</th>
                      <th className="px-3 py-2 font-medium">Home since</th>
                      <th className="px-3 py-2 text-right font-medium">Days</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-nw-border">
                    {rows.map((r) => (
                      <tr key={r.rowId} className="hover:bg-nw-hover">
                        <td className="px-3 py-3">
                          {r.driverId ? (
                            <Link to="/drivers/$driverId" params={{ driverId: r.driverId }} className="block font-semibold text-nw-text hover:underline">
                              {r.driverName}
                            </Link>
                          ) : (
                            <span className="block font-semibold text-nw-text">{r.driverName}</span>
                          )}
                          <span className="text-xs text-nw-text-3">
                            {r.unitNumber ? `Unit ${r.unitNumber}` : 'No unit'}
                            {r.coDriver ? ` · with ${r.coDriver}` : ''}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-nw-text-2">
                          {r.dispatcherName || '—'}
                          {r.teamNumber ? <span className="block text-xs text-nw-text-3">Team {r.teamNumber}</span> : null}
                        </td>
                        <td className="px-3 py-3 text-nw-text-2 tabular-nums">{r.phone || '—'}</td>
                        <td className="px-3 py-3 tabular-nums">{formatIsoDate(r.homeSince)}</td>
                        <td className={cn('px-3 py-3 text-right font-semibold tabular-nums', r.daysHome >= 7 && 'text-nw-warning-text')}>{r.daysHome}d</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Figure({ label, value, edge }: { label: string; value: number | undefined; edge: string }) {
  return (
    <div className={cn('flex flex-col gap-1 rounded-[12px] border border-t-4 border-nw-border-strong bg-nw-panel px-4 py-3', edge)}>
      <span className="text-sm text-nw-text-2">{label}</span>
      <span className="text-[28px] leading-none font-bold text-nw-text tabular-nums">{value === undefined ? 'Loading…' : value}</span>
    </div>
  );
}
