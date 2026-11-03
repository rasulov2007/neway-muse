import { describe, expect, it } from 'vitest';
import { odometerAt } from './fuel-odometer';

const H = 3_600_000;
const day = (d: number, h = 0) => Date.UTC(2026, 9, d, h);

describe('odometerAt', () => {
  const daily = [
    { atMs: day(1, 12), miles: 100_000 },
    { atMs: day(2, 12), miles: 100_600 },
    { atMs: day(3, 12), miles: 101_200 },
  ];

  it('interpolates between the readings around the fill', () => {
    expect(odometerAt(daily, day(2, 0))).toBe(100_300);
    expect(odometerAt(daily, day(2, 12))).toBe(100_600);
  });

  it('uses a reading on its own only when it is close to the fill', () => {
    expect(odometerAt(daily, day(3, 15))).toBe(101_200);
    expect(odometerAt(daily, day(4, 12))).toBeNull();
    expect(odometerAt([], day(2))).toBeNull();
  });

  it('does not bridge a gap of more than four days', () => {
    const gap = [{ atMs: day(1, 12), miles: 100_000 }, { atMs: day(9, 12), miles: 104_000 }];
    expect(odometerAt(gap, day(5))).toBeNull();
    expect(odometerAt(gap, day(1, 12) + 2 * H)).toBe(100_000);
  });

  it('does not interpolate across a reading that went backwards', () => {
    const swapped = [{ atMs: day(1, 12), miles: 500_000 }, { atMs: day(2, 12), miles: 1_000 }];
    expect(odometerAt(swapped, day(2, 0))).toBeNull();
    expect(odometerAt(swapped, day(1, 14))).toBe(500_000);
  });
});
