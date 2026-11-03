import { describe, expect, it } from 'vitest';
import { ExportsService } from './exports.service';
import type { InvoiceRecord } from './invoices.service';

const inv = (n: number, over: Partial<InvoiceRecord> = {}): InvoiceRecord =>
  ({
    id: `inv_${n}`,
    invoiceNumber: `INV-${n}`,
    loadNumber: `L-10000${n}`,
    billToName: 'Sample Brokerage (test)',
    issuedOn: '2026-10-20',
    dueOn: '2026-11-19',
    total: 2250,
    paid: 0,
    balance: 2250,
    status: 'issued',
    paidOn: null,
    rc: { loadReference: `REF${n}`, rcReference: null, state: 'matched' },
    ...over,
  }) as InvoiceRecord;

describe('invoice list download (owner, 2026-10-23)', () => {
  const exportsService = new ExportsService(undefined as never, undefined as never, undefined as never);

  it('writes one row per invoice with the reference and the money', () => {
    const rows = exportsService.invoicesRows([inv(1), inv(2, { status: 'paid', paid: 2250, balance: 0, paidOn: '2026-10-22' })]);
    expect(rows[0]).toEqual(['Invoice', 'Issued', 'Due', 'Bill to', 'Load', 'Reference', 'Total', 'Paid', 'Balance', 'Status', 'Paid on']);
    expect(rows[1]).toEqual(['INV-1', '2026-10-20', '2026-11-19', 'Sample Brokerage (test)', 'L-100001', 'REF1', 2250, 0, 2250, 'Issued', '']);
    expect(rows[2]?.[9]).toBe('Paid');
    expect(exportsService.xlsx('Invoices', rows).subarray(0, 2).toString()).toBe('PK');
  });

  it('renders a PDF of the period', async () => {
    const pdf = await exportsService.invoicesPdf([inv(1), inv(2)], 'NORTHWIND FREIGHT', '2026-10-01 to 2026-10-31');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
