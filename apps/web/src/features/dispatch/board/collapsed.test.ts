import { afterEach, describe, expect, it, vi } from 'vitest';
import { collapsedStorageKey, moveEntry, readCollapsed, writeCollapsed } from './collapsed';

describe('folded team bands (owner, 2026-10-26)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('keys by company, person and page, so boards and companies never share folds', () => {
    const daily = collapsedStorageKey('/dispatch/daily', 'co_a', 'usr_1');
    expect(daily).not.toBe(collapsedStorageKey('/dispatch/weekly', 'co_a', 'usr_1'));
    expect(daily).not.toBe(collapsedStorageKey('/dispatch/daily', 'co_b', 'usr_1'));
    expect(daily).not.toBe(collapsedStorageKey('/dispatch/daily', 'co_a', 'usr_2'));
    expect(daily).not.toBe(collapsedStorageKey('/dispatch/unassigned', 'co_a', 'usr_1'));
  });

  it('round-trips the folded ids and clears the key when nothing is folded', () => {
    const key = collapsedStorageKey('/dispatch/daily', 'co_a', 'usr_1');
    writeCollapsed(key, new Set(['d_adam', 'emp_adin']));
    expect([...readCollapsed(key)].sort()).toEqual(['d_adam', 'emp_adin']);
    writeCollapsed(key, new Set());
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('works without storage: unreadable or refused storage means every band starts open', () => {
    const key = collapsedStorageKey('/dispatch/daily', 'co_a', 'usr_1');
    window.localStorage.setItem(key, '{not json');
    expect(readCollapsed(key).size).toBe(0);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readCollapsed(key).size).toBe(0);
    expect(() => writeCollapsed(key, new Set(['d_adam']))).not.toThrow();
  });

  it('moveEntry moves one team up or down and leaves the ends alone', () => {
    expect(moveEntry(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveEntry(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveEntry(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
  });
});
