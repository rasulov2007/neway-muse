import { describe, expect, it } from 'vitest';
import { clampMiles, splitLoadForRecovery, type LoadSegment } from './recovery-split';

const OUT = { driverId: 'd1', driverName: 'Victor Young', truckId: 't1', unitNumber: '2757' };
const IN = { driverId: 'd2', driverName: 'Alexis Vance', truckId: 't2', unitNumber: '1593' };

/** The two segments, named, so a test never has to cope with an index that might be missing. */
function split(milesCompleted: number, existing?: LoadSegment[]): [LoadSegment, LoadSegment] {
  const segments = splitLoadForRecovery({
    loadedMiles: 1340,
    emptyMiles: 89,
    linehaul: 2775,
    milesCompleted,
    outgoing: OUT,
    incoming: IN,
    reason: 'Breakdown at MM 142',
    at: '2026-09-13T12:00:00.000Z',
    existing,
  });
  const [first, second] = segments.slice(-2);
  if (!first || !second) throw new Error('a recovery always produces two segments');
  return [first, second];
}

describe('splitLoadForRecovery', () => {
  it('divides miles and linehaul between the two drivers', () => {
    const [first, second] = split(600);

    expect(first.driverName).toBe('Victor Young');
    expect(first.loadedMiles).toBe(600);
    expect(second.driverName).toBe('Alexis Vance');
    expect(second.loadedMiles).toBe(740);

    // 600/1340 of $2,775 and the remainder — and the two halves add back to the whole.
    expect(first.linehaulRevenue).toBe(1242.54);
    expect(second.linehaulRevenue).toBe(1532.46);
    expect(first.linehaulRevenue + second.linehaulRevenue).toBe(2775);
  });

  it('puts the deadhead on the driver who repositioned, not on the one who took over', () => {
    const [first, second] = split(600);
    expect(first.emptyMiles).toBe(89);
    expect(second.emptyMiles).toBe(0);
  });

  it('pays nothing to a driver who never turned a mile', () => {
    const [first, second] = split(0);
    expect(first.loadedMiles).toBe(0);
    expect(first.linehaulRevenue).toBe(0);
    expect(second.linehaulRevenue).toBe(2775);
  });

  it('cannot pay a driver for more miles than the load is long', () => {
    const [first, second] = split(99_999);
    expect(first.loadedMiles).toBe(1340);
    expect(second.loadedMiles).toBe(0);
    expect(second.linehaulRevenue).toBe(0);
    expect(clampMiles(-40, 1340)).toBe(0);
  });

  it('leaves already-settled segments alone on a second recovery', () => {
    const once: LoadSegment[] = split(600);
    // The second driver breaks down too, at mile 1,000 of the run.
    const twice = splitLoadForRecovery({
      loadedMiles: 1340,
      emptyMiles: 89,
      linehaul: 2775,
      milesCompleted: 1000,
      outgoing: IN,
      incoming: { driverId: 'd3', driverName: 'Dana Reyes', truckId: 't3', unitNumber: '2711' },
      reason: 'Out of hours',
      at: '2026-09-13T20:00:00.000Z',
      existing: once,
    });

    expect(twice).toHaveLength(3);
    const [kept, middle, last] = twice;
    expect(kept).toEqual(once[0]);
    expect(middle?.driverName).toBe('Alexis Vance');
    expect(middle?.loadedMiles).toBe(400);
    expect(last?.driverName).toBe('Dana Reyes');
    expect(last?.loadedMiles).toBe(340);

    const paid = twice.reduce((sum, seg) => sum + seg.linehaulRevenue, 0);
    expect(Math.round(paid * 100) / 100).toBe(2775);
    const miles = twice.reduce((sum, seg) => sum + seg.loadedMiles, 0);
    expect(miles).toBe(1340);
  });
});
