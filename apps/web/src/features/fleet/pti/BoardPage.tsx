import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Calendar, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ptiWeekStartOf, type PtiBoardRow } from '@neway/shared';
import { Badge, Card, Drawer, EmptyState, ErrorState, Input, cn } from '@/design-system';
import { today as companyToday } from '@/lib/clock';
import { formatIsoDate } from '@/lib/format';
import { weekRangeLabel } from '../pti-week-label';
import { usePtiBoard } from './api';
import { matchesSearch, sortRows, stripe } from './board-model';
import {
  BOARD_KINDS,
  BOARD_KIND_LABEL,
  driverPti,
  boardKind,
  defectMeta,
  holdingCount,
  kindCounts,
  listedDefects,
  GROUP_LABEL,
  GROUP_ORDER,
  groupInFilter,
  groupOf,
  rowButton,
  statusPill,
  type BoardKind,
  type GroupKind,
} from './board-view';
import { workOrderLink } from './links';
import { ptiSearchSchema } from '../pti-search';
import { DriverPtiList, DriverPtiTile } from './DriverPtiCard';
import { ReviewForm } from './ReviewForm';
import { useLeaveGuard } from '../pm/useLeaveGuard';

/**
 * Pre-trip inspections, as the owner drew them (2026-09-22): four counters that are also the
 * filters, one table with a group per counter and one button per row that says what it does,
 * and - when a row is opened - the review form in place of the board, with a way back.
 * `?review=<unitId>` keeps a review addressable.
 */
