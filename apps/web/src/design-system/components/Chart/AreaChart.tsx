import {
  Area,
  AreaChart as RechartsAreaChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartContainer } from './ChartContainer';
import { ChartFrame } from './ChartFrame';
import { chartTheme } from './chartTheme';
import { useCartesianFrame, type CartesianChartProps } from './cartesian';

export interface AreaChartProps extends CartesianChartProps {
  /** Stack the areas (part-to-whole over time). */
  stacked?: boolean;
}

/**
 * Trend with a 10% wash under the line. Best for a single series; stack for part-to-whole.
 * The line draws in with Recharts; the wash underneath fades in via CSS (`.recharts-area-area`
 * in motion.css) so the fill arrives after the shape instead of sweeping with it.
 */
export function AreaChart({ stacked = false, ...props }: AreaChartProps) {
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
  return (
    <ChartContainer height={height} legend={legendNode} tableView={table} {...container}>
      <ChartFrame width={width} height={height} fadeKey={plotKey} fade={animation.fade}>
        <RechartsAreaChart className="chart-plot" data={data} margin={chartTheme.margin}>
          <CartesianGrid vertical={false} stroke={chartTheme.grid} strokeWidth={1} />
          <XAxis
            dataKey={xKey}
            tickLine={false}
            axisLine={false}
            tick={chartTheme.axisTick}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={tickX}
          />
          <YAxis
            width="auto"
            tickLine={false}
            axisLine={false}
            tick={chartTheme.axisTick}
            tickFormatter={tickY}
          />
          <Tooltip
            cursor={chartTheme.tooltip.cursorLine}
            content={tooltip}
            isAnimationActive={false}
          />
          {series.map((s, i) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stackId={stacked ? 'stack' : undefined}
              stroke={colors[i]}
              strokeWidth={chartTheme.line.strokeWidth}
              strokeLinejoin="round"
              strokeLinecap="round"
              fill={colors[i]}
              fillOpacity={chartTheme.area.fillOpacity}
              dot={false}
              activeDot={{
                r: chartTheme.dot.r,
                strokeWidth: chartTheme.dot.strokeWidth,
                stroke: chartTheme.surface,
                fill: colors[i],
              }}
              isAnimationActive={animation.isAnimationActive}
              animationDuration={animation.animationDuration}
              animationEasing={animation.animationEasing}
              animationBegin={animation.animationBegin(i)}
            />
          ))}
        </RechartsAreaChart>
      </ChartFrame>
    </ChartContainer>
  );
}
