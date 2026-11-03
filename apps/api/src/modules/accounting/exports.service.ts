import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { payPeriodLabel, safeCell, safeFileName } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { buildXlsx, toCsv, zip, type XlsxCell } from '../dispatch-board/xlsx';
import { AuditService } from '../people/audit.service';
import { newId } from '../dispatch-board/ops.helpers';
import type { InvoiceRecord } from './invoices.service';
import type { StatementRecord } from './settlements.service';
import { AccountingStore } from './store.service';
import { EmailTransport } from './email.transport';
import { easternDay, payReportModel, renderPayReport, type PayReportContext } from './pay-report';

/**
 * PDF, XLSX, CSV, ZIP and the delivery log (§10).
 *
 * A statement PDF is rendered from the approved snapshot; a draft says DRAFT across every
 * page. A vendor statement starts each truck on its own page and ends with one payout. Text
 * cells in every spreadsheet go through the formula guard. Email has no transport configured
 * on this server, so "send" validates the recipients, writes a delivery row per statement and
 * says exactly why nothing left the building - sending never marks anything paid.
 */

const PAGE = { w: 612, h: 792, margin: 48 };

/** The standard fonts speak WinAnsi: arrows and anything outside Latin-1 become plain ASCII. */
/** The word the Invoices screen uses for a status. */
function invoiceStatusWord(status: string): string {
  const words: Record<string, string> = { draft: 'Draft', issued: 'Issued', sent: 'Sent', partially_paid: 'Partly paid', paid: 'Paid', overdue: 'Overdue', disputed: 'Disputed', void: 'Void' };
  return words[status] ?? status;
}

function ascii(s: string): string {
  return s.replace(/→/g, '->').replace(/[^ -ÿ–—‘’“”•…]/g, '?');
}

function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type Align = 'left' | 'right';
interface Col {
  /** Column width in points. The widths of one table must add up to the printable width. */
  w: number;
  align?: Align;
  /** A long value wraps onto further lines instead of being cut, for routes and load numbers. */
  wrap?: boolean;
}

const INK = rgb(0.09, 0.09, 0.1);
const MUTED = rgb(0.42, 0.44, 0.47);
const LINE = rgb(0.84, 0.85, 0.87);
const PANEL = rgb(0.965, 0.967, 0.972);

