import { describe, expect, it } from 'vitest';
import { driverMessageFromRc } from './driver-message.js';
import type { RateConfirmationExtract } from './rate-confirmation.js';
import {
  applyChooseRoute,
  applyClearRoute,
  normalizeTollGuruRoutes,
  routeLine,
  stopRouteAddress,
  withRouteLine,
  type RouteOption,
  type TollGuruResponse,
} from './route-options.js';
import type { StoredLoad } from './write-rules.js';

const settings = { fuelPricePerGallon: 4, mpg: 6.5 };

const tollguru: TollGuruResponse = {
  status: 'OK',
  routes: [
    {
      summary: { name: 'I-65 S', distance: { text: '718 mi', metric: '1,155 km', value: 1155500 }, duration: { text: '11 h 5 min', value: 39900 }, hasTolls: true, url: 'https://maps.example/a' },
      costs: { tag: 24.5, cash: 31, fuel: 440 },
    },
    {
      summary: { name: 'I-57 S; I-24 E', distance: { text: '702 mi', value: 1129700 }, duration: { text: '11 h 30 min', value: 41400 }, hasTolls: false, url: null },
      costs: { tag: null, cash: null, fuel: 430 },
    },
    {
      summary: { name: 'I-55 S', distance: { text: '760 mi', value: 1223000 }, duration: { text: '10 h 50 min', value: 39000 }, hasTolls: true },
      costs: { tag: 80, cash: 95, fuel: 470 },
    },
    {
      summary: { name: 'US-41 S', distance: { text: '800 mi' }, duration: { text: '13 h' }, hasTolls: false },
      costs: { fuel: 600 },
    },
  ],
};

describe('TollGuru route options', () => {
  it('keeps three, sorted by tolls + fuel, and marks the cheapest, the fastest and the least fuel', () => {
    const options = normalizeTollGuruRoutes(tollguru, settings);
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.via)).toEqual(['I-57 S; I-24 E', 'I-65 S', 'I-55 S']);
    expect(options.map((o) => o.totalCost)).toEqual([430, 464.5, 550]);
    expect(options[0]).toMatchObject({ label: 'Cheapest', miles: 702, durationMinutes: 690, tollCost: 0, fuelCost: 430, hasTolls: false, mapUrl: null });
    expect(options[0]!.tags).toEqual(expect.arrayContaining(['cheapest', 'least_fuel', 'shortest']));
    expect(options[1]).toMatchObject({ label: 'I-65 S', tollCost: 24.5, cashTollCost: 31, mapUrl: 'https://maps.example/a' });
    expect(options[2]).toMatchObject({ label: 'Fastest', tags: ['fastest'] });
  });

  it('works the fuel out from the miles, mpg and price when TollGuru gives none', () => {
    const [only] = normalizeTollGuruRoutes({ routes: [{ summary: { name: 'US-41 S', distance: { text: '800 mi' }, duration: { text: '13 h' } }, costs: {} }] }, settings);
    expect(only).toMatchObject({ miles: 800, durationMinutes: 780, fuelCost: Math.round((800 / 6.5) * 4 * 100) / 100 });
  });

  it('gives the same road the same id when it is asked again', () => {
    const a = normalizeTollGuruRoutes(tollguru, settings).map((o) => o.id);
    const b = normalizeTollGuruRoutes(tollguru, settings).map((o) => o.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(3);
  });

  it('an empty answer is no options', () => {
    expect(normalizeTollGuruRoutes({ routes: [] }, settings)).toEqual([]);
  });

  it('routes a stop to its street, city, state and ZIP', () => {
    expect(stopRouteAddress({ address: '1 Main St', city: 'Chicago', state: 'IL', zip: '60601' })).toBe('1 Main St, Chicago, IL 60601');
    expect(stopRouteAddress({ city: 'Atlanta', state: 'GA' })).toBe('Atlanta, GA');
  });
});

