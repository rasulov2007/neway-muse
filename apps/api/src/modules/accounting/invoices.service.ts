import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  AccountingSettingsSchema,
  AddChargeAfterInvoicingSchema,
  supplementEligibility,
  supplementInvoiceNumber,
  supplementNote,
  proofDocumentType,
  BILLING_QUEUES,
  CreateRevisionSchema,
  revisionBalance,
  revisionPosting,
  buildEntry,
  billingVerdict,
  checkApplication,
  checkFunding,
  invoiceLinesFor,
  postInvoiceIssued,
  postInvoiceVoid,
  postPaymentReceived,
  revisionNumber,
  type AccountingSettings,
  type BillableLoad,
  type BillingQueue,
  type BillingVerdict,
  type RecordFundingInput,
  type ResolveBillingExceptionInput,
  type StoredLoad,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { hasPermission } from '../../common/auth/principal';
import { AuditService } from '../people/audit.service';
import { LoadsService } from '../loads/loads.service';
import { forbidden, newId, unprocessable } from '../dispatch-board/ops.helpers';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { companies } from '../../database/schema';
import { FilesService } from '../files/files.service';
import { ExportsService } from './exports.service';
import { LedgerService } from './ledger.service';
import { AccountingStore, type Stored } from './store.service';

/**
 * Invoices, the billing queue, RC validation, revisions, payments and RTS fundings (§3–§5).
 *
 * An invoice is created from a delivered load once its documents and checks pass; from then
 * on the load's billed facts are Accounting's (the loads service refuses other writes). Every
 * status a queue shows is derived from the record, and every money move posts to the ledger
 * through the one commit.
 */

export interface InvoiceLineRecord {
  id: string;
  invoiceId: string;
  loadId: string | null;
  loadChargeId?: string | null;
  chargeType: string;
  description: string;
  quantity: number;
  rate: number;
  amount: number;
  /** The load's documents behind this charge - a broker's detention approval, a lumper receipt. */
  supportingDocuments?: Array<{ id: string; type: string; fileName: string }>;
}

/** A note for Accounting's eyes only: never printed, packaged, scheduled or emailed. */
export interface InternalNote {
  id: string;
  text: string;
  by: string;
  at: string;
  /** Every earlier wording, kept when the note is edited. */
  edits: Array<{ text: string; by: string; at: string }>;
}

export interface InvoiceRecord {
  id: string;
  invoiceNumber: string;
  family: string;
  revision: number;
  isCurrent: boolean;
  supersedesId: string | null;
  sourceKey: string;
  loadId: string;
  loadNumber: string;
  billToType: 'customer' | 'broker';
  billToId: string;
  billToName: string;
  issuedOn: string | null;
  dueOn: string | null;
  paymentTermsDays: number;
  subtotal: number;
  total: number;
  paid: number;
  balance: number;
  status: string;
  agingDays: number;
  agingBucket: string;
  paidOn: string | null;
  disputeReason: string | null;
  lines: InvoiceLineRecord[];
  /** The exact documents this invoice was issued with: ids and hashes, frozen at issue. */
  documentPackage: Array<{ id: string; type: string; fileHash: string | null; fileName: string }>;
  rc: { loadReference: string | null; rcReference: string | null; state: string } | null;
  /**
   * What has actually happened with the factoring provider.
   *
   * `status` is a claim about the outside world, so it carries how we know. `prepared` means an
   * export exists here and nothing has left the building. `submitted` and `accepted` mean a person
   * saw the provider say so, and `evidence` records what they saw — a provider reference, or a
   * file. `simulated` marks a rehearsal: an internal test event that must never be read as a real
   * submission, a real acceptance or real money.
   */
  submission: {
    provider: string;
    status: 'prepared' | 'submitted' | 'accepted' | 'rejected';
    reference: string | null;
    at: string | null;
    issues: string[];
    by: string | null;
    evidence: { kind: 'none' | 'provider_reference' | 'file'; detail: string | null } | null;
    simulated: boolean;
  } | null;
  factoring: { billViaFactoring: boolean; fundedGross: number; feeCents: number; reserveCents: number; fundingIds: string[] };
  revisions: Array<{ revision: number; invoiceId: string; invoiceNumber: string; at: string; by: string; reason: string; delta: number; total: number }>;
  history: Array<{ at: string; by: string; action: string; detail: string }>;
  /**
   * Printed on the invoice and in the RTS package. On an issued invoice it can change only by a
   * revision, because the broker already has the version that carried the old wording.
   */
  invoiceNote?: string | null;
  /** Accounting's own notes. Never on a PDF, a schedule, a manifest, a package or an email. */
  internalNotes?: InternalNote[];
  /** The draft revision in progress for this invoice, if any: one at a time per family. */
  draftRevisionId?: string | null;
  /** On a revision: why, what it replaced, and the money either side of it. */
  revisionOf?: { invoiceId: string; invoiceNumber: string; originalInvoiceNumber: string; reason: string; previousTotal: number; adjustment: number; revisedOn: string | null } | null;
  /** What RTS already had of the previous version, carried onto the revision so it is never lost. */
  priorSubmission?: { invoiceNumber: string; status: string; reference: string | null; at: string | null; fundedGross: number } | null;
  /** A credit owed to the customer when a revision lowered the total below what was paid. */
  creditBalance?: number;
  /**
   * The PDF exactly as it was issued, kept in the file store. An issued invoice is served from
   * these bytes from then on, so a later payment or a revision never changes the document the
   * broker was sent.
   */
  issuedPdf?: { fileId: string; sha256: string; at: string } | null;
  /** The RTS batch holding this invoice, when one is. */
  rtsBatch?: { batchId: string; batchNumber: string } | null;
  /**
   * On a supplemental invoice (INV-10004-S1): the invoice it adds to. The original was already
   * sent to RTS (or funded) and is never changed; this one carries the charges that came after.
   */
  supplementOf?: { invoiceId: string; invoiceNumber: string; family: string; sequence: number; reason: string; requestKey: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentRecord {
  id: string;
  sourceKey: string;
  direction: 'in' | 'out';
  partyType: string;
  partyId: string;
  partyName: string;
  amount: number;
  method: string;
  receivedOn: string;
  reference: string;
  unappliedAmount: number;
  applications: Array<{ id: string; paymentId: string; invoiceId: string | null; billId: string | null; amount: number; appliedAt: string }>;
  notes: string | null;
  createdAt: string;
  createdBy: string;
  funding?: { provider: string; feeCents: number; reserveCents: number; extraFees: Array<{ label: string; amountCents: number }>; netReceivedCents: number; grossCents: number } | null;
}

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly store: AccountingStore,
    private readonly ledger: LedgerService,
    private readonly loads: LoadsService,
    private readonly audit: AuditService,
    private readonly exportsService: ExportsService,
    private readonly files: FilesService,
  ) {}

  /** Called after an invoice changes state (issued, submitted, funded, disputed): the completion pipeline listens. */
  readonly afterChange: Array<(principal: Principal, loadId: string) => Promise<void>> = [];
  private async notifyChange(principal: Principal, loadId: string | null | undefined): Promise<void> {
    if (!loadId) return;
    for (const listener of this.afterChange) {
      try {
        await listener(principal, loadId);
      } catch {
        // The listener records its own failure; the invoice write stands.
      }
    }
  }

  clock: () => Date = () => new Date();

  async settings(companyId: string): Promise<AccountingSettings> {
    const raw = await this.store.settings(companyId);
    return AccountingSettingsSchema.parse(raw.record);
  }

  // ------------------------------------------------------------ reads

  async list(principal: Principal): Promise<InvoiceRecord[]> {
    return (await this.store.list<InvoiceRecord>('acct_invoices', principal.companyId)).map((r) => r.record);
  }

  async get(principal: Principal, id: string): Promise<InvoiceRecord> {
    const rows = await this.store.list<InvoiceRecord>('acct_invoices', principal.companyId, sql`(id = ${id} or invoice_number = ${id})`);
    if (!rows[0]) throw unprocessable(`Invoice ${id} is not on file.`);
    return rows[0].record;
  }

  async payments(principal: Principal): Promise<PaymentRecord[]> {
    return (await this.store.list<PaymentRecord>('acct_payments', principal.companyId)).map((r) => r.record);
  }

  /** The loads as billing sees them, with RC readings and open flags overlaid. */
  private async billableLoads(principal: Principal): Promise<BillableLoad[]> {
    const [loads, exceptions, flags] = await Promise.all([
      this.loads.list(principal, { includeDemo: false }),
      this.store.list<{ loadId: string; kind: string; status: string; documentId?: string; rcReference?: string; confidence?: string }>('acct_billing_exceptions', principal.companyId),
      this.store.db.execute(sql`select load_id, count(*)::int as n from load_problems where company_id = ${principal.companyId} and closed_at is null group by load_id`) as unknown as Promise<Array<{ load_id: string; n: number }>>,
    ]);
    const flagsByLoad = new Map((await flags).map((f) => [f.load_id, Number(f.n)]));
    const readings = exceptions.filter((e) => e.record.kind === 'rc_reading').map((e) => e.record);
    return loads.map((l) => this.toBillable(l, readings, flagsByLoad.get(l.id) ?? 0));
  }

