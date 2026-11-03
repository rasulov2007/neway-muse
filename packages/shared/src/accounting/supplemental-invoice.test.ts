import { describe, expect, it } from 'vitest';
import { defaultSwitches, type DriverTx, type ProfileVersion } from './driver-account.js';
import { billingVerdict, type BillableLoad } from './billing.js';
import { computeStatement, settlementPeriodFor, type SettleableLoadV2 } from './settlement-rules.js';
import { accessorialShareCents, lateAccessorialKey, parseLateAccessorialKey, supplementEligibility, supplementInvoiceNumber, AddChargeAfterInvoicingSchema } from './supplemental-invoice.js';

/**
 * A layover after the invoice went to RTS (owner, 2026-10-21): billed on INV-…-S1, the original never
 * changed, and the driver paid once even when the load's statement was already approved.
 */

const ET = { timezone: 'America/New_York', cutoffTime: '12:00', payDay: 'thursday' };

describe('supplemental invoices', () => {
  it('are numbered after the original', () => {
    expect(supplementInvoiceNumber('INV-10004', 1)).toBe('INV-10004-S1');
    expect(supplementInvoiceNumber('INV-10004', 2)).toBe('INV-10004-S2');
  });

  it('are the way only once RTS has the invoice (sent, batched or funded)', () => {
    const base = { invoiceNumber: 'INV-1', isCurrent: true, status: 'issued', submission: { status: 'prepared' }, factoring: { fundedGross: 0 }, rtsBatch: null };
    expect(supplementEligibility({ ...base, status: 'draft' }, false)).toMatchObject({ ok: false, useRevision: false });
    expect(supplementEligibility(base, false)).toMatchObject({ ok: false, useRevision: true });
    expect(supplementEligibility(base, true).ok).toBe(true);
    expect(supplementEligibility({ ...base, status: 'submitted', submission: { status: 'submitted' } }, false).ok).toBe(true);
    expect(supplementEligibility({ ...base, status: 'funded', factoring: { fundedGross: 2000 } }, false).ok).toBe(true);
    // A rejected submission is corrected by a revision, as before.
    expect(supplementEligibility({ ...base, submission: { status: 'rejected' } }, false)).toMatchObject({ ok: false, useRevision: true });
    expect(supplementEligibility({ ...base, status: 'submitted', submission: { status: 'submitted' }, supplementOf: { invoiceId: 'x' } }, false).ok).toBe(false);
  });

  it('the input asks for a reason, a positive amount and a request key', () => {
    const good = { requestKey: 'req-12345678', reason: 'Layover approved', charges: [{ chargeType: 'layover', description: 'Layover', amount: 250 }], expectedUpdatedAt: 'x' };
    expect(AddChargeAfterInvoicingSchema.parse(good)).toMatchObject({ issueNow: true, charges: [{ payableToDriver: false, supportingDocumentIds: [] }] });
    expect(() => AddChargeAfterInvoicingSchema.parse({ ...good, charges: [{ chargeType: 'linehaul', description: 'x', amount: 1 }] })).toThrow();
    expect(() => AddChargeAfterInvoicingSchema.parse({ ...good, charges: [{ chargeType: 'layover', description: 'x', amount: 0 }] })).toThrow();
  });

  it('never become "the" invoice of the load in the billing queue', () => {
    const load: BillableLoad = { id: 'l1', loadNumber: 'L-1', status: 'delivered', brokerReference: 'R', customerId: null, brokerId: 'b', customerName: 'C', brokerName: 'B', rate: 1000, documents: [], charges: [], stops: [], updatedAt: 'x' };
    const ctx = (supplementFirst: boolean) => ({
      invoices: [
        ...(supplementFirst ? [{ id: 's1', loadId: 'l1', family: 'INV-1-S1', revision: 1, isCurrent: true, status: 'issued', submission: { status: 'prepared' }, supplement: true }] : []),
        { id: 'i1', loadId: 'l1', family: 'INV-1', revision: 1, isCurrent: true, status: 'submitted', submission: { status: 'submitted' } },
      ],
      hashesElsewhere: () => [],
      resolvedExceptions: () => [],
    });
    expect(billingVerdict(load, ctx(true)).queue).toBe(billingVerdict(load, ctx(false)).queue);
  });
});

