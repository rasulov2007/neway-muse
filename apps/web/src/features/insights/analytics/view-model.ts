import type { MetricComparison, MetricKey } from '@neway/shared';
import { formatMoney, formatNumber } from '@/lib/format';
import type { CostDriver, RankedEntity, TrendPoint } from '../useInsights';

/**
 * What the Analytics screens show, worked out from what the server sent.
 *
 * Nothing here computes a business figure. These are the display rules the page always had —
 * how a metric is written, which bar a missing cost leaves out — kept in one tested place so the
 * redesign cannot change a number while changing how it looks.
 */

/** Writes a metric value exactly as the page always has; `—` when there is none. */
export function formatMetric(unit: MetricComparison['unit'], value: number | null): string {
  if (value === null) return '—';
  switch (unit) {
    case 'money':
      return formatMoney(value);
    case 'money_per_mile':
      return formatMoney(value);
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'miles':
      return formatNumber(Math.round(value));
    default:
      return formatNumber(value);
  }
}

/** The four metrics that have a per-week value in the trend; no other metric gets a sparkline. */
const SPARKLINE_FIELD: Partial<Record<MetricKey, 'gross' | 'cost' | 'profit' | 'miles'>> = {
  gross: 'gross',
  cost: 'cost',
  profit: 'profit',
  miles: 'miles',
};

/**
 * The weekly values behind a sparkline, or `null` when there should be none: the metric has no
 * weekly figure, or fewer than two weeks carry a value. Weeks without a value stay `null` so the
 * line breaks there instead of dropping to zero.
 */
export function sparklineFor(key: MetricKey, trend: readonly TrendPoint[]): (number | null)[] | null {
  const field = SPARKLINE_FIELD[key];
  if (!field) return null;
  const values = trend.map((point) => point[field]);
  const known = values.filter((value) => value !== null).length;
  return known >= 2 ? values : null;
}

/** How a change reads to a screen reader and which way the pill points. */
export function deltaDirection(metric: MetricComparison): 'up' | 'down' | 'flat' | 'none' {
  if (metric.change === null) return 'none';
  if (metric.change > 0) return 'up';
  if (metric.change < 0) return 'down';
  return 'flat';
}

// ---------------------------------------------------------------------------------- trucks

/** Owner's wording (2026-10-25) for the driver columns the facts cannot fill. */
export const DRIVER_COST_NOTE =
  "Profit per driver isn't available: costs aren't allocated to drivers.";

export const PAGE_SIZES = [25, 50, 100] as const;

export type ProfitTag = 'profitable' | 'loss' | 'break_even' | 'no_cost' | 'no_revenue';

/**
 * Owner, 2026-10-25: Profitable / Loss / Break-even (exactly 0) / No cost data — and, when the
 * server says only cost is on file for the truck (`oneSided: cost_only`), No revenue.
 */
export function profitTag(row: Pick<RankedEntity, 'profit' | 'oneSided'>): ProfitTag {
  if (row.oneSided === 'cost_only') return 'no_revenue';
  if (row.oneSided === 'revenue_only') return 'no_cost';
  if (row.profit === null) return 'no_cost';
  if (row.profit > 0) return 'profitable';
  if (row.profit < 0) return 'loss';
  return 'break_even';
}

export const PROFIT_TAG: Record<
  ProfitTag,
  { label: string; family: 'done' | 'urgent' | 'neutral' }
> = {
  profitable: { label: 'Profitable', family: 'done' },
  loss: { label: 'Loss', family: 'urgent' },
  break_even: { label: 'Break-even', family: 'neutral' },
  no_cost: { label: 'No cost data', family: 'neutral' },
  no_revenue: { label: 'No revenue', family: 'neutral' },
};

/** Needs attention: data gaps (`data_*`) first, then the server's own order. */
export function attentionOrder<T extends { key: string }>(insights: readonly T[]): T[] {
  const data = insights.filter((i) => i.key.startsWith('data_'));
  return [...data, ...insights.filter((i) => !i.key.startsWith('data_'))];
}

/** "2026-10-24T18:05:00Z" → "Oct 24, 2:05 PM ET": business clock is US Eastern. */
export function easternDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)} ET`;
}

/**
 * Width of a margin bar, 0–100. A display scale only: the margin itself is printed beside it.
 * Negative margins draw an empty bar (the Loss tag and the red figure carry them).
 */
export function marginBarWidth(marginPct: number | null): number {
  if (marginPct === null || marginPct <= 0) return 0;
  return Math.min(100, marginPct);
}

// --------------------------------------------------------------------------------- financial

/** Categories ranked by share of revenue, as the server sent it; categories with no share last. */
export function shareOfRevenueRanking(drivers: readonly CostDriver[]): CostDriver[] {
  return [...drivers]
    .map((driver, index) => ({ driver, index }))
    .sort((a, b) => {
      const av = a.driver.shareOfRevenue;
      const bv = b.driver.shareOfRevenue;
      if (av === null || bv === null) {
        if (av === null && bv === null) return a.index - b.index;
        return av === null ? 1 : -1;
      }
      return bv - av || a.index - b.index;
    })
    .map((entry) => entry.driver);
}

/** `driver_pay` → `Driver Pay`: what the old `capitalize` styling showed. */
export function categoryLabel(category: string): string {
  return category
    .replace(/_/g, ' ')
    .replace(/(^|\s)(\S)/g, (_, space: string, letter: string) => space + letter.toUpperCase());
}

/** Bar width for a ranked list: share of the largest value, never under 2% so a row is visible. */
export function barWidth(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(2, Math.min(100, (Math.max(value, 0) / max) * 100));
}

// ---------------------------------------------------------------------------------- weekly chart

export interface ChartAxis {
  /** Value at the top of the plot. */
  top: number;
  /** Value at the bottom of the plot: 0, or below it when a week made a loss. */
  bottom: number;
  /** Gridline values, bottom to top, including 0. */
  ticks: number[];
}

/**
 * The weekly chart's axis: from the lowest value (0, or a loss) to the highest gross or cost,
 * rounded out to even steps so the dashed gridlines land on readable amounts.
 */
export function chartAxis(points: readonly TrendPoint[]): ChartAxis {
  let max = 0;
  let min = 0;
  for (const point of points) {
    max = Math.max(max, point.gross, point.cost ?? 0, point.profit ?? 0);
    min = Math.min(min, point.profit ?? 0);
  }
  if (max <= 0 && min >= 0) max = 1;
  const rough = (max - min) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = Math.ceil(rough / magnitude) * magnitude;
  const bottom = Math.floor(min / step) * step;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = bottom; value <= top + step / 2; value += step) ticks.push(Math.round(value));
  return { top, bottom, ticks };
}

/** Where a value sits on the axis, as a percentage from the bottom. */
export function axisPosition(axis: ChartAxis, value: number): number {
  const span = axis.top - axis.bottom;
  return span <= 0 ? 0 : ((value - axis.bottom) / span) * 100;
}
