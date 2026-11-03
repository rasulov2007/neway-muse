import { describe, expect, it } from 'vitest';
import type { RateConfirmationExtract, RcStop } from '@neway/shared';
import { matchBroker, rcToForm } from './rc-reader';

const stop = (over: Partial<RcStop>): RcStop => ({
  kind: 'pickup',
  facilityName: null,
  street: null,
  city: null,
  state: null,
  zip: null,
  date: null,
  time: null,
  endTime: null,
  reference: null,
  ...over,
});

const rc = (over: Partial<RateConfirmationExtract> = {}): RateConfirmationExtract => ({
  brokerName: 'TQL Logistics, LLC',
  brokerMc: 'MC-411443',
  brokerLoadNumber: '38127764',
  totalRate: 2450,
  linehaulRate: 2200,
  commodity: 'Paper products',
  weightLbs: 38000,
  equipment: 'dry_van',
  hazmat: false,
  temperature: null,
  miles: 712,
  stops: [
    stop({ kind: 'pickup', facilityName: 'IP Mill', street: '100 Mill Rd', city: 'Augusta', state: 'GA', zip: '30901', date: '2026-10-01', time: '08:00', endTime: '14:00', reference: 'PU 5521' }),
    stop({ kind: 'delivery', facilityName: 'Kroger DC', city: 'Columbus', state: 'OH', zip: '43207', date: '2026-10-02', time: '06:00' }),
  ],
  notes: 'Macropoint tracking required.',
  warnings: [],
  ...over,
});

const brokers = [
  { id: 'b1', name: 'Total Quality Logistics', mcNumber: '411443' },
  { id: 'b2', name: 'Coyote Logistics', mcNumber: '561135' },
];

describe('reading an RC into the Add load form', () => {
  it('matches the broker by MC before name', () => {
    expect(matchBroker(rc(), brokers)?.id).toBe('b1');
  });

  it('matches by name when the MC is missing', () => {
    expect(matchBroker(rc({ brokerName: 'Coyote Logistics LLC', brokerMc: null }), brokers)?.id).toBe('b2');
  });

  it('fills the reference, rate, freight and the first pickup / last delivery', () => {
    const { values, unknownBroker, warnings } = rcToForm(rc(), brokers);
    expect(unknownBroker).toBeNull();
    expect(values).toMatchObject({
      brokerId: 'b1',
      brokerReference: '38127764',
      rate: 2450,
      weightLbs: 38000,
      equipmentType: 'dry_van',
      originStreet: '100 Mill Rd',
      originFacility: 'IP Mill',
      originCity: 'Augusta',
      originState: 'GA',
      pickupAt: '2026-10-01T08:00',
      pickupEndAt: '2026-10-01T14:00',
      destinationCity: 'Columbus',
      deliveryAt: '2026-10-02T06:00',
      deliveryEndAt: '',
      extraStops: [],
    });
    expect(values.notes).toContain('PU Augusta: PU 5521');
    expect(values.notes).toContain('Macropoint');
    expect(warnings).toEqual([]);
  });

  it('puts the stops in between into extra stops', () => {
    const three = rc();
    three.stops.splice(1, 0, stop({ kind: 'delivery', city: 'Knoxville', state: 'TN', date: '2026-10-01', time: '20:00' }));
    expect(rcToForm(three, brokers).values.extraStops).toMatchObject([{ kind: 'delivery', city: 'Knoxville', at: '2026-10-01T20:00' }]);
  });

  it('leaves a time the RC does not give empty, and says so', () => {
    const fcfs = rc();
    fcfs.stops[1] = stop({ kind: 'delivery', facilityName: 'Kroger DC', city: 'Columbus', date: '2026-10-02', time: null });
    const { values, warnings } = rcToForm(fcfs, brokers);
    expect(values.deliveryAt).toBe('');
    expect(warnings.join(' ')).toContain('Kroger DC');
  });

  /*
   * EVE International PRO 1115971 (owner's real RC, 2026-09-30), as the reader should return it:
   * no broker MC printed (990001 is the carrier's own), weight printed as 1, delivery hours are
   * the dock's hours, not a window.
   */
  it('fills the owner’s EVE International RC', () => {
    const eve: RateConfirmationExtract = {
      brokerName: 'EVE INTERNATIONAL LOGISTICS INC',
      brokerMc: null,
      brokerLoadNumber: '1115971',
      totalRate: 2150,
      linehaulRate: 2150,
      commodity: 'US MAIL',
      weightLbs: 1,
      equipment: 'dry_van',
      hazmat: null,
      temperature: null,
      miles: 521,
      stops: [
        stop({ kind: 'pickup', facilityName: 'LOG QUEENS', street: '14202 20TH AVE RM 3166', city: 'FLUSHING', state: 'NY', zip: '11351', date: '2026-10-03', time: '02:45', reference: 'FA2A1 TRIP:2003' }),
        stop({ kind: 'delivery', facilityName: 'GREENSBORO NDC', street: '3701 W WENDOVER AVE', city: 'GREENSBORO', state: 'NC', zip: '27495', date: '2026-10-03', time: '15:00' }),
      ],
      notes: 'Signed postal form 5398 or 5397 required; HCR and trip # must match or no payment. MacroPoint required ($300 if off). Late/missed appointment $500/day. FCFS: no detention. Driver needs safety vest, 12 ratchet straps, E-tracks, padlock; may have to assist unloading (unpaid). Send POD to operations@eveinternational.org.',
      warnings: ['The RC prints the weight as 1; the real weight is not given.'],
    };
    const { values, unknownBroker, warnings } = rcToForm(eve, [...brokers, { id: 'b3', name: 'Eve International Logistics Inc.', mcNumber: null }]);
    expect(unknownBroker).toBeNull();
    expect(values).toMatchObject({
      brokerId: 'b3',
      brokerReference: '1115971',
      rate: 2150,
      commodity: 'US MAIL',
      equipmentType: 'dry_van',
      originStreet: '14202 20TH AVE RM 3166',
      originFacility: 'LOG QUEENS',
      originCity: 'FLUSHING',
      originState: 'NY',
      originZip: '11351',
      pickupAt: '2026-10-03T02:45',
      destinationStreet: '3701 W WENDOVER AVE',
      destinationFacility: 'GREENSBORO NDC',
      destinationState: 'NC',
      deliveryAt: '2026-10-03T15:00',
      extraStops: [],
    });
    expect(values.weightLbs).toBeUndefined();
    expect(warnings.join(' ')).toContain('weight');
    expect(values.notes).toContain('PU FLUSHING: FA2A1 TRIP:2003');
    expect(values.notes!.length).toBeLessThanOrEqual(500);
  });

  it('fills the loaded miles the RC prints, and leaves them out when it prints none', () => {
    expect(rcToForm(rc({ miles: 712.4 }), brokers).values.loadedMiles).toBe(712);
    expect(rcToForm(rc({ miles: null }), brokers).values.loadedMiles).toBeUndefined();
    expect(rcToForm(rc({ miles: 0 }), brokers).values.loadedMiles).toBeUndefined();
  });

  it('names a broker that is not on the list instead of guessing one', () => {
    const { values, unknownBroker } = rcToForm(rc({ brokerName: 'New Freight Inc', brokerMc: '999' }), brokers);
    expect(values.brokerId).toBeUndefined();
    expect(unknownBroker).toEqual({ name: 'New Freight Inc', mc: '999' });
  });
});
