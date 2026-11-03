import type { HTMLAttributes } from 'react';
import { Area, AreaChart, YAxis } from 'recharts';
import { cn } from '../../lib/cn';
import { ChartFrame } from './ChartFrame';
import { chartTheme } from './chartTheme';

export interface SparklineProps extends HTMLAttributes<HTMLDivElement> {
  /** `null` is a gap (a week with no data), drawn as a break in the line rather than a zero. */
  data: ReadonlyArray<number | null>;
  /** Defaults to series 1. */
  color?: string;
  /** Height in px (default 32). */
  height?: number;
  /** Fixed width bypasses ResponsiveContainer. */
  width?: number;
}

/**
 * Bare trend for a stat tile: 2px line, 10% wash, no axes, no tooltip. Decorative (aria-hidden).
 *
 * Deliberately not animated: a sparkline is tile chrome, often several per screen, and a KPI card
 * should read the instant it paints. Animating them would turn a stat row into a light show, so
 * `isAnimationActive={false}` stays and the `.chart-plot` CSS hooks are not applied here.
 */
export function Sparkline({
  data,
  color = chartTheme.series[0],
  height = 32,
  width,
  className,
  style,
  ...rest
}: SparklineProps) {
  const points = data.map((v, i) => ({ i, v }));
  return (
    <div
      aria-hidden
      className={cn('w-full', className)}
      style={{ height, width, ...style }}
      {...rest}
    >
      <ChartFrame width={width} height={height}>
        <AreaChart data={points} margin={{ top: 2, right: 1, bottom: 2, left: 1 }}>
          <YAxis hide domain={['dataMin', 'dataMax']} />
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={chartTheme.line.strokeWidth}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill={color}
            fillOpacity={chartTheme.area.fillOpacity}
            connectNulls={false}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ChartFrame>
    </div>
  );
}
