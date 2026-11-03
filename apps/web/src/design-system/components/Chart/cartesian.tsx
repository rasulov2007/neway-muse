import type { ReactNode } from 'react';
import { ChartLegend } from './ChartLegend';
import type { ChartContainerProps } from './ChartContainer';
import { renderChartTooltip, type RechartsTooltipContentProps } from './tooltipAdapter';
import { plotKeyOf, useChartAnimation } from './chartAnimation';
import { seriesColor } from './chartTheme';
import { buildCartesianTable } from './chartUtils';
import type { ChartDatum, ChartSeries, ChartTableView, ValueFormatter, XFormatter } from './types';

/** A Recharts `Tooltip` content component: receives the hovered point and renders the card. */
export type TooltipContentRenderer = (props: RechartsTooltipContentProps) => ReactNode;

export interface CartesianChartProps extends Omit<
  ChartContainerProps,
  'children' | 'legend' | 'tableView'
> {
  data: ChartDatum[];
  xKey: string;
  /** Column label for the x values in the table view (defaults to a humanized xKey). */
  xLabel?: string;
  series: ChartSeries[];
  valueFormatter?: ValueFormatter;
  xFormatter?: XFormatter;
  /** Fixed pixel width; bypasses ResponsiveContainer (tests, print). */
  width?: number;
  /** Auto for >= 2 series; `false` hides; a node replaces. */
  legend?: ReactNode | false;
  /** Auto-generated from data; `false` disables the table toggle. */
  tableView?: ChartTableView | false;
  /** Entrance animation. On by default; forced off by an OS reduced-motion preference. */
  animate?: boolean;
  /**
   * Replaces the default tooltip renderer. Use when a chart needs rows the series alone cannot
   * express — a derived ratio, say — so it keeps the wrapper's legend, animation and table view
   * instead of re-implementing the plot with raw primitives.
   */
  renderTooltip?: TooltipContentRenderer;
}

/**
 * Shared derivation for the cartesian wrappers: splits chart props from ChartContainer props,
 * resolves series colors in fixed order, builds the legend (>= 2 series), the table twin,
 * the axis tick formatters, the tooltip renderer and the resolved animation props.
 */
export function useCartesianFrame(props: CartesianChartProps) {
  const {
    data,
    xKey,
    xLabel,
    series,
    valueFormatter,
    xFormatter,
    width,
    height = 240,
    legend,
    tableView,
    animate,
    renderTooltip,
    ...container
  } = props;
  const animation = useChartAnimation(animate);
  const colors = series.map((s, i) => seriesColor(i, s.color));
  const legendNode =
    legend === false ? undefined : legend !== undefined ? (
      legend
    ) : series.length >= 2 ? (
      <ChartLegend items={series.map((s, i) => ({ label: s.label, color: colors[i]! }))} />
    ) : undefined;
  const table =
    tableView === false
      ? undefined
      : (tableView ??
        buildCartesianTable(data, xKey, series, { xLabel, valueFormatter, xFormatter }));
  const tickX = xFormatter ? (v: string | number) => xFormatter(v) : undefined;
  const tickY = valueFormatter ? (v: number) => valueFormatter(v) : undefined;
  const tooltip =
    renderTooltip ??
    renderChartTooltip({
      valueFormatter,
      labelFormatter: xFormatter
        ? (l) => (typeof l === 'string' || typeof l === 'number' ? xFormatter(l) : l)
        : undefined,
    });
  return {
    data,
    xKey,
    series,
    width,
    height,
    animation,
    /** Stable while the series set is: lets Recharts tween a data swap instead of remounting. */
    plotKey: plotKeyOf(series.map((s) => s.key)),
    container,
    colors,
    legendNode,
    table,
    tickX,
    tickY,
    tooltip,
  };
}
