import { revisionInvoiceNumber } from './invoice-revision.js';
import { z } from 'zod';

/**
 * Billing (§3, §4): which queue a load sits in, what blocks its invoice, how a rate
 * confirmation is checked against the load, and how an invoice family carries revisions.
 *
 * Every status here is derived from conditions on the record - never stored as a word somebody
 * could set - so the tab a load appears in is always the truth about its documents and checks.
 */

// ------------------------------------------------------------------ the load as billing sees it

export interface BillableDocument {
  id: string;
  type: string;
  status: string;
  review?: string;
  title?: string;
  /** Why it was rejected, when it was. */
  rejectedReason?: string | null;
  /** Set once a later file replaced this one; a replaced file no longer counts. */
  supersededBy?: string | null;
  fileHash?: string | null;
  fileName?: string;
  uploadedAt: string;
  /** `driver_app` for a file the driver sent from the phone (0081); absent = the office. */
  source?: string | null;
  /** The broker reference a person or an extractor read off the document; null = not read. */
  extractedReference?: string | null;
  /** How the reference was read: a person typed it, or an extractor did. Uncertain = review. */
  extractionConfidence?: 'person' | 'extracted' | 'uncertain' | null;
}

export interface BillableLoad {
  id: string;
  loadNumber: string;
  status: string;
  brokerReference: string | null;
  customerId: string | null;
  brokerId: string | null;
  customerName: string;
  brokerName: string | null;
  rate: number;
  documents: BillableDocument[];
  charges: Array<{ id: string; type: string; description: string; amount: number; billable: boolean; status?: string }>;
  stops: Array<{ kind: string; status: string }>;
  cancellation?: { outcome: string; fee: number | null; at?: string | null } | null;
  invoiceId?: string | null;
  openFlags?: number;
  deliveredAt?: string | null;
  updatedAt: string;
}

export interface BillingInvoiceLike {
  id: string;
  loadId: string | null;
  family: string;
  revision: number;
  isCurrent: boolean;
  status: string;
  submission?: { status: string; issues?: string[] } | null;
  /** A supplemental invoice (INV-10004-S1): billed after the load's own invoice, never "the" invoice of the load. */
  supplement?: boolean;
}

export const BILLING_QUEUES = ['needs_documents', 'needs_review', 'ready_to_bill', 'ready_to_submit', 'submission_issues', 'revisions'] as const;
export type BillingQueue = (typeof BILLING_QUEUES)[number];

export const BILLING_QUEUE_LABEL: Record<BillingQueue, string> = {
  needs_documents: 'Needs documents',
  needs_review: 'Needs review',
  ready_to_bill: 'Ready to bill',
  ready_to_submit: 'Ready to submit',
  submission_issues: 'Submission issues',
  revisions: 'Revisions',
};

export interface BillingCondition {
  code: string;
  message: string;
  /** Where to fix it. */
  fix: 'documents' | 'review' | 'load' | 'invoice' | 'flags';
}

export interface BillingVerdict {
  loadId: string;
  queue: BillingQueue | null;
  conditions: BillingCondition[];
  /** RC check result, for the side-by-side panel. */
  rc: RcCheck;
  /** True when TONU: cancellation evidence stands in for the POD. */
  tonu: boolean;
}

// ------------------------------------------------------------------ RC reference validation

/**
 * Conservative normalisation: trims, upper-cases, drops spaces and the common separators
 * (`-`, `/`, `#`, `.`) so `BR-8801` equals `br 8801`, but never touches leading zeros or letters
 * - `0034` and `34` stay different, because a broker's system may treat them so.
 */
export function normalizeReference(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s\-/#.]+/g, '');
}

export type RcCheckState = 'match' | 'mismatch' | 'unreadable' | 'missing' | 'no_reference_on_load' | 'duplicate';

export interface RcCheck {
  state: RcCheckState;
  loadReference: string | null;
  rcReference: string | null;
  documentId: string | null;
  /** The other load(s) the same file is filed on, when `duplicate`. */
  duplicateOf: string[];
  message: string;
}

