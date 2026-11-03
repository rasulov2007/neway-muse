import { describe, expect, it } from 'vitest';
import { findDuplicateOrder, type ExistingOrder } from './work-order-duplicate';

const day = Date.parse('2026-09-29T12:00:00Z');
const order = (over: Partial<ExistingOrder>): ExistingOrder => ({
  number: 'RO-2026-1033',
  vendorName: 'Mason Truck Repair LLC',
  workDone: 'new tire, tandem valve',
  label: 'new tire, tandem valve',
  shopInAt: '2026-09-29T00:00:00Z',
  completedAt: '2026-09-29T00:00:00Z',
  createdAt: '2026-09-29T23:06:29Z',
  total: 553.57,
  ...over,
});

describe('finding a duplicate work order', () => {
  it('catches the same shop and total on the same unit within a week (the RO-1033 / RO-1034 case)', () => {
    const hit = findDuplicateOrder([order({})], { vendorName: 'Mason Truck Repair LLC', total: 553.57, title: 'new tire, tandem valve', at: day });
    expect(hit?.number).toBe('RO-2026-1033');
  });

  it('matches on the description when the reader cannot see money', () => {
    const hit = findDuplicateOrder([order({ total: undefined })], { vendorName: 'mason truck repair llc', total: 553.57, title: 'New tire,  tandem valve', at: day });
    expect(hit?.number).toBe('RO-2026-1033');
  });

  it('does not flag a different total, a different shop, an old order or a voided one', () => {
    const next = { vendorName: 'Mason Truck Repair LLC', total: 553.57, title: 'x', at: day };
    expect(findDuplicateOrder([order({ total: 120 })], next)).toBeNull();
    expect(findDuplicateOrder([order({ vendorName: 'Other Shop' })], next)).toBeNull();
    expect(findDuplicateOrder([order({ completedAt: '2026-09-01T00:00:00Z' })], next)).toBeNull();
    expect(findDuplicateOrder([order({ voided: { at: 'x' } })], next)).toBeNull();
  });
});
