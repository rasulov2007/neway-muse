import { describe, expect, it } from 'vitest';
import {
  applyAddNote,
  applyCancel,
  applyConfirmUpload,
  applyPinNote,
  applyReview,
  cancelPatch,
  cancelRefusal,
  cancelRequires,
  confirmationPatch,
  diffLoad,
  duplicateWarning,
  formatAppointment,
  formatInstant,
  instantFromLocal,
  LOADS_SCHEMA_VERSION,
  localParts,
  looksLikeRawIso,
  migrateLoad,
  migrateLoads,
  orderNotes,
  planRoute,
  resolveStopZone,
  reviewLabel,
  suggestionForUpload,
  timeInZone,
  zoneOfCity,
  zoneOfZip,
  type LoadLike,
  type StopLike,
  type StoredLoad,
} from './index.js';

const NOW = '2026-09-18T14:00:00.000Z';

function stop(over: Partial<StopLike> & { id: string; kind: 'pickup' | 'delivery' }): StopLike {
  return {
    sequence: 1,
    facilityId: '',
    facilityName: `${over.id} facility`,
    city: 'Chicago',
    state: 'IL',
    timezone: 'America/Chicago',
    appointmentStartAt: '2026-09-18T13:00:00.000Z',
    appointmentEndAt: '2026-09-18T15:00:00.000Z',
    status: 'pending',
    arrivedAt: null,
    departedAt: null,
    ...over,
  };
}

function load(over: Partial<StoredLoad> = {}): StoredLoad {
  return {
    id: 'ld_1',
    loadNumber: 'L-100001',
    status: 'assigned',
    schemaVersion: 2,
    dispatcherId: 'u_1',
    dispatcherName: 'Dana',
    driverId: 'd_1',
    driverName: 'Ray Ortiz',
    truckId: 't_1',
    truckUnit: '0017',
    trailerId: 'tr_1',
    trailerUnit: 'T-201',
    stops: [
      stop({ id: 's1', kind: 'pickup', sequence: 1 }),
      stop({ id: 's2', kind: 'delivery', sequence: 2, city: 'Atlanta', state: 'GA', timezone: 'America/New_York' }),
    ],
    documents: [],
    notes: [],
    timeline: [],
    dispatchedAt: null,
    deliveredAt: null,
    updatedAt: '2026-09-18T12:00:00.000Z',
    charges: [{ id: 'chg_1', type: 'linehaul', description: 'Linehaul', amount: 1800, billable: true, payableToDriver: false }],
    exception: null,
    ...over,
  };
}

const lead = { id: 'u_lead', name: 'Lena Lead', isLead: true };
const dispatcher = { id: 'u_2', name: 'Dan Dispatcher', isLead: false };

