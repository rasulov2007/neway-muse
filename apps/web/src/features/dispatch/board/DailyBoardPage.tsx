import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft, ArrowUpDown, ChevronDown, Pencil, Plus, RefreshCw, Search, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BOARD_WORDS_NEEDING_A_LOAD, DAILY_COLUMNS, DISPATCH_STATUS_DEFS, addDays, boardLoadLabel, canSeparateTeams, statusDef, type DailyBoardRow, type DailyColumn, type RosterRow } from '@neway/shared';
import { Badge, Button, DropdownMenu, ErrorState, Input, MenuItem, StatusSymbol, cn, useToast } from '@/design-system';
import { today as companyToday } from '@/lib/clock';
import { formatIsoDate } from '@/lib/format';
import { useDailyBoard, useWriteCells, useWriteFills } from './api';
import { AccessPill, BoardBar, PeriodStepper, SaveIndicator, UndoBar } from './chrome';
import { FillPalette } from './FillPalette';
import { HistoryPopup } from './HistoryPopup';
import { AddDriverDialog, EditDriverDialog, ImportRosterDialog } from './RosterDialogs';
import { SeparateDispatchersDialog } from './SeparateTeamDialogs';
import { useAccount } from '@/features/auth/auth-context';
import { FAMILY_CELL, FAMILY_TEXT, GRID, STATUS_CELL, STATUS_SWATCH, TINT_CLASS, phoneParts, sinceLabel, sinceTone } from './sheet';
import { SheetCell } from './SheetCell';
import { StatusActionPanel, type PendingStatus } from './StatusActionPanel';
import { TeamOrderDialog } from './TeamOrderDialog';
import { useCollapsedTeams } from './collapsed';
import { copyText, useSheet, type CellInfo, type SheetWrite } from './useSheet';
import { dailyBoardSearchSchema } from './search';
import { BoardPtiIssueMark } from '@/features/fleet/pti/PtiIssueBadge';
import { CreateDriverFileDialog, useCanCreateDriverFile, type BoardRowForFile } from './DriverFileForRow';

type View = 'teams' | 'flat';

/** The sheet's columns, in the brief's order. `name` and `since` are read-only. */
/** The four board words that are statements about freight rather than about the driver's day. */
const LOAD_STATUSES_ON_BOARD = new Set(['DISPATCHED', 'AT PU', 'ENROUTE', 'UNLOADING', 'READY']);

/**
 * Words that say the driver is not available. They never change a load - a person going home
 * does not deliver freight - but a live load still on them is a contradiction somebody has to
 * settle, so the row says so instead of the two screens quietly disagreeing.
 */
const OFF_DUTY_STATUSES = new Set(['HOME', 'VACATION', 'SHOP', 'INACTIVE', 'NO ANSWER', 'STOP']);

const COLS = ['load_number', 'name', 'truck', 'trailer', 'phone', 'status', 'since', 'eta', 'miles', 'route', 'notes'] as const;
type Col = (typeof COLS)[number];
const COL_LABEL: Record<Col, string> = {
  load_number: 'Load #',
  name: 'Driver name',
  truck: 'Truck #',
  trailer: 'Trailer #',
  phone: 'Phone #',
  status: 'Status',
  since: 'Active since',
  eta: 'ETA',
  miles: 'Miles',
  route: 'Origin / Delivery',
  notes: 'Notes',
};
/** Column widths in px, the sheet's; the table is exactly their sum so nothing gets squeezed. */
const COL_WIDTH: Record<Col, number> = {
  load_number: 112,
  name: 224,
  truck: 80,
  trailer: 96,
  phone: 200,
  status: 109,
  since: 64,
  eta: 128,
  miles: 80,
  route: 256,
  notes: 288,
};
const FLAT_ORDINAL = 40;
const FLAT_DISPATCHER = 160;
const TYPED: Set<string> = new Set(DAILY_COLUMNS);
/** Delete never clears the status or the truck. */
const NO_CLEAR: Set<string> = new Set(['status', 'truck', 'name', 'since']);
const UNASSIGNED = '';
/** Board T's status filter: symbol + word + count, the chosen one painted in its status colour. */
const CHIP = 'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] font-bold transition-colors';
const CHIP_COUNT = 'tabular inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold';

/**
 * The Daily Dispatch Board (owner's brief §4): every driver on a row, grouped by dispatcher
 * team and ordered by status, or flat as Board T; the sheet's columns; typed cells over what the
 * loads say; Sheets editing. Everything typed is saved to the server and seen by everyone.
 */
/**
 * `scope`: the board itself (teams), or the drivers with no dispatcher on a page of their own,
 * beside Dispatcher rotation (owner, 2026-10-25). Same rows, same editing; only which rows show.
 */
