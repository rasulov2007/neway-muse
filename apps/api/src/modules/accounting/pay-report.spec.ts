import { inflateSync } from 'node:zlib';
import type { EarningLine, StatementComputation } from '@neway/shared';
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { ExportsService } from './exports.service';
import { dollars, payReportModel, stopDay, type PayReportContext } from './pay-report';
import type { StatementRecord } from './settlements.service';

/**
 * The driver statement printed as the owner's "Driver Pay Report" (2026-10-22): the layout is
 * read from the model, and - where poppler's pdftotext is installed - from the PDF itself.
 */

function load(id: string, number: string, over: Partial<EarningLine> = {}): EarningLine {
  return { kind: 'percentage', loadId: id, loadNumber: number, pickedUpOn: '2026-10-12', deliveredOn: '2026-10-13', route: 'Dallas, TX -> Memphis, TN', payBasisCents: 190_000, rateLabel: '30%', description: 'Load pay · 30% of gross', cents: 57_000, basis: '30% × $1,900.00', ...over };
}

function statement(over: Partial<StatementComputation> = {}, rec: Partial<StatementRecord> = {}): StatementRecord {
  const earnings: EarningLine[] = over.earnings ?? [
    load('ld_1', 'L-1101'),
    { kind: 'accessorial', loadId: 'ld_1', loadNumber: 'L-1101', description: 'Detention', cents: 7_500, basis: 'full' },
    load('ld_2', 'L-1102', { kind: 'loaded_miles', payBasisCents: null, payBasisMiles: 932, rateLabel: '$0.65/mi', cents: 60_580, description: 'Loaded miles' }),
    { kind: 'reimbursement', loadId: null, loadNumber: null, description: 'Lumper receipt', cents: 15_000, basis: 'reimbursement' },
  ];
  const deductions = over.deductions ?? [
    { kind: 'fuel' as const, description: 'Fuel · Pilot #187', cents: 49_187, onDate: '2026-10-16', txId: 't1', basis: 'fuel_ledger' },
    { kind: 'fuel' as const, description: "Fuel · Love's #331", cents: 43_678, onDate: '2026-10-14', txId: 't2', basis: 'fuel_ledger' },
    { kind: 'lease' as const, description: 'Maintenance fee (2,160 mi × $0.13/mi)', cents: 28_080, onDate: '2026-10-18', txId: null, basis: '2,160 mi × $0.13/mi', ref: 'maintenance_fee' },
    { kind: 'recurring' as const, description: 'PrePass', cents: 925, txId: null, basis: 'weekly', ref: 'rcd_1' },
    { kind: 'tolls' as const, description: 'I-294', cents: 4_150, onDate: '2026-10-15', txId: 't3', basis: 'toll feed' },
    { kind: 'escrow' as const, description: 'Escrow · to $3000', cents: 5_000, txId: null, basis: 'balance $0.00' },
  ];
  const gross = earnings.filter((e) => e.kind !== 'reimbursement').reduce((t, e) => t + e.cents, 0);
  const reimb = earnings.filter((e) => e.kind === 'reimbursement').reduce((t, e) => t + e.cents, 0);
  const escrow = deductions.filter((d) => d.kind === 'escrow').reduce((t, d) => t + d.cents, 0);
  const ded = deductions.filter((d) => d.kind !== 'escrow').reduce((t, d) => t + d.cents, 0);
  const net = gross + reimb - ded - escrow;
  const computation: StatementComputation = {
    earnings,
    deductions,
    grossCents: gross,
    reimbursementsCents: reimb,
    deductionsCents: ded,
    escrowCents: escrow,
    netCents: net,
    payableCents: Math.max(0, net),
    carryCents: net < 0 ? -net : 0,
    openingDebtCents: 0,
    closingDebtCents: 0,
    escrowBalanceAfterCents: escrow,
    loadCount: 2,
    totalMiles: 0,
    exceptions: [],
    excluded: [],
    recoveries: [],
    recurringCharges: [],
    ...over,
  };
  return {
    id: 'stm_x', sourceKey: 'x', settlementNumber: 'ST-20261012-V_2003', batchId: 'bat_x', kind: 'lo_oo', partyType: 'driver', partyId: 'drv_1', partyName: 'Sam Testwell',
    truckId: null, unitNumber: 'T-211', periodStart: '2026-10-12', periodEnd: '2026-10-18', cutoffAt: '2026-10-19T16:00:00.000Z', payDate: '2026-10-22', status: 'approved',
    netCents: net, payableCents: computation.payableCents, carryCents: computation.carryCents, computation, vendor: null, snapshot: null, loadIds: [], exceptions: [],
    approvedAt: null, approvedBy: null, paidAt: null, paymentId: null, paidCents: null, reversedAt: null, notes: null, versions: [], createdAt: '', updatedAt: '',
    ...rec,
  };
}

