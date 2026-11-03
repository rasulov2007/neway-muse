import { Link } from '@tanstack/react-router';
import {
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  Droplet,
  Plus,
  RefreshCw,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DUE_STATUS_LABEL,
  SHOP_STAGE_LABEL,
  WORK_TYPE_LABEL,
  downtimeMinutes,
  formatDowntime,
  type AssetType,
  type DueStatus,
  type InShopRow,
  type InspectionRow,
  type MaintenanceDefaults,
  type OilChangeRow,
  type WorkType,
} from '@neway/shared';
import { Badge, Button, EmptyState, PageHeader, SectionCard, Skeleton, cn } from '@/design-system';
import { nowMs } from '@/lib/clock';
import { formatDate, formatIsoDate, formatMiles, formatNumber } from '@/lib/format';
import { CreateWorkOrderDialog } from './components/CreateWorkOrderDialog';
import { DUE_TONE, shopStageTone, workOrderActionWord } from './fleet-ui';
import { useFleetToday } from './useFleetToday';

type Filter = 'all' | 'truck' | 'trailer' | 'overdue';

/** How many due rows are drawn before the list is cut; the sort puts the worst first. */
const INSPECTION_LIMIT = 60;
/** How many no-baseline rows the group opens to. Entering baselines is a sitting-down job. */
const BASELINE_LIMIT = 60;

/**
 * Today, for the shop.
 *
 * Three sections in the order a shift is worked: what needs oil, what needs inspecting, what is
 * already in. Nothing on this page is money, and that is structural rather than careful — the
 * endpoint behind it has no cost field in its response, so there is nothing here to hide.
 *
 * Every section lists only what needs attention. A unit on schedule is absent, because a list that
 * includes the healthy units is a list nobody reads to the bottom of, and every row carries the
 * one action it implies: open a work order for it.
 *
 * Built for a phone held in a shop. Rows stack rather than scroll sideways, the tap targets are
 * full-width, and the downtime counters tick on the client so a number on screen is never stale
 * even though the board refetches every five minutes.
 */
