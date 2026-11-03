import { describe, expect, it } from 'vitest';
import { attachDocumentPatch, currentDocuments, reviewPatch, ReviewDocumentSchema } from '../loads/documents.js';
import { billingVerdict, type BillableDocument, type BillableLoad, type BillingContext } from './billing.js';

/**
 * Document review for billing: uploaded is not reviewed, a review belongs to the file that was
 * looked at, a rejection says why, and reviewing a document never stands in for the RC checks.
 */
const actor = { id: 'u1', name: 'Accounting Tester' };
const now = '2026-09-29T12:00:00.000Z';

const doc = (over: Partial<BillableDocument> & { id: string; type: string }): BillableDocument => ({
  status: 'pending',
  review: 'received',
  title: over.type,
  fileName: `${over.id}.pdf`,
  uploadedAt: '2026-09-28T10:00:00.000Z',
  ...over,
});

const load = (documents: BillableDocument[], over: Partial<BillableLoad> = {}): BillableLoad => ({
  id: 'ld_1', loadNumber: 'TEST-1', status: 'delivered', brokerReference: 'REF-1', customerId: 'c', brokerId: 'b',
  customerName: 'Broker', brokerName: 'Broker', rate: 3000, documents,
  charges: [{ id: 'c1', type: 'linehaul', description: 'Linehaul', amount: 3000, billable: true }],
  stops: [{ kind: 'pickup', status: 'completed' }, { kind: 'delivery', status: 'completed' }],
  updatedAt: now, ...over,
});

const ctx: BillingContext = { invoices: [], hashesElsewhere: () => [], resolvedExceptions: () => [] };
const rcOk = { extractedReference: 'REF-1', extractionConfidence: 'person' as const };

describe('reviewing one file', () => {
  it('a rejection needs a reason', () => {
    expect(ReviewDocumentSchema.safeParse({ review: 'rejected', expectedUpdatedAt: now }).success).toBe(false);
    expect(ReviewDocumentSchema.safeParse({ review: 'rejected', reason: 'Unsigned', expectedUpdatedAt: now }).success).toBe(true);
    expect(reviewPatch({ review: 'received', status: 'pending' }, 'rejected', actor, now, '')).toEqual({ refusal: 'A rejection needs a reason.' });
  });

  it('records who rejected it, when, and why', () => {
    expect(reviewPatch({ review: 'received', status: 'pending' }, 'rejected', actor, now, 'Signature missing')).toEqual({ review: 'rejected', rejectedReason: 'Signature missing', reviewedBy: 'Accounting Tester', reviewedAt: now });
  });

  it('a rejected file cannot then be marked reviewed; its replacement is reviewed instead', () => {
    const r = reviewPatch({ review: 'rejected', status: 'pending' }, 'reviewed', actor, now);
    expect('refusal' in r && r.refusal).toMatch(/Upload a replacement/);
  });

  it('a replaced file cannot be reviewed', () => {
    const r = reviewPatch({ review: 'received', status: 'pending', supersededBy: 'doc_2' }, 'reviewed', actor, now);
    expect('refusal' in r && r.refusal).toMatch(/Review the replacement/);
  });
});

describe('replacing a file', () => {
  const base = { loadNumber: 'TEST-1', documents: [{ id: 'doc_1', type: 'pod', title: 'POD', fileName: 'old.pdf', uploadedAt: now, uploadedBy: 'x', status: 'pending', review: 'reviewed' }] } as never;
  const file = { type: 'pod' as const, fileName: 'new.pdf', sizeBytes: 1, mimeType: 'application/pdf', fileUrl: '/f', fileId: 'f' };

  it('starts the replacement unreviewed and stops counting the old one', () => {
    const { documents, document } = attachDocumentPatch(base, { ...file, replacesId: 'doc_1' }, actor, '2026-09-29T13:00:00.000Z');
    expect(document.review).toBe('received');
    const old = documents.find((d) => d.id === 'doc_1') as { supersededBy?: string };
    expect(old.supersededBy).toBe(document.id);
    expect(currentDocuments(documents as never).map((d: { id: string }) => d.id)).toEqual([document.id]);
  });

  it('a new upload answers a rejected file for the same stop without being told', () => {
    const rejected = { loadNumber: 'TEST-1', documents: [{ id: 'doc_1', type: 'pod', title: 'POD', fileName: 'old.pdf', uploadedAt: now, uploadedBy: 'x', status: 'pending', review: 'rejected' }] } as never;
    const { documents, document } = attachDocumentPatch(rejected, file, actor, '2026-09-29T13:00:00.000Z');
    expect((documents.find((d) => d.id === 'doc_1') as { supersededBy?: string }).supersededBy).toBe(document.id);
  });

  it('a second POD for another delivery replaces nothing', () => {
    const { documents } = attachDocumentPatch(base, file, actor, '2026-09-29T13:00:00.000Z');
    expect(documents.filter((d) => !(d as { supersededBy?: string }).supersededBy)).toHaveLength(2);
  });
});

describe('billing reads the current files', () => {
  // Uploaded is enough: RTS checks the documents (owner, 2026-10-16).
  it('uploaded RC and POD make the load ready without a review', () => {
    const v = billingVerdict(load([doc({ id: 'rc', type: 'rate_confirmation', ...rcOk }), doc({ id: 'pod', type: 'pod' })]), ctx);
    expect(v.queue).toBe('ready_to_bill');
  });

  it('reviewed RC and POD make the load ready', () => {
    const v = billingVerdict(load([doc({ id: 'rc', type: 'rate_confirmation', review: 'reviewed', ...rcOk }), doc({ id: 'pod', type: 'pod', review: 'reviewed' })]), ctx);
    expect(v.queue).toBe('ready_to_bill');
  });

  it('a replaced POD counts through its replacement', () => {
    const v = billingVerdict(load([
      doc({ id: 'rc', type: 'rate_confirmation', review: 'reviewed', ...rcOk }),
      doc({ id: 'pod_old', type: 'pod', review: 'reviewed', supersededBy: 'pod_new' }),
      doc({ id: 'pod_new', type: 'pod' }),
    ]), ctx);
    expect(v.queue).toBe('ready_to_bill');
  });

  it('a rejected POD is not proof of delivery, and says why', () => {
    const v = billingVerdict(load([doc({ id: 'rc', type: 'rate_confirmation', review: 'reviewed', ...rcOk }), doc({ id: 'pod', type: 'pod', review: 'rejected', rejectedReason: 'Unsigned', title: 'POD' })]), ctx);
    expect(v.queue).toBe('needs_documents');
    expect(v.conditions.map((c) => c.message).join(' ')).toMatch(/POD rejected: Unsigned/);
  });

  // The RC reference is not compared any more; RTS checks it (owner, 2026-10-16).
  it('a different reference on the RC does not block billing', () => {
    const v = billingVerdict(load([doc({ id: 'rc', type: 'rate_confirmation', extractedReference: 'OTHER-9', extractionConfidence: 'person' }), doc({ id: 'pod', type: 'pod' })]), ctx);
    expect(v.queue).toBe('ready_to_bill');
  });

  it('a reused RC file still blocks', () => {
    const v = billingVerdict(load([doc({ id: 'rc', type: 'rate_confirmation', review: 'verified', fileHash: 'h1', ...rcOk }), doc({ id: 'pod', type: 'pod', review: 'verified' })]), { ...ctx, hashesElsewhere: () => ['ld_other'] });
    expect(v.conditions.map((c) => c.code)).toContain('rc_duplicate');
  });
});
