import { describe, expect, it } from 'vitest';
import { planFor } from './StatusActionPanel';

/**
 * Where the POD is asked for.
 *
 * It was asked for on the way INTO unloading, which is the wrong moment: the truck is on the dock
 * and nothing has been handed over yet. It belongs to the move that ends the stop — ENROUTE when
 * another delivery follows, READY when it does not. These tests are that rule.
 */

type Stop = Parameters<typeof planFor>[1] extends infer L
  ? L extends { stops: (infer S)[] }
    ? S
    : never
  : never;

function stop(over: Partial<Stop> & { id: string; kind: 'pickup' | 'delivery' }): Stop {
  return {
    sequence: 1,
    facilityName: 'Dock',
    city: 'Irving',
    state: 'TX',
    timezone: 'America/Chicago',
    status: 'pending',
    arrivedAt: null,
    departedAt: null,
    appointmentStartAt: '2026-09-25T13:00:00Z',
    appointmentEndAt: '2026-09-25T15:00:00Z',
    ...over,
  } as Stop;
}

function load(stops: Stop[]) {
  return {
    id: 'ld_1',
    loadNumber: 'L-100002',
    status: 'in_transit',
    updatedAt: '2026-09-25T12:00:00Z',
    stops,
    documents: [],
  };
}

const pickupDone = stop({ id: 'p1', kind: 'pickup', status: 'completed' });

describe('one delivery', () => {
  const only = (status: string) => stop({ id: 'd1', kind: 'delivery', status });

  it('asks for no paperwork when the truck reaches the dock', () => {
    const plan = planFor('UNLOADING', load([pickupDone, only('pending')]));
    expect(plan?.kind).toBe('arrived');
    expect(plan?.paper).toBeNull();
    expect(plan?.timeLabel).toBe('Checked in');
  });

  it('asks for the POD when the truck leaves empty', () => {
    const plan = planFor('READY', load([pickupDone, only('in_progress')]));
    expect(plan?.kind).toBe('departed');
    expect(plan?.paper).toBe('pod');
    expect(plan?.title).toBe('Finish the delivery');
  });

  it('still asks for the POD at READY when nobody said UNLOADING', () => {
    expect(planFor('READY', load([pickupDone, only('pending')]))?.paper).toBe('pod');
  });

  it('asks for nothing at READY once the delivery is done', () => {
    expect(planFor('READY', load([pickupDone, only('completed')]))).toBeNull();
  });
});

describe('two deliveries', () => {
  it('asks for the POD on leaving the first, and says how many are left', () => {
    const plan = planFor(
      'ENROUTE',
      load([
        pickupDone,
        stop({ id: 'd1', kind: 'delivery', status: 'in_progress' }),
        stop({ id: 'd2', kind: 'delivery', status: 'pending', sequence: 2 }),
      ]),
    );
    expect(plan?.paper).toBe('pod');
    expect(plan?.stop?.id).toBe('d1');
    expect(plan?.title).toBe('Finish this stop, 1 to go');
  });

  it('records an arrival at the second delivery, with no paperwork', () => {
    const plan = planFor(
      'UNLOADING',
      load([
        pickupDone,
        stop({ id: 'd1', kind: 'delivery', status: 'completed' }),
        stop({ id: 'd2', kind: 'delivery', status: 'pending', sequence: 2 }),
      ]),
    );
    expect(plan?.kind).toBe('arrived');
    expect(plan?.stop?.id).toBe('d2');
    expect(plan?.paper).toBeNull();
  });

  it('finishes nothing when ENROUTE means driving between two stops it has not reached', () => {
    const plan = planFor(
      'ENROUTE',
      load([
        pickupDone,
        stop({ id: 'd1', kind: 'delivery', status: 'completed' }),
        stop({ id: 'd2', kind: 'delivery', status: 'pending', sequence: 2 }),
      ]),
    );
    expect(plan).toBeNull();
  });
});

describe('the steps before the freight is delivered', () => {
  it('still asks for the bill of lading on leaving the shipper', () => {
    const plan = planFor(
      'ENROUTE',
      load([stop({ id: 'p1', kind: 'pickup', status: 'in_progress' }), stop({ id: 'd1', kind: 'delivery' })]),
    );
    expect(plan?.paper).toBe('bol');
    expect(plan?.title).toBe('Left the shipper');
  });

  it('still asks for the rate confirmation on dispatch', () => {
    expect(planFor('DISPATCHED', load([pickupDone]))?.paper).toBe('rate_confirmation');
  });
});
