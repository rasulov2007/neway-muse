import { describe, expect, it } from 'vitest';
import { oilIntervalMiles } from './oil-interval';

describe('oilIntervalMiles', () => {
  it('reads thousands typed short', () => {
    expect(oilIntervalMiles('30')).toBe(30_000);
    expect(oilIntervalMiles('25')).toBe(25_000);
    expect(oilIntervalMiles('25k')).toBe(25_000);
    expect(oilIntervalMiles('27.5')).toBe(27_500);
  });

  it('reads full miles as they are', () => {
    expect(oilIntervalMiles('30000')).toBe(30_000);
    expect(oilIntervalMiles('30,000 mi')).toBe(30_000);
  });

  it('refuses what is not an interval', () => {
    expect(oilIntervalMiles('')).toBeNull();
    expect(oilIntervalMiles('abc')).toBeNull();
    expect(oilIntervalMiles('2')).toBeNull();
    expect(oilIntervalMiles('500000')).toBeNull();
  });
});
