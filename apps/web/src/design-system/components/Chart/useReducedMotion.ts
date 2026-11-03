import { useSyncExternalStore } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** `window.matchMedia` is absent in jsdom and during SSR; both mean "no preference known". */
function getMediaQueryList(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

function readPreference(): boolean {
  return getMediaQueryList()?.matches ?? false;
}

/** No preference is knowable without a DOM, and full motion is the design default. */
function getServerSnapshot(): boolean {
  return false;
}

function subscribe(onStoreChange: () => void): () => void {
  const mql = getMediaQueryList();
  if (!mql) return () => {};
  mql.addEventListener('change', onStoreChange);
  return () => mql.removeEventListener('change', onStoreChange);
}

/**
 * `true` when the OS asks for reduced motion. CSS is already handled globally by the
 * `prefers-reduced-motion` block in tokens.css; Recharts animates in JS, so its charts need the
 * preference as a value to hand to `isAnimationActive`.
 *
 * Subscribed, so toggling the setting takes effect without a reload.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, readPreference, getServerSnapshot);
}