const CTX: PayReportContext = {
  company: { legalName: 'Training Freight LLC', address: '1200 Industrial Pkwy, Atlanta, GA 30318', phone: '(404) 555-0100', fax: null },
  driver: { contractType: 'OO', city: 'Atlanta', state: 'GA', phone: '(404) 555-0190' },
  stopsByLoad: {
    ld_1: [
      { kind: 'pickup', date: '2026-10-12', facility: 'Shipper (test)', city: 'Dallas', state: 'TX' },
      { kind: 'delivery', date: '2026-10-13', facility: 'Receiver (test)', city: 'Memphis', state: 'TN' },
    ],
  },
  generatedOn: '2026-10-22',
};

describe('Driver Pay Report: the model', () => {
  it('heads the report with the company and a driver table', () => {
    const m = payReportModel(statement(), 'Fallback name', CTX);
    expect(m.title).toBe('Driver Pay Report');
    expect(m.company.name).toBe('Training Freight LLC');
    expect(m.company.lines).toEqual(['1200 Industrial Pkwy', 'Atlanta, GA 30318', 'Phone: (404) 555-0100', 'Fax: ']);
    expect(Object.fromEntries(m.info)).toEqual({
      'Driver:': 'SAM TESTWELL (OO)',
      'Address:': 'Atlanta, GA, USA',
      'Phone #:': '(404) 555-0190',
      'Report Date:': '2026-10-22',
      'Search From:': '2026-10-12',
      'Search To:': '2026-10-18',
      'Generation Date:': '2026-10-22',
    });
  });

  it('names a load by the broker REF and the L-number, and never prints the real rate', () => {
    // The driver is paid on the For driver $1,900.00; the broker pays more and the PDF does not say so.
    const earnings: EarningLine[] = [load('ld_1', 'L-100015', { brokerReference: '123456' }), load('ld_2', 'L-1102')];
    const m = payReportModel(statement({ earnings }), 'X', CTX);
    expect(m.loads.map((l) => l.loadNumber)).toEqual(['REF 123456 / L-100015', 'L-1102']);
    expect(JSON.stringify(m)).not.toMatch(/Real|\$3,000/);
  });

  it('prints one block per load with its stops, rate and accessorials, and a total pay', () => {
    const m = payReportModel(statement(), 'X', CTX);
    expect(m.loads.map((l) => l.loadNumber)).toEqual(['L-1101', 'L-1102']);
    const [a, b] = m.loads;
    expect(a!.rows).toEqual([
      { label: 'Pickup:', text: '2026-10-12, Shipper (test), Dallas, TX' },
      { label: 'Delivery:', text: '2026-10-13, Receiver (test), Memphis, TN' },
      { label: 'Rate:', text: '$1,900.00 * 30%', cents: 57_000 },
      { label: 'Accessorial:', text: 'Detention', cents: 7_500 },
    ]);
    expect(a!.totalCents).toBe(64_500);
    // No stops to hand: the line's own run and route.
    expect(b!.rows.slice(0, 2)).toEqual([
      { label: 'Pickup:', text: '2026-10-12, Dallas, TX' },
      { label: 'Delivery:', text: '2026-10-13, Memphis, TN' },
    ]);
    expect(b!.rows[2]).toEqual({ label: 'Rate:', text: '932 mi * $0.65/mi', cents: 60_580 });
    expect(m.subTotalCents).toBe(64_500 + 60_580);
  });

  it('lists recurring deductions under their header, the rest as plain rows, fuel as one total', () => {
    const m = payReportModel(statement(), 'X', CTX);
    expect(m.sections.map((s) => s.title)).toEqual(['Recurring Deduction', null, 'Reimbursements']);
    expect(m.sections[0]!.rows).toEqual([{ description: 'PrePass', cents: -925 }]);
    expect(m.sections[1]!.rows).toEqual([
      { description: 'Fuel', cents: -(49_187 + 43_678) },
      { description: 'Maintenance fee (2,160 mi × $0.13/mi)', cents: -28_080 },
      { description: 'Escrow · to $3000', cents: -5_000 },
      { description: 'Tolls · I-294', cents: -4_150 },
    ]);
    expect(m.sections[2]!.rows).toEqual([{ description: 'Lumper receipt', cents: 15_000 }]);
  });

  it('adds up: sub-total plus every section row is the grand total, which is the statement net', () => {
    for (const s of [statement(), statement({ deductions: [] }), statement({ earnings: [load('ld_9', 'L-9')], deductions: [{ kind: 'advance', description: 'Advance', cents: 90_000, txId: 't', basis: '' }] })]) {
      const m = payReportModel(s, 'X', CTX);
      const sum = m.subTotalCents + m.sections.flatMap((x) => x.rows).reduce((t, r) => t + r.cents, 0);
      expect(sum).toBe(s.computation!.netCents);
      expect(m.grandTotalCents).toBe(s.computation!.netCents);
    }
  });

  it('says what is carried to next week only when something is', () => {
    expect(payReportModel(statement(), 'X', CTX).carryCents).toBe(0);
    const short = statement({ earnings: [load('ld_9', 'L-9')], deductions: [{ kind: 'advance', description: 'Advance', cents: 90_000, txId: 't', basis: '' }] });
    expect(payReportModel(short, 'X', CTX).carryCents).toBe(33_000);
  });

  it('keeps the notes: draft, exceptions, the no-truck note, excluded loads', () => {
    const m = payReportModel(statement({ exceptions: ['1 transaction this week still pending approval.'], notes: ['No truck was assigned this week: no lease charge was taken.'], excluded: [{ loadId: 'x', loadNumber: 'L-7', reason: 'Load is in_transit' }] }, { status: 'draft' }), 'X', CTX);
    expect(m.draft).toBe(true);
    expect(m.notes).toEqual(expect.arrayContaining([
      'This is a draft. The amounts can still change before it is approved.',
      '1 transaction this week still pending approval.',
      'No truck was assigned this week: no lease charge was taken.',
      'L-7 is not on this statement: Load is in_transit',
    ]));
  });

  it('shows a team share on the rate row and explains it in the notes', () => {
    const m = payReportModel(statement({ earnings: [load('ld_t', 'L-T', { cents: 28_500, teamShare: { drivers: 2, beforeShareCents: 57_000 } })], deductions: [] }), 'X', CTX);
    expect(m.loads[0]!.rows.at(-1)).toEqual({ label: 'Rate:', text: '$1,900.00 * 30% * 50% team share', cents: 28_500 });
    expect(m.loads[0]!.notes).toBe('Team load: 30% of $1,900.00 = $570.00; your 50% team share of 2 drivers = $285.00.');
  });

  it('dates a stop in US Eastern', () => {
    // 02:30 UTC on the 13th is the evening of the 12th in New York.
    expect(stopDay({ kind: 'delivery', arrivedAt: '2026-10-13T02:30:00.000Z' })).toBe('2026-10-12');
    expect(stopDay({ kind: 'pickup', loadedAt: '2026-10-12T15:00:00.000Z', arrivedAt: '2026-10-11T15:00:00.000Z' })).toBe('2026-10-12');
  });
});

