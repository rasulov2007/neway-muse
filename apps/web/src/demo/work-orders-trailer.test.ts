import { beforeEach, describe, expect, it } from 'vitest';
import { demoData } from './data';
import { attachWorkOrderInvoice, createRepairOrder, updateRepairOrder } from './fleet-writes';
import { listWorkOrderTypes } from './work-order-types';

/**
 * Trailers are units too: a work order can be opened against one, the shop hold does what it
 * says for a trailer, and the type list offers trailer work.
 */
describe('trailer work orders', () => {
  beforeEach(() => {
    demoData.repairOrders.length = 0;
    demoData.workOrderTypes.length = 0;
  });

  it('offers trailer work for trailers and engine work for trucks, from the same catalog', () => {
    const trailer = listWorkOrderTypes('trailer').map((t) => t.code);
    const truck = listWorkOrderTypes('truck').map((t) => t.code);
    expect(trailer).toEqual(
      expect.arrayContaining(['landing_gear', 'reefer_unit', 'doors_seals', 'tire_replacement']),
    );
    expect(trailer).not.toContain('engine');
    expect(truck).toEqual(expect.arrayContaining(['engine', 'dpf', 'tire_replacement']));
    expect(truck).not.toContain('landing_gear');
  });

  it('opens an order against a trailer, marks it unavailable in the shop and detaches it from its truck, and releases it when done', async () => {
    const trailer = demoData.trailers.find((t) => t.currentTruckId)!;
    const truck = demoData.trucks.find((t) => t.id === trailer.currentTruckId)!;
    truck.currentTrailerId = trailer.id;
    trailer.status = 'assigned';

    const order = await createRepairOrder({
      truckId: '',
      unitType: 'trailer',
      trailerId: trailer.id,
      type: 'landing_gear',
      summary: 'Crank seized',
      priority: 'normal',
      vendorName: '',
      technician: '',
      promisedAt: null,
      status: 'open',
      warranty: false,
      notes: null,
    });
    expect(order).toMatchObject({
      unitType: 'trailer',
      trailerId: trailer.id,
      truckId: '',
      unitNumber: trailer.unitNumber,
      odometer: 0,
    });

    const moved = await updateRepairOrder({ id: order.id, status: 'in_shop' });
    expect(moved.ok).toBe(true);
    expect(trailer.status).toBe('in_shop');
    expect(trailer.currentTruckId).toBeNull();
    expect(truck.currentTrailerId).toBeNull();
    // The truck itself is untouched by a trailer's shop visit.
    expect(truck.status).not.toBe('in_shop');

    await attachWorkOrderInvoice({
      orderId: order.id,
      fileName: 'i.pdf',
      sizeBytes: 1,
      mimeType: 'application/pdf',
      fileUrl: '/api/v1/files/file_test', fileId: 'file_test',
      uploadedBy: 'Test',
      amount: 240,
    });
    expect(demoData.repairOrders.find((o) => o.id === order.id)?.status).toBe('completed');
    expect(trailer.status).toBe('available');
  });

  it('still refuses an unknown unit of either kind', async () => {
    await expect(
      createRepairOrder({
        truckId: '',
        unitType: 'trailer',
        trailerId: 'trl_nope',
        type: 'other',
        summary: 'x',
        priority: 'low',
        vendorName: '',
        technician: '',
        promisedAt: null,
        status: 'open',
        warranty: false,
        notes: null,
      }),
    ).rejects.toThrow(/not in the fleet/);
  });
});
