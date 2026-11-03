import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chartTheme } from './chartTheme';
import { useChartAnimation } from './chartAnimation';
import { useReducedMotion } from './useReducedMotion';

/** Minimal MediaQueryList double: one instance per query, mutable `matches`, real subscribers. */
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const mql = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: (event: Event) => {
      for (const listener of listeners) {
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      }
      return true;
    },
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mql as unknown as MediaQueryList),
  );
  return {
    /** Flip the OS preference the way a settings change would. */
    set(next: boolean) {
      mql.matches = next;
      mql.dispatchEvent(new Event('change'));
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useReducedMotion', () => {
  it('reports no preference when matchMedia is missing (jsdom, SSR)', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it('reads the media query and reacts to a change', () => {
    const media = stubMatchMedia(false);
    const { result, unmount } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);

    act(() => media.set(true));
    expect(result.current).toBe(true);

    act(() => media.set(false));
    expect(result.current).toBe(false);

    unmount();
    expect(media.listenerCount()).toBe(0);
  });
});

describe('useChartAnimation', () => {
  it('animates by default, staggering one series after another', () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useChartAnimation());
    expect(result.current.isAnimationActive).toBe(true);
    expect(result.current.animationDuration).toBe(chartTheme.animationDuration);
    expect(result.current.animationDuration).toBeGreaterThan(0);
    expect(result.current.animationEasing).toBe('ease-out');
    expect(result.current.animationBegin(0)).toBe(0);
    expect(result.current.animationBegin(2)).toBe(2 * chartTheme.animationStagger);
    expect(result.current.fade).toBe(true);
  });

  it('takes an explicit duration (the donut sweep runs longer)', () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useChartAnimation(true, chartTheme.animationDurationSlow));
    expect(result.current.animationDuration).toBe(chartTheme.animationDurationSlow);
    expect(chartTheme.animationDurationSlow).toBeGreaterThan(chartTheme.animationDuration);
  });

  it('is off for animate={false} and for a reduced-motion preference', () => {
    const media = stubMatchMedia(false);
    const { result, rerender } = renderHook(({ animate }) => useChartAnimation(animate), {
      initialProps: { animate: false },
    });
    expect(result.current.isAnimationActive).toBe(false);
    expect(result.current.animationDuration).toBe(0);
    expect(result.current.animationBegin(3)).toBe(0);
    expect(result.current.fade).toBe(false);

    rerender({ animate: true });
    expect(result.current.isAnimationActive).toBe(true);

    act(() => media.set(true));
    expect(result.current.isAnimationActive).toBe(false);
    expect(result.current.animationDuration).toBe(0);
    expect(result.current.fade).toBe(false);
  });
});
