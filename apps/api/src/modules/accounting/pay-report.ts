import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { loadRefLabel, type DeductionLine, type EarningLine } from '@neway/shared';
import type { StatementRecord } from './settlements.service';

/**
 * The driver's statement as a "Driver Pay Report" (owner, 2026-10-22): the layout of the pay
 * report the company sent drivers before NeWay - a centred title, the company on the left, the
 * driver and the dates in a small table on the right, one bordered block per load, the
 * deductions, and the grand total.
 *
 * It is drawn from the statement's own computation lines and nothing else: no amount here is
 * figured again. `payReportModel` lays the lines out (and is what the tests read); `renderPayReport`
 * only draws the model. The figures add up the same way the computation does:
 *
 *   Sub-Total (the load blocks) + every section row = Grand Total = the statement's net.
 *
 * A document stays light: plain black text, thin light-grey borders, light-grey label cells.
 */

// ------------------------------------------------------------------ context

/** What the report prints that the statement record does not carry. Every field may be blank. */
export interface PayReportContext {
  company?: { legalName?: string | null; address?: string | null; phone?: string | null; fax?: string | null } | null;
  driver?: { contractType?: string | null; city?: string | null; state?: string | null; phone?: string | null } | null;
  /** The load's stops, by load id, in their order on the load. */
  stopsByLoad?: Record<string, PayReportStop[]>;
  /** Today in US Eastern (YYYY-MM-DD): the Generation Date. */
  generatedOn?: string | null;
}

export interface PayReportStop {
  kind: 'pickup' | 'delivery';
  /** The day of the stop in US Eastern, YYYY-MM-DD; blank when the load has no time for it. */
  date: string;
  facility: string;
  city: string;
  state: string;
}

/** A stop's day: when the work happened there, else its appointment; always in US Eastern. */
export function stopDay(stop: { kind: string; loadedAt?: string | null; departedAt?: string | null; arrivedAt?: string | null; appointmentStartAt?: string | null }): string {
  const at = stop.kind === 'pickup' ? (stop.loadedAt ?? stop.departedAt ?? stop.arrivedAt ?? stop.appointmentStartAt) : (stop.arrivedAt ?? stop.departedAt ?? stop.appointmentStartAt);
  return at ? easternDay(at) : '';
}

export function easternDay(at: string | Date): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return typeof at === 'string' ? at.slice(0, 10) : '';
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ------------------------------------------------------------------ the model

export interface PayReportLoadRow {
  /** "Pickup:", "Delivery:", "Rate:", "Accessorial:", "Reimbursement:". */
  label: string;
  text: string;
  /** Present on a pay row: the amount in its own cell. */
  cents?: number;
}

export interface PayReportLoad {
  loadNumber: string;
  rows: PayReportLoadRow[];
  notes: string;
  totalCents: number;
}

export interface PayReportSection {
  /** The grey header row; null for rows that continue the table above without a header of their own. */
  title: string | null;
  /** Signed as they act on pay: a deduction is negative, a reimbursement positive. */
  rows: Array<{ description: string; cents: number }>;
}

export interface PayReportModel {
  title: string;
  draft: boolean;
  company: { name: string; lines: string[] };
  /** The header table on the right, label then value. */
  info: Array<[string, string]>;
  loads: PayReportLoad[];
  subTotalCents: number;
  sections: PayReportSection[];
  grandTotalCents: number;
  /** Money the statement could not pay this week and carries to the next; 0 when none. */
  carryCents: number;
  notes: string[];
  /** Set when the statement has no computation yet; the body says so instead. */
  empty: string | null;
}

