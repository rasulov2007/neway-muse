import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft, Download, Search, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { addDays, statusDef, weekStartMonday } from '@neway/shared';
import { Button, ErrorState, Input, cn } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { today as companyToday } from '@/lib/clock';
import { formatIsoDate } from '@/lib/format';
import { useWeeklyBoard } from './api';
import { AccessPill, BoardBar, WeekPicker } from './chrome';
import { GRID, STATUS_CELL, money, moneyShort } from './sheet';
import { weeklyBoardSearchSchema } from './search';

const DAY_NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const CELL = 'border-r border-b border-(--bd-border) px-2 text-center align-middle';

/** CD = company driver, LO = lease operator, OO = owner operator (owner, 2026-10-19). */
function driverKind(type: string): string {
  return type === 'lease_operator' ? 'LO' : type === 'owner_operator' ? 'OO' : 'CD';
}

/**
 * The Weekly Report: the same week the other way - biggest week first, each day painted its
 * status colour with the amount and the miles inside it, the total with its shortfall, and a
 * Target column that flags every truck under its weekly goal ($10k solo / $16k team) for a
 * dispatcher review. It reads the board's own query, so the two can never disagree.
 */
export function WeeklyReportPage() {
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => weeklyBoardSearchSchema.parse(rawSearch), [rawSearch]);
  const week = weekStartMonday(search.week ?? companyToday());
  const board = useWeeklyBoard(week);
  const [q, setQ] = useState('');
  const account = useAccount();
  // A report: Accounting reads it with dispatch_pay.view; the pill says Admin only for pay editors.
  const canManage = account?.permissions.includes('dispatch_pay.edit') ?? false;
  const setWeek = (next: string) => void navigate({ to: '/dispatch/weekly/report', search: { week: next }, replace: true });

  const needle = q.trim().toLowerCase();
  const rows = useMemo(
    () =>
      (board.data?.rows ?? [])
        .filter((r) => !needle || [r.driverName, r.coDriver ?? '', r.truckUnit ?? '', r.dispatcherName].join(' ').toLowerCase().includes(needle))
        .sort((a, b) => b.total - a.total),
    [board.data, needle],
  );
  const days = board.data?.days ?? [];
  const dayTotals = days.map((_, i) => rows.reduce((s, r) => s + (r.days[i]?.amount ?? 0), 0));
  const total = rows.reduce((s, r) => s + r.total, 0);
  const miles = rows.reduce((s, r) => s + r.miles, 0);
  const short = rows.filter((r) => r.total < r.goal).length;

  const exportCsv = () => {
    const head = ['#', 'Driver', 'Truck', ...days.flatMap((d, i) => [`${DAY_NAMES[i]} ${d} $`, `${DAY_NAMES[i]} mi`, `${DAY_NAMES[i]} status`]), 'Total', 'Miles', 'RPM', 'Days', 'CD/LO', 'Note', 'Dispatcher', 'Goal', 'Short by', 'Target'];
    const lines = rows.map((r, i) => [
      i + 1,
      r.coDriver ? `${r.driverName} // ${r.coDriver}` : r.driverName,
      r.truckUnit ?? '',
      ...r.days.flatMap((d) => [d.amount.toFixed(2), d.miles, d.statusWord ?? '']),
      r.total.toFixed(2),
      r.miles,
      r.rpm?.toFixed(2) ?? '',
      r.daysWorked,
      driverKind(r.driverType),
      r.weekComment?.value ?? '',
      r.dispatcherName,
      r.goal,
      r.total < r.goal ? (r.goal - r.total).toFixed(2) : '',
      r.total < r.goal ? 'BELOW TARGET - review dispatcher' : 'Reached',
    ]);
    const csv = [head, ...lines].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `weekly-report-${week}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="flex flex-col gap-2">
      <BoardBar current="/dispatch/weekly/report"
        title="Weekly Report"
        meta={
          <>
            {formatIsoDate(week)} – {formatIsoDate(addDays(week, 6))} · what each driver earned, day by day · biggest week first ·{' '}
            <span className="text-(--bd-red)">red = short of the weekly goal</span>
            {board.data ? ` · ${short} of ${rows.length} below target` : ''}
          </>
        }
      >
        <AccessPill canWrite={canManage} canManage={canManage} />
        <Button variant="secondary" size="sm" icon={<ArrowLeft />} asChild>
          <Link to="/dispatch/weekly" search={{ week }}>
            Board
          </Link>
        </Button>
        <WeekPicker week={week} onChange={setWeek} />
        <Button variant="secondary" size="sm" icon={<Download />} onClick={exportCsv} disabled={!board.data}>
          CSV
        </Button>
      </BoardBar>
      <Input size="sm" type="search" prefix={<Search />} aria-label="Search driver, truck or dispatcher" placeholder="Search driver, truck or dispatcher…" value={q} onChange={(e) => setQ(e.target.value)} className="w-80" />

      {board.isError ? (
        <ErrorState error={board.error} onRetry={() => void board.refetch()} />
      ) : (
        <div className={GRID.frame} style={{ maxHeight: 'calc(100vh - 190px)', outline: 'none' }}>
          <table className="nw-board w-full min-w-[1760px] table-fixed border-collapse">
            <colgroup>
              <col className="w-10" />
              <col className="w-64" />
              <col className="w-20" />
              {days.map((d) => (
                <col key={d} className="w-28" />
              ))}
              <col className="w-28" />
              <col className="w-20" />
              <col className="w-18" />
              <col className="w-16" />
              <col className="w-16" />
              <col className="w-48" />
              <col className="w-40" />
              <col className="w-52" />
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr>
                <th className={cn(GRID.headNavy, 'h-12')}>#</th>
                <th className={cn(GRID.headNavy, 'h-12')}>Driver name</th>
                <th className={cn(GRID.headNavy, 'h-12')}>Truck #</th>
                {days.map((d, i) => (
                  <th key={d} className={cn(GRID.headNavy, 'h-12 leading-tight')}>
                    <span className="block">{DAY_NAMES[i]}</span>
                    <span className="block text-[10.5px] font-semibold opacity-75">{d.slice(5).replace('-', '/')}</span>
                  </th>
                ))}
                <th className={cn(GRID.headNavy, 'h-12')}>Total</th>
                <th className={cn(GRID.headNavy, 'h-12')}>Mi</th>
                <th className={cn(GRID.headNavy, 'h-12')}>RPM</th>
                <th className={cn(GRID.headNavy, 'h-12')}>Days</th>
                <th className={cn(GRID.headNavy, 'h-12')}>CD / LO</th>
                <th className={cn(GRID.headNavy, 'h-12')}>Note</th>
                <th className={cn(GRID.headNavy, 'h-12')}>Dispatcher</th>
                <th className={cn(GRID.headNavy, 'h-12 border-r-0')}>Target</th>
              </tr>
            </thead>
            <tbody>
              {board.isPending ? (
                <tr>
                  <td colSpan={18} className="px-4 py-10 text-center text-sm text-nw-text-3">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={18} className="px-4 py-10 text-center text-sm text-nw-text-3">
                    No drivers match.
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => {
                  const isShort = r.total < r.goal;
                  return (
                    <tr key={r.driverId} className="h-[53px] bg-nw-panel">
                      <td className={cn(CELL, 'tabular text-[12px] font-semibold text-(--bd-blue)')}>{i + 1}</td>
                      <td className={cn(CELL, 'text-left text-[13px] font-bold', isShort ? 'text-(--bd-red)' : 'text-nw-text')}>
                        {r.driverName}
                        {r.coDriver ? ` // ${r.coDriver}` : ''}
                      </td>
                      <td className={cn(CELL, 'tabular text-[13px] text-nw-text')}>{r.truckUnit ?? '—'}</td>
                      {r.days.map((d) => {
                        const def = d.statusWord ? statusDef(d.statusWord) : null;
                        if (def)
                          return (
                            <td key={d.day} className={cn(CELL, 'text-[11px] font-extrabold uppercase', STATUS_CELL[def.code])}>
                              <span className="block">{def.code}</span>
                              <span className="block text-[11px] font-semibold opacity-80">{d.amount ? money(d.amount) : '—'}</span>
                            </td>
                          );
                        return (
                          <td key={d.day} className={cn(CELL, 'tabular')}>
                            {d.amount ? (
                              <>
                                <span className="block text-[13px] font-bold text-nw-text">{money(d.amount)}</span>
                                <span className="block text-[11px] text-nw-text-3">{d.miles ? `${d.miles.toLocaleString('en-US')} mi` : ''}</span>
                              </>
                            ) : (
                              <span className="text-nw-text-3">—</span>
                            )}
                          </td>
                        );
                      })}
                      <td className={cn(CELL, 'tabular', isShort ? 'bg-(--bd-red-bg) text-(--bd-red)' : 'bg-(--bd-green-bg) text-(--bd-green-text)')}>
                        <span className="block text-[13px] font-bold">{money(r.total)}</span>
                        {isShort ? <span className="block text-[11px] font-semibold">-{money(r.goal - r.total)}</span> : null}
                      </td>
                      <td className={cn(CELL, 'tabular text-[13px] text-nw-text')}>{r.miles.toLocaleString('en-US')}</td>
                      <td className={cn(CELL, 'tabular text-[13px] text-nw-text')}>{r.rpm ? `$${r.rpm.toFixed(2)}` : '—'}</td>
                      <td className={cn(CELL, 'tabular text-[13px] text-nw-text')}>{r.daysWorked}</td>
                      <td className={cn(CELL, 'text-[12.5px] font-bold text-nw-text')} title={r.driverType.replace(/_/g, ' ')}>
                        {driverKind(r.driverType)}
                      </td>
                      {/* The week's Comment from the Weekly board, typed there (owner, 2026-10-19). */}
                      <td className={cn(CELL, 'text-left text-[12px] text-nw-text-2')} title={r.weekComment?.value ?? undefined}>
                        <span className="line-clamp-2">{r.weekComment?.value || '—'}</span>
                      </td>
                      <td className={cn(CELL, 'text-[12.5px] font-semibold text-nw-text uppercase')} title={r.dispatcherNickname ? (r.dispatcherFullName ?? r.dispatcherName) : undefined}>{r.dispatcherNickname || r.dispatcherName || '—'}</td>
                      <td className={cn(CELL, 'border-r-0 text-left')}>
                        {isShort ? (
                          <span className="inline-flex items-center gap-1.5 rounded-md bg-(--bd-red-bg) px-2 py-1 text-[11.5px] font-bold text-(--bd-red-text)" title={`Weekly goal ${money(r.goal)} (${r.unit}) · short by ${money(r.goal - r.total)}`}>
                            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                            <span>
                              Below {moneyShort(r.goal)} target
                              <span className="block font-semibold opacity-80">Needs a dispatcher change</span>
                            </span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-md bg-(--bd-green-bg) px-2 py-1 text-[11.5px] font-bold text-(--bd-green-text)">Target reached · {moneyShort(r.goal)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
            {board.data ? (
              <tfoot>
                <tr className={GRID.grand}>
                  <td className={cn(GRID.grandCell, 'text-left')} colSpan={3}>
                    Total · {rows.length} drivers · {short} below target
                  </td>
                  {dayTotals.map((t, i) => (
                    <td key={i} className={GRID.grandCell}>
                      {money(t)}
                    </td>
                  ))}
                  <td className={GRID.grandCell}>{money(total)}</td>
                  <td className={GRID.grandCell}>{miles.toLocaleString('en-US')}</td>
                  <td className={GRID.grandCell}>{miles > 0 ? `$${(total / miles).toFixed(2)}` : '—'}</td>
                  <td className={cn(GRID.grandCell, 'border-r-0')} colSpan={5} />
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      )}
    </div>
  );
}