/**
 * The printed lines of a PDF drawn by pdf-lib, page by page: each `x y Tm <hex> Tj` is one piece
 * of text, and pieces on one baseline (within a point and a half) read left to right as a line.
 * No external tool, so the test runs everywhere.
 */
async function pdfLines(bytes: Buffer): Promise<string[][]> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => pdf.context.lookup(r)) : [contents];
    let ops = '';
    for (const st of streams) {
      if (!(st instanceof PDFRawStream)) continue;
      const raw = Buffer.from(st.contents);
      ops += (st.dict.get(PDFName.of('Filter')) ? inflateSync(raw) : raw).toString('latin1');
    }
    const pieces: Array<{ x: number; y: number; t: string }> = [];
    for (const m of ops.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]*)> Tj/g)) {
      pieces.push({ x: Number(m[5]), y: Number(m[6]), t: Buffer.from(m[7]!, 'hex').toString('latin1') });
    }
    pieces.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: Array<{ y: number; parts: typeof pieces }> = [];
    for (const p of pieces) {
      const line = lines.find((l) => Math.abs(l.y - p.y) <= 1.5);
      if (line) line.parts.push(p);
      else lines.push({ y: p.y, parts: [p] });
    }
    return lines.map((l) => l.parts.sort((a, b) => a.x - b.x).map((p) => p.t).join(' '));
  });
}

