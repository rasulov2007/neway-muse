import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Building2,
  CalendarDays,
  ChartPie,
  ClipboardList,
  Info,
  Minus,
  MoreHorizontal,
  Receipt,
  Search,
  ShieldAlert,
  Truck,
  Upload,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  MAINTENANCE_TYPE_LABEL,
  type FleetAnomaly,
  type FleetExpenseSummary,
  type FleetMetric,
  type FleetSpendPeriod,
  type FleetUnitTypeFilter,
  type FleetVendorRow,
} from '@neway/shared';
import {
  Badge,
  BarChart,
  Button,
  Combobox,
  DataTable,
  DonutChart,
  DropdownMenu,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  KpiCard,
  MenuItem,
  PageHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SectionCard,
  Select,
  StatTile,
  StatusBadge,
  Tabs,
  cn,
  createColumns,
  getStatus,
  useDataTableState,
  type ChartTableView,
  type DonutSlice,
  type KpiDelta,
  type StatusTone,
} from '@/design-system';
import { conditionCandidates } from '@/demo';
import { formatIsoDate, formatMoney, formatNumber, formatRpm } from '@/lib/format';
import { AnomaliesDrawer, ExpenseRecordsDrawer, VendorsDrawer } from './components/ExpenseDrawers';
import { expenseSearchSchema, parseUnits, type ExpenseSearch } from './expense-search';
import { useFleetExpense, useTruckOptions } from './useFleetExpense';

/**
 * The Fleet landing page: what maintenance cost, by unit, vendor and service type.
 *
 * Every figure on this screen was aggregated on the server from the workspace's own records and
 * comes back with the ids behind it. The page adds nothing: no modelled numbers, no trend it did
 * not receive, no alert without a rule. A figure the records cannot support shows a dash and the
 * reason, in place, and the six-card strip is allowed to hold fewer than six numbers.
 */

const PERIODS: Array<{ value: FleetSpendPeriod; label: string; toDate: string }> = [
  { value: 'week', label: 'Week', toDate: 'Week to date' },
  { value: 'month', label: 'Month', toDate: 'Month to date' },
  { value: 'quarter', label: 'Quarter', toDate: 'Quarter to date' },
  { value: 'year', label: 'Year', toDate: 'Year to date' },
];

const UNIT_TYPES: Array<{ value: FleetUnitTypeFilter; label: string }> = [
  { value: 'all', label: 'All units' },
  { value: 'truck', label: 'Trucks' },
  { value: 'trailer', label: 'Trailers' },
];

/**
 * Legend keys for the service-category donut as token utilities rather than an inline colour.
 * Same order as `chartTheme.series`; a seventh category folds to the neutral "Other" like
 * `seriesColor` does.
 */
const SERIES_KEY_CLASS = [
  'bg-nw-chart-1',
  'bg-nw-chart-2',
  'bg-(--chart-series-3)',
  'bg-(--chart-series-4)',
  'bg-(--chart-series-5)',
  'bg-(--chart-series-6)',
] as const;
const seriesKeyClass = (index: number) => SERIES_KEY_CLASS[index] ?? 'bg-nw-text-3';

const TOP_VENDORS = 8;
const TOP_SERVICE_TYPES = 8;
const TOP_FINDINGS = 5;
const VEHICLES_PAGE_SIZE = 10;

/** The selected period pill is filled blue; the rest stay quiet. */
const PILL_TABS =
  'gap-1 rounded-lg bg-surface-muted p-0.5 ' +
  '[&>[data-state=active]]:bg-primary! [&>[data-state=active]]:text-inverse! [&>[data-state=active]]:shadow-xs';

type Severity = FleetAnomaly['severity'];

const SEVERITY: Record<Severity, { tone: StatusTone; label: string; icon: typeof Info }> = {
  critical: { tone: 'danger', label: 'Critical', icon: ShieldAlert },
  warning: { tone: 'warning', label: 'Warning', icon: AlertTriangle },
  info: { tone: 'neutral', label: 'To review', icon: Info },
};

interface RecordsView {
  title: string;
  description?: string;
  recordIds: string[];
}

type OnRecords = (title: string, ids: string[], description?: string) => void;

