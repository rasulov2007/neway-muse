import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Calendar, CircleCheck, Droplet, Gauge, Search, Settings2, Truck } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { PM_SETTINGS, type PmBoardRow } from '@neway/shared';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  StatusSymbol,
  cn,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { formatDate } from '@/lib/format';
import { useAssignees, usePmBoard, usePmShops } from './api';
import {
  dueText,
  intervalPct,
  isOverdue,
  milesAtLastReading,
  matchesSearch,
  rowFamily,
  type RowFamily,
} from './board-model';
import { oilChangeSearchSchema } from './search';
import { RecordPmSheet } from './RecordPmSheet';
import { SchedulePmSheet } from './SchedulePmSheet';
import { UpdateReadingDialog } from './UpdateReadingDialog';
import { TruckTypeDialog } from './TruckTypeDialog';

const n = (v: number) => v.toLocaleString('en-US');

type View = 'all' | 'overdue' | 'due_soon' | 'ok';

function inView(row: PmBoardRow, view: View): boolean {
  switch (view) {
    case 'all':
      return true;
    case 'overdue':
      return isOverdue(row);
    case 'due_soon':
      return row.dueStatus === 'due_soon';
    case 'ok':
      return row.dueStatus === 'ok';
  }
}

/**
 * Oil changes as the owner drew them (2026-09-20): four numbers that filter one schedule. Every
 * row is the PM engine's verdict for a truck - the odometer it was read at, the last change, how
 * much of the interval is used, where it is due and by how far - and one action: book it, or
 * log the change once it is done. A booked service does not un-overdue a unit; only a recorded
 * oil change moves the clock.
 */