  private toBillable(l: StoredLoad, readings: Array<{ loadId: string; documentId?: string; rcReference?: string; confidence?: string }>, openFlags: number): BillableLoad {
    const r = l as StoredLoad & Record<string, unknown>;
    const docs = (l.documents ?? []).map((d) => {
      const reading = readings.find((x) => x.loadId === l.id && x.documentId === d.id);
      const extra = d as unknown as Record<string, unknown>;
      return {
        id: d.id,
        type: d.type,
        status: d.status,
        review: d.review,
        // What the review screen shows and what billing decides by: who looked, when, why it was
        // rejected, and whether a later file replaced this one.
        title: d.title,
        reviewedBy: d.reviewedBy ?? null,
        reviewedAt: (extra['reviewedAt'] as string | undefined) ?? null,
        verifiedBy: d.verifiedBy ?? null,
        verifiedAt: d.verifiedAt ?? null,
        rejectedReason: (extra['rejectedReason'] as string | undefined) ?? null,
        supersededBy: (extra['supersededBy'] as string | undefined) ?? null,
        stopId: (extra['stopId'] as string | undefined) ?? null,
        // driver_app for a paper the driver sent from the phone (0081): billing asks for a review first.
        source: (extra['source'] as string | undefined) ?? null,
        fileId: (extra['fileId'] as string | undefined) ?? null,
        uploadedBy: d.uploadedBy,
        fileHash: d.fileHash ?? null,
        fileName: d.fileName,
        fileUrl: ((d as unknown as Record<string, unknown>)['fileUrl'] as string | undefined) ?? null,
        mimeType: ((d as unknown as Record<string, unknown>)['mimeType'] as string | undefined) ?? null,
        uploadedAt: d.uploadedAt,
        extractedReference: reading?.rcReference ?? null,
        extractionConfidence: reading ? ((reading.confidence as 'person' | 'extracted' | 'uncertain') ?? 'person') : null,
      };
    });
    return {
      id: l.id,
      loadNumber: l.loadNumber,
      status: l.status,
      brokerReference: (r['brokerReference'] as string | null) ?? null,
      customerId: (r['customerId'] as string | null) ?? null,
      brokerId: (r['brokerId'] as string | null) ?? null,
      customerName: (r['customerName'] as string) ?? '',
      brokerName: (r['brokerName'] as string | null) ?? null,
      rate: Number(r['rate']) || 0,
      documents: docs,
      charges: ((r['charges'] as BillableLoad['charges']) ?? []).map((c) => ({ id: c.id, type: c.type, description: c.description, amount: c.amount, billable: c.billable, status: c.status })),
      stops: (l.stops ?? []).map((s) => ({ id: s.id, kind: s.kind, status: s.status, facilityName: s.facilityName, city: s.city, state: s.state })),
      cancellation: l.cancellation ? { outcome: l.cancellation.outcome, fee: l.cancellation.fee, at: (l.cancellation as { at?: string | null }).at ?? null } : null,
      invoiceId: (r['invoiceId'] as string | null) ?? null,
      openFlags,
      deliveredAt: l.deliveredAt,
      updatedAt: l.updatedAt,
    };
  }

  private context(loads: BillableLoad[], invoices: InvoiceRecord[], exceptions: Array<{ loadId: string; kind: string; status: string }>) {
    const hashIndex = new Map<string, Set<string>>();
    // Only current RC files: a file a load has since replaced is no evidence of reuse.
    for (const l of loads) for (const d of l.documents) if (d.type === 'rate_confirmation' && d.fileHash && !d.supersededBy) (hashIndex.get(d.fileHash) ?? hashIndex.set(d.fileHash, new Set()).get(d.fileHash)!).add(l.id);
    return {
      invoices: invoices.map((i) => ({ id: i.id, loadId: i.loadId, family: i.family, revision: i.revision, isCurrent: i.isCurrent, status: i.status, submission: i.submission ? { status: i.submission.status, issues: i.submission.issues } : null, supplement: Boolean(i.supplementOf) })),
      hashesElsewhere: (hash: string) => [...(hashIndex.get(hash) ?? [])],
      resolvedExceptions: (loadId: string) => exceptions.filter((e) => e.loadId === loadId && e.status === 'resolved').map((e) => ({ kind: e.kind })),
    };
  }

  /** The billing queue (§3): every billable load with its verdict, plus the counts per tab. */
  async queue(principal: Principal): Promise<{ rows: Array<{ load: BillableLoad & { driverName: string | null; truckUnit: string | null; charges: BillableLoad['charges'] }; verdict: BillingVerdict; invoice: InvoiceRecord | null; supplements: InvoiceRecord[]; parentInvoice: InvoiceRecord | null }>; counts: Record<BillingQueue, number>; totals: Record<BillingQueue, number> }> {
    const [loads, invoices, exceptions, all] = await Promise.all([this.billableLoads(principal), this.list(principal), this.store.list<{ loadId: string; kind: string; status: string }>('acct_billing_exceptions', principal.companyId), this.loads.list(principal, { includeDemo: false })]);
    const ctx = this.context(loads, invoices, exceptions.map((e) => e.record));
    const rows = loads
      .map((load) => {
        const verdict = billingVerdict(load, ctx);
        const full = all.find((l) => l.id === load.id) as (StoredLoad & Record<string, unknown>) | undefined;
        // The load's own invoice; supplemental invoices (charges billed after it was sent) are listed beside it.
        const invoice = invoices.find((i) => i.loadId === load.id && i.isCurrent && !i.supplementOf) ?? null;
        const supplements = invoices.filter((i) => i.loadId === load.id && i.isCurrent && i.supplementOf && i.status !== 'void').sort((a, b) => (a.supplementOf!.sequence - b.supplementOf!.sequence));
        const base = { load: { ...load, driverName: (full?.['driverName'] as string | null) ?? null, truckUnit: (full?.['truckUnit'] as string | null) ?? null }, supplements };
        // Once the load's own invoice has gone, a supplemental invoice still to issue or to send
        // brings the load back to the queue - issued and sent to RTS exactly like any invoice.
        const pending = verdict.queue === null && invoice ? supplements.find((s) => s.status === 'draft' || (s.status === 'issued' && (!s.submission || s.submission.status === 'prepared'))) : undefined;
        if (pending) {
          const conditions = pending.status === 'draft' ? [{ code: 'supplement_draft', message: `Supplemental ${pending.invoiceNumber} waiting to be issued.`, fix: 'invoice' as const }] : [];
          return { ...base, verdict: { ...verdict, queue: (pending.status === 'draft' ? 'ready_to_bill' : 'ready_to_submit') as BillingQueue, conditions }, invoice: pending, parentInvoice: invoice };
        }
        return { ...base, verdict, invoice, parentInvoice: null as InvoiceRecord | null };
      })
      .filter((r) => r.verdict.queue !== null)
      .sort((a, b) => (b.load.deliveredAt ?? '').localeCompare(a.load.deliveredAt ?? ''));
    const counts = Object.fromEntries(BILLING_QUEUES.map((q) => [q, rows.filter((r) => r.verdict.queue === q).length])) as Record<BillingQueue, number>;
    const totals = Object.fromEntries(BILLING_QUEUES.map((q) => [q, money(rows.filter((r) => r.verdict.queue === q).reduce((s, r) => s + (r.parentInvoice && r.invoice ? r.invoice.total : invoiceLinesFor(r.load).reduce((a, l) => a + l.amount, 0)), 0))])) as Record<BillingQueue, number>;
    return { rows, counts, totals };
  }

  // ------------------------------------------------------------ RC readings and exceptions

  /** A person read the broker reference off the RC (or an extractor did): kept per document. */
  async recordRcReading(principal: Principal, loadId: string, input: { documentId: string; rcReference: string; confidence: 'person' | 'extracted' | 'uncertain' }) {
    const id = `rcr_${loadId}_${input.documentId}`;
    const existing = await this.store.find('acct_billing_exceptions', principal.companyId, id);
    const record = { id, loadId, kind: 'rc_reading', status: 'recorded', documentId: input.documentId, rcReference: input.rcReference.trim(), confidence: input.confidence, byId: principal.userId, byName: principal.userName ?? principal.userId, at: this.clock().toISOString() };
    if (existing) await this.store.update('acct_billing_exceptions', principal.companyId, id, existing.version, record);
    else await this.store.insert('acct_billing_exceptions', principal.companyId, record);
    await this.audit.write(principal, { action: 'rc_reference_recorded', entityType: 'load', entityId: loadId, entityLabel: loadId, summary: `RC reference read as ${input.rcReference} (${input.confidence}).`, changes: [] });
    return record;
  }

  /** Only Accounting resolves an exception, with a reason and, when the RC was re-read, the reference. */
  async resolveException(principal: Principal, loadId: string, input: ResolveBillingExceptionInput) {
    if (!hasPermission(principal, 'accounting.edit')) throw forbidden('Only Accounting can resolve a billing exception.');
    const id = `bex_${loadId}_${input.kind}`;
    const existing = await this.store.find('acct_billing_exceptions', principal.companyId, id);
    const record = { id, loadId, kind: input.kind, status: 'resolved', reason: input.reason, rcReference: input.rcReference ?? null, evidenceFileId: input.evidenceFileId ?? null, byId: principal.userId, byName: principal.userName ?? principal.userId, at: this.clock().toISOString() };
    if (existing) await this.store.update('acct_billing_exceptions', principal.companyId, id, existing.version, record);
    else await this.store.insert('acct_billing_exceptions', principal.companyId, record);
    await this.audit.write(principal, { action: 'billing_exception_resolved', entityType: 'load', entityId: loadId, entityLabel: loadId, summary: `${input.kind} resolved: ${input.reason}`, reason: input.reason, changes: [] });
    return record;
  }

