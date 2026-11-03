/**
 * Chart theme built from the design tokens (tokens.css `--chart-*`). Recharts paints SVG, so it
 * needs concrete color strings; `var(--chart-…)` is the only allowed form (no raw hex here).
 *
 * The categorical palette is validated (dataviz skill) in this exact order. Never cycle or
 * re-order it: a 7th series folds into "Other" (neutral) instead of getting a new hue.
 *
 * What "validated" means here, precisely, because the honest answer is not "all of them":
 *
 *   1–4  iris, teal, amber, rose — pass every check for *every* pair. Any subset may be plotted
 *        together with no further thought.
 *   5    purple — ΔE 2.7 from iris under protanopia, 8.9 under normal vision. Safe only when
 *        series 1 is absent from the same plot. Nothing in the product plots more than three
 *        series, so this is a boundary rather than a live problem; if a fifth is ever needed,
 *        fold it into `other` instead of reaching for slot 5 beside iris.
 *   6    slate — deliberately below the chroma floor. It *is* the neutral "Other", not a hue.
 *
 * Teal and amber sit below 3:1 against the surface. That obligates the relief every chart in this
 * product already carries: a legend plus direct labels, and a table view of the same numbers.
 */

/*
 * Porcelain (design/porcelain/SPEC.md §7 "Charts"): series 1 is gross/revenue, series 2 is cost,
 * both from the theme's validated pair. Slots 3–6 predate the handoff and stay on the old
 * `--chart-series-*` values; the spec asks before a third series is added, so nothing new is
 * invented here.
 */
export const CHART_SERIES = [
  'var(--nw-chart-1)',
  'var(--nw-chart-2)',
  'var(--chart-series-3)',
  'var(--chart-series-4)',
  'var(--chart-series-5)',
  'var(--chart-series-6)',
] as const;

export const CHART_SEQUENTIAL = [
  'var(--chart-seq-1)',
  'var(--chart-seq-2)',
  'var(--chart-seq-3)',
  'var(--chart-seq-4)',
  'var(--chart-seq-5)',
  'var(--chart-seq-6)',
  'var(--chart-seq-7)',
] as const;

/**
 * Entrance animation timings (ms). Recharts paints SVG with rAF, so it needs numbers, not CSS
 * vars; these are the single source of truth and mirror the CSS side of chart motion in
 * motion.css. DESIGN_SYSTEM §1 rule 8 caps *interaction* feedback at 100-240 ms (see
 * `--duration-fast|base|slow`); a one-shot entrance is allowed to run longer so bars/lines can
 * be read as they grow. Everything hover-driven stays inside the token range.
 */
/** Bars, lines and areas: long enough to read the growth, short enough to never feel slow. */
export const animationDuration = 450;
/** Donut sweep: a full circle needs a touch more time than a bar rising. */
export const animationDurationSlow = 600;
/** Decelerating, no overshoot: nothing in a business dashboard should bounce. */
export const animationEasing = 'ease-out';
/** Per-series entrance offset so a multi-series chart cascades instead of popping at once. */
export const animationStagger = 90;

export const chartTheme = {
  /** Fixed categorical order (validated). Index by series position, never by rank. */
  series: CHART_SERIES,
  /** Single-hue ramp, light -> dark, for magnitude. */
  sequential: CHART_SEQUENTIAL,
  /** Reserved status colors; always paired with a label/icon, never used as "series N". */
  status: {
    good: 'var(--chart-good)',
    warning: 'var(--chart-warning)',
    serious: 'var(--chart-serious)',
    critical: 'var(--chart-critical)',
  },
  /** Color for a folded "Other" bucket or an over-budget series. */
  other: 'var(--nw-text-3)',
  grid: 'var(--nw-chart-grid)',
  /** Axis text: 11px in `--nw-text-3`. */
  axis: 'var(--nw-text-3)',
  /** Fill behind the current period (SPEC §7 "Chart parts"). */
  band: 'var(--nw-chart-band)',
  surface: 'var(--nw-panel)',
  /** Hover fill behind the active bar category. */
  hoverFill: 'var(--nw-hover)',
  fontSize: 11,
  axisTick: { fill: 'var(--nw-text-3)', fontSize: 11 },
  margin: { top: 8, right: 8, bottom: 0, left: 0 },
  line: { strokeWidth: 2 },
  /** 8px marker (r 4) with a 2px surface ring; shown on hover only. */
  dot: { r: 4, strokeWidth: 2 },
  area: { fillOpacity: 0.1 },
  bar: { radius: 3, maxSize: 24, gap: 2, categoryGap: '25%' },
  donut: { innerRadius: '62%', outerRadius: '92%', gap: 2 },
  /** Default entrance duration (bars / lines / areas). Kept as the historical export name. */
  animationDuration,
  /** Donut sweep. */
  animationDurationSlow,
  animationEasing,
  animationStagger,
  /** Outer-radius bump on the hovered donut slice (px). Subtle by design. */
  activeSliceOffset: 3,
  tooltip: {
    /** Raised surface, border-strong, radius 8, menu shadow (SPEC §7 "Menus … tooltips"). */
    className:
      'chart-tooltip-in rounded-md border border-nw-border-strong bg-nw-raised px-2.5 py-2 text-xs shadow-menu min-w-32 pointer-events-none',
    cursorLine: { stroke: 'var(--nw-text-3)', strokeWidth: 1 },
    cursorFill: { fill: 'var(--nw-hover)' },
  },
} as const;

export type ChartTheme = typeof chartTheme;

/** Series color by position. Explicit `color` wins; past the 6-slot budget we fold to neutral. */
export function seriesColor(index: number, explicit?: string): string {
  if (explicit) return explicit;
  const color = CHART_SERIES[index];
  if (color) return color;
  if (import.meta.env.DEV) {
    console.warn(
      `[chart] series #${index + 1} exceeds the 6-color categorical budget; fold the tail into "Other" or facet.`,
    );
  }
  return chartTheme.other;
}

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** Default value formatter: thousands-separated, at most 2 decimals. */
export function formatChartValue(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? numberFormat.format(value) : '';
  if (value === null || value === undefined) return '';
  return String(value);
}

/** "in_transit" -> "In transit"; "revenueUsd" -> "Revenue usd" */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
