import { describe, expect, it } from 'vitest';
import { planAdjustedCents } from '@neway/shared';

/*
 * The sheet's rule (owner, 2026-10-27): a week whose Plan Adj is below zero pays no commission -
 * "No payment · missed Plan Adj". The service reads the same Plan Adj the board shows.
 */
describe('missed Plan Adj', () => {
  it('a solo week of $10,500 against a $15,000 goal over 7 days misses Plan Adj', () => {
    expect(planAdjustedCents(1_050_000, 1_500_000, 7)).toBeLessThan(0);
  });
  it('a week at or above the goal does not', () => {
    expect(planAdjustedCents(1_500_000, 1_500_000, 7)).toBeGreaterThanOrEqual(0);
    expect(planAdjustedCents(1_800_000, 1_500_000, 7)).toBeGreaterThan(0);
  });
});
