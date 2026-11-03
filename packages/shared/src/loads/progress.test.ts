import { describe, expect, it } from 'vitest';
import {
  allDeliveriesComplete,
  assignmentPatch,
  correctionRefusal,
  missingDocumentsFor,
  statusPatch,
  statusRefusal,
  stopEventPatch,
  type ProgressActor,
  missingPaperwork,
  paperworkLabel,
} from './progress.js';
import type { DocumentLike, LoadLike, StopLike } from './model.js';

/**
 * The rules these tests hold, in order of how much they cost when broken:
 *
 * - a load completes when the freight is off, never because somebody typed a word;
 * - only the stop named in the call moves;
 * - a time is taken in the stop's own zone or it is refused;
 * - a correction belongs to the person who made the entry, for two hours.
 */
const dispatcher: ProgressActor = { id: 'u1', name: 'Elena Vasquez', isLead: false };
const lead: ProgressActor = { id: 'u2', name: 'Sarah Chen', isLead: true };
const NOW = '2026-09-24T18:00:00.000Z';

function stop(over: Partial<StopLike> = {}): StopLike {
  return {
    id: 's1',
    sequence: 1,
    kind: 'delivery',
    facilityName: 'Bluewater Chemicals',
    city: 'Houston',
    state: 'TX',
    timezone: 'America/Chicago',
    appointmentStartAt: '2026-09-24T16:00:00.000Z',
    appointmentEndAt: '2026-09-24T18:00:00.000Z',
    status: 'in_progress',
    arrivedAt: '2026-09-24T16:08:00.000Z',
    departedAt: null,
    ...over,
  };
}

function doc(type: DocumentLike['type']): DocumentLike {
  return {
    id: `doc_${type}`,
    type,
    title: type,
    fileName: `${type}.pdf`,
    uploadedAt: '2026-09-20T10:00:00.000Z',
    uploadedBy: 'Elena Vasquez',
    status: 'received',
    review: 'received',
  };
}

function load(over: Partial<LoadLike> = {}): LoadLike {
  return {
    id: 'ld1',
    loadNumber: 'L-100235',
    status: 'at_delivery',
    dispatcherId: 'u1',
    dispatcherName: 'Elena Vasquez',
    driverId: 'drv_1',
    truckId: 'trk_1',
    trailerId: null,
    stops: [stop({ id: 'p1', kind: 'pickup', sequence: 0, status: 'completed', departedAt: '2026-09-22T05:00:00.000Z' }), stop()],
    documents: [doc('rate_confirmation'), doc('bol')],
    notes: [],
    timeline: [],
    dispatchedAt: '2026-09-22T04:00:00.000Z',
    deliveredAt: null,
    updatedAt: '2026-09-24T17:00:00.000Z',
    ...over,
  };
}

describe('what blocks a status move', () => {
  it('refuses a step the sequence does not allow', () => {
    expect(statusRefusal(load({ status: 'booked' }), 'delivered', { bypassPaperwork: false }, dispatcher)?.code).toBe('invalid');
  });

  it('refuses delivered while a delivery stop is still open', () => {
    // One delivery, not finished: the message says to finish the stop rather than the load.
    expect(statusRefusal(load(), 'delivered', { bypassPaperwork: false }, dispatcher)?.message).toContain(
      'No delivery has been completed yet',
    );
    // Two deliveries with one left: the message names how many and where.
    const two = load({
      stops: [
        stop({ id: 'p1', kind: 'pickup', status: 'completed' }),
        stop({ id: 'd1', status: 'completed' }),
        stop({ id: 'd2', sequence: 2, status: 'pending', facilityName: 'Gulf Terminal' }),
      ],
    });
    expect(statusRefusal(two, 'delivered', { bypassPaperwork: false }, dispatcher)?.message).toContain('Gulf Terminal');
  });

  it('lets a delivered load be delivered without its POD, and says what is missing', () => {
    // Delivery is a fact about the freight. The paperwork is a separate, visible fact that
    // blocks billing, not the status: holding the load at "at delivery" would misreport it.
    const l = load({ stops: [stop({ id: 'p1', kind: 'pickup', status: 'completed' }), stop({ status: 'completed' })] });
    expect(statusRefusal(l, 'delivered', { bypassPaperwork: false }, dispatcher)).toBeNull();
    expect(paperworkLabel(missingPaperwork({ ...l, status: 'delivered' }))).toBe('POD missing');
    expect(missingPaperwork(l)).toEqual([]); // not delivered yet: nothing is late
  });

  it('still asks for the BOL before loaded, and a lead may bypass it with a reason', () => {
    const l = load({ status: 'at_pickup', documents: [doc('rate_confirmation')], stops: [stop({ id: 'p1', kind: 'pickup', status: 'completed' }), stop({ status: 'pending' })] });
    expect(statusRefusal(l, 'loaded', { bypassPaperwork: false }, dispatcher)?.message).toContain('bill of lading');
    expect(statusRefusal(l, 'loaded', { bypassPaperwork: true }, dispatcher)?.code).toBe('forbidden');
    expect(statusRefusal(l, 'loaded', { bypassPaperwork: true }, lead)?.code).toBe('invalid');
    expect(statusRefusal(l, 'loaded', { bypassPaperwork: true, reason: 'BOL photographed, filing it now' }, lead)).toBeNull();
  });

  it('needs a driver and a truck before dispatch', () => {
    const l = load({ status: 'assigned', driverId: null });
    expect(statusRefusal(l, 'dispatched', { bypassPaperwork: false }, dispatcher)?.message).toContain('driver');
  });

  it('leaves the stops and the exception alone when the status moves', () => {
    const l = load({ status: 'in_transit', stops: [stop({ id: 'p1', kind: 'pickup', status: 'completed' }), stop({ status: 'pending' })] });
    const patch = statusPatch(l, { status: 'at_delivery', bypassPaperwork: false }, dispatcher, NOW);
    expect(patch.status).toBe('at_delivery');
    expect(patch).not.toHaveProperty('stops');
    expect(patch.event.title).toBe('in transit → at delivery');
  });
});

