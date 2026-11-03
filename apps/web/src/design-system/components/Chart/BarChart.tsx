import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
  matchByIndex,
} from 'recharts';
import { ChartContainer } from './ChartContainer';
import { ChartFrame } from './ChartFrame';
import { chartTheme } from './chartTheme';
import { useCartesianFrame, type CartesianChartProps } from './cartesian';

export interface BarChartProps extends CartesianChartProps {
  stacked?: boolean;
  /**
   * Recharts semantics: `horizontal` (default) draws vertical columns along an x category axis;
   * `vertical` draws horizontal bars along a y category axis (use for long category names).
   */
  layout?: 'horizontal' | 'vertical';
}

/**
 * Magnitude or part-to-whole. Bars <= 24px, 4px rounded at the data end only, square at the
 * baseline; stacked segments separated by a 2px surface gap (surface-colored stroke).
 *
 * Bars grow from the baseline, one series after another (`animationBegin` stagger). A period
 * change tweens bar heights (`matchByIndex`) instead of replaying the entrance.
 */
export function BarChart({ stacked = false, layout = 'horizontal', ...props }: BarChartProps) {
  const {
    data,
    xKey,
    series,
    width,
    height,
    container,
    colors,
    legendNode,
    table,
    tickX,
    tickY,
    tooltip,
    animation,
    plotKey,
  } = useCartesianFrame(props);
  const r = chartTheme.bar.radius;
  const endRadius: [number, number, number, number] =
    layout === 'vertical' ? [0, r, r, 0] : [r, r, 0, 0];
  const last = series.length - 1;

  return (
    <ChartContainer height={height} legend={legendNode} tableView={table} {...container}>
      <ChartFrame width={width} height={height} fadeKey={plotKey} fade={animation.fade}>
        <RechartsBarChart
          className="chart-plot"
          data={data}
          layout={layout}
          margin={chartTheme.margin}
          barGap={chartTheme.bar.gap}
          barCategoryGap={chartTheme.bar.categoryGap}
          maxBarSize={chartTheme.bar.maxSize}
        >
          <CartesianGrid
            vertical={layout === 'vertical'}
            horizontal={layout === 'horizontal'}
            stroke={chartTheme.grid}
            strokeWidth={1}
          />
          {layout === 'vertical' ? (
            <>
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                tick={chartTheme.axisTick}
                tickMargin={8}
                tickFormatter={tickY}
              />
              <YAxis
                type="category"
                dataKey={xKey}
                width="auto"
                tickLine={false}
                axisLine={false}
                tick={chartTheme.axisTick}
                tickFormatter={tickX}
              />
            </>
          ) : (
            <>
              <XAxis
                dataKey={xKey}
                tickLine={false}
                axisLine={false}
                tick={chartTheme.axisTick}
                tickMargin={8}
                minTickGap={16}
                tickFormatter={tickX}
              />
              <YAxis
                width="auto"
                tickLine={false}
                axisLine={false}
                tick={chartTheme.axisTick}
                tickFormatter={tickY}
              />
            </>
          )}
          <Tooltip
            cursor={chartTheme.tooltip.cursorFill}
            content={tooltip}
            isAnimationActive={false}
          />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              fill={colors[i]}
              stackId={stacked ? 'stack' : undefined}
              radius={!stacked || i === last ? endRadius : 0}
              stroke={stacked ? chartTheme.surface : undefined}
              strokeWidth={stacked ? chartTheme.bar.gap : 0}
              isAnimationActive={animation.isAnimationActive}
              animationDuration={animation.animationDuration}
              animationEasing={animation.animationEasing}
              animationBegin={animation.animationBegin(i)}
              animationMatchBy={matchByIndex}
            />
          ))}
        </RechartsBarChart>
      </ChartFrame>
    </ChartContainer>
  );
}