describe('Driver Pay Report: the PDF', () => {
  it('prints the headings, every load and the totals', async () => {
    const s = statement();
    const bytes = await new ExportsService(null as never, null as never, null as never).statementPdf(s, 'Fallback', null, CTX);
    const pages = await pdfLines(bytes);
    const text = pages.flat().join('\n');
    for (const t of ['Driver Pay Report', 'Training Freight LLC', 'Phone: (404) 555-0100', 'Fax:', 'Driver: SAM TESTWELL (OO)', 'Address: Atlanta, GA, USA', 'Report Date: 2026-10-22', 'Search From: 2026-10-12', 'Search To: 2026-10-18', 'Generation Date: 2026-10-22']) expect(text).toContain(t);
    for (const t of ['Load # L-1101', 'Load # L-1102', 'Pickup: 2026-10-12, Shipper (test), Dallas, TX', 'Rate: $1,900.00 * 30% $570.00', 'Total Pay: $645.00', 'Recurring Deduction', 'PrePass -$9.25', 'Fuel -$928.65', 'Reimbursements', 'Lumper receipt $150.00']) expect(text).toContain(t);
    expect(text).toContain(`Sub-Total: ${dollars(125_080)}`);
    expect(text).toContain(`Grand Total: ${dollars(s.computation!.netCents)} USD`);
    expect(pages[0]).toContain('Page 1 of 1');
    expect(text).not.toContain('Carried to next week');
  });

  it('says what is carried and runs a long week onto numbered pages', async () => {
    const earnings = Array.from({ length: 14 }, (_, i) => load(`ld_${i}`, `L-${2000 + i}`, { cents: 1_000 }));
    const s = statement({ earnings, deductions: [{ kind: 'advance', description: 'Advance', cents: 90_000, txId: 't', basis: '' }] });
    const pages = await pdfLines(await new ExportsService(null as never, null as never, null as never).statementPdf(s, 'Fallback', null, CTX));
    const text = pages.flat().join('\n');
    expect(text).toContain('Carried to next week: $760.00');
    expect(pages.length).toBeGreaterThan(1);
    // Every page carries the title, the driver table and its number.
    pages.forEach((lines, i) => {
      expect(lines).toContain('Driver Pay Report');
      expect(lines.join('\n')).toContain('Driver: SAM TESTWELL (OO)');
      expect(lines).toContain(`Page ${i + 1} of ${pages.length}`);
    });
    for (const e of earnings) expect(text).toContain(e.loadNumber!);
  });
});