class Sheet {
  page: PDFPage;
  y: number;
  /** Redrawn at the top of every page this table continues onto. */
  private repeat: (() => void) | null = null;

  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
    readonly draft: boolean,
    readonly footer: string,
  ) {
    this.page = this.newPage();
    this.y = PAGE.h - PAGE.margin;
  }

  get width(): number {
    return PAGE.w - PAGE.margin * 2;
  }

  private newPage(): PDFPage {
    const p = this.doc.addPage([PAGE.w, PAGE.h]);
    if (this.draft) {
      p.drawText('DRAFT', { x: 150, y: 300, size: 110, font: this.bold, color: rgb(0.925, 0.925, 0.93), rotate: { type: 'degrees', angle: 35 } as never });
    }
    p.drawText(ascii(this.footer), { x: PAGE.margin, y: 30, size: 7.5, font: this.font, color: MUTED });
    return p;
  }

  /** Page numbers are stamped at the end, when the count is finally known. */
  break(): void {
    this.page = this.newPage();
    this.y = PAGE.h - PAGE.margin;
    if (this.repeat) this.repeat();
  }

  ensure(h: number): void {
    if (this.y - h < PAGE.margin + 24) this.break();
  }

  gap(h = 8): void {
    this.y -= h;
  }

  text(t: string, o: { size?: number; bold?: boolean; x?: number; color?: ReturnType<typeof rgb>; gap?: number } = {}): void {
    const size = o.size ?? 9.5;
    this.ensure(size + 4);
    const font = o.bold ? this.bold : this.font;
    this.page.drawText(ascii(t), { x: o.x ?? PAGE.margin, y: this.y - size, size, font, color: o.color ?? INK });
    this.y -= size + (o.gap ?? 4);
  }

  rule(color = LINE, thickness = 0.5): void {
    this.ensure(6);
    this.page.drawLine({ start: { x: PAGE.margin, y: this.y - 1 }, end: { x: PAGE.w - PAGE.margin, y: this.y - 1 }, thickness, color });
    this.y -= 6;
  }

  /** A section title: small, spaced, with a hairline under it. */
  section(title: string): void {
    this.ensure(26);
    this.gap(6);
    this.text(title.toUpperCase(), { size: 8, bold: true, color: MUTED, gap: 3 });
    this.rule();
  }

  /** One cell's lines, shrunk a little before it wraps and never simply cut in half. */
  private lines(t: string, col: Col, size: number, font: PDFFont): string[] {
    const max = col.w - 6;
    const words = ascii(t).split(' ');
    if (font.widthOfTextAtSize(ascii(t), size) <= max) return [ascii(t)];
    if (!col.wrap) {
      let cut = ascii(t);
      while (cut.length > 4 && font.widthOfTextAtSize(cut, size) > max) cut = `${cut.slice(0, -2)}…`;
      return [cut];
    }
    const out: string[] = [];
    let line = '';
    // A word wider than the column is broken on the character, because a load number carries no
    // spaces and running it under the next column is how a statement becomes unreadable.
    const pieces: string[] = [];
    for (const w of words) {
      if (font.widthOfTextAtSize(w, size) <= max) { pieces.push(w); continue; }
      let rest = w;
      while (font.widthOfTextAtSize(rest, size) > max) {
        let take = rest.length;
        while (take > 1 && font.widthOfTextAtSize(rest.slice(0, take), size) > max) take -= 1;
        // A load number reads in its own segments - TEST-RB-NY1N8-SOLO - so it breaks after a
        // hyphen where one fits, and only mid-segment when a segment is itself wider than the column.
        const hyphen = rest.lastIndexOf('-', take - 1);
        if (hyphen > 0 && hyphen + 1 < rest.length) take = hyphen + 1;
        pieces.push(rest.slice(0, take));
        rest = rest.slice(take);
      }
      if (rest) pieces.push(rest);
    }
    for (const w of pieces) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) <= max || !line) line = next;
      else { out.push(line); line = w; }
    }
    if (line) out.push(line);
    return out;
  }

  /**
   * One table row. A wrapping column may take several lines and the row grows to fit; nothing is
   * shrunk below the body size and no row is dropped, which is what lets a long table run over a
   * page without losing anything.
   */
  row(cells: string[], cols: Col[], o: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb>; tint?: boolean } = {}): void {
    const size = o.size ?? 8.5;
    const font = o.bold ? this.bold : this.font;
    const laid = cells.map((c, i) => this.lines(c ?? '', cols[i] ?? { w: 80 }, size, font));
    const height = Math.max(...laid.map((l) => l.length)) * (size + 2.5) + 4;
    this.ensure(height);
    if (o.tint) {
      this.page.drawRectangle({ x: PAGE.margin, y: this.y - height + 2, width: this.width, height, color: PANEL });
    }
    let x = PAGE.margin;
    laid.forEach((lines, i) => {
      const col = cols[i] ?? { w: 80 };
      lines.forEach((line, n) => {
        const w = font.widthOfTextAtSize(line, size);
        this.page.drawText(line, {
          x: col.align === 'right' ? x + col.w - w - 2 : x,
          y: this.y - size - n * (size + 2.5) - 1,
          size,
          font,
          color: o.color ?? INK,
        });
      });
      x += col.w;
    });
    this.y -= height;
  }

  /** A table header that comes back at the top of each page the table continues onto. */
  head(cells: string[], cols: Col[]): void {
    const draw = () => {
      this.row(cells, cols, { bold: true, size: 7.5, color: MUTED });
      this.page.drawLine({ start: { x: PAGE.margin, y: this.y + 2 }, end: { x: PAGE.w - PAGE.margin, y: this.y + 2 }, thickness: 0.5, color: LINE });
      this.y -= 4;
    };
    this.repeat = null;
    this.ensure(30);
    draw();
    this.repeat = draw;
  }

  endTable(): void {
    this.repeat = null;
  }

  /** "Label ................ $0.00" on one line, for a summary or a balance. */
  pair(label: string, value: string, o: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb> } = {}): void {
    this.row([label, value], [{ w: this.width - 110 }, { w: 110, align: 'right' }], { size: 9, ...o });
  }
}

