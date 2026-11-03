import { describe, expect, it } from 'vitest';
import { planTruckMove } from './truck-move.data';

const SOURCE = { id: 'trk_0016', unitNumber: '0016', vin: '1FUJHHDR9PLUK0202', status: 'available' };
const DEST = 'Harbor Line Transport (co_aj)';

describe('planTruckMove', () => {
  it('goes when the destination has no truck with the unit number or VIN and no load holds the truck', () => {
    expect(planTruckMove({ source: SOURCE, destination: [], destinationName: DEST, activeLoads: [] })).toEqual({ outcome: 'go', refusals: [], movedTo: null });
  });

  it('refuses when the destination already has a live truck with the unit number or the VIN', () => {
    const byNumber = planTruckMove({ source: SOURCE, destination: [{ id: 'trk_9', unitNumber: '0016', vin: 'OTHER', status: 'available' }], destinationName: DEST, activeLoads: [] });
    expect(byNumber.outcome).toBe('refused');
    expect(byNumber.refusals[0]).toBe('Harbor Line Transport (co_aj) already has a live truck with unit number 0016 (trk_9, available)');
    const byVin = planTruckMove({ source: SOURCE, destination: [{ id: 'trk_8', unitNumber: 'X1', vin: '1fujhhdr9pluk0202 ', status: 'in_shop' }], destinationName: DEST, activeLoads: [] });
    expect(byVin.refusals[0]).toMatch(/live truck with VIN .*\(trk_8, in_shop\)/);
  });

  it('refuses over an archived twin too (the unique index forbids a second) and names the way out', () => {
    const r = planTruckMove({ source: SOURCE, destination: [{ id: 'trk_7', unitNumber: '0016', vin: 'OTHER', status: 'archived' }], destinationName: DEST, activeLoads: [] });
    expect(r.refusals[0]).toMatch(/archived truck with unit number 0016 \(trk_7\); restore that one/);
  });

  it('refuses while the truck is on an active load', () => {
    const r = planTruckMove({ source: SOURCE, destination: [], destinationName: DEST, activeLoads: ['L-100'] });
    expect(r.outcome).toBe('refused');
    expect(r.refusals).toEqual(['Unit 0016 is on active load L-100; finish or move the load first']);
  });

  it('a second run: source archived and the VIN in the destination = already moved', () => {
    const r = planTruckMove({
      source: { ...SOURCE, status: 'archived' },
      destination: [{ id: 'trk_1001', unitNumber: '0016', vin: '1FUJHHDR9PLUK0202', status: 'available' }],
      destinationName: DEST,
      activeLoads: [],
    });
    expect(r).toEqual({ outcome: 'already_moved', refusals: [], movedTo: 'trk_1001' });
  });

  it('an archived source with nothing in the destination is not moved silently', () => {
    const r = planTruckMove({ source: { ...SOURCE, status: 'archived' }, destination: [], destinationName: DEST, activeLoads: [] });
    expect(r.outcome).toBe('refused');
    expect(r.refusals[0]).toMatch(/already archived/);
  });
});
