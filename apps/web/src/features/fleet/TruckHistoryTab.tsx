import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Calendar, ExternalLink, MapPin, Shield, TriangleAlert, Wrench } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  SectionCard,
  Select,
  Skeleton,
  StatusBadge,
} from '@/design-system';
import {
  listAccidents,
  listViolations,
  type Accident,
  type RepairOrder,
  type Violation,
} from '@/demo';
import { formatDate, formatMoney, formatTime } from '@/lib/format';
import type { accidentsV2 } from '@neway/shared';
import { ApiError, apiGet } from '@/lib/api-client';
import { isEnabled } from '@/lib/feature-flags';
import { ProfileAccidents } from '@/features/accidents/ProfileAccidents';
import { stageStatus } from '@/features/accidents/labels';

/**
 * What has happened to this unit.
 *
 * A truck's safety history belongs to the truck, not to whoever is driving it this month. A unit
 * is sold, a driver is reassigned, an insurer asks what this VIN has been through — and an answer
 * assembled from the current driver's record would be the wrong answer in all three cases. So the
 * only thing that puts a record on this page is its own `truckId`.
 *
 * Nothing here is a copy. The rows are the Safety department's accidents and violations, read
 * through the same list functions Safety reads, and the reference opens the record itself rather
 * than a summary of it — including the accident's photographs, which deliberately do not appear
 * on this page: a list of thumbnails of somebody's wreck is not what a person scanning a unit's
 * history needs to see.
 *
 * Closed and resolved records stay. History that quietly drops everything already dealt with is
 * how a unit with four settled accidents looks clean.
 */

/** The demo API caps a page at 200 rows, so both lists are drained rather than truncated. */
const PAGE = 200;

async function drain<T>(
  fetchPage: (page: number, pageSize: number) => Promise<{ data: T[]; total: number }>,
): Promise<T[]> {
  const first = await fetchPage(1, PAGE);
  const rows = [...first.data];
  const pages = Math.ceil(first.total / PAGE);
  for (let page = 2; page <= pages; page += 1) {
    rows.push(...(await fetchPage(page, PAGE)).data);
  }
  return rows;
}

type HistoryKind = 'accident' | 'violation' | 'repair';

interface HistoryEntry {
  id: string;
  kind: HistoryKind;
  /** ISO date or date-time; the sort and the column both read this. */
  at: string;
  reference: string;
  description: string;
  /** A status code the design system already knows, so the badge matches Safety's. */
  status: string;
  /** Anything worth a second line — the accident's location, the violation's code. */
  detail: string | null;
}

/**
 * With `accidents_v2` the accidents on a unit come from Safety's accident cases (safety_accidents) — the source the
 * case page reads — instead of the per-session demo list, which is why a real unit with one case used to show none
 * (ACCEPTANCE L3). A role that may not read accidents gets the rest of the history.
 */
async function v2Accidents(truckId: string): Promise<HistoryEntry[]> {
  try {
    const r = await apiGet<accidentsV2.ProfileAccidentsResponse>(
      `/safety/accidents-v2/profiles/truck/${truckId}`,
    );
    return r.cases.map((c) => ({
      id: c.id,
      kind: 'accident' as const,
      at: c.occurredAt,
      reference: c.number,
      description: c.type,
      status: stageStatus(c.stage),
      detail: c.workOrders.length ? c.workOrders.map((w) => w.number).join(', ') : null,
    }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return [];
    throw e;
  }
}

function fromAccident(accident: Accident): HistoryEntry {
  return {
    id: accident.id,
    kind: 'accident',
    at: accident.at,
    reference: accident.accidentNumber,
    description: accident.description,
    status: accident.status,
    detail: `${accident.location.city}, ${accident.location.state}`,
  };
}

/**
 * A repair, in the unit's history.
 *
 * What happened to a truck is one story, not two filed in different rooms: an accident in March
 * and the body work in April belong on the same page, in order, or nobody can see that the second
 * followed the first. Repairs used to live only on the Maintenance tab, so a unit's history read
 * as though nothing had ever been fixed on it (acceptance test A20).
 */
function fromRepair(order: RepairOrder): HistoryEntry {
  return {
    id: order.id,
    kind: 'repair',
    at: order.completedAt ?? order.backInServiceAt ?? order.openedAt,
    reference: order.roNumber,
    description: order.summary,
    status: order.status,
    detail:
      [order.vendorName, order.total > 0 ? formatMoney(order.total) : null]
        .filter(Boolean)
        .join(' · ') || null,
  };
}

function fromViolation(violation: Violation): HistoryEntry {
  /*
   * The three states a violation is in from a truck's point of view. The full derivation —
   * overdue corrective actions and the rest — belongs to the violation's own page, which is one
   * click away; repeating a partial version of it here would be a second answer to the same
   * question.
   */
  const status = violation.resolvedAt ? 'resolved' : violation.contested ? 'disputed' : 'open';
  return {
    id: violation.id,
    kind: 'violation',
    at: violation.onDate,
    reference: violation.violationNumber,
    description: violation.description,
    status,
    detail: violation.code,
  };
}

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'repair', label: 'Repairs' },
  { value: 'accident', label: 'Accidents' },
  { value: 'violation', label: 'Violations' },
] as const;

