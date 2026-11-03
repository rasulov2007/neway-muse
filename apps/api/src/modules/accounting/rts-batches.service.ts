import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  RTS_FTP_GAP_MINUTES,
  RTS_FTP_PAGE,
  RTS_LIVE_STATUSES,
  RTS_SCHEDULE_COLUMNS,
  rtsFtpFileName,
  rtsFtpProblems,
  rtsFtpCsv,
  rtsFtpWaitMinutes,
  type RtsFtpRowInput,
  rtsBatchTotals,
  rtsEligibility,
  revisionFundable,
  safeCell,
  type RecordRtsSubmissionInput,
  type RtsBatchStatus,
  type RtsEligibility,
  type RtsPackageDocument,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { hasPermission } from '../../common/auth/principal';
import { companies } from '../../database/schema';
import { AuditService } from '../people/audit.service';
import { LoadsService } from '../loads/loads.service';
import { FilesService } from '../files/files.service';
import { RtsFtpService } from '../admin/connectors/rts-ftp.service';
import { conflict, forbidden, newId, unprocessable } from '../dispatch-board/ops.helpers';
import { toCsv, zip } from '../dispatch-board/xlsx';
import { ExportsService } from './exports.service';
import { InvoicesService, type InvoiceRecord } from './invoices.service';
import { AccountingStore } from './store.service';

/**
 * RTS export batches (see packages/shared/src/accounting/rts-batch.ts for the rules).
 *
 * Batches are kept in `acct_payment_batches` under their own kind, `rts_export`: the same
 * versioned, company-scoped batch table payment exports use, so no new table and no migration.
 * Payment screens read only their own kinds.
 *
 * Nothing here talks to RTS. Creating a batch reserves its invoices, exporting it produces a
 * package of files, and neither changes any invoice's standing. Recording the submission - with
 * a reference, a note or a file - is the step that marks the invoices submitted, and it goes
 * through the same per-invoice record the Billing drawer uses.
 */

export const RTS_KIND = 'rts_export';

export interface RtsBatchLine {
  invoiceId: string;
  invoiceNumber: string;
  loadId: string;
  loadNumber: string;
  debtor: string;
  issuedOn: string | null;
  dueOn: string | null;
  totalCents: number;
  documents: Array<{ id: string; type: string; fileName: string }>;
  warnings: string[];
  /** For a revision: the family's first number, which revision this is, and the money either side. */
  originalInvoiceNumber?: string;
  revision?: number;
  previousTotalCents?: number | null;
  adjustmentCents?: number | null;
  /** What is new for RTS: the whole total, or - for a revision RTS already has - only the increase. */
  fundableCents?: number;
}

export interface RtsBatchRecord {
  id: string;
  kind: typeof RTS_KIND;
  batchNumber: string;
  status: RtsBatchStatus;
  provider: 'RTS';
  lines: RtsBatchLine[];
  count: number;
  totalCents: number;
  /** The new money the batch asks RTS to consider; below the total when it carries revisions. */
  fundableCents?: number;
  createdAt: string;
  createdBy: string;
  /** Every package produced, so the file that was uploaded can be matched to its bytes later. */
  exports: Array<{ at: string; by: string; fileName: string; sha256: string; bytes: number }>;
  submission: { reference: string | null; evidence: string | null; evidenceFileId: string | null; submittedOn: string; at: string; by: string } | null;
  /** Every FTPS upload to RTS (2026-10-19): the CSV that triggered it and where it went. */
  ftpSends?: Array<{ at: string; by: string; csvName: string; files: number; host: string; clientNumber: string; sha256: string; test?: boolean }>;
  cancellation: { reason: string; at: string; by: string } | null;
  history: Array<{ at: string; by: string; action: string; detail: string }>;
  updatedAt: string;
}

export interface RtsCandidate {
  invoiceId: string;
  invoiceNumber: string;
  loadNumber: string;
  debtor: string;
  issuedOn: string | null;
  status: string;
  totalCents: number;
  documents: RtsPackageDocument[];
  inBatch: { batchId: string; batchNumber: string; status: RtsBatchStatus } | null;
  eligibility: RtsEligibility;
  originalInvoiceNumber: string;
  revision: number;
  previousTotalCents: number | null;
  adjustmentCents: number | null;
  fundableCents: number;
  priorSubmission: InvoiceRecord['priorSubmission'] | null;
}

const TYPE_TAG: Record<string, string> = { rate_confirmation: 'RC', bol: 'BOL', pod: 'POD', tonu: 'TONU' };

/** RTS's Notice of Assignment stamp, as RTS sent it (2026-10-19). */
const NOA_STAMP = resolve(__dirname, '../../../assets/factoring/rts-noa-stamp.png');

/** One RTS upload at a time per company: two clicks must not send the same batch twice. */
const sending = new Set<string>();

/** When each company last dropped a test CSV: test packets keep RTS's five minutes too. */
const lastTestDrop = new Map<string, string>();

const easternDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/**
 * The packet in grayscale, as RTS prefers, through Ghostscript when the server has it. Without it
 * (a developer's machine) the colour PDF goes as it is - RTS asks for grayscale, it does not refuse colour.
 */
