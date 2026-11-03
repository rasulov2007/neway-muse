import { describe, expect, it } from 'vitest';
import type { DriverCharge, SafetyClaim } from '@neway/shared';
import { ageBuckets, attentionOf, finOf, kpisOf } from './model';

const now = Date.parse('2026-10-14T12:00:00Z');
const claim = (over: Partial<SafetyClaim>): SafetyClaim =>
  ({
    id: 'c1',
    number: 'CLM-1',
    kind: 'liability',
    stage: 'insurer_review',
    openedOn: '2026-10-07',
    claimedCents: 2_943_000,
    approvedCents: null,
    decision: null,
    receivedCents: 0,
    payments: [],
    lastActivityAt: '2026-10-13T12:00:00Z',
    nextAction: null,
    nextActionDueOn: null,
    ownerName: 'Dilnoza',
    voidedAt: null,
    driverCharge: null,
    ...over,
  }) as SafetyClaim;
const charge = (over: Partial<DriverCharge>): DriverCharge =>
  ({ id: 'd1', number: 'DCH-1', claimId: 'c1', state: 'on_hold', amountCents: 500_000, recoveredCents: 0, remainingCents: 500_000, ageDays: 5, driverName: 'Bekzod', isTest: false, recoveryLog: [], ...over }) as DriverCharge;

describe('claims figures', () => {
  it('reads the money of a claim: gross, insurance expected, driver to recover, projected net', () => {
    const c = claim({ decision: 'approved', approvedCents: 1_340_000, receivedCents: 0 });
    const f = finOf(c, charge({}));
    expect(f).toMatchObject({ gross: 2_943_000, insuranceExpected: 1_340_000, toRecover: 500_000, net: 2_943_000 - 1_340_000 - 500_000 });
  });

  it('counts the cards and ranks what needs attention', () => {
    const claims = [claim({}), claim({ id: 'c2', number: 'CLM-2', kind: 'cargo', claimedCents: null, lastActivityAt: '2026-10-01T12:00:00Z', nextAction: 'Chase payment', nextActionDueOn: '2026-10-09' })];
    const charges = [charge({}), charge({ id: 'd2', claimId: 'c2', state: 'pending_accounting', amountCents: 100_000, remainingCents: 100_000 })];
    const k = kpisOf(claims, charges, now);
    expect(k).toMatchObject({ open: 2, onHold: 1, onHoldCents: 500_000, pendingAccounting: 1, stale: 1, openSub: '1 accident · 1 cargo' });
    const a = attentionOf(claims, charges, '2026-10-14', now);
    expect(a[0]!.severity).toBe(2);
    expect(a.map((x) => x.title)).toEqual(expect.arrayContaining(['Driver not informed of $5,000 charge', 'Overdue: Chase payment', 'Reserve not set', 'No update in 13 days']));
  });

  it('buckets open claims by age', () => {
    expect(ageBuckets([claim({}), claim({ id: 'c3', openedOn: '2026-06-01' })], now).map((b) => b.count)).toEqual([1, 0, 0, 1]);
  });
});
