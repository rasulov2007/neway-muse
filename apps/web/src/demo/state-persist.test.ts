import { describe, expect, it } from 'vitest';
import * as stateModule from './state-persist';
import { collectionKey, mergeRows } from './state-persist';

/**
 * Two browsers editing the same collection: neither loses a record.
 *
 * The rows are the three copies the merge sees - what both started from, what the server holds
 * now (theirs), and what this browser holds (ours, possibly unsaved).
 */
describe('mergeRows', () => {
  const base = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];

  it('keeps a row created here that the server never saw', () => {
    const ours = [...base, { id: 'c', name: 'C (ours)' }];
    expect(mergeRows(base, base, ours)).toEqual([...base, { id: 'c', name: 'C (ours)' }]);
  });

  it('takes a row created there, and keeps ours, when both browsers created one', () => {
    const theirs = [...base, { id: 'd', name: 'D (theirs)' }];
    const ours = [...base, { id: 'c', name: 'C (ours)' }];
    expect(mergeRows(base, theirs, ours)).toEqual([
      ...base,
      { id: 'd', name: 'D (theirs)' },
      { id: 'c', name: 'C (ours)' },
    ]);
  });

  it('keeps our edit to a row they did not touch', () => {
    const ours = [{ id: 'a', name: 'A (edited here)' }, base[1]];
    expect(mergeRows(base, base, ours)).toEqual(ours);
  });

  it('takes their edit when both edited the same row', () => {
    const theirs = [{ id: 'a', name: 'A (theirs)' }, base[1]];
    const ours = [{ id: 'a', name: 'A (ours)' }, base[1]];
    expect(mergeRows(base, theirs, ours)).toEqual(theirs);
  });

  it('drops a row they deleted, and a row we deleted', () => {
    const theirs = [base[0]];
    const ours = [base[1]];
    expect(mergeRows(base, theirs, ours)).toEqual([]);
  });

  it('does not resurrect a row we deleted just because they left it alone', () => {
    expect(mergeRows(base, base, [base[0]])).toEqual([base[0]]);
  });
});

describe('collectionKey', () => {
  it('is a lower-cased, prefixed name the store accepts', () => {
    expect(collectionKey('repairOrders')).toBe('ws2-repairorders');
    expect(collectionKey('repairOrders')).toMatch(/^[a-z0-9_-]{1,64}$/);
  });
});

/**
 * Per-key workspace writes (owner, 2026-10-25): the browser does not try to save a collection the
 * worker's role may not write - the server would refuse it every twenty seconds.
 */
describe('maySaveKey', () => {
  it('lets the maintenance seat save PTI ratings but not invoices or repair orders (costs)', () => {
    const maintenance = ['maintenance.view', 'maintenance.edit', 'trucks.view', 'trucks.create', 'truck_assignment.edit', 'trailers.view', 'documents.create', 'accidents.view', 'accidents.edit_units'];
    const { maySaveKey } = stateModule;
    expect(maySaveKey(collectionKey('ptiRatings'), maintenance)).toBe(true);
    expect(maySaveKey(collectionKey('invoices'), maintenance)).toBe(false);
    expect(maySaveKey(collectionKey('repairOrders'), maintenance)).toBe(false);
  });

  it('leaves the decision to the server when the account could not be read', () => {
    expect(stateModule.maySaveKey(collectionKey('invoices'), null)).toBe(true);
  });
});