export function ShopTodayPage() {
  const today = useFleetToday();
  const [filter, setFilter] = useState<Filter>('all');
  const [creating, setCreating] = useState<{
    unit?: { assetType: AssetType; unitId: string };
    workType?: WorkType;
  } | null>(null);
  // Units with no service history are shown as one group rather than as rows; see splitOnBaseline.
  const [showOilBaselines, setShowOilBaselines] = useState(false);
  const [showInspectionBaselines, setShowInspectionBaselines] = useState(false);

  // The counters tick between refetches, so "2d 5h" is true to the minute rather than to the last
  // time the board loaded. It is the company clock rather than the browser's, so a laptop with the
  // wrong time does not invent downtime.
  const [clock, setClock] = useState(() => nowMs());
  useEffect(() => {
    const timer = setInterval(() => setClock(nowMs()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const data = today.data;

  const inspections = useMemo(() => {
    const rows = data?.inspections ?? [];
    if (filter === 'all') return rows;
    if (filter === 'overdue') return rows.filter((row) => row.status === 'overdue');
    return rows.filter((row) => row.assetType === filter);
  }, [data, filter]);

  const oil = useMemo(() => splitOnBaseline(data?.oilChanges ?? []), [data]);
  const inspection = useMemo(() => splitOnBaseline(inspections), [inspections]);

  if (today.isPending) {
    return (
      <div className="flex flex-col gap-(--section-gap)">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const counts = data?.counts;
  const defaults = data?.defaults;

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Today"
        description="What needs doing in the shop: oil, inspections, and what is already in."
        actions={
          <Button icon={<Plus />} variant="primary" onClick={() => setCreating({})}>
            Create work order
          </Button>
        }
      />

      {/* A · oil change */}
      <SectionCard
        icon={<Droplet />}
        title="Oil change"
        description={
          defaults
            ? `Every ${formatMiles(defaults.oilChangeIntervalMiles)} · due soon inside ${formatMiles(defaults.oilChangeDueSoonMiles)}`
            : undefined
        }
        padding="none"
        actions={
          counts ? (
            <span className="flex flex-wrap gap-1.5">
              <Count tone="danger" n={counts.oilOverdue} label="overdue" />
              <Count tone="warning" n={counts.oilDueSoon} label="due soon" />
              <Count n={counts.oilUnknown} label="no record" />
            </span>
          ) : undefined
        }
      >
        {oil.due.length === 0 && oil.noBaseline.length === 0 ? (
          <Nothing />
        ) : (
          <ul>
            {oil.due.map((row) => (
              <OilRow
                key={row.unitId}
                row={row}
                onCreate={() =>
                  setCreating({
                    unit: { assetType: 'truck', unitId: row.unitId },
                    workType: 'oil_change',
                  })
                }
              />
            ))}
            {oil.noBaseline.length > 0 ? (
              <NoBaselineRow
                count={oil.noBaseline.length}
                what="no oil change on record"
                hint="The first oil change recorded here becomes the baseline the interval counts from."
                open={showOilBaselines}
                onToggle={() => setShowOilBaselines((value) => !value)}
              />
            ) : null}
            {showOilBaselines
              ? oil.noBaseline.slice(0, BASELINE_LIMIT).map((row) => (
                  <OilRow
                    key={row.unitId}
                    row={row}
                    onCreate={() =>
                      setCreating({
                        unit: { assetType: 'truck', unitId: row.unitId },
                        workType: 'oil_change',
                      })
                    }
                  />
                ))
              : null}
          </ul>
        )}
        {showOilBaselines && oil.noBaseline.length > BASELINE_LIMIT ? (
          <p className="border-t border-nw-border px-4 py-2.5 text-xs text-nw-text-2">
            Showing {BASELINE_LIMIT} of {formatNumber(oil.noBaseline.length)} units with no record.
          </p>
        ) : null}
      </SectionCard>

      {/* B · inspections, trucks and trailers in one list */}
      <SectionCard
        icon={<ClipboardCheck />}
        title="Inspections"
        description="Annual DOT and PM, for trucks and trailers"
        padding="none"
        actions={
          counts ? (
            <span className="flex flex-wrap gap-1.5">
              <Count tone="danger" n={counts.inspectionsOverdue} label="overdue" />
              <Count tone="warning" n={counts.inspectionsDueSoon} label="due soon" />
            </span>
          ) : undefined
        }
      >
        <div className="flex flex-wrap gap-1.5 border-b border-nw-border px-4 py-2.5">
          {(
            [
              ['all', 'All'],
              ['truck', 'Trucks'],
              ['trailer', 'Trailers'],
              ['overdue', 'Overdue'],
            ] as [Filter, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={cn(
                'min-h-9 rounded-full px-3 py-1.5 text-xs font-semibold ring-1',
                filter === key
                  ? 'bg-nw-accent-tint text-nw-accent-ink ring-nw-accent'
                  : 'bg-nw-panel text-nw-text-2 ring-nw-border',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {inspection.due.length === 0 && inspection.noBaseline.length === 0 ? (
          <Nothing />
        ) : (
          <ul>
            {inspection.due.slice(0, INSPECTION_LIMIT).map((row) => (
              <InspectionListRow
                key={`${row.unitId}-${row.inspectionType}`}
                row={row}
                onCreate={() =>
                  setCreating({
                    unit: { assetType: row.assetType, unitId: row.unitId },
                    workType: row.inspectionType,
                  })
                }
              />
            ))}
            {inspection.noBaseline.length > 0 ? (
              <NoBaselineRow
                count={inspection.noBaseline.length}
                what="no inspection on record"
                hint="Recording the inspection sets the date the next one is counted from."
                open={showInspectionBaselines}
                onToggle={() => setShowInspectionBaselines((value) => !value)}
              />
            ) : null}
            {showInspectionBaselines
              ? inspection.noBaseline.slice(0, BASELINE_LIMIT).map((row) => (
                  <InspectionListRow
                    key={`${row.unitId}-${row.inspectionType}`}
                    row={row}
                    onCreate={() =>
                      setCreating({
                        unit: { assetType: row.assetType, unitId: row.unitId },
                        workType: row.inspectionType,
                      })
                    }
                  />
                ))
              : null}
          </ul>
        )}
        {inspection.due.length > INSPECTION_LIMIT ? (
          <p className="border-t border-nw-border px-4 py-2.5 text-xs text-nw-text-2">
            Showing the {INSPECTION_LIMIT} most urgent of {formatNumber(inspection.due.length)} due.
          </p>
        ) : null}
      </SectionCard>

      {/* C · in the shop */}
      <SectionCard
        icon={<Wrench />}
        title="In the shop"
        description="Longest in, first"
        padding="none"
        actions={counts ? <Count n={counts.inShop} label="in the shop" /> : undefined}
      >
        {(data?.workOrdersInShop.length ?? 0) === 0 ? (
          <Nothing />
        ) : (
          <ul>
            {data?.workOrdersInShop.map((row) => (
              <InShopListRow key={row.workOrderId} row={row} defaults={defaults} clock={clock} />
            ))}
          </ul>
        )}
        <p className="flex items-center gap-2 border-t border-nw-border px-4 py-2.5 text-xs text-nw-text-3">
          <RefreshCw className="size-3.5" aria-hidden />
          The board refreshes every five minutes; the downtime counters tick every minute.
        </p>
      </SectionCard>

      <CreateWorkOrderDialog
        open={creating !== null}
        onOpenChange={(open) => {
          if (!open) setCreating(null);
        }}
        defaultUnit={
          creating?.unit ? { kind: creating.unit.assetType, id: creating.unit.unitId } : null
        }
        defaultWorkType={creating?.workType}
        onDone={() => void today.refetch()}
      />
    </div>
  );
}

/**
 * "It is late" and "we have never written it down" are different problems.
 *
 * A fleet that has just moved onto the product has no service history, so every unit reads as
 * unknown - and eighty unknown rows above three overdue ones is a board nobody scrolls to the
 * bottom of. The unknowns are true and they are kept: one row with the count, which opens on
 * request. What is actually due stays at the top, where a mechanic reads it.
 */
function splitOnBaseline<T extends { status: DueStatus }>(rows: T[]): { due: T[]; noBaseline: T[] } {
  const due: T[] = [];
  const noBaseline: T[] = [];
  for (const row of rows) (row.status === 'unknown' ? noBaseline : due).push(row);
  return { due, noBaseline };
}

function NoBaselineRow({
  count,
  what,
  hint,
  open,
  onToggle,
}: {
  count: number;
  what: string;
  hint: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex flex-col gap-2 border-t border-nw-border bg-nw-surface px-4 py-3 first:border-t-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-nw-text-1">
            {formatNumber(count)} with {what}
          </span>
          <Badge tone="neutral" size="sm" variant="outline" dot>
            No record
          </Badge>
        </span>
        <span className="mt-0.5 block text-xs text-nw-text-2">{hint}</span>
      </div>
      <div className="shrink-0 [&>button]:w-full sm:[&>button]:w-auto">
        <Button
          size="md"
          variant="secondary"
          aria-expanded={open}
          icon={open ? <ChevronUp /> : <ChevronDown />}
          onClick={onToggle}
        >
          {open ? 'Hide them' : 'Show them'}
        </Button>
      </div>
    </li>
  );
}

function Nothing() {
  return (
    <EmptyState
      size="sm"
      icon={<ShieldCheck />}
      title="Nothing due — all good"
      description="Units on schedule are not listed here."
    />
  );
}

function Count({ n, label, tone }: { n: number; label: string; tone?: 'danger' | 'warning' }) {
  if (n === 0) return null;
  return (
    <Badge tone={tone ?? 'neutral'} size="sm" variant="outline" dot>
      {n} {label}
    </Badge>
  );
}

/** Overdue red, due soon amber, no record neutral — with the symbol and the word, never colour. */
function DueBadge({ status }: { status: DueStatus }) {
  return (
    <Badge tone={DUE_TONE[status]} size="sm" variant="outline" dot>
      {DUE_STATUS_LABEL[status]}
    </Badge>
  );
}

/** A row on a phone: a title line, two lines of detail, one full-width action. Never sideways. */
function Row({
  title,
  badges,
  lines,
  action,
}: {
  title: ReactNode;
  badges?: ReactNode;
  lines: ReactNode[];
  action: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2 border-t border-nw-border px-4 py-3 first:border-t-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          {title}
          {badges}
        </span>
        {lines.map((line, index) => (
          <span key={index} className="mt-0.5 block text-xs text-nw-text-2">
            {line}
          </span>
        ))}
      </div>
      <div className="shrink-0 [&>a]:w-full [&>button]:w-full sm:[&>a]:w-auto sm:[&>button]:w-auto">
        {action}
      </div>
    </li>
  );
}

function OilRow({ row, onCreate }: { row: OilChangeRow; onCreate: () => void }) {
  const over = row.milesRemaining !== null && row.milesRemaining <= 0;
  return (
    <Row
      title={
        <Link
          to="/fleet/trucks/$truckId"
          params={{ truckId: row.unitId }}
          className="text-sm font-semibold text-nw-text-1 hover:underline"
        >
          {row.unitNumber}
        </Link>
      }
      badges={
        <>
          <DueBadge status={row.status} />
          {row.milesRemaining !== null ? (
            <span
              className={cn(
                'text-xs font-semibold tabular-nums',
                over ? 'text-nw-urgent-text' : 'text-nw-warning-text',
              )}
            >
              {over
                ? `${formatMiles(Math.abs(row.milesRemaining))} over`
                : `${formatMiles(row.milesRemaining)} left`}
            </span>
          ) : null}
        </>
      }
      lines={[
        `${row.description} · ${row.odometer === null ? 'no odometer reading' : `${formatMiles(row.odometer)} now`}`,
        row.lastOilChangeAt
          ? `Last oil change ${formatDate(row.lastOilChangeAt)}${row.lastOilChangeOdometer !== null ? ` at ${formatMiles(row.lastOilChangeOdometer)}` : ''}`
          : 'No oil change on record — enter the baseline, or record the one just done',
      ]}
      action={
        <Button
          size="md"
          variant={row.status === 'overdue' ? 'primary' : 'secondary'}
          onClick={onCreate}
        >
          Create work order
        </Button>
      }
    />
  );
}

function InspectionListRow({ row, onCreate }: { row: InspectionRow; onCreate: () => void }) {
  const late = row.daysRemaining !== null && row.daysRemaining < 0;
  const detail =
    [
      row.daysRemaining === null
        ? null
        : late
          ? `${Math.abs(row.daysRemaining)} days overdue`
          : `${row.daysRemaining} days left`,
      row.milesRemaining === null
        ? null
        : row.milesRemaining <= 0
          ? `${formatMiles(Math.abs(row.milesRemaining))} over`
          : `${formatMiles(row.milesRemaining)} to go`,
    ]
      .filter(Boolean)
      .join(' · ') || 'No baseline on file';

  return (
    <Row
      title={
        row.assetType === 'truck' ? (
          <Link
            to="/fleet/trucks/$truckId"
            params={{ truckId: row.unitId }}
            className="text-sm font-semibold text-nw-text-1 hover:underline"
          >
            {row.unitNumber}
          </Link>
        ) : (
          <Link
            to="/fleet/trailers/$trailerId"
            params={{ trailerId: row.unitId }}
            className="text-sm font-semibold text-nw-text-1 hover:underline"
          >
            {row.unitNumber}
          </Link>
        )
      }
      badges={
        <>
          <span className="text-xs font-medium text-nw-text-2">
            {row.assetType === 'truck' ? 'Truck' : 'Trailer'} ·{' '}
            {WORK_TYPE_LABEL[row.inspectionType]}
          </span>
          <DueBadge status={row.status} />
        </>
      }
      lines={[
        // A due date with no last date behind it is the unit record's own next-inspection date,
        // which is worth saying: it is a date somebody typed, not one this page worked out.
        [
          row.dueDate ? `Due ${formatIsoDate(row.dueDate)}` : null,
          row.dueOdometer !== null ? `or at ${formatMiles(row.dueOdometer)}` : null,
          row.lastDoneAt
            ? `last done ${formatDate(row.lastDoneAt)}`
            : 'from the unit record; no inspection logged here yet',
        ]
          .filter(Boolean)
          .join(' · '),
        detail,
      ]}
      action={
        <Button
          size="md"
          variant={row.status === 'overdue' ? 'primary' : 'secondary'}
          onClick={onCreate}
        >
          Create work order
        </Button>
      }
    />
  );
}

function InShopListRow({
  row,
  defaults,
  clock,
}: {
  row: InShopRow;
  defaults: MaintenanceDefaults | undefined;
  /** The ticking clock, passed in so the row stays a pure function of its props. */
  clock: number;
}) {
  // Counted from the ticking clock rather than read off the row, so the number is current and not
  // as of the last refetch. The same function the server uses, so the two never disagree.
  const minutes = downtimeMinutes(row.shopInAt, null, clock);
  const days = minutes / (60 * 24);
  const amber = days > (defaults?.downtimeAmberDays ?? 3);
  const red = days > (defaults?.downtimeRedDays ?? 7);

  return (
    <Row
      title={
        <Link
          to="/fleet/shop/$orderId"
          params={{ orderId: row.workOrderId }}
          className="text-sm font-semibold text-nw-text-1 hover:underline"
        >
          {row.unitNumber}
        </Link>
      }
      badges={
        <>
          <span className="text-xs font-medium text-nw-text-2">
            {row.number} · {WORK_TYPE_LABEL[row.workType]}
          </span>
          {row.shopStage ? (
            <Badge tone={shopStageTone(row.shopStage)} size="sm" variant="outline" dot>
              {SHOP_STAGE_LABEL[row.shopStage]}
            </Badge>
          ) : null}
          <span
            className={cn(
              'text-xs font-bold tabular-nums',
              red ? 'text-nw-urgent-text' : amber ? 'text-nw-warning-text' : 'text-nw-text-2',
            )}
          >
            {formatDowntime(minutes)}
          </span>
        </>
      }
      lines={[
        `In since ${formatDate(row.shopInAt)}${row.assignedTo ? ` · ${row.assignedTo}` : ''}`,
        row.lastAction
          ? `${row.lastAction.note ?? workOrderActionWord(row.lastAction.action)} — ${row.lastAction.userName}, ${formatDate(row.lastAction.createdAt)}`
          : 'No action recorded yet',
      ]}
      action={
        <Button size="md" variant="secondary" asChild>
          <Link to="/fleet/shop/$orderId" params={{ orderId: row.workOrderId }}>
            Open
          </Link>
        </Button>
      }
    />
  );
}
