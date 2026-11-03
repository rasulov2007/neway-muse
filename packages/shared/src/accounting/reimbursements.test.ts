import { describe, expect, it } from 'vitest';
import {
  canTransitionReimbursement,
  companyFundedCents,
  isEligibleFor,
  reimbursableCents,
  reimbursementProblems,
  reimbursementTotals,
  totalsByCurrency,
  type ReimbursementBlock,
} from './reimbursements.js';

const block = (over: Partial<ReimbursementBlock> = {}): ReimbursementBlock => ({
  status: 'pending',
  category: 'lumper',
  receiptCents: 15000,
  driverFundedCents: 15000,
  currency: 'USD',
  paymentSource: 'driver_personal',
  payerDriverId: 'drv_1',
  payerDriverName: 'Remy Calloway',
  missingReceipt: null,
  note: null,
  submittedBy: 'tester',
  submittedAt: '2026-09-29T12:00:00.000Z',
  reviewedBy: null,
  reviewedAt: null,
  rejectedReason: null,
  settlementId: null,
  settlementNumber: null,
  includedAt: null,
  paidAt: null,
  ...over,
});

describe('what is owed to the driver', () => {
  it('pays back what the driver funded', () => {
    expect(reimbursableCents({ receiptCents: 15000, driverFundedCents: 15000, paymentSource: 'driver_personal' })).toBe(15000);
  });

  it('pays nothing when the company card paid', () => {
    expect(reimbursableCents({ receiptCents: 15000, driverFundedCents: 15000, paymentSource: 'company_card' })).toBe(0);
  });

  it('pays nothing on an EFS advance, which is the company’s money already', () => {
    expect(reimbursableCents({ receiptCents: 15000, driverFundedCents: 15000, paymentSource: 'efs_advance' })).toBe(0);
  });

  it('pays only the driver’s share of a split', () => {
    const split = { receiptCents: 15000, driverFundedCents: 6000, paymentSource: 'driver_personal' as const };
    expect(reimbursableCents(split)).toBe(6000);
    expect(companyFundedCents(split)).toBe(9000);
  });

  it('never pays more than the receipt', () => {
    expect(reimbursableCents({ receiptCents: 15000, driverFundedCents: 99000, paymentSource: 'driver_personal' })).toBe(15000);
  });
});

describe('what stops one being filed', () => {
  const ok = { receiptCents: 15000, driverFundedCents: 15000, paymentSource: 'driver_personal' as const, payerDriverId: 'drv_1', hasReceiptFile: true, missingReceiptReason: null };

  it('accepts a complete one', () => {
    expect(reimbursementProblems(ok)).toEqual([]);
  });

  it('refuses a driver-funded amount larger than the receipt', () => {
    expect(reimbursementProblems({ ...ok, driverFundedCents: 20000 })).toContain('The driver cannot have funded more than the receipt total.');
  });

  it('refuses a company-paid expense that also claims a driver share', () => {
    expect(reimbursementProblems({ ...ok, paymentSource: 'company_card' }).join(' ')).toMatch(/none of it is reimbursable/);
  });

  it('refuses a missing receipt with no authorised reason', () => {
    expect(reimbursementProblems({ ...ok, hasReceiptFile: false })).toContain('Attach the receipt, or record an authorised reason for it being missing.');
  });

  it('accepts a missing receipt once a reason is recorded', () => {
    expect(reimbursementProblems({ ...ok, hasReceiptFile: false, missingReceiptReason: 'Receipt lost at the dock; scale ticket attached' })).toEqual([]);
  });

  it('insists on naming the driver who paid', () => {
    expect(reimbursementProblems({ ...ok, payerDriverId: '' })).toContain('Name the driver who actually paid.');
  });
});

