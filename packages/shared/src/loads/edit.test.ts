import { describe, expect, it } from 'vitest';
import { applyEdit } from './edit.js';
import type { StoredLoad } from './write-rules.js';

const NOW = '2026-09-25T12:00:00.000Z';
const load = (): StoredLoad =>
  ({
    id: 'ld_1',
    loadNumber: 'L-100001',
    status: 'in_transit',
    dispatcherId: 'usr_1',
    dispatcherName: 'Marcus Reid',
    driverId: 'drv_1',
    truckId: 'trk_1',
    trailerId: null,
    stops: [],
    documents: [],
    notes: [],
    timeline: [],
    dispatchedAt: '2026-09-24T12:00:00Z',
    deliveredAt: null,
    updatedAt: '2026-09-25T11:00:00.000Z',
    brokerReference: 'PO-1',
    loadedMiles: 812,
    emptyMiles: 40,
    rpm: 3.08,
    pickupAt: '2026-09-24T14:00:00Z',
  }) as StoredLoad;

describe('Edit (rule 1.3)', () => {
  it('changes only the field sent; miles, RPM, dispatcher and times are exactly what they were', () => {
    const before = load();
    const out = applyEdit(before, { expectedUpdatedAt: before.updatedAt, patch: { brokerReference: 'PO-2' } }, NOW);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.brokerReference).toBe('PO-2');
    expect(out.record.loadedMiles).toBe(812);
    expect(out.record.emptyMiles).toBe(40);
    expect(out.record.rpm).toBe(3.08);
    expect(out.record.dispatcherId).toBe('usr_1');
    expect(out.record.dispatcherName).toBe('Marcus Reid');
    expect(out.record.pickupAt).toBe('2026-09-24T14:00:00Z');
    expect(out.record.updatedAt).toBe(NOW);
  });

  it('refuses status and assignment through Edit', () => {
    const before = load();
    const out = applyEdit(before, { expectedUpdatedAt: before.updatedAt, patch: { status: 'delivered' } }, NOW);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.message).toContain('status cannot be changed through Edit');
  });

  it('refuses a stale save instead of overwriting', () => {
    const before = load();
    const out = applyEdit(before, { expectedUpdatedAt: '2000-01-01T00:00:00Z', patch: { brokerReference: 'PO-2' } }, NOW);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.code).toBe('conflict');
  });
});