/**
 * Checks the rate confirmation on a load against the load's broker reference (§4).
 *
 * `hashesElsewhere` says which other loads already carry a file with the same hash, so a reused
 * RC is caught by identity, not by eye. A revised RC on the *same* load is not a duplicate.
 */
export function checkRateConfirmation(load: BillableLoad, hashesElsewhere: (hash: string) => string[]): RcCheck {
  // The RC compared is the newest current file; a replaced one is history, not evidence.
  const rcs = load.documents.filter((d) => d.type === 'rate_confirmation' && d.status !== 'missing' && !d.supersededBy && d.review !== 'rejected');
  const rc = rcs.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))[0] ?? null;
  const loadRef = load.brokerReference?.trim() || null;
  if (!rc) return { state: 'missing', loadReference: loadRef, rcReference: null, documentId: null, duplicateOf: [], message: 'No rate confirmation on file.' };
  const dup = rc.fileHash ? hashesElsewhere(rc.fileHash).filter((id) => id !== load.id) : [];
  if (dup.length > 0) {
    return { state: 'duplicate', loadReference: loadRef, rcReference: rc.extractedReference ?? null, documentId: rc.id, duplicateOf: dup, message: `This file is also filed on ${dup.length} other load${dup.length === 1 ? '' : 's'}. A multi-load RC needs a reviewed mapping.` };
  }
  if (!loadRef) return { state: 'no_reference_on_load', loadReference: null, rcReference: rc.extractedReference ?? null, documentId: rc.id, duplicateOf: [], message: 'The load has no broker reference to compare with.' };
  if (!rc.extractedReference || rc.extractionConfidence === 'uncertain') {
    return { state: 'unreadable', loadReference: loadRef, rcReference: rc.extractedReference ?? null, documentId: rc.id, duplicateOf: [], message: 'The reference on the RC has not been read with confidence. Read it off the document and record it.' };
  }
  if (normalizeReference(rc.extractedReference) === normalizeReference(loadRef)) {
    return { state: 'match', loadReference: loadRef, rcReference: rc.extractedReference, documentId: rc.id, duplicateOf: [], message: 'The RC reference matches the load.' };
  }
  return { state: 'mismatch', loadReference: loadRef, rcReference: rc.extractedReference, documentId: rc.id, duplicateOf: [], message: `The RC says ${rc.extractedReference}; the load says ${loadRef}. Billing is blocked until somebody resolves it.` };
}

// ------------------------------------------------------------------ the queue

export interface BillingContext {
  invoices: BillingInvoiceLike[];
  hashesElsewhere: (hash: string) => string[];
  /** Resolved exceptions (RC mismatch etc.) that an authorised person recorded, by load. */
  resolvedExceptions: (loadId: string) => Array<{ kind: string }>;
}

const DONE = new Set(['delivered', 'closed']);

