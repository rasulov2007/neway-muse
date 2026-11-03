import { describe, expect, it } from 'vitest';
import type { Vendor } from './accounting-types';
import type { RepairOrder } from './types';
import { migrateWorkOrderVendors, normaliseVendorName, splitVendorText } from './vendor-migration';

function order(id: string, vendorName: string, vendorId: string | null = null): RepairOrder {
  return {
    id,
    roNumber: id.toUpperCase(),
    truckId: 'trk_1',
    unitNumber: '1',
    status: 'completed',
    priority: 'normal',
    type: 'other',
    summary: 'x',
    vendorName,
    vendorId,
    technician: '',
    openedAt: '2026-09-01T00:00:00.000Z',
    promisedAt: null,
    completedAt: '2026-09-02T00:00:00.000Z',
    odometer: 0,
    downtimeMinutes: 0,
    partsTotal: 0,
    laborTotal: 100,
    feesTotal: 0,
    total: 100,
    warranty: false,
    notes: null,
  };
}

const existing: Vendor = {
  id: 'ven_001',
  name: 'TA Truck Service',
  kind: 'shop',
  city: 'Effingham',
  state: 'IL',
  paymentTermsDays: 30,
  status: 'active',
  defaultCategory: 'maintenance',
  contactName: null,
  contactEmail: null,
};

describe('vendor migration', () => {
  it('normalises spelling, spacing and punctuation into one key', () => {
    expect(normaliseVendorName('  TA  Truck-Service ')).toBe('ta truck service');
    expect(normaliseVendorName("Love’s Travel Stops")).toBe('loves travel stops');
    expect(splitVendorText('Midwest Diesel Repair – Gary')).toEqual({ name: 'Midwest Diesel Repair', city: 'Gary' });
    expect(splitVendorText('Freightliner of Chicago')).toEqual({ name: 'Freightliner of Chicago', city: null });
  });

  it('creates one vendor per distinct shop, links every order, matches existing vendors and keeps the original text', () => {
    const data = {
      vendors: [{ ...existing }],
      repairOrders: [
        order('ro_1', 'Midwest Diesel Repair – Gary'),
        order('ro_2', 'midwest  diesel repair - gary'),
        order('ro_3', 'TA truck service'),
        order('ro_4', 'Freightliner of Chicago'),
        order('ro_5', ''),
        order('ro_6', 'Anything', 'ven_kept'),
      ],
    };
    const result = migrateWorkOrderVendors(data);

    expect(result.created.map((v) => v.name)).toEqual(['Midwest Diesel Repair', 'Freightliner of Chicago']);
    expect(result.created[0]).toMatchObject({ city: 'Gary', kind: 'shop' });
    expect(result.created[0]?.notes).toContain('Imported from work order text: "Midwest Diesel Repair – Gary"');
    expect(result.created[0]?.notes).toContain('Also written as: "midwest  diesel repair - gary"');
    expect(result.linked).toBe(4);

    const byId = new Map(data.repairOrders.map((o) => [o.id, o.vendorId]));
    expect(byId.get('ro_1')).toBe(byId.get('ro_2'));
    expect(byId.get('ro_3')).toBe('ven_001');
    expect(byId.get('ro_5')).toBeNull();
    expect(byId.get('ro_6')).toBe('ven_kept');
    expect(data.vendors).toHaveLength(3);

    // Running again changes nothing.
    const again = migrateWorkOrderVendors(data);
    expect(again.created).toHaveLength(0);
    expect(again.linked).toBe(0);
    expect(data.vendors).toHaveLength(3);
  });
});