type HistoryFilter = (typeof FILTERS)[number]['value'];

const PERIODS = [
  { value: 'all', label: 'All time', days: null },
  { value: '30', label: 'Last 30 days', days: 30 },
  { value: '90', label: 'Last 90 days', days: 90 },
  { value: 'year', label: 'This year', days: null },
] as const;

type Period = (typeof PERIODS)[number]['value'];

/** The earliest instant a period admits, or null for "everything". Read off the real clock. */
function periodStart(period: Period, now: Date): number | null {
  if (period === 'all') return null;
  if (period === 'year') return Date.UTC(now.getFullYear(), 0, 1);
  const days = PERIODS.find((p) => p.value === period)?.days ?? 0;
  return now.getTime() - days * 86_400_000;
}

/** A calendar date is an instant at midnight UTC; a timestamp is itself. */
function instantOf(at: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T00:00:00Z` : at);
}

export function TruckHistoryTab({
  truckId,
  unitNumber,
  repairs = [],
}: {
  truckId: string;
  unitNumber: string;
  /** Every work order on this unit, from the fleet bundle the page already holds. */
  repairs?: RepairOrder[];
}) {
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [period, setPeriod] = useState<Period>('all');

  /*
   * Keyed under `safety` on purpose: `useInvalidateSafety` invalidates everything below that key,
   * so an accident recorded or a violation resolved anywhere in the app refreshes this list
   * without this page having to know it happened.
   */
  const history = useQuery({
    queryKey: ['safety', 'truck-history', truckId, isEnabled('accidents_v2')],
    enabled: Boolean(truckId),
    queryFn: async (): Promise<HistoryEntry[]> => {
      const [accidents, violations] = await Promise.all([
        isEnabled('accidents_v2')
          ? v2Accidents(truckId)
          : drain((page, pageSize) => listAccidents({ truckId, page, pageSize })).then((rows) =>
              rows.map(fromAccident),
            ),
        drain((page, pageSize) => listViolations({ truckId, page, pageSize })),
      ]);
      return [...accidents, ...violations.map(fromViolation)].sort((a, b) =>
        a.at < b.at ? 1 : a.at > b.at ? -1 : 0,
      );
    },
  });

  const rows = useMemo(
    () =>
      [...(history.data ?? []), ...repairs.map(fromRepair)].sort((a, b) =>
        instantOf(a.at) < instantOf(b.at) ? 1 : instantOf(a.at) > instantOf(b.at) ? -1 : 0,
      ),
    [history.data, repairs],
  );
  const inPeriod = useMemo(() => {
    const start = periodStart(period, new Date());
    return start === null ? rows : rows.filter((row) => instantOf(row.at) >= start);
  }, [rows, period]);
  const counts = useMemo(
    () => ({
      all: inPeriod.length,
      repair: inPeriod.filter((row) => row.kind === 'repair').length,
      accident: inPeriod.filter((row) => row.kind === 'accident').length,
      violation: inPeriod.filter((row) => row.kind === 'violation').length,
    }),
    [inPeriod],
  );
  const visible = filter === 'all' ? inPeriod : inPeriod.filter((row) => row.kind === filter);

  if (history.isPending) {
    return (
      <Card className="flex flex-col gap-3 p-4" aria-busy>
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </Card>
    );
  }

  if (history.isError) {
    return (
      <Card>
        <ErrorState
          title="Unable to load this unit's history"
          description="The safety records for this unit could not be fetched."
          error={history.error}
          onRetry={() => void history.refetch()}
          retrying={history.isFetching}
        />
      </Card>
    );
  }

  const accidentsSection = isEnabled('accidents_v2') ? (
    <ProfileAccidents kind="truck" id={truckId} />
  ) : null;

  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {accidentsSection}
        <SectionCard
          icon={<Shield />}
          title="Unit history"
          description="Repairs, accidents and violations for this unit, in one order."
          footer="0 events"
        >
          <EmptyState
            icon={<Shield />}
            title={`Nothing recorded against unit ${unitNumber}`}
            description="Accidents and violations filed against this unit appear here, including closed ones. Records belonging to its driver are on the driver's own page."
          />
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {accidentsSection}
      <SectionCard
        icon={<Shield />}
        title="Unit history"
        description="Repairs, accidents and violations for this unit, in one order."
        actions={
          <>
            {FILTERS.map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={filter === option.value ? 'primary' : 'secondary'}
                aria-pressed={filter === option.value}
                onClick={() => setFilter(option.value)}
              >
                {option.label} {counts[option.value]}
              </Button>
            ))}
            <span className="flex items-center gap-1.5">
              <Calendar className="size-4 text-muted" aria-hidden />
              <Select
                size="sm"
                aria-label="Period"
                value={period}
                onValueChange={(value) => setPeriod(value as Period)}
                options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
                className="w-36"
              />
            </span>
          </>
        }
        padding="sm"
        footer={`${visible.length} ${visible.length === 1 ? 'event' : 'events'}`}
      >
        <ul className="flex flex-col gap-3">
          {visible.map((entry) => (
            <li
              key={`${entry.kind}_${entry.id}`}
              className="flex flex-wrap gap-4 rounded-lg border border-line-soft bg-surface px-4 py-3"
            >
              <span className="flex w-28 shrink-0 flex-col">
                <span className="text-sm font-medium text-ink">{formatDate(entry.at)}</span>
                {/* A violation is a calendar date; only a timestamp carries a time of day. */}
                {/^\d{4}-\d{2}-\d{2}$/.test(entry.at) ? null : (
                  <span className="text-xs text-muted">{formatTime(entry.at)}</span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={
                      entry.kind === 'accident'
                        ? 'danger'
                        : entry.kind === 'repair'
                          ? 'neutral'
                          : 'warning'
                    }
                    variant="outline"
                    size="sm"
                    icon={
                      entry.kind === 'repair' ? (
                        <Wrench aria-hidden />
                      ) : (
                        <TriangleAlert aria-hidden />
                      )
                    }
                  >
                    {entry.kind === 'accident'
                      ? 'Accident'
                      : entry.kind === 'repair'
                        ? 'Repair'
                        : 'Violation'}
                  </Badge>
                  <span className="text-sm font-semibold text-ink">{entry.reference}</span>
                  <StatusBadge status={entry.status} dot />
                </span>
                <span className="mt-1 block text-sm text-secondary">{entry.description}</span>
                {entry.detail ? (
                  <span className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                    <MapPin className="size-3.5 shrink-0" aria-hidden />
                    {entry.detail}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 self-center">
                {entry.kind === 'repair' ? (
                  <Button size="sm" variant="secondary" asChild>
                    <Link to="/fleet/maintenance/$orderId" params={{ orderId: entry.id }}>
                      <ExternalLink aria-hidden />
                      View repair
                    </Link>
                  </Button>
                ) : entry.kind === 'accident' ? (
                  <Button size="sm" variant="secondary" asChild>
                    <Link to="/safety/accidents/$accidentId" params={{ accidentId: entry.id }}>
                      <ExternalLink aria-hidden />
                      View accident
                    </Link>
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" asChild>
                    <Link to="/safety/violations/$violationId" params={{ violationId: entry.id }}>
                      <ExternalLink aria-hidden />
                      View violation
                    </Link>
                  </Button>
                )}
              </span>
            </li>
          ))}
          {visible.length === 0 ? (
            <li className="px-4 py-8 text-center text-sm text-muted">
              No{' '}
              {filter === 'accident'
                ? 'accidents'
                : filter === 'violation'
                  ? 'violations'
                  : filter === 'repair'
                    ? 'repairs'
                    : 'events'}
              {period === 'all' ? ' on this unit.' : ' on this unit in this period.'}
            </li>
          ) : null}
        </ul>
      </SectionCard>
    </div>
  );
}