  /** Replacing the RC voids the readings and resolutions for the old document: the checks run again. */
  async invalidateRcResolutions(principal: Principal, loadId: string): Promise<number> {
    const rows = await this.store.list<{ id: string; loadId: string; kind: string; status: string }>('acct_billing_exceptions', principal.companyId, sql`load_id = ${loadId} and status = 'resolved'`);
    for (const r of rows) await this.store.update('acct_billing_exceptions', principal.companyId, r.id, r.version, { ...r.record, status: 'superseded' });
    return rows.length;
  }

  // ------------------------------------------------------------ create, issue, void

  private async nextInvoiceNumber(companyId: string): Promise<string> {
    const rows = (await this.store.db.execute(sql`select max((regexp_match(family, '^INV-(\\d+)$'))[1]::int) as n from acct_invoices where company_id = ${companyId}`)) as unknown as Array<{ n: number | null }>;
    return `INV-${String((Number(rows[0]?.n) || 10_000) + 1)}`;
  }

  /** Drafts for the selected loads. Idempotent: a load already invoiced (source key) returns its invoice. */
  async createFromLoads(principal: Principal, loadIds: string[]): Promise<{ created: InvoiceRecord[]; skipped: Array<{ loadId: string; reason: string }> }> {
    const [loads, invoices, exceptions, settings] = await Promise.all([this.billableLoads(principal), this.list(principal), this.store.list<{ loadId: string; kind: string; status: string }>('acct_billing_exceptions', principal.companyId), this.settings(principal.companyId)]);
    const ctx = this.context(loads, invoices, exceptions.map((e) => e.record));
    const created: InvoiceRecord[] = [];
    const skipped: Array<{ loadId: string; reason: string }> = [];
    for (const loadId of loadIds) {
      const load = loads.find((l) => l.id === loadId);
      if (!load) {
        skipped.push({ loadId, reason: 'Not on file' });
        continue;
      }
      const verdict = billingVerdict(load, ctx);
      const already = invoices.find((i) => i.loadId === loadId && i.isCurrent && !i.supplementOf);
      if (already) {
        skipped.push({ loadId, reason: `Already on ${already.invoiceNumber}` });
        continue;
      }
      if (verdict.queue !== 'ready_to_bill') {
        skipped.push({ loadId, reason: verdict.conditions.map((c) => c.message).join(' ') || `In ${verdict.queue}` });
        continue;
      }
      const now = this.clock().toISOString();
      const number = await this.nextInvoiceNumber(principal.companyId);
      const id = newId('inv');
      const lines = invoiceLinesFor(load).map((l, i) => ({ id: `${id}_l${i + 1}`, invoiceId: id, loadId, loadChargeId: l.loadChargeId, chargeType: l.chargeType, description: l.description, quantity: 1, rate: l.amount, amount: money(l.amount) }));
      const total = money(lines.reduce((s, l) => s + l.amount, 0));
      const billToBroker = Boolean(load.brokerId || load.brokerName);
      const record: InvoiceRecord = {
        id,
        invoiceNumber: number,
        family: number,
        revision: 1,
        isCurrent: true,
        supersedesId: null,
        sourceKey: `load:${loadId}:r1`,
        loadId,
        loadNumber: load.loadNumber,
        billToType: billToBroker ? 'broker' : 'customer',
        billToId: (billToBroker ? load.brokerId : load.customerId) ?? '',
        billToName: billToBroker ? (load.brokerName ?? load.customerName) : load.customerName,
        issuedOn: null,
        dueOn: null,
        paymentTermsDays: settings.defaultPaymentTermsDays,
        subtotal: total,
        total,
        paid: 0,
        balance: total,
        status: 'draft',
        agingDays: 0,
        agingBucket: 'current',
        paidOn: null,
        disputeReason: null,
        lines,
        // The files the invoice is issued with are the current ones: not replaced, not rejected.
        documentPackage: load.documents.filter((d) => d.status !== 'missing' && !d.supersededBy && d.review !== 'rejected').map((d) => ({ id: d.id, type: d.type, fileHash: d.fileHash ?? null, fileName: d.fileName ?? '' })),
        rc: { loadReference: verdict.rc.loadReference, rcReference: verdict.rc.rcReference, state: verdict.rc.state },
        submission: null,
        factoring: { billViaFactoring: true, fundedGross: 0, feeCents: 0, reserveCents: 0, fundingIds: [] },
        revisions: [],
        history: [{ at: now, by: principal.userName ?? principal.userId, action: 'created', detail: `Draft from ${load.loadNumber}` }],
        createdAt: now,
        updatedAt: now,
      };
      const { stored, created: fresh } = await this.store.insert('acct_invoices', principal.companyId, record as unknown as Record<string, unknown> & { id: string });
      if (fresh) {
        await this.loads.markInvoiced(principal, loadId, id);
        await this.audit.write(principal, { action: 'invoice_created', entityType: 'invoice', entityId: id, entityLabel: number, summary: `${number} drafted from ${load.loadNumber} for $${total.toFixed(2)}`, changes: [] });
        created.push(record);
      } else created.push(stored.record as unknown as InvoiceRecord);
    }
    return { created, skipped };
  }

  /**
   * The document check at the moment of issue.
   *
   * A draft can be made ready and then lose its ground - a POD replaced, an RC reference
   * re-read, a resolution superseded - so the checks run again here, where the money actually
   * leaves: issuing posts revenue and a receivable. Delivery is not the question; paperwork is.
   */
  private async billingBlock(principal: Principal, loadId: string | null): Promise<string | null> {
    if (!loadId) return null;
    const [loads, invoices, exceptions] = await Promise.all([this.billableLoads(principal), this.list(principal), this.store.list<{ loadId: string; kind: string; status: string }>('acct_billing_exceptions', principal.companyId)]);
    const load = loads.find((l) => l.id === loadId);
    if (!load) return null;
    // The verdict is taken as if the draft were not there: with an invoice on file the rules
    // answer a question about the invoice, and the question here is whether the paperwork still
    // holds up. A superseded resolution or a replaced POD therefore stops the issue.
    const others = invoices.filter((i) => i.loadId !== loadId);
    const verdict = billingVerdict(load, this.context(loads, others, exceptions.map((e) => e.record)));
    if (verdict.queue === 'ready_to_bill') return null;
    if (verdict.queue === null) return verdict.conditions.map((c) => c.message).join(' ') || null;
    const why = verdict.conditions.map((c) => c.message).join(' ');
    return why || `The load is in ${verdict.queue.replace(/_/g, ' ')}; it cannot be invoiced yet.`;
  }

  async issue(principal: Principal, id: string) {
    const stored = await this.store.get<InvoiceRecord>('acct_invoices', principal.companyId, id);
    const inv = stored.record;
    if (inv.status !== 'draft') return { ok: false as const, blocked: `${inv.invoiceNumber} has already been issued.`, invoice: inv };
    const blocked = await this.billingBlock(principal, inv.loadId);
    if (blocked) return { ok: false as const, blocked, invoice: inv };
    const issuedOn = this.clock().toISOString().slice(0, 10);
    const posted = await this.ledger.commit(principal, postInvoiceIssued({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, issuedOn, billToName: inv.billToName, lines: inv.lines.map((l) => ({ chargeType: l.chargeType, description: l.description, amount: l.amount })) }));
    if (!posted.ok) return { ok: false as const, blocked: posted.blocked, invoice: inv };
    const dueOn = new Date(Date.parse(`${issuedOn}T00:00:00Z`) + inv.paymentTermsDays * 86_400_000).toISOString().slice(0, 10);
    const issuedShape: InvoiceRecord = { ...inv, status: 'issued', issuedOn, dueOn, submission: { provider: 'RTS', status: 'prepared', reference: null, at: null, issues: [], by: null, evidence: null, simulated: false }, updatedAt: this.clock().toISOString(), history: [...inv.history, { at: this.clock().toISOString(), by: principal.userName ?? principal.userId, action: 'issued', detail: `Posted as ${posted.entry.id}` }] };
    const after: InvoiceRecord = { ...issuedShape, issuedPdf: await this.freezePdf(principal, issuedShape) };
    await this.store.update('acct_invoices', principal.companyId, id, stored.version, after as unknown as Record<string, unknown>);
    await this.audit.write(principal, { action: 'invoice_issued', entityType: 'invoice', entityId: id, entityLabel: inv.invoiceNumber, summary: `${inv.invoiceNumber} issued; ${posted.entry.id}`, changes: [{ field: 'status', old: 'draft', new: 'issued' }] });
    await this.notifyChange(principal, after.loadId);
    return { ok: true as const, invoice: after };
  }

  async void(principal: Principal, id: string, reason: string) {
    const stored = await this.store.get<InvoiceRecord>('acct_invoices', principal.companyId, id);
    const inv = stored.record;
    if (inv.paid > 0) return { ok: false as const, blocked: `${inv.invoiceNumber} has $${inv.paid.toFixed(2)} applied. Reverse the payment before voiding it.`, invoice: inv };
    if (!reason.trim()) return { ok: false as const, blocked: 'A void needs a reason.', invoice: inv };
    if (inv.status !== 'draft') {
      const posted = await this.ledger.commit(principal, postInvoiceVoid({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, onDate: this.clock().toISOString().slice(0, 10), billToName: inv.billToName, amount: inv.total, reason: reason.trim() }));
      if (!posted.ok) return { ok: false as const, blocked: posted.blocked, invoice: inv };
    }
    const after: InvoiceRecord = { ...inv, status: 'void', balance: 0, updatedAt: this.clock().toISOString(), history: [...inv.history, { at: this.clock().toISOString(), by: principal.userName ?? principal.userId, action: 'void', detail: reason.trim() }] };
    await this.store.update('acct_invoices', principal.companyId, id, stored.version, after as unknown as Record<string, unknown>);
    // Only the whole family's void frees the load; a revision void leaves the previous current. A
    // supplemental invoice never held the load: voiding it leaves the load on its own invoice.
    const family = await this.store.list<InvoiceRecord>('acct_invoices', principal.companyId, sql`family = ${inv.family} and status <> 'void'`);
    if (family.length === 0 && !inv.supplementOf) await this.loads.markInvoiced(principal, inv.loadId, null);
    // A voided supplemental invoice takes its charges off the load (dropped, kept on record), so they
    // are neither billed nor paid as if they still stood.
    if (inv.supplementOf && family.length === 0) await this.dropChargesOnLoad(principal, inv, reason.trim());
    await this.audit.write(principal, { action: 'invoice_void', entityType: 'invoice', entityId: id, entityLabel: inv.invoiceNumber, summary: `${inv.invoiceNumber} voided: ${reason}`, reason, changes: [{ field: 'status', old: inv.status, new: 'void' }] });
    return { ok: true as const, invoice: after };
  }

