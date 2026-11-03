import {
  AlarmClock,
  ArrowDownRight,
  ArrowUpRight,
  BadgeDollarSign,
  Ban,
  Undo2,
  FlaskConical,
  Building2,
  CalendarClock,
  ChartColumn,
  Coins,
  DollarSign,
  Droplet,
  Fuel,
  Gauge,
  Package,
  PackageCheck,
  PackageOpen,
  Percent,
  PiggyBank,
  Receipt,
  Route,
  Tag,
  TrendingUp,
  Truck,
  UserPlus,
  UserSearch,
  Users,
} from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import type { MetricComparison, MetricKey } from '@neway/shared';
import { Link } from '@tanstack/react-router';
import { StatusSymbol, cn } from '@/design-system';
import { formatMoney, formatNumber } from '@/lib/format';
import {
  useAccessorialSplit,
  useCostDrivers,
  useDriverRankingPage,
  useFuelAnalytics,
  useOperationsAnalytics,
  useTruckRankingPage,
  useWorkforceAnalytics,
  type ExecutiveAnalytics,
  type RankingParams,
} from '../useInsights';
import { AccessorialSplitCard } from './AccessorialSplitCard';
import { NeedsAttention } from './AlertCard';
import { KpiTile, StatTileCard, type SparkSeries } from './KpiTile';
import { RankingExplorer } from './RankingExplorer';
import { RankedList, SplitBar } from './RankedList';
import {
  AnCard,
  AnCardHeader,
  DataSourceBadge,
  EmptyCard,
  LoadingBlock,
  Note,
  SectionError,
} from './ui';
import {
  DRIVER_COST_NOTE,
  attentionOrder,
  easternDateTime,
  categoryLabel,
  shareOfRevenueRanking,
  sparklineFor,
} from './view-model';
import { WeeklyChart } from './WeeklyChart';

const METRIC_ICON: Record<MetricKey, ReactNode> = {
  gross: <DollarSign />,
  cost: <Receipt />,
  profit: <TrendingUp />,
  marginPct: <Percent />,
  miles: <Route />,
  rpm: <Gauge />,
  cpm: <Coins />,
  ppm: <PiggyBank />,
  activeTrucks: <Truck />,
  grossPerTruck: <ChartColumn />,
  emptyPct: <Percent />,
  loads: <Package />,
  loadedMiles: <PackageCheck />,
  emptyMiles: <PackageOpen />,
  linehaul: <Route />,
  accessorials: <Receipt />,
  tonu: <Ban />,
  costBeforeRecovery: <Receipt />,
  recovered: <Undo2 />,
  linehaulRpm: <Gauge />,
};

const SPARK_SERIES: Partial<Record<MetricKey, SparkSeries>> = {
  gross: 'gross',
  cost: 'cost',
  profit: 'profit',
  miles: 'miles',
};

