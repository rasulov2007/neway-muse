import { describe, expect, it } from 'vitest';
import { driverMessageFromRc } from './driver-message.js';
import { driverLastDrop, type LastDropLoad } from './last-drop.js';
import type { StopLike } from './model.js';
import { planRoute } from './stops.js';
import type { RateConfirmationExtract } from './rate-confirmation.js';

/** The Telegram text after Create load (owner, 2026-10-25): LIVE / DROP on top, Empty / Loaded / Total miles. */
const rc: RateConfirmationExtract = {
  brokerName: 'Broker', brokerMc: null, brokerLoadNumber: '123456', totalRate: 3000, linehaulRate: null, commodity: null, weightLbs: null, equipment: 'dry_van', hazmat: false, temperature: null, miles: 350,
  stops: [
    { kind: 'pickup', facilityName: 'Shipper', street: null, city: 'Atlanta', state: 'GA', zip: null, date: '2026-10-24', time: '08:00', endTime: null, reference: null },
    { kind: 'delivery', facilityName: 'Receiver', street: null, city: 'Dallas', state: 'TX', zip: null, date: '2026-10-25', time: '14:00', endTime: null, reference: null },
  ],
  notes: null, warnings: [],
};

describe('the driver message miles', () => {
  it('reads Empty, Loaded and Total when the load has empty miles', () => {
    const text = driverMessageFromRc(rc, { emptyMiles: 45 });
    expect(text).toContain('Empty: 45 miles\nLoaded: 350 miles\nTotal: 395 miles');
  });

  it('has no Empty line without empty miles, and the total is the loaded miles', () => {
    for (const emptyMiles of [0, null, undefined]) {
      const text = driverMessageFromRc(rc, { emptyMiles });
      expect(text).not.toContain('Empty:');
      expect(text).toContain('Loaded: 350 miles\nTotal: 350 miles');
    }
  });

  it('a company driver still has no Rate line', () => {
    const text = driverMessageFromRc(rc, { hideRate: true, rate: 2500, emptyMiles: 45 });
    expect(text).not.toMatch(/Rate:/);
    expect(text).toContain('Total: 395 miles');
  });
});

describe('the LIVE / DROP line', () => {
  it('sits under the Load # line, first pickup then last delivery, upper case (owner, 2026-10-26)', () => {
    const text = driverMessageFromRc(rc, { handling: { pickup: 'live', delivery: 'drop' } });
    expect(text.split('\n')[0]).toBe('Load # 123456');
    expect(text.split('\n')[1]).toBe('LIVE / DROP');
    expect(driverMessageFromRc(rc, { handling: { pickup: 'drop', delivery: 'live' } }).split('\n')[1]).toBe('DROP / LIVE');
  });

  it('a side never said reads LIVE; no handling given leaves the line out', () => {
    expect(driverMessageFromRc(rc, { handling: {} }).split('\n')[1]).toBe('LIVE / LIVE');
    expect(driverMessageFromRc(rc).split('\n')[0]).toBe('Load # 123456');
    expect(driverMessageFromRc(rc).split('\n')[1]).not.toMatch(/LIVE|DROP/);
  });

  it('no trailer yet: Need Trailer between Load # and LIVE / DROP (owner, 2026-10-29)', () => {
    expect(driverMessageFromRc(rc, { handling: {}, needTrailer: true }).split('\n').slice(0, 3)).toEqual(['Load # 123456', 'Need Trailer', 'LIVE / LIVE']);
    expect(driverMessageFromRc(rc, { handling: {} })).not.toMatch(/Need Trailer/);
  });
});

describe('live / drop on an edited route', () => {
  const stop = (kind: 'pickup' | 'delivery', over: Partial<StopLike> = {}): StopLike => ({
    id: `s_${kind}`, sequence: kind === 'pickup' ? 1 : 2, kind, facilityName: 'Dock', city: kind === 'pickup' ? 'Atlanta' : 'Dallas', state: kind === 'pickup' ? 'GA' : 'TX',
    timezone: 'America/New_York', appointmentStartAt: '2026-10-24T12:00:00.000Z', appointmentEndAt: '2026-10-24T12:00:00.000Z', appointmentNoWindow: true,
    status: 'pending', arrivedAt: null, departedAt: null, ...over,
  });
  const edit = (s: StopLike, handling?: 'live' | 'drop') => ({ kind: s.kind, city: s.city, state: s.state, at: s.appointmentStartAt, noWindow: true, facilityName: s.facilityName, handling });
  const opts = { newId: (i: number) => `n${i}`, make: (b: StopLike) => b };

  it('saying Live on a stop that never said is no change; Drop is', () => {
    const existing = [stop('pickup'), stop('delivery')];
    expect(planRoute(existing, existing.map((s) => edit(s, 'live')), opts).changed).toBe(false);
    const plan = planRoute(existing, [edit(existing[0]!, 'live'), edit(existing[1]!, 'drop')], opts);
    expect(plan.changed).toBe(true);
    expect(plan.stops[1]!.handling).toBe('drop');
  });

  it('an edit that does not say keeps what the stop had', () => {
    const existing = [stop('pickup', { handling: 'drop' }), stop('delivery')];
    const plan = planRoute(existing, existing.map((s) => edit(s)), opts);
    expect(plan.stops[0]!.handling).toBe('drop');
  });
});

describe("the driver's last drop", () => {
  const load = (id: string, over: Partial<LastDropLoad>): LastDropLoad => ({
    id, loadNumber: `L-${id}`, status: 'delivered', driverId: 'drv_1', deliveryAt: '2026-10-20T12:00:00.000Z',
    stops: [{ kind: 'pickup', city: 'Atlanta', state: 'GA' }, { kind: 'delivery', city: 'Dallas', state: 'TX', zip: '75201' }],
    ...over,
  });

  it('is the last delivery of the latest load, cancelled ones and the load being edited left out', () => {
    const loads = [
      load('1', {}),
      load('2', { deliveryAt: '2026-10-22T12:00:00.000Z', stops: [{ kind: 'pickup', city: 'Dallas', state: 'TX' }, { kind: 'delivery', city: 'Memphis', state: 'TN' }] }),
      load('3', { deliveryAt: '2026-10-23T12:00:00.000Z', status: 'cancelled' }),
      load('4', { deliveryAt: '2026-10-24T12:00:00.000Z', driverId: 'drv_2' }),
    ];
    expect(driverLastDrop(loads, 'drv_1')).toEqual({ loadId: '2', loadNumber: 'L-2', city: 'Memphis', state: 'TN', zip: null });
    expect(driverLastDrop(loads, 'drv_1', '2')?.loadId).toBe('1');
    expect(driverLastDrop(loads, 'drv_3')).toBeNull();
  });

  it('counts a load the driver ran as the co-driver', () => {
    const loads = [load('5', { driverId: 'drv_9', coDriverId: 'drv_1' })];
    expect(driverLastDrop(loads, 'drv_1')?.loadId).toBe('5');
  });
});