  private requireEdit(principal: Principal): void {
    if (!hasPermission(principal, 'accounting.edit')) throw forbidden('Only Accounting can revise invoices or change their notes.');
  }

  private async companyName(companyId: string): Promise<string> {
    const [row] = await this.store.db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
    return row?.name ?? companyId;
  }

  /** Renders the invoice as it stands and keeps the bytes: the PDF of record from here on. */
  private async freezePdf(principal: Principal, inv: InvoiceRecord): Promise<{ fileId: string; sha256: string; at: string }> {
    const bytes = await this.exportsService.invoicePdf(inv, await this.companyName(principal.companyId));
    const stored = await this.files.store(principal.companyId, { fileName: `${inv.invoiceNumber}.pdf`, contentType: 'application/pdf', bytes, uploadedBy: principal.userName ?? principal.userId });
    return { fileId: stored.id, sha256: createHash('sha256').update(bytes).digest('hex'), at: this.clock().toISOString() };
  }

  /**
   * The PDF to hand out: the frozen one for an issued invoice, a fresh render for a draft (or for
   * an invoice issued before PDFs were kept, which is frozen the first time it is superseded).
   */
  async pdfBytes(principal: Principal, inv: InvoiceRecord): Promise<Buffer> {
    if (inv.issuedPdf?.fileId) {
      const kept = await this.files.read(principal.companyId, inv.issuedPdf.fileId).catch(() => null);
      if (kept) return kept.bytes;
    }
    return this.exportsService.invoicePdf(inv, await this.companyName(principal.companyId));
  }

  /** The load's documents, company-scoped, by id: what a revised charge can point to. */
  private async loadDocuments(principal: Principal, loadId: string): Promise<Map<string, { id: string; type: string; fileName: string }>> {
    const load = await this.loads.get(principal, loadId).catch(() => null);
    return new Map((load?.documents ?? []).filter((d) => d.status !== 'missing').map((d) => [d.id, { id: d.id, type: d.type, fileName: d.fileName }]));
  }

  /**
   * Starts a revision (§4) as a draft: INV-10004 → INV2-10004 → INV3-10004.
   *
   * Nothing posts here. The issued invoice stays current, with its PDF, lines, documents, payments
   * and submission history, until the draft is issued. One draft per family at a time: the claim
   * is taken on the issued invoice under a row lock, and the draft's source key is unique, so a
   * retry or a second person gets the same draft back instead of a second one.
   */
  async revise(principal: Principal, id: string, raw: unknown) {
    this.requireEdit(principal);
    const input = CreateRevisionSchema.parse(raw);
    const stored = await this.store.get<InvoiceRecord>('acct_invoices', principal.companyId, id);
    const prev = stored.record;
    if (!prev.isCurrent || prev.status === 'void' || prev.status === 'draft' || prev.status === 'superseded') return { ok: false as const, blocked: 'Only the current issued invoice can be revised.', invoice: prev };
    if (prev.draftRevisionId) {
      const existing = await this.store.find<InvoiceRecord>('acct_invoices', principal.companyId, prev.draftRevisionId);
      if (existing && existing.record.status === 'draft') return { ok: true as const, invoice: existing.record, existing: true };
    }
    if (prev.updatedAt !== input.expectedUpdatedAt) return { ok: false as const, blocked: `${prev.invoiceNumber} changed since you opened it. Reload and try again.`, invoice: prev };
    // Factoring practice (owner, 2026-10-21): an invoice RTS has been sent, or has funded, is never
    // replaced. An extra charge goes on a supplemental invoice; anything else is settled with RTS.
    if ((prev.submission && (prev.submission.status === 'submitted' || prev.submission.status === 'accepted') && !prev.submission.simulated) || (prev.factoring?.fundedGross ?? 0) > 0) {
      return { ok: false as const, blocked: `${prev.invoiceNumber} has been sent to RTS${(prev.factoring?.fundedGross ?? 0) > 0 ? ' and funded' : ''}, so it is not changed. Bill a layover, detention or other extra with Add charge after invoicing (a supplemental invoice, ${supplementInvoiceNumber(prev.family, 1)}, -S2 …); settle a reduction with RTS.`, invoice: prev };
    }
    if (prev.rtsBatch) {
      const batch = await this.store.find<{ status: string; batchNumber: string }>('acct_payment_batches', principal.companyId, prev.rtsBatch.batchId);
      if (batch && (batch.record.status === 'prepared' || batch.record.status === 'exported')) {
        return { ok: false as const, blocked: `${prev.invoiceNumber} is in ${batch.record.batchNumber}, which has not been submitted. Cancel that batch first, so RTS is never sent a version that has been replaced.`, invoice: prev };
      }
    }
    const docs = await this.loadDocuments(principal, prev.loadId);
    const unknownDoc = input.lines.flatMap((l) => l.supportingDocumentIds ?? []).find((d) => !docs.has(d));
    if (unknownDoc) return { ok: false as const, blocked: 'A supporting document is not on this load.', invoice: prev };

    const revision = prev.revision + 1;
    const number = revisionNumber(prev.family, revision);
    const draftId = newId('inv');
    const now = this.clock().toISOString();
    // Claim the family's one draft slot on the issued invoice, under its row lock.
    let claimed = false;
    await this.store.modify<InvoiceRecord>('acct_invoices', principal.companyId, prev.id, (row) => {
      if (row.draftRevisionId || !row.isCurrent) return row;
      claimed = true;
      return { ...row, draftRevisionId: draftId };
    });
    if (!claimed) {
      const again = (await this.store.get<InvoiceRecord>('acct_invoices', principal.companyId, prev.id)).record;
      const other = again.draftRevisionId ? await this.store.find<InvoiceRecord>('acct_invoices', principal.companyId, again.draftRevisionId) : null;
      if (other) return { ok: true as const, invoice: other.record, existing: true };
      return { ok: false as const, blocked: `${prev.invoiceNumber} is being revised by someone else. Reload in a moment.`, invoice: prev };
    }
    const lines: InvoiceLineRecord[] = input.lines.map((l, i) => ({
      id: `${draftId}_l${i + 1}`,
      invoiceId: draftId,
      loadId: prev.loadId,
      loadChargeId: l.loadChargeId ?? null,
      chargeType: l.chargeType,
      description: l.description,
      quantity: 1,
      rate: money(l.amount),
      amount: money(l.amount),
      supportingDocuments: (l.supportingDocumentIds ?? []).map((d) => docs.get(d)!),
    }));
    const total = money(lines.reduce((t, l) => t + l.amount, 0));
    const wasSubmitted = Boolean(prev.submission && prev.submission.status !== 'prepared') || (prev.factoring?.fundedGross ?? 0) > 0;
    const draft: InvoiceRecord = {
      ...prev,
      id: draftId,
      invoiceNumber: number,
      revision,
      isCurrent: false,
      supersedesId: prev.id,
      sourceKey: `load:${prev.loadId}:r${revision}`,
      lines,
      subtotal: total,
      total,
      status: 'draft',
      issuedOn: null,
      dueOn: null,
      submission: null,
      rtsBatch: null,
      draftRevisionId: null,
      creditBalance: 0,
      invoiceNote: input.invoiceNote === undefined ? (prev.invoiceNote ?? null) : input.invoiceNote,
      internalNotes: [],
      revisionOf: { invoiceId: prev.id, invoiceNumber: prev.invoiceNumber, originalInvoiceNumber: prev.family, reason: input.reason.trim(), previousTotal: prev.total, adjustment: money(total - prev.total), revisedOn: null },
      priorSubmission: wasSubmitted ? { invoiceNumber: prev.invoiceNumber, status: prev.submission?.status ?? 'funded', reference: prev.submission?.reference ?? null, at: prev.submission?.at ?? null, fundedGross: prev.factoring?.fundedGross ?? 0 } : (prev.priorSubmission ?? null),
      history: [...prev.history, { at: now, by: principal.userName ?? principal.userId, action: 'revision_drafted', detail: `${number}: ${input.reason.trim()} (draft; nothing posted)` }],
      createdAt: now,
      updatedAt: now,
    };
    const { stored: inserted, created } = await this.store.insert('acct_invoices', principal.companyId, draft as unknown as Record<string, unknown> & { id: string });
    if (!created) {
      // The same revision number already exists for this load: a retry. Point the claim at it.
      await this.store.modify<InvoiceRecord>('acct_invoices', principal.companyId, prev.id, (row) => ({ ...row, draftRevisionId: inserted.id }));
      return { ok: true as const, invoice: inserted.record as unknown as InvoiceRecord, existing: true };
    }
    await this.audit.write(principal, { action: 'invoice_revision_drafted', entityType: 'invoice', entityId: draftId, entityLabel: number, summary: `${prev.invoiceNumber} → ${number} drafted: ${input.reason.trim()} · ${money(total - prev.total) >= 0 ? '+' : ''}$${money(total - prev.total).toFixed(2)} (not posted)`, reason: input.reason.trim(), changes: [] });
    return { ok: true as const, invoice: draft, existing: false };
  }