describe('the chosen route on the load', () => {
  const load = { id: 'ld_1', loadNumber: 'L-1', status: 'booked', updatedAt: '2026-10-27T10:00:00.000Z', timeline: [], stops: [] } as unknown as StoredLoad;
  const option: RouteOption = normalizeTollGuruRoutes(tollguru, settings)[1]!;
  const used = { ...settings, fuelPricePerGallon: 4, grossWeightLbs: 80000, axles: 5 };

  it('stores the route with who chose it and a timeline entry', () => {
    const out = applyChooseRoute(load, { expectedUpdatedAt: load.updatedAt, option, settings: used }, { id: 'u1', name: 'Dan' }, '2026-10-27T11:00:00.000Z');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record['route']).toMatchObject({ provider: 'tollguru', via: 'I-65 S', miles: 718, tollCost: 24.5, chosenByName: 'Dan', settings: used });
    expect(out.record.timeline.at(-1)).toMatchObject({ kind: 'route_chosen', title: 'Route chosen: I-65 S' });
    const cleared = applyClearRoute(out.record, { expectedUpdatedAt: out.record.updatedAt }, { id: 'u1', name: 'Dan' }, '2026-10-27T12:00:00.000Z');
    expect(cleared.ok && cleared.record['route']).toBeNull();
  });

  it('refuses a stale copy', () => {
    const out = applyChooseRoute(load, { expectedUpdatedAt: 'old', option, settings: used }, { id: 'u1', name: 'Dan' }, '2026-10-27T11:00:00.000Z');
    expect(out).toMatchObject({ ok: false, refusal: { code: 'conflict' } });
  });
});

describe('the route line in the driver message', () => {
  const rc: RateConfirmationExtract = {
    brokerName: 'Broker', brokerMc: null, brokerLoadNumber: '123456', totalRate: 3000, linehaulRate: null, commodity: null, weightLbs: null, equipment: 'dry_van', hazmat: false, temperature: null, miles: 718,
    stops: [
      { kind: 'pickup', facilityName: 'Shipper', street: null, city: 'Chicago', state: 'IL', zip: null, date: '2026-10-27', time: '08:00', endTime: null, reference: null },
      { kind: 'delivery', facilityName: 'Receiver', street: null, city: 'Atlanta', state: 'GA', zip: null, date: '2026-10-28', time: '14:00', endTime: null, reference: null },
    ],
    notes: null, warnings: [],
  };

  it('reads road, miles and tolls right after the stops block, no fuel or total', () => {
    const text = driverMessageFromRc(rc, { route: { via: 'I-65 S', miles: 718, tollCost: 24.5 } });
    expect(text).toContain('Atlanta, GA\n——————————-\nRoute: I-65 S · 718 mi · tolls $24.50\nRate: $3000');
    expect(text).not.toMatch(/fuel/i);
  });

  it('says no tolls on a free road, and is absent without a route', () => {
    expect(routeLine({ via: 'I-57 S', miles: 702, tollCost: 0 })).toBe('Route: I-57 S · 702 mi · no tolls');
    expect(driverMessageFromRc(rc)).not.toContain('Route:');
  });

  it('goes into a message the dispatcher already edited, replacing the old line', () => {
    const edited = `${driverMessageFromRc(rc)}\ntrailer 5301`;
    const once = withRouteLine(edited, 'Route: I-65 S · 718 mi · tolls $24.50');
    expect(once).toContain('——————————-\nRoute: I-65 S · 718 mi · tolls $24.50\nRate:');
    expect(once).toContain('trailer 5301');
    const twice = withRouteLine(once, 'Route: I-57 S · 702 mi · no tolls');
    expect(twice.match(/Route:/g)).toHaveLength(1);
    expect(twice).toContain('Route: I-57 S · 702 mi · no tolls');
    expect(withRouteLine(twice, null)).not.toContain('Route:');
  });
});
