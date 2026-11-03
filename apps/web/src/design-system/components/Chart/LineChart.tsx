import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartContainer } from './ChartContainer';
import { ChartFrame } from './ChartFrame';
import { chartTheme } from './chartTheme';
import { useCartesianFrame, type CartesianChartProps } from './cartesian';

export type LineChartProps = CartesianChartProps;

/**
 * Trend over time. One y-axis; 2px lines; 8px dots on hover only. Lines draw in on mount and
 * tween between data sets; the hover dot fades/scales in via CSS (see motion.css).
 */
export function LineChart(props: LineChartProps) {
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
        <RechartsLineChart className="chart-plot" data={data} margin={chartTheme.margin}>
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
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={colors[i]}
              strokeWidth={chartTheme.line.strokeWidth}
              strokeLinejoin="round"
              strokeLinecap="round"
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
        </RechartsLineChart>
      </ChartFrame>
    </ChartContainer>
  );
}