  /**
   * Issues a draft revision: posts only what changed, account by account, and makes it current.
   *
   * Idempotent. The draft is claimed under its row lock, so a double click or two people issuing
   * at once end with one issued revision; the posting's source key is unique, so the ledger would
   * refuse a second one even if a claim were lost. Payments carry over; a total below them leaves
   * an explicit credit.
   */
  async issueRevision(principal: Principal, draftId: string, input: { expectedUpdatedAt: string }) {
    this.requireEdit(principal);
    const current = await this.store.get<InvoiceRecord>('acct_invoices', principal.companyId, draftId);
    const draft = current.record;
    if (!draft.revisionOf) return { ok: false as const, blocked: `${draft.invoiceNumber} is not a revision.`, invoice: draft };
    if (draft.status !== 'draft') return { ok: true as const, invoice: draft, alreadyIssued: true };
    if (draft.updatedAt !== input.expectedUpdatedAt) return { ok: false as const, blocked: `${draft.invoiceNumber} changed since you opened it. Reload and try again.`, invoice: draft };
    let claimed = false;
    await this.store.modify<InvoiceRecord & { issuing?: boolean }>('acct_invoices', principal.companyId, draftId, (row) => {
      if (row.status !== 'draft' || row.issuing) return row;
      claimed = true;
      return { ...row, issuing: true };
    });
    if (!claimed) {
      const now = (await this.store.get<InvoiceRecord>('acct_invoices', principal.companyId, draftId)).record;
      return { ok: true as const, invoice: now, alreadyIssued: true };
    }
    const prevStored = await this.store.get<InvoiceRecord>('acct_invoices', principal.companyId, draft.revisionOf.invoiceId);
    const prev = prevStored.record;
    const release = async () => this.store.modify<InvoiceRecord & { issuing?: boolean }>('acct_invoices', principal.companyId, draftId, (row) => ({ ...row, issuing: false }));
    if (!prev.isCurrent) {
      await release();
      return { ok: false as const, blocked: `${prev.invoiceNumber} is no longer the current version; this draft is out of date.`, invoice: draft };
    }
    const now = this.clock().toISOString();
    const onDate = now.slice(0, 10);
    const posting = revisionPosting(prev.lines, draft.lines);
    let entryId: string | null = null;
    if (posting.postsAnything) {
      const lines: Array<{ accountCode: string; debit?: number; credit?: number; memo?: string }> = [];
      if (posting.deltaCents > 0) lines.push({ accountCode: '1200', debit: posting.deltaCents, memo: `${draft.invoiceNumber} increase` });
      if (posting.deltaCents < 0) lines.push({ accountCode: '1200', credit: -posting.deltaCents, memo: `${draft.invoiceNumber} decrease` });
      for (const a of posting.byAccount) lines.push(a.cents > 0 ? { accountCode: a.accountCode, credit: a.cents } : { accountCode: a.accountCode, debit: -a.cents });
      const posted = await this.ledger.commit(principal, buildEntry({ onDate, source: 'invoice_issued', sourceKey: `invoice:${draftId}:revision`, reference: { type: 'invoice', id: draftId, label: draft.invoiceNumber }, memo: `${draft.invoiceNumber} — ${draft.revisionOf.reason}`, lines }));
      if (!posted.ok) {
        await release();
        return { ok: false as const, blocked: posted.blocked, invoice: draft };
      }
      entryId = posted.entry.id;
    }
    const paidCents = Math.round(prev.paid * 100);
    const bal = revisionBalance(posting.revisedTotalCents, paidCents);
    const dueOn = new Date(Date.parse(`${onDate}T00:00:00Z`) + draft.paymentTermsDays * 86_400_000).toISOString().slice(0, 10);
    const issued: InvoiceRecord = {
      ...draft,
      status: bal.status,
      isCurrent: true,
      issuedOn: onDate,
      dueOn,
      paid: prev.paid,
      balance: bal.balanceCents / 100,
      creditBalance: bal.creditCents / 100,
      submission: { provider: 'RTS', status: 'prepared', reference: null, at: null, issues: [], by: null, evidence: null, simulated: false },
      revisionOf: { ...draft.revisionOf, revisedOn: onDate },
      revisions: [...prev.revisions, { revision: draft.revision, invoiceId: draftId, invoiceNumber: draft.invoiceNumber, at: now, by: principal.userName ?? principal.userId, reason: draft.revisionOf.reason, delta: posting.deltaCents / 100, total: posting.revisedTotalCents / 100 }],
      history: [...draft.history, { at: now, by: principal.userName ?? principal.userId, action: 'revision_issued', detail: `${draft.invoiceNumber} issued: ${posting.deltaCents >= 0 ? '+' : ''}$${(posting.deltaCents / 100).toFixed(2)}${entryId ? ` posted as ${entryId}` : ' (nothing to post: no charge changed)'}${bal.creditCents ? ` · credit of $${(bal.creditCents / 100).toFixed(2)} owed to the customer (not refunded)` : ''}` }],
      updatedAt: now,
    };
    const issuedPdf = await this.freezePdf(principal, issued);
    // An invoice issued before PDFs were kept is frozen now, as it stands, before it is superseded.
    const prevPdf = prev.issuedPdf ?? (await this.freezePdf(principal, prev));
    await this.store.modify<InvoiceRecord & { issuing?: boolean }>('acct_invoices', principal.companyId, draftId, () => ({ ...issued, issuedPdf, issuing: false }));
    await this.store.modify<InvoiceRecord>('acct_invoices', principal.companyId, prev.id, (row) => ({
      ...row,
      isCurrent: false,
      status: 'superseded',
      balance: 0,
      draftRevisionId: null,
      issuedPdf: row.issuedPdf ?? prevPdf,
      history: [...row.history, { at: now, by: principal.userName ?? principal.userId, action: 'superseded', detail: `Replaced by ${draft.invoiceNumber}; this version is kept as issued` }],
      updatedAt: now,
    }));
    if (!prev.supplementOf) await this.loads.markInvoiced(principal, prev.loadId, draftId);
    await this.audit.write(principal, { action: 'invoice_revised', entityType: 'invoice', entityId: draftId, entityLabel: draft.invoiceNumber, summary: `${prev.invoiceNumber} → ${draft.invoiceNumber}: ${draft.revisionOf.reason} (${posting.deltaCents >= 0 ? '+' : ''}$${(posting.deltaCents / 100).toFixed(2)})`, reason: draft.revisionOf.reason, changes: [{ field: 'total', old: String(prev.total), new: String(posting.revisedTotalCents / 100) }] });
    await this.notifyChange(principal, prev.loadId);
    return { ok: true as const, invoice: { ...issued, issuedPdf }, alreadyIssued: false };
  }

  /** Abandons a draft revision. The draft is kept, voided with the reason; the issued one is untouched. */
  async discardRevision(principal: Principal, draftId: string, reason: string) {
    this.requireEdit(principal);
    const stored = await this.store.get<InvoiceRecord>('acct_invoices', principal.companyId, draftId);
    const draft = stored.record;
    if (draft.status !== 'draft' || !draft.revisionOf) return { ok: false as const, blocked: 'Only a draft revision can be discarded.', invoice: draft };
    const now = this.clock().toISOString();
    await this.store.modify<InvoiceRecord>('acct_invoices', principal.companyId, draftId, (row) => ({ ...row, status: 'void', history: [...row.history, { at: now, by: principal.userName ?? principal.userId, action: 'revision_discarded', detail: reason }], updatedAt: now }));
    await this.store.modify<InvoiceRecord>('acct_invoices', principal.companyId, draft.revisionOf.invoiceId, (row) => (row.draftRevisionId === draftId ? { ...row, draftRevisionId: null } : row));
    await this.audit.write(principal, { action: 'invoice_revision_discarded', entityType: 'invoice', entityId: draftId, entityLabel: draft.invoiceNumber, summary: reason, reason, changes: [] });
    return { ok: true as const };
  }

  /**
   * The printed note. Editable on a draft; on an issued invoice the broker already has the words
   * that were printed, so a change is a revision (a note-only one posts nothing).
   */
  async setInvoiceNote(principal: Principal, id: string, input: { invoiceNote: string | null; expectedUpdatedAt: string }) {
    this.requireEdit(principal);
    const stored = await this.store.get<InvoiceRecord>('acct_invoices', principal.companyId, id);
    const inv = stored.record;
    if (inv.status !== 'draft') return { ok: false as const, blocked: `${inv.invoiceNumber} has been issued. The printed note changes by a revision, so the broker is never holding a version that says something else.`, invoice: inv };
    if (inv.updatedAt !== input.expectedUpdatedAt) return { ok: false as const, blocked: `${inv.invoiceNumber} changed since you opened it.`, invoice: inv };
    const now = this.clock().toISOString();
    const after = { ...inv, invoiceNote: input.invoiceNote?.trim() ? input.invoiceNote : null, updatedAt: now, history: [...inv.history, { at: now, by: principal.userName ?? principal.userId, action: 'invoice_note_set', detail: 'Printed note changed on the draft' }] };
    await this.store.update('acct_invoices', principal.companyId, id, stored.version, after as unknown as Record<string, unknown>);
    return { ok: true as const, invoice: after };
  }