describe('cancel (P0.1)', () => {
  it('anyone on dispatch may cancel before the driver is dispatched', () => {
    expect(cancelRequires('booked')).toBe('any');
    expect(cancelRequires('assigned')).toBe('any');
  });

  it('after dispatch it takes the lead, and past the pickup nobody', () => {
    expect(cancelRequires('dispatched')).toBe('lead');
    expect(cancelRequires('at_pickup')).toBe('lead');
    for (const status of ['loading', 'loaded', 'in_transit', 'at_delivery', 'delivered', 'closed', 'cancelled', 'tonu'] as const) {
      expect(cancelRequires(status)).toBe('forbidden');
    }
  });

  it('refuses a dispatcher after dispatch and lets the lead through', () => {
    const l = load({ status: 'dispatched' });
    expect(cancelRefusal(l, { outcome: 'cancelled' }, dispatcher)?.code).toBe('lead');
    expect(cancelRefusal(l, { outcome: 'cancelled' }, lead)).toBeNull();
  });

  it('a TONU needs a fee, even $0', () => {
    const l = load();
    expect(cancelRefusal(l, { outcome: 'tonu' }, dispatcher)?.code).toBe('fee');
    expect(cancelRefusal(l, { outcome: 'tonu', fee: 0 }, dispatcher)).toBeNull();
  });

  it('frees the driver, truck and trailer and leaves the TONU fee as the only charge', () => {
    const patch = cancelPatch({ outcome: 'tonu', reason: 'Shipper not ready', requestedBy: 'TQL', approval: { by: 'Broker desk', method: 'email' as const, reference: 'RC-1', at: NOW }, fee: 250 }, lead, NOW, 'chg_x');
    expect(patch.status).toBe('tonu');
    expect(patch.driverId).toBeNull();
    expect(patch.truckId).toBeNull();
    expect(patch.trailerId).toBeNull();
    expect(patch.charges).toEqual([
      expect.objectContaining({ type: 'tonu', amount: 250, billable: true }),
    ]);
    expect(patch.cancellation).toMatchObject({ outcome: 'tonu', fee: 250, byName: 'Lena Lead', at: NOW });
  });

  it('applyCancel writes the status, the cancellation and one timeline line', () => {
    const result = applyCancel(load(), { outcome: 'cancelled', reason: 'Broker pulled it', requestedBy: 'CH Robinson', approval: { by: 'Broker desk', method: 'email' as const, reference: 'RC-1', at: NOW }, expectedUpdatedAt: '2026-09-18T12:00:00.000Z' }, dispatcher, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('cancelled');
    expect(result.record.charges).toEqual([]);
    expect(result.record.driverName).toBeNull();
    expect(result.record.timeline).toHaveLength(1);
    expect(result.record.timeline[0]).toMatchObject({ kind: 'cancelled', title: 'Cancelled', actorName: 'Dan Dispatcher' });
    expect(result.record.timeline[0]!.detail).toContain('Released driver Ray Ortiz, unit 0017, trailer T-201');
    expect(result.record.updatedAt).toBe(NOW);
  });

  it('a stale expectedUpdatedAt is a conflict, never a merge', () => {
    const result = applyCancel(load(), { outcome: 'cancelled', reason: 'Broker pulled it', requestedBy: 'x', approval: { by: 'Broker desk', method: 'email' as const, reference: 'RC-1', at: NOW }, expectedUpdatedAt: '2026-09-18T11:00:00.000Z' }, lead, NOW);
    expect(result).toMatchObject({ ok: false, refusal: { code: 'conflict' } });
  });

  it('a dispatcher cancelling after dispatch is forbidden on the server too', () => {
    const result = applyCancel(load({ status: 'dispatched' }), { outcome: 'cancelled', reason: 'Broker pulled it', requestedBy: 'x', approval: { by: 'Broker desk', method: 'email' as const, reference: 'RC-1', at: NOW }, expectedUpdatedAt: '2026-09-18T12:00:00.000Z' }, dispatcher, NOW);
    expect(result).toMatchObject({ ok: false, refusal: { code: 'forbidden' } });
  });
});

describe('notes (P0.1)', () => {
  it('a note carries the signed-in author and the server time, and pins to the top', () => {
    const added = applyAddNote(load(), { kind: 'internal', body: 'Call the shipper at 7', pinned: true, expectedUpdatedAt: '2026-09-18T12:00:00.000Z' }, dispatcher, NOW);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.record.notes[0]).toMatchObject({ authorId: 'u_2', authorName: 'Dan Dispatcher', at: NOW, pinned: true });
    expect(added.record.timeline[0]).toMatchObject({ kind: 'note_added', title: 'Note pinned', detail: 'Call the shipper at 7' });
    const older = { id: 'n0', kind: 'internal' as const, body: 'older', authorName: 'x', at: '2026-09-18T10:00:00.000Z', pinned: false };
    expect(orderNotes([older, added.record.notes[0]!]).map((n) => n.id)).toEqual([added.record.notes[0]!.id, 'n0']);
  });

  it('unpinning is a write with its own line; the same state twice is a no-op', () => {
    const base = load({ notes: [{ id: 'n1', kind: 'internal', body: 'x', authorName: 'a', at: NOW, pinned: true }] });
    const same = applyPinNote(base, { noteId: 'n1', pinned: true, expectedUpdatedAt: base.updatedAt }, dispatcher, NOW);
    expect(same.ok && same.event).toBeNull();
    const off = applyPinNote(base, { noteId: 'n1', pinned: false, expectedUpdatedAt: base.updatedAt }, dispatcher, NOW);
    expect(off.ok && off.record.notes[0]?.pinned).toBe(false);
    expect(off.ok && off.event?.title).toBe('Note unpinned');
  });
});