export function FleetExpensePage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => expenseSearchSchema.parse(rawSearch), [rawSearch]);
  const navigate = useNavigate();
  const period = search.period ?? 'year';
  const unitType = search.unitType ?? 'all';
  const units = useMemo(() => parseUnits(search.units), [search.units]);

  const summary = useFleetExpense({ period, units, unitType });
  const trucks = useTruckOptions();
  const data = summary.data;

  const [records, setRecords] = useState<RecordsView | null>(null);
  const [vendorsOpen, setVendorsOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [allServiceTypes, setAllServiceTypes] = useState(false);

  function updateSearch(patch: Partial<ExpenseSearch>) {
    void navigate({
      to: '/fleet',
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        for (const key of Object.keys(next)) {
          if (next[key] === undefined || next[key] === '') delete next[key];
        }
        return next;
      },
      replace: true,
    });
  }

  const openRecords: OnRecords = (title, recordIds, description) =>
    setRecords({ title, recordIds, description });
  const openFinding = (finding: FleetAnomaly) =>
    openRecords(finding.title, finding.recordIds, finding.detail);

  const unitOptions = useMemo(
    () =>
      (trucks.data ?? [])
        .map((truck) => ({
          value: truck.id,
          label: truck.unitNumber,
          description: `${truck.year} ${truck.make} ${truck.model} · ${truck.status.replace(/_/g, ' ')}`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    [trucks.data],
  );

  const scopeLabel =
    units.length === 0
      ? 'All units'
      : `${units.length} unit${units.length === 1 ? '' : 's'} selected`;
  const rangeLabel = data?.meta.period.label;

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Fleet maintenance"
        description="Maintenance spending and fleet health."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Combobox
              multiple
              aria-label="Units"
              options={unitOptions}
              value={units}
              onValueChange={(next) =>
                updateSearch({ units: next.length > 0 ? next.join(',') : undefined })
              }
              placeholder={scopeLabel}
              searchPlaceholder="Type a unit number…"
              emptyMessage="No unit matches"
              loading={trucks.isPending}
              className="min-w-56"
            />
            <Button
              variant="secondary"
              icon={<Upload />}
              disabled={!data || data.vehicles.rows.length === 0}
              onClick={() => data && exportVehiclesCsv(data)}
            >
              Export
            </Button>
          </div>
        }
      />

      <PeriodRow
        data={data}
        period={period}
        unitType={unitType}
        onPeriod={(value) => updateSearch({ period: value })}
        onUnitType={(value) => updateSearch({ unitType: value === 'all' ? undefined : value })}
      />

      {summary.isError ? (
        <ErrorState
          title="The expense summary could not be loaded"
          description="The figures come from the server; nothing is computed here without it."
          error={summary.error}
          onRetry={() => void summary.refetch()}
          retrying={summary.isFetching}
        />
      ) : null}

      <KpiStrip data={data} loading={summary.isPending} onRecords={openRecords} />

      {data ? <MileageNotice metric={data.kpis.costPerMile} /> : null}

      {data && data.events.length === 0 && !summary.isPending ? (
        <EmptyState
          icon={<Receipt />}
          title="No completed maintenance in this period"
          description={`Completed work orders and standalone service records dated ${data.meta.period.label} would appear here. ${excludedSentence(data)}`}
          action={
            <Link
              to="/fleet/maintenance"
              className="text-sm font-medium text-primary-text hover:underline"
            >
              Open Maintenance
            </Link>
          }
        />
      ) : null}

      <div className="grid gap-(--section-gap) lg:grid-cols-2">
        <VendorsChart
          data={data}
          loading={summary.isPending}
          onViewAll={() => setVendorsOpen(true)}
          onRecords={openRecords}
        />
        <CategoriesChart data={data} loading={summary.isPending} onRecords={openRecords} />
      </div>

      <SectionHeading title="Service insights" range={rangeLabel} />

      <ConditionCandidates />

      <ServiceTypes
        data={data}
        loading={summary.isPending}
        showAll={allServiceTypes}
        onToggle={() => setAllServiceTypes((v) => !v)}
        onRecords={openRecords}
      />

      {/* Not "Vehicles & issues": Playwright matches headings by substring, and the e2e specs look
          for the "Vehicles" card heading alone. */}
      <SectionHeading title="Vehicles & issues" range={rangeLabel} />

      <div className="grid gap-(--section-gap) xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <VehiclesTable data={data} loading={summary.isPending} onRecords={openRecords} />
        <IssuesPanel
          data={data}
          loading={summary.isPending}
          onReview={() => setIssuesOpen(true)}
          onRecords={openFinding}
        />
      </div>

      {data ? <Coverage data={data} /> : null}

      <ExpenseRecordsDrawer
        open={records !== null}
        onOpenChange={(open) => !open && setRecords(null)}
        title={records?.title ?? ''}
        description={records?.description}
        events={data?.events ?? []}
        recordIds={records?.recordIds ?? []}
      />
      <VendorsDrawer
        open={vendorsOpen}
        onOpenChange={setVendorsOpen}
        vendors={data?.vendors.rows ?? []}
        onSelect={(vendor) => {
          setVendorsOpen(false);
          openRecords(vendor.name, vendor.recordIds, 'Every counted record with this vendor');
        }}
      />
      <AnomaliesDrawer
        open={issuesOpen}
        onOpenChange={setIssuesOpen}
        findings={data?.anomalies.findings ?? []}
        checks={data?.anomalies.checks ?? []}
        onRecords={(finding) => {
          setIssuesOpen(false);
          openFinding(finding);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Header and period
// ---------------------------------------------------------------------------------------------

function excludedSentence(data: FleetExpenseSummary): string {
  const { excluded } = data.coverage;
  const parts: string[] = [];
  if (excluded.notCompleted > 0) parts.push(`${excluded.notCompleted} still open`);
  if (excluded.draftOrCancelled > 0) parts.push(`${excluded.draftOrCancelled} draft or cancelled`);
  if (excluded.missingCompletionDate > 0)
    parts.push(`${excluded.missingCompletionDate} without a completion date`);
  if (excluded.unknownAmount > 0) parts.push(`${excluded.unknownAmount} without an amount`);
  return parts.length > 0 ? `Not counted: ${parts.join(', ')}.` : '';
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The vehicles table as a file: the rows on screen, nothing recomputed. */
function exportVehiclesCsv(data: FleetExpenseSummary) {
  const header = [
    'Unit',
    'Kind',
    'Vehicle',
    'Status',
    'Top service',
    'Events',
    'Spend',
    'Trend %',
    'Flags',
  ];
  const lines = data.vehicles.rows.map((row) =>
    [
      row.unitNumber,
      row.kind,
      row.description,
      row.status,
      row.topTypeLabel ?? '',
      row.events,
      row.spend.toFixed(2),
      row.trendPct === null ? '' : row.trendPct.toFixed(1),
      row.flags,
    ]
      .map(csvCell)
      .join(','),
  );
  const blob = new Blob([[header.join(','), ...lines].join('\n')], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `fleet-vehicles-${data.meta.period.from}-${data.meta.period.to}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function PeriodRow({
  data,
  period,
  unitType,
  onPeriod,
  onUnitType,
}: {
  data: FleetExpenseSummary | undefined;
  period: FleetSpendPeriod;
  unitType: FleetUnitTypeFilter;
  onPeriod: (value: FleetSpendPeriod) => void;
  onUnitType: (value: FleetUnitTypeFilter) => void;
}) {
  // Only the selected preset's range is known: the server resolves the dates in the workspace's
  // timezone, and the page does not second-guess it for the other three.
  const options = PERIODS.map((p) => ({
    value: p.value,
    label: p.value === period && data ? data.meta.period.label : p.toDate,
  }));
  const coverage = data?.coverage;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="relative">
          <CalendarDays
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted"
          />
          <Select
            aria-label="Date range"
            options={options}
            value={period}
            onValueChange={(value) => onPeriod(value as FleetSpendPeriod)}
            className="min-w-52 pl-8 font-medium"
          />
        </div>
        {data && coverage ? (
          <p className="text-sm text-secondary">
            Compared with {data.meta.period.comparison.label}
            {' · '}
            {formatNumber(coverage.workOrdersCounted)} completed work order
            {coverage.workOrdersCounted === 1 ? '' : 's'}
            {' · '}
            {formatNumber(coverage.serviceRecordsCounted)} service record
            {coverage.serviceRecordsCounted === 1 ? '' : 's'}
            {data.meta.filters.unknownUnits.length > 0
              ? ` · ${data.meta.filters.unknownUnits.length} selected unit id${data.meta.filters.unknownUnits.length === 1 ? ' is' : 's are'} not on the roster and was ignored`
              : ''}
          </p>
        ) : null}
        {/* Whose money this is. Owner-billed repairs are the driver's cost, so they are named
            rather than folded into the company's spend - otherwise the numbers describe nobody. */}
        {coverage ? (
          <p className="text-sm text-secondary">
            {coverage.ownerBilled.orders > 0
              ? `Company-billed repairs only. A further ${formatMoney(coverage.ownerBilled.amount)} on ${formatNumber(coverage.ownerBilled.orders)} order${coverage.ownerBilled.orders === 1 ? '' : 's'} is billed to owner-operators and lease drivers and is not counted here.`
              : 'Every repair in this period is billed to the company; nothing is charged to an owner-operator or lease driver.'}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          variant="segmented"
          size="sm"
          aria-label="Unit type"
          items={UNIT_TYPES}
          value={unitType}
          onValueChange={(value) => onUnitType(value as FleetUnitTypeFilter)}
        />
        <Tabs
          variant="segmented"
          size="sm"
          aria-label="Period"
          items={PERIODS}
          value={period}
          listClassName={PILL_TABS}
          onValueChange={(value) => onPeriod(value as FleetSpendPeriod)}
        />
      </div>
    </div>
  );
}

function SectionHeading({ title, range }: { title: string; range?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {range ? <span className="text-sm text-muted">{range}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------------------------

function delta(metric: FleetMetric, positiveIsGood = false): KpiDelta | undefined {
  if (metric.deltaPct === null || metric.current) return undefined;
  return { value: metric.deltaPct, label: 'vs prior period', positiveIsGood };
}

function metricValue(metric: FleetMetric, format: (value: number) => string): string {
  return metric.value === null ? '—' : format(metric.value);
}

/**
 * How much of the fleet a figure actually measured, said out loud.
 *
 * A figure measured over most of the fleet says nothing here; one measured over 70-89% of it wears
 * a Medium chip, so the reader knows what they are holding. Below that the server withholds the
 * figure altogether and the hint carries the coverage instead (acceptance test A16).
 */
function ConfidenceChip({ metric }: { metric: FleetMetric | undefined }) {
  const confidence = metric?.confidence;
  if (!confidence || confidence.level === 'high') return null;
  return (
    <Badge
      tone="warning"
      variant="outline"
      size="sm"
      title={`Measured over ${confidence.covered} of ${confidence.total} trucks (${confidence.coveragePct}%)`}
    >
      {confidence.level === 'medium' ? 'Medium confidence' : `${confidence.coveragePct}% coverage`}
    </Badge>
  );
}

function KpiStrip({
  data,
  loading,
  onRecords,
}: {
  data: FleetExpenseSummary | undefined;
  loading: boolean;
  onRecords: OnRecords;
}) {
  const navigate = useNavigate();
  const k = data?.kpis;
  const hint = (metric: FleetMetric | undefined, fallback: string) =>
    metric ? (metric.reasons[0] ?? fallback) : fallback;
  const link = (metric: FleetMetric | undefined) =>
    metric?.link
      ? () =>
          void navigate({
            to: metric.link?.to as never,
            search: (metric.link?.search ?? {}) as never,
          })
      : undefined;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
      <KpiCard
        label="Total maintenance spend"
        value={k ? metricValue(k.totalSpend, formatMoney) : '—'}
        delta={k ? delta(k.totalSpend) : undefined}
        hint={hint(k?.totalSpend, 'Completed work orders and standalone service records')}
        loading={loading}
        onClick={
          k
            ? () => onRecords('Total maintenance spend', k.totalSpend.recordIds, k.totalSpend.basis)
            : undefined
        }
        title={k?.totalSpend.basis}
      />
      <KpiCard
        label={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            Maintenance cost / mile
            <ConfidenceChip metric={k?.costPerMile} />
          </span>
        }
        value={k ? metricValue(k.costPerMile, (v) => `${formatRpm(v)}/mi`) : '—'}
        delta={k ? delta(k.costPerMile) : undefined}
        hint={
          k && k.costPerMile.value !== null
            ? 'Spend over odometer-covered miles'
            : hint(k?.costPerMile, 'Spend over odometer-covered miles')
        }
        loading={loading}
        onClick={
          k && k.costPerMile.value !== null
            ? () =>
                onRecords(
                  'Spend behind cost per mile',
                  k.costPerMile.recordIds,
                  k.costPerMile.basis,
                )
            : undefined
        }
        title={k?.costPerMile.basis}
      />
      <KpiCard
        label="In shop now"
        value={k ? metricValue(k.inShopNow, formatNumber) : '—'}
        hint="Current status, as stored now"
        loading={loading}
        onClick={link(k?.inShopNow)}
        title={k?.inShopNow.basis}
      />
      <KpiCard
        label="Average per vehicle"
        value={k ? metricValue(k.averagePerVehicle, formatMoney) : '—'}
        delta={k ? delta(k.averagePerVehicle) : undefined}
        hint={
          k
            ? `Per unit on the roster now — ${k.averagePerVehicle.basis.match(/\((\d+ trucks, \d+ trailers)/)?.[1] ?? 'not sold'}`
            : 'Per unit on the roster now (not sold)'
        }
        loading={loading}
        onClick={
          k
            ? () =>
                onRecords(
                  'Spend on units on the roster',
                  k.averagePerVehicle.recordIds,
                  k.averagePerVehicle.basis,
                )
            : undefined
        }
        title={k?.averagePerVehicle.basis}
      />
      <KpiCard
        label="Inactive now"
        value={k ? metricValue(k.inactiveNow, formatNumber) : '—'}
        hint="Current status inactive; there is no status history"
        loading={loading}
        onClick={link(k?.inactiveNow)}
        title={k?.inactiveNow.basis}
      />
      <KpiCard
        label="Lease overage"
        value={k ? metricValue(k.leaseOverage, formatMoney) : '—'}
        hint={k ? 'Lease mileage terms not configured' : 'Lease terms'}
        loading={loading}
        title={k?.leaseOverage.reasons[0] ?? k?.leaseOverage.basis}
      />
    </div>
  );
}

/**
 * The cost-per-mile figure leaves out units without usable odometer readings. The server names
 * them in the metric's reasons; the bar surfaces the count and "Details" shows every reason.
 */
function MileageNotice({ metric }: { metric: FleetMetric }) {
  const leftOut = metric.reasons
    .map((reason) => /^(\d+) (?:trucks|units) left out/.exec(reason)?.[1])
    .find((n) => n !== undefined);
  if (metric.value === null || leftOut === undefined) return null;
  const count = Number(leftOut);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-info-soft px-4 py-2.5 text-sm text-info-text">
      <span className="flex items-center gap-2">
        <Info aria-hidden className="size-4 shrink-0" />
        Cost per mile excludes {formatNumber(count)} unit{count === 1 ? '' : 's'} with incomplete or
        inconsistent odometer readings.
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="link" size="sm" iconRight={<ArrowRight />}>
            Details
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="max-w-sm text-xs">
          <p className="mb-2 font-medium text-ink">How cost per mile was counted</p>
          <p className="text-secondary">{metric.basis}.</p>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-secondary">
            {metric.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Vendors and categories
// ---------------------------------------------------------------------------------------------

type ChartView = 'chart' | 'table';

function ViewToggle({ value, onChange }: { value: ChartView; onChange: (v: ChartView) => void }) {
  return (
    <div
      role="group"
      aria-label="View"
      className="inline-flex items-center gap-0.5 rounded-md bg-surface-muted p-0.5"
    >
      {(['chart', 'table'] as const).map((view) => (
        <button
          key={view}
          type="button"
          aria-pressed={value === view}
          className={cn(
            'h-6 rounded px-2.5 text-xs font-medium transition-colors duration-(--duration-base)',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
            value === view ? 'bg-primary text-inverse shadow-xs' : 'text-secondary hover:text-ink',
          )}
          onClick={() => onChange(view)}
        >
          {view === 'chart' ? 'Chart' : 'Table'}
        </button>
      ))}
    </div>
  );
}

function SimpleTable({ view, caption }: { view: ChartTableView; caption: string }) {
  return (
    <table className="w-full border-collapse text-xs">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {view.columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              className={cn(
                'border-b border-line py-1.5 pr-3 text-2xs font-medium tracking-eyebrow text-muted uppercase',
                column.align === 'right' ? 'text-right' : 'text-left',
              )}
            >
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {view.rows.map((row, index) => (
          <tr key={index}>
            {view.columns.map((column) => (
              <td
                key={column.key}
                className={cn(
                  'border-b border-line-soft py-1.5 pr-3 text-secondary',
                  column.align === 'right' ? 'tabular text-right' : 'text-left',
                )}
              >
                {row[column.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VendorsChart({
  data,
  loading,
  onViewAll,
  onRecords,
}: {
  data: FleetExpenseSummary | undefined;
  loading: boolean;
  onViewAll: () => void;
  onRecords: OnRecords;
}) {
  const [view, setView] = useState<ChartView>('chart');
  const rows = data?.vendors.rows ?? [];
  const top = rows.slice(0, TOP_VENDORS);
  const chartData = top.map((row) => ({ vendor: row.name, spend: row.spend, key: row.key }));
  const table: ChartTableView = {
    columns: [
      { key: 'vendor', label: 'Vendor', align: 'left' },
      { key: 'events', label: 'Events', align: 'right' },
      { key: 'spend', label: 'Spend', align: 'right' },
    ],
    rows: top.map((row) => ({
      vendor: (
        <button
          type="button"
          className="text-primary-text hover:underline"
          onClick={() =>
            onRecords(row.name, row.recordIds, 'Every counted record with this vendor')
          }
        >
          {row.name}
        </button>
      ),
      events: formatNumber(row.events),
      spend: formatMoney(row.spend),
    })),
  };
  return (
    <SectionCard
      icon={<Building2 />}
      title="Top vendors by spend"
      description={
        rows.length > TOP_VENDORS
          ? `Top ${TOP_VENDORS} of ${rows.length}, grouped by vendor name as written`
          : 'Grouped by vendor name as written on each record'
      }
      actions={
        <>
          {rows.length > 0 ? (
            <Button variant="link" size="sm" onClick={onViewAll}>
              View all
            </Button>
          ) : null}
          <ViewToggle value={view} onChange={setView} />
        </>
      }
      padding="sm"
    >
      {view === 'table' && !loading && rows.length > 0 ? (
        <div className="scroll-quiet overflow-auto" style={{ maxHeight: 284 }}>
          <SimpleTable view={table} caption="Top vendors by spend" />
        </div>
      ) : (
        <BarChart
          bare
          ariaLabel="Top vendors by spend"
          data={chartData}
          xKey="vendor"
          xLabel="Vendor"
          series={[{ key: 'spend', label: 'Spend' }]}
          valueFormatter={(value) => formatMoney(value, { compact: true })}
          xFormatter={(value) => shorten(String(value))}
          tableView={false}
          loading={loading}
          empty={!loading && rows.length === 0}
          height={260}
        />
      )}
    </SectionCard>
  );
}

function shorten(name: string): string {
  return name.length > 14 ? `${name.slice(0, 13)}…` : name;
}

function CategoriesChart({
  data,
  loading,
  onRecords,
}: {
  data: FleetExpenseSummary | undefined;
  loading: boolean;
  onRecords: OnRecords;
}) {
  const slices = data?.categories.slices ?? [];
  const other = data?.categories.otherMembers ?? [];
  const chart: DonutSlice[] = slices.map((slice) => ({ name: slice.label, value: slice.spend }));
  return (
    <SectionCard
      icon={<ChartPie />}
      title="Spend by service category"
      description={
        other.length > 0
          ? `Top five types; “All other types” folds ${other.map((s) => s.label).join(', ')}`
          : 'Every service type with spend in the period'
      }
      padding="sm"
    >
      <div className="flex flex-col items-center gap-6 sm:flex-row">
        {/* The chart's own legend is hidden: the one beside it carries the same rows as links. */}
        <div className="w-full shrink-0 sm:w-56 [&_ul[aria-label=Legend]]:hidden">
          <DonutChart
            bare
            ariaLabel="Spend by service category"
            data={chart}
            width={200}
            height={220}
            centerValue={data ? formatMoney(data.categories.total, { compact: true }) : undefined}
            centerLabel="Total spend"
            valueFormatter={(value) => formatMoney(value, { compact: true })}
            tableView={false}
            loading={loading}
            empty={!loading && slices.length === 0}
          />
        </div>
        {slices.length > 0 ? (
          <ul
            aria-label="Service categories"
            className="flex w-full min-w-0 flex-1 flex-col text-sm"
          >
            {slices.map((slice, index) => (
              <li
                key={slice.type + slice.label}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto_3.5rem] items-center gap-x-3 border-b border-line-soft py-2 last:border-b-0"
              >
                <span aria-hidden className={cn('size-2.5 rounded-full', seriesKeyClass(index))} />
                <button
                  type="button"
                  className="min-w-0 truncate text-left text-ink hover:text-primary-text hover:underline"
                  onClick={() => onRecords(slice.label, slice.recordIds)}
                  title={
                    slice.label.startsWith('All other') && other.length > 0
                      ? other.map((s) => `${s.label} ${formatMoney(s.spend)}`).join(' · ')
                      : undefined
                  }
                >
                  {slice.label}
                </button>
                <span className="tabular text-right font-medium text-ink">
                  {formatMoney(slice.spend)}
                </span>
                <span className="tabular text-right text-muted">{slice.sharePct.toFixed(1)}%</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------------------------
// Service insights
// ---------------------------------------------------------------------------------------------

/** Units whose walk-around video rated a component Replace soon or Replace now. */
function ConditionCandidates() {
  const query = useQuery({
    queryKey: ['pti', 'condition-candidates'],
    queryFn: () => conditionCandidates(),
  });
  const data = query.data;
  return (
    <SectionCard
      icon={<ClipboardList />}
      tone="warning"
      title="Condition candidates"
      description="From reviewed walk-around videos."
      actions={
        data ? (
          <Badge tone="neutral">
            {formatNumber(data.units)} candidate{data.units === 1 ? '' : 's'}
          </Badge>
        ) : undefined
      }
      padding="sm"
    >
      {!data ? (
        <div className="h-8 animate-pulse rounded bg-surface-muted" />
      ) : data.units === 0 ? (
        <p className="text-sm text-muted">
          No components are currently rated Replace soon or Replace now.
        </p>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <span className="flex items-baseline gap-2">
            <span className="tabular text-2xl font-semibold text-ink">{data.units}</span>
            <span className="text-xs text-secondary">units</span>
          </span>
          <span className="flex items-baseline gap-2">
            <span className="tabular text-lg font-semibold text-danger-text">
              {data.replaceNow}
            </span>
            <span className="text-xs text-secondary">Replace now</span>
          </span>
          <span className="flex items-baseline gap-2">
            <span className="tabular text-lg font-semibold text-warning-text">
              {data.replaceSoon}
            </span>
            <span className="text-xs text-secondary">Replace soon</span>
          </span>
          <Link to="/fleet/pti" className="ml-auto text-sm text-primary-text hover:underline">
            Open the PTI board
          </Link>
        </div>
      )}
    </SectionCard>
  );
}

const SERVICE_GRID =
  'grid grid-cols-[minmax(0,1fr)_6rem_6.5rem] items-center gap-3 sm:grid-cols-[13rem_minmax(0,1fr)_6rem_6.5rem_4.5rem]';

function ServiceTypes({
  data,
  loading,
  showAll,
  onToggle,
  onRecords,
}: {
  data: FleetExpenseSummary | undefined;
  loading: boolean;
  showAll: boolean;
  onToggle: () => void;
  onRecords: OnRecords;
}) {
  const rows = data?.serviceTypes.rows ?? [];
  const shown = showAll ? rows : rows.slice(0, TOP_SERVICE_TYPES);
  const max = rows[0]?.events ?? 0;
  const threshold = data?.serviceTypes.widespreadThreshold ?? 0;
  return (
    <SectionCard
      icon={<BarChart3 />}
      title="Most frequent service types"
      description="Service events in the selected period."
      actions={
        rows.length > TOP_SERVICE_TYPES ? (
          <Button variant="link" size="sm" iconRight={<ArrowRight />} onClick={onToggle}>
            {showAll ? `Show top ${TOP_SERVICE_TYPES}` : `Show all ${rows.length}`}
          </Button>
        ) : undefined
      }
      padding="none"
      footer={
        <span className="flex items-center gap-2">
          <Info aria-hidden className="size-3.5 shrink-0" />
          Rankings reflect service events, not failed parts. Work orders carry a service type, not a
          part identity.
        </span>
      }
    >
      {loading ? (
        <div className="m-4 h-24 animate-pulse rounded bg-surface-muted" />
      ) : rows.length === 0 ? (
        <EmptyState
          size="sm"
          title="No service events"
          description="Nothing completed in this period."
        />
      ) : (
        <>
          <div
            aria-hidden
            className={cn(
              SERVICE_GRID,
              'border-b border-line-soft bg-surface-muted px-5 py-2 text-2xs font-medium tracking-eyebrow text-muted uppercase',
            )}
          >
            <span>Service type</span>
            <span className="hidden sm:block">Frequency</span>
            <span className="text-right">Events</span>
            <span className="text-right">Spend</span>
            <span className="hidden text-right sm:block">Units</span>
          </div>
          <ol
            className="flex flex-col divide-y divide-line-soft px-5"
            aria-label="Most frequent service types"
          >
            {shown.map((row) => (
              // Fixed columns, so every bar starts on the same line and the figures stack in one column.
              <li key={row.type} className={cn(SERVICE_GRID, 'py-2.5 text-sm')}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium text-ink">{row.label}</span>
                  {row.widespread ? (
                    <Badge
                      tone="warning"
                      variant="outline"
                      size="sm"
                      title={`On ${row.truckCount} units; ${threshold} or more is a review signal, not proof of a defective part`}
                    >
                      widespread
                    </Badge>
                  ) : null}
                </span>
                <span
                  className="col-span-3 h-2 overflow-hidden rounded-full bg-surface-muted sm:col-span-1"
                  aria-hidden
                >
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${max > 0 ? Math.max(4, (row.events / max) * 100) : 0}%` }}
                  />
                </span>
                <button
                  type="button"
                  className="tabular text-right text-xs font-medium whitespace-nowrap text-primary-text hover:underline"
                  onClick={() => onRecords(row.label, row.recordIds)}
                >
                  {formatNumber(row.events)} event{row.events === 1 ? '' : 's'}
                </button>
                <span className="tabular text-right text-xs whitespace-nowrap text-ink">
                  {formatMoney(row.spend)}
                </span>
                <span className="tabular hidden text-right text-xs whitespace-nowrap text-secondary sm:inline">
                  {row.truckCount} unit{row.truckCount === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------------------------
// Vehicles and issues
// ---------------------------------------------------------------------------------------------

type VehicleRow = FleetExpenseSummary['vehicles']['rows'][number];
const col = createColumns<VehicleRow>();

function Trend({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted">—</span>;
  const Icon = value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        'tabular inline-flex items-center gap-0.5 font-medium',
        value > 0 ? 'text-danger-text' : value < 0 ? 'text-success-text' : 'text-muted',
      )}
    >
      <Icon className="size-3" aria-hidden />
      {value > 0 ? '+' : ''}
      {value.toFixed(1)}%
    </span>
  );
}

const ALL_STATUSES = 'all';

function VehiclesTable({
  data,
  loading,
  onRecords,
}: {
  data: FleetExpenseSummary | undefined;
  loading: boolean;
  onRecords: OnRecords;
}) {
  const rows = useMemo(() => data?.vehicles.rows ?? [], [data]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState(ALL_STATUSES);
  const [tableState, onTableStateChange] = useDataTableState({
    pagination: { page: 1, pageSize: VEHICLES_PAGE_SIZE },
  });

  const statusOptions = useMemo(
    () => [
      { value: ALL_STATUSES, label: 'All statuses' },
      ...[...new Set(rows.map((row) => row.status))]
        .sort()
        .map((code) => ({ value: code, label: getStatus(code).label })),
    ],
    [rows],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (status !== ALL_STATUSES && row.status !== status) return false;
      if (!needle) return true;
      return [row.unitNumber, row.description, row.topTypeLabel ?? '', row.kind]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [rows, query, status]);

  const columns = useMemo(
    () =>
      col.columns([
        col.display({
          id: 'unit',
          header: 'Unit',
          meta: { primary: true, width: 90 },
          cell: ({ row }) => (
            <Link
              to="/fleet/trucks/$truckId"
              params={{ truckId: row.original.truckId }}
              className="font-medium text-primary-text hover:underline"
            >
              {row.original.unitNumber}
            </Link>
          ),
        }),
        col.accessor('description', {
          header: 'Vehicle',
          meta: { width: 220 },
          cell: ({ row }) => (
            <span>
              {/* The kind stays in every mode: rows are found by "unit + kind" in the e2e specs. */}
              <span className="mr-1.5 text-xs font-medium tracking-wide text-muted uppercase">
                {row.original.kind === 'trailer' ? 'Trailer' : 'Truck'}
              </span>
              {row.original.description}
            </span>
          ),
        }),
        col.display({
          id: 'top',
          header: 'Top service',
          cell: ({ row }) =>
            row.original.topTypeLabel ? (
              <span>
                {row.original.topTypeLabel}
                <span className="ml-1 text-xs text-muted">×{row.original.topTypeEvents}</span>
              </span>
            ) : (
              <span className="text-muted">—</span>
            ),
        }),
        col.accessor('events', {
          header: 'Events',
          meta: { align: 'right', width: 90 },
          cell: ({ row }) =>
            row.original.events > 0 ? (
              <button
                type="button"
                className="tabular font-medium text-primary-text hover:underline"
                onClick={() => onRecords(`Unit ${row.original.unitNumber}`, row.original.recordIds)}
              >
                {formatNumber(row.original.events)}
              </button>
            ) : (
              <span className="text-muted">0</span>
            ),
        }),
        col.accessor('spend', {
          header: 'Spend',
          meta: { align: 'right', width: 120 },
          cell: ({ getValue }) => formatMoney(getValue()),
        }),
        col.accessor('trendPct', {
          header: 'Trend',
          meta: { align: 'right', width: 110 },
          cell: ({ getValue }) => <Trend value={getValue()} />,
        }),
        col.accessor('status', {
          header: 'Status',
          meta: { width: 120 },
          cell: ({ getValue }) => <StatusBadge status={getValue() as never} size="sm" />,
        }),
        col.accessor('flags', {
          header: 'Flags',
          meta: { align: 'right', width: 70 },
          cell: ({ getValue }) =>
            getValue() > 0 ? (
              <Badge tone="warning" size="sm" className="min-w-6 justify-center tabular">
                {getValue()}
              </Badge>
            ) : (
              <Badge tone="neutral" size="sm" className="min-w-6 justify-center tabular">
                0
              </Badge>
            ),
        }),
      ]),
    [onRecords],
  );

  return (
    <SectionCard
      icon={<Truck />}
      title="Vehicles"
      description={
        data
          ? `${formatNumber(rows.length)} unit${rows.length === 1 ? '' : 's'} · ${formatNumber(data.vehicles.flagged)} flagged · trend against ${data.meta.period.comparison.label}`
          : 'Spend per unit'
      }
      padding="none"
    >
      <DataTable
        columns={columns}
        data={filtered}
        rowKey={(row) => row.truckId}
        state={tableState}
        onStateChange={onTableStateChange}
        pageSizes={[VEHICLES_PAGE_SIZE, 25, 50]}
        loading={loading}
        dense
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="search"
              size="sm"
              aria-label="Search vehicles"
              placeholder="Search units, vehicles, or services..."
              prefix={<Search />}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                onTableStateChange({
                  pagination: { page: 1, pageSize: tableState.pagination.pageSize },
                });
              }}
              className="w-64"
            />
            <Select
              aria-label="Status"
              size="sm"
              options={statusOptions}
              value={status}
              onValueChange={(value) => {
                setStatus(value);
                onTableStateChange({
                  pagination: { page: 1, pageSize: tableState.pagination.pageSize },
                });
              }}
              className="min-w-36"
            />
          </div>
        }
        emptyTitle={rows.length > 0 ? 'No units match' : 'No units in scope'}
        emptyDescription={
          rows.length > 0
            ? 'Clear the search or the status filter to see every unit.'
            : 'Nothing on the roster matches the selection.'
        }
        aria-label="Vehicles"
      />
    </SectionCard>
  );
}

function IssueItem({
  finding,
  onRecords,
  onReview,
}: {
  finding: FleetAnomaly;
  onRecords: (finding: FleetAnomaly) => void;
  onReview: () => void;
}) {
  const navigate = useNavigate();
  const severity = SEVERITY[finding.severity];
  const Icon = severity.icon;
  // A finding about the present points at the unit; one about the period points at its records.
  const hasSpendRecords = !finding.current && finding.recordIds.length > 0;
  const iconTone =
    finding.severity === 'critical'
      ? 'text-danger-text'
      : finding.severity === 'warning'
        ? 'text-warning-text'
        : 'text-muted';
  return (
    <li className="flex gap-3 py-3">
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', iconTone)} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/fleet/trucks/$truckId"
            params={{ truckId: finding.truckId }}
            className="text-sm font-semibold text-ink hover:underline"
          >
            Unit {finding.unitNumber}
          </Link>
          <Badge tone={severity.tone} size="sm">
            {severity.label}
          </Badge>
          {finding.current ? (
            <Badge tone="neutral" variant="outline" size="sm">
              Now
            </Badge>
          ) : null}
        </div>
        <p className="text-sm font-medium text-ink">{finding.title}</p>
        <p className="text-xs text-secondary">{finding.detail}</p>
        {hasSpendRecords ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 self-start text-xs font-medium text-primary-text hover:underline"
            onClick={() => onRecords(finding)}
          >
            View {finding.recordIds.length} record{finding.recordIds.length === 1 ? '' : 's'}
            <ArrowRight aria-hidden className="size-3" />
          </button>
        ) : null}
      </div>
      <DropdownMenu
        trigger={
          <IconButton variant="ghost" size="sm" label={`Actions for unit ${finding.unitNumber}`}>
            <MoreHorizontal />
          </IconButton>
        }
      >
        <MenuItem
          onSelect={() =>
            void navigate({ to: '/fleet/trucks/$truckId', params: { truckId: finding.truckId } })
          }
        >
          Open unit {finding.unitNumber}
        </MenuItem>
        {hasSpendRecords ? (
          <MenuItem onSelect={() => onRecords(finding)}>View the records</MenuItem>
        ) : null}
        <MenuItem onSelect={onReview}>Review all issues</MenuItem>
      </DropdownMenu>
    </li>
  );
}

function IssuesPanel({
  data,
  loading,
  onReview,
  onRecords,
}: {
  data: FleetExpenseSummary | undefined;
  loading: boolean;
  onReview: () => void;
  onRecords: (finding: FleetAnomaly) => void;
}) {
  const [severity, setSeverity] = useState<Severity | null>(null);
  const findings = data?.anomalies.findings ?? [];
  const counts = data?.anomalies.counts;
  const unavailable = (data?.anomalies.checks ?? []).filter((c) => c.status === 'unavailable');
  const ran = (data?.anomalies.checks ?? []).filter((c) => c.status === 'ran');
  const visible = severity ? findings.filter((f) => f.severity === severity) : findings;
  const shown = visible.slice(0, TOP_FINDINGS);
  const more = visible.length - shown.length;

  const tiles: Array<{ severity: Severity; count: number }> = [
    { severity: 'critical', count: counts?.critical ?? 0 },
    { severity: 'warning', count: counts?.warning ?? 0 },
    { severity: 'info', count: counts?.info ?? 0 },
  ];

  return (
    <SectionCard
      icon={<ShieldAlert />}
      tone="danger"
      title="Issues to review"
      description={
        counts
          ? `${formatNumber(findings.length)} finding${findings.length === 1 ? '' : 's'} from ${ran.length} check${ran.length === 1 ? '' : 's'} that ran`
          : 'Explainable findings with their thresholds'
      }
      actions={
        data ? (
          <Button variant="secondary" size="sm" onClick={onReview}>
            Review all
          </Button>
        ) : undefined
      }
      padding="sm"
      footer={
        unavailable.length > 0 ? (
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <Info aria-hidden className="size-3.5 shrink-0" />
              <span>Did not run: {unavailable.map((c) => c.label.toLowerCase()).join('; ')}.</span>
            </span>
            <Button variant="link" size="sm" onClick={onReview}>
              Details
            </Button>
          </span>
        ) : undefined
      }
    >
      {loading ? (
        <div className="h-24 animate-pulse rounded bg-surface-muted" />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-2">
            {tiles.map((tile) => (
              <StatTile
                key={tile.severity}
                label={SEVERITY[tile.severity].label}
                value={formatNumber(tile.count)}
                tone={SEVERITY[tile.severity].tone}
                valueTone={tile.severity !== 'info'}
                pressed={severity === tile.severity}
                onClick={() => setSeverity((v) => (v === tile.severity ? null : tile.severity))}
                className={cn(
                  'px-3 py-2',
                  tile.severity === 'critical' && 'bg-danger-soft',
                  tile.severity === 'warning' && 'bg-warning-soft',
                  tile.severity === 'info' && 'bg-surface-muted',
                )}
              />
            ))}
          </div>
          {visible.length === 0 ? (
            <EmptyState
              size="sm"
              title={
                severity
                  ? `No ${SEVERITY[severity].label.toLowerCase()} findings`
                  : 'Nothing unusual in this period'
              }
              description={`From the ${ran.length} checks that ran${unavailable.length > 0 ? `; ${unavailable.length} could not run` : ''}.`}
            />
          ) : (
            <ul className="flex flex-col divide-y divide-line-soft">
              {shown.map((finding) => (
                <IssueItem
                  key={finding.key}
                  finding={finding}
                  onRecords={onRecords}
                  onReview={onReview}
                />
              ))}
            </ul>
          )}
          {more > 0 ? (
            <Button
              variant="link"
              size="sm"
              iconRight={<ArrowRight />}
              className="self-start"
              onClick={onReview}
            >
              View {more} more issue{more === 1 ? '' : 's'}
            </Button>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------------------------
// Basis
// ---------------------------------------------------------------------------------------------

function Coverage({ data }: { data: FleetExpenseSummary }) {
  const { coverage, meta } = data;
  const excluded = coverage.excluded;
  return (
    <SectionCard
      icon={<Info />}
      tone="neutral"
      title="What was counted"
      padding="sm"
      className="bg-surface-muted"
    >
      <div className="flex flex-col gap-1 text-xs text-secondary">
        <span>{meta.source.basis}.</span>
        <span>{meta.source.scope}.</span>
        <span>
          {meta.fleet.trucks} truck{meta.fleet.trucks === 1 ? '' : 's'}, {meta.fleet.trailers}{' '}
          trailer{meta.fleet.trailers === 1 ? '' : 's'} in scope · {meta.period.label}, compared
          with {meta.period.comparison.label} · completed work orders counted by completion date,
          standalone service records by service date
          {meta.source.provenance === 'demo'
            ? ' · the workspace includes generated demo records'
            : ''}
          .
        </span>
        <span>
          Left out across the workspace: {excluded.notCompleted} open, {excluded.draftOrCancelled}{' '}
          draft or cancelled, {excluded.missingCompletionDate} without a completion date,{' '}
          {excluded.unknownAmount} without an amount, {excluded.unattributedTruck} on units not on
          this roster, {excluded.linkedServiceRecords} service records already counted through their
          work order.
          {coverage.zeroAmountEvents > 0
            ? ` ${coverage.zeroAmountEvents} counted record${coverage.zeroAmountEvents === 1 ? '' : 's'} carry an amount of exactly $0.00.`
            : ''}
        </span>
        {excluded.invoiceMismatch > 0 ? (
          <span>
            {excluded.invoiceMismatch} work order{excluded.invoiceMismatch === 1 ? '' : 's'} carry
            an invoice amount that disagrees with the order total; the order total was used.{' '}
            <Link
              to="/fleet/maintenance"
              search={{ ids: coverage.invoiceMismatchIds.join(',') } as never}
              className="font-medium text-primary-text hover:underline"
            >
              Open them
            </Link>
            .
          </span>
        ) : null}
        <span className="text-muted">
          As of {formatIsoDate(meta.asOf.slice(0, 10))}
          {meta.source.snapshotUpdatedAt
            ? ` · workspace saved ${formatIsoDate(meta.source.snapshotUpdatedAt.slice(0, 10))}`
            : ' · no workspace snapshot saved yet'}
          {` · ${Object.keys(MAINTENANCE_TYPE_LABEL).length} service types in the vocabulary`}
        </span>
      </div>
    </SectionCard>
  );
}

// Shown in the table twin of the vendors chart and nowhere else; kept for symmetry with the API row.
export type { FleetVendorRow };
