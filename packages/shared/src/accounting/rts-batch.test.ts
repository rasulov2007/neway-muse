import { describe, expect, it } from 'vitest';
import { rtsFtpFileName, rtsFtpProblems, rtsFtpRow, rtsFtpWaitMinutes, RecordRtsSubmissionSchema, rtsBatchTotals, rtsEligibility, type RtsPackageDocument } from './rts-batch.js';

const inv = (over: Record<string, unknown> = {}) => ({ id: 'inv_1', invoiceNumber: 'INV-1', status: 'issued', isCurrent: true, total: 3000, submission: { status: 'prepared' }, factoring: { billViaFactoring: true }, ...over });
const docs = (over: Partial<Record<'rc' | 'pod' | 'bol', Partial<RtsPackageDocument> | null>> = {}): RtsPackageDocument[] =>
  (
    [
      over.rc === null ? null : { id: 'rc', type: 'rate_confirmation', fileName: 'rc.pdf', stillCurrent: true, hasBytes: true, ...over.rc },
      over.pod === null ? null : { id: 'pod', type: 'pod', fileName: 'pod.pdf', stillCurrent: true, hasBytes: true, ...over.pod },
      over.bol === null ? null : { id: 'bol', type: 'bol', fileName: 'bol.pdf', stillCurrent: true, hasBytes: true, ...over.bol },
    ] as Array<RtsPackageDocument | null>
  ).filter((d): d is RtsPackageDocument => d !== null);

describe('which invoices can go into an RTS batch', () => {
  it('an issued, current invoice with its RC and POD can', () => {
    expect(rtsEligibility(inv(), docs(), null)).toEqual({ eligible: true, reasons: [], warnings: [] });
  });

  it('a draft cannot, and says to issue it', () => {
    expect(rtsEligibility(inv({ status: 'draft' }), docs(), null).reasons).toContain('Still a draft: issue it first.');
  });

  it('an invoice already submitted, accepted or funded cannot', () => {
    for (const status of ['submitted', 'accepted', 'funded', 'paid']) expect(rtsEligibility(inv({ status }), docs(), null).eligible).toBe(false);
  });

  it('an invoice already in a live batch cannot go into a second one', () => {
    const r = rtsEligibility(inv(), docs(), { batchNumber: 'RTS-00001', status: 'exported' });
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/Already in RTS-00001/);
  });

  it('a superseded revision cannot', () => {
    expect(rtsEligibility(inv({ isCurrent: false }), docs(), null).reasons.join(' ')).toMatch(/revision/);
  });

  it('an invoice without its POD cannot, and says which document', () => {
    expect(rtsEligibility(inv(), docs({ pod: null }), null).reasons).toContain("No POD in the invoice's document package.");
  });

  it('a TONU goes with its RC and the TONU confirmation, no POD (owner, 2026-10-30)', () => {
    const tonuDocs: RtsPackageDocument[] = [
      { id: 'rc', type: 'rate_confirmation', fileName: 'rc.pdf', stillCurrent: true, hasBytes: true },
      { id: 't', type: 'tonu', fileName: 'tonu.pdf', stillCurrent: true, hasBytes: true },
    ];
    expect(rtsEligibility(inv({ tonu: true, total: 150 }), tonuDocs, null)).toEqual({ eligible: true, reasons: [], warnings: [] });
    expect(rtsEligibility(inv({ tonu: true }), tonuDocs.slice(0, 1), null).reasons).toContain("No TONU confirmation in the invoice's document package.");
  });

  it('an invoice whose POD has since been rejected on the load cannot', () => {
    expect(rtsEligibility(inv(), docs({ pod: { stillCurrent: false } }), null).reasons.join(' ')).toMatch(/replaced or rejected/);
  });

  it('a missing BOL is a warning, not a refusal', () => {
    const r = rtsEligibility(inv(), docs({ bol: null }), null);
    expect(r.eligible).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/No BOL/);
  });

  it('a simulated submission can never be batched for real', () => {
    expect(rtsEligibility(inv({ submission: { status: 'prepared', simulated: true } }), docs(), null).eligible).toBe(false);
  });

  it('an invoice billed directly, not through RTS, cannot', () => {
    expect(rtsEligibility(inv({ factoring: { billViaFactoring: false } }), docs(), null).reasons).toContain('Billed directly to the broker, not through RTS.');
  });
});

describe('the batch review and the submission record', () => {
  it('totals count and money, and counts any line missing a required document', () => {
    expect(rtsBatchTotals([{ totalCents: 300_000, documents: ['rate_confirmation', 'pod'] }, { totalCents: 90_000, documents: ['rate_confirmation'] }])).toEqual({ count: 2, totalCents: 390_000, missingRequired: 1 });
  });

  it('recording a submission needs a reference, a note or a file', () => {
    expect(RecordRtsSubmissionSchema.safeParse({ submittedOn: '2026-09-29', expectedVersion: 1 }).success).toBe(false);
    expect(RecordRtsSubmissionSchema.safeParse({ reference: 'RTS-SCH-4411', submittedOn: '2026-09-29', expectedVersion: 1 }).success).toBe(true);
    expect(RecordRtsSubmissionSchema.safeParse({ evidence: 'Uploaded in the RTS portal, confirmation on screen', submittedOn: '2026-09-29', expectedVersion: 1 }).success).toBe(true);
  });
});

describe('RTS FTPS upload rules', () => {
  const row = { clientNumber: 'NWF', invoiceNumber: 'INV-1001', debtorNumber: 'MC123456', debtorName: 'TQL', loadNumber: '98765', invoiceDate: '2026-10-19', amountCents: 215000 };
  it('writes the seven columns in RTS order with an MM/DD/YYYY date', () => {
    expect(rtsFtpRow(row)).toEqual(['NWF', 'INV-1001', 'MC123456', 'TQL', '98765', '10/19/2026', '2150.00']);
    expect(rtsFtpFileName(' INV-1001 ')).toBe('INV-1001.pdf');
  });
  it('refuses blanks, $0, duplicates and file-hostile numbers before anything is sent', () => {
    expect(rtsFtpProblems([row])).toEqual([]);
    const bad = rtsFtpProblems([row, { ...row }, { ...row, invoiceNumber: 'A/B', debtorNumber: '', amountCents: 0 }]);
    expect(bad.some((p) => p.includes('listed twice'))).toBe(true);
    expect(bad.some((p) => p.includes('DebtorNo is blank'))).toBe(true);
    expect(bad.some((p) => p.includes('more than $0'))).toBe(true);
    expect(bad.some((p) => p.includes('file name'))).toBe(true);
  });
  it('keeps five minutes between two submissions', () => {
    const now = new Date('2026-10-19T15:00:00Z');
    expect(rtsFtpWaitMinutes(null, now)).toBe(0);
    expect(rtsFtpWaitMinutes('2026-10-19T14:58:00Z', now)).toBe(3);
    expect(rtsFtpWaitMinutes('2026-10-19T14:54:00Z', now)).toBe(0);
  });
});
