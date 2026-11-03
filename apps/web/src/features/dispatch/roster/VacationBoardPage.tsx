import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { VACATION_RETURN_STATE_LABEL, type DriverVacationView, type VacationReturnDetail, type VacationReturnList } from '@neway/shared';
import { EmptyState, ErrorState, Input, Select, StatusSymbol, cn } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { useVacationList } from '@/features/operations/vacation-api';
import { apiGet } from '@/lib/api-client';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { BoardNav } from '../board/chrome';
import { VacationRequests } from './VacationRequests';

/**
 * Drivers on vacation (owner mockup, 2026-10-17): the list on the left, the selected driver on
 * the right - dates, days away, return readiness with the Safety review, and the related cost
 * when one is linked. Vacations are started and ended from the driver page.
 */
export function VacationBoardPage() {
  const account = useAccount();
  const seesSafety = account?.permissions.includes('safety.view') ?? false;
  const list = useVacationList();
  const safety = useQuery({ queryKey: ['safety-v2', 'vacation-returns'], queryFn: () => apiGet<VacationReturnList>('/safety/vacation-returns'), enabled: seesSafety });
  const [tab, setTab] = useState<'away' | 'returned'>('away');
  const [q, setQ] = useState('');
  const [dispatcher, setDispatcher] = useState('all');
  const [picked, setPicked] = useState<string | null>(null);
  const data = list.data;
  const source = useMemo(() => (tab === 'away' ? (data?.away ?? []) : (data?.returned ?? [])), [tab, data]);
  const dispatchers = useMemo(() => [...new Set([...(data?.away ?? []), ...(data?.returned ?? [])].map((v) => v.dispatcherName).filter((n): n is string => !!n))].sort(), [data]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return source.filter((v) => (dispatcher === 'all' || v.dispatcherName === dispatcher) && (!needle || `${v.driverName} ${v.unitNumber ?? ''}`.toLowerCase().includes(needle)));
  }, [source, q, dispatcher]);
  const selected = rows.find((v) => v.id === picked) ?? rows[0] ?? null;
  const reviewState = (id: string) => safety.data?.rows.find((r) => r.vacation.id === id)?.state ?? null;

  return (
    <div className="page-surface-workspace flex flex-col gap-5">
      <BoardNav current="/dispatch/vacations" />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-tight font-bold text-nw-text">Drivers on vacation</h1>
          <p className="mt-1 text-[15px] text-nw-text-2">Time away, return readiness and related costs.</p>
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
            <Figure label="On vacation" value={data?.counts.away} edge="border-t-nw-accent" />
            <Figure label="Returning this week" value={data?.counts.returningThisWeek} edge="border-t-nw-moving-icon" />
            <Figure label={`Away ${data?.testAfterDays ?? 30}+ days`} value={data?.counts.away30Plus} edge="border-t-nw-warning-icon" />
            <p className="text-xs text-nw-text-3 sm:col-span-3">Company rule: {data?.testAfterDays ?? 30}+ days away requires a Safety review and a drug test before the next load.</p>
          </section>

          <VacationRequests />

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            <section aria-label="Drivers" className="min-w-0 rounded-[12px] border border-nw-border-strong bg-nw-panel p-3">
              <div role="tablist" aria-label="Vacations" className="mb-2 flex gap-6 border-b border-nw-border">
                {(
                  [
                    ['away', `On vacation (${data?.away.length ?? 0})`],
                    ['returned', `Recently returned · last 30 days (${data?.returned.length ?? 0})`],
                  ] as const
                ).map(([key, label]) => (
                  <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={cn('-mb-px border-b-2 pb-2 text-sm font-semibold', tab === key ? 'border-nw-accent text-nw-accent-ink' : 'border-transparent text-nw-text-2 hover:text-nw-text')}>
                    {label}
                  </button>
                ))}
              </div>
              {list.isPending ? (
                <p className="text-sm text-nw-text-3">Loading…</p>
              ) : rows.length === 0 ? (
                <EmptyState title={q || dispatcher !== 'all' ? 'No driver matches' : tab === 'away' ? 'No drivers on vacation' : 'Nobody came back in the last 30 days'} description={tab === 'away' && !q ? 'A driver goes on vacation from their driver page, or when VACATION is set on the Daily board.' : undefined} />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] border-collapse text-sm" data-testid={tab === 'away' ? 'vacation-away' : 'vacation-returned'}>
                    <thead className="border-b border-nw-border text-left text-[13px] text-nw-text-2">
                      <tr>
                        <th className="px-3 py-2 font-medium">Driver</th>
                        <th className="px-3 py-2 font-medium">Dispatcher</th>
                        <th className="px-3 py-2 font-medium">Away since</th>
                        <th className="px-3 py-2 font-medium">{tab === 'away' ? 'Return' : 'Returned'}</th>
                        <th className="px-3 py-2 text-right font-medium">Days</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-nw-border">
                      {rows.map((v) => {
                        const on = selected?.id === v.id;
                        return (
                          <tr
                            key={v.id}
                            tabIndex={0}
                            aria-selected={on}
                            onClick={() => setPicked(v.id)}
                            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setPicked(v.id))}
                            className={cn('cursor-pointer outline-none focus-visible:bg-nw-hover', on ? 'bg-nw-accent-tint' : 'hover:bg-nw-hover')}
                          >
                            <td className="px-3 py-3">
                              <span className="block font-semibold text-nw-text">{v.driverName}</span>
                              <span className="text-xs text-nw-text-3">{v.unitNumber ? `Unit ${v.unitNumber}` : 'No unit'}</span>
                            </td>
                            <td className="px-3 py-3 text-nw-text-2">{v.dispatcherName ?? '—'}</td>
                            <td className="px-3 py-3 tabular-nums">{formatIsoDate(v.startedOn)}</td>
                            <td className="px-3 py-3 tabular-nums">{tab === 'away' ? (v.expectedReturnOn ? formatIsoDate(v.expectedReturnOn) : <span className="text-nw-text-3">Not set</span>) : v.endedOn ? formatIsoDate(v.endedOn) : '—'}</td>
                            <td className="px-3 py-3 text-right font-semibold tabular-nums">{v.daysAway}d</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            {selected ? (
              <section aria-label="Selected driver" className="min-w-0 rounded-[12px] border border-l-4 border-nw-border-strong border-l-nw-accent bg-nw-panel p-4">
                <DriverPanel v={selected} seesSafety={seesSafety} state={reviewState(selected.id)} testAfterDays={data?.testAfterDays ?? 30} />
              </section>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

// A coloured edge per figure (owner, 2026-10-17: borders easier to see, with colour).
function Figure({ label, value, edge }: { label: string; value: number | undefined; edge: string }) {
  return (
    <div className={cn('flex flex-col gap-1 rounded-[12px] border border-t-4 border-nw-border-strong bg-nw-panel px-4 py-3', edge)}>
      <span className="text-sm text-nw-text-2">{label}</span>
      <span className="text-[28px] leading-none font-bold text-nw-text tabular-nums">{value === undefined ? 'Loading…' : value}</span>
    </div>
  );
}

function DriverPanel({ v, seesSafety, state, testAfterDays }: { v: DriverVacationView; seesSafety: boolean; state: keyof typeof VACATION_RETURN_STATE_LABEL | null; testAfterDays: number }) {
  // The cost lives on the Safety review; read it only when a review exists and the viewer may see Safety.
  const detail = useQuery({
    queryKey: ['safety-v2', 'vacation-returns', v.id],
    queryFn: () => apiGet<VacationReturnDetail>(`/safety/vacation-returns/${encodeURIComponent(v.id)}`),
    enabled: seesSafety && v.drugTestRequired,
  });
  return (
    <div className="flex flex-col gap-4" data-testid="vacation-driver-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-nw-text">{v.driverName}</h2>
          <p className="text-sm text-nw-text-2">
            {v.unitNumber ? `Unit ${v.unitNumber}` : 'No unit'} · {v.dispatcherName ?? 'No dispatcher'}
          </p>
        </div>
        <Link to="/drivers/$driverId" params={{ driverId: v.driverId }} className="inline-flex items-center gap-1 text-sm font-semibold text-nw-accent-ink hover:underline">
          View driver <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
      <dl className="grid grid-cols-3 gap-3 border-y border-nw-border py-3 text-sm">
        <div><dt className="text-nw-text-2">Away since</dt><dd className="font-semibold">{formatIsoDate(v.startedOn)}</dd></div>
        <div><dt className="text-nw-text-2">{v.endedOn ? 'Returned' : 'Expected return'}</dt><dd className="font-semibold">{v.endedOn ? formatIsoDate(v.endedOn) : v.expectedReturnOn ? formatIsoDate(v.expectedReturnOn) : 'Not set'}</dd></div>
        <div><dt className="text-nw-text-2">Days away</dt><dd className="font-semibold tabular-nums">{v.daysAway}</dd></div>
      </dl>
      <section>
        <h3 className="mb-1.5 text-base font-bold text-nw-text">Return readiness</h3>
        {v.drugTestRequired ? (
          <>
            <p className="flex items-center gap-2 font-semibold text-nw-warning-text">
              <StatusSymbol family="warning" size={16} className="text-nw-warning-icon" /> Drug test required
            </p>
            <dl className="mt-2 grid grid-cols-[120px_minmax(0,1fr)] gap-y-1 text-sm">
              <dt className="text-nw-text-2">Safety review</dt>
              <dd>{seesSafety ? (state ? VACATION_RETURN_STATE_LABEL[state] : 'Loading…') : 'Visible to Safety'}</dd>
              <dt className="text-nw-text-2">Next load</dt>
              <dd>{state === 'cleared' ? 'Cleared by Safety' : 'Not cleared'}</dd>
            </dl>
            {seesSafety ? (
              <Link to="/safety/vacation-returns" search={{ vacation: v.id } as never} className="mt-2 inline-flex items-center gap-1 rounded-md border border-nw-border px-3 py-1.5 text-sm font-semibold text-nw-text hover:bg-nw-hover">
                Open Safety review <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            ) : null}
          </>
        ) : (
          <p className="flex items-center gap-2 text-sm text-nw-text-2">
            <StatusSymbol family="done" size={14} className="text-nw-done-icon" /> Under {testAfterDays} days away: no vacation-return test by company policy.
          </p>
        )}
      </section>
      <section>
        <h3 className="mb-1.5 text-base font-bold text-nw-text">Related costs</h3>
        {detail.data?.expense ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-nw-border px-3 py-2 text-sm">
            <span>
              {detail.data.expense.description || detail.data.expense.expenseNumber}
              <span className="block text-xs text-nw-text-3 capitalize">{detail.data.expense.expenseNumber} · {detail.data.expense.status}</span>
            </span>
            <span className="font-semibold tabular-nums">{formatMoney(detail.data.expense.amountCents / 100)}</span>
          </div>
        ) : detail.data?.expenseRestricted ? (
          <p className="text-sm text-nw-text-3">A cost is linked; seeing it needs Accounting access.</p>
        ) : (
          <p className="text-sm text-nw-text-3">No linked expenses.</p>
        )}
        {detail.data?.expense ? (
          <Link to="/accounting/expenses" search={{ q: detail.data.expense.expenseNumber, fp: 'year' } as never} className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-nw-accent-ink hover:underline">
            View linked expense in Accounting <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        ) : null}
        <p className="mt-1 text-xs text-nw-text-3">Costs follow the existing payer and approval rules. Vacations are managed from the driver profile.</p>
      </section>
    </div>
  );
}
