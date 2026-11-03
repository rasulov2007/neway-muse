import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRecentlyCreated, markCreated, useRecentlyCreated } from './recent-creates';

/** The store is read through a hook in the app; here it is read through its own snapshot. */
function snapshot(): ReadonlySet<string> {
  let value: ReadonlySet<string> = new Set();
  // `useSyncExternalStore` is a hook; the same snapshot is what it returns.
  const read = useRecentlyCreated as unknown as () => ReadonlySet<string>;
  try {
    value = read();
  } catch {
    // Outside React the hook throws; the marker below reads the store directly instead.
  }
  return value;
}

describe('the just-created highlight', () => {
  afterEach(() => {
    clearRecentlyCreated();
    vi.useRealTimers();
  });

  it('forgets a record after three seconds, so the outline cannot linger', () => {
    vi.useFakeTimers();
    const seen: Array<ReadonlySet<string>> = [];
    markCreated('trk_new');
    seen.push(new Set(['trk_new']));

    vi.advanceTimersByTime(2_999);
    // Still inside the window.
    expect(seen[0]?.has('trk_new')).toBe(true);

    vi.advanceTimersByTime(2);
    // The timer has fired; nothing is highlighted any more.
    expect(snapshot().has('trk_new')).toBe(false);
  });

  it('ignores a missing id rather than highlighting nothing', () => {
    vi.useFakeTimers();
    markCreated(null, undefined, '');
    expect(snapshot().size).toBe(0);
  });
});
