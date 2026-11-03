import { cloneElement, type ReactElement } from 'react';
import { ResponsiveContainer } from 'recharts';
import { cn } from '../../lib/cn';

export interface ChartFrameProps {
  /** Fixed pixel width bypasses ResponsiveContainer (tests, print, fixed slots). */
  width?: number;
  height: number | '100%';
  /**
   * Identity of the plot's series set. Stable key = Recharts keeps its DOM and tweens new data;
   * a changed key remounts the plot, and `fade` keeps that swap from flashing.
   */
  fadeKey?: string;
  /** Fade the wrapper in on mount/remount. Off under reduced motion. */
  fade?: boolean;
  children: ReactElement<{ width?: number; height?: number }>;
}

/** Sizes a Recharts chart: responsive by default, fixed when `width` is given. */
export function ChartFrame({ width, height, fadeKey, fade = false, children }: ChartFrameProps) {
  const className = cn('h-full w-full', fade && 'chart-fade-in');
  if (width) {
    const h = typeof height === 'number' ? height : width;
    return (
      <div
        key={fadeKey}
        className={fade ? 'chart-fade-in' : undefined}
        style={{ width, height: h }}
      >
        {cloneElement(children, { width, height: h })}
      </div>
    );
  }
  return (
    <div key={fadeKey} className={className}>
      <ResponsiveContainer width="100%" height={height}>
        {children}
      </ResponsiveContainer>
    </div>
  );
}