  /** Accounting's internal notes: added with author and time, edits kept, never printed or sent. */
  async addInternalNote(principal: Principal, id: string, text: string) {
    this.requireEdit(principal);
    const now = this.clock().toISOString();
    const note: InternalNote = { id: newId('note'), text: text.trim(), by: principal.userName ?? principal.userId, at: now, edits: [] };
    const after = await this.store.modify<InvoiceRecord>('acct_invoices', principal.companyId, id, (row) => ({ ...row, internalNotes: [...(row.internalNotes ?? []), note] }));
    await this.audit.write(principal, { action: 'invoice_internal_note', entityType: 'invoice', entityId: id, entityLabel: after.record.invoiceNumber, summary: 'Internal note added', changes: [] });
    return { ok: true as const, note };
  }

  async editInternalNote(principal: Principal, id: string, noteId: string, text: string) {
    this.requireEdit(principal);
    const now = this.clock().toISOString();
    let found = false;
    const after = await this.store.modify<InvoiceRecord>('acct_invoices', principal.companyId, id, (row) => ({
      ...row,
      internalNotes: (row.internalNotes ?? []).map((n) => {
        if (n.id !== noteId) return n;
        found = true;
        return { ...n, text: text.trim(), edits: [...n.edits, { text: n.text, by: n.by, at: n.at }], by: principal.userName ?? principal.userId, at: now };
      }),
    }));
    if (!found) throw unprocessable('That note is not on this invoice.');
    await this.audit.write(principal, { action: 'invoice_internal_note_edited', entityType: 'invoice', entityId: id, entityLabel: after.record.invoiceNumber, summary: 'Internal note edited; the earlier wording is kept', changes: [] });
    return { ok: true as const };
  }

  /** Every version of the family, oldest first, so each can be previewed as it was issued. */
  async family(principal: Principal, id: string): Promise<InvoiceRecord[]> {
    const inv = (await this.store.get<InvoiceRecord>('acct_invoices', principal.companyId, id)).record;
    const rows = await this.store.list<InvoiceRecord>('acct_invoices', principal.companyId, sql`family = ${inv.family}`);
    return rows.map((r) => r.record).sort((a, b) => a.revision - b.revision || a.createdAt.localeCompare(b.createdAt));
  }

  /** What a revision can add: the load's approved billable charges not on the invoice, and its documents. */
  async revisionOptions(principal: Principal, id: string) {
    const inv = (await this.store.get<InvoiceRecord>('acct_invoices', principal.companyId, id)).record;
    const load = await this.loads.get(principal, inv.loadId).catch(() => null);
    const r = (load ?? {}) as Record<string, unknown>;
    // A charge already billed - on this invoice, or on a supplemental invoice of the load - is not offered again.
    const billed = (await this.store.list<InvoiceRecord>('acct_invoices', principal.companyId, sql`load_id = ${inv.loadId} and is_current = true and status <> 'void'`)).map((x) => x.record);
    const onInvoice = new Set([...inv.lines, ...billed.flatMap((b) => b.lines)].map((l) => l.loadChargeId).filter(Boolean));
    const charges = ((r['charges'] as Array<{ id: string; type: string; description: string; amount: number; billable: boolean; status?: string }>) ?? [])
      .filter((c) => c.type !== 'linehaul' && c.billable && c.status !== 'draft' && c.status !== 'dropped' && !onInvoice.has(c.id))
      .map((c) => ({ id: c.id, chargeType: c.type, description: c.description, amount: c.amount }));
    const documents = (load?.documents ?? []).filter((d) => d.status !== 'missing' && !(d as { supersededBy?: string | null }).supersededBy).map((d) => ({ id: d.id, type: d.type, fileName: d.fileName, title: d.title }));
    return { charges, documents };
  }

  // ------------------------------------------------------------ charges after invoicing (supplemental invoices)

  /** The supplemental invoices of an original, oldest first (void ones included, marked). */
  async supplementsOf(principal: Principal, id: string): Promise<InvoiceRecord[]> {
    const inv = await this.get(principal, id);
    const parentId = inv.supplementOf?.invoiceId ?? inv.id;
    const rows = await this.store.list<InvoiceRecord>('acct_invoices', principal.companyId, sql`record->'supplementOf'->>'invoiceId' = ${parentId}`);
    return rows.map((r) => r.record).filter((r) => r.isCurrent || r.status === 'void').sort((a, b) => (a.supplementOf?.sequence ?? 0) - (b.supplementOf?.sequence ?? 0) || a.revision - b.revision);
  }

  /** Whether an extra charge on this invoice goes on a supplemental invoice, for the screens. */
  async supplementCheck(principal: Principal, id: string) {
    const inv = await this.get(principal, id);
    return supplementEligibility(inv, await this.inLiveBatch(principal, inv));
  }

  private async inLiveBatch(principal: Principal, inv: InvoiceRecord): Promise<boolean> {
    if (!inv.rtsBatch) return false;
    const batch = await this.store.find<{ status: string }>('acct_payment_batches', principal.companyId, inv.rtsBatch.batchId);
    return Boolean(batch && ['prepared', 'exported', 'submitted'].includes(batch.record.status));
  }

  /**
   * Add charge after invoicing (owner, 2026-10-21): a layover, detention, lumper or other extra
   * that came in after the load's invoice went to RTS.
   *
   * The original is not touched - not its lines, total, status, PDF, submission or batch. A
   * supplemental invoice INV-10004-S1 is drafted for the same load, bill-to and broker reference,
   * with the new charges as its lines, the person's proof attached to them, and the original's RC,
   * BOL and POD carried by reference as backup. The charges are put on the load too (accepted,
   * billable, marked as added after invoicing) so the load's revenue, the driver's pay and the
   * revision screens see them, and they are never offered for billing twice. With `issueNow` it is
   * issued at once and lands in the RTS batch list like any issued invoice.
   *
   * Idempotent per `requestKey`: a retry returns the same supplement and adds nothing twice. The
   * original's `updatedAt` is checked, so a stale screen is refused.
   */
  async addChargeAfterInvoicing(principal: Principal, id: string, raw: unknown) {
    this.requireEdit(principal);
    const input = AddChargeAfterInvoicingSchema.parse(raw);
    const parent = await this.get(principal, id);
    const sourceKey = `supplement:${parent.family}:${input.requestKey}`;
    const again = (await this.store.list<InvoiceRecord>('acct_invoices', principal.companyId, sql`source_key = ${sourceKey}`))[0]?.record ?? null;
    if (again) {
      await this.putChargesOnLoad(principal, again);
      return { ok: true as const, invoice: (await this.store.get<InvoiceRecord>('acct_invoices', principal.companyId, again.id)).record, parent, existing: true };
    }
    const eligible = supplementEligibility(parent, await this.inLiveBatch(principal, parent));
    if (!eligible.ok) return { ok: false as const, blocked: eligible.reason, useRevision: eligible.useRevision, parent };
    if (parent.updatedAt !== input.expectedUpdatedAt) return { ok: false as const, blocked: `${parent.invoiceNumber} changed since you opened it. Reload and try again.`, useRevision: false, parent };
    let docs = await this.loadDocuments(principal, parent.loadId);
    if (input.charges.flatMap((c) => c.supportingDocumentIds).some((d) => !docs.has(d))) return { ok: false as const, blocked: 'A supporting document is not on this load. Attach the receipt or sheet to the load first.', useRevision: false, parent };
    // The proof uploaded in the dialog (the layover receipt, the detention sheet) is filed on the
    // load first - once per file - so it is part of the load's paperwork, then attached to its charge.
    const byFile = new Map<string, string>();
    for (const c of input.charges) {
      for (const f of c.newFiles) byFile.set(f.fileId, await this.fileProofOnLoad(principal, parent.loadId, c.chargeType, c.description, f.fileId));
    }
    if (byFile.size > 0) docs = await this.loadDocuments(principal, parent.loadId);
    const supportOf = (c: (typeof input.charges)[number]) => [...new Set([...c.supportingDocumentIds, ...c.newFiles.map((f) => byFile.get(f.fileId)!)])].filter((d) => docs.has(d));

    const now = this.clock().toISOString();
    const by = principal.userName ?? principal.userId;
    const existingSupps = await this.store.list<InvoiceRecord>('acct_invoices', principal.companyId, sql`record->'supplementOf'->>'invoiceId' = ${parent.id}`);
    let sequence = existingSupps.reduce((m, r) => Math.max(m, r.record.supplementOf?.sequence ?? 0), 0) + 1;
    let record: InvoiceRecord | null = null;
    // Two people adding charges at once each get their own number: a taken number moves to the next.
    for (let attempt = 0; attempt < 5 && !record; attempt += 1, sequence += 1) {
      const number = supplementInvoiceNumber(parent.family, sequence);
      const suppId = newId('inv');
      const lines: InvoiceLineRecord[] = input.charges.map((c, i) => ({
        id: `${suppId}_l${i + 1}`,
        invoiceId: suppId,
        loadId: parent.loadId,
        loadChargeId: `chg_${suppId}_${i + 1}`,
        chargeType: c.chargeType,
        description: c.description,
        quantity: 1,
        rate: money(c.amount),
        amount: money(c.amount),
        supportingDocuments: supportOf(c).map((d) => docs.get(d)!),
      }));
      const total = money(lines.reduce((t, l) => t + l.amount, 0));
      const candidate: InvoiceRecord = {
        id: suppId,
        invoiceNumber: number,
        family: number,
        revision: 1,
        isCurrent: true,
        supersedesId: null,
        sourceKey,
        loadId: parent.loadId,
        loadNumber: parent.loadNumber,
        billToType: parent.billToType,
        billToId: parent.billToId,
        billToName: parent.billToName,
        issuedOn: null,
        dueOn: null,
        paymentTermsDays: parent.paymentTermsDays,
        subtotal: total,
        total,
        paid: 0,
        balance: total,
        status: 'draft',
        agingDays: 0,
        agingBucket: 'current',
        paidOn: null,
        disputeReason: null,
        lines,
        // The original's RC, BOL and POD by reference - the backup RTS asks for with every invoice.
        documentPackage: parent.documentPackage.map((d) => ({ ...d })),
        rc: parent.rc ? { ...parent.rc } : null,
        submission: null,
        factoring: { billViaFactoring: parent.factoring?.billViaFactoring !== false, fundedGross: 0, feeCents: 0, reserveCents: 0, fundingIds: [] },
        revisions: [],
        invoiceNote: input.invoiceNote?.trim() ? input.invoiceNote : supplementNote(parent.invoiceNumber, parent.loadNumber, parent.rc?.loadReference ?? null),
        internalNotes: [],
        supplementOf: { invoiceId: parent.id, invoiceNumber: parent.invoiceNumber, family: parent.family, sequence, reason: input.reason.trim(), requestKey: input.requestKey },
        history: [{ at: now, by, action: 'created', detail: `Supplemental to ${parent.invoiceNumber} (${eligible.why}): ${input.reason.trim()}` }],
        createdAt: now,
        updatedAt: now,
      };
      try {
        const { stored, created } = await this.store.insert('acct_invoices', principal.companyId, candidate as unknown as Record<string, unknown> & { id: string });
        record = stored.record as unknown as InvoiceRecord;
        if (!created) return { ok: true as const, invoice: record, parent, existing: true };
      } catch (e) {
        if (!/acct_invoices_number_key|duplicate key/i.test(String((e as { message?: string })?.message ?? e) + String((e as { cause?: { message?: string } })?.cause?.message ?? ''))) throw e;
      }
    }
    if (!record) throw unprocessable(`Could not number a supplemental invoice for ${parent.invoiceNumber}. Try again.`);
    await this.audit.write(principal, { action: 'invoice_supplement_created', entityType: 'invoice', entityId: record.id, entityLabel: record.invoiceNumber, summary: `${record.invoiceNumber} drafted for ${parent.loadNumber} after ${parent.invoiceNumber} (${eligible.why}): ${record.lines.map((l) => `${l.description} $${l.amount.toFixed(2)}`).join(', ')} · ${input.reason.trim()}. ${parent.invoiceNumber} is unchanged.`, reason: input.reason.trim(), changes: [] });
    await this.putChargesOnLoad(principal, record, input.charges.map((c) => c.payableToDriver));
    let invoice = record;
    let issueBlocked: string | null = null;
    if (input.issueNow) {
      const issued = await this.issue(principal, record.id);
      if (issued.ok) invoice = issued.invoice;
      else issueBlocked = issued.blocked;
    }
    return { ok: true as const, invoice, parent, existing: false, issueBlocked };
  }

