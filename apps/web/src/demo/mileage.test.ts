import { describe, expect, it } from 'vitest';
import { demoData } from './data';
import { deadheadMilesFor, ensureUsPlaces, lastDeliveredLoad, loadedMilesFor, milesBetween } from './mileage';

/**
 * The rule under test is not the arithmetic, it is the honesty: a figure exists only when both
 * ends of the leg are known, and a driver with no history produces no deadhead rather than a zero.
 */
describe('miles from the stops', () => {
  it('measures a lane both ways to the same distance', () => {
    const there = milesBetween({ city: 'Chicago', state: 'IL' }, { city: 'Dallas', state: 'TX' });
    const back = milesBetween({ city: 'Dallas', state: 'TX' }, { city: 'Chicago', state: 'IL' });
    expect(there).toBeGreaterThan(800);
    expect(there).toBe(back);
  });

  it('adds up a multi-stop route in order', () => {
    const direct = loadedMilesFor([
      { city: 'Chicago', state: 'IL' },
      { city: 'Dallas', state: 'TX' },
    ]);
    const viaMemphis = loadedMilesFor([
      { city: 'Chicago', state: 'IL' },
      { city: 'Memphis', state: 'TN' },
      { city: 'Dallas', state: 'TX' },
    ]);
    expect(direct.miles).not.toBeNull();
    expect(viaMemphis.miles).not.toBeNull();
    // Going via a third city is never shorter than going straight there.
    expect(viaMemphis.miles!).toBeGreaterThanOrEqual(direct.miles!);
    expect(viaMemphis.note).toContain('3 stops');
  });

  it('says what it cannot measure rather than guessing', () => {
    const unknown = loadedMilesFor([
      { city: 'Chicago', state: 'IL' },
      { city: 'Nowhereville', state: 'ZZ' },
    ]);
    expect(unknown.miles).toBeNull();
    expect(unknown.note).toContain('Nowhereville');

    const tooFew = loadedMilesFor([{ city: 'Chicago', state: 'IL' }]);
    expect(tooFew.miles).toBeNull();
  });

  it('leaves deadhead blank with a reason when there is no driver or no history', () => {
    expect(deadheadMilesFor(null, { city: 'Chicago', state: 'IL' })).toEqual({
      miles: null,
      note: expect.stringContaining('driver'),
    });

    const stranger = deadheadMilesFor('drv_not_a_real_driver', { city: 'Chicago', state: 'IL' });
    expect(stranger.miles).toBeNull();
    expect(stranger.note).toContain('No earlier load');
  });

  it('measures deadhead from the driver’s last delivery', () => {
    const delivered = demoData.loads.find(
      (load) => (load.status === 'delivered' || load.status === 'closed') && load.driverId,
    );
    expect(delivered, 'the demo book has a delivered load').toBeTruthy();

    const previous = lastDeliveredLoad(delivered!.driverId as string);
    expect(previous).toBeTruthy();

    const estimate = deadheadMilesFor(delivered!.driverId as string, {
      city: previous!.destination.city,
      state: previous!.destination.state,
    });
    // Starting where they finished is no deadhead at all.
    expect(estimate.miles).toBe(0);
    expect(estimate.note).toContain(previous!.destination.city);
  });
});

describe('real US places (owner, 2026-10-13)', () => {
  it('measures by ZIP or by city once the US places are loaded', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ zip: { '30901': [33.46, -81.97], '23803': [37.21, -77.4] }, city: { 'GREENSBORO|NC': [36.07, -79.79] } }),
    })) as unknown as typeof fetch;
    try {
      expect(await ensureUsPlaces()).toBe(true);
      const byZip = milesBetween({ city: 'Augusta', state: 'GA', zip: '30901' }, { city: 'Petersburg', state: 'VA', zip: '23803' });
      expect(byZip).toBeGreaterThan(300);
      const byCity = milesBetween({ city: 'Augusta', state: 'GA', zip: '30901' }, { city: 'Greensboro', state: 'NC' });
      expect(byCity).toBeGreaterThan(150);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
