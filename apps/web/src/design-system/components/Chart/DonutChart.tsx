import type { ReactNode } from 'react';
import {
  Cell,
  Pie,
  PieChart,
  Sector,
  Tooltip,
  matchByIndex,
  type PieSectorShapeProps,
} from 'recharts';
import { cn } from '../../lib/cn';
import { ChartContainer, type ChartContainerProps } from './ChartContainer';
import { ChartFrame } from './ChartFrame';
import { renderChartTooltip, type RechartsTooltipEntry } from './tooltipAdapter';
import { plotKeyOf, useChartAnimation } from './chartAnimation';
import { chartTheme, animationDurationSlow, formatChartValue, seriesColor } from './chartTheme';
import type { ChartTableView, ValueFormatter } from './types';

export interface DonutSlice {
  name: string;
  value: number;
  /** Defaults to the categorical order; status donuts pass `chartTheme.status.*`. */
  color?: string;
}

export interface DonutChartProps extends Omit<
  ChartContainerProps,
  'children' | 'legend' | 'tableView'
> {
  data: DonutSlice[];
  valueFormatter?: ValueFormatter;
  /** Small label under the center value (e.g. "Trucks"). */
  centerLabel?: ReactNode;
  /** Large center figure; defaults to the total. */
  centerValue?: ReactNode;
  /** Fixed pixel size of the ring; bypasses ResponsiveContainer. */
  width?: number;
  /**
   * Where the legend sits relative to the ring. `'right'` (default) is the two-column reading
   * order; `'bottom'` stacks the ring over full-width legend rows for a narrow tile.
   */
  legendPosition?: 'right' | 'bottom';
  tableView?: ChartTableView | false;
  /** Sweep entrance. On by default; forced off by an OS reduced-motion preference. */
  animate?: boolean;
}

/**
 * Default slice, raised by `chartTheme.activeSliceOffset` px while it is the active one. Recharts
 * hands the resolved geometry (already interpolated during the sweep), so the raise composes with
 * the entrance animation instead of fighting it. Props are forwarded one by one: the rest of what
 * Recharts passes is bookkeeping, not SVG.
 */
function DonutSector(props: PieSectorShapeProps) {
  const outerRadius = props.isActive
    ? props.outerRadius + chartTheme.activeSliceOffset
    : props.outerRadius;
  return (
    <Sector
      cx={props.cx}
      cy={props.cy}
      innerRadius={props.innerRadius}
      outerRadius={outerRadius}
      startAngle={props.startAngle}
      endAngle={props.endAngle}
      cornerRadius={props.cornerRadius}
      className={props.className}
      fill={props.fill}
      stroke={props.stroke}
      strokeWidth={props.strokeWidth}
      tabIndex={props.tabIndex}
      data-recharts-item-index={props['data-recharts-item-index']}
      data-recharts-item-id={props['data-recharts-item-id']}
    />
  );
}

/**
 * Part-to-whole at a glance (<= 6 slices; use a bar to compare close values). Slices sit on a
 * 2px surface gap; the legend lists value + percent in text tokens, beside the ring by default or
 * under it with `legendPosition="bottom"`. The ring sweeps in clockwise from 12 o'clock and the
 * hovered slice sits 3px proud of the rest.
 */
export function DonutChart({
  data,
  valueFormatter = formatChartValue,
  centerLabel,
  centerValue,
  width,
  height = 200,
  legendPosition = 'right',
  tableView,
  animate,
  ...container
}: DonutChartProps) {
  const animation = useChartAnimation(animate, animationDurationSlow);
  const total = data.reduce((sum, d) => sum + (Number.isFinite(d.value) ? d.value : 0), 0);
  const colors = data.map((d, i) => seriesColor(i, d.color));
  const colorByName = new Map(data.map((d, i) => [d.name, colors[i]!]));
  const pct = (v: number) => (total > 0 ? Math.round((v / total) * 100) : 0);
  const table: ChartTableView | undefined =
    tableView === false
      ? undefined
      : (tableView ?? {
          columns: [
            { key: 'name', label: 'Category', align: 'left' },
            { key: 'value', label: 'Value', align: 'right' },
            { key: 'pct', label: 'Share', align: 'right' },
          ],
          rows: data.map((d) => ({
            name: d.name,
            value: valueFormatter(d.value),
            pct: `${pct(d.value)}%`,
          })),
        });
  const tooltip = renderChartTooltip({
    valueFormatter,
    hideLabel: true,
    colorOf: (e: RechartsTooltipEntry) =>
      typeof e.name === 'string' ? colorByName.get(e.name) : undefined,
  });
  const ring = width ?? height;
  const stacked = legendPosition === 'bottom';

  return (
    <ChartContainer height={height} tableView={table} {...container}>
      <div className={cn('flex h-full', stacked ? 'flex-col gap-3' : 'items-center gap-6')}>
        {/*
         * With the legend below, the ring must stay square: a full-width box with whatever height
         * is left over collapses the circle to the smaller dimension and the centre label then
         * overruns it. `aspect-square` sized off the remaining height keeps it round and centred.
         */}
        <div
          className={cn(
            'relative',
            stacked
              ? cn('mx-auto min-h-0', width ? 'shrink-0' : 'aspect-square h-full max-w-full flex-1')
              : 'h-full shrink-0',
          )}
          style={stacked && !width ? undefined : { width: ring }}
        >
          <ChartFrame
            width={width}
            height="100%"
            fadeKey={plotKeyOf(data.map((d) => d.name))}
            fade={animation.fade}
          >
            <PieChart className="chart-plot" margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                innerRadius={chartTheme.donut.innerRadius}
                outerRadius={chartTheme.donut.outerRadius}
                startAngle={90}
                endAngle={-270}
                stroke={chartTheme.surface}
                strokeWidth={chartTheme.donut.gap}
                shape={DonutSector}
                isAnimationActive={animation.isAnimationActive}
                animationDuration={animation.animationDuration}
                animationEasing={animation.animationEasing}
                animationBegin={0}
                animationMatchBy={matchByIndex}
              >
                {data.map((d, i) => (
                  <Cell key={d.name} fill={colors[i]} />
                ))}
              </Pie>
              <Tooltip content={tooltip} isAnimationActive={false} />
            </PieChart>
          </ChartFrame>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <div className="text-2xl leading-none font-semibold text-ink">
              {centerValue ?? valueFormatter(total)}
            </div>
            {centerLabel ? <div className="mt-1 text-xs text-muted">{centerLabel}</div> : null}
          </div>
        </div>
        <ul
          aria-label="Legend"
          className={cn(
            'flex min-w-0 flex-col gap-1.5 text-xs',
            stacked ? 'w-full shrink-0' : 'flex-1',
          )}
        >
          {data.map((d, i) => (
            <li key={d.name} className="flex items-center gap-2">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-xs"
                style={{ background: colors[i] }}
              />
              <span className="min-w-0 flex-1 truncate text-secondary">{d.name}</span>
              <span className="tabular font-medium text-ink">{valueFormatter(d.value)}</span>
              <span className={cn('tabular w-9 text-right text-muted')}>{pct(d.value)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </ChartContainer>
  );
}
