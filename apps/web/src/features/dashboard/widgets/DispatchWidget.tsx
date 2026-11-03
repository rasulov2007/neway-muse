import type { DashboardDispatch, DispatchTeam, RpmBuckets } from '@neway/shared';
import { Trophy } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Badge, BarChart, Card, CardSkeleton, SectionLabel, Tabs } from '@/design-system';
import { formatNumber } from '@/lib/format';
import { DASH, formatValue } from '../metric';
import { Value } from './Value';
import type { Visibility } from '../visibility';
import { CompactTable, type CompactColumn } from './CompactTable';
import { StatTile } from './StatTile';

export interface DispatchWidgetProps {
  dispatch: DashboardDispatch;
  visibility: Visibility;
}

const BUCKETS: Array<{ key: keyof RpmBuckets; label: string }> = [
  { key: 'lt150', label: '< $1.50' },
  { key: 'b150to200', label: '$1.50 – 2.00' },
  { key: 'b200to250', label: '$2.00 – 2.50' },
  { key: 'gte250', label: '$2.50+' },
];

interface WeekTotals {
  gross: number | null;
  loads: number;
  activeTrucks: number;
  /** Gross ÷ miles over every team, where a team's miles are its own `gross ÷ rpm`. */
  rpm: number | null;
  teams: number;
}

/**
 * Totals for the selected week: plain sums of the rows the API returned. Gross is `null` unless
 * every team reported one, and the blended RPM is only offered when every team has both a gross
 * and a positive RPM — a partial sum would silently understate the fleet.
 */
function weekTotals(teams: readonly DispatchTeam[]): WeekTotals {
  let gross = 0;
  let loads = 0;
  let activeTrucks = 0;
  let miles = 0;
  let grossComplete = teams.length > 0;
  let rpmComplete = teams.length > 0;
  for (const team of teams) {
    loads += team.loads;
    activeTrucks += team.activeTrucks;
    if (team.gross === null) {
      grossComplete = false;
      rpmComplete = false;
      continue;
    }
    gross += team.gross;
    if (team.rpm === null || team.rpm <= 0) rpmComplete = false;
    else miles += team.gross / team.rpm;
  }
  return {
    gross: grossComplete ? gross : null,
    loads,
    activeTrucks,
    rpm: grossComplete && rpmComplete && miles > 0 ? gross / miles : null,
    teams: teams.length,
  };
}

/** 1-based rank per team, best gross first; teams without a gross are ranked last. */
function ranksByGross(teams: readonly DispatchTeam[]): Map<string, number> {
  const ordered = [...teams].sort((a, b) => (b.gross ?? -Infinity) - (a.gross ?? -Infinity));
  return new Map(ordered.map((team, i) => [team.teamId, i + 1]));
}

/** Column total for one week. `estimated` is true when any contributing value is a projection. */
function weekColumnTotal(teams: readonly DispatchTeam[], weekStart: string) {
  let value = 0;
  let seen = false;
  let estimated = false;
  for (const team of teams) {
    const entry = team.byWeek.find((w) => w.weekStart === weekStart);
    if (!entry || entry.gross === null) continue;
    value += entry.gross;
    seen = true;
    if (entry.estimated) estimated = true;
  }
  return { value: seen ? value : null, estimated };
}

function EstimatedBadge({ children = 'Estimated' }: { children?: ReactNode }) {
  return (
    <Badge tone="warning" size="sm">
      {children}
    </Badge>
  );
}