@Injectable()
export class ExportsService {
  constructor(
    private readonly store: AccountingStore,
    private readonly audit: AuditService,
    private readonly mail: EmailTransport,
  ) {}

  clock: () => Date = () => new Date();

  // ------------------------------------------------------------ PDFs

  /**
   * The driver's pay settlement, as a "Driver Pay Report" (owner, 2026-10-22; see pay-report.ts).
   *
   * It is written for the person it pays, so it holds what they can check - the loads they ran,
   * what each one paid them, what was taken off and what lands in the bank - and nothing they
   * cannot: no batch or source keys, no bank details. It is drawn from the statement's computation
   * lines, never figured again. What is not known is said, never rounded to zero: an unreconciled
   * escrow or debt balance prints as "not reconciled yet" in the Notes.
   *
   * `context` carries what the record does not: the company profile, the driver's home and phone,
   * the loads' stops. Without it the report still prints, from the statement alone.
   */
  async statementPdf(s: StatementRecord, company: string, payee: { legalName: string; accountLast4: string | null } | null, context: PayReportContext = {}): Promise<Buffer> {
    if (s.partyType === 'vendor' && s.vendor) {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const bold = await doc.embedFont(StandardFonts.HelveticaBold);
      const draft = s.status !== 'approved' && s.status !== 'paid';
      const sh = new Sheet(doc, font, bold, draft, `${company} · ${s.settlementNumber} · ${s.periodStart} to ${s.periodEnd}`);
      return this.vendorPages(sh, s, doc, company, payee);
    }
    return renderPayReport(payReportModel(s, company, { ...context, generatedOn: context.generatedOn ?? easternDay(this.clock()) }));
  }