function KpiSkeletons({ count, className }: { count: number; className?: string }) {
  return (
    <div className={className} role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: count }, (_, i) => (
        <LoadingBlock key={i} className="h-[132px]" label="" />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------ executive

export function ExecutiveSection({
  query,
}: {
  query: { data?: ExecutiveAnalytics; error: unknown; isPending: boolean };
}) {
  if (query.error) return <SectionError title="Analytics could not be loaded" error={query.error} />;
  if (query.isPending || !query.data) {
    return (
      <div className="flex flex-col gap-4">
        <KpiSkeletons
          count={12}
          className="grid auto-rows-fr grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
        />
        <div className="grid gap-4 lg:grid-cols-3">
          <LoadingBlock className="h-80 lg:col-span-2" label="" />
          <LoadingBlock className="h-80" label="" />
        </div>
      </div>
    );
  }
  const data = query.data;
  const metrics = new Map(data.metrics.map((metric) => [metric.key, metric]));
  const money = (key: MetricKey) => {
    const value = metrics.get(key)?.current;
    return value === null || value === undefined ? '—' : formatMoney(value);
  };
  // Profit, margin and PPM are never shown from one side only; the server says why (F19).
  const hiddenReason = data.profitHidden?.reason || null;
  const revenueNotConnected = data.dataStatus ? !data.dataStatus.revenue.connected : false;

  return (
    <div className="flex flex-col gap-4">
      {revenueNotConnected ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-an-card border border-nw-warning-border bg-nw-warning-bg px-4 py-3"
          data-testid="revenue-not-connected"
        >
          <StatusSymbol family="warning" size={16} className="mt-0.5 text-nw-warning-icon" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-nw-warning-text">
              No loads in NeWay Loads — revenue not connected
            </p>
            <p className="mt-0.5 text-xs text-nw-text-2">
              Gross, RPM and profit stay empty until this company&apos;s loads are in NeWay Loads.
            </p>
          </div>
        </div>
      ) : null}
      <ul
        aria-label="Headline figures"
        className="grid auto-rows-fr grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
      >
        {EXECUTIVE_CARDS.map((key) => {
          const metric = metrics.get(key);
          if (!metric) return null;
          const series = SPARK_SERIES[key];
          const withheld =
            hiddenReason && (key === 'profit' || key === 'marginPct' || key === 'ppm')
              ? hiddenReason
              : null;
          const details =
            key === 'cost'
              ? [
                  { label: 'Before recovery', value: money('costBeforeRecovery') },
                  { label: 'Recovered', value: money('recovered') },
                  { label: 'Net cost', value: money('cost') },
                ]
              : key === 'gross'
                ? (
                    [
                      ['linehaul', 'Linehaul'],
                      ['accessorials', 'Accessorials'],
                      ['tonu', 'TONU'],
                    ] as const
                  )
                    .filter(([part]) => metrics.has(part))
                    .map(([part, name]) => ({ label: name, value: money(part) }))
                : undefined;
          return (
            <li key={key} className="h-full min-w-0">
              <KpiTile
                metric={metric}
                label={key === 'tonu' ? 'TONU' : undefined}
                icon={METRIC_ICON[key]}
                sparkline={series ? sparklineFor(key, data.trend) : null}
                sparkSeries={series}
                unavailableReason={withheld}
                details={details}
              />
            </li>
          );
        })}
      </ul>
      {data.notes.map((note) => (
        <Note key={note}>{note}</Note>
      ))}
      <div className="grid items-start gap-4 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <WeeklyChart points={data.trend} />
        </div>
        <NeedsAttention insights={attentionOrder(data.insights)} />
      </div>
    </div>
  );
}

/**
 * The headline cards, in reading order: money first, then miles and rates, then the fleet. TONU
 * has its own card and Linehaul RPM sits beside RPM (owner, 2026-10-25). Linehaul, accessorials,
 * cost before recovery and recovered are in the Gross and Cost cards' "how" popovers.
 */
const EXECUTIVE_CARDS: MetricKey[] = [
  'gross',
  'cost',
  'profit',
  'marginPct',
  'miles',
  'tonu',
  'rpm',
  'linehaulRpm',
  'cpm',
  'ppm',
  'activeTrucks',
  'grossPerTruck',
];

// ------------------------------------------------------------------------------------ financial

export function FinancialSection({ preset }: { preset: string }) {
  const costs = useCostDrivers(preset);
  if (costs.error) return <SectionError title="Costs could not be loaded" error={costs.error} />;
  if (costs.isPending) {
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        <LoadingBlock className="h-80 lg:col-span-2" />
        <LoadingBlock className="h-80" label="" />
      </div>
    );
  }
  const drivers = costs.data?.drivers ?? [];
  const notes = costs.data?.notes ?? [];
  const trailers = costs.data?.byTrailer ?? [];
  const unapplied = costs.data?.totals?.recoveredUnapplied ?? 0;
  const noteList = (
    <>
      {notes.map((note) => (
        <Note key={note}>{note}</Note>
      ))}
      {unapplied > 0 ? (
        <Note>
          {formatMoney(unapplied)} recovered is on file but not yet applied to a cost line, so it is
          not taken off the totals above.
        </Note>
      ) : null}
    </>
  );
  if (drivers.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <EmptyCard
          title="No cost data for this period"
          description="Cost intelligence appears once expenses are recorded in the range."
        />
        <AccessorialSplit preset={preset} />
        {noteList}
      </div>
    );
  }
  // A recovery is a negative cost: it has no share of revenue to rank.
  const ranked = shareOfRevenueRanking(drivers).filter(
    (d) => d.shareOfRevenue !== null && d.amount > 0,
  );

  // Columns that are empty for every row (no miles or no revenue this period) are left out rather
  // than shown as a column of dashes; the note above the table says why.
  const showPerMile = drivers.some((d) => d.perMile !== null);
  const showShare = drivers.some((d) => d.shareOfRevenue !== null);

  return (
    <div className="flex flex-col gap-4">
      {/* Top: the cost table (2/3) beside the share of revenue (1/3), one height. Below: trailer
          repairs across the full width (owner, 2026-10-25). */}
      <div className="grid items-stretch gap-4 lg:grid-cols-3">
        <AnCard className="flex min-w-0 flex-col lg:col-span-2">
          <AnCardHeader
            title="Where the money goes"
            description="Ranked by total. The rate per mile is what makes two periods comparable when miles change."
          />
          <div className="overflow-x-auto border-t border-an-card-border">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="border-b border-an-card-border text-xs font-semibold text-nw-text-2">
                  <th scope="col" className="h-10 px-5 text-left">Category</th>
                  <th scope="col" className="h-10 px-5 text-right">Cost</th>
                  {showPerMile ? <th scope="col" className="h-10 px-5 text-right">Per mile</th> : null}
                  {showShare ? <th scope="col" className="h-10 px-5 text-right">% of revenue</th> : null}
                  <th scope="col" className="h-10 px-5 text-right">vs previous</th>
                </tr>
              </thead>
              <tbody>
                {drivers.map((driver) => (
                  <tr key={driver.category} className="border-b border-an-card-border last:border-0 hover:bg-nw-hover">
                    <td className="h-11 px-5 font-medium text-nw-text">
                      {costCategoryLabel(driver.category)}
                      {driver.amount < 0 ? (
                        <span className="ml-2 text-xs font-normal text-nw-text-3">taken off cost</span>
                      ) : null}
                    </td>
                    <td
                      className={cn(
                        'h-11 px-5 text-right font-semibold tabular-nums text-nw-text',
                        driver.amount < 0 && 'text-nw-done-text',
                      )}
                    >
                      {formatMoney(driver.amount, { compact: true })}
                    </td>
                    {showPerMile ? (
                      <td className="h-11 px-5 text-right tabular-nums">
                        {driver.perMile === null ? <span className="text-nw-text-3">—</span> : formatMoney(driver.perMile)}
                      </td>
                    ) : null}
                    {showShare ? (
                      <td className="h-11 px-5 text-right tabular-nums">
                        {driver.shareOfRevenue === null ? (
                          <span className="text-nw-text-3">—</span>
                        ) : (
                          `${driver.shareOfRevenue.toFixed(1)}%`
                        )}
                      </td>
                    ) : null}
                    <td className="h-11 px-5 text-right tabular-nums">
                      <CostChange changePct={driver.changePct} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AnCard>
        <AnCard className="flex min-w-0 flex-col">
          <AnCardHeader title="Share of revenue" description="Each category's cost as a % of gross revenue." />
          <div className="flex flex-1 flex-col px-5 pb-5">
            {ranked.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-an-card-border px-4 py-8 text-center">
                <span className="text-sm font-semibold text-nw-text-2">No revenue this period</span>
                <span className="text-xs text-nw-text-3">Shares appear once delivered loads are in NeWay Loads.</span>
              </div>
            ) : (
              <RankedList
                label="Cost categories by share of revenue"
                barClassName="bg-an-cost"
                items={ranked.map((driver) => ({
                  key: driver.category,
                  label: costCategoryLabel(driver.category),
                  value: driver.shareOfRevenue ?? 0,
                  display: `${(driver.shareOfRevenue ?? 0).toFixed(1)}%`,
                  secondary: formatMoney(driver.amount, { compact: true }),
                }))}
              />
            )}
          </div>
        </AnCard>
      </div>
      <AccessorialSplit preset={preset} />
      <RepairsByUnit trucks={costs.data?.byTruck ?? []} trailers={trailers} />
      {noteList}
    </div>
  );
}

/** Accessorials - who gets what, paged on the server; the page resets with the period. */
function AccessorialSplit({ preset }: { preset: string }) {
  const [paging, setPaging] = useState({ preset, page: 1 });
  const page = paging.preset === preset ? paging.page : 1;
  const query = useAccessorialSplit(preset, page);
  if (query.error) return <SectionError title="Accessorials could not be loaded" error={query.error} />;
  if (query.isPending || !query.data) return <LoadingBlock className="h-56" />;
  return <AccessorialSplitCard data={query.data} onPageChange={(next) => setPaging({ preset, page: next })} />;
}

type UnitRepairs = { id: string | null; unitNumber: string | null; amount: number; orders: number };

/**
 * Repairs by unit (owner, 2026-10-25: "truck repair?"): trucks (repairs + maintenance written to
 * the truck) and trailers (written to the trailer, never to the truck pulling it), one list at a
 * time behind a Trucks / Trailers switch, most spent first.
 */
function RepairsByUnit({
  trucks,
  trailers,
}: {
  trucks: { truckId: string | null; unitNumber: string | null; amount: number; orders: number }[];
  trailers: { trailerId: string | null; unitNumber: string | null; amount: number; orders: number }[];
}) {
  const [kind, setKind] = useState<'trucks' | 'trailers'>(trucks.length > 0 ? 'trucks' : 'trailers');
  if (trucks.length === 0 && trailers.length === 0) return null;
  const rows: UnitRepairs[] =
    kind === 'trucks'
      ? trucks.map((t) => ({ id: t.truckId, unitNumber: t.unitNumber, amount: t.amount, orders: t.orders }))
      : trailers.map((t) => ({ id: t.trailerId, unitNumber: t.unitNumber, amount: t.amount, orders: t.orders }));
  const noun = kind === 'trucks' ? 'truck' : 'trailer';
  return (
    <AnCard className="min-w-0">
      <AnCardHeader
        title="Repairs by unit"
        description={
          kind === 'trucks'
            ? 'Repairs and maintenance written to each truck.'
            : 'Written to the trailer itself, never to the truck pulling it.'
        }
        actions={
          <div role="group" aria-label="Unit type" className="flex gap-0.5 rounded-full bg-an-pill-track p-0.5">
            {(
              [
                ['trucks', `Trucks · ${trucks.length}`],
                ['trailers', `Trailers · ${trailers.length}`],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
                className={cn(
                  'h-8 rounded-full px-3.5 text-[12.5px] font-semibold text-nw-text-2',
                  kind === value && 'bg-an-pill-active text-an-on-pill-active',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />
      {rows.length === 0 ? (
        <p className="border-t border-an-card-border px-5 py-6 text-sm text-nw-text-3">
          No {noun} repairs in this period.
        </p>
      ) : (
        <ol
          aria-label={`Repairs by ${noun}`}
          className="grid gap-x-6 border-t border-an-card-border px-5 py-2 sm:grid-cols-2 xl:grid-cols-3"
        >
          {rows.map((row, index) => (
            <li key={row.id ?? 'none'} className="flex items-center gap-3 border-b border-an-card-border py-2.5 text-sm">
              <span className="w-5 shrink-0 text-right text-xs text-nw-text-3 tabular-nums">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate font-medium text-nw-text">
                {row.unitNumber ?? row.id ?? `Unknown ${noun}`}
              </span>
              <span className="shrink-0 text-xs text-nw-text-3">
                {formatNumber(row.orders)} {row.orders === 1 ? 'order' : 'orders'}
              </span>
              <span className="w-24 shrink-0 text-right font-semibold text-nw-text tabular-nums">
                {formatMoney(row.amount)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </AnCard>
  );
}


/** Cost category names: the old wording, with the data-integrity categories spelled out. */
function costCategoryLabel(category: string): string {
  if (category === 'def') return 'DEF';
  if (category === 'recovered') return 'Recovered';
  return categoryLabel(category);
}

/** A cost moving up is bad and down is good: an arrow and the figure, never colour alone. */
function CostChange({ changePct }: { changePct: number | null }) {
  if (changePct === null) return <span className="text-nw-text-3">—</span>;
  const up = changePct > 0;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn('inline-flex items-center gap-1', up ? 'text-nw-urgent-text' : 'text-nw-done-text')}>
      {changePct !== 0 ? <Arrow aria-hidden className="size-3.5" /> : null}
      {`${up ? '+' : ''}${changePct.toFixed(1)}%`}
    </span>
  );
}

// ----------------------------------------------------------------------------------- operations

function byKey(metrics: MetricComparison[], key: MetricKey): MetricComparison | undefined {
  return metrics.find((metric) => metric.key === key);
}

export function OperationsSection({ preset }: { preset: string }) {
  const ops = useOperationsAnalytics(preset);
  if (ops.error) return <SectionError title="Operations could not be loaded" error={ops.error} />;
  if (ops.isPending || !ops.data) {
    return <KpiSkeletons count={6} className="grid auto-rows-fr grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" />;
  }
  const data = ops.data;
  const cards: { metric: MetricComparison | undefined; label: string }[] = [
    { metric: byKey(data.volume, 'loads'), label: 'Loads delivered' },
    { metric: byKey(data.metrics, 'miles'), label: 'Total miles' },
    { metric: byKey(data.volume, 'loadedMiles'), label: 'Loaded miles' },
    { metric: byKey(data.volume, 'emptyMiles'), label: 'Empty miles' },
    { metric: byKey(data.metrics, 'emptyPct'), label: 'Empty miles %' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <ul
        aria-label="Operations figures"
        className="grid auto-rows-fr grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"
      >
        {cards.map(({ metric, label }) =>
          metric ? (
            <li key={metric.key} className="h-full min-w-0">
              <KpiTile metric={metric} label={label} icon={METRIC_ICON[metric.key]} />
            </li>
          ) : null,
        )}
        {data.tonuLoads !== undefined ? (
          <li className="h-full min-w-0">
            <StatTileCard
              label="TONU loads"
              icon={<Ban />}
              value={data.tonuLoads}
              format={(value) => (value === null ? '—' : formatNumber(value))}
              info="Truck-ordered-not-used lines in the period, counted apart from delivered loads."
            />
          </li>
        ) : null}
      </ul>
      <AnCard>
        <AnCardHeader
          title="Loaded vs empty miles"
          description="Empty miles are the deadhead recorded on delivered loads."
        />
        <div className="px-5 pb-5">
          <SplitBar
            loaded={data.loadedMiles}
            empty={data.emptyMiles}
            format={(value) => formatNumber(value)}
          />
        </div>
      </AnCard>
      {/* Server notes, except the dwell sentence the owner reworded below (2026-10-25). */}
      {data.notes
        .filter((note) => !note.includes('On-time and dwell'))
        .map((note) => (
          <Note key={note}>{note}</Note>
        ))}
      <Note>On-time and dwell aren&apos;t tracked yet.</Note>
    </div>
  );
}

// ---------------------------------------------------------------------------------------- fleet

function useRankingParams(defaults: Pick<RankingParams, 'sort' | 'dir'>) {
  const [params, setParams] = useState<RankingParams>({
    page: 1,
    pageSize: 25,
    q: '',
    ...defaults,
  });
  const update = useCallback((next: RankingParams) => setParams(next), []);
  return [params, update] as const;
}

export function FleetSection({ preset }: { preset: string }) {
  const fuel = useFuelAnalytics(preset);
  const [params, setParams] = useRankingParams({ sort: 'profit', dir: 'desc' });
  const trucks = useTruckRankingPage(preset, params);
  const money = (value: number | null) => (value === null ? '—' : formatMoney(value));

  return (
    <div className="flex flex-col gap-4">
      {fuel.error ? (
        <SectionError title="Fuel could not be loaded" error={fuel.error} />
      ) : fuel.isPending || !fuel.data ? (
        <KpiSkeletons count={5} className="grid auto-rows-fr grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" />
      ) : (
        <>
          <ul aria-label="Fuel figures" className="grid auto-rows-fr grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <li className="h-full min-w-0">
              <StatTileCard
                label="Diesel spend"
                icon={<Fuel />}
                value={fuel.data.totals.discountedCost}
                format={(value) => (value === null ? '—' : formatMoney(value, { compact: true }))}
              />
            </li>
            <li className="h-full min-w-0">
              <StatTileCard
                label="Diesel gallons"
                icon={<Droplet />}
                value={Math.round(fuel.data.totals.gallons)}
                format={(value) => (value === null ? '—' : formatNumber(Math.round(value)))}
              />
            </li>
            <li className="h-full min-w-0">
              <StatTileCard
                label="Diesel $/gal"
                icon={<Tag />}
                value={fuel.data.totals.avgPricePerGallon}
                format={money}
              />
            </li>
            <li className="h-full min-w-0">
              <StatTileCard
                label="Diesel per mile"
                icon={<BadgeDollarSign />}
                value={fuel.data.totals.fuelCostPerMile}
                format={money}
              />
            </li>
            {fuel.data.totals.def ? (
              <li className="h-full min-w-0">
                <StatTileCard
                  label="DEF"
                  icon={<FlaskConical />}
                  value={fuel.data.totals.def.cost}
                  format={(value) => (value === null ? '—' : formatMoney(value, { compact: true }))}
                  hint={`${formatNumber(Math.round(fuel.data.totals.def.gallons))} gal · kept apart from diesel`}
                />
              </li>
            ) : null}
          </ul>
          {fuel.data.freshness ? (
            <p className="text-xs font-medium text-nw-text-2" data-testid="fuel-freshness">
              {fuel.data.freshness.latestAt
                ? `Fuel feed last updated ${easternDateTime(fuel.data.freshness.latestAt)}.`
                : fuel.data.freshness.rowsInPeriod > 0
                  ? `${formatNumber(fuel.data.freshness.rowsInPeriod)} fuel rows in this period; the feed's last update time is not recorded.`
                  : 'No fuel feed rows in this period.'}
            </p>
          ) : null}
          {fuel.data.totals.reasons.length > 0 ? <Note>{fuel.data.totals.reasons.join(' ')}</Note> : null}
          {fuel.data.notes
            .filter((note) => !note.startsWith('Fuel card feed: newest transaction'))
            .map((note) => (
              <Note key={note}>{note}</Note>
            ))}
        </>
      )}
      <RankingExplorer
        entity="truck"
        title="Truck profitability"
        query={trucks}
        params={params}
        onParamsChange={setParams}
      />
    </div>
  );
}

// -------------------------------------------------------------------------------------- drivers

const TOP_FIVE: RankingParams = { page: 1, pageSize: 5, sort: 'gross', dir: 'desc', q: '' };

export function DriverSection({ preset }: { preset: string }) {
  const top = useDriverRankingPage(preset, TOP_FIVE);
  const [params, setParams] = useRankingParams({ sort: 'gross', dir: 'desc' });
  const drivers = useDriverRankingPage(preset, params);

  return (
    <div className="flex flex-col gap-4">
      <Note>{DRIVER_COST_NOTE}</Note>
      <div className="grid items-start gap-4 lg:grid-cols-3">
        <AnCard className="min-w-0">
          <AnCardHeader title="Top 5 by Gross" description="Drivers with the most revenue in the period." />
          <div className="px-5 pb-5">
            {top.error ? (
              <SectionError title="Drivers could not be loaded" error={top.error} />
            ) : top.isPending ? (
              <LoadingBlock className="h-56" />
            ) : !top.data || top.data.rows.length === 0 ? (
              <p className="text-sm text-nw-text-3">No driver activity for this period.</p>
            ) : (
              <RankedList
                label="Top 5 drivers by gross"
                items={top.data.rows.map((row) => ({
                  key: row.id,
                  label: (
                    <Link
                      to={row.href as never}
                      className="hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-an-accent"
                    >
                      {row.label}
                    </Link>
                  ),
                  value: row.gross,
                  display: formatMoney(row.gross, { compact: true }),
                  secondary:
                    row.miles === null ? undefined : `${formatNumber(Math.round(row.miles))} mi`,
                }))}
              />
            )}
          </div>
        </AnCard>
        <div className="min-w-0 lg:col-span-2">
          <RankingExplorer
            entity="driver"
            title="Driver revenue"
            query={drivers}
            params={params}
            onParamsChange={setParams}
          />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------ workforce

function candidatesBasisText(basis: string | undefined): string | undefined {
  if (basis === 'open_leads') {
    return 'Open hiring leads: not converted to a driver, not closed as dead, and not test data.';
  }
  return basis ? `Counted as: ${basis.replace(/_/g, ' ')}.` : undefined;
}

export function WorkforceSection() {
  const workforce = useWorkforceAnalytics();
  if (workforce.error) return <SectionError title="Workforce could not be loaded" error={workforce.error} />;
  if (workforce.isPending || !workforce.data) {
    return <KpiSkeletons count={7} className="grid auto-rows-fr grid-cols-2 gap-3 lg:grid-cols-4" />;
  }
  const data = workforce.data;
  const count = (value: number | null) => (value === null ? '—' : formatNumber(value));
  const stats: { label: string; value: number; icon: ReactNode; info?: string }[] = [
    { label: 'Headcount', value: data.headcount, icon: <Users /> },
    { label: 'Drivers', value: data.drivers, icon: <Truck /> },
    ...(data.driversOnboarding !== undefined
      ? [{ label: 'Drivers onboarding', value: data.driversOnboarding, icon: <UserPlus /> }]
      : []),
    { label: 'Office & operations', value: data.staff, icon: <Building2 /> },
    { label: 'In onboarding', value: data.onboardingActive, icon: <UserPlus /> },
    { label: 'PTO awaiting decision', value: data.ptoPending, icon: <CalendarClock /> },
    { label: 'Attendance exceptions', value: data.attendanceExceptions, icon: <AlarmClock /> },
    {
      label: 'Candidates in pipeline',
      value: data.candidatesInPipeline,
      icon: <UserSearch />,
      info: candidatesBasisText(data.candidatesBasis),
    },
  ];
  const departments = [...data.byDepartment].sort((a, b) => b.count - a.count);

  return (
    <div className="flex flex-col gap-4">
      <ul aria-label="Workforce figures" className="grid auto-rows-fr grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((stat) => (
          <li key={stat.label} className="h-full min-w-0">
            <StatTileCard
              label={stat.label}
              value={stat.value}
              icon={stat.icon}
              format={count}
              info={stat.info}
            />
          </li>
        ))}
      </ul>
      <AnCard>
        <AnCardHeader
          title="Headcount by department"
          description={
            data.driversOnboarding !== undefined
              ? 'Office and operations staff currently employed, by department.'
              : 'People currently employed, by department.'
          }
          actions={<DataSourceBadge source={data.source} />}
        />
        <div className="px-5 pb-5">
          {departments.length === 0 ? (
            <p className="text-sm text-nw-text-3">No employees on file.</p>
          ) : (
            <RankedList
              label="Headcount by department"
              items={departments.map((row) => ({
                key: row.department,
                label: categoryLabel(row.department),
                value: row.count,
                display: formatNumber(row.count),
              }))}
            />
          )}
        </div>
      </AnCard>
      {data.notes.map((note) => (
        <Note key={note}>{note}</Note>
      ))}
    </div>
  );
}
