import { describe, expect, it } from 'vitest';
import { dispatcherCommission, payableCommissionCents } from './policy.js';

/**
 * "Until the gross comes out the commission must be 0" (owner, 2026-10-26). The engine already
 * prices a $0 week at $0; the manual layer on top must not write a commission by itself.
 */
describe('commission with no gross', () => {
  it('the engine prices a week with no gross at $0, No gross', () => {
    const calc = dispatcherCommission({ unit: 'solo', grossCents: 0, miles: 0, complaint: false, junior: false });
    expect(calc).toMatchObject({ status: 'no_gross', amountCents: 0, tier: 'No gross' });
  });

  it('no override: the calculated amount', () => {
    expect(payableCommissionCents(0, 0, null)).toEqual({ payableCents: 0, adjustmentHeld: false });
    expect(payableCommissionCents(45_000, 900_000, null)).toEqual({ payableCents: 45_000, adjustmentHeld: false });
  });

  it('an adjustment on a week with no gross is held: $0, applied once there is gross', () => {
    const adj = { mode: 'adjustment' as const, amountCents: 5_000 };
    expect(payableCommissionCents(0, 0, adj)).toEqual({ payableCents: 0, adjustmentHeld: true });
    expect(payableCommissionCents(0, -1_000, adj)).toEqual({ payableCents: 0, adjustmentHeld: true });
    expect(payableCommissionCents(45_000, 900_000, adj)).toEqual({ payableCents: 50_000, adjustmentHeld: false });
    // A negative adjustment on a priced week still applies.
    expect(payableCommissionCents(45_000, 900_000, { mode: 'adjustment', amountCents: -5_000 })).toEqual({ payableCents: 40_000, adjustmentHeld: false });
  });

  it('a manual approved amount is the administrator\'s explicit choice and stays, gross or not', () => {
    expect(payableCommissionCents(0, 0, { mode: 'amount', amountCents: 25_000 })).toEqual({ payableCents: 25_000, adjustmentHeld: false });
    expect(payableCommissionCents(45_000, 900_000, { mode: 'amount', amountCents: 30_000 })).toEqual({ payableCents: 30_000, adjustmentHeld: false });
  });
});
