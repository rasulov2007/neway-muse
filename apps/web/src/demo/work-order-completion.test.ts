import { beforeEach, describe, expect, it } from 'vitest';
import { demoData } from './data';
import {
  attachWorkOrderInvoice,
  completeWorkOrderWithoutInvoice,
  createRepairOrder,
  updateRepairOrder,
} from './fleet-writes';

/**
 * P1 #8: completing a work order asks for the invoice, and the "no invoice" path is deliberate.
 * The rule (completed work carries its invoice) still refuses a bare status change; the dialog's
 * two paths - attach, or complete without one for a reason - are the only ways through.
 */
describe('completing a work order', () => {
  beforeEach(() => {
    demoData.repairOrders.length = 0;
  });

  async function open() {
    const truck = demoData.trucks[0]!;
    return createRepairOrder({
      truckId: truck.id,
      type: 'brake_inspection',
      summary: 'Rear pads worn',
      priority: 'normal',
      vendorName: '',
      technician: '',
      promisedAt: null,
      status: 'open',
      warranty: false,
      notes: null,
    });
  }

  it('still refuses a bare status change with no invoice', async () => {
    const order = await open();
    const result = await updateRepairOrder({ id: order.id, status: 'completed' });
    expect(result.ok).toBe(false);
    expect(result.blocked).toMatch(/no invoice yet/);
  });

  it('completes without an invoice for a stated reason and flags the order as awaiting one', async () => {
    const order = await open();
    const done = await completeWorkOrderWithoutInvoice({
      orderId: order.id,
      reason: 'warranty',
      note: 'Covered by the brake warranty',
      completedBy: 'Shop lead',
    });
    expect(done.status).toBe('completed');
    expect(done.completedAt).not.toBeNull();
    expect(done.awaitingInvoice).toMatchObject({ reason: 'warranty', by: 'Shop lead' });
  });

  it('attaching the invoice later clears the flag and keeps the invoice number and date', async () => {
    const order = await open();
    await completeWorkOrderWithoutInvoice({
      orderId: order.id,
      reason: 'invoice_to_follow',
      note: 'Shop sends it Friday',
      completedBy: 'Shop lead',
    });
    const withInvoice = await attachWorkOrderInvoice({
      orderId: order.id,
      fileName: 'inv.pdf',
      sizeBytes: 12,
      mimeType: 'application/pdf',
      fileUrl: '/api/v1/files/file_test',
      fileId: 'file_test',
      uploadedBy: 'Shop lead',
      amount: 412.5,
      invoiceNumber: 'INV-10482',
      invoiceDate: '2026-09-17',
    });
    expect(withInvoice.awaitingInvoice).toBeNull();
    expect(withInvoice.invoices?.[0]).toMatchObject({
      invoiceNumber: 'INV-10482',
      invoiceDate: '2026-09-17',
      amount: 412.5,
    });
    expect(withInvoice.total).toBe(412.5);
  });
});