describe('one stop at a time', () => {
  it('refuses a time taken in the wrong zone', () => {
    const out = stopEventPatch(load(), { stopId: 's1', kind: 'departed', at: NOW, zone: 'America/New_York' }, dispatcher, NOW);
    expect('refusal' in out && out.refusal.message).toContain('America/Chicago');
  });

  it('refuses a stop that has no zone at all, and says what to do', () => {
    const l = load({ stops: [stop({ id: 's1', timezone: '' })] });
    const out = stopEventPatch(l, { stopId: 's1', kind: 'arrived', at: NOW, zone: 'America/Chicago' }, dispatcher, NOW);
    expect('refusal' in out && out.refusal.message).toContain('city and state');
  });

  it('refuses a time in the future and a departure before its arrival', () => {
    const future = stopEventPatch(load(), { stopId: 's1', kind: 'arrived', at: '2026-09-25T00:00:00.000Z', zone: 'America/Chicago' }, dispatcher, NOW);
    expect('refusal' in future).toBe(true);
    const early = stopEventPatch(load(), { stopId: 's1', kind: 'departed', at: '2026-09-24T15:00:00.000Z', zone: 'America/Chicago' }, dispatcher, NOW);
    expect('refusal' in early && early.refusal.message).toContain('before the arrival');
  });

  it('completes only the stop it names, and does not finish a multi-stop load', () => {
    const l = load({
      status: 'in_transit',
      stops: [
        stop({ id: 'p1', kind: 'pickup', status: 'completed' }),
        stop({ id: 'd1', sequence: 1, status: 'in_progress' }),
        stop({ id: 'd2', sequence: 2, status: 'pending', arrivedAt: null }),
      ],
      documents: [doc('rate_confirmation'), doc('bol'), doc('pod')],
    });
    const out = stopEventPatch(l, { stopId: 'd1', kind: 'departed', at: NOW, zone: 'America/Chicago' }, dispatcher, NOW);
    expect('patch' in out).toBe(true);
    if ('patch' in out) {
      expect(out.patch.stopId).toBe('d1');
      expect(out.patch.completesLoad).toBe(false);
      // Leaving a delivery with another still open: the load is running again (rule 1.5).
      expect(out.patch.status).toBe('in_transit');
      expect(out.patch.deliveredAt).toBeUndefined();
    }
  });

  it('finishes the load when the last delivery closes and the POD is filed', () => {
    const l = load({
      stops: [stop({ id: 'p1', kind: 'pickup', status: 'completed' }), stop({ id: 'd1', status: 'in_progress' })],
      documents: [doc('rate_confirmation'), doc('bol'), doc('pod')],
    });
    const out = stopEventPatch(l, { stopId: 'd1', kind: 'departed', at: NOW, zone: 'America/Chicago' }, dispatcher, NOW);
    if ('patch' in out) {
      expect(out.patch.completesLoad).toBe(true);
      expect(out.patch.status).toBe('delivered');
      expect(out.patch.deliveredAt).toBe(NOW);
    } else {
      throw new Error('expected a patch');
    }
  });

  it('delivers the load on the last departure even with no POD, and records the real instant', () => {
    const l = load({ stops: [stop({ id: 'p1', kind: 'pickup', status: 'completed' }), stop({ id: 'd1', status: 'in_progress' })] });
    const out = stopEventPatch(l, { stopId: 'd1', kind: 'departed', at: NOW, zone: 'America/Chicago' }, dispatcher, NOW);
    if ('patch' in out) {
      expect(out.patch.completesLoad).toBe(true);
      expect(out.patch.status).toBe('delivered');
      // The departure's own instant, not the moment it was typed and not a made-up time.
      expect(out.patch.deliveredAt).toBe(NOW);
      expect(out.patch.stopPatch.status).toBe('completed');
    }
  });

  it('drafts detention past the free time, from the later of arrival and appointment (rule 1.8)', () => {
    // Appointment 16:00Z; arrived 15:30Z (early, earns nothing); left 19:15Z: 195 min on the clock, 120 free = 75.
    const l = load({ stops: [stop({ id: 'd1', status: 'in_progress', arrivedAt: '2026-09-24T15:30:00.000Z' })] });
    const out = stopEventPatch(l, { stopId: 'd1', kind: 'departed', at: '2026-09-24T19:15:00.000Z', zone: 'America/Chicago' }, dispatcher, '2026-09-24T20:00:00.000Z');
    expect('patch' in out).toBe(true);
    if ('patch' in out) {
      expect(out.patch.stopPatch.detentionMinutes).toBe(75);
      expect(out.patch.detentionCharge?.amount).toBe(62.5);
      expect(out.patch.detentionCharge?.description).toContain('75 min');
    }
  });

  it("respects the stop's own free time and drafts nothing inside it", () => {
    const l = load({ stops: [stop({ id: 'd1', status: 'in_progress', arrivedAt: '2026-09-24T14:00:00.000Z', freeTimeMinutes: 240 })] });
    const out = stopEventPatch(l, { stopId: 'd1', kind: 'departed', at: '2026-09-24T17:15:00.000Z', zone: 'America/Chicago' }, dispatcher, '2026-09-24T20:00:00.000Z');
    if ('patch' in out) {
      expect(out.patch.stopPatch.detentionMinutes).toBeUndefined();
      expect(out.patch.detentionCharge).toBeUndefined();
    }
  });

  it('knows when every delivery is done', () => {
    expect(allDeliveriesComplete(load())).toBe(false);
    expect(allDeliveriesComplete(load({ stops: [stop({ status: 'completed' })] }))).toBe(true);
  });
});

