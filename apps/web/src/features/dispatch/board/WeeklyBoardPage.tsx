import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ChevronDown, FileText, Plus, RefreshCw, Search, TrendingDown, TrendingUp, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WEEK_COMMENT_COLUMN, WEEK_NAME_FILL_COLUMN, statusDef, weekStartMonday, type RosterRow, type WeeklyBoardRow, type WeeklyColumn } from '@neway/shared';
import { Button, ErrorState, Input, cn, useToast } from '@/design-system';
import { today as companyToday } from '@/lib/clock';
import { formatIsoDate } from '@/lib/format';
import { useWeeklyBoard, useWriteCells, useWriteFills } from './api';
import { AccessPill, BoardBar, EffPill, SaveIndicator, UndoBar, WeekPicker } from './chrome';
import { CommissionCell } from './CommissionCell';
import { FillPalette } from './FillPalette';
import { HistoryPopup } from './HistoryPopup';
import { AddDriverDialog, EditDriverDialog } from './RosterDialogs';
import { GRID, STATUS_CELL, TINT_CLASS, cents, moneyCell } from './sheet';
import { SheetCell } from './SheetCell';
import { useCollapsedTeams } from './collapsed';
import { copyText, useSheet, type CellInfo, type SheetWrite } from './useSheet';
import { weeklyBoardSearchSchema } from './search';

const SUBROWS = ['amount', 'wk_miles', 'rpm', 'wk_load'] as const;
type Sub = (typeof SUBROWS)[number];
const SUB_LABEL: Record<Sub, string> = { amount: 'Amount', wk_miles: 'Miles', rpm: 'RPM', wk_load: 'Load #' };

/** A day with more than one load: each load's money and miles, and the sum (owner, 2026-10-19). */
function loadBreakdown(loads: { loadNumber: string; amount: number; miles: number }[]): string {
  const lines = loads.map((l) => `${l.loadNumber}: ${moneyCell(l.amount)} · ${l.miles.toLocaleString('en-US')} mi`);
  const total = loads.reduce((s, l) => s + l.amount, 0);
  const miles = loads.reduce((s, l) => s + l.miles, 0);
  return [...lines, `Total: ${moneyCell(total)} · ${miles.toLocaleString('en-US')} mi`].join('\n');
}
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/**
 * The sheet column key of the Comment cell (after Commission). It is one cell per driver per week,
 * drawn once across the driver's four rows; any of those rows reads and writes the same comment.
 */
const COMMENT = 'comment';

function rowKey(driverId: string, sub: Sub): string {
  return `${driverId}|${sub}`;
}
function splitKey(key: string): { driverId: string; sub: Sub } {
  const i = key.lastIndexOf('|');
  return { driverId: key.slice(0, i), sub: key.slice(i + 1) as Sub };
}

/**
 * The Weekly Production Board (owner's brief §6): four stacked rows per driver - Amount, Miles,
 * RPM, Load # - across the seven days; the driver and summary cells span the block; a continuous
 * line closes every block; team bands with day totals, gross, miles, weighted RPM, average per
 * truck, efficiency and the team's commission; the grand total pinned under the header.
 */