/** The queue a load belongs in, and every condition that put it there or keeps it out (§3). */
export function billingVerdict(load: BillableLoad, ctx: BillingContext): BillingVerdict {
  const tonu = load.status === 'tonu' || load.cancellation?.outcome === 'tonu';
  const invoice = ctx.invoices.find((i) => i.loadId === load.id && i.isCurrent && !i.supplement) ?? null;
  const rc = checkRateConfirmation(load, ctx.hashesElsewhere);
  const resolved = new Set(ctx.resolvedExceptions(load.id).map((e) => e.kind));
  const conditions: BillingCondition[] = [];

  // Not billable at all: still rolling, or cancelled without a fee.
  if (!tonu && !DONE.has(load.status)) return { loadId: load.id, queue: null, conditions: [{ code: 'not_delivered', message: 'The load is not delivered yet.', fix: 'load' }], rc, tonu };
  if (load.status === 'cancelled' && !tonu) return { loadId: load.id, queue: null, conditions: [{ code: 'cancelled', message: 'Cancelled without a fee: nothing to bill.', fix: 'load' }], rc, tonu };

  // Already invoiced: the queue is about the invoice now.
  if (invoice) {
    if (invoice.submission?.status === 'rejected' || (invoice.submission?.issues?.length ?? 0) > 0) {
      return { loadId: load.id, queue: 'submission_issues', conditions: (invoice.submission?.issues ?? ['Submission rejected']).map((m) => ({ code: 'submission', message: m, fix: 'invoice' as const })), rc, tonu };
    }
    if (invoice.revision > 1 && invoice.status === 'draft') return { loadId: load.id, queue: 'revisions', conditions: [{ code: 'revision_draft', message: `Revision R${invoice.revision} is a draft.`, fix: 'invoice' }], rc, tonu };
    if (invoice.status === 'draft') return { loadId: load.id, queue: 'ready_to_bill', conditions: [{ code: 'draft', message: 'Draft invoice waiting to be issued.', fix: 'invoice' }], rc, tonu };
    if (invoice.status === 'issued' && (!invoice.submission || invoice.submission.status === 'prepared')) return { loadId: load.id, queue: 'ready_to_submit', conditions: [], rc, tonu };
    return { loadId: load.id, queue: null, conditions: [], rc, tonu };
  }

  // Documents first. Only current files count: not replaced, and not rejected - a rejected POD
  // is not proof of delivery, it is a request for a new one.
  const current = load.documents.filter((d) => d.status !== 'missing' && !d.supersededBy);
  const pods = current.filter((d) => d.type === 'pod' && d.review !== 'rejected');
  const rejected = current.filter((d) => (d.type === 'rate_confirmation' || d.type === 'bol' || d.type === 'pod') && d.review === 'rejected');
  for (const d of rejected) {
    const reason = d.rejectedReason;
    const name = d.type === 'rate_confirmation' ? 'RC' : d.type === 'bol' ? 'BOL' : 'POD';
    conditions.push({ code: 'document_rejected', message: `${name} rejected${reason ? `: ${reason}` : ''}. Upload a replacement.`, fix: 'documents' });
  }
  const deliveries = load.stops.filter((s) => s.kind === 'delivery');
  if (rc.state === 'missing') conditions.push({ code: 'rc_missing', message: rc.message, fix: 'documents' });
  if (tonu) {
    // A TONU bills on the broker's TONU confirmation - or the revised rate confirmation the broker
    // sends with the TONU amount (owner, 2026-10-15) - never on a BOL or a POD.
    const cancelledAt = load.cancellation?.at ?? null;
    const evidence = load.documents.some(
      (d) =>
        d.status !== 'missing' &&
        (d.type === 'tonu' || d.type === 'other' || (d.type === 'rate_confirmation' && cancelledAt !== null && d.uploadedAt > cancelledAt)),
    );
    if (!evidence) conditions.push({ code: 'tonu_evidence_missing', message: 'A TONU needs the broker’s TONU confirmation or a revised rate confirmation on file.', fix: 'documents' });
    if (load.cancellation?.fee === null || load.cancellation?.fee === undefined) conditions.push({ code: 'tonu_fee_missing', message: 'The TONU fee is not recorded.', fix: 'load' });
  } else if (pods.length < Math.max(1, deliveries.length)) {
    conditions.push({ code: 'pod_missing', message: `${pods.length} of ${Math.max(1, deliveries.length)} proof${deliveries.length === 1 ? '' : 's'} of delivery on file.`, fix: 'documents' });
  }
  if (conditions.length > 0) return { loadId: load.id, queue: 'needs_documents', conditions, rc, tonu };

  // Then review: a reused RC file, open flags, drafted charges. Documents on file are enough and
  // the RC reference is not compared - RTS checks both (owner, 2026-10-16); a rejected file still
  // asks for a replacement above.
  if (rc.state === 'duplicate' && !resolved.has('rc_duplicate')) conditions.push({ code: 'rc_duplicate', message: rc.message, fix: 'review' });
  if ((load.openFlags ?? 0) > 0) conditions.push({ code: 'open_flag', message: 'An open flag says this load needs a person first.', fix: 'flags' });
  const drafts = load.charges.filter((c) => c.status === 'draft');
  if (drafts.length > 0) conditions.push({ code: 'charges_drafted', message: `${drafts.length} drafted accessorial${drafts.length === 1 ? '' : 's'} to accept or drop.`, fix: 'load' });
  // Paperwork the driver sent from the phone (0081) is looked at by a person before it is billed:
  // received from the app and nobody has reviewed it yet. Office uploads keep the 2026-10-16 rule.
  const fromApp = current.filter((d) => d.source === 'driver_app' && (d.type === 'pod' || d.type === 'bol' || d.type === 'lumper_receipt') && (d.review ?? 'received') === 'received');
  for (const d of fromApp) {
    const name = d.type === 'pod' ? 'POD' : d.type === 'bol' ? 'BOL' : 'Lumper receipt';
    conditions.push({ code: 'driver_document_unreviewed', message: `${name} from the driver app received: review it (Mark reviewed, or Request correction).`, fix: 'review' });
  }
  if (conditions.length > 0) return { loadId: load.id, queue: 'needs_review', conditions, rc, tonu };

  return { loadId: load.id, queue: 'ready_to_bill', conditions: [], rc, tonu };
}

