import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DriverTx, StatementComputation } from '@neway/shared';
import { and, eq, sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { loads } from '../src/database/schema/loads';
import { drivers } from '../src/database/schema/roster';
import { RtsBatchesService } from '../src/modules/accounting/rts-batches.service';
import type { InvoiceRecord } from '../src/modules/accounting/invoices.service';
import { RtsFtpService } from '../src/modules/admin/connectors/rts-ftp.service';
import { FilesService } from '../src/modules/files/files.service';

const ACCT = '/api/v1/accounting';

type Statement = { id: string; status: string; periodStart: string; periodEnd: string; exceptions: string[]; computation: StatementComputation; loadIds: string[] };
type Outcome = { ok: boolean; blocked?: string; statement: Statement };
type AddOut = { ok: boolean; blocked?: string; useRevision?: boolean; existing?: boolean; issueBlocked?: string | null; invoice: InvoiceRecord; parent: InvoiceRecord; driverPay?: Array<{ chargeId: string; treatment: string }> };

/**
 * A layover after the invoice went to RTS (owner, 2026-10-21). The load is invoiced, batched and
 * sent; the layover comes in later. It is billed on a supplemental invoice INV-…-S1 for the same
 * load and broker reference - issued, batched and sent to RTS like any invoice - while the original
 * stays exactly as it was sent. The driver, whose statement for the load is already approved, is
 * paid the layover once, on the next statement. Before an invoice is sent the old way stays.
 */
describe('Charges after the invoice went to RTS (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let rts: RtsBatchesService;
  let companyId = '';
  const tag = Date.now().toString(36).toUpperCase();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const shift = (day: string, n: number) => {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  // A Wednesday five weeks back: its pay week is long over.
  const monday = (() => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 35 - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  })();
  const deliveredDay = shift(monday, 2);
  const driverId = `drv_e2e_late_${tag}`.toLowerCase();
  const sentLoad = `lod_e2e_late1_${tag}`.toLowerCase();
  const draftLoad = `lod_e2e_late2_${tag}`.toLowerCase();
  const brokerRef = `BR-${tag}`;
  let truckId = '';
  let receiptFileId = '';
  let original: InvoiceRecord;
  let supplement: InvoiceRecord;
  let stmA = '';
  const uploads: Array<{ pdfs: string[]; pages: number[]; csv: string }> = [];

  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: payload === undefined ? {} : { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const ok = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
    const r = await call(method, url, payload);
    expect(r.statusCode, r.body).toBeLessThan(300);
    return r.json() as never;
  };
  const invoice = async (id: string) => (await ok('GET', `${ACCT}/invoices/${id}`)) as InvoiceRecord;
  const loadRecord = async (id: string) => (await db.select({ record: loads.record }).from(loads).where(eq(loads.id, id)))[0]!.record as Record<string, unknown> & { charges: Array<Record<string, unknown>>; invoiceId?: string };
  const lateTxs = async () => ((await db.execute(sql`select record from acct_driver_transactions where company_id = ${companyId} and driver_id = ${driverId} and source = 'late_accessorial'`)) as unknown as Array<{ record: DriverTx }>).map((r) => r.record);
  const statements = async () => ((await ok('GET', `${ACCT}/settlements`)) as Statement[] & Array<{ partyId: string }>).filter((s) => (s as unknown as { partyId: string }).partyId === driverId);
  const statement = async (id: string) => (await ok('GET', `${ACCT}/settlements/${id}`)) as Statement;
  const layoverLines = (s: Statement) => s.computation.earnings.filter((e) => /Layover/.test(e.description));

  /**
   * RTS takes one CSV every five minutes. This spec sends twice in a few seconds, so for its own
   * sends the gap is not read (earlier sends are hidden from the check) and the send is stamped an
   * hour back - which also keeps the shared test database from holding another spec's next send.
   */
  const sendBatch = async (invoiceIds: string[]) => {
    const batch = (await ok('POST', `${ACCT}/rts/batches`, { invoiceIds })) as { id: string; batchNumber: string };
    const { version } = (await ok('GET', `${ACCT}/rts/batches/${batch.id}`)) as { version: number };
    const realBatches = rts.batches.bind(rts);
    const at = new Date(Date.now() - 3_600_000);
    rts.batches = async (p) => (await realBatches(p)).map((b) => ({ ...b, ftpSends: [] }));
    rts.clock = () => at;
    try {
      const sent = (await ok('POST', `${ACCT}/rts/batches/${batch.id}/send`, { expectedVersion: version })) as { status: string; batchNumber: string };
      expect(sent.status).toBe('submitted');
      return sent;
    } finally {
      rts.batches = realBatches;
      rts.clock = () => new Date();
    }
  };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    rts = app.get(RtsBatchesService);
    // RTS's FTPS server is not called: the upload is captured, as a production account would send it.
    const ftp = app.get(RtsFtpService);
    ftp.uploader = async () => ({ ok: true, accountId: 'int_e2e_late', name: 'RTS', clientNumber: 'E2ECLIENT', host: 'ftps.example', test: false }) as never;
    ftp.upload = async (_c, _a, pdfs, csv) => {
      uploads.push({ pdfs: pdfs.map((f) => f.name), pages: await Promise.all(pdfs.map(async (f) => (await PDFDocument.load(f.data)).getPageCount())), csv: csv.data.toString() });
      return { uploaded: [...pdfs.map((f) => f.name), csv.name] };
    };

    const t = await call('POST', '/api/v1/trucks', { unitNumber: `LT-${tag}`.slice(0, 20), vin: `1LT${tag}`.replace(/[IOQ]/g, '0').padEnd(17, '6').slice(0, 17), year: 2022, make: 'E2E', model: 'Late', odometer: 100_000, status: 'available' });
    expect(t.statusCode, t.body).toBe(201);
    truckId = (t.json() as { id: string }).id;
    const [anyDriver] = await db.select({ companyId: drivers.companyId }).from(drivers).limit(1);
    companyId = anyDriver?.companyId ?? 'co_northwind';
    await db.insert(drivers).values({ id: driverId, companyId, driverNumber: `E2E-LT-${tag}`, firstName: 'E2E', lastName: `Late ${tag}`, phone: '5550000009', email: `e2e-lt-${tag}@example.test`.toLowerCase(), driverType: 'lease_operator', cdlState: 'IL', cdlClass: 'A', cdlExpiresOn: '2030-01-01', cdlStatus: 'missing', medicalCardStatus: 'missing', hireDate: shift(today, -120), status: 'active', dispatcherId: '', dispatcherName: '', currentTruckId: truckId, homeCity: 'Chicago', homeState: 'IL', payPlanKind: 'per_mile', payPlanRate: '1' });
    const s = (await ok('GET', `${ACCT}/settings`)) as { version: number; settings: { payOnFundingOnly: boolean | null } };
    await ok('PUT', `${ACCT}/settings`, { expectedVersion: s.version, settings: { cutoffBasis: 'delivered_at', cutoffTimezoneConfirmed: true, payOnFundingOnly: s.settings.payOnFundingOnly ?? false, payPeriodCutoffTime: '12:00' } });
    const acct = (await ok('GET', `${ACCT}/drivers/${driverId}/account`)) as { profile: { version: number } };
    await ok('PUT', `${ACCT}/drivers/${driverId}/profile`, { expectedVersion: acct.profile.version, effectiveFrom: shift(today, -120), contractType: 'LO', switches: { deductFuel: false, deductTolls: false, deductApprovedAdvances: true, recurringDeductions: false, escrowEnabled: false }, loadedPlan: { kind: 'per_mile', rate: 1 }, emptyPlan: { kind: 'none', rate: 0 }, escrow: { targetCents: 0, perSettlementCents: 0, openingBalanceCents: 0, openingReconciled: true }, lease: null, reason: 'e2e', openingDebtCents: 0, openingDebtReconciled: true, confirmRate: true });

    // The paperwork, with real bytes in the file store: RC, BOL, POD and - later - the layover receipt.
    const files = app.get(FilesService);
    const pdf = async (text: string) => {
      const d = await PDFDocument.create();
      d.addPage([612, 792]).drawText(text, { x: 50, y: 700 });
      return Buffer.from(await d.save());
    };
    const doc = async (loadId: string, type: string, title: string) => {
      const f = await files.store(companyId, { fileName: `${type}-${loadId}.pdf`, contentType: 'application/pdf', bytes: await pdf(`${title} ${loadId}`), uploadedBy: 'e2e' });
      return { id: `doc_${type}_${loadId}`, type, title, fileName: `${type}-${loadId}.pdf`, sizeBytes: 900, uploadedAt: `${deliveredDay}T18:00:00.000Z`, uploadedBy: 'e2e', status: 'received', review: 'reviewed', fileHash: `hash-${type}-${loadId}`, fileId: f.id, fileUrl: `/api/v1/files/${f.id}`, mimeType: 'application/pdf' };
    };
    const row = async (id: string, n: string, ref: string) => {
      const deliveredAt = `${deliveredDay}T17:00:00.000Z`;
      const documents = [await doc(id, 'rate_confirmation', 'RC'), await doc(id, 'bol', 'BOL'), await doc(id, 'pod', 'POD')];
      return { id, companyId, loadNumber: n, status: 'delivered', driverId, truckId, record: { id, loadNumber: n, status: 'delivered', driverId, truckId, brokerReference: ref, brokerName: `E2E Broker ${tag}`, brokerId: `brk_e2e_${tag}`.toLowerCase(), customerName: `E2E Shipper ${tag}`, deliveredAt, updatedAt: deliveredAt, rate: 2000, loadedMiles: 1000, emptyMiles: 0, documents, timeline: [], notes: [], charges: [{ id: 'lh', type: 'linehaul', description: 'Linehaul', amount: 2000, billable: true, payableToDriver: false, status: 'accepted' }], stops: [{ id: `${id}_s1`, kind: 'pickup', status: 'departed', city: 'Chicago', state: 'IL', facilityName: 'Shipper' }, { id: `${id}_s2`, kind: 'delivery', status: 'departed', city: 'Dallas', state: 'TX', facilityName: 'Receiver' }] } };
    };
    await db.insert(loads).values(await row(sentLoad, `E2E-LT1-${tag}`, brokerRef)).onConflictDoNothing();
    await db.insert(loads).values(await row(draftLoad, `E2E-LT2-${tag}`, `${brokerRef}-2`)).onConflictDoNothing();
    // The layover receipt the driver sends after the invoice went: uploaded in the dialog, so only
    // in the file store for now.
    receiptFileId = (await files.store(companyId, { fileName: `layover-receipt-${tag}.pdf`, contentType: 'application/pdf', bytes: await pdf('Layover receipt'), uploadedBy: 'e2e' })).id;

    // Week A: both loads paid and the statement approved, before anything is invoiced late.
    await ok('POST', `${ACCT}/settlements/generate`, { kind: 'lo_oo', weekOf: deliveredDay });
    stmA = (await statements()).find((x) => x.periodStart <= deliveredDay && x.periodEnd >= deliveredDay)!.id;
    const a = await statement(stmA);
    expect(a.loadIds.sort()).toEqual([sentLoad, draftLoad].sort());
    expect(a.exceptions, a.exceptions.join(' ')).toEqual([]);
    const approved = (await ok('POST', `${ACCT}/settlements/${stmA}/approve`, {})) as Outcome;
    expect(approved.ok, approved.blocked).toBe(true);
  }, 240_000);

  afterAll(async () => {
    await db.update(loads).set({ status: 'cancelled' }).where(and(eq(loads.companyId, companyId), eq(loads.driverId, driverId)));
    await app?.close();
  });

  it('the load is invoiced, batched and sent to RTS', async () => {
    const created = (await ok('POST', `${ACCT}/invoices/from-loads`, { ids: [sentLoad] })) as { created: InvoiceRecord[]; skipped: Array<{ reason: string }> };
    expect(created.skipped, JSON.stringify(created.skipped)).toEqual([]);
    const issued = (await ok('POST', `${ACCT}/invoices/${created.created[0]!.id}/issue`, {})) as { ok: boolean; blocked?: string; invoice: InvoiceRecord };
    expect(issued.ok, issued.blocked).toBe(true);
    await sendBatch([issued.invoice.id]);
    original = await invoice(issued.invoice.id);
    expect(original.status).toBe('submitted');
    expect(original.submission?.status).toBe('submitted');
    expect(uploads.at(-1)!.pdfs).toEqual([`${original.invoiceNumber}.pdf`]);
  }, 120_000);

  it('a sent invoice is not revised; Add charge after invoicing bills the layover on INV-…-S1 and the original is unchanged', async () => {
    const revise = (await ok('POST', `${ACCT}/invoices/${original.id}/revise`, { reason: 'Layover approved', lines: [...original.lines.map((l) => ({ chargeType: l.chargeType, description: l.description, amount: l.amount })), { chargeType: 'layover', description: 'Layover', amount: 250 }], expectedUpdatedAt: original.updatedAt })) as { ok: boolean; blocked?: string };
    expect(revise.ok).toBe(false);
    expect(revise.blocked).toMatch(/Add charge after invoicing/);

    const check = (await ok('GET', `${ACCT}/invoices/${original.id}/supplements`)) as { check: { ok: boolean }; supplements: InvoiceRecord[] };
    expect(check.check.ok).toBe(true);
    expect(check.supplements).toEqual([]);

    const body = { requestKey: `req-${tag}-1`, reason: 'Layover approved by the broker after delivery', charges: [{ chargeType: 'layover', description: 'Layover', amount: 250, supportingDocumentIds: [], newFiles: [{ fileId: receiptFileId, fileName: 'layover-receipt.pdf' }], payableToDriver: true, driverPay: { mode: 'fixed', value: 150 } }], issueNow: true, expectedUpdatedAt: original.updatedAt };
    const out = (await ok('POST', `${ACCT}/invoices/${original.id}/supplements`, body)) as AddOut;
    expect(out.ok, out.blocked).toBe(true);
    expect(out.issueBlocked ?? null).toBeNull();
    supplement = out.invoice;
    expect(supplement.invoiceNumber).toBe(`${original.invoiceNumber}-S1`);
    expect(supplement).toMatchObject({ status: 'issued', total: 250, balance: 250, loadId: sentLoad, billToName: original.billToName, billToId: original.billToId, isCurrent: true, supplementOf: { invoiceId: original.id, invoiceNumber: original.invoiceNumber, sequence: 1 } });
    expect(supplement.rc?.loadReference).toBe(brokerRef);
    // The receipt is filed on the load as a layover document and backs the charge.
    const receiptDoc = ((await loadRecord(sentLoad))['documents'] as Array<{ id: string; type: string; fileId?: string }>).filter((d) => d.fileId === receiptFileId);
    expect(receiptDoc).toEqual([expect.objectContaining({ type: 'layover' })]);
    expect(supplement.lines).toEqual([expect.objectContaining({ chargeType: 'layover', amount: 250, supportingDocuments: [expect.objectContaining({ id: receiptDoc[0]!.id })] })]);
    expect(supplement.documentPackage.map((d) => d.type).sort()).toEqual(['bol', 'pod', 'rate_confirmation']);
    expect(supplement.invoiceNote).toMatch(new RegExp(`Supplemental invoice to ${original.invoiceNumber}`));
    expect(out.driverPay).toEqual([{ chargeId: supplement.lines[0]!.loadChargeId, treatment: 'paid_separately' }]);

    // A retry (double click) returns the same invoice and adds nothing twice.
    const again = (await ok('POST', `${ACCT}/invoices/${original.id}/supplements`, body)) as AddOut;
    expect(again).toMatchObject({ ok: true, existing: true });
    expect(again.invoice.id).toBe(supplement.id);

    // The original exactly as it was sent: lines, total, status, submission, PDF, history.
    expect(await invoice(original.id)).toEqual(original);
    // The load keeps its invoice and now carries the layover, marked as billed after invoicing.
    const load = await loadRecord(sentLoad);
    expect(load.invoiceId).toBe(original.id);
    const late = load.charges.filter((c) => c['type'] === 'layover');
    expect(late).toEqual([expect.objectContaining({ id: supplement.lines[0]!.loadChargeId, amount: 250, billable: true, status: 'accepted', payableToDriver: true, addedAfterInvoice: expect.objectContaining({ invoiceId: supplement.id }) })]);

    const audit = (await db.execute(sql`select action from audit_logs where company_id = ${companyId} and entity_id = ${supplement.id}`)) as unknown as Array<{ action: string }>;
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(['invoice_supplement_created', 'invoice_issued']));
    // The load is back in the billing queue with the supplement to send - Ready to submit, like any
    // issued invoice - and the original beside it.
    const queue = (await ok('GET', `${ACCT}/billing/queue`)) as { rows: Array<{ load: { id: string }; verdict: { queue: string | null }; invoice: InvoiceRecord | null; parentInvoice: InvoiceRecord | null; supplements: InvoiceRecord[] }> };
    const row = queue.rows.find((r) => r.load.id === sentLoad)!;
    expect(row.verdict.queue).toBe('ready_to_submit');
    expect(row.invoice?.id).toBe(supplement.id);
    expect(row.parentInvoice?.id).toBe(original.id);
    expect(row.supplements.map((x) => x.id)).toEqual([supplement.id]);
    // A stale screen is refused.
    const stale = (await ok('POST', `${ACCT}/invoices/${original.id}/supplements`, { ...body, requestKey: `req-${tag}-stale`, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' })) as AddOut;
    expect(stale.ok).toBe(false);
    expect(stale.blocked).toMatch(/changed since you opened it/);
  }, 120_000);

  it('the supplement is batched and sent like any invoice; the RTS file names it with the same load reference', async () => {
    const candidates = (await ok('GET', `${ACCT}/rts/candidates`)) as Array<{ invoiceId: string; eligibility: { eligible: boolean; reasons: string[] } }>;
    const c = candidates.find((x) => x.invoiceId === supplement.id)!;
    expect(c.eligibility.eligible, c.eligibility.reasons.join(' ')).toBe(true);
    // The original is not offered again.
    expect(candidates.find((x) => x.invoiceId === original.id)?.eligibility.eligible ?? false).toBe(false);

    await sendBatch([supplement.id]);
    const sent = uploads.at(-1)!;
    expect(sent.pdfs).toEqual([`${supplement.invoiceNumber}.pdf`]);
    // Its packet: the supplemental invoice with the NOA stamp, the same load's RC, BOL and POD, and the layover receipt.
    expect(sent.pages).toEqual([5]);
    const lines = sent.csv.trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(new RegExp(`^E2ECLIENT,${supplement.invoiceNumber},[^,]+,[^,]+,${brokerRef},\\d{2}/\\d{2}/\\d{4},250\\.00$`));
    const after = await invoice(supplement.id);
    expect(after.status).toBe('submitted');
    expect(await invoice(original.id)).toEqual(original);
    // Sent: the load leaves the queue again.
    const q2 = (await ok('GET', `${ACCT}/billing/queue`)) as { rows: Array<{ load: { id: string } }> };
    expect(q2.rows.some((r) => r.load.id === sentLoad)).toBe(false);
  }, 120_000);

  it('RTS funds the supplement on its own; receivables list it as its own invoice', async () => {
    const funded = (await ok('POST', `${ACCT}/fundings`, { provider: 'RTS', reference: `E2E-FUND-${tag}`, fundedOn: today, feeCents: 750, reserveCents: 0, extraFees: [], allocations: [{ invoiceId: supplement.id, grossCents: 25_000 }], netReceivedCents: 24_250 })) as { ok: boolean; blocked?: string };
    expect(funded.ok, funded.blocked).toBe(true);
    const s = await invoice(supplement.id);
    expect(s).toMatchObject({ status: 'funded', balance: 0, factoring: { fundedGross: 250 } });
    const ar = (await ok('GET', `${ACCT}/receivables`)) as InvoiceRecord[];
    expect(ar.filter((i) => i.loadId === sentLoad).map((i) => i.invoiceNumber).sort()).toEqual([original.invoiceNumber, supplement.invoiceNumber].sort());
    // A second supplement for the same load is S2.
    const two = (await ok('POST', `${ACCT}/invoices/${original.id}/supplements`, { requestKey: `req-${tag}-2`, reason: 'Lumper receipt came in', charges: [{ chargeType: 'lumper', description: 'Lumper', amount: 80, supportingDocumentIds: [], payableToDriver: false }], issueNow: false, expectedUpdatedAt: original.updatedAt })) as AddOut;
    expect(two.ok, two.blocked).toBe(true);
    expect(two.invoice).toMatchObject({ invoiceNumber: `${original.invoiceNumber}-S2`, status: 'draft' });
    // Voiding that draft supplement leaves the load on its own invoice.
    await ok('POST', `${ACCT}/invoices/${two.invoice.id}/void`, { reason: 'Broker declined the lumper' });
    const afterVoid = await loadRecord(sentLoad);
    expect(afterVoid.invoiceId).toBe(original.id);
    // ... and takes its charge off the load (dropped, kept on record).
    expect(afterVoid.charges.find((c) => c['id'] === two.invoice.lines[0]!.loadChargeId)).toMatchObject({ status: 'dropped' });
  }, 120_000);

  it('the driver, whose week was already approved, gets the layover once, on the next statement', async () => {
    const txs = await lateTxs();
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ kind: 'adjustment', state: 'approved', amountCents: 15_000, loadId: sentLoad, settlementId: null });
    // The approved statement is not touched.
    expect(layoverLines(await statement(stmA))).toEqual([]);

    await ok('POST', `${ACCT}/settlements/generate`, { kind: 'lo_oo', weekOf: today });
    const now = (await statements()).find((x) => x.periodStart <= today && x.periodEnd >= shift(today, -1) && x.id !== stmA) ?? (await statements()).sort((x, y) => y.periodStart.localeCompare(x.periodStart))[0]!;
    let cur = await statement(now.id);
    expect(layoverLines(cur).map((e) => e.cents)).toEqual([15_000]);
    // Generating again pays it once still.
    await ok('POST', `${ACCT}/settlements/generate`, { kind: 'lo_oo', weekOf: today });
    cur = await statement(now.id);
    expect(layoverLines(cur)).toHaveLength(1);

    // Reopening week A recomputes it from the load - and still does not pay the layover there.
    const reopened = (await ok('POST', `${ACCT}/settlements/${stmA}/reopen`, { reason: 'e2e: check the layover is not paid twice' })) as Outcome;
    expect(reopened.ok, reopened.blocked).toBe(true);
    expect(layoverLines(await statement(stmA))).toEqual([]);
    expect(layoverLines(await statement(now.id))).toHaveLength(1);

    // Approving the current week claims it; nothing else can take it after that.
    expect(cur.exceptions, cur.exceptions.join(' ')).toEqual([]);
    const ap = (await ok('POST', `${ACCT}/settlements/${now.id}/approve`, {})) as Outcome;
    expect(ap.ok, ap.blocked).toBe(true);
    expect((await lateTxs())[0]).toMatchObject({ state: 'applied', settlementId: now.id });
    expect(layoverLines(await statement(stmA))).toEqual([]);
  }, 180_000);

  it('before an invoice is sent the old way stays: a draft is refused, an issued one points to Create revision', async () => {
    const created = (await ok('POST', `${ACCT}/invoices/from-loads`, { ids: [draftLoad] })) as { created: InvoiceRecord[] };
    const draft = created.created[0]!;
    const onDraft = (await ok('POST', `${ACCT}/invoices/${draft.id}/supplements`, { requestKey: `req-${tag}-d`, reason: 'Layover', charges: [{ chargeType: 'layover', description: 'Layover', amount: 100, supportingDocumentIds: [] }], expectedUpdatedAt: draft.updatedAt })) as AddOut;
    expect(onDraft).toMatchObject({ ok: false, useRevision: false });
    expect(onDraft.blocked).toMatch(/still a draft/);

    const issued = ((await ok('POST', `${ACCT}/invoices/${draft.id}/issue`, {})) as { invoice: InvoiceRecord }).invoice;
    const onIssued = (await ok('POST', `${ACCT}/invoices/${issued.id}/supplements`, { requestKey: `req-${tag}-i`, reason: 'Layover', charges: [{ chargeType: 'layover', description: 'Layover', amount: 100, supportingDocumentIds: [] }], expectedUpdatedAt: issued.updatedAt })) as AddOut;
    expect(onIssued).toMatchObject({ ok: false, useRevision: true });
    // The revision still works on an issued invoice that has not gone to RTS.
    const rev = (await ok('POST', `${ACCT}/invoices/${issued.id}/revise`, { reason: 'Layover approved before submission', lines: [...issued.lines.map((l) => ({ chargeType: l.chargeType, description: l.description, amount: l.amount })), { chargeType: 'layover', description: 'Layover', amount: 100 }], expectedUpdatedAt: issued.updatedAt })) as { ok: boolean; blocked?: string; invoice: InvoiceRecord };
    expect(rev.ok, rev.blocked).toBe(true);
    expect(rev.invoice.total).toBe(2100);
    const loadNow = await loadRecord(draftLoad);
    expect(loadNow.charges.some((c) => c['type'] === 'layover')).toBe(false);
  }, 120_000);
});