export function WeeklyBoardPage() {
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => weeklyBoardSearchSchema.parse(rawSearch), [rawSearch]);
  const week = weekStartMonday(search.week ?? companyToday());
  const { toast } = useToast();
  const board = useWeeklyBoard(week);
  const writeCells = useWriteCells();
  const writeFills = useWriteFills();
  const [q, setQ] = useState('');
  // Folded bands stay folded between visits, per person, company and page (owner, 2026-10-26).
  const { collapsed, toggle: toggleTeam } = useCollapsedTeams('/dispatch/weekly');
  const [history, setHistory] = useState<{ id: string; name: string } | null>(null);
  const [adding, setAdding] = useState<{ id: string; name: string } | null | false>(false);
  const [editing, setEditing] = useState<RosterRow | null>(null);

  const setWeek = (next: string) => void navigate({ to: '/dispatch/weekly', search: { week: next }, replace: true });

  const needle = q.trim().toLowerCase();
  const allRows = useMemo(() => board.data?.rows ?? [], [board.data]);
  const visible = useMemo(
    () =>
      allRows.filter(
        (r) =>
          !needle ||
          [r.driverName, r.coDriver ?? '', r.payTag ?? '', r.driverNumber, r.truckUnit ?? '', r.dispatcherName, r.dispatcherNickname ?? '', r.comment, r.weekComment?.value ?? '', ...r.days.flatMap((d) => [...d.loadNumbers, ...(d.loadLabels ?? []), d.loadCell?.value ?? '', d.statusWord ?? '', String(d.amount)])]
            .join(' ')
            .toLowerCase()
            .includes(needle),
      ),
    [allRows, needle],
  );
  const filtered = needle.length > 0;
  const teams = useMemo(() => {
    const map = new Map<string, WeeklyBoardRow[]>();
    for (const r of visible) map.set(r.dispatcherId, [...(map.get(r.dispatcherId) ?? []), r]);
    const list = [...map.entries()].map(([id, rows]) => ({ id, rows, meta: board.data?.teams.find((t) => t.dispatcherId === id) ?? null }));
    // Drivers with no dispatcher this week (Unassign, owner 2026-10-26) sit in their own group, last.
    return [...list.filter((t) => t.id !== ''), ...list.filter((t) => t.id === '')];
  }, [visible, board.data]);
  const rowsById = useMemo(() => new Map(visible.map((r) => [r.driverId, r])), [visible]);
  const sheetRows = useMemo(() => teams.flatMap((t) => (collapsed.has(t.id) ? [] : t.rows.flatMap((r) => SUBROWS.map((s) => rowKey(r.driverId, s))))), [teams, collapsed]);
  const days = useMemo(() => board.data?.days ?? [], [board.data]);

  const read = useCallback(
    (r: string, c: string): CellInfo => {
      const { driverId, sub } = splitKey(r);
      const row = rowsById.get(driverId);
      if (c === COMMENT) {
        const cell = row?.weekComment ?? null;
        if (!row) return { text: '', editable: false, clearable: false, typed: false, version: null };
        return { text: cell?.value ?? '', editable: Boolean(board.data?.canWrite), clearable: Boolean(cell), typed: Boolean(cell), version: cell?.version ?? null };
      }
      const day = row?.days.find((d) => d.day === c);
      if (!row || !day) return { text: '', editable: false, clearable: false, typed: false, version: null };
      if (sub === 'rpm') return { text: day.miles > 0 ? (day.amount / day.miles).toFixed(2) : '', editable: false, clearable: false, typed: false, version: null };
      const cell = sub === 'amount' ? day.amountCell : sub === 'wk_miles' ? day.milesCell : day.loadCell;
      const text = cell
        ? (cell.formula ?? cell.value ?? '')
        : sub === 'amount'
          ? day.loads.length > 1
            ? `=${day.loads.map((l) => l.amount).join('+')}`
            : day.autoAmount
              ? String(day.autoAmount)
              : ''
          : sub === 'wk_miles'
            ? day.loads.length > 1
              ? `=${day.loads.map((l) => l.miles).join('+')}`
              : day.autoMiles
                ? String(day.autoMiles)
                : ''
            : (day.loadLabels?.length ? day.loadLabels : day.loadNumbers).join(', ');
      return { text, editable: Boolean(board.data?.canWrite), clearable: true, typed: Boolean(cell), version: cell?.version ?? null };
    },
    [rowsById, board.data?.canWrite],
  );
  const write = useCallback(
    async (writes: SheetWrite[]) => {
      const weekStart = board.data?.weekStart ?? week;
      const seen = new Set<string>();
      const cells = writes.flatMap((w) => {
        const { driverId, sub } = splitKey(w.r);
        if (w.c !== COMMENT) return [{ driverId, day: w.c, column: sub as WeeklyColumn, value: w.restore ? null : w.text, restore: w.restore, expectedVersion: w.expectedVersion }];
        // The four rows of a driver share one comment: a range or a paste over them writes it once.
        if (seen.has(driverId)) return [];
        seen.add(driverId);
        // An emptied comment is removed rather than kept as an empty typed cell.
        const empty = w.restore || w.text === null || w.text.trim() === '';
        return [{ driverId, day: weekStart, column: WEEK_COMMENT_COLUMN, value: empty ? null : w.text, restore: empty, expectedVersion: w.expectedVersion }];
      });
      await writeCells.mutateAsync({ cells });
    },
    [writeCells, board.data?.weekStart, week],
  );
  const sheetCols = useMemo(() => (days.length > 0 ? [...days, COMMENT] : []), [days]);
  const sheet = useSheet({
    rows: sheetRows,
    cols: sheetCols,
    read,
    write,
    describe: (r, c) =>
      c === COMMENT
        ? `Comment cleared on ${rowsById.get(splitKey(r).driverId)?.driverName ?? ''}`
        : `${SUB_LABEL[splitKey(r).sub]} cleared on ${rowsById.get(splitKey(r).driverId)?.driverName ?? ''} · ${formatIsoDate(c)}`,
    onNotice: (message) => toast({ tone: 'warning', title: 'Paste', description: message }),
  });
  // Driver names picked for painting (owner, 2026-11-02): a click on a name picks it, Ctrl or Shift
  // adds; a click on a sheet cell goes back to painting the cells.
  const [pickedNames, setPickedNames] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (sheet.anchor) setPickedNames(new Set());
  }, [sheet.anchor]);
  const pickName = (driverId: string, add: boolean) =>
    setPickedNames((prev) => {
      const next = new Set(add ? prev : []);
      if (add && prev.has(driverId)) next.delete(driverId);
      else next.add(driverId);
      return next;
    });
  const paint = (tint: number) => {
    if (pickedNames.size > 0) {
      const monday = board.data?.weekStart ?? week;
      void writeFills
        .mutateAsync({ fills: [...pickedNames].map((driverId) => ({ driverId, day: monday, column: WEEK_NAME_FILL_COLUMN, tint })) })
        .catch((e) => toast({ tone: 'danger', title: 'Fill not saved', description: e instanceof Error ? e.message : undefined }));
      return;
    }
    const cells = sheet.rangeCells().filter((x) => splitKey(x.r).sub !== 'rpm' && x.c !== COMMENT);
    if (cells.length === 0) return;
    void writeFills
      .mutateAsync({ fills: cells.map((x) => ({ driverId: splitKey(x.r).driverId, day: x.c, column: splitKey(x.r).sub as WeeklyColumn, tint })) })
      .catch((e) => toast({ tone: 'danger', title: 'Fill not saved', description: e instanceof Error ? e.message : undefined }));
  };
  const copyName = (row: WeeklyBoardRow) => {
    const text = row.coDriver ? `${row.driverName} // ${row.coDriver}` : row.driverName;
    void copyText(text).then(() => toast({ tone: 'success', title: 'Copied', description: text }));
  };
  const openEdit = (row: WeeklyBoardRow) =>
    setEditing({
      id: row.driverId,
      driverId: row.driverNumber ? row.driverId : null,
      name: row.driverName,
      coDriver: row.coDriver,
      sourceName: null,
      payTag: row.payTag,
      truckUnit: row.truckUnit,
      phone: '',
      dispatcherId: row.dispatcherId,
      dispatcherName: row.dispatcherName,
      comment: row.comment,
      unassignedAt: row.unassignedAt,
      unassignedReason: null,
      truckConflict: false,
      version: row.rosterVersion,
    });

  const canWrite = board.data?.canWrite ?? false;
  const canManage = board.data?.canManage ?? false;
  const sees = board.data?.seesCommission ?? false;
  const grand = board.data?.grand;
  const headCell = GRID.headTeal;
  /*
   * Sideways scrolling stops on whole columns: the sheet snaps so the first column after the pinned
   * Driver column is never half hidden. A half-hidden day showed only a sliver of its status fill
   * beside the names - a bare blue or pink bar (owner's screenshots, 2026-10-01). The snap padding
   * is the pinned column's own width, which grows with the longest name. The far right end is a
   * snap point too: the Comment column (the last, "grows" one) takes the few extra pixels that make
   * the furthest scroll land on a column edge rather than on half a day.
   */
  const frameRef = useRef<HTMLDivElement>(null);
  const driverHeadRef = useRef<HTMLTableCellElement>(null);
  const commentHeadRef = useRef<HTMLTableCellElement>(null);
  useEffect(() => {
    const head = driverHeadRef.current;
    const frame = frameRef.current;
    const comment = commentHeadRef.current;
    if (!head || !frame || !comment || typeof ResizeObserver === 'undefined') return;
    const sync = () => {
      const pad = head.getBoundingClientRect().width;
      frame.style.scrollPaddingLeft = `${pad}px`;
      // The table sits at its columns' minimum widths, so the minimum is what moves the column.
      comment.style.minWidth = '200px';
      const table = head.closest('table');
      if (!table) return;
      const maxScroll = table.offsetWidth - frame.clientWidth;
      if (maxScroll <= 0) return;
      const stops = [...(head.parentElement?.children ?? [])].slice(1).map((th) => (th as HTMLElement).offsetLeft - pad);
      const next = stops.filter((v) => v >= maxScroll).sort((a, b) => a - b)[0];
      if (next !== undefined && next - maxScroll > 1) comment.style.minWidth = `${200 + Math.ceil(next - maxScroll)}px`;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(head);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [board.data, sees]);
  const shown = useMemo(() => {
    const total = visible.reduce((s, r) => s + r.total, 0);
    const miles = visible.reduce((s, r) => s + r.miles, 0);
    return {
      total,
      miles,
      rpm: miles > 0 ? total / miles : null,
      trucks: visible.length,
      goal: visible.reduce((s, r) => s + r.goal, 0),
      planReach: visible.reduce((s, r) => s + r.planReach, 0),
      planAdj: Math.round(visible.reduce((s, r) => s + r.planAdj, 0) * 100) / 100,
      daysWorked: visible.reduce((s, r) => s + r.daysWorked, 0),
      commissionCents: visible.reduce((s, r) => s + (r.commission?.payableCents ?? 0), 0),
    };
  }, [visible, days]);
  const colCount = 9 + 7 + (sees ? 1 : 0) + 1;
  const avgPerTruck = shown.trucks ? Math.round((shown.total / shown.trucks) * 100) / 100 : null;

  return (
    <div className="flex flex-col gap-2">
      <BoardBar current="/dispatch/weekly"
        title="Weekly Board"
      >
        <AccessPill canWrite={canWrite} canManage={canManage} />
        <SaveIndicator state={sheet.saveState} onDismiss={sheet.dismissSaveState} />
        <WeekPicker week={week} onChange={setWeek} />
        {week !== weekStartMonday(companyToday()) ? (
          <Button variant="secondary" size="sm" onClick={() => setWeek(weekStartMonday(companyToday()))}>
            This week
          </Button>
        ) : null}
        <FillPalette disabled={!canWrite || (!sheet.anchor && pickedNames.size === 0)} onPick={paint} />
        {canManage ? (
          <Button variant="secondary" size="sm" icon={<Plus />} onClick={() => setAdding(null)}>
            Add driver
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" icon={<FileText />} asChild>
          <Link to="/dispatch/weekly/report" search={{ week }}>
            Report
          </Link>
        </Button>
        <Button variant="secondary" size="sm" icon={<RefreshCw />} loading={board.isFetching && !board.isPending} onClick={() => void board.refetch()} aria-label="Refresh" />
      </BoardBar>

      <div className="flex flex-wrap items-center gap-2">
        <Input size="sm" type="search" prefix={<Search />} aria-label="Search anything"
          // A firmer outline than the app's default field, so the board's search is easy to find (owner, 2026-10-01).
          placeholder="Search name, co-driver, truck, load #, status, amount, comment…" value={q} onChange={(e) => setQ(e.target.value)} className="w-96 ring-nw-text-3/60" />
      </div>

      {board.isError ? (
        <ErrorState error={board.error} onRetry={() => void board.refetch()} />
      ) : (
        <div ref={frameRef} className={cn(GRID.frame, 'nw-board-week-frame')} tabIndex={0} onKeyDown={sheet.onKeyDown} onPaste={sheet.onPaste} style={{ maxHeight: 'calc(100vh - 190px)', outline: 'none' }}>
          <table className="nw-board nw-board-week w-full border-collapse"
            // Flexible: the sheet widths are minimums, the table fills the screen, and a column whose
            // number needs more room grows (Plan Adj at -$253,000.00) instead of spilling.
            style={{ minWidth: 160 + 60 + 90 * 7 + 88 * 7 + (sees ? 110 : 0) + 200 }} role="grid" aria-label="Weekly board">
            <colgroup>
              {/* The sheet's widths: driver 160, row label 60, each day 90, each summary 88, commission 110. */}
              <col style={{ width: 160 }} />
              <col style={{ width: 60 }} />
              {days.map((d) => (
                <col key={d} style={{ width: 90 }} />
              ))}
              <col style={{ width: 88 }} />
              <col style={{ width: 88 }} />
              <col style={{ width: 88 }} />
              <col style={{ width: 88 }} />
              <col style={{ width: 88 }} />
              <col style={{ width: 88 }} />
              <col style={{ width: 88 }} />
              {sees ? <col style={{ width: 110 }} /> : null}
              {/* Comment: 200 at least; it takes what the screen has left over. */}
              <col style={{ width: 200 }} />
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr>
                <th ref={driverHeadRef} scope="col" className={cn(headCell, 'sticky left-0 z-20 min-w-[160px] px-4 text-left tracking-[.06em] uppercase')}>Driver</th>
                <th scope="col" className={cn(headCell, 'w-[60px] min-w-[60px] text-left tracking-[.06em] uppercase')}>Row</th>
                {days.map((d, i) => (
                  <th key={d} scope="col" className={cn(headCell, 'min-w-[90px] cursor-pointer hover:bg-nw-hover')} title={`Click to select the column · ${formatIsoDate(d)}`} onClick={() => sheet.selectColumn(d)}>
                    <span className="block">{DAY_NAMES[i]}</span>
                    <span className="tabular block text-[11.5px] font-medium text-nw-text-3">{shortDate(d)}</span>
                  </th>
                ))}
                <th scope="col" className={cn(headCell, 'min-w-[88px]')}>Total $</th>
                <th scope="col" className={cn(headCell, 'min-w-[88px]')}>Total Mi</th>
                <th scope="col" className={cn(headCell, 'min-w-[88px]')}>Avg RPM</th>
                <th scope="col" className={cn(headCell, 'min-w-[88px]')}>Plan Reach</th>
                <th scope="col" className={cn(headCell, 'min-w-[88px]')}>Plan Adj</th>
                <th scope="col" className={cn(headCell, 'min-w-[88px]')}>Days Worked</th>
                <th scope="col" className={cn(headCell, 'min-w-[88px]')}>Efficiency</th>
                {sees ? <th scope="col" className={cn(headCell, 'min-w-[110px] tracking-[.06em] uppercase')}>Commission</th> : null}
                <th ref={commentHeadRef} scope="col" className={cn(headCell, 'min-w-[200px] cursor-pointer hover:bg-nw-hover')} title="Click to select the column" onClick={() => sheet.selectColumn(COMMENT)}>
                  Comment
                </th>
              </tr>
            </thead>
            <tbody>
              {grand ? (
                // The one row with its own background: the dark band of the owner's mockup (2026-10-01). It is
                // the first body row and scrolls away; only the header stays pinned (owner, 2026-10-01).
                <tr className="nw-week-grand">
                  <td className={cn(GRID.wkGrandCell, 'sticky left-0 z-[5] px-4 text-left tracking-[.04em] uppercase')} title={filtered ? `Full week: ${moneyCell(grand.total)} across ${grand.trucks} trucks` : undefined}>
                    {filtered ? 'Filtered total' : 'Grand total'}
                  </td>
                  <td colSpan={8} className={cn(GRID.wkGrandCell, 'text-[12.5px] font-semibold')}>
                    <span className="text-(--bd-grand-muted)">AVG / TRUCK </span>
                    <span className="tabular font-bold text-(--bd-grand-accent)">{avgPerTruck !== null ? moneyCell(avgPerTruck) : '—'}</span>
                    <span className="text-(--bd-grand-muted)">{filtered ? ` · ${shown.trucks} of ${grand.trucks} trucks` : ` · ${shown.trucks} trucks`}</span>
                  </td>
                  <td className={GRID.wkGrandCell}>{moneyCell(shown.total)}</td>
                  <td className={GRID.wkGrandCell}>{shown.miles.toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                  <td className={GRID.wkGrandCell} title="Weighted: total gross ÷ total miles">
                    {shown.rpm ? `${shown.rpm.toFixed(2)}` : '—'}
                  </td>
                  <td className={GRID.wkGrandCell}>
                    <SignedMoney n={shown.planReach} />
                  </td>
                  <td className={GRID.wkGrandCell}>
                    <SignedMoney n={shown.planAdj} />
                  </td>
                  <td className={GRID.wkGrandCell}>{shown.daysWorked}</td>
                  <td className={GRID.wkGrandCell}>
                    <EffPill total={shown.total} goal={shown.goal} />
                  </td>
                  {sees ? <td className={cn(GRID.wkGrandCell, 'text-(--bd-grand-pos)')}>{cents(shown.commissionCents)}</td> : null}
                  <td className={GRID.wkGrandCell} aria-label="No comment on the total" />
                </tr>
              ) : null}
              {board.isPending ? (
                <tr>
                  <td colSpan={colCount} className="px-4 py-10 text-center text-sm text-nw-text-3">
                    Loading…
                  </td>
                </tr>
              ) : teams.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="px-4 py-10 text-center text-sm text-nw-text-3">
                    {allRows.length === 0 ? 'No drivers on the board this week.' : 'No drivers match.'}
                  </td>
                </tr>
              ) : (
                teams.map((team) => {
                  const meta = team.meta;
                  const isCollapsed = collapsed.has(team.id);
                  // Nickname(s) when the team is linked to employees (owner, 2026-10-26), full name on hover.
                  const first = team.rows[0];
                  const name = team.id ? first?.dispatcherNickname || first?.dispatcherName || team.id : 'Unassigned drivers';
                  const fullName = team.id && first?.dispatcherNickname ? (first.dispatcherFullName ?? first.dispatcherName) : undefined;
                  return (
                    <TeamRows key={team.id}>
                      <tr className={cn(GRID.wkBand, 'nw-week-team')}>
                        {/* The team name sits in the pinned Driver column alone (one column, like the header and the
                            grand total), so nothing scrolling under it is half covered. */}
                        <td className={cn(GRID.bandCell, 'sticky left-0 z-[5] bg-(--bd-band) text-left font-bold')}>
                          <div className="flex h-[38px] w-full items-center gap-2 overflow-hidden whitespace-nowrap">
                            <button
                              type="button"
                              aria-expanded={!isCollapsed}
                              onClick={() => toggleTeam(team.id)}
                              className="inline-flex min-w-0 items-center gap-1.5"
                            >
                              <ChevronDown className={cn('size-3.5 shrink-0 text-nw-text-3 transition-transform', isCollapsed && '-rotate-90')} aria-hidden />
                              <span title={fullName} className="truncate text-[13px] font-bold tracking-[.02em] text-nw-accent-ink uppercase">{name}</span>
                              <span className="text-[12px] font-semibold text-nw-text-3">({team.rows.length})</span>
                            </button>
                          </div>
                        </td>
                        <td className={GRID.bandCell} />
                        {(meta?.dayTotals ?? days.map(() => 0)).map((t, i) => (
                          <td key={i} className={cn(GRID.bandCell, 'tabular text-(--bd-green)')}>
                            {t ? moneyCell(t) : ''}
                          </td>
                        ))}
                        <td className={GRID.bandCell}>{meta ? <span className={GRID.pillBlue}>{moneyCell(meta.total)}</span> : ''}</td>
                        <td className={GRID.bandCell}>{meta ? <span className={GRID.pillGrey}>{meta.miles.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span> : ''}</td>
                        <td className={GRID.bandCell} title="Weighted: team gross ÷ team miles">
                          {meta?.rpm ? <span className={GRID.pillAmber}>${meta.rpm.toFixed(2)}</span> : ''}
                        </td>
                        {/* AVG/TRUCK centred over Plan Reach + Plan Adj; Add sits in its own Days Worked cell so
                            that column keeps its line (owner, 2026-10-02). */}
                        <td className={cn(GRID.bandCell, 'text-center text-[12px] text-nw-text-3')} colSpan={2}>
                          {meta ? (
                            <span className="whitespace-nowrap">
                              AVG/TRUCK <span className="font-bold text-(--bd-blue)">{moneyCell(Math.round(meta.total / Math.max(1, meta.trucks)))}</span>
                            </span>
                          ) : null}
                        </td>
                        <td className={GRID.bandCell}>
                          {canManage && team.id ? (
                            <button type="button" onClick={() => setAdding({ id: team.id, name })} className={cn(GRID.pillBlue, 'h-6 shrink-0 gap-1 bg-nw-panel px-2.5 hover:bg-(--bd-blue-bg)')} title="Add a driver to this team">
                              <UserPlus className="size-3.5" aria-hidden /> Add
                            </button>
                          ) : null}
                        </td>
                        <td className={GRID.bandCell}>{meta ? <EffPill total={meta.total} goal={meta.goal} /> : null}</td>
                        {sees ? <td className={cn(GRID.bandCell, 'tabular font-bold')}>{meta?.commissionCents !== null && meta?.commissionCents !== undefined ? cents(meta.commissionCents) : ''}</td> : null}
                        <td className={cn(GRID.bandCell, 'border-r-0')} />
                      </tr>
                      {isCollapsed
                        ? null
                        : team.rows.map((row) => (
                            <DriverRows key={row.driverId} row={row} week={week} sheet={sheet} canWrite={canWrite} canManage={canManage} sees={sees} picked={pickedNames.has(row.driverId)} onHistory={() => setHistory({ id: row.driverId, name: row.driverName })} onEdit={() => openEdit(row)} onCopy={() => copyName(row)} onPick={canWrite ? (add) => pickName(row.driverId, add) : undefined} />
                          ))}
                    </TeamRows>
                  );
                })
              )}
              {/*
               * A driver unassigned from his dispatcher sits in the Unassigned drivers group above
               * (owner, 2026-10-26). A row REMOVED from the board is not listed (owner, 2026-10-02);
               * it is restored from its Edit driver dialog on any earlier week it still shows on,
               * or - for an archived driver - from Drivers > Archived > Restore.
               */}
            </tbody>
          </table>
        </div>
      )}

      <UndoBar sheet={sheet} />
      {history ? <HistoryPopup driverId={history.id} driverName={history.name} onClose={() => setHistory(null)} /> : null}
      {adding !== false ? <AddDriverDialog open onClose={() => setAdding(false)} team={adding ?? undefined} /> : null}
      {editing ? <EditDriverDialog row={editing} week={week} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function TeamRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}


/** The summary cells span the four rows; `driver-end` on the fourth row draws the closing line. */
const SPAN = GRID.summary;

/**
 * Plan Reach / Plan Adj: the sheet FILLS these cells rather than colouring the
 * digits — `whenNumberLessThan(0)` paints #f4c7c3 and `>= 0` paints #b7e1cd
 * across the cell, text staying black. Matching the sheet means a fill here too,
 * not a red or green number (Apps Script `applyConditionalFormattingOnDashTabs`).
 */
const planFill = (n: number): string =>
  n < 0
    ? 'bg-(--bd-wk-plan-neg) text-(--bd-wk-plan-text)'
    : 'bg-(--bd-wk-plan-pos) text-(--bd-wk-plan-text)';

/**
 * A signed amount on the dark grand-total band: a minus sign, a falling arrow and red for a
 * shortfall; a plus sign, a rising arrow and green for a surplus. Never the colour alone.
 */
function SignedMoney({ n }: { n: number }) {
  const negative = n < 0;
  const Icon = negative ? TrendingDown : TrendingUp;
  return (
    <span className={cn('tabular inline-flex items-center gap-1', negative ? 'text-(--bd-grand-neg)' : 'text-(--bd-grand-pos)')}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {negative ? `−${moneyCell(-n)}` : `+${moneyCell(n)}`}
    </span>
  );
}

/** "9/28": the header's short date, read from the ISO day (no time zone involved). */
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function DriverRows({ row, week, sheet, canWrite, canManage, sees, picked, onHistory, onEdit, onCopy, onPick }: { row: WeeklyBoardRow; week: string; sheet: ReturnType<typeof useSheet>; canWrite: boolean; canManage: boolean; sees: boolean; picked: boolean; onHistory: () => void; onEdit: () => void; onCopy: () => void; onPick?: (add: boolean) => void }) {
  const nameTint = TINT_CLASS[row.days[0]?.fills[WEEK_NAME_FILL_COLUMN] ?? 0];
  return (
    <>
      {SUBROWS.map((sub, si) => {
        const r = rowKey(row.driverId, sub);
        const last = si === SUBROWS.length - 1;
        return (
          <tr key={sub} className={last ? 'driver-end' : undefined} data-driver-end={last || undefined}>
            {si === 0 ? (
              <td
                rowSpan={SUBROWS.length}
                className={cn(SPAN, 'sticky left-0 z-[5] min-w-[160px] px-4 py-2 text-left align-top', nameTint || 'bg-nw-panel', picked && 'outline-2 -outline-offset-2 outline-nw-accent', onPick && 'cursor-pointer')}
                // A click anywhere in the driver cell picks it for Fill (owner, 2026-11-03: only the name
                // text answered); Ctrl or Shift adds. Unassign and the other links keep their own click.
                onClick={(e) => {
                  if (!onPick || (e.target as HTMLElement).closest('button[data-own-click]')) return;
                  onPick(e.ctrlKey || e.metaKey || e.shiftKey);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onHistory();
                }}
              >
                {/* A team shows its two drivers one under the other (owner, 2026-10-01; this replaces the
                    one-line "NAME // CO-DRIVER" on the Weekly Board only). A click still copies
                    "NAME // CO-DRIVER"; right-click opens the history. */}
                <button type="button" onClick={onCopy} className="block text-left text-[13px] leading-4 font-semibold whitespace-nowrap text-nw-text uppercase hover:underline" title="Click: copy the name and pick the driver for Fill (Ctrl adds) · right-click: edit history">
                  <span className="block">{row.driverName}</span>
                  {row.coDriver ? <span className="block">{row.coDriver}</span> : null}
                </button>
                <span className="mt-1 flex items-center gap-1 overflow-hidden whitespace-nowrap">
                  {row.truckUnit ? <span className={GRID.chipBlue}>#{row.truckUnit}</span> : null}
                  {row.payTag ? <span className={GRID.chipGrey}>{row.payTag}</span> : null}
                  {row.unit === 'team' ? <span className={GRID.chipGrey}>Team</span> : null}
                  {row.pinned ? (
                    <span className={GRID.badgeAmber} title="This week keeps the team / truck it ran under; the roster has moved since">
                      pinned
                    </span>
                  ) : null}
                </span>
                {canManage ? (
                  <button type="button" data-own-click onClick={onEdit} className={cn(GRID.linkRed, 'mt-0.5 block leading-4')}>
                    {row.dispatcherId ? 'Unassign' : 'Assign'}
                  </button>
                ) : null}
                {row.comment ? (
                  <span className="block truncate text-[11px] leading-4 text-nw-text-3" title={row.comment}>
                    {row.comment}
                  </span>
                ) : null}
              </td>
            ) : null}
            <td className={cn(GRID.ro, 'px-1 text-[12.5px] whitespace-nowrap text-nw-text')}>{SUB_LABEL[sub]}</td>
            {row.days.map((d) => {
              const def = d.statusWord ? statusDef(d.statusWord) : null;
              const cell = sub === 'amount' ? d.amountCell : sub === 'wk_miles' ? d.milesCell : sub === 'wk_load' ? d.loadCell : null;
              const tint = TINT_CLASS[d.fills[sub] ?? 0];
              if (sub === 'rpm') {
                return (
                  <td key={d.day} className={cn(GRID.ro, 'tabular font-semibold')}>
                    {d.miles > 0 ? `$${(d.amount / d.miles).toFixed(2)}` : ''}
                  </td>
                );
              }
              const shown =
                sub === 'amount'
                  ? def
                    ? def.code
                    : d.amount
                      ? moneyCell(d.amount)
                      : ''
                  : sub === 'wk_miles'
                    ? d.miles
                      ? d.miles.toLocaleString('en-US')
                      : ''
                    : cell
                      ? (cell.value ?? '')
                      : (d.loadLabels?.length ? d.loadLabels : d.loadNumbers).join(', ');
              return (
                <SheetCell
                  key={d.day}
                  sheet={sheet}
                  r={r}
                  c={d.day}
                  text=""
                  typed={Boolean(cell)}
                  editable={canWrite}
                  tint={cn(tint, sub === 'amount' && def ? STATUS_CELL[def.code] : undefined)}
                  className={cn('tabular font-semibold', sub === 'amount' && def && 'font-extrabold uppercase', sub === 'wk_load' && 'text-[12px] text-nw-text-2')}
                  title={cell?.formula ?? (cell ? `Typed by ${cell.setByName}` : d.loads.length > 1 ? loadBreakdown(d.loads) : undefined)}
                 
                >
                  {shown}
                </SheetCell>
              );
            })}
            {si === 0 ? (
              <>
                <td rowSpan={SUBROWS.length} className={cn(SPAN, 'text-[13px] font-bold text-(--bd-green)')}>
                  {moneyCell(row.total)}
                </td>
                <td rowSpan={SUBROWS.length} className={cn(SPAN, 'text-nw-text-2')}>
                  {row.miles.toLocaleString('en-US')}
                </td>
                <td rowSpan={SUBROWS.length} className={cn(SPAN, 'text-nw-text-2')}>
                  {row.rpm ? `$${row.rpm.toFixed(2)}` : '—'}
                </td>
                <td rowSpan={SUBROWS.length} className={cn(SPAN, 'nw-week-plan', planFill(row.planReach))}>
                  {moneyCell(row.planReach)}
                </td>
                <td rowSpan={SUBROWS.length} className={cn(SPAN, 'nw-week-plan', planFill(row.planAdj))}>
                  {moneyCell(row.planAdj)}
                </td>
                <td rowSpan={SUBROWS.length} className={cn(SPAN, 'text-nw-text-2')} title="Days worked: HOME, VACATION, SHOP, INACTIVE, STOP and NO ANSWER take a day off the plan; REST counts as worked">
                  {row.daysWorked}
                </td>
                <td rowSpan={SUBROWS.length} className={SPAN}>
                  <EffPill total={row.total} goal={row.goal} />
                </td>
                {sees ? (
                  <td rowSpan={SUBROWS.length} className={cn(SPAN, 'p-0')}>
                    <CommissionCell row={row} week={week} canManage={canManage} />
                  </td>
                ) : null}
                <SheetCell
                  sheet={sheet}
                  r={r}
                  c={COMMENT}
                  rowSpan={SUBROWS.length}
                  spanRows={SUBROWS.map((x) => rowKey(row.driverId, x))}
                  text=""
                  typed={Boolean(row.weekComment)}
                  editable={canWrite}
                  className="border-r-0 px-2 py-1 text-left align-top"
                  title={row.weekComment ? `${row.weekComment.value ?? ''}
— ${row.weekComment.setByName}` : canWrite ? 'Click, then click again or press Enter to write a comment' : undefined}
                >
                  <span className="line-clamp-4 text-[12.5px] leading-[18px] font-normal break-words whitespace-pre-wrap text-nw-text">{row.weekComment?.value ?? ''}</span>
                </SheetCell>
              </>
            ) : null}
          </tr>
        );
      })}
    </>
  );
}