describe('the workflow', () => {
  it('goes pending to approved or rejected, and no further', () => {
    expect(canTransitionReimbursement('pending', 'approved')).toBe(true);
    expect(canTransitionReimbursement('pending', 'rejected')).toBe(true);
    expect(canTransitionReimbursement('pending', 'paid')).toBe(false);
    expect(canTransitionReimbursement('pending', 'included')).toBe(false);
  });

  it('becomes paid only from a statement, never from approval', () => {
    expect(canTransitionReimbursement('approved', 'paid')).toBe(false);
    expect(canTransitionReimbursement('included', 'paid')).toBe(true);
  });

  it('lets a regenerated draft hand an item back', () => {
    expect(canTransitionReimbursement('included', 'approved')).toBe(true);
  });

  it('leaves a paid item alone', () => {
    expect(canTransitionReimbursement('paid', 'approved')).toBe(false);
    expect(canTransitionReimbursement('paid', 'included')).toBe(false);
  });
});

describe('which statement may carry it', () => {
  it('takes an approved item that is not yet on one', () => {
    expect(isEligibleFor(block({ status: 'approved' }), 'stm_1')).toBe(true);
  });

  it('keeps an item on the statement it is already on, however often the draft recomputes', () => {
    const on = block({ status: 'included', settlementId: 'stm_1' });
    expect(isEligibleFor(on, 'stm_1')).toBe(true);
    expect(isEligibleFor(on, 'stm_1')).toBe(true);
  });

  it('refuses to put it on a second statement', () => {
    expect(isEligibleFor(block({ status: 'included', settlementId: 'stm_1' }), 'stm_2')).toBe(false);
  });

  it('refuses one that is still pending, rejected or already paid', () => {
    expect(isEligibleFor(block({ status: 'pending' }), 'stm_1')).toBe(false);
    expect(isEligibleFor(block({ status: 'rejected' }), 'stm_1')).toBe(false);
    expect(isEligibleFor(block({ status: 'paid', settlementId: 'stm_1' }), 'stm_1')).toBe(false);
  });
});

describe('the summary cards', () => {
  const items = [
    block({ status: 'pending', driverFundedCents: 15000, receiptCents: 15000 }),
    block({ status: 'pending', driverFundedCents: 2500, receiptCents: 2500 }),
    block({ status: 'approved', driverFundedCents: 6000, receiptCents: 15000 }),
    block({ status: 'included', driverFundedCents: 4000, receiptCents: 4000, settlementId: 'stm_1' }),
    block({ status: 'paid', driverFundedCents: 9000, receiptCents: 9000, settlementId: 'stm_0', paidAt: '2026-09-20' }),
    block({ status: 'rejected', driverFundedCents: 7000, receiptCents: 7000 }),
  ];

  it('counts and totals each state', () => {
    const t = reimbursementTotals(items);
    expect(t.pendingCount).toBe(2);
    expect(t.pendingCents).toBe(17500);
    expect(t.approvedCount).toBe(1);
    expect(t.includedCount).toBe(1);
    expect(t.paidCents).toBe(9000);
  });

  it('totals what will be paid, not what was spent', () => {
    // The approved item is a $150 receipt the driver funded $60 of.
    expect(reimbursementTotals(items).approvedCents).toBe(6000);
  });

  it('leaves a rejected item out of every card', () => {
    const t = reimbursementTotals(items);
    expect(t.pendingCents + t.approvedCents + t.includedCents + t.paidCents).toBe(17500 + 6000 + 4000 + 9000);
  });

  it('never adds two currencies together', () => {
    const mixed = [block({ status: 'pending', currency: 'USD', driverFundedCents: 10000, receiptCents: 10000 }), block({ status: 'pending', currency: 'CAD', driverFundedCents: 5000, receiptCents: 5000 })];
    const byCurrency = totalsByCurrency(mixed);
    expect(byCurrency.map((c) => c.currency)).toEqual(['CAD', 'USD']);
    expect(byCurrency.find((c) => c.currency === 'USD')?.totals.pendingCents).toBe(10000);
    expect(byCurrency.find((c) => c.currency === 'CAD')?.totals.pendingCents).toBe(5000);
  });
});