export function DailyBoardPage({ scope = 'teams' }: { scope?: 'teams' | 'unassigned' } = {}) {
  const page = scope === 'unassigned' ? '/dispatch/unassigned' : '/dispatch/daily';
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => dailyBoardSearchSchema.parse(rawSearch), [rawSearch]);
  const day = search.day ?? companyToday();
  const { toast } = useToast();
  const board = useDailyBoard(day);
  const writeCells = useWriteCells();
  const writeFills = useWriteFills();
  const [view, setView] = useState<View>('teams');
  const [q, setQ] = useState('');
  // Folded bands stay folded between visits, per person, company and page (owner, 2026-10-26).
  const { collapsed, toggle: toggleTeam } = useCollapsedTeams(page);
  const [history, setHistory] = useState<{ id: string; name: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ id: string; name: string } | null | false>(false);
  const [importing, setImporting] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [editing, setEditing] = useState<RosterRow | null>(null);
  // A board row with no driver file, being given one (owner, 2026-10-26).
  const [fileFor, setFileFor] = useState<BoardRowForFile | null>(null);
  const canCreateFile = useCanCreateDriverFile();
  const createFileFor = (row: DailyBoardRow) =>
    setFileFor({ id: row.driverId, name: row.driverName, phone: cellText(row, 'phone') || row.phone, dispatcherId: row.dispatcherId });
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const nowIso = new Date(tick).toISOString();

  const setDay = (next: string) => void navigate({ to: page, search: { day: next }, replace: true });

  const rowsById = useMemo(() => new Map((board.data?.rows ?? []).map((r) => [r.driverId, r])), [board.data]);
  const needle = q.trim().toLowerCase();
  const visible = useMemo(() => {
    let rows = (board.data?.rows ?? []).filter((r) => (scope === 'unassigned' ? r.dispatcherId === UNASSIGNED : r.dispatcherId !== UNASSIGNED));
    if (needle)
      rows = rows.filter((r) =>
        [r.driverName, r.coDriver ?? '', r.driverNumber, r.truckUnit ?? '', r.primaryLoad ? boardLoadLabel(r.primaryLoad) : '', r.dispatcherName, r.dispatcherNickname ?? '', r.payTag ?? '', cellText(r, 'notes'), cellText(r, 'load_number')]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      );
    if (statusFilter) rows = rows.filter((r) => (r.status ?? '') === statusFilter);
    return rows;
  }, [board.data, needle, statusFilter, scope]);
  const teams = useMemo(() => {
    const map = new Map<string, DailyBoardRow[]>();
    for (const r of visible) map.set(r.dispatcherId, [...(map.get(r.dispatcherId) ?? []), r]);
    // Nickname(s) when the team is linked to employees (owner, 2026-10-26); the stored name is
    // kept for writes (Add driver names the team by it) and shown in the tooltip.
    const list = [...map.entries()].map(([id, rows]) => ({
      id,
      name: rows[0]!.dispatcherName,
      label: rows[0]!.dispatcherNickname || rows[0]!.dispatcherName,
      fullName: rows[0]!.dispatcherNickname ? (rows[0]!.dispatcherFullName ?? rows[0]!.dispatcherName) : undefined,
      // TEAM n comes from the server's team order; a solo dispatcher has none (owner, 2026-10-26).
      teamNumber: rows[0]!.teamNumber ?? null,
      rows,
    }));
    // Unassigned drivers have their own page now; on it they are the only section.
    return [...list.filter((t) => t.id !== UNASSIGNED), ...list.filter((t) => t.id === UNASSIGNED)];
  }, [visible]);
  const orderedRows = useMemo(() => (view === 'teams' ? teams.flatMap((t) => (collapsed.has(t.id) ? [] : t.rows)) : visible), [view, teams, collapsed, visible]);
  const statusCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of board.data?.rows ?? []) c.set(r.status ?? '', (c.get(r.status ?? '') ?? 0) + 1);
    return c;
  }, [board.data]);

  const read = useCallback(
    (r: string, c: string): CellInfo => {
      const row = rowsById.get(r);
      if (!row || !TYPED.has(c)) return { text: row ? readOnlyText(row, c as Col, nowIso) : '', editable: false, clearable: false, typed: false, version: null };
      const cell = row.cells[c];
      const shown = typedCell(row, c);
      return {
        text: shown ? (shown.formula ?? shown.value ?? '') : (row.auto[c] ?? ''),
        // LOAD # is the load on the driver: never typed, cleared, pasted or filled (owner, 2026-10-13).
        editable: Boolean(board.data?.canWrite) && c !== 'status' && c !== 'load_number',
        clearable: !NO_CLEAR.has(c) && c !== 'load_number',
        typed: Boolean(shown),
        // A carried cell belongs to an earlier day; today's row does not exist yet, so expect none.
        version: cell && cell.day === day ? cell.version : null,
      };
    },
    [rowsById, nowIso, board.data?.canWrite, day],
  );
  const write = useCallback(
    async (writes: SheetWrite[]) => {
      await writeCells.mutateAsync({
        cells: writes.map((w) => ({ driverId: w.r, day, column: w.c as DailyColumn, value: w.restore ? null : w.text, restore: w.restore, expectedVersion: w.expectedVersion })),
      });
    },
    [writeCells, day],
  );
  const sheet = useSheet({
    rows: orderedRows.map((r) => r.driverId),
    cols: [...COLS],
    read,
    write,
    describe: (r, c) => `${COL_LABEL[c as Col] ?? c} cleared on ${rowsById.get(r)?.driverName ?? r}`,
    onNotice: (message) => toast({ tone: 'warning', title: 'Paste', description: message }),
  });

  /**
   * The board word, written straight to the cell. Four words are not only a word - they are a
   * statement about freight - and those open the panel instead; see `chooseStatus`.
   */
  const setStatus = (row: DailyBoardRow, status: string) =>
    void sheet.commit([{ r: row.driverId, c: 'status', text: status, expectedVersion: undefined }], `Status on ${row.driverName}`, true).catch(() => undefined);

  /**
   * Choosing a status from a row.
   *
   * DISPATCHED, ENROUTE, UNLOADING and the READY that follows a delivery need something from the
   * person before they are true, so they open the side panel; the load and the row then move
   * together in one server call. Everything else - COVERED, REST, HOME - is the board's own word
   * and is written at once. A driver who is off keeps their word, and the row says what is still
   * assigned rather than quietly dropping it.
   */
  const chooseStatus = (row: DailyBoardRow, status: string) => {
    /*
     * Dispatching is the moment a waiting load becomes today's work, so that step looks at the
     * queued loads as well; every other word is about the load the driver is already on.
     */
    const about = row.primaryLoad ?? (status === 'DISPATCHED' ? (row.queuedLoads[0] ?? null) : null);
    // No load, no DISPATCHED / ENROUTE / UNLOADING: the driver stays READY until a load is assigned,
    // and assigning one turns the row DISPATCHED by itself (owner, 2026-09-30).
    if (BOARD_WORDS_NEEDING_A_LOAD.has(status) && !about) {
      toast({ tone: 'warning', title: `${row.driverName} has no load`, description: `Assign a load first; the row turns DISPATCHED by itself. Until then it stays READY.` });
      return;
    }
    if (LOAD_STATUSES_ON_BOARD.has(status) && about) {
      setPending({ row, status, load: about });
      return;
    }
    setStatus(row, status);
  };
  /** The row whose status is being finished in the panel, if any. */
  const [pending, setPending] = useState<PendingStatus | null>(null);
  const paint = (tint: number) => {
    const cells = sheet.rangeCells().filter((x) => TYPED.has(x.c) && x.c !== 'status');
    if (cells.length === 0) return;
    void writeFills.mutateAsync({ fills: cells.map((x) => ({ driverId: x.r, day, column: x.c as DailyColumn, tint })) }).catch((e) => toast({ tone: 'danger', title: 'Fill not saved', description: e instanceof Error ? e.message : undefined }));
  };
  const openEdit = (row: DailyBoardRow) =>
    setEditing({
      id: row.driverId,
      driverId: row.driverType === 'roster' ? null : row.driverId,
      name: row.driverName,
      coDriver: row.coDriver,
      sourceName: null,
      payTag: row.payTag,
      truckUnit: row.truckUnit,
      phone: row.phone,
      dispatcherId: row.dispatcherId,
      dispatcherName: row.dispatcherName,
      comment: '',
      unassignedAt: null,
      unassignedReason: null,
      truckConflict: row.truckConflict,
      version: row.rosterVersion,
    });

  const canWrite = board.data?.canWrite ?? false;
  const canManage = board.data?.canManage ?? false;
  // Separate is for administrators and dispatch managers only (owner, 2026-10-29).
  const account = useAccount();
  const canSeparate = account !== null && canSeparateTeams(account.roles);
  const [separatingTeam, setSeparatingTeam] = useState<{ id: string; name: string } | null>(null);
  const isToday = day === (board.data?.today ?? companyToday());
  // The last six weeks of days, newest first, for the drop-down (owner, 2026-10-19).
  const todayIso = board.data?.today ?? companyToday();
  const dayChoices = Array.from({ length: 42 }, (_, i) => {
    const d = addDays(todayIso, -i);
    return { value: d, label: `${formatIsoDate(d)}${i === 0 ? ' · today' : ''}`, group: formatIsoDate(`${d.slice(0, 8)}01`).replace(/ \d+,/, '') };
  });
  const colCount = COLS.length + (view === 'flat' ? 2 : 0);

  return (
    <div className="flex flex-col gap-2">
      <BoardBar current={page} title={scope === 'unassigned' ? 'Unassigned drivers' : 'Daily Board'}>
        <AccessPill canWrite={canWrite} canManage={canManage} />
        <SaveIndicator state={sheet.saveState} onDismiss={sheet.dismissSaveState} />
        <PeriodStepper
          label={`${formatIsoDate(day)}${isToday ? ' · today' : ''}`}
          onPrev={() => setDay(addDays(day, -1))}
          onNext={() => setDay(addDays(day, 1))}
          prevLabel="Previous day"
          nextLabel="Next day"
          options={dayChoices}
          value={day}
          onPick={setDay}
        />
        {!isToday ? (
          <Button variant="secondary" size="sm" onClick={() => setDay(companyToday())}>
            Today
          </Button>
        ) : null}
        <span className="inline-flex rounded-md bg-nw-segment p-0.5" role="group" aria-label="View">
          {(['teams', 'flat'] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cn('h-7 rounded px-2.5 text-xs font-semibold', view === v ? 'bg-nw-accent text-nw-on-accent' : 'text-nw-text-2 hover:bg-nw-panel')}
            >
              {v === 'teams' ? 'Teams' : 'Board T'}
            </button>
          ))}
        </span>
        <FillPalette disabled={!canWrite || !sheet.anchor} onPick={paint} />
        {canManage ? (
          <>
            <Button variant="secondary" size="sm" icon={<Plus />} onClick={() => setAdding(null)}>
              Add driver
            </Button>
            <Button variant="secondary" size="sm" icon={<Upload />} onClick={() => setImporting(true)}>
              Import roster
            </Button>
            {scope === 'teams' ? (
              <Button variant="secondary" size="sm" icon={<ArrowUpDown />} onClick={() => setOrdering(true)}>
                Team order
              </Button>
            ) : null}
          </>
        ) : null}
        <Button variant="secondary" size="sm" icon={<RefreshCw />} loading={board.isFetching && !board.isPending} onClick={() => void board.refetch()} aria-label="Refresh" />
      </BoardBar>

      <div className="flex flex-wrap items-center gap-2">
        <Input size="sm" type="search" prefix={<Search />} aria-label="Search driver, unit, load or note" placeholder="Search driver, unit, load or note…" value={q} onChange={(e) => setQ(e.target.value)} className="w-72" />
        {view === 'flat' ? (
          <Button
            variant="outline"
            size="sm"
            icon={<ArrowLeft />}
            onClick={() => {
              setView('teams');
              setStatusFilter(null);
            }}
          >
            Back to Daily Board
          </Button>
        ) : null}
        {view === 'flat' ? (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Status filter">
            <button
              type="button"
              aria-pressed={statusFilter === null}
              onClick={() => setStatusFilter(null)}
              className={cn(CHIP, statusFilter === null ? 'border-transparent bg-nw-accent text-nw-on-accent shadow-segment' : 'border-nw-border bg-nw-panel text-nw-text hover:bg-nw-hover')}
            >
              Show all
              <span className={cn(CHIP_COUNT, statusFilter === null ? 'bg-nw-panel/25 text-nw-on-accent' : 'bg-nw-subtle text-nw-text-2')}>{board.data?.rows.length ?? 0}</span>
            </button>
            {DISPATCH_STATUS_DEFS.filter((s) => (statusCounts.get(s.code) ?? 0) > 0).map((s) => {
              const on = statusFilter === s.code;
              return (
                <button
                  key={s.code}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setStatusFilter(on ? null : s.code)}
                  className={cn(CHIP, on ? cn(FAMILY_CELL[s.family], 'border-current shadow-segment') : 'border-nw-border bg-nw-panel hover:bg-nw-hover')}
                >
                  <StatusSymbol family={s.family} size={12} className={FAMILY_TEXT[s.family]} />
                  <span className={FAMILY_TEXT[s.family]}>{s.code}</span>
                  <span className={cn(CHIP_COUNT, on ? 'bg-nw-panel text-nw-text' : 'bg-nw-subtle text-nw-text-2')}>{statusCounts.get(s.code)}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {board.isError ? (
        <ErrorState error={board.error} onRetry={() => void board.refetch()} />
      ) : (
        /* The grid and the panel share one row: the board keeps its day, its filters and its
           scroll while the work is finished beside it. */
        <div className="flex min-h-0 items-stretch gap-0">
        <div className={cn(GRID.frame, 'min-w-0 flex-1')} tabIndex={0} onKeyDown={sheet.onKeyDown} onPaste={sheet.onPaste} style={{ maxHeight: 'calc(100vh - 190px)', outline: 'none' }}>
          <table className="nw-board w-full border-collapse"
            style={{ minWidth: COLS.reduce((s, c) => s + COL_WIDTH[c], 0) + (view === 'flat' ? FLAT_ORDINAL + FLAT_DISPATCHER + 1 : 0) }} role="grid" aria-label="Daily board">
            <colgroup>
              {view === 'flat' ? <col style={{ width: FLAT_ORDINAL }} /> : null}
              {COLS.map((c) => (
                <col key={c} style={{ width: c === 'status' && view === 'flat' ? 110 : COL_WIDTH[c] }} />
              ))}
              {view === 'flat' ? <col style={{ width: FLAT_DISPATCHER }} /> : null}
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr>
                {view === 'flat' ? <th className={GRID.headNavy}>#</th> : null}
                {COLS.map((c) => (
                  <th
                    key={c}
                    scope="col"
                    className={cn(GRID.headNavy, TYPED.has(c) && c !== 'status' && 'cursor-pointer hover:bg-nw-text/90')}
                    title={TYPED.has(c) && c !== 'status' ? 'Click to select the column' : undefined}
                    onClick={() => TYPED.has(c) && c !== 'status' && sheet.selectColumn(c)}
                  >
                    {COL_LABEL[c]}
                  </th>
                ))}
                {view === 'flat' ? <th className={GRID.headNavy}>Dispatcher</th> : null}
              </tr>
            </thead>
            <tbody>
              {board.isPending ? (
                <tr>
                  <td colSpan={colCount} className="px-4 py-10 text-center text-sm text-nw-text-3">
                    Loading…
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="px-4 py-10 text-center text-sm text-nw-text-3">
                    {board.data?.rows.length === 0 ? 'No drivers on the board yet.' : 'No drivers match.'}
                  </td>
                </tr>
              ) : view === 'teams' ? (
                teams.map((team) => (
                  <TeamBand
                    key={team.id}
                    teamNumber={team.teamNumber}
                    name={team.id === UNASSIGNED ? 'Unassigned drivers' : team.label}
                    fullName={team.id === UNASSIGNED ? undefined : team.fullName}
                    unassigned={team.id === UNASSIGNED}
                    count={team.rows.length}
                    collapsed={collapsed.has(team.id)}
                    colSpan={COLS.length}
                    onAdd={canManage && team.id !== UNASSIGNED ? () => setAdding({ id: team.id, name: team.name }) : undefined}
                    onSeparate={canSeparate && team.id !== UNASSIGNED && (team.teamNumber !== null || (team.fullName ?? team.name).includes('/')) ? () => setSeparatingTeam({ id: team.id, name: team.label }) : undefined}
                    onToggle={() => toggleTeam(team.id)}
                  >
                    {team.rows.map((row) => (
                      <BoardRow
                        key={row.driverId}
                        row={row}
                        sheet={sheet}
                        nowIso={nowIso}
                        canWrite={canWrite}
                        canManage={canManage}
                        flat={false}
                        ordinal={0}
                        onStatus={chooseStatus}
                       
                        onHistory={() => setHistory({ id: row.driverId, name: row.driverName })}
                        onEdit={() => openEdit(row)}
                        onCreateFile={canCreateFile ? () => createFileFor(row) : undefined}
                      />
                    ))}
                  </TeamBand>
                ))
              ) : (
                visible.map((row, i) => (
                  <BoardRow
                    key={row.driverId}
                    row={row}
                    sheet={sheet}
                    nowIso={nowIso}
                    canWrite={canWrite}
                    canManage={canManage}
                    flat
                    ordinal={i + 1}
                    onStatus={chooseStatus}
                   
                    onHistory={() => setHistory({ id: row.driverId, name: row.driverName })}
                    onEdit={() => openEdit(row)}
                    onCreateFile={canCreateFile ? () => createFileFor(row) : undefined}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
        {pending ? (
          <StatusActionPanel
            pending={pending}
            onCancel={() => setPending(null)}
            onPlainStatus={(row, status) => {
              setStatus(row, status);
              setPending(null);
            }}
            onDone={() => setPending(null)}
          />
        ) : null}
        </div>
      )}

      <UndoBar sheet={sheet} />
      {history ? <HistoryPopup driverId={history.id} driverName={history.name} onClose={() => setHistory(null)} /> : null}
      {adding !== false ? <AddDriverDialog open onClose={() => setAdding(false)} team={adding ?? undefined} /> : null}
      {importing ? <ImportRosterDialog open onClose={() => setImporting(false)} /> : null}
      {ordering ? <TeamOrderDialog open onClose={() => setOrdering(false)} /> : null}
      {editing ? <EditDriverDialog row={editing} week={day} onClose={() => setEditing(null)} /> : null}
      {separatingTeam ? <SeparateDispatchersDialog dispatcherId={separatingTeam.id} teamName={separatingTeam.name} week={day} onClose={() => setSeparatingTeam(null)} /> : null}
      {fileFor ? <CreateDriverFileDialog row={fileFor} onClose={() => setFileFor(null)} /> : null}
    </div>
  );
}

function TeamBand({ name, fullName, teamNumber, unassigned, count, collapsed, colSpan, onToggle, onAdd, onSeparate, children }: { name: string; fullName?: string; teamNumber: number | null; unassigned: boolean; count: number; collapsed: boolean; colSpan: number; onToggle: () => void; onAdd?: () => void; onSeparate?: () => void; children: React.ReactNode }) {
  return (
    <>
      <tr className={unassigned ? 'bg-(--bd-amber-bg)' : GRID.band}>
        <td colSpan={colSpan} className="h-9 border-b border-(--bd-border) px-2 align-middle">
          <div className="flex items-center gap-2">
            <button type="button" onClick={onToggle} className="inline-flex items-center gap-2" aria-expanded={!collapsed}>
              <ChevronDown className={cn('size-3.5 text-nw-text-3 transition-transform', collapsed && '-rotate-90')} aria-hidden />
              <span title={fullName} className={cn('text-[13px] font-bold tracking-[.04em] uppercase', unassigned ? 'text-(--bd-amber-text)' : 'text-nw-accent-ink')}>{name}</span>
              {!unassigned && teamNumber !== null ? <span className="inline-flex h-5 items-center rounded bg-nw-accent px-1.5 text-[11px] font-extrabold text-nw-on-accent uppercase">Team {teamNumber}</span> : null}
              <span className={GRID.chipGrey}>{count}</span>
            </button>
            {onSeparate ? (
              <button type="button" onClick={onSeparate} className={cn(GRID.pillBlue, onAdd ? 'ml-auto' : 'ml-auto')} title="Two dispatchers run this team: separate them">
                Separate
              </button>
            ) : null}
            {onAdd ? (
              <button type="button" onClick={onAdd} className={cn(GRID.pillBlue, onSeparate ? 'gap-1' : 'ml-auto gap-1')}>
                <Plus className="size-3" aria-hidden /> Add driver
              </button>
            ) : null}
          </div>
        </td>
      </tr>
      {collapsed ? null : children}
    </>
  );
}

function BoardRow({ row, sheet, nowIso, canWrite, canManage, flat, ordinal, onStatus, onHistory, onEdit }: { row: DailyBoardRow; sheet: ReturnType<typeof useSheet>; nowIso: string; canWrite: boolean; canManage: boolean; flat: boolean; ordinal: number; onStatus: (row: DailyBoardRow, status: string) => void; onHistory: () => void; onEdit: () => void; onCreateFile?: () => void }) {
  const { toast } = useToast();
  const def = statusDef(row.status);
  const [menuOpen, setMenuOpen] = useState(false);
  const tint = (c: string) => TINT_CLASS[row.fills[c] ?? 0];
  const r = row.driverId;
  const late = row.primaryLoad && row.status === 'ENROUTE' && Date.parse(row.primaryLoad.deliveryAt) < Date.parse(nowIso);
  /* Marked off with freight still on them: flagged for a person, never resolved by the machine. */
  const offWithLoad = row.primaryLoad && row.status !== null && OFF_DUTY_STATUSES.has(row.status);
  const since = sinceTone(row.statusSince, nowIso);
  return (
    <tr data-driver={row.driverNumber}>
      {flat ? <td className={cn(GRID.ro, 'tabular')}>{ordinal}</td> : null}
      {/* LOAD # is never typed (owner, 2026-10-13): it is the load on the driver, and only that. */}
      <SheetCell sheet={sheet} r={r} c="load_number" text="" typed={Boolean(typedCell(row, 'load_number'))} editable={false} tint={tint('load_number')}>
        {/* The current load, and it opens. A typed value with no record keeps its old badge. */}
        {row.primaryLoad ? (
          <Link
            to="/loads/$loadNumber"
            params={{ loadNumber: row.primaryLoad.loadNumber }}
            className="font-semibold text-nw-text hover:underline"
            onClick={(e) => e.stopPropagation()}
            title={`${boardLoadLabel(row.primaryLoad)} · ${tripText(row.primaryLoad)}`}
          >
            {/* The broker reference only, in black; the load number when there is none (owner, 2026-10-26). */}
            {row.primaryLoad.brokerReference?.trim() || row.primaryLoad.loadNumber}
          </Link>
        ) : null}
        {/* The load needs a person (rule 1.10): a small mark in the cell's corner, so the reference
            stays whole and centred (owner, 2026-10-26). The amber "update due" mark is not shown on
            the board (owner, 2026-10-27: documents are uploaded from the board itself). */}
        {row.primaryLoad?.openFlags ? (
          <span className="absolute top-0.5 right-0.5 flex gap-0.5">
            <span className={cn(GRID.badgeRed, 'h-3 px-0.5 text-[8.5px]')} title={`${row.primaryLoad.openFlags} open flag${row.primaryLoad.openFlags === 1 ? '' : 's'} on ${row.primaryLoad.loadNumber}`}>
              ⚑{row.primaryLoad.openFlags}
            </span>
          </span>
        ) : null}
        {/* Only the real load shows (owner, 2026-10-13): a number typed in the past, or a load that
            was removed, no longer lingers in LOAD #. */}
      </SheetCell>
      {/* The name is a read-only sheet cell: click selects it, Ctrl+C copies it, the text can be
          dragged over. Right-click opens the history; admins get a pencil for the driver. */}
      <SheetCell
        sheet={sheet}
        r={r}
        c="name"
        text=""
        typed={false}
        editable={false}
        sizeToContent
        className="group"
        title="Right-click: edit history"
        onContextMenu={(e) => {
          e.preventDefault();
          onHistory();
        }}
      >
        <span className="flex items-center justify-center gap-1.5">
          {row.cdlHold.length > 0 ? (
            <span className={GRID.badgeRed} title={row.cdlHold.join(' · ')}>
              Hold
            </span>
          ) : null}
          <span className="text-nw-text select-text">
            {row.driverName}
            {row.coDriver ? <span> // {row.coDriver}</span> : null}
          </span>
          {row.payTag ? <span className={GRID.chipGrey}>{row.payTag}</span> : null}
          {canManage ? (
            <button
              type="button"
              aria-label="Edit driver"
              title="Edit driver"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              className="ml-0.5 rounded p-0.5 text-nw-text-3 opacity-0 group-hover:opacity-100 hover:bg-nw-hover hover:text-nw-text focus:opacity-100"
            >
              <Pencil className="size-3" aria-hidden />
            </button>
          ) : null}
        </span>
      </SheetCell>
      <SheetCell sheet={sheet} r={r} c="truck" text="" typed={Boolean(row.cells.truck)} editable={canWrite} tint={tint('truck')} title={row.truckConflict ? 'Another row runs this truck number' : undefined}>
        {cellText(row, 'truck')}
        {row.truckConflict ? <span className="ml-1 text-nw-warning-text" aria-label="Shared truck number">!</span> : null}
        {/* A PTI defect not yet fixed on this truck (owner, 2026-10-21), as the Trucks list shows it. */}
        <BoardPtiIssueMark unitNumber={cellText(row, 'truck') || row.truckUnit} />
      </SheetCell>
      <SheetCell sheet={sheet} r={r} c="trailer" text="" typed={Boolean(row.cells.trailer)} editable={canWrite} tint={tint('trailer')}>
        {cellText(row, 'trailer')}
      </SheetCell>
      <SheetCell sheet={sheet} r={r} c="phone" text="" typed={Boolean(row.cells.phone)} editable={canWrite} tint={tint('phone')} className="tabular">
        {phoneParts(cellText(row, 'phone')).map((p, i) =>
          p.kind === 'tel' ? (
            <a key={i} href={`tel:${p.value.replace(/[^\d+]/g, '')}`} onMouseDown={(e) => e.stopPropagation()} className="text-nw-text hover:underline">
              {p.value}
            </a>
          ) : p.kind === 'sep' ? (
            <span key={i} className="text-nw-text-3">{p.value}</span>
          ) : (
            <span key={i}>{p.value}</span>
          ),
        )}
      </SheetCell>
      <td
        role="gridcell"
        className={cn('relative h-[26px] border-r border-b border-(--bd-border) p-0 text-center align-middle', def ? STATUS_CELL[def.code] : 'bg-nw-panel')}
        onContextMenu={(e) => {
          e.preventDefault();
          onHistory();
        }}
      >
        <DropdownMenu
          align="start"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          trigger={
            <button
              type="button"
              disabled={!canWrite}
              // Open-only: a second click (the board's "click, click again" habit) never closes
              // the menu on the way in. It closes on a choice, a click elsewhere or Escape.
              onPointerDown={(e) => {
                if (!canWrite || e.button !== 0) return;
                e.preventDefault();
                setMenuOpen(true);
              }}
              style={{ outline: 'none' }}
              // `whitespace-nowrap` and a non-shrinking chevron keep the caret on the
              // status's own line: without them a long code ("HOLD FOR LOAD") wraps and
              // pushes the arrow onto a second line, which doubles the row's height.
              className="flex h-[26px] w-full min-w-0 items-center justify-center gap-0 overflow-hidden px-0.5 text-[13px] font-normal tracking-tight whitespace-nowrap uppercase disabled:cursor-default"
            >
              <span className="truncate">{def?.code ?? row.status ?? ''}</span>
              {canWrite ? <ChevronDown className="size-2.5 shrink-0 opacity-70" aria-hidden /> : null}
            </button>
          }
        >
          {DISPATCH_STATUS_DEFS.map((s) => (
            <MenuItem key={s.code} onSelect={() => onStatus(row, s.code)}>
              <span className={cn('mr-2 inline-block size-3 rounded-sm', STATUS_SWATCH[s.code])} aria-hidden /><span className="font-bold">{s.code}</span>
              {s.off ? <span className="ml-2 text-[10px] text-nw-text-3">off</span> : null}
            </MenuItem>
          ))}
        </DropdownMenu>
      </td>
      <td className={cn(GRID.ro, 'tabular', FAMILY_TEXT[since === 'urgent' ? 'urgent' : since === 'warning' ? 'warning' : 'neutral'])} title={row.statusSince ? `Status set ${formatIsoDate(row.statusSince.slice(0, 10))}` : undefined}>
        {sinceLabel(row.statusSince, nowIso)}
      </td>
      <SheetCell sheet={sheet} r={r} c="eta" text="" typed={Boolean(typedCell(row, 'eta'))} editable={canWrite} tint={tint('eta')}>
        {cellText(row, 'eta')}
      </SheetCell>
      <SheetCell sheet={sheet} r={r} c="miles" text="" typed={Boolean(typedCell(row, 'miles'))} editable={canWrite} tint={tint('miles')} className="tabular">
        {cellText(row, 'miles')}
      </SheetCell>
      <SheetCell sheet={sheet} r={r} c="route" text="" typed={Boolean(typedCell(row, 'route'))} editable={canWrite} tint={tint('route')} title={cellText(row, 'route')}>
        {cellText(row, 'route')}
      </SheetCell>
      <SheetCell sheet={sheet} r={r} c="notes" text="" typed={Boolean(row.cells.notes)} editable={canWrite} tint={tint('notes')} className={cn('text-left', !flat && 'border-r-0')} title={cellText(row, 'notes')}>
        <span className="flex items-center gap-1">
          {late ? (
            <Badge tone="danger" size="sm">
              late
            </Badge>
          ) : null}
          {offWithLoad ? (
            <Badge tone="danger" size="sm" title={`${row.primaryLoad!.loadNumber} is still assigned to ${row.driverName}. Reassign it or release the driver.`}>
              {row.primaryLoad!.loadNumber} still assigned
            </Badge>
          ) : null}
          {/* Prebooks: click copies the broker reference alone, as LOAD # shows it (owner, 2026-10-26). */}
          {row.queuedLoads.map((l) => {
            const label = l.brokerReference?.trim() || l.loadNumber;
            return (
              <button
                key={l.id}
                type="button"
                className="cursor-copy rounded-full focus-visible:outline-2 focus-visible:outline-nw-accent"
                title={`${tripText(l)} · click to copy ${label}`}
                aria-label={`Copy ${label}`}
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  void copyText(label).then(() => toast({ tone: 'success', title: 'Copied', description: label }));
                }}
              >
                <Badge tone="info" size="sm">{label}</Badge>
              </button>
            );
          })}
          <span className="truncate">{cellText(row, 'notes')}</span>
        </span>
      </SheetCell>
      {flat ? (
        <td className={cn(GRID.ro, 'truncate border-r-0')} title={row.dispatcherNickname ? (row.dispatcherFullName ?? row.dispatcherName) : undefined}>
          {row.dispatcherNickname || row.dispatcherName || '—'}
        </td>
      ) : null}
    </tr>
  );
}

/** The typed cell the row shows: one typed for the load before the current one gives way (owner, 2026-10-27). */
function typedCell(row: DailyBoardRow, c: string) {
  const cell = row.cells[c];
  return cell && !cell.earlierLoad ? cell : undefined;
}

/** What a typed column shows: the typed cell, else the automatic value. A typed empty stays empty. */
function cellText(row: DailyBoardRow, c: string): string {
  const cell = typedCell(row, c);
  if (cell) return cell.value ?? '';
  return row.auto[c] ?? '';
}

function readOnlyText(row: DailyBoardRow, c: Col, nowIso: string): string {
  if (c === 'name') return row.coDriver ? `${row.driverName} // ${row.coDriver}` : row.driverName;
  if (c === 'since') return sinceLabel(row.statusSince, nowIso);
  return '';
}

/** The whole trip for a tooltip; with receivers still ahead, the one the truck is driving to now. */
function tripText(l: { origin: string; destination: string; finalDestination?: string; deliveriesLeft?: number }): string {
  const end = l.finalDestination || l.destination;
  const more = (l.deliveriesLeft ?? 0) > 1 ? ` · next drop ${l.destination}, ${l.deliveriesLeft} drops left` : '';
  return `${l.origin} → ${end}${more}`;
}
