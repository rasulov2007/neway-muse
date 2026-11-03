import { describe, expect, it } from 'vitest';
import { transition, type TransitionActor } from './transition.js';
import type { StoredLoad } from './write-rules.js';

/**
 * The one way a status moves, whoever is speaking.
 *
 * Every path - a person, the Daily Board, a BOL or POD upload, Samsara - is a transition through
 * one function. The tests below are the contract each path relies on: the allowed moves are the
 * allowed moves, the actor is named for what it is, and the record remembers who moved it last.
 */
const NOW = '2026-09-25T12:00:00.000Z';

function load(over: Partial<StoredLoad> = {}): StoredLoad {
  return {
    id: 'ld_1',
    loadNumber: 'L-100001',
    status: 'in_transit',
    dispatcherId: 'usr_1',
    dispatcherName: 'Marcus Reid',
    driverId: 'drv_1',
    truckId: 'trk_1',
    trailerId: null,
    stops: [
      { id: 's1', sequence: 1, kind: 'pickup', facilityName: 'Shipper', city: 'Denver', state: 'CO', timezone: 'America/Denver', appointmentStartAt: '2026-09-24T14:00:00Z', appointmentEndAt: '2026-09-24T16:00:00Z', status: 'completed', arrivedAt: '2026-09-24T14:30:00Z', departedAt: '2026-09-24T15:30:00Z' },
      { id: 's2', sequence: 2, kind: 'delivery', facilityName: 'Receiver', city: 'Cleveland', state: 'OH', timezone: 'America/New_York', appointmentStartAt: '2026-09-26T13:00:00Z', appointmentEndAt: '2026-09-26T15:00:00Z', status: 'pending', arrivedAt: null, departedAt: null },
    ],
    documents: [
      { id: 'd1', type: 'rate_confirmation', title: 'Rate con', fileName: 'rc.pdf', uploadedAt: NOW, uploadedBy: 'x', status: 'pending', review: 'received' },
      { id: 'd2', type: 'bol', title: 'BOL', fileName: 'bol.pdf', uploadedAt: NOW, uploadedBy: 'x', status: 'pending', review: 'received' },
    ],
    notes: [],
    timeline: [],
    dispatchedAt: '2026-09-24T12:00:00Z',
    deliveredAt: null,
    updatedAt: NOW,
    ...over,
  } as StoredLoad;
}

const person: TransitionActor = { id: 'usr_2', name: 'Dana Reed', isLead: false, source: 'user' };

describe('one function, every source', () => {
  it('moves a status a person is allowed to make and names them', () => {
    const out = transition(load(), { kind: 'status', input: { status: 'at_delivery', bypassPaperwork: false, expectedUpdatedAt: NOW } }, person, NOW);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.status).toBe('at_delivery');
    expect(out.event?.actorName).toBe('Dana Reed');
    expect(out.event?.actorType).toBe('user');
    expect((out.record as { lastChangedBy?: { source: string } }).lastChangedBy?.source).toBe('user');
  });

  it('names an automatic source as itself, never as somebody', () => {
    const samsara: TransitionActor = { id: 'sys', name: 'Geofence', isLead: true, source: 'samsara' };
    const out = transition(
      load(),
      { kind: 'stop_event', input: { stopId: 's2', kind: 'arrived', at: '2026-09-26T13:10:00Z', zone: 'America/New_York', expectedUpdatedAt: NOW } },
      samsara,
      '2026-09-26T13:11:00Z',
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.event?.actorType).toBe('system');
    expect(out.event?.actorName).toContain('Samsara');
    expect(out.record.status).toBe('at_delivery');
  });

  it('refuses a move the rules do not allow, from any source', () => {
    const out = transition(load(), { kind: 'status', input: { status: 'booked', bypassPaperwork: false, expectedUpdatedAt: NOW } }, person, NOW);
    expect(out.ok).toBe(false);
  });

  it('refuses a stale write', () => {
    const out = transition(load(), { kind: 'status', input: { status: 'at_delivery', bypassPaperwork: false, expectedUpdatedAt: '2000-01-01T00:00:00Z' } }, person, NOW);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.code).toBe('conflict');
  });
});