export function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function sharePercent(drivers: number): string {
  const pct = 100 / drivers;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** The pay row of a load, in the words of the old report: "$1,900.00 * 30%", "932 mi * $0.65/mi", "Flat $450.00". */
export function rateText(e: EarningLine): string {
  let t: string;
  if (e.payBasisMiles !== null && e.payBasisMiles !== undefined && e.rateLabel) t = `${e.payBasisMiles.toLocaleString('en-US')} mi * ${e.rateLabel}`;
  else if (e.payBasisCents !== null && e.payBasisCents !== undefined && e.rateLabel) t = `${dollars(e.payBasisCents)} * ${e.rateLabel}`;
  else if (e.kind === 'flat') t = e.rateLabel ? e.rateLabel.replace(/^flat/, 'Flat') : 'Flat';
  else t = e.description;
  if (e.kind === 'empty_miles') t += ' (empty miles)';
  if (e.teamShare && e.teamShare.drivers > 1) t += ` * ${sharePercent(e.teamShare.drivers)} team share`;
  return t;
}

/** The team-share sentence, in the order the pay was computed, so it never disagrees with the cents. */
function shareNote(e: EarningLine): string | null {
  if (e.teamShare && e.teamShare.drivers > 1) {
    const basis = e.payBasisCents !== null && e.payBasisCents !== undefined ? dollars(e.payBasisCents) : e.payBasisMiles !== null && e.payBasisMiles !== undefined ? `${e.payBasisMiles.toLocaleString('en-US')} mi` : '';
    return `Team load: ${e.rateLabel ?? 'pay'} of ${basis} = ${dollars(e.teamShare.beforeShareCents)}; your ${sharePercent(e.teamShare.drivers)} team share of ${e.teamShare.drivers} drivers = ${dollars(e.cents)}.`;
  }
  if (e.description && /team share|\bsplit\b/.test(e.description)) return 'Team load: this row is your share of the load’s pay.';
  return null;
}

const PAY_KINDS = new Set<EarningLine['kind']>(['loaded_miles', 'empty_miles', 'percentage', 'flat']);

function withPrefix(prefix: string, description: string): string {
  const d = description.trim();
  if (!d) return prefix;
  return d.toLowerCase().startsWith(prefix.toLowerCase()) ? d : `${prefix} · ${d}`;
}

/** The order the deductions are printed in under the recurring ones. */
const DEDUCTION_ORDER: Array<DeductionLine['kind']> = ['fuel', 'lease', 'escrow', 'tolls', 'advance', 'manual_charge', 'debt_recovery', 'carry_forward', 'reversal'];

function deductionText(d: DeductionLine): string {
  switch (d.kind) {
    case 'tolls':
      return withPrefix('Tolls', d.description);
    case 'advance':
      return withPrefix('Advance', d.description);
    case 'carry_forward':
      return withPrefix('Carried forward', d.description);
    case 'reversal':
      return withPrefix('Refund', d.description);
    default:
      return d.description || d.kind.replace(/_/g, ' ');
  }
}

function companyLines(c: PayReportContext['company']): string[] {
  const out: string[] = [];
  const address = (c?.address ?? '').trim();
  if (address) {
    const parts = address.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (parts.length === 1) {
      // "1200 Main St, Atlanta, GA 30301" prints as the street, then the city line.
      const one = parts[0]!;
      const comma = one.indexOf(',');
      if (comma > 0 && one.indexOf(',', comma + 1) > comma) out.push(one.slice(0, comma).trim(), one.slice(comma + 1).trim());
      else out.push(one);
    } else out.push(...parts);
  }
  out.push(`Phone: ${(c?.phone ?? '').trim()}`);
  out.push(`Fax: ${(c?.fax ?? '').trim()}`);
  return out;
}

/** The whole report, laid out. Pure: the statement in, the rows out. */
export function payReportModel(s: StatementRecord, companyName: string, ctx: PayReportContext = {}): PayReportModel {
  const draft = s.status !== 'approved' && s.status !== 'paid';
  const contract = ctx.driver?.contractType ?? (s.kind === 'cd' ? 'CD' : null);
  const place = [ctx.driver?.city, ctx.driver?.state].map((x) => (x ?? '').trim()).filter(Boolean).join(', ');
  const info: Array<[string, string]> = [
    ['Driver:', `${s.partyName.toUpperCase()}${contract ? ` (${contract})` : ''}`],
    ['Address:', place ? `${place}, USA` : ''],
    ['Phone #:', (ctx.driver?.phone ?? '').trim()],
    ['Report Date:', s.payDate],
    ['Search From:', s.periodStart],
    ['Search To:', s.periodEnd],
    ['Generation Date:', ctx.generatedOn ?? easternDay(new Date())],
  ];
  const company = { name: (ctx.company?.legalName ?? '').trim() || companyName, lines: companyLines(ctx.company) };
  const base: PayReportModel = { title: 'Driver Pay Report', draft, company, info, loads: [], subTotalCents: 0, sections: [], grandTotalCents: 0, carryCents: 0, notes: [], empty: null };
  const c = s.computation;
  if (!c) return { ...base, empty: 'This statement has not been calculated yet.', notes: draft ? ['This is a draft. The amounts can still change before it is approved.'] : [] };

  // ---------------------------------------------------------------- one block per load
  // Every earning tied to a load sits in that load's block - its pay, the accessorials the driver
  // was allocated and a reimbursement filed against it - so a block's total is what the load paid.
  const order: string[] = [];
  const byLoad = new Map<string, EarningLine[]>();
  const loose: EarningLine[] = [];
  for (const e of c.earnings) {
    if (!e.loadId) { loose.push(e); continue; }
    if (!byLoad.has(e.loadId)) { byLoad.set(e.loadId, []); order.push(e.loadId); }
    byLoad.get(e.loadId)!.push(e);
  }
  const loads: PayReportLoad[] = order.map((id) => {
    const lines = byLoad.get(id)!;
    const first = lines[0]!;
    const rows: PayReportLoadRow[] = [];
    const stops = ctx.stopsByLoad?.[id];
    if (stops && stops.length) {
      for (const st of stops) rows.push({ label: st.kind === 'pickup' ? 'Pickup:' : 'Delivery:', text: [st.date, st.facility, st.city, st.state].map((x) => (x ?? '').trim()).filter(Boolean).join(', ') });
    } else {
      // No stops to hand (an old statement read without its load): the line's own run and route.
      const run = lines.find((l) => l.route) ?? first;
      const [from, to] = (run.route ?? '').split('->').map((x) => x.trim());
      if (run.pickedUpOn || from) rows.push({ label: 'Pickup:', text: [run.pickedUpOn, from].filter(Boolean).join(', ') });
      if (run.deliveredOn || to) rows.push({ label: 'Delivery:', text: [run.deliveredOn, to].filter(Boolean).join(', ') });
    }
    const notes: string[] = [];
    for (const e of lines.filter((l) => PAY_KINDS.has(l.kind))) {
      rows.push({ label: 'Rate:', text: rateText(e), cents: e.cents });
      const n = shareNote(e);
      if (n) notes.push(n);
    }
    for (const e of lines.filter((l) => !PAY_KINDS.has(l.kind))) {
      rows.push({ label: e.kind === 'reimbursement' ? 'Reimbursement:' : 'Accessorial:', text: e.txId ? `${e.description} (added after the load was settled)` : e.description, cents: e.cents });
    }
    // The broker's REF beside the L-number (owner, 2026-10-23): "REF 123456 / L-100015".
    return { loadNumber: loadRefLabel(lines.find((l) => l.brokerReference)?.brokerReference, first.loadNumber), rows, notes: notes.join(' '), totalCents: lines.reduce((t, e) => t + e.cents, 0) };
  });
  const subTotalCents = loads.reduce((t, l) => t + l.totalCents, 0);

  // ---------------------------------------------------------------- the sections under it
  const sections: PayReportSection[] = [];
  const otherPay = loose.filter((e) => e.kind !== 'reimbursement');
  if (otherPay.length) sections.push({ title: 'Other Pay', rows: otherPay.map((e) => ({ description: e.description, cents: e.cents })) });

  const deductions = c.deductions.filter((d) => d.cents !== 0);
  const recurring = deductions.filter((d) => d.kind === 'recurring');
  if (recurring.length) sections.push({ title: 'Recurring Deduction', rows: recurring.map((d) => ({ description: d.description, cents: -d.cents })) });
  const rest = deductions.filter((d) => d.kind !== 'recurring');
  const restRows: PayReportSection['rows'] = [];
  const kinds = [...DEDUCTION_ORDER, ...rest.map((d) => d.kind).filter((k) => !DEDUCTION_ORDER.includes(k))];
  for (const kind of new Set(kinds)) {
    const mine = rest.filter((d) => d.kind === kind);
    if (!mine.length) continue;
    // Fuel prints as one total, as on the old report; each purchase stays on the statement in the app.
    if (kind === 'fuel') restRows.push({ description: 'Fuel', cents: -mine.reduce((t, d) => t + d.cents, 0) });
    else for (const d of mine) restRows.push({ description: deductionText(d), cents: -d.cents });
  }
  if (restRows.length) sections.push({ title: recurring.length ? null : 'Deductions', rows: restRows });

  const reimbursements = loose.filter((e) => e.kind === 'reimbursement');
  if (reimbursements.length) sections.push({ title: 'Reimbursements', rows: reimbursements.map((e) => ({ description: e.description, cents: e.cents })) });

  // ---------------------------------------------------------------- notes
  const notes: string[] = [
    ...(draft ? ['This is a draft. The amounts can still change before it is approved.'] : []),
    ...c.exceptions,
    ...(c.notes ?? []),
    ...c.excluded.map((x) => `${x.loadNumber} is not on this statement: ${x.reason}`),
  ];
  // Balances: what is not known is said, never printed as zero.
  const escrowUnreconciled = c.exceptions.some((x) => /escrow/i.test(x) && /reconcil/i.test(x));
  if (c.escrowCents !== 0 || (c.escrowBalanceAfterCents ?? 0) !== 0 || escrowUnreconciled) {
    if (c.escrowBalanceAfterCents === null) notes.push('Escrow balance: not reconciled yet. Escrow is not withheld until the opening balance is reconciled.');
    else notes.push(`Escrow balance: ${dollars(c.escrowBalanceAfterCents - c.escrowCents)} at the start of this period, ${dollars(c.escrowCents)} withheld, ${dollars(c.escrowBalanceAfterCents)} now.`);
  }
  const showDebt = c.openingDebtCents === null || c.closingDebtCents === null || (c.openingDebtCents ?? 0) !== 0 || (c.closingDebtCents ?? 0) !== 0 || c.carryCents !== 0 || c.deductions.some((d) => d.kind === 'debt_recovery');
  if (showDebt) {
    if (c.openingDebtCents === null) notes.push('Advances and charges owed: not reconciled yet.');
    else notes.push(`Advances and charges owed: ${dollars(c.openingDebtCents)} before this statement, still owed ${c.closingDebtCents === null ? 'not reconciled yet' : dollars(c.closingDebtCents)}.`);
  }

  return { ...base, loads, subTotalCents, sections, grandTotalCents: c.netCents, carryCents: c.carryCents, notes };
}

// ------------------------------------------------------------------ drawing

const PAGE = { w: 612, h: 792, margin: 36 };
const WIDTH = PAGE.w - PAGE.margin * 2;
const INK = rgb(0, 0, 0);
const BORDER = rgb(0.851, 0.851, 0.851);
const LABEL_FILL = rgb(0.925, 0.925, 0.925);
const HEAD_FILL = rgb(0.88, 0.88, 0.88);
const SIZE = 8.5;
const LINE_H = SIZE + 2.5;
const PAD = 3;

/** The standard fonts speak WinAnsi: arrows and anything outside Latin-1 become plain ASCII. */
function ascii(t: string): string {
  return t.replace(/→/g, '->').replace(/×/g, '*').replace(/[^ -ÿ–—‘’“”•…]/g, '?');
}

interface Cell {
  w: number;
  text: string;
  bold?: boolean;
  align?: 'left' | 'right' | 'center';
  fill?: ReturnType<typeof rgb>;
  size?: number;
}

class Pages {
  page!: PDFPage;
  y = 0;
  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
    readonly model: PayReportModel,
  ) {
    this.newPage();
  }

  private wrap(text: string, width: number, font: PDFFont, size: number): string[] {
    const max = width - PAD * 2;
    const t = ascii(text);
    if (font.widthOfTextAtSize(t, size) <= max) return [t];
    const out: string[] = [];
    let line = '';
    for (const word of t.split(' ')) {
      let w = word;
      // A word wider than the cell (a long load number) breaks on the character.
      while (font.widthOfTextAtSize(w, size) > max) {
        let take = w.length;
        while (take > 1 && font.widthOfTextAtSize(w.slice(0, take), size) > max) take -= 1;
        if (line) { out.push(line); line = ''; }
        out.push(w.slice(0, take));
        w = w.slice(take);
      }
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) <= max) line = next;
      else { out.push(line); line = w; }
    }
    if (line) out.push(line);
    return out;
  }

  rowHeight(cells: Cell[]): number {
    return Math.max(...cells.map((c) => this.wrap(c.text, c.w, c.bold ? this.bold : this.font, c.size ?? SIZE).length)) * LINE_H + PAD * 2 - 1;
  }

  /** One bordered row at the cursor; the caller has made room for it. */
  row(cells: Cell[], x0 = PAGE.margin): void {
    const h = this.rowHeight(cells);
    let x = x0;
    for (const c of cells) {
      const font = c.bold ? this.bold : this.font;
      const size = c.size ?? SIZE;
      this.page.drawRectangle({ x, y: this.y - h, width: c.w, height: h, color: c.fill, borderColor: BORDER, borderWidth: 0.6 });
      this.wrap(c.text, c.w, font, size).forEach((line, n) => {
        const tw = font.widthOfTextAtSize(line, size);
        const tx = c.align === 'right' ? x + c.w - PAD - tw : c.align === 'center' ? x + (c.w - tw) / 2 : x + PAD;
        this.page.drawText(line, { x: tx, y: this.y - PAD - size - n * LINE_H + 1, size, font, color: INK });
      });
      x += c.w;
    }
    this.y -= h;
  }

  /** Room for `h` points, or a new page (with the header) when there is not. */
  ensure(h: number): void {
    // The page number sits at 20pt; the body may run down to the margin above it.
    if (this.y - h < PAGE.margin) this.newPage();
  }

  newPage(): void {
    this.page = this.doc.addPage([PAGE.w, PAGE.h]);
    const m = this.model;
    if (m.draft) this.page.drawText('DRAFT', { x: 150, y: 300, size: 110, font: this.bold, color: rgb(0.93, 0.93, 0.93), rotate: { type: 'degrees', angle: 35 } as never });
    // Title, centred.
    let y = PAGE.h - PAGE.margin;
    const tw = this.bold.widthOfTextAtSize(m.title, 16);
    this.page.drawText(m.title, { x: (PAGE.w - tw) / 2, y: y - 16, size: 16, font: this.bold, color: INK });
    y -= 30;
    // The company on the left.
    const top = y;
    let ly = top - 10;
    this.page.drawText(ascii(m.company.name), { x: PAGE.margin, y: ly, size: 10, font: this.bold, color: INK });
    ly -= 13;
    for (const l of m.company.lines) {
      this.page.drawText(ascii(l), { x: PAGE.margin, y: ly, size: 9, font: this.font, color: INK });
      ly -= 12;
    }
    // The driver and the dates on the right.
    this.y = top;
    const labelW = 88;
    const valueW = 190;
    for (const [label, value] of m.info) this.row([{ w: labelW, text: label, fill: LABEL_FILL }, { w: valueW, text: value }], PAGE.w - PAGE.margin - labelW - valueW);
    this.y = Math.min(this.y, ly) - 14;
  }
}

