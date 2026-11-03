import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoData } from './data';
import { attachWorkOrderInvoice, updateRepairOrder } from './fleet-writes';
import { openPtiWeek, ptiWeek } from './pti-api';
import {
  conditionQueue,
  conditionsFor,
  listPtiComponents,
  raiseComponentWorkOrder,
  rateComponents,
  unitCondition,
} from './pti-condition-api';

/**
 * The loop end to end: rate → the board sees it → Maintenance queues it → a work order carries it
 * → closing the order resets the component. Every step reads and writes the workspace's real rows.
 */
describe('component ratings through to the shop and back', () => {
  const week = '2026-09-14';
  const by = { id: 'usr_test', name: 'Test Reviewer' };

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    demoData.ptiRecords.length = 0;
    demoData.ptiRatings.length = 0;
    demoData.repairOrders.length = 0;
  });

  it('records ratings append-only and shows the worst on the unit', async () => {
    openPtiWeek(week);
    const row = ptiWeek(week)[0]!;
    const [steer, drive, , brakes] = listPtiComponents();
    await rateComponents(
      row.id,
      [
        { componentId: steer!.id, rating: 'good', windowValue: null, windowUnit: null },
        { componentId: drive!.id, rating: 'replace_soon', windowValue: 2, windowUnit: 'weeks' },
        { componentId: brakes!.id, rating: 'monitor', windowValue: null, windowUnit: null },
      ],
      by,
    );
    expect(demoData.ptiRatings).toHaveLength(3);
    const { worst } = unitCondition(row.truckId, week);
    expect(worst?.component.id).toBe(drive!.id);
    expect(worst?.rating).toBe('replace_soon');

    // Re-rating adds a row; the old one stays in the history.
    await rateComponents(
      row.id,
      [{ componentId: drive!.id, rating: 'good', windowValue: null, windowUnit: null }],
      by,
    );
    expect(demoData.ptiRatings).toHaveLength(4);
    expect(unitCondition(row.truckId, week).worst?.rating).toBe('monitor');
  });

  it('refuses a Replace soon rating without its window', async () => {
    openPtiWeek(week);
    const row = ptiWeek(week)[0]!;
    const [steer] = listPtiComponents();
    await expect(
      rateComponents(
        row.id,
        [{ componentId: steer!.id, rating: 'replace_soon', windowValue: null, windowUnit: null }],
        by,
      ),
    ).rejects.toThrow(/expected window/);
  });

  it('queues Replace now for Maintenance, opens a work order carrying the component, and resets it on completion', async () => {
    // The resolution is stamped with the week that "now" falls in, so "now" has to be in `week`
    // for the board read below to be looking at the same week the work was done in.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
    openPtiWeek(week);
    const row = ptiWeek(week)[0]!;
    const truck = demoData.trucks.find((t) => t.id === row.truckId)!;
    truck.status = 'available';
    const [, drive] = listPtiComponents();
    await rateComponents(
      row.id,
      [{ componentId: drive!.id, rating: 'replace_now', windowValue: null, windowUnit: null }],
      by,
    );

    const queued = conditionQueue().filter((item) => item.truckId === row.truckId);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.reason).toBe('replace_now');

    const { order, rating } = await raiseComponentWorkOrder(row.truckId, drive!.id, by);
    expect(order.summary).toContain('Drive tyres');
    expect(order.summary).toContain('Replace now');
    expect(order.notes).toContain('PTI video');
    expect(order.type).toBe('tire_replacement');
    expect(rating.workOrderId).toBe(order.id);
    // On an open order, so no longer queued; and a second order is refused.
    expect(conditionQueue().filter((item) => item.truckId === row.truckId)).toHaveLength(0);
    await expect(raiseComponentWorkOrder(row.truckId, drive!.id, by)).rejects.toThrow(
      /Already on work order/,
    );

    // Attaching the invoice completes the order, which resets the component to Good with a note.
    // The shop work happens later the same day, still inside the week under test.
    vi.setSystemTime(new Date('2026-09-16T18:00:00Z'));
    await attachWorkOrderInvoice({
      orderId: order.id,
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      uploadedBy: 'Test',
      fileUrl: '/api/v1/files/file_test', fileId: 'file_test',
      amount: 1200,
    });
    const drives = conditionsFor(row.truckId, week).find((c) => c.component.id === drive!.id)!;
    expect(drives.rating).toBe('good');
    expect(drives.source?.note).toMatch(/completed/);
    expect(drives.source?.workOrderId).toBe(order.id);
  });

  it('resets on a status move to completed as well, and closes a Replace soon window that has passed', async () => {
    openPtiWeek(week);
    const row = ptiWeek(week)[0]!;
    demoData.trucks.find((t) => t.id === row.truckId)!.status = 'available';
    const [steer] = listPtiComponents();
    await rateComponents(
      row.id,
      [{ componentId: steer!.id, rating: 'replace_soon', windowValue: 1, windowUnit: 'weeks' }],
      by,
    );
    // Age the rating so its window has closed.
    const rating = demoData.ptiRatings[0]!;
    rating.ratedAt = '2026-08-01T12:00:00.000Z';
    rating.weekStart = '2026-07-27';

    const queued = conditionQueue().find((item) => item.truckId === row.truckId);
    expect(queued?.reason).toBe('window_closed');

    const { order } = await raiseComponentWorkOrder(row.truckId, steer!.id, by);
    await attachWorkOrderInvoice({
      orderId: order.id,
      fileName: 'i.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1,
      uploadedBy: 'Test',
      fileUrl: '/api/v1/files/file_test', fileId: 'file_test',
      amount: null,
    });
    const reopened = await updateRepairOrder({ id: order.id, status: 'completed' });
    expect(reopened.ok).toBe(true);
    expect(conditionsFor(row.truckId).find((c) => c.component.id === steer!.id)?.rating).toBe(
      'good',
    );
    // Exactly one resolution row, not one per completion path.
    expect(
      demoData.ptiRatings.filter((r) => r.workOrderId === order.id && r.rating === 'good'),
    ).toHaveLength(1);
  });
});