describe('stop zones (P0.4)', () => {
  it('ZIP first: a Pensacola ZIP is Central even though Florida is Eastern', () => {
    expect(zoneOfZip('32501')).toBe('America/Chicago');
    expect(zoneOfZip('33101')).toBe('America/New_York');
    expect(zoneOfZip('79901')).toBe('America/Denver');
    expect(zoneOfZip('60607-1234')).toBe('America/Chicago');
    expect(zoneOfZip('85001')).toBe('America/Phoenix');
    expect(zoneOfZip('not a zip')).toBeNull();
  });

  it('then city and state, with the split states handled', () => {
    expect(zoneOfCity('El Paso', 'TX')).toBe('America/Denver');
    expect(zoneOfCity('Dallas', 'tx')).toBe('America/Chicago');
    expect(zoneOfCity('Knoxville', 'TN')).toBe('America/New_York');
    expect(zoneOfCity('Nashville', 'TN')).toBe('America/Chicago');
    expect(zoneOfCity("Coeur d'Alene", 'ID')).toBe('America/Los_Angeles');
    expect(zoneOfCity('Boise', 'ID')).toBe('America/Denver');
    expect(zoneOfCity('Anywhere', 'ZZ')).toBeNull();
  });

  it('resolveStopZone says where the answer came from, and admits when there is none', () => {
    expect(resolveStopZone({ zip: '30301', city: 'Atlanta', state: 'GA' })).toEqual({ zone: 'America/New_York', source: 'zip' });
    expect(resolveStopZone({ city: 'Evansville', state: 'IN' })).toEqual({ zone: 'America/Chicago', source: 'city' });
    expect(resolveStopZone({ city: 'Indianapolis', state: 'IN' })).toEqual({ zone: 'America/New_York', source: 'state' });
    expect(resolveStopZone({ city: 'Toronto', state: 'ON' })).toEqual({ zone: null, source: 'unknown' });
  });
});

describe('the one formatter (P0.4)', () => {
  it('shows the stop clock with its zone and never a raw ISO', () => {
    expect(timeInZone('2026-09-18T06:25:00.000Z', 'America/New_York')).toBe('2:25 AM EDT');
    expect(timeInZone('2026-01-18T06:25:00.000Z', 'America/New_York')).toBe('1:25 AM EST');
    const f = formatInstant('2026-09-18T06:25:00.000Z', 'America/New_York');
    expect(f.text).toBe('Sep 18, 2:25 AM EDT');
    // Eastern is what is printed; a stop on another clock is on the hover, labelled as the stop's.
    expect(f.tooltip).toContain('2:25 AM EDT - Eastern');
    expect(formatInstant('2026-09-18T06:25:00.000Z', 'America/Chicago').tooltip).toContain('1:25 AM CDT - stop local');
    expect(f.tooltip).toContain('11:25 AM GMT+5 - Tashkent');
    expect(looksLikeRawIso(f.text)).toBe(false);
    expect(looksLikeRawIso(f.tooltip)).toBe(false);
  });

  it('says when the zone is unknown instead of guessing', () => {
    expect(timeInZone('2026-09-18T06:25:00.000Z', '')).toBe('6:25 AM UTC · zone unknown');
    expect(timeInZone(null, 'America/Chicago')).toBe('Time unknown');
  });

  it('formats a window, a single time, and no appointment', () => {
    expect(formatAppointment({ appointmentStartAt: '2026-09-18T12:00:00.000Z', appointmentEndAt: '2026-09-18T14:00:00.000Z', timezone: 'America/New_York' })).toBe('Sep 18, 8:00 AM – 10:00 AM EDT');
    expect(formatAppointment({ appointmentStartAt: '2026-09-18T12:00:00.000Z', appointmentEndAt: '2026-09-18T12:00:00.000Z', timezone: 'America/New_York' })).toBe('Sep 18, 8:00 AM EDT (no window)');
    expect(formatAppointment({ appointmentStartAt: '2026-09-18T12:00:00.000Z', appointmentEndAt: '2026-09-18T14:00:00.000Z', appointmentNoWindow: true, timezone: 'America/New_York' })).toBe('Sep 18, 8:00 AM EDT (no window)');
    expect(formatAppointment({ appointmentStartAt: null, appointmentEndAt: null, timezone: 'America/New_York' })).toBe('Appointment not set');
  });

  it('round-trips a wall clock through a zone, across the DST change', () => {
    expect(localParts('2026-09-18T06:25:00.000Z', 'America/New_York')).toEqual({ date: '2026-09-18', time: '02:25' });
    expect(instantFromLocal('2026-09-18', '02:25', 'America/New_York')).toBe('2026-09-18T06:25:00.000Z');
    expect(instantFromLocal('2026-11-01', '03:30', 'America/Chicago')).toBe('2026-11-01T09:30:00.000Z');
    expect(instantFromLocal('2026-03-08', '03:30', 'America/Chicago')).toBe('2026-03-08T08:30:00.000Z');
    expect(instantFromLocal('2026-09-18', '02:25', '')).toBeNull();
  });
});

