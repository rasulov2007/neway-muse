import { describe, expect, it } from 'vitest';
import { pct, roundMoney, roundPct, roundRatio, roundTo, safeDivide, subtract, sum } from './money';

describe('money helpers', () => {
  it('rounds money to cents, half away from zero, without negative zero', () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(2.675)).toBe(2.68);
    expect(roundMoney(-1.005)).toBe(-1.01);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(Object.is(roundMoney(-0.001), 0)).toBe(true);
  });

  it('rounds ratios to 4 decimals and percentages to 1 decimal', () => {
    expect(roundRatio(1.23456789)).toBe(1.2346);
    expect(roundPct(33.3333)).toBe(33.3);
    expect(roundTo(5, 0)).toBe(5);
  });

  it('never returns NaN or Infinity from rounding', () => {
    expect(roundMoney(Number.NaN)).toBe(0);
    expect(roundMoney(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('sums values ignoring non-finite entries', () => {
    expect(sum([1, 2, 3.5])).toBe(6.5);
    expect(sum([])).toBe(0);
    expect(sum([1, Number.NaN, Number.POSITIVE_INFINITY])).toBe(1);
  });

  it('safeDivide returns null for zero or null denominators and null numerators', () => {
    expect(safeDivide(10, 4)).toBe(2.5);
    expect(safeDivide(10, 0)).toBeNull();
    expect(safeDivide(null, 4)).toBeNull();
    expect(safeDivide(10, null)).toBeNull();
    expect(safeDivide(0, 0)).toBeNull();
  });

  it('pct rounds to one decimal and is null for a zero whole', () => {
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(-50, 200)).toBe(-25);
    expect(pct(5, 0)).toBeNull();
    expect(pct(null, 10)).toBeNull();
  });

  it('subtract passes null through', () => {
    expect(subtract(5, 2)).toBe(3);
    expect(subtract(null, 2)).toBeNull();
    expect(subtract(5, null)).toBeNull();
  });
});
