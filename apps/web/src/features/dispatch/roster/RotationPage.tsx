import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, CalendarDays, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { DispatcherRotationReport, DispatcherRotationRow, RotationEvent } from '@neway/shared';
import { EmptyState, ErrorState, Input, cn } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet } from '@/lib/api-client';
import { today } from '@/lib/clock';
import { formatIsoDate } from '@/lib/format';
import { BoardNav } from '../board/chrome';

/**
 * Dispatcher rotation (owner mockup, 2026-10-16): the teams on the left, the selected
 * dispatcher's moves on the right. Administrators and dispatch leads only (dispatch.manage).
 * Rotation = drivers who left ÷ drivers on the team at the start; the totals use the summed
 * counts, never an average of percentages. Read from the board's assignment history.
 */
export function RotationPage() {
  const account = useAccount();
  const canManage = account?.permissions.includes('dispatch.manage') ?? false;
  const now = today();
  const daysAgo = (n: number) => new Date(Date.parse(`${now}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  const presets = [
    { key: 'month', label: 'This month', f: `${now.slice(0, 7)}-01`, t: now },
    { key: '30', label: '30 days', f: daysAgo(30), t: now },
    { key: '90', label: '90 days', f: daysAgo(90), t: now },
    { key: 'year', label: 'This year', f: `${now.slice(0, 4)}-01-01`, t: now },
  ];
  const [from, setFrom] = useState(presets[0]!.f);
  const [to, setTo] = useState(now);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const report = useQuery({
    queryKey: ['dispatch', 'rotation', from, to],
    queryFn: () => apiGet<DispatcherRotationReport>('/dispatch/rotation', { from, to }),
    enabled: canManage && valid,
  });

  const rows = useMemo(() => report.data?.rows ?? [], [report.data]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? rows.filter((r) => `${r.dispatcherName} ${r.dispatcherNickname ?? ''}`.toLowerCase().includes(needle)) : rows;
  }, [rows, q]);
  const total = useMemo(
    () => rows.reduce((t, r) => ({ atStart: t.atStart + r.atStart, joined: t.joined + r.joined, left: t.left + r.left, atEnd: t.atEnd + r.atEnd }), { atStart: 0, joined: 0, left: 0, atEnd: 0 }),
    [rows],
  );
  const selected = shown.find((r) => r.dispatcherId === picked) ?? shown[0] ?? null;

  if (!canManage) {
    return (
      <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
        <BoardNav current="/dispatch/rotation" />
        <EmptyState title="Administrators and dispatch leads only" description="Dispatcher rotation takes the dispatch.manage permission." />
      </div>
    );
  }

  return (
    <div className="page-surface-workspace flex flex-col gap-6">
      <BoardNav current="/dispatch/rotation" />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-tight font-bold text-nw-text">Dispatcher rotation</h1>
          <p className="mt-1 text-[15px] text-nw-text-2">Track driver movement and team changes.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-10 items-center gap-2 rounded-[10px] border border-nw-border bg-nw-panel px-3 text-sm">
            <CalendarDays className="size-4 text-nw-text-3" aria-hidden />
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" className="bg-transparent text-nw-text outline-none" />
            <span className="text-nw-text-3">–</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" className="bg-transparent text-nw-text outline-none" />
          </div>
          <div role="group" aria-label="Period" className="flex h-10 overflow-hidden rounded-[10px] border border-nw-border">
            {presets.map((p) => {
              const on = from === p.f && to === p.t;
              return (
                <button
                  key={p.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    setFrom(p.f);
                    setTo(p.t);
                  }}
                  className={cn('px-3 text-[13px] font-semibold', on ? 'bg-nw-accent text-nw-on-accent' : 'bg-nw-panel text-nw-text-2 hover:bg-nw-hover')}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {!valid ? (
        <EmptyState title="Pick a period" description="The start date has to be on or before the end date." />
      ) : report.isError ? (
        <ErrorState onRetry={() => void report.refetch()} />
      ) : (
        <>
          <section aria-label="Summary" className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="rotation-summary">
            <Figure label="Starting drivers" value={report.isPending ? null : total.atStart} edge="border-t-nw-moving-icon" />
            <Figure label="Joined" value={report.isPending ? null : total.joined} sign="+" tone="text-nw-accent-ink" edge="border-t-nw-accent" />
            <Figure label="Left" value={report.isPending ? null : total.left} edge="border-t-nw-urgent-icon" />
            <Figure label="Drivers at period end" value={report.isPending ? null : total.atEnd} edge="border-t-nw-done-icon" />
          </section>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <section aria-label="Dispatch teams" className="min-w-0">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl font-bold text-nw-text">Dispatch teams</h2>
                <Input size="sm" prefix={<Search />} placeholder="Search dispatcher…" aria-label="Search dispatcher" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
              </div>
              {report.isPending ? (
                <p className="text-sm text-nw-text-3">Loading…</p>
              ) : shown.length === 0 ? (
                <EmptyState title={q ? 'No dispatcher matches' : 'No dispatcher teams in this period'} />
              ) : (
                <div className="overflow-x-auto rounded-[12px] border border-nw-border-strong bg-nw-panel">
                  <table className="w-full min-w-[560px] border-collapse text-sm" data-testid="rotation-table">
                    <thead className="border-b border-nw-border bg-nw-subtle text-left text-[13px] text-nw-text-2">
                      <tr>
                        <th className="px-4 py-2.5 font-medium">Dispatcher</th>
                        <th className="px-3 py-2.5 text-center font-medium">Start</th>
                        <th className="px-3 py-2.5 text-center font-medium">Joined</th>
                        <th className="px-3 py-2.5 text-center font-medium">Left</th>
                        <th className="px-3 py-2.5 text-center font-medium">At end</th>
                        <th className="px-3 py-2.5 text-center font-medium">Rotation</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-nw-border">
                      {shown.map((r) => {
                        const on = selected?.dispatcherId === r.dispatcherId;
                        return (
                          <tr
                            key={r.dispatcherId}
                            tabIndex={0}
                            aria-selected={on}
                            onClick={() => setPicked(r.dispatcherId)}
                            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setPicked(r.dispatcherId))}
                            className={cn('cursor-pointer outline-none focus-visible:bg-nw-hover', on ? 'bg-nw-accent-tint shadow-[inset_3px_0_0_var(--nw-accent)]' : 'hover:bg-nw-hover')}
                          >
                            <td className="px-4 py-3 font-semibold text-nw-text" title={r.dispatcherNickname ? (r.dispatcherFullName ?? r.dispatcherName) : undefined}>{r.dispatcherNickname || r.dispatcherName}</td>
                            <td className="px-3 py-3 text-center tabular-nums">{r.atStart}</td>
                            <td className="px-3 py-3 text-center font-semibold tabular-nums text-nw-accent-ink">{r.joined > 0 ? `+${r.joined}` : 0}</td>
                            <td className="px-3 py-3 text-center tabular-nums text-nw-text-2">{r.left}</td>
                            <td className="px-3 py-3 text-center tabular-nums">{r.atEnd}</td>
                            <td className="px-3 py-3 text-center tabular-nums">{pct(r.left, r.atStart)}</td>
                          </tr>
                        );
                      })}
                      <tr className="bg-nw-subtle font-bold">
                        <td className="px-4 py-3 text-nw-text">Total</td>
                        <td className="px-3 py-3 text-center tabular-nums">{total.atStart}</td>
                        <td className="px-3 py-3 text-center tabular-nums text-nw-accent-ink">{total.joined > 0 ? `+${total.joined}` : 0}</td>
                        <td className="px-3 py-3 text-center tabular-nums">{total.left}</td>
                        <td className="px-3 py-3 text-center tabular-nums">{total.atEnd}</td>
                        <td className="px-3 py-3 text-center tabular-nums">{pct(total.left, total.atStart)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-3 text-[13px] text-nw-text-3">Rotation = drivers who left ÷ drivers at start. A dash means no drivers at period start.</p>
            </section>

            <section aria-label="Selected dispatcher" className="min-w-0 rounded-[12px] border border-l-4 border-nw-border-strong border-l-nw-accent bg-nw-panel p-4">
              {selected ? <DispatcherDetail row={selected} key={selected.dispatcherId} /> : report.isPending ? null : <p className="text-sm text-nw-text-3">Pick a dispatcher to see their changes.</p>}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function pct(left: number, atStart: number): string {
  return atStart > 0 ? `${Math.round((left / atStart) * 1000) / 10}%` : '—';
}

function Figure({ label, value, sign = '', tone = 'text-nw-text', edge }: { label: string; value: number | null; sign?: string; tone?: string; edge: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-1 rounded-[12px] border border-t-4 border-nw-border-strong bg-nw-panel px-3 py-3', edge)}>
      <span className="text-sm text-nw-text-2">{label}</span>
      <span className={cn('text-[30px] leading-none font-bold tabular-nums', tone)}>{value === null ? 'Loading…' : `${value > 0 ? sign : ''}${value}`}</span>
    </div>
  );
}

function DispatcherDetail({ row }: { row: DispatcherRotationRow }) {
  const [filter, setFilter] = useState<'all' | 'joined' | 'left'>('all');
  const events = filter === 'all' ? row.events : row.events.filter((e) => e.kind === filter);
  const tabs = [
    { key: 'all' as const, label: `All changes (${row.events.length})` },
    { key: 'joined' as const, label: `Joined (${row.joined})` },
    { key: 'left' as const, label: `Left (${row.left})` },
  ];
  return (
    <div className="flex flex-col gap-4" data-testid="rotation-detail">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-2xl font-bold text-nw-text" title={row.dispatcherNickname ? (row.dispatcherFullName ?? row.dispatcherName) : undefined}>{row.dispatcherNickname || row.dispatcherName}</h2>
          <p className="text-sm text-nw-text-2">Driver movement · Selected period</p>
        </div>
        <div className="flex shrink-0 gap-5 text-center">
          <span>
            <span className="block text-2xl font-bold text-nw-accent-ink tabular-nums">{row.joined > 0 ? `+${row.joined}` : 0}</span>
            <span className="text-xs text-nw-text-2">joined</span>
          </span>
          <span className="border-l border-nw-border pl-5">
            <span className="block text-2xl font-bold text-nw-text tabular-nums">{row.left}</span>
            <span className="text-xs text-nw-text-2">left</span>
          </span>
        </div>
      </div>
      <div role="tablist" aria-label="Changes" className="flex gap-6 border-b border-nw-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={filter === t.key}
            onClick={() => setFilter(t.key)}
            className={cn('-mb-px border-b-2 pb-2 text-sm font-semibold', filter === t.key ? 'border-nw-accent text-nw-accent-ink' : 'border-transparent text-nw-text-2 hover:text-nw-text')}
          >
            {t.label}
          </button>
        ))}
      </div>
      {events.length === 0 ? (
        <p className="py-4 text-sm text-nw-text-3">No change of this kind in the period.</p>
      ) : (
        <ul className="divide-y divide-nw-border" data-testid="rotation-events">
          {events.map((e, i) => (
            <EventRow key={`${e.rosterId}-${e.at}-${e.kind}-${i}`} event={e} />
          ))}
        </ul>
      )}
      <div className="flex items-center justify-center gap-10 border-t border-nw-border pt-4 text-center">
        <span>
          <span className="block text-sm text-nw-text-2">Starting</span>
          <span className="text-2xl font-bold tabular-nums">{row.atStart}</span>
        </span>
        <ArrowRight className="size-5 text-nw-text-3" aria-hidden />
        <span>
          <span className="block text-sm text-nw-text-2">At end</span>
          <span className="text-2xl font-bold tabular-nums">{row.atEnd}</span>
        </span>
      </div>
    </div>
  );
}

function EventRow({ event: e }: { event: RotationEvent }) {
  const initials = e.driverName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
  const where = e.kind === 'joined' ? (e.otherDispatcher ? `from ${e.otherDispatcher}` : 'new to the board') : e.otherDispatcher ? `to ${e.otherDispatcher}` : 'off the board';
  return (
    <li className="flex items-start gap-3 py-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-nw-subtle text-sm font-semibold text-nw-text-2" aria-hidden>
        {initials}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-nw-text">{e.driverName}</p>
        <p className={cn('text-sm font-semibold', e.kind === 'joined' ? 'text-nw-accent-ink' : 'text-nw-urgent-text')}>
          {e.kind === 'joined' ? 'Joined' : 'Left'} <span className="font-normal text-nw-text-2">{where}</span>
        </p>
        <p className="text-sm text-nw-text-2">{e.reason ?? 'No reason recorded'}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-sm text-nw-text-2 tabular-nums">{formatIsoDate(e.at)}</span>
        {e.driverId ? (
          <Link to="/drivers/$driverId" params={{ driverId: e.driverId }} className="inline-flex items-center gap-1 text-sm font-semibold text-nw-accent-ink hover:underline">
            View driver <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>
    </li>
  );
}