describe('editing the route (P0.2)', () => {
  const existing: StopLike[] = [
    stop({ id: 's1', kind: 'pickup', sequence: 1, city: 'Chicago', state: 'IL', arrivedAt: '2026-09-18T13:10:00.000Z', departedAt: '2026-09-18T14:00:00.000Z', status: 'completed' }),
    stop({ id: 's2', kind: 'delivery', sequence: 2, city: 'Atlanta', state: 'GA', timezone: 'America/New_York' }),
  ];
  const opts = { newId: (i: number) => `new_${i}`, make: (base: StopLike) => base };

  it('the same route back is not a change', () => {
    const plan = planRoute(existing, existing.map((s) => ({ kind: s.kind, city: s.city, state: s.state, at: s.appointmentStartAt, endAt: s.appointmentEndAt, facilityName: s.facilityName })), opts);
    expect(plan.changed).toBe(false);
    expect(plan.losses).toEqual([]);
    expect(plan.stops[0]).toMatchObject({ id: 's1', arrivedAt: '2026-09-18T13:10:00.000Z', timezone: 'America/Chicago' });
  });

  it('a city change gets the new place its own zone, never the old one', () => {
    const plan = planRoute(existing, [
      { kind: 'pickup', city: 'Chicago', state: 'IL', at: existing[0]!.appointmentStartAt },
      { kind: 'delivery', city: 'El Paso', state: 'TX', at: existing[1]!.appointmentStartAt },
    ], opts);
    expect(plan.stops[1]?.timezone).toBe('America/Denver');
    expect(plan.stops[1]?.id).toBe('s2');
    expect(plan.changed).toBe(true);
  });

  it('a stop with an arrival keeps it until the person confirms', () => {
    const edits = [
      { kind: 'pickup' as const, city: 'Joliet', state: 'IL', at: existing[0]!.appointmentStartAt },
      { kind: 'delivery' as const, city: 'Atlanta', state: 'GA', at: existing[1]!.appointmentStartAt },
    ];
    const asked = planRoute(existing, edits, opts);
    expect(asked.losses).toEqual([expect.objectContaining({ stopId: 's1', from: 'Chicago, IL', to: 'Joliet, IL' })]);
    expect(asked.stops[0]).toMatchObject({ arrivedAt: '2026-09-18T13:10:00.000Z', status: 'completed' });
    const confirmed = planRoute(existing, edits, { ...opts, confirmClearEvents: true });
    expect(confirmed.stops[0]).toMatchObject({ arrivedAt: null, departedAt: null, status: 'pending', city: 'Joliet' });
  });

  it('an unknown place is left with no zone and listed, not defaulted', () => {
    const plan = planRoute(existing, [
      { kind: 'pickup', city: 'Chicago', state: 'IL', at: existing[0]!.appointmentStartAt },
      { kind: 'delivery', city: 'Winnipeg', state: 'MB', at: existing[1]!.appointmentStartAt },
    ], opts);
    expect(plan.stops[1]?.timezone).toBe('');
    expect(plan.unresolved).toEqual([{ index: 1, city: 'Winnipeg', state: 'MB' }]);
  });

  it('the window keeps its length when only the start moves; one time means no window', () => {
    const plan = planRoute(existing, [
      { kind: 'pickup', city: 'Chicago', state: 'IL', at: '2026-09-19T13:00:00.000Z' },
      { kind: 'delivery', city: 'Atlanta', state: 'GA', at: '2026-09-20T13:00:00.000Z', noWindow: true },
    ], opts);
    expect(plan.stops[0]).toMatchObject({ appointmentEndAt: '2026-09-19T15:00:00.000Z', appointmentNoWindow: false });
    expect(plan.stops[1]).toMatchObject({ appointmentEndAt: '2026-09-20T13:00:00.000Z', appointmentNoWindow: true });
  });
});