describe('assignment', () => {
  it('makes a booked load assigned once it has both a driver and a truck', () => {
    const l = load({ status: 'booked', driverId: null, truckId: null });
    const out = assignmentPatch(l, { driverId: 'drv_9', driverName: 'Victor Young', truckId: 'trk_9', truckUnit: '2757' }, dispatcher, NOW);
    if ('patch' in out) {
      expect(out.patch.status).toBe('assigned');
      expect(out.patch.event.title).toContain('Victor Young');
    }
  });

  it('never dispatches by itself', () => {
    const l = load({ status: 'assigned' });
    const out = assignmentPatch(l, { driverId: 'drv_9', driverName: 'Victor Young' }, dispatcher, NOW);
    if ('patch' in out) expect(out.patch.status).toBeNull();
  });

  it('refuses to strip the driver off a delivered load', () => {
    const out = assignmentPatch(load({ status: 'delivered' }), { driverId: null }, dispatcher, NOW);
    expect('refusal' in out).toBe(true);
  });
});

describe('correcting an entry', () => {
  const recent = '2026-09-24T17:30:00.000Z';
  const old = '2026-09-24T12:00:00.000Z';

  it('lets a person correct their own entry inside the window', () => {
    expect(correctionRefusal({ enteredAt: recent, enteredBy: 'Elena Vasquez', reversesDelivery: false }, dispatcher, NOW)).toBeNull();
  });

  it('takes a lead after the window', () => {
    expect(correctionRefusal({ enteredAt: old, enteredBy: 'Elena Vasquez', reversesDelivery: false }, dispatcher, NOW)?.code).toBe('forbidden');
    expect(correctionRefusal({ enteredAt: old, enteredBy: 'Elena Vasquez', reversesDelivery: false }, lead, NOW)).toBeNull();
  });

  it("takes a lead for somebody else's entry", () => {
    expect(correctionRefusal({ enteredAt: recent, enteredBy: 'Sarah Chen', reversesDelivery: false }, dispatcher, NOW)?.message).toContain('Sarah Chen');
  });

  it('takes a lead to reverse a delivery, however recent', () => {
    expect(correctionRefusal({ enteredAt: recent, enteredBy: 'Elena Vasquez', reversesDelivery: true }, dispatcher, NOW)?.code).toBe('forbidden');
  });

  it('honours a different window when one is configured', () => {
    expect(correctionRefusal({ enteredAt: old, enteredBy: 'Elena Vasquez', reversesDelivery: false }, dispatcher, NOW, 24 * 60)).toBeNull();
  });
});

describe('paperwork', () => {
  it('names what is missing for the next status', () => {
    expect(missingDocumentsFor(load({ documents: [] }), 'loaded')).toEqual(['rate_confirmation', 'bol']);
    expect(missingDocumentsFor(load(), 'delivered')).toEqual(['pod']);
  });

  it('does not count a placeholder as a document', () => {
    const placeholder: DocumentLike = { ...doc('pod'), status: 'missing', review: undefined, fileName: '' };
    expect(missingDocumentsFor(load({ documents: [placeholder] }), 'delivered')).toContain('pod');
  });
});