const LABEL_W = 78;
const AMOUNT_W = 96;
const TOTAL_LABEL_W = 70;

/** Draws the model. Letter portrait, every page headed alike and numbered "Page N of M". */
export async function renderPayReport(m: PayReportModel): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const p = new Pages(doc, font, bold, m);
  const label = (t: string): Cell => ({ w: LABEL_W, text: t, fill: LABEL_FILL });

  if (m.empty) {
    p.ensure(20);
    p.row([{ w: WIDTH, text: m.empty }]);
  }

  // ---------------------------------------------------------------- load blocks
  for (const l of m.loads) {
    const rows: Cell[][] = [[label('Load #'), { w: WIDTH - LABEL_W, text: l.loadNumber, bold: true }]];
    for (const r of l.rows) {
      if (r.cents === undefined) rows.push([label(r.label), { w: WIDTH - LABEL_W, text: r.text }]);
      else rows.push([label(r.label), { w: WIDTH - LABEL_W - AMOUNT_W, text: r.text }, { w: AMOUNT_W, text: dollars(r.cents), align: 'right' }]);
    }
    rows.push([label('Notes:'), { w: WIDTH - LABEL_W - TOTAL_LABEL_W - AMOUNT_W, text: l.notes }, { w: TOTAL_LABEL_W, text: 'Total Pay:', bold: true, fill: LABEL_FILL }, { w: AMOUNT_W, text: dollars(l.totalCents), bold: true, align: 'right' }]);
    // A block stays on one page when it fits on one; a very long one continues row by row.
    const h = rows.reduce((t, r) => t + p.rowHeight(r), 0);
    p.ensure(Math.min(h, 600));
    for (const r of rows) {
      p.ensure(p.rowHeight(r));
      p.row(r);
    }
    p.y -= 8;
  }
  if (m.loads.length) {
    const sub: Cell[] = [{ w: WIDTH - AMOUNT_W, text: 'Sub-Total:', bold: true, align: 'right', fill: LABEL_FILL }, { w: AMOUNT_W, text: dollars(m.subTotalCents), bold: true, align: 'right' }];
    p.ensure(p.rowHeight(sub));
    p.row(sub);
    p.y -= 12;
  }

  // ---------------------------------------------------------------- sections
  for (const s of m.sections) {
    const head: Cell[] | null = s.title ? [{ w: WIDTH - AMOUNT_W, text: s.title, bold: true, fill: HEAD_FILL }, { w: AMOUNT_W, text: 'Amount', bold: true, align: 'right', fill: HEAD_FILL }] : null;
    const rows = s.rows.map((r): Cell[] => [{ w: WIDTH - AMOUNT_W, text: r.description }, { w: AMOUNT_W, text: dollars(r.cents), align: 'right' }]);
    // A header never sits alone at the foot of a page.
    p.ensure((head ? p.rowHeight(head) : 0) + (rows[0] ? p.rowHeight(rows[0]) : 0));
    if (head) p.row(head);
    for (const r of rows) {
      p.ensure(p.rowHeight(r));
      p.row(r);
    }
    p.y -= s.title === 'Recurring Deduction' ? 0 : 8;
  }

  // ---------------------------------------------------------------- grand total
  if (!m.empty) {
    const grand: Cell[] = [{ w: WIDTH - AMOUNT_W - 30, text: 'Grand Total:', bold: true, align: 'right', fill: LABEL_FILL }, { w: AMOUNT_W + 30, text: `${dollars(m.grandTotalCents)} USD`, bold: true, align: 'right', size: 9.5 }];
    p.ensure(p.rowHeight(grand) + (m.carryCents ? 14 : 0));
    p.y -= 4;
    p.row(grand);
    if (m.carryCents) {
      const t = `Carried to next week: ${dollars(m.carryCents)}`;
      p.page.drawText(t, { x: PAGE.w - PAGE.margin - font.widthOfTextAtSize(t, 8) - PAD, y: p.y - 11, size: 8, font, color: INK });
      p.y -= 14;
    }
    p.y -= 12;
  }

  // ---------------------------------------------------------------- notes
  if (m.notes.length) {
    const head: Cell[] = [{ w: WIDTH, text: 'Notes', bold: true, fill: HEAD_FILL }];
    const rows = m.notes.map((n): Cell[] => [{ w: WIDTH, text: n, size: 8 }]);
    // The notes stay together under their header when they fit on one page.
    p.ensure(Math.min(p.rowHeight(head) + rows.reduce((t, r) => t + p.rowHeight(r), 0), 600));
    p.row(head);
    for (const r of rows) {
      p.ensure(p.rowHeight(r));
      p.row(r);
    }
  }

  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const t = `Page ${i + 1} of ${pages.length}`;
    page.drawText(t, { x: (PAGE.w - font.widthOfTextAtSize(t, 8)) / 2, y: 20, size: 8, font, color: INK });
  });
  return Buffer.from(await doc.save());
}