export function PtiBoardPage() {
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const reviewing = useMemo(() => ptiSearchSchema.parse(rawSearch).review ?? null, [rawSearch]);

  const [week, setWeek] = useState(() => ptiWeekStartOf(companyToday()));
  const [filter, setFilter] = useState<BoardKind | 'all' | null>(null);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [search, setSearch] = useState('');

  const board = usePtiBoard(week);
  const rows = useMemo(() => sortRows(board.data?.rows ?? []), [board.data]);
  const counts = useMemo(() => kindCounts(rows), [rows]);
  const holding = useMemo(() => holdingCount(rows), [rows]);
  const drivers = useMemo(() => driverPti(rows), [rows]);
  const [driversOpen, setDriversOpen] = useState(false);
  // Nothing chosen yet: issues first, then the videos nobody looked at, then the ones owed.
  const chosen: BoardKind | 'all' =
    filter ?? (['open', 'rev', 'miss'] as const).find((k) => counts[k] > 0) ?? 'all';
  // A search looks through every group, whichever counter is chosen (owner, 2026-10-26: unit 0017
  // was "not on the board" because it sat in another group than the one on screen).
  const searching = search.trim() !== '';
  const active: BoardKind | 'all' = searching ? 'all' : chosen;
  const today = board.data?.today ?? companyToday();
  const currentWeek = ptiWeekStartOf(companyToday());

  const openReview = (unitId: string | null, replace = false) =>
    void navigate({
      to: '/fleet/pti',
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev };
        if (unitId) next.review = unitId;
        else delete next.review;
        return next;
      },
      replace,
      resetScroll: false,
    });

  const selected = rows.find((r) => r.inspection.unitId === reviewing) ?? null;
  // A click outside, the X or Cancel asks before the review is lost, as the oil-change sheet does.
  // Once this review is saved, closing it no longer asks (owner, 2026-10-05).
  const [savedReview, setSavedReview] = useState<string | null>(null);
  const saved = selected !== null && savedReview === selected.inspection.id;
  const leave = useLeaveGuard(false, () => openReview(null), !saved);

  return (
    <div className="flex w-full flex-col gap-4">
      {/* The review opens beside the board, as the owner asked (2026-09-22), never on a page of its own. */}
      <Drawer
        open={Boolean(reviewing && selected)}
        onOpenChange={(open) => {
          if (!open) leave.requestClose();
        }}
        size="xl"
        className="md:w-180"
        title={selected ? `PTI review · Unit ${selected.inspection.unitNumber}` : 'PTI review'}
      >
        {selected ? (
          <ReviewForm
            key={selected.inspection.id}
            row={selected}
            week={week}
            onCancel={leave.requestClose}
            onSavedNext={null}
            onSaved={() => setSavedReview(selected.inspection.id)}
          />
        ) : null}
      </Drawer>
      {leave.dialog}
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-[21px] font-extrabold tracking-[-.022em] text-nw-text">
          Pre-trip inspections
        </h1>
        <div
          className="flex items-center gap-1 rounded-lg border border-nw-border bg-nw-panel p-0.5"
          role="group"
          aria-label="Week"
        >
          <button
            type="button"
            aria-label="Previous week"
            onClick={() => setWeek(addDays(week, -7))}
            className="grid size-7 place-items-center rounded-md text-nw-text-2 hover:bg-nw-hover"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <span className="inline-flex items-center gap-1.5 px-2 text-[13px] font-semibold text-nw-text">
            <Calendar className="size-3.5 text-nw-text-3" aria-hidden />
            {weekRangeLabel(week)}
          </span>
          <button
            type="button"
            aria-label="Next week"
            disabled={week >= addDays(currentWeek, 7)}
            onClick={() => setWeek(addDays(week, 7))}
            className="grid size-7 place-items-center rounded-md text-nw-text-2 hover:bg-nw-hover disabled:opacity-40"
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </div>
        {board.data ? (
          <span className="text-xs text-nw-text-3">
            {rows.length} {rows.length === 1 ? 'truck' : 'trucks'}
          </span>
        ) : null}
      </header>

      {/* Counters are filters: tap one. */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5" role="group" aria-label="Filter">
        {BOARD_KINDS.map((kind) => {
          const on = active === kind;
          const sub = kind === 'open' ? `${holding} holding a truck` : BOARD_KIND_LABEL[kind].sub;
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={on}
              onClick={() => {
                setFilter(on ? 'all' : kind);
                setCleanOpen(kind === 'clean' && !on);
                setSearch('');
              }}
              className={cn(
                'rounded-[10px] border border-nw-border border-t-[3px] bg-nw-panel px-3.5 py-3 text-left hover:bg-nw-hover',
                COUNTER_TOP[kind],
                on && 'outline-2 -outline-offset-2 outline-nw-accent',
              )}
            >
              <span className="tabular block text-[25px] leading-[1.05] font-extrabold tracking-[-.03em] text-nw-text">
                {board.data ? counts[kind] : '…'}
              </span>
              <span className="mt-0.5 block text-[12.5px] font-bold text-nw-text">
                {BOARD_KIND_LABEL[kind].title}
              </span>
              <span className="mt-0.5 block text-[10.5px] text-nw-text-3">{sub}</span>
            </button>
          );
        })}
        <DriverPtiTile summary={drivers} loading={!board.data} on={driversOpen} onToggle={() => setDriversOpen(!driversOpen)} />
      </div>

      {driversOpen && board.data ? <DriverPtiList summary={drivers} current={week === currentWeek} onOpen={(unitId) => openReview(unitId)} /> : null}

      <Card padding="none" className="overflow-hidden">
        <div className="border-b border-nw-border p-3">
          <Input
            size="sm"
            type="search"
            prefix={<Search />}
            aria-label="Search unit, driver, defect or RO"
            placeholder="Search unit, driver, defect or RO number…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-md"
          />
        </div>
        {board.isPending ? (
          <p className="px-5 py-10 text-center text-sm text-nw-text-3">Loading…</p>
        ) : board.isError ? (
          <ErrorState error={board.error} onRetry={() => void board.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No trucks on this week's board"
            description="A row opens for every eligible truck when the week is looked at."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse" aria-label="Trucks">
              <thead>
                <tr className="border-b border-nw-border bg-nw-subtle text-left text-[10px] font-extrabold tracking-[.08em] text-nw-text-3 uppercase">
                  <th className="px-3 py-2.5 pl-[15px]">Unit / driver</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Last inspection</th>
                  <th className="min-w-[210px] px-3 py-2.5">Open issues</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {GROUP_ORDER.filter((k) => groupInFilter(k, active)).map((kind) => {
                  const group = rows.filter((r) => groupOf(r) === kind && matchesSearch(r, search));
                  // A group with nobody in it is not listed; its counter already says 0.
                  if (group.length === 0) return null;
                  // A search shows its matches, even in the folded Clean group.
                  const collapsed = kind === 'clean' && !cleanOpen && !searching;
                  return (
                    <GroupRows
                      key={kind}
                      kind={kind}
                      rows={group}
                      collapsed={collapsed}
                      today={today}
                      onToggle={() => setCleanOpen((v) => !v)}
                      onOpen={(unitId) => openReview(unitId)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-[11.5px] leading-[1.7] text-nw-text-3">
        Counters are filters — tap one. Each row&apos;s button says what it does, so nobody has to
        guess.
        <br />
        <b className="font-bold text-nw-text-2">Clean trucks collapse</b>, because rows that need
        nothing are noise.
      </p>
    </div>
  );
}

/** Each section wears its family: red for missing, amber for issues, blue to review, green clean. */
const GROUP_HEAD: Record<GroupKind, string> = {
  awaiting: 'bg-nw-neutral-bg text-nw-neutral-text border-l-nw-neutral-icon',
  miss: 'bg-nw-urgent-bg text-nw-urgent-text border-l-nw-urgent-icon',
  rev: 'bg-nw-moving-bg text-nw-moving-text border-l-nw-moving-icon',
  open: 'bg-nw-warning-bg text-nw-warning-text border-l-nw-warning-icon',
  clean: 'bg-nw-done-bg text-nw-done-text border-l-nw-done-icon',
};

const COUNTER_TOP: Record<BoardKind, string> = {
  miss: 'border-t-nw-urgent-icon',
  rev: 'border-t-nw-moving-icon',
  open: 'border-t-nw-warning-icon',
  clean: 'border-t-nw-done-icon',
};

const STRIPE: Record<string, string> = {
  red: 'border-l-nw-urgent-icon',
  amber: 'border-l-nw-warning-icon',
  blue: 'border-l-nw-moving-icon',
};

function GroupRows({
  kind,
  rows,
  collapsed,
  today,
  onToggle,
  onOpen,
}: {
  kind: GroupKind;
  rows: PtiBoardRow[];
  collapsed: boolean;
  today: string;
  onToggle: () => void;
  onOpen: (unitId: string) => void;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={5}
          className={cn(
            'border-l-[3px] px-3 py-1.5 pl-[12px] text-[10px] font-extrabold tracking-[.09em] uppercase',
            GROUP_HEAD[kind],
          )}
        >
          {GROUP_LABEL[kind]} <span className="font-bold opacity-80">· {rows.length}</span>
        </td>
      </tr>
      {rows.length === 0 ? (
        <tr>
          <td colSpan={5} className="px-3 py-3 pl-[15px] text-xs text-nw-text-3">
            Nobody here this week.
          </td>
        </tr>
      ) : collapsed ? (
        <tr>
          <td colSpan={5} className="px-3 py-3 pl-[15px] text-xs text-nw-text-3">
            {rows.length} {rows.length === 1 ? 'truck' : 'trucks'} reviewed and clear —{' '}
            <button
              type="button"
              onClick={onToggle}
              className="font-semibold text-nw-accent-ink hover:underline"
            >
              show them
            </button>
          </td>
        </tr>
      ) : (
        <>
          {rows.map((row) => (
            <UnitRow key={row.inspection.unitId} row={row} today={today} onOpen={onOpen} />
          ))}
          {kind === 'clean' ? (
            <tr>
              <td colSpan={5} className="px-3 py-3 pl-[15px] text-xs text-nw-text-3">
                <button
                  type="button"
                  onClick={onToggle}
                  className="font-semibold text-nw-accent-ink hover:underline"
                >
                  collapse
                </button>
              </td>
            </tr>
          ) : null}
        </>
      )}
    </>
  );
}

function UnitRow({
  row,
  today,
  onOpen,
}: {
  row: PtiBoardRow;
  today: string;
  onOpen: (unitId: string) => void;
}) {
  const { inspection, latestReviewed } = row;
  const pill = statusPill(row);
  const button = rowButton(row);
  const defects = listedDefects(row);
  const kind = boardKind(row);
  const s = stripe(row);

  // Last inspection: the review, else the video, else the last reviewed week, else nothing.
  const last = inspection.reviewedAt
    ? {
        date: formatIsoDate(inspection.reviewedAt.slice(0, 10)),
        by: inspection.reviewerName ?? '—',
        old: false,
        warn: false,
      }
    : inspection.receivedAt
      ? {
          date: formatIsoDate(inspection.receivedAt.slice(0, 10)),
          by: `waiting ${row.ageDays} ${row.ageDays === 1 ? 'day' : 'days'}`,
          old: false,
          warn: true,
        }
      : latestReviewed
        ? {
            date: formatIsoDate(latestReviewed.reviewedAt.slice(0, 10)),
            by: `${weeksAgo(latestReviewed.reviewedAt, today)} ago`,
            old: true,
            warn: false,
          }
        : { date: 'Never', by: 'no inspection on record', old: true, warn: false };

  const buttonClass = cn(
    'inline-flex h-[29px] items-center rounded-[7px] border px-2.5 text-xs font-semibold whitespace-nowrap',
    button.look === 'primary' &&
      'border-nw-accent bg-nw-accent text-nw-on-accent hover:bg-nw-accent-hover',
    button.look === 'danger' &&
      'border-nw-urgent-border bg-nw-urgent-bg text-nw-urgent-text hover:bg-nw-hover',
    button.look === 'plain' && 'border-nw-border-strong bg-nw-panel text-nw-text hover:bg-nw-hover',
  );

  return (
    <tr
      className="border-b border-nw-border last:border-b-0 hover:bg-nw-hover"
      data-unit={inspection.unitNumber}
    >
      <td
        className={cn(
          'border-l-[3px] border-l-transparent py-2.5 pr-3 pl-[12px] align-middle',
          s ? STRIPE[s] : null,
        )}
      >
        <span className="block text-[13.5px] font-bold tracking-[-.01em] text-nw-text">
          {inspection.unitNumber}
        </span>
        {inspection.driverName ? (
          <span className="block text-[11px] text-nw-text-3">
            {inspection.driverName}
            {inspection.dispatcherName ? ` · ${inspection.dispatcherName}` : ''}
          </span>
        ) : (
          <span className="block text-[11px] font-semibold text-nw-urgent-text">
            No driver assigned
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 align-middle">
        <Badge tone={pill.tone} size="sm" className="uppercase tracking-[.05em]">
          {pill.label}
        </Badge>
      </td>
      <td className="px-3 py-2.5 align-middle">
        <span
          className={cn(
            'block text-xs font-semibold',
            last.old ? 'text-nw-text-3' : 'text-nw-text',
          )}
        >
          {last.date}
        </span>
        <span
          className={cn(
            'block text-[10.5px]',
            last.warn ? 'font-semibold text-nw-warning-text' : 'text-nw-text-3',
          )}
        >
          {last.by}
        </span>
      </td>
      <td className="px-3 py-2.5 align-middle">
        {defects.length > 0 ? (
          <span className="flex flex-col gap-1.5">
            {defects.slice(0, 2).map((d) => (
              <span key={d.id}>
                <span className="block text-xs leading-[1.35] font-semibold text-nw-text">
                  {d.componentName} — {d.description}
                </span>
                <span className="block text-[10.5px] text-nw-text-3">{defectMeta(d, today)}</span>
              </span>
            ))}
            {defects.length > 2 ? (
              <span className="text-[10.5px] text-nw-text-3">+{defects.length - 2} more</span>
            ) : null}
          </span>
        ) : kind === 'rev' ? (
          <span className="text-[11.5px] text-nw-text-3">Unknown until reviewed</span>
        ) : (
          <span className="text-[11.5px] text-nw-text-3">None</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right align-middle">
        {button.kind === 'open_ro' && button.defect?.workOrderId ? (
          <Link {...workOrderLink(button.defect.workOrderId)} className={buttonClass}>
            {button.label}
          </Link>
        ) : (
          <button type="button" onClick={() => onOpen(inspection.unitId)} className={buttonClass}>
            {button.label}
          </button>
        )}
      </td>
    </tr>
  );
}

function weeksAgo(iso: string, today: string): string {
  const days = Math.max(
    0,
    Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(iso)) / 86_400_000),
  );
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'}`;
  const weeks = Math.round(days / 7);
  return `${weeks} ${weeks === 1 ? 'week' : 'weeks'}`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