/** Dispatch team performance: current week table, RPM bands, cumulative view (§8). */
export function DispatchWidget({ dispatch, visibility }: DispatchWidgetProps) {
  const [tab, setTab] = useState<'week' | 'cumulative'>('week');
  const masked = !visibility.financial || dispatch.masked;
  const currentWeek = dispatch.weeks[dispatch.weeks.length - 1];
  // Rows read top-down by rank: a rank chip on an unsorted list is just noise.
  const teams = useMemo(
    () => [...dispatch.teams].sort((a, b) => (b.gross ?? -Infinity) - (a.gross ?? -Infinity)),
    [dispatch.teams],
  );

  const totals = useMemo(() => weekTotals(teams), [teams]);
  const ranks = useMemo(() => ranksByGross(teams), [teams]);
  const bestGross = useMemo(
    () => teams.reduce<number>((best, t) => Math.max(best, t.gross ?? 0), 0),
    [teams],
  );

  const bucketData = BUCKETS.map((bucket) => ({
    band: bucket.label,
    trucks: dispatch.rpmBucketsTotal[bucket.key],
  }));
  const bucketLabel = `Trucks by weekly RPM band. ${bucketData
    .map((d) => `${d.band}: ${formatNumber(d.trucks)} trucks`)
    .join('. ')}`;

  const weekColumns: CompactColumn<DispatchTeam>[] = [
    {
      key: 'team',
      label: 'Team',
      render: (t) => {
        const rank = ranks.get(t.teamId);
        return (
          <span className="inline-flex items-center gap-2">
            <span
              title={rank === undefined ? undefined : `Rank ${rank} by gross`}
              className="tabular inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-muted text-2xs font-medium text-muted"
            >
              {rank ?? DASH}
            </span>
            <span className="font-medium">{t.teamName}</span>
            {rank === 1 && t.gross !== null ? (
              <Badge tone="success" size="sm" icon={<Trophy aria-hidden />}>
                Leader
              </Badge>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'gross',
      label: 'Gross',
      align: 'right',
      render: (t) => (
        <span className="inline-flex items-center justify-end gap-2">
          {!masked && t.gross !== null && bestGross > 0 ? (
            <span
              aria-hidden
              data-testid="gross-bar"
              className="hidden h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-nw-track sm:block"
            >
              <span
                className="block h-full rounded-full bg-nw-chart-1"
                style={{ width: `${Math.max(2, Math.round((t.gross / bestGross) * 100))}%` }}
              />
            </span>
          ) : null}
          <Value value={t.gross} kind="moneyCompact" masked={masked} />
        </span>
      ),
    },
    {
      key: 'loads',
      label: 'Loads',
      align: 'right',
      render: (t) => formatNumber(t.loads),
    },
    {
      key: 'activeTrucks',
      label: 'Active trucks',
      align: 'right',
      render: (t) => formatNumber(t.activeTrucks),
    },
    {
      key: 'activeDays',
      label: 'Active days',
      align: 'right',
      render: (t) => <Value value={t.activeDaysPct} kind="percent" />,
    },
    {
      key: 'rpm',
      label: 'RPM',
      align: 'right',
      render: (t) => <Value value={t.rpm} kind="rate" masked={masked} />,
    },
    {
      key: 'grossPerTruck',
      label: 'Gross / truck',
      align: 'right',
      render: (t) => <Value value={t.grossPerTruck} kind="moneyCompact" masked={masked} />,
    },
    {
      key: 'fullWeek',
      label: 'Full-week gross',
      align: 'right',
      render: (t) => (
        <span className="inline-flex items-center justify-end gap-1.5">
          <Value value={t.estimatedFullWeekGross.value} kind="moneyCompact" masked={masked} />
          {t.estimatedFullWeekGross.estimated ? <EstimatedBadge /> : null}
        </span>
      ),
    },
  ];

  const cumulativeColumns: CompactColumn<DispatchTeam>[] = [
    {
      key: 'team',
      label: 'Team',
      render: (t) => <span className="font-medium">{t.teamName}</span>,
    },
    ...dispatch.weeks.map<CompactColumn<DispatchTeam>>((week) => ({
      key: week.weekStart,
      label: (
        <span className="inline-flex flex-col items-end leading-tight">
          <span>{week.label}</span>
          {!week.isComplete ? (
            <span className="text-2xs normal-case text-warning-text">In progress</span>
          ) : null}
        </span>
      ),
      align: 'right',
      render: (t) => {
        const entry = t.byWeek.find((w) => w.weekStart === week.weekStart);
        return (
          <span className="inline-flex items-center justify-end gap-1.5">
            <Value value={entry?.gross ?? null} kind="moneyCompact" masked={masked} />
            {entry?.estimated ? <EstimatedBadge>Est.</EstimatedBadge> : null}
          </span>
        );
      },
    })),
    {
      key: 'total',
      label: 'Total',
      align: 'right',
      render: (t) => (
        <Value value={t.total} kind="moneyCompact" masked={masked} className="font-medium" />
      ),
    },
  ];

  const cumulativeFooter: ReactNode[] = [
    'Total',
    ...dispatch.weeks.map((week) => {
      const column = weekColumnTotal(teams, week.weekStart);
      return (
        <span key={week.weekStart} className="inline-flex items-center justify-end gap-1.5">
          {formatValue(column.value, 'moneyCompact', { masked })}
          {column.estimated ? <EstimatedBadge>Est.</EstimatedBadge> : null}
        </span>
      );
    }),
    teams.length === 0
      ? DASH
      : formatValue(
          teams.every((t) => t.total === null)
            ? null
            : teams.reduce((sum, t) => sum + (t.total ?? 0), 0),
          'moneyCompact',
          { masked },
        ),
  ];

  return (
    <Card
      title="Dispatch performance"
      description={
        currentWeek
          ? `${currentWeek.label}${currentWeek.isComplete ? '' : ' (in progress)'} · ${dispatch.weeks.length} reporting weeks`
          : 'By dispatch team'
      }
      padding="none"
      className="@container min-w-0"
      data-testid="dispatch-widget"
      footer={
        tab === 'week'
          ? 'Totals are the sum of the teams listed above. Full-week gross for an incomplete week is a projection and is labelled "Estimated".'
          : 'Team totals never include estimated weeks; a week column marked "Est." contains at least one projected value.'
      }
      actions={
        <Tabs
          variant="segmented"
          size="sm"
          aria-label="Dispatch view"
          items={[
            { value: 'week', label: 'This week' },
            { value: 'cumulative', label: 'Cumulative' },
          ]}
          value={tab}
          onValueChange={(v) => setTab(v as 'week' | 'cumulative')}
        />
      }
    >
      {tab === 'week' ? (
        <>
          <div
            data-testid="dispatch-totals"
            className="grid grid-cols-2 gap-2 border-b border-line-soft p-3 md:grid-cols-4"
          >
            <StatTile
              label="Total gross"
              value={formatValue(totals.gross, 'moneyCompact', { masked })}
              hint={`${formatNumber(totals.teams)} teams`}
              title={
                totals.gross === null ? 'At least one team has no gross for this week' : undefined
              }
            />
            <StatTile label="Loads" value={formatNumber(totals.loads)} hint="delivered" />
            <StatTile
              label="Active trucks"
              value={formatNumber(totals.activeTrucks)}
              hint="with a delivered load"
            />
            <StatTile
              label="Blended RPM"
              value={formatValue(totals.rpm, 'rate', { masked })}
              hint="all teams combined"
              title={totals.rpm === null ? 'Needs a gross and an RPM from every team' : undefined}
            />
          </div>
          <CompactTable
            caption="Dispatch teams, current week"
            columns={weekColumns}
            rows={teams}
            rowKey={(t) => t.teamId}
            rowClassName={(t) => (ranks.get(t.teamId) === 1 ? 'bg-success-soft/40' : undefined)}
          />
          <div className="grid grid-cols-1 gap-4 border-t border-line-soft p-3 @2xl:grid-cols-2">
            <div className="min-w-0">
              <SectionLabel>Trucks by RPM band</SectionLabel>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {BUCKETS.map((bucket) => (
                  <StatTile
                    key={bucket.key}
                    label={`RPM ${bucket.label}`}
                    value={formatNumber(dispatch.rpmBucketsTotal[bucket.key])}
                    hint="trucks this week"
                  />
                ))}
              </div>
            </div>
            <BarChart
              bare
              className="min-w-0"
              height={176}
              data={bucketData}
              xKey="band"
              xLabel="RPM band"
              series={[{ key: 'trucks', label: 'Trucks' }]}
              valueFormatter={(v) => formatNumber(v)}
              legend={false}
              tableView={false}
              ariaLabel={bucketLabel}
            />
          </div>
        </>
      ) : (
        <CompactTable
          caption="Dispatch teams, cumulative by week"
          columns={cumulativeColumns}
          rows={teams}
          rowKey={(t) => t.teamId}
          footer={cumulativeFooter}
        />
      )}
    </Card>
  );
}

export function DispatchWidgetSkeleton() {
  return <CardSkeleton lines={6} />;
}