/** The lines an invoice for this load would carry: linehaul (or the TONU fee) plus accepted billable accessorials. */
export function invoiceLinesFor(load: BillableLoad): Array<{ chargeType: string; description: string; amount: number; loadChargeId: string | null }> {
  if (load.status === 'tonu' || load.cancellation?.outcome === 'tonu') {
    return [{ chargeType: 'tonu', description: `TONU · ${load.loadNumber}`, amount: load.cancellation?.fee ?? 0, loadChargeId: null }];
  }
  const linehaul = load.charges.find((c) => c.type === 'linehaul');
  const lines = [{ chargeType: 'linehaul', description: `Linehaul · ${load.loadNumber}`, amount: linehaul?.amount ?? load.rate, loadChargeId: linehaul?.id ?? null }];
  for (const c of load.charges) {
    if (c.type === 'linehaul' || !c.billable) continue;
    if (c.status === 'draft' || c.status === 'dropped') continue;
    lines.push({ chargeType: c.type, description: c.description, amount: c.amount, loadChargeId: c.id });
  }
  return lines;
}

// ------------------------------------------------------------------ invoice families and revisions

/**
 * `INV-10452` → `INV2-10452` → `INV3-10452`; the family is the original number.
 *
 * Kept under its old name for the callers that use it; the rule itself lives beside the rest of
 * the revision rules. Revisions already issued as `-R2` keep the number they were issued with.
 */
export function revisionNumber(family: string, revision: number): string {
  return revisionInvoiceNumber(family, revision);
}

export const ReviseInvoiceSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  lines: z.array(z.object({ chargeType: z.string().min(1), description: z.string().trim().min(1).max(200), amount: z.number().finite() })).min(1),
  expectedUpdatedAt: z.string().min(1),
});
export type ReviseInvoiceInput = z.infer<typeof ReviseInvoiceSchema>;

export const ResolveBillingExceptionSchema = z.object({
  kind: z.enum(['rc_mismatch', 'rc_unreadable', 'rc_duplicate', 'rc_no_reference']),
  reason: z.string().trim().min(3).max(500),
  /** The reference the person read off the document, when resolving unreadable/mismatch. */
  rcReference: z.string().trim().max(80).optional(),
  evidenceFileId: z.string().optional(),
});
export type ResolveBillingExceptionInput = z.infer<typeof ResolveBillingExceptionSchema>;

/** Whether a non-accounting write to the load is refused because it is invoiced (§3). */
export function loadIsLocked(load: { invoiceId?: string | null }): boolean {
  return Boolean(load.invoiceId);
}