async function grayscale(pdf: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'rts-'));
  try {
    await writeFile(join(dir, 'in.pdf'), pdf);
    const ok = await new Promise<boolean>((done) => {
      const gs = spawn('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pdfwrite', '-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray', '-dCompatibilityLevel=1.4', `-sOutputFile=${join(dir, 'out.pdf')}`, join(dir, 'in.pdf')]);
      gs.on('error', () => done(false));
      gs.on('close', (code) => done(code === 0));
    });
    return ok ? await readFile(join(dir, 'out.pdf')) : pdf;
  } catch {
    return pdf;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

@Injectable()
export class RtsBatchesService {
  constructor(
    private readonly store: AccountingStore,
    private readonly invoices: InvoicesService,
    private readonly loads: LoadsService,
    private readonly files: FilesService,
    private readonly exports: ExportsService,
    private readonly audit: AuditService,
    private readonly rtsFtp: RtsFtpService,
  ) {}

  clock: () => Date = () => new Date();

  private requireEdit(principal: Principal): void {
    if (!hasPermission(principal, 'accounting.edit')) throw forbidden('Only Accounting can prepare, export or record RTS batches.');
  }

  private who(principal: Principal): string {
    return principal.userName ?? principal.userId;
  }

  // ------------------------------------------------------------ reads

  async batches(principal: Principal): Promise<RtsBatchRecord[]> {
    const rows = await this.store.list<RtsBatchRecord>('acct_payment_batches', principal.companyId, sql`kind = ${RTS_KIND}`);
    return rows.map((r) => r.record).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async batch(principal: Principal, id: string): Promise<{ record: RtsBatchRecord; version: number }> {
    const stored = await this.store.get<RtsBatchRecord>('acct_payment_batches', principal.companyId, id);
    if (stored.record.kind !== RTS_KIND) throw unprocessable(`${id} is not an RTS batch.`);
    return { record: stored.record, version: stored.version };
  }

  /** The live batch holding each invoice, so nothing can be batched twice. */
  private async liveHolders(principal: Principal): Promise<Map<string, { batchId: string; batchNumber: string; status: RtsBatchStatus }>> {
    const held = new Map<string, { batchId: string; batchNumber: string; status: RtsBatchStatus }>();
    for (const b of await this.batches(principal)) {
      if (!RTS_LIVE_STATUSES.has(b.status)) continue;
      for (const l of b.lines) held.set(l.invoiceId, { batchId: b.id, batchNumber: b.batchNumber, status: b.status });
    }
    return held;
  }

  /**
   * The documents an invoice was issued with, checked against the load as it stands now: a file
   * replaced or rejected since the invoice was issued is not something to send RTS.
   */
  private async packageDocuments(principal: Principal, inv: InvoiceRecord, loadCache: Map<string, Awaited<ReturnType<LoadsService['get']>> | null>): Promise<Array<RtsPackageDocument & { fileId: string | null }>> {
    if (!loadCache.has(inv.loadId)) loadCache.set(inv.loadId, await this.loads.get(principal, inv.loadId).catch(() => null));
    const load = loadCache.get(inv.loadId) ?? null;
    return (inv.documentPackage ?? [])
      .filter((d) => d.type in TYPE_TAG)
      .map((d) => {
        const onLoad = load?.documents.find((x) => x.id === d.id) as (Record<string, unknown> & { review?: string }) | undefined;
        const fileId = (onLoad?.['fileId'] as string | undefined) ?? String(onLoad?.['fileUrl'] ?? '').split('/files/')[1] ?? null;
        return {
          id: d.id,
          type: d.type,
          fileName: d.fileName,
          stillCurrent: Boolean(onLoad) && !onLoad!['supersededBy'] && onLoad!.review !== 'rejected',
          hasBytes: Boolean(fileId),
          fileId: fileId || null,
        };
      });
  }

  /** Every current invoice with whether it can be batched and, if not, why. */
  async candidates(principal: Principal): Promise<RtsCandidate[]> {
    const held = await this.liveHolders(principal);
    const loadCache = new Map();
    const out: RtsCandidate[] = [];
    for (const inv of await this.invoices.list(principal)) {
      if (!inv.isCurrent || inv.status === 'void') continue;
      const documents = await this.packageDocuments(principal, inv, loadCache);
      const inBatch = held.get(inv.id) ?? null;
      const totalCents = Math.round(inv.total * 100);
      const previousTotalCents = inv.revisionOf ? Math.round(inv.revisionOf.previousTotal * 100) : null;
      const fund = revisionFundable({ previousTotalCents: previousTotalCents ?? totalCents, revisedTotalCents: totalCents, previouslySubmitted: Boolean(inv.priorSubmission) });
      const eligibility = rtsEligibility({ id: inv.id, invoiceNumber: inv.invoiceNumber, status: inv.status, isCurrent: inv.isCurrent, total: inv.total, submission: inv.submission, factoring: inv.factoring, tonu: inv.lines.some((l) => l.chargeType === 'tonu') }, documents, inBatch);
      if (inv.priorSubmission) {
        eligibility.warnings.push(`Revision of ${inv.priorSubmission.invoiceNumber}, which RTS already has (${inv.priorSubmission.status}${inv.priorSubmission.reference ? `, ${inv.priorSubmission.reference}` : ''}). Only ${fund.fundableCents >= 0 ? `$${(fund.fundableCents / 100).toFixed(2)}` : '$0.00'} is new; RTS has not confirmed how it takes revisions.`);
      }
      out.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        loadNumber: inv.loadNumber,
        debtor: inv.billToName,
        issuedOn: inv.issuedOn,
        status: inv.status,
        totalCents: Math.round(inv.total * 100),
        documents: documents.map(({ fileId: _f, ...d }) => d),
        inBatch,
        eligibility,
        originalInvoiceNumber: inv.family,
        revision: inv.revision,
        previousTotalCents,
        adjustmentCents: previousTotalCents === null ? null : totalCents - previousTotalCents,
        fundableCents: fund.fundableCents,
        priorSubmission: inv.priorSubmission ?? null,
      });
    }
    // Eligible first, then the ones that say why not.
    return out.sort((a, b) => Number(b.eligibility.eligible) - Number(a.eligibility.eligible) || (b.issuedOn ?? '').localeCompare(a.issuedOn ?? ''));
  }

  // ------------------------------------------------------------ create · export · cancel · submit

  async create(principal: Principal, invoiceIds: string[]): Promise<RtsBatchRecord> {
    this.requireEdit(principal);
    const unique = [...new Set(invoiceIds)];
    const candidates = new Map((await this.candidates(principal)).map((c) => [c.invoiceId, c]));
    const refused = unique.map((id) => ({ id, c: candidates.get(id) })).filter(({ c }) => !c || !c.eligibility.eligible);
    if (refused.length > 0) {
      // One line per reason, the invoices it holds back listed once (owner, 2026-10-30: twelve
      // copies of "Already in RTS-00004" read like twelve problems).
      const byReason = new Map<string, string[]>();
      for (const { id, c } of refused) {
        const reason = c ? c.eligibility.reasons.join(' ') : 'not a current invoice of this company.';
        byReason.set(reason, [...(byReason.get(reason) ?? []), c?.invoiceNumber ?? id]);
      }
      throw unprocessable([...byReason].map(([reason, numbers]) => `${numbers.join(', ')}: ${reason}`).join(' | '));
    }
    const now = this.clock().toISOString();
    const count = (await this.batches(principal)).length;
    const lines: RtsBatchLine[] = unique.map((id) => {
      const c = candidates.get(id)!;
      return {
        invoiceId: id,
        invoiceNumber: c.invoiceNumber,
        loadId: '',
        loadNumber: c.loadNumber,
        debtor: c.debtor,
        issuedOn: c.issuedOn,
        dueOn: null,
        totalCents: c.totalCents,
        documents: c.documents.filter((d) => d.stillCurrent).map((d) => ({ id: d.id, type: d.type, fileName: d.fileName })),
        warnings: c.eligibility.warnings,
        originalInvoiceNumber: c.originalInvoiceNumber,
        revision: c.revision,
        previousTotalCents: c.previousTotalCents,
        adjustmentCents: c.adjustmentCents,
        fundableCents: c.fundableCents,
      };
    });
    const totals = rtsBatchTotals(lines.map((l) => ({ totalCents: l.totalCents, documents: l.documents.map((d) => d.type) })));
    const rec: RtsBatchRecord = {
      id: newId('rtsb'),
      kind: RTS_KIND,
      batchNumber: `RTS-${String(count + 1).padStart(5, '0')}`,
      status: 'prepared',
      provider: 'RTS',
      lines,
      count: totals.count,
      totalCents: totals.totalCents,
      fundableCents: lines.reduce((t, l) => t + (l.fundableCents ?? l.totalCents), 0),
      createdAt: now,
      createdBy: this.who(principal),
      exports: [],
      submission: null,
      cancellation: null,
      history: [{ at: now, by: this.who(principal), action: 'created', detail: `${totals.count} invoice(s), $${(totals.totalCents / 100).toFixed(2)}` }],
      updatedAt: now,
    };
    await this.store.insert('acct_payment_batches', principal.companyId, rec as unknown as Record<string, unknown> & { id: string });

    // Reserve each invoice for this batch. Reading the holders again closes the gap between the
    // eligibility check and the insert: two people building batches at once cannot both win.
    const held = await this.liveHolders(principal);
    const taken = rec.lines.filter((l) => held.get(l.invoiceId)?.batchId !== rec.id);
    if (taken.length > 0) {
      await this.cancelRecord(principal, rec.id, 'Another batch took one of its invoices at the same moment.');
      throw conflict(`Another batch already holds ${taken.map((l) => l.invoiceNumber).join(', ')}.`);
    }
    for (const l of rec.lines) {
      const inv = await this.invoices.get(principal, l.invoiceId);
      l.loadId = inv.loadId;
      l.dueOn = inv.dueOn;
      await this.store.modify<InvoiceRecord & { rtsBatch?: { batchId: string; batchNumber: string } | null }>('acct_invoices', principal.companyId, l.invoiceId, (row) => ({
        ...row,
        rtsBatch: { batchId: rec.id, batchNumber: rec.batchNumber },
        history: [...row.history, { at: now, by: this.who(principal), action: 'rts_batched', detail: `Added to ${rec.batchNumber} (export only; nothing sent)` }],
      }));
    }
    await this.store.modify<RtsBatchRecord>('acct_payment_batches', principal.companyId, rec.id, (row) => ({ ...row, lines: rec.lines }));
    await this.audit.write(principal, { action: 'rts_batch_created', entityType: 'rts_batch', entityId: rec.id, entityLabel: rec.batchNumber, summary: `${rec.count} invoice(s), $${(rec.totalCents / 100).toFixed(2)}`, changes: [] });
    return { ...rec };
  }

  private async cancelRecord(principal: Principal, id: string, reason: string): Promise<RtsBatchRecord> {
    const now = this.clock().toISOString();
    const after = await this.store.modify<RtsBatchRecord>('acct_payment_batches', principal.companyId, id, (row) => ({
      ...row,
      status: 'cancelled',
      cancellation: { reason, at: now, by: this.who(principal) },
      history: [...row.history, { at: now, by: this.who(principal), action: 'cancelled', detail: reason }],
      updatedAt: now,
    }));
    return after.record;
  }

  /** Cancels a batch that has not been submitted; its invoices can be batched again. History stays. */
  async cancel(principal: Principal, id: string, input: { reason: string; expectedVersion: number }): Promise<RtsBatchRecord> {
    this.requireEdit(principal);
    const { record, version } = await this.batch(principal, id);
    if (version !== input.expectedVersion) throw conflict(`${record.batchNumber} changed since you opened it. Reload and try again.`);
    if (record.status === 'submitted') throw unprocessable(`${record.batchNumber} is recorded as submitted to RTS. A submitted batch is corrected with RTS, not cancelled here.`);
    if (record.status === 'cancelled') throw unprocessable(`${record.batchNumber} is already cancelled.`);
    const after = await this.cancelRecord(principal, id, input.reason);
    const now = this.clock().toISOString();
    for (const l of record.lines) {
      await this.store.modify<InvoiceRecord & { rtsBatch?: { batchId: string } | null }>('acct_invoices', principal.companyId, l.invoiceId, (row) => ({
        ...row,
        rtsBatch: row.rtsBatch?.batchId === id ? null : row.rtsBatch ?? null,
        history: [...row.history, { at: now, by: this.who(principal), action: 'rts_batch_cancelled', detail: `${record.batchNumber} cancelled: ${input.reason}` }],
      }));
    }
    await this.audit.write(principal, { action: 'rts_batch_cancelled', entityType: 'rts_batch', entityId: id, entityLabel: record.batchNumber, summary: input.reason, changes: [{ field: 'status', old: record.status, new: 'cancelled' }] });
    return after;
  }

  /**
   * The package a person uploads to RTS: a schedule of accounts, and for each invoice the invoice
   * PDF, its RC, BOL and POD, and all of them merged into one packet in that order.
   *
   * Producing it is recorded (who, when, the file's hash) and nothing else: no invoice becomes
   * sent, submitted or accepted because a file was downloaded.
   */
  async exportPackage(principal: Principal, id: string): Promise<{ fileName: string; data: Buffer }> {
    this.requireEdit(principal);
    const { record } = await this.batch(principal, id);
    if (record.status === 'cancelled') throw unprocessable(`${record.batchNumber} is cancelled.`);
    const [co] = await this.store.db.select({ name: companies.name }).from(companies).where(eq(companies.id, principal.companyId)).limit(1);
    const company = co?.name ?? principal.companyId;
    const loadCache = new Map();
    const files: Array<{ name: string; data: Buffer }> = [];
    const manifest: Array<Record<string, unknown>> = [];
    const schedule: Array<Array<string | number>> = [[...RTS_SCHEDULE_COLUMNS]];

    for (const line of record.lines) {
      const inv = await this.invoices.get(principal, line.invoiceId);
      const dir = line.invoiceNumber.replace(/[^\w.-]+/g, '_');
      const invoicePdf = await this.invoices.pdfBytes(principal, inv);
      files.push({ name: `${dir}/${dir}_invoice.pdf`, data: invoicePdf });
      const packet = await PDFDocument.create();
      const addToPacket = async (bytes: Buffer, label: string) => {
        try {
          if (bytes.subarray(0, 4).toString() === '%PDF') {
            const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
            for (const p of await packet.copyPages(src, src.getPageIndices())) packet.addPage(p);
          } else {
            const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
            const img = isPng ? await packet.embedPng(bytes) : await packet.embedJpg(bytes);
            const page = packet.addPage([612, 792]);
            const scale = Math.min(572 / img.width, 752 / img.height, 1);
            page.drawImage(img, { x: (612 - img.width * scale) / 2, y: (792 - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
          }
          return true;
        } catch {
          manifest.push({ invoice: line.invoiceNumber, problem: `${label} could not be merged into the packet; it is included as its own file.` });
          return false;
        }
      };
      const docs = await this.packageDocuments(principal, inv, loadCache);
      const included: string[] = [];
      // The files each charge points to - a detention approval - travel with the invoice.
      const supporting = inv.lines.flatMap((l) => (l.supportingDocuments ?? []).map((d) => ({ ...d, charge: l.description })));
      const supportingIds = new Set(supporting.map((d) => d.id));
      const enclosed = [
        `Invoice ${inv.invoiceNumber}${inv.revision > 1 ? ` (revision ${inv.revision} of ${inv.family})` : ''}${inv.supplementOf ? ` (supplemental to ${inv.supplementOf.invoiceNumber}; RC, BOL and POD of the same load as backup)` : ''}`,
        ...(['rate_confirmation', 'bol', 'pod', 'tonu'] as const).flatMap((t) => docs.filter((d) => d.type === t && d.stillCurrent && d.fileId && !supportingIds.has(d.id)).map((d) => `${TYPE_TAG[t]} - ${d.fileName}`)),
        ...supporting.map((d) => `Supporting "${d.charge}" - ${d.fileName}`),
      ];
      const cover = await this.exports.packetCover(inv, company, enclosed, line.fundableCents ?? line.totalCents);
      files.push({ name: `${dir}/${dir}_cover.pdf`, data: cover });
      await addToPacket(cover, 'Cover');
      await addToPacket(invoicePdf, 'Invoice');
      for (const type of ['rate_confirmation', 'bol', 'pod', 'tonu']) {
        let n = 0;
        for (const d of docs.filter((x) => x.type === type && x.stillCurrent && x.fileId)) {
          n += 1;
          const { info, bytes } = await this.files.read(principal.companyId, d.fileId!);
          const ext = (info.fileName.match(/\.[a-z0-9]+$/i)?.[0] ?? '.pdf').toLowerCase();
          files.push({ name: `${dir}/${dir}_${TYPE_TAG[type]}_${n}${ext}`, data: bytes });
          await addToPacket(bytes, TYPE_TAG[type]!);
          included.push(TYPE_TAG[type]!);
        }
      }
      const loadNow = loadCache.get(inv.loadId) ?? null;
      let s = 0;
      for (const d of supporting) {
        const onLoad = loadNow?.documents.find((x: { id: string }) => x.id === d.id) as Record<string, unknown> | undefined;
        const fileId = (onLoad?.['fileId'] as string | undefined) ?? String(onLoad?.['fileUrl'] ?? '').split('/files/')[1];
        if (!fileId) continue;
        s += 1;
        const { info, bytes } = await this.files.read(principal.companyId, fileId);
        const ext = (info.fileName.match(/\.[a-z0-9]+$/i)?.[0] ?? '.pdf').toLowerCase();
        files.push({ name: `${dir}/${dir}_SUPPORTING_${s}${ext}`, data: bytes });
        await addToPacket(bytes, `Supporting ${s}`);
        included.push('SUPPORTING');
      }
      files.push({ name: `${dir}/${dir}_packet.pdf`, data: Buffer.from(await packet.save()) });
      const adj = line.adjustmentCents ?? null;
      schedule.push([safeCell(line.invoiceNumber), safeCell(inv.supplementOf ? `${inv.supplementOf.invoiceNumber} (supplemental)` : inv.family), inv.revision, inv.issuedOn ?? '', inv.dueOn ?? '', safeCell(inv.billToName), safeCell(inv.loadNumber), safeCell(inv.rc?.loadReference ?? ''), (line.totalCents / 100).toFixed(2), line.previousTotalCents == null ? '' : (line.previousTotalCents / 100).toFixed(2), adj == null ? '' : (adj / 100).toFixed(2), ((line.fundableCents ?? line.totalCents) / 100).toFixed(2), included.join(' + ')]);
      manifest.push({ invoice: line.invoiceNumber, originalInvoice: inv.supplementOf?.invoiceNumber ?? inv.family, supplementalTo: inv.supplementOf ? { invoice: inv.supplementOf.invoiceNumber, reason: inv.supplementOf.reason } : null, revision: inv.revision, load: inv.loadNumber, debtor: inv.billToName, amount: (line.totalCents / 100).toFixed(2), previousTotal: line.previousTotalCents == null ? null : (line.previousTotalCents / 100).toFixed(2), adjustment: adj == null ? null : (adj / 100).toFixed(2), amountToFund: ((line.fundableCents ?? line.totalCents) / 100).toFixed(2), previouslyWithRts: inv.priorSubmission ?? null, documents: included });
    }
    schedule.push(['TOTAL', '', '', '', '', '', '', '', (record.totalCents / 100).toFixed(2), '', '', ((record.fundableCents ?? record.totalCents) / 100).toFixed(2), `${record.count} invoice(s)`]);
    const exportedAt = this.clock().toISOString();
    files.unshift({ name: 'schedule.csv', data: Buffer.from(toCsv(schedule)) });
    files.push({
      name: 'manifest.json',
      data: Buffer.from(
        JSON.stringify(
          {
            batch: record.batchNumber,
            company,
            invoices: record.count,
            total: (record.totalCents / 100).toFixed(2),
            exportedAt,
            exportedBy: this.who(principal),
            note: 'Export only. Nothing has been sent to RTS; record the submission in NeWay after uploading.',
            supplementals: 'A supplemental invoice (INV-10004-S1) bills charges approved after the original was sent - layover, detention, lumper. It is its own invoice for the same load and broker reference; the original is unchanged.',
            revisions: 'A revised invoice is listed under its current number (INV2-, INV3-) with its original number. RTS has not confirmed how it takes revisions; the adjustment is reported, not claimed as accepted.',
            scheduleLayout: 'NeWay schedule of accounts - confirm the columns against RTS’s current upload template.',
            lines: manifest,
          },
          null,
          2,
        ),
      ),
    });
    const data = zip(files);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const fileName = `${record.batchNumber}_RTS_package.zip`;
    await this.store.modify<RtsBatchRecord>('acct_payment_batches', principal.companyId, id, (row) => ({
      ...row,
      // "exported" means a package exists; it says nothing about RTS having it.
      status: row.status === 'prepared' ? 'exported' : row.status,
      exports: [...row.exports, { at: exportedAt, by: this.who(principal), fileName, sha256, bytes: data.length }],
      history: [...row.history, { at: exportedAt, by: this.who(principal), action: 'exported', detail: `${fileName} · sha256 ${sha256.slice(0, 16)}` }],
      updatedAt: exportedAt,
    }));
    await this.audit.write(principal, { action: 'rts_package_exported', entityType: 'rts_batch', entityId: id, entityLabel: record.batchNumber, summary: `${fileName} (${data.length} bytes, sha256 ${sha256.slice(0, 16)}) - not sent`, changes: [] });
    return { fileName, data };
  }

  // ------------------------------------------------------------ RTS FTPS (one way, 2026-10-19)

  /**
   * One invoice as RTS wants it: the invoice sheet with RTS's NOA stamp, then the RC, BOL, POD and
   * any supporting files, every page fitted to 8 x 10 portrait, in grayscale when the server can.
   */
  private async ftpPacket(principal: Principal, inv: InvoiceRecord, loadCache: Map<string, Awaited<ReturnType<LoadsService['get']>> | null>, problems: string[]): Promise<Buffer> {
    const merged = await PDFDocument.create();
    const add = async (bytes: Buffer, label: string) => {
      try {
        if (bytes.subarray(0, 4).toString() === '%PDF') {
          const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
          for (const p of await merged.copyPages(src, src.getPageIndices())) merged.addPage(p);
        } else {
          const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
          const img = isPng ? await merged.embedPng(bytes) : await merged.embedJpg(bytes);
          merged.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        }
      } catch {
        problems.push(`${inv.invoiceNumber}: the ${label} could not be read into the PDF.`);
      }
    };
    await add(await this.stampNoa(await this.invoices.pdfBytes(principal, inv)), 'invoice');
    const docs = await this.packageDocuments(principal, inv, loadCache);
    const supporting = inv.lines.flatMap((l) => l.supportingDocuments ?? []);
    const supportingIds = new Set(supporting.map((d) => d.id));
    for (const type of ['rate_confirmation', 'bol', 'pod', 'tonu']) {
      for (const d of docs.filter((x) => x.type === type && x.stillCurrent && x.fileId && !supportingIds.has(x.id))) {
        await add((await this.files.read(principal.companyId, d.fileId!)).bytes, TYPE_TAG[type]!);
      }
    }
    const loadNow = loadCache.get(inv.loadId) ?? null;
    for (const d of supporting) {
      const onLoad = loadNow?.documents.find((x: { id: string }) => x.id === d.id) as Record<string, unknown> | undefined;
      const fileId = (onLoad?.['fileId'] as string | undefined) ?? String(onLoad?.['fileUrl'] ?? '').split('/files/')[1];
      if (fileId) await add((await this.files.read(principal.companyId, fileId)).bytes, `supporting file ${d.fileName}`);
    }
    // Every page onto an 8 x 10 portrait sheet, scaled to fit and centred.
    const out = await PDFDocument.create();
    const pages = await out.embedPdf(await merged.save(), merged.getPageIndices());
    for (const p of pages) {
      const scale = Math.min(RTS_FTP_PAGE.width / p.width, RTS_FTP_PAGE.height / p.height);
      out.addPage([RTS_FTP_PAGE.width, RTS_FTP_PAGE.height]).drawPage(p, {
        x: (RTS_FTP_PAGE.width - p.width * scale) / 2,
        y: (RTS_FTP_PAGE.height - p.height * scale) / 2,
        width: p.width * scale,
        height: p.height * scale,
      });
    }
    return grayscale(Buffer.from(await out.save()));
  }

  /** RTS's Notice of Assignment, bottom right of the invoice sheet's last page. */
  private async stampNoa(invoicePdf: Buffer): Promise<Buffer> {
    const doc = await PDFDocument.load(invoicePdf);
    const stamp = await doc.embedPng(readFileSync(NOA_STAMP));
    const page = doc.getPage(doc.getPageCount() - 1);
    const width = 200;
    const height = (stamp.height / stamp.width) * width;
    page.drawImage(stamp, { x: page.getWidth() - width - 36, y: 54, width, height });
    return Buffer.from(await doc.save());
  }

  /** The PDFs and the CSV of one submission, and everything RTS would refuse about them. */
  private async ftpSubmission(principal: Principal, record: RtsBatchRecord, clientNumber: string): Promise<{ pdfs: Array<{ name: string; data: Buffer }>; csv: { name: string; data: Buffer }; problems: string[] }> {
    if (record.status === 'cancelled') throw unprocessable(`${record.batchNumber} is cancelled.`);
    const loadCache = new Map();
    const rows: RtsFtpRowInput[] = [];
    const pdfs: Array<{ name: string; data: Buffer }> = [];
    const problems: string[] = [];
    for (const line of record.lines) {
      const inv = await this.invoices.get(principal, line.invoiceId);
      rows.push({
        clientNumber,
        invoiceNumber: inv.invoiceNumber,
        // RTS (2026-10-19): repeat the debtor name when there is no identifier of our own.
        debtorNumber: inv.billToName,
        debtorName: inv.billToName,
        loadNumber: inv.rc?.loadReference?.trim() || inv.loadNumber,
        invoiceDate: inv.issuedOn ?? '',
        amountCents: line.fundableCents ?? line.totalCents,
      });
      pdfs.push({ name: rtsFtpFileName(inv.invoiceNumber), data: await this.ftpPacket(principal, inv, loadCache, problems) });
    }
    problems.unshift(...rtsFtpProblems(rows));
    const stamp = this.clock().toISOString().replace(/\D/g, '').slice(0, 14);
    const csv = { name: `${record.batchNumber}_${stamp}.csv`, data: Buffer.from(rtsFtpCsv(rows)) };
    return { pdfs, csv, problems };
  }

  /** The files the FTPS upload would send, as a ZIP for a test upload by hand. Sends nothing. */
  async exportFtpFiles(principal: Principal, id: string): Promise<{ fileName: string; data: Buffer }> {
    this.requireEdit(principal);
    const { record } = await this.batch(principal, id);
    const clientNumber = (await this.rtsFtp.clientNumberOf(principal.companyId)) ?? 'CLIENT';
    const { pdfs, csv, problems } = await this.ftpSubmission(principal, record, clientNumber);
    const files = [...pdfs, csv];
    if (problems.length > 0) files.push({ name: 'PROBLEMS.txt', data: Buffer.from(`RTS would refuse this submission:\n${problems.join('\n')}\n`) });
    const data = zip(files);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const fileName = `${record.batchNumber}_RTS_FTP_files.zip`;
    const at = this.clock().toISOString();
    await this.store.modify<RtsBatchRecord>('acct_payment_batches', principal.companyId, id, (row) => ({
      ...row,
      status: row.status === 'prepared' ? 'exported' : row.status,
      exports: [...row.exports, { at, by: this.who(principal), fileName, sha256, bytes: data.length }],
      history: [...row.history, { at, by: this.who(principal), action: 'exported', detail: `${fileName} (RTS FTP format) · sha256 ${sha256.slice(0, 16)}` }],
      updatedAt: at,
    }));
    await this.audit.write(principal, { action: 'rts_package_exported', entityType: 'rts_batch', entityId: id, entityLabel: record.batchNumber, summary: `${fileName} - RTS FTP format, not sent`, changes: [] });
    return { fileName, data };
  }

  /**
   * Sends the batch to RTS over FTPS: every PDF, then the CSV that makes RTS take them. Refused
   * before anything moves when RTS would refuse it, when the account is not ready, or when the
   * last submission went less than five minutes ago. Once the CSV is up the invoices are recorded
   * submitted, with the CSV's name as the reference - RTS sends nothing back.
   */
  async sendFtp(principal: Principal, id: string, expectedVersion: number): Promise<RtsBatchRecord> {
    this.requireEdit(principal);
    const { record, version } = await this.batch(principal, id);
    if (version !== expectedVersion) throw conflict(`${record.batchNumber} changed since you opened it. Reload and try again.`);
    if (record.status === 'submitted') throw unprocessable(`${record.batchNumber} is already submitted to RTS.`);
    const up0 = await this.rtsFtp.uploader(principal.companyId);
    if (!up0.ok) throw unprocessable(up0.reason);
    const lastSent = (await this.batches(principal)).flatMap((b) => b.ftpSends ?? []).map((s) => s.at).sort().pop() ?? null;
    const wait = rtsFtpWaitMinutes(lastSent, this.clock());
    if (wait > 0) throw unprocessable(`RTS takes one submission every ${RTS_FTP_GAP_MINUTES} minutes. Send this one in ${wait} minute${wait === 1 ? '' : 's'}.`);
    const up = up0;
    if (sending.has(principal.companyId)) throw conflict('Another RTS submission is uploading right now. Wait for it to finish.');
    sending.add(principal.companyId);
    try {
      const { pdfs, csv, problems } = await this.ftpSubmission(principal, record, up.clientNumber);
      if (problems.length > 0) throw unprocessable(`Not sent - RTS would refuse it: ${problems.join(' | ')}`);
      await this.rtsFtp.upload(principal.companyId, up.accountId, pdfs, csv);
      const now = this.clock().toISOString();
      const sha256 = createHash('sha256').update(csv.data).digest('hex');
      const evidence = `${pdfs.length} PDF(s) and ${csv.name} uploaded to ${up.host} as ${up.clientNumber}${up.test ? ' (RTS test folder)' : ''}`;
      // A test account's upload is a rehearsal: the batch and its invoices stay as they were.
      if (up.test) {
        const after = await this.store.modify<RtsBatchRecord>('acct_payment_batches', principal.companyId, id, (row) => ({
          ...row,
          ftpSends: [...(row.ftpSends ?? []), { at: now, by: this.who(principal), csvName: csv.name, files: pdfs.length, host: up.host, clientNumber: up.clientNumber, sha256, test: true }],
          history: [...row.history, { at: now, by: this.who(principal), action: 'sent_ftps_test', detail: `${evidence}; test only, nothing marked submitted` }],
          updatedAt: now,
        }));
        await this.audit.write(principal, { action: 'rts_test_upload', entityType: 'rts_batch', entityId: id, entityLabel: record.batchNumber, summary: evidence, changes: [] });
        return after.record;
      }
      const missed: string[] = [];
      for (const l of record.lines) {
        const r = await this.invoices.markSubmission(principal, l.invoiceId, { status: 'submitted', reference: `RTS FTPS ${csv.name}`, evidence });
        if (!r.ok) missed.push(`${l.invoiceNumber}: ${r.blocked}`);
      }
      const after = await this.store.modify<RtsBatchRecord>('acct_payment_batches', principal.companyId, id, (row) => ({
        ...row,
        status: 'submitted',
        submission: { reference: csv.name, evidence, evidenceFileId: null, submittedOn: easternDate(now), at: now, by: this.who(principal) },
        ftpSends: [...(row.ftpSends ?? []), { at: now, by: this.who(principal), csvName: csv.name, files: pdfs.length, host: up.host, clientNumber: up.clientNumber, sha256 }],
        history: [...row.history, { at: now, by: this.who(principal), action: 'sent_ftps', detail: `${evidence}${missed.length ? ` · not marked on: ${missed.join('; ')}` : ''}` }],
        updatedAt: now,
      }));
      await this.audit.write(principal, { action: 'rts_submission_sent', entityType: 'rts_batch', entityId: id, entityLabel: record.batchNumber, summary: evidence, changes: [{ field: 'status', old: record.status, new: 'submitted' }] });
      return after.record;
    } finally {
      sending.delete(principal.companyId);
    }
  }

  /**
   * Test packets for RTS's test folder (owner, 2026-10-20): RTS asked for a test submission before
   * production credentials, and NORTHWIND FREIGHT has no loads in NeWay yet. Three invoices TEST-0001..3,
   * each an invoice sheet with the NOA stamp plus RC / BOL / POD pages marked TEST, every page 8 x 10,
   * and the RTS CSV - built in memory and uploaded through a TEST account only. No load, invoice,
   * ledger entry or batch is created; the upload is audited and the CSV handed back.
   */
  async sendTestPackets(principal: Principal): Promise<{ uploaded: string[]; csvName: string; csv: string; host: string }> {
    this.requireEdit(principal);
    const up = await this.rtsFtp.uploader(principal.companyId);
    if (!up.ok) throw unprocessable(up.reason);
    if (!up.test) throw unprocessable('Test packets go to an RTS test account only. This company’s RTS account is production.');
    const lastSent = [...(await this.batches(principal)).flatMap((b) => b.ftpSends ?? []).map((s) => s.at), lastTestDrop.get(principal.companyId) ?? ''].filter(Boolean).sort().pop() ?? null;
    const wait = rtsFtpWaitMinutes(lastSent, this.clock());
    if (wait > 0) throw unprocessable(`RTS takes one submission every ${RTS_FTP_GAP_MINUTES} minutes. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`);
    const [co] = await this.store.db.select({ name: companies.name }).from(companies).where(eq(companies.id, principal.companyId)).limit(1);
    const company = co?.name ?? principal.companyId;
    const today = easternDate(this.clock().toISOString());
    const tests = [
      { n: 1, debtor: 'Test Debtor One', amount: 1200 },
      { n: 2, debtor: 'Test Debtor Two', amount: 2150 },
      { n: 3, debtor: 'Test Debtor Three', amount: 2700 },
    ];
    const pdfs: Array<{ name: string; data: Buffer }> = [];
    const rows: RtsFtpRowInput[] = [];
    for (const t of tests) {
      const number = `TEST-000${t.n}`;
      const load = `TEST-LOAD-000${t.n}`;
      const inv = {
        invoiceNumber: number, family: number, revision: 1, revisionOf: null, status: 'issued', billToName: t.debtor, loadNumber: load,
        issuedOn: today, dueOn: today, paymentTermsDays: 30, rc: { loadReference: load }, total: t.amount, balance: t.amount, paid: 0, creditBalance: 0,
        lines: [{ description: 'TEST - linehaul (RTS test-folder submission, not a real load)', amount: t.amount, supportingDocuments: [] }],
        invoiceNote: 'TEST SUBMISSION for the RTS FTPS integration test. Not a real invoice.',
      } as unknown as InvoiceRecord;
      const sheet = await this.stampNoa(await this.exports.invoicePdf(inv, company));
      const docs = await PDFDocument.create();
      const font = await docs.embedFont(StandardFonts.Helvetica);
      const bold = await docs.embedFont(StandardFonts.HelveticaBold);
      const pages: Array<[string, string[]]> = [
        ['RATE CONFIRMATION - TEST', [`Load ${load}`, `Broker: ${t.debtor}`, `Linehaul USD ${t.amount.toFixed(2)}`]],
        ['BILL OF LADING - TEST', [`Load ${load}`, 'Shipper / consignee: TEST']],
        ['PROOF OF DELIVERY - TEST', [`Load ${load}`, 'Signed: TEST']],
      ];
      for (const [title, lines] of pages) {
        const page = docs.addPage([612, 792]);
        page.drawText(title, { x: 54, y: 720, size: 20, font: bold });
        lines.forEach((text, i) => page.drawText(text, { x: 54, y: 680 - i * 22, size: 12, font }));
        page.drawText('TEST DOCUMENT - RTS FTPS integration test - not a real load', { x: 54, y: 60, size: 10, font });
      }
      const merged = await PDFDocument.create();
      for (const bytes of [sheet, Buffer.from(await docs.save())]) {
        const src = await PDFDocument.load(bytes);
        for (const p of await merged.copyPages(src, src.getPageIndices())) merged.addPage(p);
      }
      const out = await PDFDocument.create();
      for (const p of await out.embedPdf(await merged.save(), merged.getPageIndices())) {
        const k = Math.min(RTS_FTP_PAGE.width / p.width, RTS_FTP_PAGE.height / p.height);
        out.addPage([RTS_FTP_PAGE.width, RTS_FTP_PAGE.height]).drawPage(p, { x: (RTS_FTP_PAGE.width - p.width * k) / 2, y: (RTS_FTP_PAGE.height - p.height * k) / 2, width: p.width * k, height: p.height * k });
      }
      pdfs.push({ name: rtsFtpFileName(number), data: await grayscale(Buffer.from(await out.save())) });
      rows.push({ clientNumber: up.clientNumber, invoiceNumber: number, debtorNumber: t.debtor, debtorName: t.debtor, loadNumber: load, invoiceDate: today, amountCents: Math.round(t.amount * 100) });
    }
    const problems = rtsFtpProblems(rows);
    if (problems.length > 0) throw unprocessable(`Not sent - RTS would refuse it: ${problems.join(' | ')}`);
    const csvName = `TEST_${this.clock().toISOString().replace(/\D/g, '').slice(0, 14)}.csv`;
    const csv = rtsFtpCsv(rows);
    if (sending.has(principal.companyId)) throw conflict('Another RTS submission is uploading right now. Wait for it to finish.');
    sending.add(principal.companyId);
    try {
      const done = await this.rtsFtp.upload(principal.companyId, up.accountId, pdfs, { name: csvName, data: Buffer.from(csv) });
      lastTestDrop.set(principal.companyId, this.clock().toISOString());
      await this.audit.write(principal, { action: 'rts_test_upload', entityType: 'integration', entityId: up.accountId, entityLabel: 'RTS test folder', summary: `Test packets ${pdfs.map((f) => f.name).join(', ')} + ${csvName} uploaded to ${up.host} (no load, invoice or batch created)`, changes: [] });
      return { uploaded: done.uploaded, csvName, csv, host: up.host };
    } finally {
      sending.delete(principal.companyId);
    }
  }

  /**
   * Accounting's record that the package was uploaded to RTS, with how they know.
   *
   * Each invoice is marked submitted through the per-invoice submission record, so the Billing
   * drawer, the invoice history and the queue all tell the same story. Only a batch whose package
   * was exported can be recorded as submitted: there is nothing to have uploaded otherwise.
   */
  async recordSubmission(principal: Principal, id: string, input: RecordRtsSubmissionInput): Promise<RtsBatchRecord> {
    this.requireEdit(principal);
    const { record, version } = await this.batch(principal, id);
    if (version !== input.expectedVersion) throw conflict(`${record.batchNumber} changed since you opened it. Reload and try again.`);
    if (record.status === 'cancelled') throw unprocessable(`${record.batchNumber} is cancelled.`);
    if (record.status === 'submitted') throw unprocessable(`${record.batchNumber} is already recorded as submitted.`);
    if (record.exports.length === 0) throw unprocessable(`Export ${record.batchNumber}'s package before recording that it was submitted.`);
    const reference = input.reference?.trim() || null;
    const evidence = input.evidence?.trim() || (input.evidenceFileId ? `Evidence file ${input.evidenceFileId}` : null);
    const problems: string[] = [];
    for (const l of record.lines) {
      const r = await this.invoices.markSubmission(principal, l.invoiceId, { status: 'submitted', reference: reference ?? undefined, evidence: evidence ?? undefined });
      if (!r.ok) problems.push(`${l.invoiceNumber}: ${r.blocked}`);
    }
    if (problems.length === record.lines.length) throw unprocessable(problems.join(' | '));
    const now = this.clock().toISOString();
    const after = await this.store.modify<RtsBatchRecord>('acct_payment_batches', principal.companyId, id, (row) => ({
      ...row,
      status: 'submitted',
      submission: { reference, evidence: input.evidence?.trim() || null, evidenceFileId: input.evidenceFileId ?? null, submittedOn: input.submittedOn, at: now, by: this.who(principal) },
      history: [...row.history, { at: now, by: this.who(principal), action: 'submission_recorded', detail: `${reference ? `RTS reference ${reference}` : 'no reference'}${input.evidence ? ` · ${input.evidence.trim()}` : ''}${problems.length ? ` · not recorded on: ${problems.join('; ')}` : ''}` }],
      updatedAt: now,
    }));
    await this.audit.write(principal, { action: 'rts_submission_recorded', entityType: 'rts_batch', entityId: id, entityLabel: record.batchNumber, summary: `${record.count} invoice(s) recorded submitted${reference ? ` · ${reference}` : ''}`, changes: [{ field: 'status', old: record.status, new: 'submitted' }] });
    return after.record;
  }
}