  /** The head of a statement: who it is from, who it pays, which period, and its standing. */
  private statementHeader(sh: Sheet, s: StatementRecord, company: string, draft: boolean): void {
    const status = s.status === 'paid' ? 'PAID' : s.status === 'approved' ? 'APPROVED' : s.status === 'reversed' ? 'REVERSED' : 'DRAFT';
    sh.page.drawText(ascii(company), { x: PAGE.margin, y: sh.y - 15, size: 15, font: sh.bold, color: INK });
    const label = 'Pay Settlement';
    const w = sh.font.widthOfTextAtSize(label, 12);
    sh.page.drawText(label, { x: PAGE.w - PAGE.margin - w, y: sh.y - 14, size: 12, font: sh.font, color: MUTED });
    sh.y -= 24;
    const sw = sh.bold.widthOfTextAtSize(status, 8);
    sh.page.drawRectangle({ x: PAGE.w - PAGE.margin - sw - 14, y: sh.y - 11, width: sw + 14, height: 15, color: PANEL, borderColor: LINE, borderWidth: 0.5 });
    sh.page.drawText(status, { x: PAGE.w - PAGE.margin - sw - 7, y: sh.y - 7, size: 8, font: sh.bold, color: draft ? MUTED : INK });
    sh.text(`${s.partyName}${s.unitNumber ? ` · Truck #${s.unitNumber}` : ''}`, { size: 11, bold: true, gap: 3 });
    // The real pay window (Monday noon to Monday noon ET) when the statement records it.
    sh.text(`Statement ${s.settlementNumber} · ${s.startsAt ? `Pay week ${payPeriodLabel({ start: s.periodStart, end: s.periodEnd, startsAt: s.startsAt, cutoffAt: s.cutoffAt, timezone: 'America/New_York' })}` : `${s.periodStart} to ${s.periodEnd}`} · Payday ${s.payDate}`, { size: 9, color: MUTED });
    sh.rule();
  }

  /** Page numbers, once the page count is finally known, then the bytes. */
  private async finish(doc: PDFDocument, font: PDFFont): Promise<Buffer> {
    const pages = doc.getPages();
    pages.forEach((page, i) => {
      const t = `Page ${i + 1} of ${pages.length}`;
      const w = font.widthOfTextAtSize(t, 7.5);
      page.drawText(t, { x: PAGE.w - PAGE.margin - w, y: 30, size: 7.5, font, color: MUTED });
    });
    return Buffer.from(await doc.save());
  }

  private async vendorPages(sh: Sheet, s: StatementRecord, doc: PDFDocument, company: string, payee: { legalName: string; accountLast4: string | null } | null): Promise<Buffer> {
    const v = s.vendor!;
    const draft = s.status !== 'approved' && s.status !== 'paid';
    const cols: Col[] = [{ w: 96, wrap: true }, { w: 190, wrap: true }, { w: 80, align: 'right' }, { w: 60, align: 'right' }, { w: 90, align: 'right' }];
    v.trucks.forEach((t, i) => {
      if (i > 0) sh.break();
      this.statementHeader(sh, { ...s, unitNumber: t.unitNumber }, company, draft);
      sh.section('Loads');
      sh.head(['Load', 'Route', 'Gross', 'Rate', 'Earnings'], cols);
      for (const l of t.loads) sh.row([l.loadNumber, l.route, dollars(l.grossCents), t.percentBps === null ? '' : `${(t.percentBps / 100).toFixed(1)}%`, dollars(l.vendorEarningsCents)], cols);
      sh.endTable();
      sh.rule();
      sh.row(['Total', '', dollars(t.grossCents), '', dollars(t.vendorEarningsCents)], cols, { bold: true, size: 9 });
      sh.section('Deductions');
      if (t.driverPayDeductedCents) sh.pair('Driver pay', dollars(-t.driverPayDeductedCents));
      if (t.fuelCents) sh.pair('Fuel', dollars(-t.fuelCents));
      if (t.tollsCents) sh.pair('Tolls', dollars(-t.tollsCents));
      if (t.otherCents) sh.pair('Other', dollars(-t.otherCents));
      if (t.adjustmentsCents) sh.pair('Adjustments', dollars(t.adjustmentsCents));
      sh.rule(INK, 0.8);
      sh.pair(`Net for Truck #${t.unitNumber}`, dollars(t.netCents), { bold: true, size: 11 });
      for (const x of t.exceptions) sh.text(`- ${x}`, { size: 8.5, color: MUTED, gap: 2 });
    });
    sh.break();
    this.statementHeader(sh, s, company, draft);
    sh.section('Payment summary');
    const sum: Col[] = [{ w: 96 }, { w: 110, align: 'right' }, { w: 100, align: 'right' }, { w: 110, align: 'right' }, { w: 100, align: 'right' }];
    sh.head(['Truck', 'Earnings', 'Driver pay', 'Fuel and tolls', 'Net'], sum);
    for (const t of v.trucks) sh.row([`#${t.unitNumber}`, dollars(t.vendorEarningsCents), dollars(-t.driverPayDeductedCents), dollars(-(t.fuelCents + t.tollsCents + t.otherCents)), dollars(t.netCents)], sum);
    if (v.vendorAdjustmentsCents) sh.row(['Adjustments', '', '', '', dollars(v.vendorAdjustmentsCents)], sum);
    sh.endTable();
    sh.rule(INK, 0.8);
    sh.row(['NET PAY', '', '', '', dollars(v.payoutCents)], sum, { bold: true, size: 13 });
    if (payee) sh.text(`Paid to ${payee.legalName}`, { size: 8.5, color: MUTED });
    if (s.paidAt) sh.text(`Paid ${s.paidAt.slice(0, 10)}`, { size: 8.5, color: MUTED });
    return this.finish(doc, sh.font);
  }

  /**
   * The invoice as the broker (and RTS) receives it.
   *
   * A revision says so at the top - REVISED INVOICE · Revision 2, its own number, the original
   * number, the date and the reason - and shows the previous total, the adjustment and the revised
   * total before the charges. Each charge lists the documents behind it. Payments already received
   * are shown against it, and a revision that fell below them shows the credit owed, in words.
   *
   * Internal notes are not read here at all: nothing in this function can print one.
   */
  async invoicePdf(inv: InvoiceRecord, company: string): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const draft = inv.status === 'draft';
    const revised = inv.revision > 1 && Boolean(inv.revisionOf);
    const sh = new Sheet(doc, font, bold, draft, `${company} · ${inv.invoiceNumber}${revised ? ` · revision ${inv.revision} of ${inv.revisionOf!.originalInvoiceNumber}` : ''}`);

    // ---------------------------------------------------------------- head
    sh.page.drawText(ascii(company), { x: PAGE.margin, y: sh.y - 15, size: 15, font: bold, color: INK });
    const supplement = inv.supplementOf ?? null;
    const title = revised ? `REVISED INVOICE · Revision ${inv.revision}` : supplement ? 'SUPPLEMENTAL INVOICE' : 'INVOICE';
    const tw = bold.widthOfTextAtSize(ascii(title), 12);
    sh.page.drawText(ascii(title), { x: PAGE.w - PAGE.margin - tw, y: sh.y - 14, size: 12, font: bold, color: revised || supplement ? INK : MUTED });
    sh.y -= 24;
    if (draft) {
      const chip = 'DRAFT - not issued';
      const cw = bold.widthOfTextAtSize(chip, 8);
      sh.page.drawRectangle({ x: PAGE.w - PAGE.margin - cw - 14, y: sh.y - 11, width: cw + 14, height: 15, color: PANEL, borderColor: LINE, borderWidth: 0.5 });
      sh.page.drawText(chip, { x: PAGE.w - PAGE.margin - cw - 7, y: sh.y - 7, size: 8, font: bold, color: MUTED });
    }
    sh.text(`Invoice ${inv.invoiceNumber}`, { size: 11, bold: true, gap: 3 });
    if (revised) sh.text(`Current number: ${inv.invoiceNumber} · Original invoice: ${inv.revisionOf!.originalInvoiceNumber}${inv.revisionOf!.invoiceNumber !== inv.revisionOf!.originalInvoiceNumber ? ` · Replaces: ${inv.revisionOf!.invoiceNumber}` : ''}`, { size: 9, gap: 3 });
    if (supplement) sh.text(`Additional charges to invoice ${supplement.invoiceNumber} for the same load. ${supplement.invoiceNumber} is unchanged and is not replaced by this invoice.`, { size: 9, gap: 3 });
    sh.text(`Bill to ${inv.billToName} · Load ${inv.loadNumber} · Issued ${inv.issuedOn ?? 'not yet'} · Due ${inv.dueOn ?? 'not yet'} · Terms ${inv.paymentTermsDays} days`, { size: 9, color: MUTED });
    if (inv.rc?.loadReference) sh.text(`Broker reference ${inv.rc.loadReference}`, { size: 9, color: MUTED });
    sh.rule();

    // ---------------------------------------------------------------- what changed
    if (revised) {
      const r = inv.revisionOf!;
      sh.section('Revision');
      sh.pair('Revision date', r.revisedOn ?? 'not issued yet');
      sh.row(['Reason / description of changes', r.reason], [{ w: 170 }, { w: sh.width - 170, wrap: true }], { size: 9 });
      sh.pair('Previous total', dollars(Math.round(r.previousTotal * 100)));
      sh.pair('Adjustment', `${r.adjustment >= 0 ? '+' : '-'}${dollars(Math.abs(Math.round(r.adjustment * 100)))}`);
      sh.pair('Revised total', dollars(Math.round(inv.total * 100)), { bold: true });
    }

    // ---------------------------------------------------------------- charges
    const cols: Col[] = [{ w: 220, wrap: true }, { w: sh.width - 330, wrap: true }, { w: 110, align: 'right' }];
    sh.section('Charges');
    sh.head(['Description', 'Supporting documents', 'Amount'], cols);
    for (const l of inv.lines) {
      const support = (l.supportingDocuments ?? []).map((d) => d.fileName).join(', ');
      sh.row([l.description, support, dollars(Math.round(l.amount * 100))], cols);
    }
    sh.endTable();
    sh.rule(INK, 0.8);
    sh.pair(revised ? 'Revised invoice total' : 'Invoice total', dollars(Math.round(inv.total * 100)), { bold: true, size: 11 });

    // ---------------------------------------------------------------- what has been paid, what is owed
    const credit = inv.creditBalance ?? 0;
    if (inv.paid) sh.pair('Payments and credits received', `-${dollars(Math.round(inv.paid * 100))}`);
    if (credit > 0) {
      sh.pair('Credit owed to you', dollars(Math.round(credit * 100)), { bold: true });
      sh.text('Payments received exceed the revised total. This credit is held for you; it has not been refunded.', { size: 8.5, color: MUTED, gap: 2 });
    } else {
      sh.pair('Balance due', dollars(Math.max(0, Math.round(inv.balance * 100))), { bold: true, size: 11 });
    }

    // ---------------------------------------------------------------- the printed note
    const note = inv.invoiceNote?.trim();
    if (note) {
      sh.section('Notes');
      for (const para of note.split(/\r?\n/)) sh.row([para || ' '], [{ w: sh.width, wrap: true }], { size: 9.5 });
    }
    return this.finish(doc, font);
  }

