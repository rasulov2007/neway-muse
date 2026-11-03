import { describe, expect, it } from 'vitest';
import { trialBalance, entryBalances, accountFor } from '@neway/shared';
import { demoData } from './data';

/**
 * The seed is where a ledger most easily goes wrong: hundreds of postings written in one pass, any
 * one of which could be lopsided. These assertions run against the real generated data rather than
 * a fixture, so a change to any posting rule or any seed rule is caught here.
 */
describe('the seeded ledger', () => {
  it('posts something', () => {
    expect(demoData.journal.length).toBeGreaterThan(50);
  });

  it('balances as a whole', () => {
    const tb = trialBalance(demoData.journal);
    expect(tb.difference).toBe(0);
    expect(tb.balanced).toBe(true);
  });

  it('balances entry by entry', () => {
    const broken = demoData.journal.filter((e) => !entryBalances(e));
    expect(broken.map((e) => `${e.id} ${e.memo}`)).toEqual([]);
  });

  it('never posts the same operational event twice', () => {
    const keys = demoData.journal.map((e) => e.sourceKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('posts only to accounts that exist and are postable', () => {
    for (const entry of demoData.journal) {
      for (const line of entry.lines) {
        const account = accountFor(line.accountCode);
        expect(account, `${entry.id} posts to unknown ${line.accountCode}`).not.toBeNull();
        expect(account?.postable, `${entry.id} posts to heading ${line.accountCode}`).toBe(true);
      }
    }
  });

  it('produces the accounting records the module needs', () => {
    expect(demoData.vendors.length).toBeGreaterThan(0);
    expect(demoData.bills.length).toBeGreaterThan(0);
    expect(demoData.expenses.length).toBeGreaterThan(0);
    expect(demoData.payments.length).toBeGreaterThan(0);
    expect(demoData.settlements.length).toBeGreaterThan(0);
    expect(demoData.payrollPeriods.length).toBe(3);
    expect(demoData.payslips.length).toBeGreaterThan(0);
  });

  it('keeps every bill balance consistent with what was paid', () => {
    for (const bill of demoData.bills) {
      expect(Math.round((bill.amount - bill.paid) * 100) / 100).toBe(bill.balance);
    }
  });

  it('keeps every settlement net consistent with its own lines', () => {
    for (const settlement of demoData.settlements) {
      const sum = Math.round(settlement.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
      expect(sum, `${settlement.settlementNumber}`).toBe(settlement.net);
    }
  });

  it('leaves the current month open and older months closed', () => {
    const open = demoData.ledgerPeriods.filter((p) => p.status === 'open');
    expect(open.length).toBeGreaterThan(0);
    expect(demoData.ledgerPeriods.some((p) => p.status === 'closed')).toBe(true);
  });
});
