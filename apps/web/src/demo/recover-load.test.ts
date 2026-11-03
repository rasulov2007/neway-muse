import { beforeEach, describe, expect, it } from 'vitest';
import { demoData } from './data';
import { recoverLoad, updateLoad } from './api';

/*
 * A recovery has to leave three things behind: a load on the new driver, a segment each for the
 * miles the two of them turned, and money in front of accounting for both. Anything less and
 * somebody has to remember to tell payroll, which is the part that never happens.
 */

function movingLoad() {
  const load = demoData.loads.find(
    (l) => l.status === 'in_transit' && l.driverId && l.loadedMiles > 200,
  );
  if (!load) throw new Error('no moving load in the demo dataset');
  return load;
}

describe('recoverLoad', () => {
  let loadId: string;
  let originalDriverId: string;
  let relief: (typeof demoData.drivers)[number];

  beforeEach(() => {
    const load = movingLoad();
    loadId = load.id;
    originalDriverId = load.driverId as string;
    const other = demoData.drivers.find((d) => d.id !== originalDriverId);
    if (!other) throw new Error('need a second driver');
    relief = other;
  });

  it('splits the miles and the linehaul, and puts both shares on settlements', async () => {
    const before = demoData.loads.find((l) => l.id === loadId);
    if (!before) throw new Error('load vanished');
    const totalMiles = before.loadedMiles;
    const linehaul = before.charges?.find((c) => c.type === 'linehaul')?.amount ?? before.rate;

    const updated = await recoverLoad({
      loadId,
      driverId: relief.id,
      truckId: null,
      reason: 'Breakdown at MM 142',
      milesCompleted: 100,
    });

    expect(updated.driverId).toBe(relief.id);
    const segments = updated.segments ?? [];
    expect(segments).toHaveLength(2);
    const [handed, taken] = segments;
    expect(handed?.driverId).toBe(originalDriverId);
    expect(handed?.loadedMiles).toBe(100);
    expect(taken?.driverId).toBe(relief.id);
    expect(taken?.loadedMiles).toBe(totalMiles - 100);

    // Nothing is lost between the two of them.
    const paid = segments.reduce((sum, s) => sum + s.linehaulRevenue, 0);
    expect(Math.round(paid * 100) / 100).toBe(Math.round(linehaul * 100) / 100);

    for (const segment of segments) {
      const settlement = demoData.settlements.find(
        (s) => s.driverId === segment.driverId && s.lines.some((l) => l.loadId === loadId),
      );
      expect(settlement, `no settlement for ${segment.driverName}`).toBeDefined();
      const line = settlement?.lines.find((l) => l.loadId === loadId);
      expect(line?.amount).toBe(segment.linehaulRevenue);
      // The driver can check the arithmetic without asking anybody.
      expect(line?.basis).toContain('loaded mi');
    }

    expect(updated.timeline.at(-1)?.title).toContain('Recovered from');
  });

  it('will not hand a load to the driver already on it', async () => {
    await expect(
      recoverLoad({
        loadId,
        driverId: originalDriverId,
        truckId: null,
        reason: 'Typo',
        milesCompleted: 10,
      }),
    ).rejects.toThrow(/already has this load/i);
  });

  it('refuses to recover a load that has already delivered', async () => {
    // Delivered now stands on a POD, so the load is papered before it is moved; the rule under
    // test here is the recovery one.
    const load = demoData.loads.find((l) => l.id === loadId);
    load?.documents.push({
      id: 'doc_recover_pod',
      type: 'pod',
      title: 'Proof of delivery',
      fileName: 'pod.pdf',
      sizeBytes: 1024,
      uploadedAt: new Date().toISOString(),
      uploadedBy: 'Test',
      status: 'verified',
    });
    // The status is the server's now; this test only needs the load to stand at delivered.
    const record = demoData.loads.find((l) => l.id === loadId || l.loadNumber === loadId)!;
    record.status = 'delivered';
    record.deliveredAt = new Date().toISOString();
    await expect(
      recoverLoad({
        loadId,
        driverId: relief.id,
        truckId: null,
        reason: 'Too late',
        milesCompleted: 10,
      }),
    ).rejects.toThrow(/delivered load cannot be recovered/i);
  });
});

describe('updateLoad', () => {
  it('records what changed, and keeps the linehaul charge with the rate', async () => {
    const load = movingLoad();
    const updated = await updateLoad({ loadId: load.id, rate: 3210.5 });

    expect(updated.rate).toBe(3210.5);
    const linehaul = updated.charges?.find((c) => c.type === 'linehaul');
    if (linehaul) expect(linehaul.amount).toBe(3210.5);

    const event = updated.timeline.at(-1);
    expect(event?.title).toBe('Load edited');
    expect(event?.detail).toContain('Rate');
  });

  it('corrects an address, and the load origin follows the stop', async () => {
    const load = movingLoad();
    const stops = load.stops.map((stop) => ({
      kind: stop.kind,
      city: stop.city,
      state: stop.state,
      at: stop.appointmentStartAt,
    }));
    const firstStop = stops[0];
    if (!firstStop) throw new Error('a load always has a first stop');
    stops[0] = { ...firstStop, city: 'Adairsville', state: 'GA' };

    // The first stop of a moving load has an arrival on it (P0.2): changing its city is refused
    // until the person has seen what would be cleared and said so.
    if (load.stops[0]?.arrivedAt || load.stops[0]?.departedAt) {
      await expect(updateLoad({ loadId: load.id, stops })).rejects.toThrow(/Confirm to clear/);
    }
    const updated = await updateLoad({ loadId: load.id, stops, confirmClearEvents: true });

    expect(updated.stops[0]?.city).toBe('Adairsville');
    expect(updated.stops[0]?.timezone).toBe('America/New_York');
    expect(updated.stops[0]?.arrivedAt).toBeNull();
    expect(updated.origin).toEqual({ city: 'Adairsville', state: 'GA' });
    expect(updated.timeline.at(-1)?.detail).toContain('Route');
  });

  it('keeps a stop that did not move, arrival times and all', async () => {
    const load = movingLoad();
    const arrived = load.stops[0]?.arrivedAt;
    const stops = load.stops.map((stop) => ({
      kind: stop.kind,
      city: stop.city,
      state: stop.state,
      at: stop.appointmentStartAt,
    }));

    const updated = await updateLoad({ loadId: load.id, stops });

    expect(updated.stops[0]?.arrivedAt).toBe(arrived);
    expect(updated.stops[0]?.id).toBe(load.stops[0]?.id);
  });
});
