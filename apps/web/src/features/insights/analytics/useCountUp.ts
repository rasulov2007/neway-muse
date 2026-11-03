import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '@/design-system';

export const COUNT_UP_MS = 600;

/**
 * A number that counts to its value once the data has arrived (owner, 2026-10-25).
 *
 * The first value counts up from zero; a later value (a new period) counts from the one on screen.
 * It always ends exactly on the target, so the formatted figure is the server's figure. `null` is
 * never animated: an unknown stays unknown. Off entirely under reduced motion, and where the
 * browser has no animation frames.
 */
export function useCountUp(target: number | null, duration = COUNT_UP_MS): number | null {
  const reduced = useReducedMotion();
  const canAnimate = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function';
  const [tween, setTween] = useState<{ target: number; value: number } | null>(null);
  // Where the last frame left off: the starting point of the next count.
  const lastShown = useRef(0);

  useEffect(() => {
    if (target === null || reduced || !canAnimate) return;
    const from = lastShown.current;
    const started = performance.now();
    let frame = window.requestAnimationFrame(function step(now: number) {
      const t = Math.min(1, (now - started) / duration);
      // Ease-out cubic: a quick start and a gentle landing on the figure.
      const value = t >= 1 ? target : from + (target - from) * (1 - (1 - t) ** 3);
      lastShown.current = value;
      setTween({ target, value });
      if (t < 1) frame = window.requestAnimationFrame(step);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [target, reduced, canAnimate, duration]);

  if (target === null) return null;
  if (reduced || !canAnimate) return target;
  // Before the first frame of a new count, the previous figure stays on screen.
  return tween ? tween.value : 0;
}
