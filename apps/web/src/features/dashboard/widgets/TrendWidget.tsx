import {
  OPS_NET_PAY_TYPES,
  type DashboardTrends,
  type MoneyMetric,
  type OpsNetPayType,
  type TrendSummary,
  type TrendWeek,
} from '@neway/shared';
import {
  ArrowDownRight,
  ArrowUpRight,
  DollarSign,
  Gauge,
  Minus,
  Percent,
  Receipt,
  TrendingUp,
  TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';
import {
  BarChart,
  Card,
  ChartLegend,
  ChartTooltip,
  KpiCard,
  KpiSkeleton,
  Skeleton,
  cn,
  type RechartsTooltipContentProps,
} from '@/design-system';
import { LOCALE, formatMoney, formatPercent } from '@/lib/format';
import {
  DASH,
  MASK,
  formatValue,
  metricDelta,
  metricText,
  metricTitle,
  reasonLabel,
  reasonsText,
  type MetricKind,
} from '../metric';
import { Value } from './Value';
import type { Visibility } from '../visibility';

export interface TrendWidgetProps {
  trends: DashboardTrends;
  visibility: Visibility;
}

const CHART_HEIGHT = 240;

/** Fixed categorical order: gross, cost, net profit. Never re-ordered or cycled. */
const SERIES = {
  gross: 'var(--chart-series-1)',
  cost: 'var(--chart-series-2)',
  profit: 'var(--chart-series-3)',
} as const;

/** The plot's three series, in the same fixed order, for the legend beside the chart title. */
const SERIES_ITEMS = [
  { label: 'Gross', color: SERIES.gross },
  { label: 'Cost', color: SERIES.cost },
  { label: 'Net profit', color: SERIES.profit },
] as const;

/** The `summary` fields a card or a table row may compare against (its metric fields only). */
type SummaryKey =
  'gross' | 'cost' | 'profit' | 'rpm' | 'cpm' | 'ppm' | 'marginPct' | 'totalMiles' | 'activeTrucks';

/** "vs. previous 8 weeks" — the real length of the comparison window, never a hardcoded 8. */
function comparisonLabel(weeks: number): string {
  return weeks === 1 ? 'vs. previous week' : `vs. previous ${weeks} weeks`;
}

/**
 * The value a bar may draw, using the *same* gate the table applies: a week without expense
 * coverage has no cost or profit, so those bars are absent rather than drawn at zero. This is what
 * keeps the chart and the table reconciled — both read this one function.
 */
function chartValue(week: TrendWeek, key: 'gross' | 'cost' | 'profit'): number | null {
  if (key === 'gross') return week.gross;
  if (!week.hasExpenseData) return null;
  return key === 'cost' ? week.cost : week.profit;
}

/** `2026-07-13` + `2026-08-31` → `Jul 13 – Aug 31, 2026`; the window the section actually covers. */
function windowLabel(weeks: readonly TrendWeek[]): string | undefined {
  const first = weeks[0];
  const last = weeks[weeks.length - 1];
  if (!first || !last) return undefined;
  const start = new Date(`${first.weekStart}T00:00:00Z`);
  const end = new Date(`${last.weekEnd}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return undefined;
  return `${shortDateFormatter.format(start)} – ${longDateFormatter.format(end)}`;
}

/**
 * `weekStart` is a calendar date (`2026-08-31`), not an instant: it is read and printed as UTC so
 * it never shifts a day in a western timezone.
 */
const shortDateFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
});

/** Same as `shortDateFormatter` with the year, for the closing end of the window label. */
const longDateFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** `2026-08-31` → `Aug 31`; falls back to the API label if the date is unparsable. */
function shortLabel(week: TrendWeek): string {
  const date = new Date(`${week.weekStart}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? week.label : shortDateFormatter.format(date);
}

/** The API range label, marked when the week is still running. */
function fullLabel(week: TrendWeek): string {
  return week.isComplete ? week.label : `${week.label} (partial)`;
}

/** "Selected" / "Partial" — the emphasis a colored column carries, in words. */
function weekMarkers(week: TrendWeek): string[] {
  const markers: string[] = [];
  if (week.highlighted) markers.push('Selected');
  if (!week.isComplete) markers.push('Partial');
  return markers;
}

interface HeadlineCard {
  key: SummaryKey;
  label: string;
  kind: MetricKind;
  /** Leading tinted tile; a 16px Lucide mark so the strip scans by shape as well as by label. */
  icon: ReactNode;
  /** False when a rise is bad, so a climbing cost reads red rather than green. */
  positiveIsGood?: boolean;
}

/** The five figures the owner's reference leads the section with, in reading order. */
const HEADLINE_CARDS: readonly HeadlineCard[] = [
  { key: 'gross', label: 'Total gross', kind: 'moneyWhole', icon: <DollarSign /> },
  {
    key: 'cost',
    label: 'Total cost',
    kind: 'moneyWhole',
    icon: <Receipt />,
    positiveIsGood: false,
  },
  { key: 'profit', label: 'Net profit', kind: 'moneyWhole', icon: <TrendingUp /> },
  { key: 'rpm', label: 'RPM', kind: 'rate', icon: <Gauge /> },
  { key: 'marginPct', label: 'Profit margin', kind: 'percent', icon: <Percent /> },
];

/**
 * The whole window rolled up against the one before it. Every figure — value and delta alike —
 * is read straight off `summary`; nothing here adds a week to another week.
 */
function HeadlineStrip({ summary, masked }: { summary: TrendSummary; masked: boolean }) {
  const label = comparisonLabel(summary.previousWindow.weeks);
  const coverage = summary.expenseCoverage;
  const uncovered = coverage.weeks - coverage.weeksWithData;
  return (
    <div className="px-(--card-padding) pt-1 pb-3">
      <div
        data-testid="trend-headline"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
      >
        {HEADLINE_CARDS.map((card) => {
          const metric = summary[card.key];
          // Both gates matter: the response may be masked wholesale, or one metric may be.
          const hidden = masked || metric.masked;
          const value = hidden ? MASK : metricText(metric, card.kind);
          const delta = hidden
            ? undefined
            : metricDelta(metric, card.positiveIsGood ?? true, label);
          const unavailable = value === DASH || value === MASK;
          return (
            <KpiCard
              key={card.key}
              label={card.label}
              value={value}
              delta={delta}
              icon={card.icon}
              iconTile
              hint={
                delta ? undefined : hidden ? (
                  reasonLabel('masked')
                ) : unavailable ? (
                  reasonLabel(metric.reasons[0] ?? 'unavailable')
                ) : (
                  <>
                    {label}: {DASH}
                  </>
                )
              }
              title={hidden ? reasonLabel('masked') : metricTitle(metric)}
              className={cn(unavailable && 'text-faint')}
              data-metric-state={hidden ? 'masked' : metric.value === null ? 'null' : 'value'}
            />
          );
        })}
      </div>
      {uncovered > 0 && !masked ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-warning-text">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Cost and profit cover {coverage.weeksWithData} of {coverage.weeks} weeks{' — '}
            {uncovered === 1 ? 'one week has' : `${uncovered} weeks have`} no expense data, so the
            window margin reads higher than any single week.
          </span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * A row's window-over-window change: an arrow, the signed percent the API computed, and a tone
 * that reads good/bad rather than merely up/down. "—" whenever there is nothing to compare —
 * a row `summary` does not carry, a metric with no previous value, or a masked one.
 */
function DeltaCell({
  metric,
  positiveIsGood,
  masked,
}: {
  metric: MoneyMetric | null;
  positiveIsGood: boolean;
  masked: boolean;
}) {
  if (masked) return <span className="text-faint">{MASK}</span>;
  const deltaPct = metric && !metric.masked ? metric.deltaPct : null;
  if (deltaPct === null) {
    return (
      <span
        className="text-faint"
        title={
          metric ? (reasonsText(metric.reasons) ?? reasonLabel('no_previous_value')) : undefined
        }
      >
        {DASH}
      </span>
    );
  }
  const direction = deltaPct > 0 ? 'up' : deltaPct < 0 ? 'down' : 'flat';
  const DirectionIcon =
    direction === 'up' ? ArrowUpRight : direction === 'down' ? ArrowDownRight : Minus;
  const tone =
    direction === 'flat'
      ? 'text-muted'
      : (direction === 'up') === positiveIsGood
        ? 'text-success-text'
        : 'text-danger-text';
  return (
    <span className={cn('inline-flex items-center justify-center gap-0.5 font-medium', tone)}>
      <DirectionIcon className="size-3 shrink-0" aria-hidden />
      <span className="sr-only">
        {direction === 'up' ? 'Up ' : direction === 'down' ? 'Down ' : 'Unchanged '}
      </span>
      {formatPercent(deltaPct)}
    </span>
  );
}

interface MetricRow {
  type: 'metric';
  key: string;
  label: string;
  kind: MetricKind;
  /** Reads the metric off a week. Expense-derived metrics stay null without expense coverage. */
  value: (week: TrendWeek) => number | null;
  /** Money and unit economics are hidden by financial masking; head counts and miles are not. */
  financial: boolean;
  /** True when a null means "this week has no expense data" (the reason shown on hover). */
  needsExpenses: boolean;
  /** The `summary` metric the trailing delta column compares; rows without one show "—". */
  summaryKey?: SummaryKey;
  /** False when a rise is bad (cost, CPM, per-truck cost). Default true. */
  positiveIsGood?: boolean;
}

/** A hairline + uppercase caption that breaks the 15+ metric rows into readable blocks. */
interface GroupRow {
  type: 'group';
  key: string;
  label: string;
}

type TableRow = MetricRow | GroupRow;

/** Money, unit economics and margin — every financial row of the operating picture. */
const FINANCE_ROWS: readonly MetricRow[] = [
  {
    type: 'metric',
    key: 'gross',
    label: 'Total gross',
    kind: 'moneyCompact',
    value: (w) => w.gross,
    financial: true,
    needsExpenses: false,
    summaryKey: 'gross',
  },
  {
    type: 'metric',
    key: 'cost',
    label: 'Cost',
    kind: 'moneyCompact',
    value: (w) => (w.hasExpenseData ? w.cost : null),
    financial: true,
    needsExpenses: true,
    summaryKey: 'cost',
    positiveIsGood: false,
  },
  {
    type: 'metric',
    key: 'profit',
    label: 'Net profit',
    kind: 'moneyCompact',
    value: (w) => (w.hasExpenseData ? w.profit : null),
    financial: true,
    needsExpenses: true,
    summaryKey: 'profit',
  },
  {
    type: 'metric',
    key: 'rpm',
    label: 'RPM',
    kind: 'rate',
    value: (w) => w.rpm,
    financial: true,
    needsExpenses: false,
    summaryKey: 'rpm',
  },
  {
    type: 'metric',
    key: 'cpm',
    label: 'CPM',
    kind: 'rate',
    value: (w) => (w.hasExpenseData ? w.cpm : null),
    financial: true,
    needsExpenses: true,
    summaryKey: 'cpm',
    positiveIsGood: false,
  },
  {
    type: 'metric',
    key: 'ppm',
    label: 'PPM',
    kind: 'rate',
    value: (w) => (w.hasExpenseData ? w.ppm : null),
    financial: true,
    needsExpenses: true,
    summaryKey: 'ppm',
  },
  {
    type: 'metric',
    key: 'margin',
    label: 'Profit margin',
    kind: 'percent',
    value: (w) => (w.hasExpenseData ? w.marginPct : null),
    financial: true,
    needsExpenses: true,
    summaryKey: 'marginPct',
  },
];

/** Head counts and miles: never gated on expense coverage, never hidden by financial masking. */
const FLEET_ROWS: readonly MetricRow[] = [
  {
    type: 'metric',
    key: 'activeTrucks',
    label: 'Total active',
    kind: 'number',
    value: (w) => w.activeTrucks,
    financial: false,
    needsExpenses: false,
    summaryKey: 'activeTrucks',
  },
  {
    type: 'metric',
    key: 'inactiveTrucks',
    label: 'Total inactive',
    kind: 'number',
    value: (w) => w.inactiveTrucks,
    financial: false,
    needsExpenses: false,
  },
  {
    type: 'metric',
    key: 'totalMiles',
    label: 'Total miles',
    kind: 'miles',
    value: (w) => w.totalMiles,
    financial: false,
    needsExpenses: false,
    summaryKey: 'totalMiles',
  },
];

/** Per-truck averages. The money ones are financial; the cost-derived ones need expenses. */
const PER_TRUCK_ROWS: readonly MetricRow[] = [
  {
    type: 'metric',
    key: 'avgGrossPerTruck',
    label: 'Avg gross / truck',
    kind: 'moneyCompact',
    value: (w) => w.avgGrossPerTruck,
    financial: true,
    needsExpenses: false,
  },
  {
    type: 'metric',
    key: 'avgCostPerTruck',
    label: 'Avg cost / truck',
    kind: 'moneyCompact',
    value: (w) => (w.hasExpenseData ? w.avgCostPerTruck : null),
    financial: true,
    needsExpenses: true,
    positiveIsGood: false,
  },
  {
    type: 'metric',
    key: 'avgProfitPerTruck',
    label: 'Avg profit / truck',
    kind: 'moneyCompact',
    value: (w) => (w.hasExpenseData ? w.avgProfitPerTruck : null),
    financial: true,
    needsExpenses: true,
  },
  {
    type: 'metric',
    key: 'avgMilesPerTruck',
    label: 'Avg miles / truck',
    kind: 'miles',
    value: (w) => w.avgMilesPerTruck,
    financial: false,
    needsExpenses: false,
  },
];

const PAY_TYPE_LABELS: Record<OpsNetPayType, string> = {
  company: 'Active company drivers',
  owner_operator: 'Active owner operators',
  lease_owner: 'Active lease owners',
  percentage: 'Active percentage',
  unknown: 'Active unknown',
};

/** One pay type's active count for a week; `null` when the week carries no attribution at all. */
function payTypeCount(week: TrendWeek, payType: OpsNetPayType): number | null {
  const counts = week.activeByPayType;
  if (!counts) return null;
  return counts[payType] ?? null;
}

/**
 * One row per pay type the window actually staffs. The whole block disappears when no week has
 * driver attribution, and a pay type nobody ran in any week is dropped rather than shown as zeros.
 */
function payTypeRows(weeks: readonly TrendWeek[]): MetricRow[] {
  if (weeks.every((week) => week.activeByPayType === null)) return [];
  return OPS_NET_PAY_TYPES.filter((payType) =>
    weeks.some((week) => (payTypeCount(week, payType) ?? 0) > 0),
  ).map((payType) => ({
    type: 'metric',
    key: `payType-${payType}`,
    label: PAY_TYPE_LABELS[payType],
    kind: 'number',
    value: (week) => payTypeCount(week, payType),
    financial: false,
    needsExpenses: false,
  }));
}

/** Finance rows, then the fleet block, then the per-truck averages — each block captioned. */
function tableRows(weeks: readonly TrendWeek[]): TableRow[] {
  return [
    ...FINANCE_ROWS,
    { type: 'group', key: 'group-fleet', label: 'Fleet' },
    ...payTypeRows(weeks),
    ...FLEET_ROWS,
    { type: 'group', key: 'group-per-truck', label: 'Per truck averages' },
    ...PER_TRUCK_ROWS,
  ];
}

/** Why a cell reads "—" or "••••••", when the payload lets us say. Named by week for context. */
function cellTitle(row: MetricRow, week: TrendWeek, masked: boolean): string | undefined {
  if (row.financial && masked) return `${fullLabel(week)}: ${reasonLabel('masked')}`;
  if (row.needsExpenses && !week.hasExpenseData) {
    return `${fullLabel(week)}: ${reasonLabel('no_expense_data')}`;
  }
  return undefined;
}

/**
 * Gross, cost and net profit for the hovered week plus the derived margin, with "—" for anything
 * the API could not compute. Reads the same gated values the table renders, so the two agree.
 */
function renderTrendTooltip(masked: boolean) {
  return function TrendTooltipContent({ active, payload }: RechartsTooltipContentProps) {
    if (!active || !payload || payload.length === 0) return null;
    const week = (payload[0]?.payload as { week?: TrendWeek } | undefined)?.week;
    if (!week) return null;
    return (
      <ChartTooltip
        label={fullLabel(week)}
        rows={[
          {
            name: 'Gross',
            value: formatValue(chartValue(week, 'gross'), 'moneyCompact', { masked }),
            color: SERIES.gross,
          },
          {
            name: 'Cost',
            value: formatValue(chartValue(week, 'cost'), 'moneyCompact', { masked }),
            color: SERIES.cost,
          },
          {
            name: 'Net profit',
            value: formatValue(chartValue(week, 'profit'), 'moneyCompact', { masked }),
            color: SERIES.profit,
          },
          {
            name: 'Profit margin',
            value: formatValue(week.hasExpenseData ? week.marginPct : null, 'percent', { masked }),
          },
        ]}
      />
    );
  };
}

/** 8-week gross bars over a dense metrics-by-week table. Every number comes from the API. */
export function TrendWidget({ trends, visibility }: TrendWidgetProps) {
  const masked = !visibility.financial || trends.masked;
  const weeks = trends.weeks;
  const missingExpenseWeeks = weeks.filter((w) => !w.hasExpenseData);
  const selected = weeks.filter((w) => w.highlighted);
  // One row per week carrying all three series plus the week itself, so the tooltip can read the
  // derived margin without a second lookup. Bars and table therefore share one source of numbers.
  const data = weeks.map((w) => ({
    short: shortLabel(w),
    gross: chartValue(w, 'gross'),
    cost: chartValue(w, 'cost'),
    profit: chartValue(w, 'profit'),
    week: w,
  }));
  const chartEmpty = masked || weeks.length === 0;
  const selectedText =
    selected.length > 0 ? selected.map((w) => w.label).join(', ') : 'none in this window';
  const rows = tableRows(weeks);
  const range = windowLabel(weeks);
  // The rollup the strip and the trailing delta column both read. Absent (no weeks, or an older
  // payload) means neither is drawn rather than either being invented here.
  const summary = trends.summary;
  const deltaLabel = summary ? comparisonLabel(summary.previousWindow.weeks) : '';
  const columns = weeks.length + (summary ? 1 : 0);

  return (
    <Card padding="none" className="min-w-0" data-testid="trend-widget">
      <header className="flex flex-wrap items-start justify-between gap-3 px-(--card-padding) pt-(--card-padding) pb-2">
        <div className="min-w-0">
          <h3 className="text-md font-bold text-ink">Weekly operating performance</h3>
          <p className="mt-0.5 text-xs text-muted">
            {weeks.length > 0 ? `Last ${weeks.length} weeks` : 'No weeks in this window'}
          </p>
        </div>
        {range ? (
          <span
            className="tabular rounded-md border border-line bg-surface-muted px-2.5 py-1 text-xs text-secondary"
            title="The reporting weeks this section covers"
          >
            {range}
          </span>
        ) : null}
      </header>

      {summary ? <HeadlineStrip summary={summary} masked={masked} /> : null}

      {/* `BarChart` brings its own ChartContainer (title, legend, empty state, aria), so it is used
          directly rather than nested inside a second one. The legend is moved out of the container's
          footer slot into the header's right side, so it sits on the title's line as in the
          reference; the plot itself is untouched. */}
      <BarChart
        bare
        className="px-(--card-padding)"
        title="Weekly gross, cost & net profit"
        legend={false}
        toolbar={
          <ChartLegend
            items={[...SERIES_ITEMS]}
            className="mt-1 justify-end gap-x-3 [&>li>span]:rounded-full"
          />
        }
        description="Grouped by week · hover a group for exact values and margin"
        ariaLabel={`Weekly gross, cost and net profit for the last ${weeks.length} reporting weeks. Selected week: ${selectedText}.`}
        height={CHART_HEIGHT}
        empty={chartEmpty}
        emptyState={
          <div className="flex h-full items-center justify-center text-sm text-muted">
            {masked
              ? `${MASK} Weekly performance is hidden by your financial visibility.`
              : 'No weeks in this window.'}
          </div>
        }
        data={data}
        xKey="short"
        xLabel="Week"
        series={[
          { key: 'gross', label: 'Gross', color: SERIES.gross },
          { key: 'cost', label: 'Cost', color: SERIES.cost },
          { key: 'profit', label: 'Net profit', color: SERIES.profit },
        ]}
        valueFormatter={(v) => formatMoney(v, { compact: true })}
        renderTooltip={renderTrendTooltip(masked)}
        // The table below is the fuller twin of this chart; a second one would just repeat it.
        tableView={false}
      />

      {weeks.length > 0 ? (
        <div className="border-t border-line-soft p-(--card-padding)">
          {/* The cage: one framed grid block. Rounding lives on the scroll wrapper so the
              header and the sticky first column clip cleanly at the corners. */}
          {/* `relative` makes this the containing block for the absolutely positioned sr-only
              spans inside the cells; without it they escape this scroll container and
              stretch the page itself once the table is wider than the viewport. */}
          <div className="scroll-quiet relative w-full overflow-x-auto rounded-lg border-2 border-line-strong">
            {/* `border-separate` (spacing 0) draws the same 2px grid as a collapsed table
                but keeps the borders of the sticky header and sticky first column painted. */}
            <table className="w-full border-separate border-spacing-0 text-sm">
              <caption className="sr-only">
                {`Weekly operating performance: metrics as rows, the last ${weeks.length} reporting weeks as columns${summary ? `, then the change for the whole window ${deltaLabel}` : ''}. Selected week: ${selectedText}.`}
              </caption>
              <thead>
                <tr className="bg-surface-muted">
                  <th
                    scope="col"
                    className="sticky top-0 left-0 z-30 border-r-2 border-b-2 border-r-line-strong border-b-line-strong bg-surface-muted px-4 py-2 text-left text-xs font-semibold whitespace-nowrap text-secondary"
                  >
                    Metric
                  </th>
                  {weeks.map((week) => {
                    const markers = weekMarkers(week);
                    return (
                      <th
                        key={week.weekStart}
                        scope="col"
                        title={fullLabel(week)}
                        className={cn(
                          'sticky top-0 z-20 border-r-2 border-b-2 border-r-line-strong border-b-line-strong bg-surface-muted px-4 py-2 text-center text-xs font-semibold whitespace-nowrap text-secondary last:border-r-0',
                          week.highlighted && 'bg-primary-soft text-primary-text',
                        )}
                      >
                        <span className="block">{shortLabel(week)}</span>
                        {markers.length > 0 ? (
                          <span className="block text-2xs font-normal">{markers.join(' · ')}</span>
                        ) : null}
                      </th>
                    );
                  })}
                  {summary ? (
                    <th
                      scope="col"
                      title={`Change over the whole window, ${deltaLabel}`}
                      className="sticky top-0 z-20 border-r-2 border-b-2 border-r-line-strong border-b-line-strong bg-surface-muted px-4 py-2 text-center text-xs font-semibold whitespace-nowrap text-secondary last:border-r-0"
                    >
                      <span aria-hidden>Δ vs prev.</span>
                      <span className="sr-only">Change {deltaLabel}</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="[&_tr:last-child_td]:border-b-0 [&_tr:last-child_th]:border-b-0">
                {rows.map((row) =>
                  row.type === 'group' ? (
                    <tr key={row.key} className="bg-surface-muted">
                      <th
                        scope="rowgroup"
                        className="eyebrow sticky left-0 z-10 border-r-2 border-b-2 border-line-strong bg-surface-muted px-4 py-1.5 text-left whitespace-nowrap"
                      >
                        {row.label}
                      </th>
                      <td
                        colSpan={columns}
                        className="border-b-2 border-line-strong bg-surface-muted"
                      />
                    </tr>
                  ) : (
                    <tr key={row.key} className="transition-colors hover:bg-surface-hover">
                      <th
                        scope="row"
                        className="sticky left-0 z-10 h-(--table-row-height-dense) border-r-2 border-b-2 border-line-strong bg-surface-muted px-4 text-left font-medium whitespace-nowrap text-ink"
                      >
                        {row.label}
                      </th>
                      {weeks.map((week) => (
                        <td
                          key={week.weekStart}
                          title={cellTitle(row, week, masked)}
                          className={cn(
                            'h-(--table-row-height-dense) border-r-2 border-b-2 border-line-strong px-4 text-center tabular whitespace-nowrap text-ink last:border-r-0',
                            week.highlighted && 'bg-primary-soft/40 text-primary-text',
                          )}
                        >
                          <Value
                            value={row.value(week)}
                            kind={row.kind}
                            masked={row.financial && masked}
                          />
                        </td>
                      ))}
                      {summary ? (
                        <td className="h-(--table-row-height-dense) border-r-2 border-b-2 border-line-strong px-4 text-center tabular whitespace-nowrap text-ink last:border-r-0">
                          <DeltaCell
                            metric={row.summaryKey ? summary[row.summaryKey] : null}
                            positiveIsGood={row.positiveIsGood ?? true}
                            masked={row.financial && masked}
                          />
                        </td>
                      ) : null}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {missingExpenseWeeks.length > 0 ? (
        <p className="border-t border-line-soft px-(--card-padding) py-2 text-xs text-muted">
          {DASH} No expense data available for{' '}
          {missingExpenseWeeks.length === 1 ? 'one week' : 'some weeks'} in this window; cost, net
          profit, CPM, PPM, margin and the per-truck cost and profit averages are not shown for
          them.
        </p>
      ) : null}
    </Card>
  );
}

/** Row count of the table without the (data-dependent) pay-type rows. */
const SKELETON_ROWS = FINANCE_ROWS.length + FLEET_ROWS.length + PER_TRUCK_ROWS.length;

export function TrendWidgetSkeleton() {
  return (
    <div className="flex flex-col rounded-lg border border-line bg-surface">
      <div className="px-(--card-padding) pt-3 pb-2">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="mt-1.5 h-3 w-80 max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-3 px-(--card-padding) pb-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {HEADLINE_CARDS.map((card) => (
          <KpiSkeleton key={card.key} />
        ))}
      </div>
      <div className="px-(--card-padding) pb-3">
        <Skeleton className="h-50 w-full" />
      </div>
      <div className="border-t border-line-soft px-(--card-padding) py-3">
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <Skeleton key={i} className="mb-2 h-4 w-full last:mb-0" />
        ))}
      </div>
    </div>
  );
}