  /**
   * The first page of an invoice's RTS packet: what the packet is, and - for a revision - what RTS
   * already had and what is new. It says plainly that RTS has not confirmed how it takes revisions;
   * the package reports the adjustment and claims nothing about acceptance.
   */
  async packetCover(inv: InvoiceRecord, company: string, enclosed: string[], fundableCents: number): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const revised = inv.revision > 1 && Boolean(inv.revisionOf);
    const sh = new Sheet(doc, font, bold, false, `${company} · RTS package · ${inv.invoiceNumber}`);
    sh.text(company, { size: 15, bold: true, gap: 3 });
    sh.text(revised ? `REVISED INVOICE · Revision ${inv.revision}` : inv.supplementOf ? 'SUPPLEMENTAL INVOICE PACKAGE' : 'INVOICE PACKAGE', { size: 13, bold: true, gap: 6 });
    sh.pair('Current number', inv.invoiceNumber, { bold: true });
    if (inv.supplementOf) {
      sh.pair('Supplemental to', `${inv.supplementOf.invoiceNumber} (unchanged)`);
      sh.row(['Reason', inv.supplementOf.reason], [{ w: 170 }, { w: sh.width - 170, wrap: true }], { size: 9 });
    }
    if (revised) {
      const r = inv.revisionOf!;
      sh.pair('Original invoice', r.originalInvoiceNumber);
      if (r.invoiceNumber !== r.originalInvoiceNumber) sh.pair('Replaces', r.invoiceNumber);
      sh.pair('Revision date', r.revisedOn ?? 'not issued yet');
      sh.row(['Reason', r.reason], [{ w: 170 }, { w: sh.width - 170, wrap: true }], { size: 9 });
      sh.pair('Previous total', dollars(Math.round(r.previousTotal * 100)));
      sh.pair('Adjustment', `${r.adjustment >= 0 ? '+' : '-'}${dollars(Math.abs(Math.round(r.adjustment * 100)))}`);
    }
    sh.pair(revised ? 'Revised total' : 'Invoice total', dollars(Math.round(inv.total * 100)), { bold: true });
    sh.pair('Debtor', inv.billToName);
    sh.pair('Load', inv.loadNumber);
    if (inv.priorSubmission) {
      const ps = inv.priorSubmission;
      sh.section('Previously with RTS');
      sh.pair('Previous version', ps.invoiceNumber);
      sh.pair('Recorded status', `${ps.status}${ps.reference ? ` · reference ${ps.reference}` : ''}`);
      if (ps.fundedGross) sh.pair('Funded against it', dollars(Math.round(ps.fundedGross * 100)));
      sh.pair('New amount to consider', dollars(fundableCents), { bold: true });
      sh.text('RTS has not confirmed how it accepts revisions. This package reports the adjustment; it is not a submission and claims no acceptance.', { size: 8.5, color: MUTED, gap: 2 });
    }
    sh.section('Enclosed');
    for (const e of enclosed) sh.text(`- ${e}`, { size: 9.5, gap: 2 });
    return this.finish(doc, font);
  }

  /** The invoice list as one PDF table (owner, 2026-10-23): what the screen shows, for a period. */
  async invoicesPdf(invoices: InvoiceRecord[], company: string, period: string): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const sh = new Sheet(doc, font, bold, false, `${company} · Invoices · ${period}`);
    sh.text(company, { size: 15, bold: true, gap: 3 });
    sh.text(`Invoices · ${period}`, { size: 11, bold: true, gap: 2 });
    sh.text(`${invoices.length} invoice${invoices.length === 1 ? '' : 's'}`, { size: 9, color: MUTED, gap: 8 });
    const w = sh.width;
    const cols: Col[] = [
      { w: w * 0.13 },
      { w: w * 0.1 },
      { w: w * 0.1 },
      { w: w * 0.23 },
      { w: w * 0.12 },
      { w: w * 0.11, align: 'right' },
      { w: w * 0.11, align: 'right' },
      { w: w * 0.1 },
    ];
    sh.head(['Invoice', 'Issued', 'Due', 'Bill to', 'Load', 'Total', 'Balance', 'Status'], cols);
    let total = 0;
    let balance = 0;
    invoices.forEach((inv, i) => {
      total += Math.round(inv.total * 100);
      balance += Math.round(inv.balance * 100);
      sh.row([inv.invoiceNumber, inv.issuedOn ?? 'Draft', inv.dueOn ?? '', inv.billToName, inv.rc?.loadReference ? `${inv.loadNumber} / ${inv.rc.loadReference}` : inv.loadNumber, dollars(Math.round(inv.total * 100)), dollars(Math.round(inv.balance * 100)), invoiceStatusWord(inv.status)].map(ascii), cols, { tint: i % 2 === 1 });
    });
    sh.endTable();
    sh.gap(6);
    sh.rule();
    sh.pair('Total invoiced', dollars(total), { bold: true });
    sh.pair('Still owed', dollars(balance), { bold: true });
    return this.finish(doc, font);
  }

  // ------------------------------------------------------------ spreadsheets

  invoicesRows(invoices: InvoiceRecord[]): XlsxCell[][] {
    const rows: XlsxCell[][] = [['Invoice', 'Issued', 'Due', 'Bill to', 'Load', 'Reference', 'Total', 'Paid', 'Balance', 'Status', 'Paid on']];
    for (const inv of invoices) {
      rows.push([safeCell(inv.invoiceNumber), inv.issuedOn ?? '', inv.dueOn ?? '', safeCell(inv.billToName), safeCell(inv.loadNumber), safeCell(inv.rc?.loadReference ?? ''), inv.total, inv.paid, inv.balance, invoiceStatusWord(inv.status), inv.paidOn ?? '']);
    }
    return rows;
  }


  statementsRows(statements: StatementRecord[]): XlsxCell[][] {
    const rows: XlsxCell[][] = [['Statement', 'Party', 'Kind', 'Period start', 'Period end', 'Pay date', 'Status', 'Gross', 'Deductions', 'Escrow', 'Net', 'Payable', 'Carry']];
    for (const s of statements) {
      const c = s.computation;
      rows.push([safeCell(s.settlementNumber), safeCell(s.partyName), safeCell(s.kind), s.periodStart, s.periodEnd, s.payDate, s.status, (c?.grossCents ?? s.vendor?.totalEarningsCents ?? 0) / 100, (c?.deductionsCents ?? s.vendor?.totalDeductionsCents ?? 0) / 100, (c?.escrowCents ?? 0) / 100, s.netCents / 100, s.payableCents / 100, s.carryCents / 100]);
    }
    return rows;
  }

  xlsx(name: string, rows: XlsxCell[][]): Buffer {
    return buildXlsx([{ name, rows }]);
  }

  csv(rows: XlsxCell[][]): string {
    return toCsv(rows.map((r) => r.map((c) => (typeof c === 'string' ? safeCell(c) : c))));
  }

  zipPdfs(files: Array<{ name: string; data: Buffer }>): Buffer {
    return zip(files.map((f) => ({ name: safeFileName(f.name, 'statement.pdf'), data: f.data })));
  }

  fileName(parts: string[], ext: string): string {
    return `${safeFileName(parts.filter(Boolean).join('_'), 'export')}.${ext}`;
  }

  // ------------------------------------------------------------ delivery log

  async deliveries(principal: Principal, documentType?: string, documentId?: string) {
    const where = documentType && documentId ? sql`document_type = ${documentType} and document_id = ${documentId}` : undefined;
    return (await this.store.list('acct_deliveries', principal.companyId, where)).map((r) => r.record);
  }

  /**
   * Email delivery (section 6). Every recipient is validated and gets a delivery row. With a
   * transport configured the message is handed to it and the row says `sent` only when the
   * transport accepted it, `failed` with the error otherwise; with no transport the row is
   * `pending` and says so. A retry re-sends one row. Sending never marks anything paid.
   */
  async email(principal: Principal, input: { documentType: 'statement' | 'invoice'; items: Array<{ documentId: string; recipient: string | null; label: string; amountCents: number }>; resend?: boolean; render?: (documentId: string) => Promise<{ pdf: Buffer; fileName: string; subject: string } | null> }) {
    const transport = this.mail.describe();
    const results: Array<{ id: string; documentId: string; label: string; recipient: string | null; status: 'pending' | 'blocked' | 'sent' | 'failed'; reason: string | null }> = [];
    for (const item of input.items) {
      const ok = Boolean(item.recipient && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(item.recipient));
      let status: 'pending' | 'blocked' | 'sent' | 'failed' = ok ? 'pending' : 'blocked';
      let reason: string | null = ok ? (transport.kind === 'none' ? 'No email transport is configured on this server (EMAIL_TRANSPORT). Queued, not sent.' : null) : item.recipient ? `Invalid email address: ${item.recipient}` : 'Missing email address';
      const id = newId('dlv');
      if (ok && transport.kind !== 'none' && input.render) {
        try {
          const doc = await input.render(item.documentId);
          if (!doc) throw new Error('The document could not be rendered.');
          const outcome = await this.mail.send({ to: item.recipient!, subject: doc.subject, text: `${item.label}\n\nAttached: ${doc.fileName}`, attachments: [{ filename: doc.fileName, content: doc.pdf }] });
          status = 'sent';
          reason = outcome.info;
        } catch (error) {
          status = 'failed';
          reason = error instanceof Error ? error.message : String(error);
        }
      }
      await this.store.insert('acct_deliveries', principal.companyId, { id, documentType: input.documentType, documentId: item.documentId, channel: 'email', recipient: item.recipient, status, reason, resend: Boolean(input.resend), amountCents: item.amountCents, label: item.label, transport: transport.kind, byName: principal.userName ?? principal.userId, at: this.clock().toISOString() });
      results.push({ id, documentId: item.documentId, label: item.label, recipient: item.recipient, status, reason });
    }
    await this.audit.write(principal, { action: 'delivery_queued', entityType: input.documentType, entityId: input.items.map((i) => i.documentId).join(','), entityLabel: `${input.items.length} ${input.documentType}(s)`, summary: `${results.filter((r) => r.status === 'sent').length} sent, ${results.filter((r) => r.status === 'pending').length} queued, ${results.filter((r) => r.status === 'failed').length} failed, ${results.filter((r) => r.status === 'blocked').length} blocked · transport ${transport.kind}`, changes: [] });
    return { transportConfigured: transport.kind !== 'none', transport: transport.kind, results };
  }

  /** Re-sends one delivery row; the row keeps its history and gets the new outcome. */
  async retryDelivery(principal: Principal, id: string, render: (documentType: string, documentId: string) => Promise<{ pdf: Buffer; fileName: string; subject: string } | null>) {
    const stored = await this.store.get<{ documentType: 'statement' | 'invoice'; documentId: string; recipient: string | null; label: string; amountCents: number; attempts?: number; status: string }>('acct_deliveries', principal.companyId, id);
    const r = stored.record;
    const out = await this.email(principal, { documentType: r.documentType, items: [{ documentId: r.documentId, recipient: r.recipient, label: r.label, amountCents: r.amountCents }], resend: true, render: (documentId) => render(r.documentType, documentId) });
    return out.results[0];
  }
}