describe('diffLoad (P0.2)', () => {
  it('the same record is a zero-field diff, bookkeeping aside', () => {
    const a = load();
    const b = { ...load(), updatedAt: NOW, timeline: [{ id: 'e', at: NOW, kind: 'note_added', actorType: 'user', actorName: 'x', title: 't', detail: null, stopId: null }] };
    expect(diffLoad(a, b)).toEqual([]);
  });

  it('names what moved, by path', () => {
    const a = load();
    const b = load({ dispatcherName: 'Someone Else', stops: [a.stops[0]!, { ...a.stops[1]!, city: 'Macon' }] });
    expect(diffLoad(a, b).map((c) => c.path)).toEqual(['dispatcherName', 'stops[1].city']);
  });
});

describe('uploads suggest, people confirm (P0.5)', () => {
  it('a BOL suggests loaded at the pickup arrival; a POD suggests delivered', () => {
    const l = load({ status: 'at_pickup', stops: [stop({ id: 's1', kind: 'pickup', arrivedAt: '2026-09-18T13:10:00.000Z', timezone: 'America/Chicago' }), stop({ id: 's2', kind: 'delivery', city: 'Atlanta', state: 'GA', timezone: 'America/New_York' })] });
    expect(suggestionForUpload(l, 'bol', NOW)).toMatchObject({ kind: 'mark_loaded', stopId: 's1', at: '2026-09-18T13:10:00.000Z', timeSource: 'arrival', prompt: 'Mark loaded at 8:10 AM CDT?' });
    expect(suggestionForUpload(l, 'pod', NOW)).toMatchObject({ kind: 'mark_delivered', stopId: 's2', timeSource: 'now', prompt: 'Delivered at 10:00 AM EDT?' });
    expect(suggestionForUpload(l, 'rate_confirmation', NOW)).toBeNull();
    expect(suggestionForUpload(load({ status: 'in_transit' }), 'bol', NOW)).toBeNull();
    expect(suggestionForUpload(load({ status: 'delivered' }), 'pod', NOW)).toBeNull();
  });

  it('uploading changes nothing by itself; confirming completes one stop, not every stop', () => {
    const l = load({
      status: 'in_transit',
      exception: { code: 'problem', reason: 'Late', raisedAt: NOW },
      stops: [
        stop({ id: 's1', kind: 'pickup', status: 'completed', arrivedAt: '2026-09-18T13:10:00.000Z', departedAt: '2026-09-18T14:00:00.000Z' }),
        stop({ id: 's2', kind: 'delivery', sequence: 2, city: 'Macon', state: 'GA', timezone: 'America/New_York' }),
        stop({ id: 's3', kind: 'delivery', sequence: 3, city: 'Atlanta', state: 'GA', timezone: 'America/New_York' }),
      ],
    });
    const result = applyConfirmUpload(l, { kind: 'mark_delivered', stopId: 's3', at: '2026-09-18T13:30:00.000Z', expectedUpdatedAt: l.updatedAt }, dispatcher, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Macon is still open, so the load is not delivered: it is back in transit, to stop 2 of 2.
    expect(result.record.status).toBe('in_transit');
    expect(result.record.deliveredAt).toBeNull();
    expect(result.record.stops.map((s) => s.status)).toEqual(['completed', 'pending', 'completed']);
    expect(result.record.exception).toEqual(l.exception);
    expect(result.record.dispatchedAt).toBeNull();
    expect(result.record.timeline[0]).toMatchObject({ kind: 'delivered', stopId: 's3', at: '2026-09-18T13:30:00.000Z' });
  });

  it('with two receivers, a POD speaks for the first one still open', () => {
    const l = load({
      status: 'in_transit',
      stops: [
        stop({ id: 's1', kind: 'pickup', status: 'completed' }),
        stop({ id: 's2', kind: 'delivery', sequence: 2, city: 'Louisville', state: 'KY', timezone: 'America/New_York' }),
        stop({ id: 's3', kind: 'delivery', sequence: 3, city: 'Evansville', state: 'IN', timezone: 'America/Chicago' }),
      ],
    });
    expect(suggestionForUpload(l, 'pod', NOW)).toMatchObject({ kind: 'mark_delivered', stopId: 's2' });
    const after = { ...l, stops: l.stops.map((s) => (s.id === 's2' ? { ...s, status: 'completed' as const } : s)) };
    expect(suggestionForUpload(after, 'pod', NOW)).toMatchObject({ kind: 'mark_delivered', stopId: 's3' });
  });

  it('a late BOL never drags a load in transit back to loaded', () => {
    const l = load({ status: 'in_transit', stops: [stop({ id: 's1', kind: 'pickup' }), stop({ id: 's2', kind: 'delivery', city: 'Atlanta', state: 'GA' })] });
    const outcome = confirmationPatch(l, { kind: 'mark_loaded', stopId: 's1', at: '2026-09-18T13:30:00.000Z' }, NOW);
    expect('patch' in outcome && outcome.patch.status).toBeNull();
    expect('patch' in outcome && outcome.patch.stopPatch.status).toBe('completed');
  });

  it('a time in the future or a stop of the wrong kind is refused', () => {
    const l = load({ status: 'at_pickup' });
    expect(confirmationPatch(l, { kind: 'mark_loaded', stopId: 's1', at: '2026-09-18T15:00:00.000Z' }, NOW)).toMatchObject({ refusal: { code: 'time' } });
    expect(confirmationPatch(l, { kind: 'mark_loaded', stopId: 's2', at: NOW }, NOW)).toMatchObject({ refusal: { code: 'stop' } });
  });

  it('a document is verified only by a person, with their name and time', () => {
    const doc = { id: 'doc_1', type: 'pod' as const, title: 'POD', fileName: 'pod.pdf', uploadedAt: NOW, uploadedBy: 'Ray', status: 'pending', review: 'received' as const };
    const l = load({ documents: [doc] });
    const reviewed = applyReview(l, 'doc_1', { review: 'reviewed', expectedUpdatedAt: l.updatedAt }, dispatcher, NOW);
    expect(reviewed.ok && reviewed.record.documents[0]).toMatchObject({ review: 'reviewed', reviewedBy: 'Dan Dispatcher', reviewedAt: NOW });
    const verified = reviewed.ok && applyReview(reviewed.record, 'doc_1', { review: 'verified', expectedUpdatedAt: NOW }, lead, NOW);
    expect(verified && verified.ok && verified.record.documents[0]).toMatchObject({ review: 'verified', status: 'verified', verifiedBy: 'Lena Lead', verifiedAt: NOW, reviewedBy: 'Dan Dispatcher' });
    expect(verified && verified.ok && reviewLabel(verified.record.documents[0]!)).toBe('Verified by Lena Lead');
    expect(reviewLabel({ status: 'verified' })).toBe('Verified (before names were kept)');
    const again = verified && verified.ok && applyReview(verified.record, 'doc_1', { review: 'verified', expectedUpdatedAt: NOW }, lead, NOW);
    expect(again && again.ok).toBe(false);
  });

  it('warns when the same file is filed under two types', () => {
    const existing = [{ id: 'd1', type: 'bol' as const, fileName: 'scan.pdf', fileHash: 'abc', title: 'BOL' }];
    expect(duplicateWarning(existing, { type: 'pod', fileName: 'other.pdf', fileHash: 'abc' })?.match).toBe('hash');
    expect(duplicateWarning(existing, { type: 'pod', fileName: 'SCAN.pdf' })?.match).toBe('fileName');
    expect(duplicateWarning(existing, { type: 'bol', fileName: 'scan.pdf', fileHash: 'abc' })).toBeNull();
    expect(duplicateWarning(existing, { type: 'pod', fileName: 'pod.pdf', fileHash: 'zzz' })).toBeNull();
  });
});

describe('migration v1 → v2', () => {
  const v1 = {
    id: 'ld_9',
    loadNumber: 'L-100009',
    status: 'booked',
    stops: [
      { id: 's1', sequence: 1, kind: 'pickup', city: 'Atlanta', state: 'GA', timezone: 'America/Chicago', appointmentStartAt: '2026-09-18T12:00:00.000Z', appointmentEndAt: '2026-09-18T12:00:00.000Z', status: 'pending', arrivedAt: null, departedAt: null, notes: 'keep me' },
      { id: 's2', sequence: 2, kind: 'delivery', city: 'El Paso', state: 'TX', timezone: '', appointmentStartAt: '2026-09-19T12:00:00.000Z', appointmentEndAt: '2026-09-19T14:00:00.000Z', status: 'pending', arrivedAt: null, departedAt: null },
      { id: 's3', sequence: 3, kind: 'delivery', city: 'Winnipeg', state: 'MB', timezone: '', appointmentStartAt: '2026-09-20T12:00:00.000Z', appointmentEndAt: '2026-09-20T14:00:00.000Z', status: 'pending', arrivedAt: null, departedAt: null },
      { id: 's4', sequence: 4, kind: 'delivery', city: 'Denver', state: 'CO', timezone: 'America/Los_Angeles', appointmentStartAt: '2026-09-21T12:00:00.000Z', appointmentEndAt: '2026-09-21T14:00:00.000Z', status: 'pending', arrivedAt: null, departedAt: null },
    ],
    documents: [
      { id: 'd1', type: 'bol', title: 'BOL', fileName: 'a.pdf', uploadedAt: NOW, uploadedBy: 'x', status: 'verified' },
      { id: 'd2', type: 'pod', title: 'POD', fileName: 'b.pdf', uploadedAt: NOW, uploadedBy: 'x', status: 'pending' },
    ],
    somethingElse: { kept: true },
  };

  it('backfills the zone from the place, corrects the company-clock stamp, keeps a deliberate zone, and logs each', () => {
    const log: string[] = [];
    const result = migrateLoad(v1, { strict: true, log: (e) => log.push(`${e.level}: ${e.message}`) });
    expect(result.changed).toBe(true);
    const rec = result.record as typeof v1 & { schemaVersion: number };
    expect(rec.schemaVersion).toBe(LOADS_SCHEMA_VERSION);
    expect(rec.stops.map((s) => s.timezone)).toEqual(['America/New_York', 'America/Denver', '', 'America/Los_Angeles']);
    expect(rec.stops.map((s) => (s as { appointmentNoWindow?: boolean }).appointmentNoWindow)).toEqual([true, false, false, false]);
    expect(rec.stops[0]).toMatchObject({ notes: 'keep me' });
    expect(rec.somethingElse).toEqual({ kept: true });
    expect(log).toEqual([
      'info: stop 1 (Atlanta, GA): zone corrected America/Chicago → America/New_York from state',
      'info: stop 2 (El Paso, TX): zone set to America/Denver from city',
      'warn: stop 3 (Winnipeg, MB): zone unknown - no ZIP, city or state matched',
      'warn: stop 4 (Denver, CO): keeps America/Los_Angeles; the lookup says America/Denver from state',
    ]);
    expect(rec.documents[0]).toMatchObject({ review: 'verified', verifiedBy: null });
    expect(rec.documents[1]).toMatchObject({ review: 'received' });
  });

  it('is idempotent and leaves a current record alone', () => {
    const once = migrateLoad(v1, { strict: true }).record;
    const twice = migrateLoad(once, { strict: true });
    expect(twice.changed).toBe(false);
    expect(twice.record).toBe(once);
  });

  it('throws in development on a record it cannot read, and logs it in production', () => {
    const broken = { id: 'ld_x', loadNumber: 'L-1', stops: 'nope' };
    expect(() => migrateLoad(broken, { strict: true })).toThrow(/cannot be migrated from v1: stops is not a list/);
    const result = migrateLoads([v1, broken], { strict: false });
    expect(result.changed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.rows[1]).toBe(broken);
    expect(result.log.some((e) => e.level === 'error' && e.loadNumber === 'L-1')).toBe(true);
  });
});

describe('the model', () => {
  it('a LoadLike is what the app stores, structurally', () => {
    const l: LoadLike = load();
    expect(l.stops).toHaveLength(2);
  });
});
