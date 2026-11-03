import { chartTheme } from './chartTheme';
import { useReducedMotion } from './useReducedMotion';

export interface ChartAnimation {
  /** Passed straight to every Recharts graphical item. */
  isAnimationActive: boolean;
  /** Entrance duration in ms (0 when motion is off, so Recharts settles on frame one). */
  animationDuration: number;
  animationEasing: typeof chartTheme.animationEasing;
  /** Entrance offset for series `index`; 0 for every series when motion is off. */
  animationBegin: (index: number) => number;
  /** Fade the plot wrapper when it has to remount (series set changed). */
  fade: boolean;
}

/**
 * Resolves the animation props a chart hands to Recharts. Motion is on by default and turns off
 * for `animate={false}` or an OS reduced-motion preference.
 */
export function useChartAnimation(
  animate: boolean = true,
  duration: number = chartTheme.animationDuration,
): ChartAnimation {
  const reduced = useReducedMotion();
  const on = animate && !reduced;
  return {
    isAnimationActive: on,
    animationDuration: on ? duration : 0,
    animationEasing: chartTheme.animationEasing,
    animationBegin: (index: number) => (on ? index * chartTheme.animationStagger : 0),
    fade: on,
  };
}

/**
 * Identity of the *shape* of a chart (its series set), not its data. Used as the plot wrapper's
 * React key: same key means Recharts keeps its DOM and tweens new data instead of remounting;
 * a changed key remounts and the wrapper fades so the swap is not a flash.
 */
export function plotKeyOf(seriesKeys: ReadonlyArray<string>): string {
  return seriesKeys.join('|');
}