export function OilChangePage() {
  const account = useAccount();
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const params = useMemo(() => oilChangeSearchSchema.parse(rawSearch), [rawSearch]);

  const [search, setSearch] = useState('');
  const [view, setView] = useState<View>('all');
  const [reading, setReading] = useState<PmBoardRow | null>(null);
  const [types, setTypes] = useState(false);

  const board = usePmBoard();
  const seesCost = account?.permissions.includes('maintenance_costs.view') ?? false;
  const canWrite = account?.permissions.includes('maintenance.edit') ?? false;
  const assignees = useAssignees(canWrite);
  const shops = usePmShops();

  const rows = useMemo(() => board.data?.rows ?? [], [board.data]);
  const counts = useMemo(
    () => ({
      all: rows.length,
      overdue: rows.filter((r) => inView(r, 'overdue')).length,
      due_soon: rows.filter((r) => inView(r, 'due_soon')).length,
      ok: rows.filter((r) => inView(r, 'ok')).length,
    }),
    [rows],
  );
  const visible = useMemo(
    () => {
      const shown = rows.filter((row) => inView(row, view) && matchesSearch(row, search));
      // Trucks with no last change sink to the bottom, server order kept otherwise (owner, 2026-10-05).
      return [
        ...shown.filter((row) => row.dueStatus !== 'no_baseline'),
        ...shown.filter((row) => row.dueStatus === 'no_baseline'),
      ];
    },
    [rows, view, search],
  );
  const dueSoonMiles = Math.max(
    PM_SETTINGS.dueSoonMinMiles,
    Math.round(PM_SETTINGS.fleetIntervalMiles * PM_SETTINGS.dueSoonFraction),
  );

  const setSheet = (sheet: 'schedule' | 'record' | null, unitId?: string) =>
    void navigate({
      to: '/fleet/oil-change',
      search: () => {
        const out: Record<string, unknown> = {};
        if (sheet) out.sheet = sheet;
        if (sheet && unitId) out.unit = unitId;
        return out;
      },
      replace: params.sheet !== undefined,
      resetScroll: false,
    });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Oil changes"
        description={`Mileage-driven · ${n(PM_SETTINGS.fleetIntervalMiles)} mi interval · a booked service does not un-overdue a unit that is already past its limit`}
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Settings2 />}
              disabled={!canWrite}
              onClick={() => setTypes(true)}
            >
              Truck types
            </Button>
            <Button
              variant="primary"
              icon={<Droplet />}
              disabled={!canWrite}
              onClick={() => setSheet('record')}
            >
              Log oil change
            </Button>
          </>
        }
      />
      {types ? <TruckTypeDialog onClose={() => setTypes(false)} /> : null}

      {/* Four numbers; each is a filter on the schedule below. */}
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Tile
          family="urgent"
          icon={<Droplet />}
          label="Overdue"
          value={board.data ? counts.overdue : undefined}
          hint="past the interval"
          active={view === 'overdue'}
          onClick={() => setView(view === 'overdue' ? 'all' : 'overdue')}
        />
        <Tile
          family="warning"
          icon={<Gauge />}
          label={`Due ≤ ${n(dueSoonMiles)} mi`}
          value={board.data ? counts.due_soon : undefined}
          hint="book this week"
          active={view === 'due_soon'}
          onClick={() => setView(view === 'due_soon' ? 'all' : 'due_soon')}
        />
        <Tile
          family="done"
          icon={<CircleCheck />}
          label="On schedule"
          value={board.data ? counts.ok : undefined}
          hint="nothing to do"
          active={view === 'ok'}
          onClick={() => setView(view === 'ok' ? 'all' : 'ok')}
        />
        <Tile
          family="neutral"
          icon={<Truck />}
          label="All trucks"
          value={board.data ? counts.all : undefined}
          hint="trailers have no oil interval"
          active={view === 'all'}
          onClick={() => setView('all')}
        />
      </section>

      <Card padding="none" className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-nw-border px-4 py-3">
          <h2 className="text-sm font-bold text-nw-text">Service schedule</h2>
          <label className="flex h-8 w-[200px] items-center gap-2 rounded-lg border border-nw-border-strong bg-nw-field px-2.5 text-[12.5px] text-nw-text-3 focus-within:border-nw-accent">
            <Search className="size-3.5 shrink-0" aria-hidden />
            <input
              type="search"
              aria-label="Search unit or driver"
              placeholder="Unit or driver"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full min-w-0 bg-transparent text-nw-text outline-none placeholder:text-nw-text-3"
            />
          </label>
        </div>

        {board.isPending ? (
          <p className="px-5 py-10 text-center text-sm text-nw-text-3">Loading…</p>
        ) : board.isError ? (
          <ErrorState error={board.error} onRetry={() => void board.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No trucks on the schedule"
            description="A row opens for every active truck once the fleet has an oil-change interval."
          />
        ) : (
          <div className="max-h-[calc(100vh-180px)] overflow-auto">
            <table className="w-full min-w-[1040px] table-fixed border-collapse text-[13px]">
              <colgroup>
                <col style={{ width: 150 }} />
                <col style={{ width: 112 }} />
                <col style={{ width: 108 }} />
                <col />
                <col style={{ width: 96 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 140 }} />
                <col style={{ width: 96 }} />
              </colgroup>
              <thead>
                <tr className="border-b border-nw-border bg-nw-subtle text-left text-[11px] font-bold tracking-[.06em] text-nw-text-2 uppercase">
                  <Th>Unit</Th>
                  <Th className="text-right">Odometer</Th>
                  <Th>Last change</Th>
                  <Th>PM mileage</Th>
                  <Th className="text-right">Due at</Th>
                  <Th>Service status</Th>
                  <Th>Shop</Th>
                  <Th>Action</Th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <Row
                    key={row.unitId}
                    row={row}
                    canWrite={canWrite}
                    onBook={() => setSheet('schedule', row.unitId)}
                    onLog={() => setSheet('record', row.unitId)}
                    onReading={() => setReading(row)}
                  />
                ))}
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-5 py-10 text-center text-sm text-nw-text-3">
                      No trucks match. Clear the search or pick another number above.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-nw-border px-4 py-2 text-xs text-nw-text-3">
          {board.data
            ? `${visible.length} of ${rows.length} trucks · a booked service stays on the row until the oil change is logged`
            : 'Loading…'}
        </div>
      </Card>

      {params.sheet === 'schedule' ? (
        <SchedulePmSheet
          unitId={params.unit ?? null}
          rows={rows}
          shops={shops.data ?? []}
          assignees={assignees.data ?? []}
          seesCost={seesCost}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {params.sheet === 'record' ? (
        <RecordPmSheet
          unitId={params.unit ?? null}
          rows={rows}
          shops={shops.data ?? []}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {reading ? <UpdateReadingDialog row={reading} onClose={() => setReading(null)} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------ pieces

const TILE_ICON: Record<'urgent' | 'warning' | 'done' | 'neutral', string> = {
  urgent: 'bg-nw-urgent-bg text-nw-urgent-icon',
  warning: 'bg-nw-warning-bg text-nw-warning-icon',
  done: 'bg-nw-done-bg text-nw-done-icon',
  neutral: 'bg-nw-accent-tint text-nw-accent-ink',
};
const TILE_RING: Record<'urgent' | 'warning' | 'done' | 'neutral', string> = {
  urgent: 'border-nw-urgent-border',
  warning: 'border-nw-warning-border',
  done: 'border-nw-border',
  neutral: 'border-nw-border',
};

function Tile({
  family,
  icon,
  label,
  value,
  hint,
  active,
  onClick,
}: {
  family: 'urgent' | 'warning' | 'done' | 'neutral';
  icon: ReactNode;
  label: string;
  value: number | undefined;
  hint: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex flex-col gap-1 rounded-xl border bg-nw-panel px-4 py-3 text-left transition-colors hover:bg-nw-hover',
        value ? TILE_RING[family] : 'border-nw-border',
        active && 'border-nw-accent bg-nw-selected',
      )}
    >
      <span className="flex items-center gap-2 text-[11px] font-bold tracking-[.07em] text-nw-text-3 uppercase">
        <span
          className={cn(
            'grid size-6 place-items-center rounded-md [&_svg]:size-3.5',
            value ? TILE_ICON[family] : 'bg-nw-segment text-nw-text-2',
          )}
          aria-hidden
        >
          {icon}
        </span>
        {label}
      </span>
      <span className="tabular text-[26px] leading-[1.15] font-bold tracking-[-0.02em] text-nw-text">
        {value === undefined ? (
          <span className="text-sm font-medium text-nw-text-3">Loading…</span>
        ) : (
          value
        )}
      </span>
      <span className="text-xs text-nw-text-3">{hint}</span>
    </button>
  );
}

function Th({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'sticky top-0 z-10 h-[38px] border-r border-nw-border bg-nw-subtle px-3 align-middle font-bold shadow-[inset_0_-1px_0_var(--nw-border)] last:border-r-0',
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <td
      className={cn(
        'h-[46px] border-r border-nw-border px-3 py-1.5 align-middle last:border-r-0',
        className,
      )}
    >
      {children}
    </td>
  );
}

const FAMILY_BAR: Record<RowFamily, string> = {
  urgent: 'bg-nw-urgent-icon',
  warning: 'bg-nw-warning-icon',
  done: 'bg-nw-done-icon',
  neutral: 'bg-nw-neutral-icon',
};
const FAMILY_PILL: Record<RowFamily, string> = {
  urgent: 'bg-nw-urgent-bg text-nw-urgent-text ring-nw-urgent-border',
  warning: 'bg-nw-warning-bg text-nw-warning-text ring-nw-warning-border',
  done: 'bg-nw-done-bg text-nw-done-text ring-nw-done-border',
  neutral: 'bg-nw-neutral-bg text-nw-neutral-text ring-nw-neutral-border',
};
const FAMILY_ICON: Record<RowFamily, string> = {
  urgent: 'text-nw-urgent-icon',
  warning: 'text-nw-warning-icon',
  done: 'text-nw-done-icon',
  neutral: 'text-nw-neutral-icon',
};

function stateWord(row: PmBoardRow): string {
  switch (row.dueStatus) {
    case 'no_reading':
      return 'No reading';
    case 'no_baseline':
      return 'No record';
    case 'no_interval':
      return 'No interval';
    default:
      return dueText(row);
  }
}

/** The interval as the OIL CHANGE sheet writes it: 30000 -> "30K". */
function pmMileage(miles: number | null): string {
  if (!miles) return '';
  return miles % 1000 === 0 ? `${miles / 1000}K` : `${n(miles)} mi`;
}

function shortDate(iso: string): string {
  return formatDate(iso).replace(/, \d{4}$/, '');
}

function Row({
  row,
  canWrite,
  onBook,
  onLog,
  onReading,
}: {
  row: PmBoardRow;
  canWrite: boolean;
  onBook: () => void;
  onLog: () => void;
  onReading: () => void;
}) {
  const family = rowFamily(row);
  const appt = row.appointment;
  const staleMiles = milesAtLastReading(row);
  const action =
    row.dueStatus === 'no_reading'
      ? { label: 'Get reading', icon: <Gauge />, onClick: onReading, variant: 'secondary' as const }
      : appt?.inShop || row.dueStatus === 'no_baseline'
        ? { label: 'Log', icon: <Droplet />, onClick: onLog, variant: 'secondary' as const }
        : appt
          ? { label: 'Log', icon: <Droplet />, onClick: onLog, variant: 'secondary' as const }
          : { label: 'Book', icon: <Calendar />, onClick: onBook, variant: 'secondary' as const };
  return (
    <tr className="border-b border-nw-border last:border-b-0 hover:bg-nw-hover">
      <Td>
        <span className="flex items-center gap-2.5">
          <Truck className="size-4 shrink-0 text-nw-text-3" aria-hidden />
          <span className="min-w-0">
            <Link
              to="/fleet/trucks/$truckId"
              params={{ truckId: row.unitId }}
              className="block truncate font-bold text-nw-text hover:underline"
            >
              {row.unitNumber}
            </Link>
            <span className="block truncate text-[11.5px] text-nw-text-3">
              {row.driverName ?? 'No driver'}
            </span>
          </span>
        </span>
      </Td>
      <Td className="tabular text-right text-nw-text-2">
        {row.readingOdometer === null ? '—' : n(row.readingOdometer)}
      </Td>
      <Td>
        {row.lastServiceOdometer !== null && row.lastServiceAt ? (
          <>
            <span className="tabular block font-semibold text-nw-text">
              {n(row.lastServiceOdometer)}
            </span>
            <span className="block text-[11.5px] text-nw-text-3">
              {shortDate(row.lastServiceAt)}
            </span>
          </>
        ) : (
          <span className="text-nw-text-3">—</span>
        )}
      </Td>
      <Td>
        {row.milesSinceService !== null && row.dueStatus !== 'no_reading' ? (
          <>
            <span className="block h-1.5 max-w-[300px] overflow-hidden rounded-full bg-nw-track">
              <i
                className={cn('block h-full rounded-full', FAMILY_BAR[family])}
                style={{ width: `${intervalPct(row)}%` }}
              />
            </span>
            <span className="tabular mt-1 block text-[11.5px] text-nw-text-3">
              <span className="font-bold text-nw-text">{pmMileage(row.intervalMiles)}</span>
              {` · ${n(row.milesSinceService)} mi used`}
            </span>
          </>
        ) : staleMiles !== null && row.intervalMiles ? (
          <>
            <span className="block h-1.5 max-w-[300px] overflow-hidden rounded-full bg-nw-track">
              <i
                className={cn('block h-full rounded-full', FAMILY_BAR.neutral)}
                style={{ width: `${Math.min(100, Math.round((staleMiles / row.intervalMiles) * 100))}%` }}
              />
            </span>
            <span
              className="tabular mt-1 block text-[11.5px] text-nw-text-3"
              title="The last odometer reading is too old to judge the due date - at least this many miles"
            >
              <span className="font-bold text-nw-text">{pmMileage(row.intervalMiles)}</span>
              {` · ≥ ${n(staleMiles)} mi used${row.readingAt ? ` as of ${shortDate(row.readingAt)}` : ''}`}
            </span>
          </>
        ) : (
          <span className="text-[11.5px] text-nw-text-3">
            {row.intervalMiles ? (
              <span className="font-bold text-nw-text">{pmMileage(row.intervalMiles)}</span>
            ) : null}
            {row.intervalMiles ? ' · ' : ''}
            {row.dueStatus === 'no_baseline' ? 'No last change' : 'Not available'}
          </span>
        )}
      </Td>
      <Td className="tabular text-right text-nw-text-2">
        {row.nextServiceOdometer === null ? '—' : n(row.nextServiceOdometer)}
      </Td>
      <Td>
        <span
          className={cn(
            'inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-semibold whitespace-nowrap ring-1 ring-inset',
            FAMILY_PILL[family],
          )}
        >
          <StatusSymbol family={family} size={12} className={FAMILY_ICON[family]} />
          {stateWord(row)}
        </span>
      </Td>
      <Td>
        {appt ? (
          <>
            <span className="block truncate text-[12.5px] font-semibold text-nw-text">
              {appt.vendorName}
            </span>
            <span className="block text-[11.5px] text-nw-text-3">
              {appt.inShop
                ? 'In the shop'
                : `${shortDate(appt.scheduledFor)}${appt.responsibleName ? ` · ${appt.responsibleName}` : ''}`}
            </span>
          </>
        ) : (
          <span className="text-nw-text-3">Not assigned</span>
        )}
      </Td>
      <Td>
        <Button
          variant={action.variant}
          size="sm"
          icon={action.icon}
          disabled={!canWrite}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      </Td>
    </tr>
  );
}
