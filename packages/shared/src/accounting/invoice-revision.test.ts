import { describe, expect, it } from 'vitest';
import { revisionBalance, revisionFundable, revisionInvoiceNumber, revisionPosting } from './invoice-revision.js';

describe('revision numbers', () => {
  it('reads INV-10004, INV2-10004, INV3-10004', () => {
    expect(revisionInvoiceNumber('INV-10004', 1)).toBe('INV-10004');
    expect(revisionInvoiceNumber('INV-10004', 2)).toBe('INV2-10004');
    expect(revisionInvoiceNumber('INV-10004', 3)).toBe('INV3-10004');
  });
  it('a family without a letters-dash prefix takes the count as a suffix', () => {
    expect(revisionInvoiceNumber('10004', 2)).toBe('10004-2');
  });
});

describe('what issuing a revision posts', () => {
  const linehaul = { chargeType: 'linehaul', description: 'Linehaul', amount: 2150 };
  it('adding $150 detention posts +$150, to detention revenue only', () => {
    const r = revisionPosting([linehaul], [linehaul, { chargeType: 'detention', description: 'Detention', amount: 150 }]);
    expect(r.previousTotalCents).toBe(215_000);
    expect(r.revisedTotalCents).toBe(230_000);
    expect(r.deltaCents).toBe(15_000);
    expect(r.byAccount).toEqual([{ accountCode: '4200', cents: 15_000 }]);
  });
  it('a note-only revision posts nothing', () => {
    expect(revisionPosting([linehaul], [linehaul]).postsAnything).toBe(false);
  });
  it('moving money between charge types at the same total still posts the move', () => {
    const r = revisionPosting([linehaul, { chargeType: 'other', description: 'x', amount: 150 }], [linehaul, { chargeType: 'detention', description: 'x', amount: 150 }]);
    expect(r.deltaCents).toBe(0);
    expect(r.postsAnything).toBe(true);
  });
});

describe('what is owed after a revision', () => {
  it('a $1,000 payment against a $2,300 revision leaves $1,300', () => {
    expect(revisionBalance(230_000, 100_000)).toEqual({ balanceCents: 130_000, creditCents: 0, status: 'partially_paid' });
  });
  it('a fully paid $2,150 invoice revised to $2,300 leaves only $150', () => {
    expect(revisionBalance(230_000, 215_000).balanceCents).toBe(15_000);
  });
  it('a revision below what was paid leaves an explicit credit, not a zero', () => {
    expect(revisionBalance(200_000, 215_000)).toEqual({ balanceCents: -15_000, creditCents: 15_000, status: 'credit' });
  });
});

describe('what a revision may ask RTS to fund', () => {
  it('only the increase, when RTS already has the invoice', () => {
    expect(revisionFundable({ previousTotalCents: 215_000, revisedTotalCents: 230_000, previouslySubmitted: true })).toEqual({ fundableCents: 15_000, adjustmentCents: 15_000 });
  });
  it('nothing, when the revision is a decrease', () => {
    expect(revisionFundable({ previousTotalCents: 215_000, revisedTotalCents: 200_000, previouslySubmitted: true }).fundableCents).toBe(0);
  });
  it('the whole total, when RTS never had the earlier version', () => {
    expect(revisionFundable({ previousTotalCents: 215_000, revisedTotalCents: 230_000, previouslySubmitted: false }).fundableCents).toBe(230_000);
  });
});