describe('driver pay for a charge added after the load was settled', () => {
  const profile: ProfileVersion = { effectiveFrom: '2026-01-01', contractType: 'LO', switches: { ...defaultSwitches('LO'), recurringDeductions: false, deductFuel: false, deductTolls: false }, loadedPlan: { kind: 'per_mile', rate: 1 }, emptyPlan: { kind: 'none', rate: 0 }, escrow: { targetCents: 0, perSettlementCents: 0, openingBalanceCents: 0, openingReconciled: true }, byId: 'u', byName: 'T', at: '2026-01-01T00:00:00Z' };
  const allocation = { chargeId: 'chg_lay', treatment: 'paid_separately' as const, mode: 'full' as const, value: 100, nature: 'earning' as const, recipients: ['d1'] };
  const load: SettleableLoadV2 = { id: 'l1', loadNumber: 'L-1', completedAt: '2026-10-07T17:00:00Z', originLabel: 'A, IL', destinationLabel: 'B, TX', loadedMiles: 1000, emptyMiles: 0, grossCents: 225_000, linehaulCents: 200_000, driverIds: ['d1'], accessorials: [{ id: 'chg_lay', type: 'layover', description: 'Layover', amountCents: 25_000, allocation }], funded: false, status: 'delivered' };
  const late: DriverTx = { id: 'tx1', driverId: 'd1', kind: 'adjustment', onDate: '2026-10-21', occurredAt: '2026-10-21T18:00:00Z', amountCents: 25_000, recoveredCents: 0, state: 'approved', source: 'late_accessorial', sourceKey: lateAccessorialKey('l1', 'chg_lay', 'd1'), truckId: null, loadId: 'l1', loadNumber: 'L-1', nature: 'earning', settlementId: null, description: 'Layover · L-1 (added after ST-1)', companyCost: false };
  const base = { driverId: 'd1', profile, recurring: [], openingDebtCents: 0, settings: { teamBaseMileageSplit: 'each_full' as const, payOnFundingOnly: false } };

  it('the key round-trips', () => {
    expect(parseLateAccessorialKey(lateAccessorialKey('l1', 'chg_lay', 'd1'))).toEqual({ loadId: 'l1', chargeId: 'chg_lay', driverId: 'd1' });
    expect(parseLateAccessorialKey('fuel:1')).toBeNull();
  });

  it('shares follow the allocation: full, percent, fixed, split', () => {
    expect(accessorialShareCents(25_000, allocation, 'd1')).toBe(25_000);
    expect(accessorialShareCents(25_000, { ...allocation, mode: 'percent', value: 50 }, 'd1')).toBe(12_500);
    expect(accessorialShareCents(25_000, { ...allocation, mode: 'fixed', value: 150 }, 'd1')).toBe(15_000);
    expect(accessorialShareCents(25_001, { ...allocation, recipients: ['d1', 'd2'] }, 'd2')).toBe(12_500);
    expect(accessorialShareCents(25_000, { ...allocation, treatment: 'excluded' }, 'd1')).toBe(0);
    expect(accessorialShareCents(25_000, null, 'd1')).toBe(0);
  });

  it('the next statement pays it once; the settled week, recomputed, does not pay it again', () => {
    const weekOfLoad = settlementPeriodFor('2026-10-06', ET);
    const thisWeek = settlementPeriodFor('2026-10-20', ET);
    // The load's own week (reopened and recomputed): load pay, but not the layover.
    const reopened = computeStatement({ ...base, period: weekOfLoad, loads: [load], transactions: [late] });
    expect(reopened.earnings.filter((e) => e.description.startsWith('Layover'))).toEqual([]);
    expect(reopened.exceptions).toEqual([]);
    // This week: one layover line, carried by the transaction, not counted as a load run.
    const now = computeStatement({ ...base, period: thisWeek, loads: [], transactions: [late] });
    expect(now.earnings).toEqual([expect.objectContaining({ kind: 'accessorial', txId: 'tx1', chargeId: 'chg_lay', cents: 25_000, loadNumber: 'L-1' })]);
    expect(now.grossCents).toBe(25_000);
    expect(now.loadCount).toBe(0);
    // Claimed by an approved statement: nobody pays it again.
    expect(computeStatement({ ...base, period: thisWeek, loads: [], transactions: [{ ...late, state: 'applied', settlementId: 'stm' }] }).earnings).toEqual([]);
    // Without the transaction, the load pays it as usual - with the charge's id on the line.
    const plain = computeStatement({ ...base, period: weekOfLoad, loads: [load], transactions: [] });
    expect(plain.earnings.filter((e) => e.kind === 'accessorial')).toEqual([expect.objectContaining({ chargeId: 'chg_lay', cents: 25_000 })]);
  });
});
