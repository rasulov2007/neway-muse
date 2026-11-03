import { describe, expect, it } from 'vitest';
import { loadInHandSince, typedForEarlierLoad } from './board.js';

/**
 * Typed LOAD # / ETA / ROUTE / MILES belong to the load they were typed for (owner, 2026-10-27).
 * Johnson Garvey: L-100011 delivered 16:22, L-100016 dispatched 16:28; the ETA "UNLOADING" and
 * the route "SPRINGFIELD, MA" were about L-100011 and must not hide L-100016's own values.
 */
const NOW = '2026-10-27T17:00:00.000Z';

describe('load-bound cells', () => {
  it('the current load is in hand from the later of its dispatch and the last delivery', () => {
    const since = loadInHandSince(
      { id: 'b', dispatchedAt: '2026-10-27T16:28:00.000Z' },
      [{ id: 'a', deliveredAt: '2026-10-27T16:22:00.000Z' }],
      NOW,
    );
    expect(since).toBe('2026-10-27T16:28:00.000Z');
  });

  it('a prebook dispatched before the last delivery is in hand from that delivery', () => {
    const since = loadInHandSince(
      { id: 'b', dispatchedAt: '2026-10-26T09:00:00.000Z' },
      [{ id: 'a', deliveredAt: '2026-10-27T16:22:00.000Z' }, { id: 'old', deliveredAt: '2026-10-20T10:00:00.000Z' }],
      NOW,
    );
    expect(since).toBe('2026-10-27T16:22:00.000Z');
  });

  it('knows nothing when the load was never dispatched and nothing was delivered', () => {
    expect(loadInHandSince({ id: 'b', dispatchedAt: null }, [{ id: 'b', deliveredAt: null }], NOW)).toBeNull();
  });

  it('text typed for the earlier load gives way; text typed since stays', () => {
    const since = '2026-10-27T16:22:00.000Z';
    expect(typedForEarlierLoad('route', '2026-10-26T16:58:53.000Z', since)).toBe(true);
    expect(typedForEarlierLoad('eta', '2026-10-27T15:33:25.000Z', since)).toBe(true);
    expect(typedForEarlierLoad('eta', '2026-10-27T16:35:17.000Z', since)).toBe(false);
  });

  it('only the load columns: trailer, truck, notes and status keep what was typed', () => {
    const since = '2026-10-27T16:22:00.000Z';
    for (const c of ['trailer', 'truck', 'notes', 'status', 'phone']) {
      expect(typedForEarlierLoad(c, '2026-10-26T10:00:00.000Z', since)).toBe(false);
    }
    expect(typedForEarlierLoad('route', '2026-10-26T10:00:00.000Z', null)).toBe(false);
  });
});
