import { describe, expect, it } from 'vitest';
import { BOARD_WORDS_NEEDING_A_LOAD, boardLoadsFor } from './board.js';

/**
 * What a row shows, given the word the dispatcher typed and the driver's loads.
 *
 * The owner's rule (2026-09-30): assigning a load to a driver with an empty LOAD # puts it there
 * and the row reads DISPATCHED; a load assigned while LOAD # is filled is a prebook in Notes; a
 * driver with no load cannot be DISPATCHED, ENROUTE or UNLOADING.
 */
const load = (id: string, status: string) => ({ id, status });

describe('the load a row carries', () => {
  it('carries the one that is moving', () => {
    const { primary } = boardLoadsFor('ENROUTE', [load('a', 'booked'), load('b', 'in_transit')]);
    expect(primary?.id).toBe('b');
  });

  it('falls back to one that has been dispatched', () => {
    const { primary } = boardLoadsFor('DISPATCHED', [load('a', 'booked'), load('b', 'dispatched')]);
    expect(primary?.id).toBe('b');
  });

  it('queues everything behind the one it carries (a prebook waits in Notes)', () => {
    const { queued } = boardLoadsFor('ENROUTE', [load('a', 'booked'), load('b', 'in_transit')]);
    expect(queued.map((l) => l.id)).toEqual(['a']);
  });

  it('carries nothing on READY while an unfinished load disagrees with it', () => {
    const { primary, queued } = boardLoadsFor('READY', [load('a', 'unloading'), load('b', 'booked')]);
    expect(primary).toBeNull();
    expect(queued.map((l) => l.id)).toEqual(['b']);
  });

  it('a load assigned to a READY driver goes in LOAD # and the row reads DISPATCHED', () => {
    const row = boardLoadsFor('READY', [load('a', 'assigned')]);
    expect(row.primary?.id).toBe('a');
    expect(row.status).toBe('DISPATCHED');
    expect(row.queued).toEqual([]);
  });

  it('the first load goes in LOAD #, the next one is a prebook in Notes', () => {
    const row = boardLoadsFor('READY', [load('a', 'assigned'), load('b', 'assigned')]);
    expect(row.primary?.id).toBe('a');
    expect(row.queued.map((l) => l.id)).toEqual(['b']);
  });

  it('with no status typed, an assigned load reads DISPATCHED too', () => {
    expect(boardLoadsFor(null, [load('a', 'assigned')]).status).toBe('DISPATCHED');
  });

  it('a driver who is off keeps their word; the load still shows in LOAD #', () => {
    const row = boardLoadsFor('HOME', [load('a', 'assigned')]);
    expect(row.status).toBe('HOME');
    expect(row.primary?.id).toBe('a');
  });

  it('with no load, the word stays what was typed', () => {
    const row = boardLoadsFor('READY', []);
    expect(row.primary).toBeNull();
    expect(row.status).toBe('READY');
  });

  it('carries the moving load when no status has been typed', () => {
    const { primary } = boardLoadsFor(null, [load('a', 'in_transit')]);
    expect(primary?.id).toBe('a');
  });

  it('names the three words that need a load', () => {
    expect([...BOARD_WORDS_NEEDING_A_LOAD].sort()).toEqual(['DISPATCHED', 'ENROUTE', 'UNLOADING']);
  });
});