  /** The charges a voided supplemental invoice put on the load, marked dropped with the reason. */
  private async dropChargesOnLoad(principal: Principal, supp: InvoiceRecord, reason: string): Promise<void> {
    const ids = new Set(supp.lines.map((l) => l.loadChargeId).filter(Boolean));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const load = (await this.loads.get(principal, supp.loadId).catch(() => null)) as (StoredLoad & Record<string, unknown>) | null;
      if (!load) return;
      const charges = Array.isArray(load['charges']) ? (load['charges'] as Array<Record<string, unknown> & { id: string; status?: string }>) : [];
      if (!charges.some((c) => ids.has(c.id) && c.status !== 'dropped')) return;
      try {
        await this.loads.patch(principal, load.id, { expectedUpdatedAt: load.updatedAt, patch: { charges: charges.map((c) => (ids.has(c.id) ? { ...c, status: 'dropped', droppedReason: `${supp.invoiceNumber} voided: ${reason}` } : c)) } });
        return;
      } catch (e) {
        if (attempt === 2 || !/changed since you opened it|conflict/i.test(String((e as { message?: string })?.message ?? e))) throw e;
      }
    }
  }

  /** Files one uploaded proof on the load (or finds it already filed) and returns its document id. */
  private async fileProofOnLoad(principal: Principal, loadId: string, chargeType: string, description: string, fileId: string): Promise<string> {
    const find = (l: StoredLoad) => (l.documents ?? []).find((d) => (d as unknown as { fileId?: string }).fileId === fileId)?.id ?? null;
    const load = await this.loads.get(principal, loadId);
    const already = find(load);
    if (already) return already;
    const { info } = await this.files.read(principal.companyId, fileId);
    const out = await this.loads.attachDocument(principal, loadId, { type: proofDocumentType(chargeType), fileName: info.fileName, sizeBytes: info.sizeBytes, mimeType: info.contentType, fileUrl: info.url, fileId, title: `${description} proof`.slice(0, 120), expectedUpdatedAt: load.updatedAt });
    const id = find(out.load as StoredLoad);
    if (!id) throw unprocessable(`${info.fileName} could not be filed on the load.`);
    return id;
  }

  /**
   * The supplement's charges on the load: accepted and billable, marked as billed after the
   * invoice. A charge already there (a retry) is left as it is.
   */
  private async putChargesOnLoad(principal: Principal, supp: InvoiceRecord, payable?: boolean[]): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const load = (await this.loads.get(principal, supp.loadId)) as StoredLoad & Record<string, unknown>;
      const charges = Array.isArray(load['charges']) ? (load['charges'] as Array<Record<string, unknown> & { id: string }>) : [];
      const missing = supp.lines.filter((l) => l.loadChargeId && !charges.some((c) => c.id === l.loadChargeId));
      if (missing.length === 0) return;
      const added = missing.map((l) => ({
        id: l.loadChargeId!,
        type: l.chargeType,
        description: l.description,
        amount: l.amount,
        billable: true,
        payableToDriver: payable?.[supp.lines.indexOf(l)] ?? false,
        status: 'accepted',
        stopId: null,
        addedAfterInvoice: { invoiceId: supp.id, invoiceNumber: supp.invoiceNumber, parentInvoiceNumber: supp.supplementOf?.invoiceNumber ?? null },
      }));
      try {
        await this.loads.patch(principal, load.id, { expectedUpdatedAt: load.updatedAt, patch: { charges: [...charges, ...added] } });
        return;
      } catch (e) {
        // Somebody else wrote the load between the read and the write: read it again.
        if (attempt === 2 || !/changed since you opened it|conflict/i.test(String((e as { message?: string })?.message ?? e))) throw e;
      }
    }
  }

  // ------------------------------------------------------------ submission (RTS)

  /**
   * Records what the factoring provider said, as told by a person who saw it.
   *
   * No API call is made here and none is claimed. RTS is not connected: the invoice is prepared
   * and exported here, a person submits it out of band, and this is where their answer is written
   * down. Because the status is a claim about the outside world, marking it `submitted` or
   * `accepted` requires either a provider reference or a note saying what was seen — unless the
   * caller marks the event `simulated`, which is a rehearsal and is labelled as one everywhere it
   * is shown. A simulated event never becomes a real one by being edited later; it stays marked.
   */
  async markSubmission(principal: Principal, id: string, input: { status: 'submitted' | 'accepted' | 'rejected'; reference?: string; issues?: string[]; evidence?: string; simulated?: boolean }) {
    const stored = await this.store.get<InvoiceRecord>('acct_invoices', principal.companyId, id);
    const inv = stored.record;
    if (inv.status === 'draft' || inv.status === 'void') return { ok: false as const, blocked: 'Issue the invoice first.', invoice: inv };
    const simulated = input.simulated === true;
    const reference = input.reference?.trim() || null;
    const evidenceNote = input.evidence?.trim() || null;
    if (!simulated && (input.status === 'submitted' || input.status === 'accepted') && !reference && !evidenceNote) {
      return {
        ok: false as const,
        blocked: `Say how you know the invoice was ${input.status}: the provider's reference, or a note of what you saw. Mark it simulated if this is a test.`,
        invoice: inv,
      };
    }
    const now = this.clock().toISOString();
    const after: InvoiceRecord = {
      ...inv,
      status: input.status === 'rejected' ? inv.status : input.status === 'accepted' ? 'accepted' : 'submitted',
      submission: {
        provider: inv.submission?.provider ?? 'RTS',
        status: input.status,
        reference: reference ?? inv.submission?.reference ?? null,
        at: now,
        issues: input.issues ?? [],
        by: principal.userName ?? principal.userId,
        evidence: simulated
          ? { kind: 'none', detail: 'Simulated test event; nothing was sent to the provider.' }
          : reference
            ? { kind: 'provider_reference', detail: reference }
            : { kind: 'file', detail: evidenceNote },
        // Once a rehearsal, always a rehearsal: a later real answer belongs on a real invoice.
        simulated: simulated || inv.submission?.simulated === true,
      },
      updatedAt: now,
      history: [...inv.history, { at: now, by: principal.userName ?? principal.userId, action: `submission_${input.status}${simulated ? '_simulated' : ''}`, detail: reference ?? evidenceNote ?? (input.issues ?? []).join('; ') }],
    };
    await this.store.update('acct_invoices', principal.companyId, id, stored.version, after as unknown as Record<string, unknown>);
    await this.notifyChange(principal, after.loadId);
    return { ok: true as const, invoice: after };
  }

  // ------------------------------------------------------------ money in

  private async nextPaymentId(companyId: string): Promise<string> {
    const rows = (await this.store.db.execute(sql`select count(*)::int as n from acct_payments where company_id = ${companyId}`)) as unknown as Array<{ n: number }>;
    return `pay_${String((Number(rows[0]?.n) || 0) + 1).padStart(5, '0')}_${Math.random().toString(36).slice(2, 6)}`;
  }

  private async applyToInvoices(principal: Principal, applications: Array<{ invoiceId: string; amount: number }>, receivedOn: string, reference: string, partyName: string) {
    for (const a of applications) {
      await this.store.modify<InvoiceRecord>('acct_invoices', principal.companyId, a.invoiceId, (inv) => {
        inv.paid = money(inv.paid + a.amount);
        inv.balance = money(inv.total - inv.paid);
        inv.status = inv.balance <= 0 ? 'paid' : 'partially_paid';
        if (inv.balance <= 0) inv.paidOn = receivedOn;
        inv.history = [...inv.history, { at: this.clock().toISOString(), by: principal.userName ?? principal.userId, action: 'payment_applied', detail: `$${a.amount.toFixed(2)} · ${reference} from ${partyName}` }];
        inv.updatedAt = this.clock().toISOString();
        return inv;
      });
    }
  }

  /** A direct customer payment (a non-factored customer) applied across invoices. */
  async recordPayment(principal: Principal, input: { partyType: string; partyId: string; partyName: string; amount: number; method: string; receivedOn: string; reference: string; applications: Array<{ invoiceId: string; amount: number }>; notes?: string | null }) {
    const invoices = await this.list(principal);
    const targets = input.applications.map((a) => invoices.find((i) => i.id === a.invoiceId)).filter((i): i is InvoiceRecord => Boolean(i)).map((i) => ({ invoiceId: i.id, invoiceNumber: i.invoiceNumber, balance: i.balance }));
    const check = checkApplication(input.amount, input.applications, targets);
    if (!check.ok) return { ok: false as const, blocked: check.errors.join('. '), payment: null };
    const paymentId = await this.nextPaymentId(principal.companyId);
    const posted = await this.ledger.commit(principal, postPaymentReceived({ paymentId, reference: input.reference, receivedOn: input.receivedOn, partyName: input.partyName, appliedAmount: check.applied, unappliedAmount: check.unapplied }));
    if (!posted.ok) return { ok: false as const, blocked: posted.blocked, payment: null };
    const at = this.clock().toISOString();
    const payment: PaymentRecord = {
      id: paymentId,
      sourceKey: `payment:${input.reference.trim()}:${input.receivedOn}:${input.partyId}`,
      direction: 'in',
      partyType: input.partyType,
      partyId: input.partyId,
      partyName: input.partyName,
      amount: input.amount,
      method: input.method,
      receivedOn: input.receivedOn,
      reference: input.reference.trim(),
      unappliedAmount: check.unapplied,
      applications: input.applications.map((a, i) => ({ id: `pap_${paymentId}_${i + 1}`, paymentId, invoiceId: a.invoiceId, billId: null, amount: a.amount, appliedAt: at })),
      notes: input.notes?.trim() || null,
      createdAt: at,
      createdBy: principal.userName ?? principal.userId,
    };
    const { created } = await this.store.insert('acct_payments', principal.companyId, payment as unknown as Record<string, unknown> & { id: string });
    if (!created) return { ok: false as const, blocked: 'That payment (same reference, date and payer) is already recorded.', payment: null };
    await this.applyToInvoices(principal, input.applications, input.receivedOn, payment.reference, payment.partyName);
    await this.audit.write(principal, { action: 'payment_recorded', entityType: 'payment', entityId: paymentId, entityLabel: payment.reference, summary: `$${input.amount.toFixed(2)} from ${input.partyName} applied to ${input.applications.length} invoice(s)`, changes: [] });
    return { ok: true as const, payment };
  }

  /**
   * An RTS funding (§5): one payment for several invoices, with the actual fee, reserve and
   * extra fees. Posts: Dr cash (net) · Dr factoring fees · Dr reserve receivable · Cr AR (gross).
   * The broker's later payment to RTS is not recorded as company cash.
   */
  async recordFunding(principal: Principal, input: RecordFundingInput) {
    const invoices = await this.list(principal);
    const check = checkFunding(input, invoices.map((i) => ({ id: i.id, balanceCents: Math.round(i.balance * 100), status: i.status })));
    if (!check.ok) return { ok: false as const, blocked: check.errors.join(' '), payment: null };
    const extras = input.extraFees.reduce((s, f) => s + f.amountCents, 0);
    const paymentId = await this.nextPaymentId(principal.companyId);
    const lines: Array<{ accountCode: string; debit?: number; credit?: number; memo?: string }> = [{ accountCode: '1110', debit: input.netReceivedCents, memo: `${input.provider} ${input.reference} net` }];
    if (input.feeCents + extras > 0) lines.push({ accountCode: '6600', debit: input.feeCents + extras, memo: 'Factoring fees' });
    if (input.reserveCents > 0) lines.push({ accountCode: '1250', debit: input.reserveCents, memo: 'Reserve held' });
    lines.push({ accountCode: '1200', credit: check.grossCents, memo: 'Invoices funded' });
    const posted = await this.ledger.commit(principal, buildEntry({ onDate: input.fundedOn, source: 'payment_received', sourceKey: `funding:${input.provider}:${input.reference}`, reference: { type: 'payment', id: paymentId, label: input.reference }, memo: `${input.provider} funding ${input.reference}`, lines }));
    if (!posted.ok) return { ok: false as const, blocked: posted.blocked, payment: null };
    const at = this.clock().toISOString();
    const applications = input.allocations.map((a, i) => ({ id: `pap_${paymentId}_${i + 1}`, paymentId, invoiceId: a.invoiceId, billId: null, amount: money(a.grossCents / 100), appliedAt: at }));
    const payment: PaymentRecord = {
      id: paymentId,
      sourceKey: `funding:${input.provider}:${input.reference}`,
      direction: 'in',
      partyType: 'factor',
      partyId: input.provider,
      partyName: input.provider,
      amount: money(check.grossCents / 100),
      method: 'factoring',
      receivedOn: input.fundedOn,
      reference: input.reference,
      unappliedAmount: 0,
      applications,
      notes: input.notes ?? null,
      createdAt: at,
      createdBy: principal.userName ?? principal.userId,
      funding: { provider: input.provider, feeCents: input.feeCents, reserveCents: input.reserveCents, extraFees: input.extraFees, netReceivedCents: input.netReceivedCents, grossCents: check.grossCents },
    };
    await this.store.insert('acct_payments', principal.companyId, payment as unknown as Record<string, unknown> & { id: string });
    await this.applyToInvoices(principal, applications.map((a) => ({ invoiceId: a.invoiceId!, amount: a.amount })), input.fundedOn, input.reference, input.provider);
    for (const a of input.allocations) {
      await this.store.modify<InvoiceRecord>('acct_invoices', principal.companyId, a.invoiceId, (inv) => {
        const share = a.grossCents / check.grossCents;
        inv.factoring = { ...inv.factoring, fundedGross: money(inv.factoring.fundedGross + a.grossCents / 100), feeCents: inv.factoring.feeCents + Math.round((input.feeCents + extras) * share), reserveCents: inv.factoring.reserveCents + Math.round(input.reserveCents * share), fundingIds: [...inv.factoring.fundingIds, paymentId] };
        if (inv.status === 'paid') inv.status = 'funded';
        return inv;
      });
    }
    await this.audit.write(principal, { action: 'funding_recorded', entityType: 'payment', entityId: paymentId, entityLabel: input.reference, summary: `${input.provider} funded ${input.allocations.length} invoice(s): gross ${check.grossCents / 100}, net ${input.netReceivedCents / 100}`, changes: [] });
    return { ok: true as const, payment };
  }

  async dispute(principal: Principal, id: string, reason: string) {
    const stored = await this.store.get<InvoiceRecord>('acct_invoices', principal.companyId, id);
    const after = { ...stored.record, status: 'disputed', disputeReason: reason.trim(), updatedAt: this.clock().toISOString(), history: [...stored.record.history, { at: this.clock().toISOString(), by: principal.userName ?? principal.userId, action: 'disputed', detail: reason.trim() }] };
    await this.store.update('acct_invoices', principal.companyId, id, stored.version, after as unknown as Record<string, unknown>);
    await this.notifyChange(principal, after.loadId);
    return { ok: true as const, invoice: after };
  }

  /** Aging for the AR page, on the server clock. */
  async receivables(principal: Principal) {
    const invoices = (await this.list(principal)).filter((i) => i.isCurrent);
    const today = this.clock().toISOString().slice(0, 10);
    return invoices.map((i) => {
      const days = i.dueOn ? Math.floor((Date.parse(today) - Date.parse(i.dueOn)) / 86_400_000) : 0;
      const bucket = days <= 0 ? 'current' : days <= 30 ? '1-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
      return { ...i, agingDays: Math.max(0, days), agingBucket: bucket };
    });
  }

  /** Stored payments and invoices for the Loads screens: which load is on which invoice. */
  async invoiceForLoad(principal: Principal, loadId: string): Promise<InvoiceRecord | null> {
    const rows = await this.store.list<InvoiceRecord>('acct_invoices', principal.companyId, sql`load_id = ${loadId} and is_current = true and record->>'supplementOf' is null`);
    return rows[0]?.record ?? null;
  }

  async exceptionsFor(principal: Principal, loadId: string): Promise<Stored<Record<string, unknown>>[]> {
    return this.store.list('acct_billing_exceptions', principal.companyId, sql`load_id = ${loadId}`);
  }
}
