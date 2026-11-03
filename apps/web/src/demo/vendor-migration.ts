import type { Vendor } from './accounting-types';
import type { RepairOrder } from './types';

/**
 * Vendors become records.
 *
 * A work order used to carry the shop as free text, which is why the spend dashboard had to group
 * "TA Truck Service" with "TA truck service " by squinting at the string. Every distinct name on
 * the existing orders becomes a Vendor row — deduplicated on the normalised name, matched to the
 * accounting vendors that already exist — and the order keeps a pointer to it. The original text
 * is kept on the vendor as a note so nothing that was typed is lost.
 *
 * Idempotent: an order that already points at a vendor is left alone, and running twice creates
 * nothing new.
 */

/** Lower-cased, punctuation-light, whitespace-collapsed: what makes two spellings one shop. */
export function normaliseVendorName(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[’'"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** "Midwest Diesel Repair – Gary" → name "Midwest Diesel Repair", city "Gary". */
export function splitVendorText(text: string): { name: string; city: string | null } {
  const parts = text.split(/\s+[–—-]\s+/);
  if (parts.length >= 2) {
    const city = parts[parts.length - 1]?.trim() ?? '';
    const name = parts.slice(0, -1).join(' – ').trim();
    if (name && city && city.length <= 40) return { name, city };
  }
  return { name: text.trim(), city: null };
}

export interface VendorMigrationResult {
  created: Vendor[];
  linked: number;
}

export function migrateWorkOrderVendors(data: {
  vendors: Vendor[];
  repairOrders: RepairOrder[];
}): VendorMigrationResult {
  const byKey = new Map<string, Vendor>();
  for (const vendor of data.vendors) {
    byKey.set(normaliseVendorName(vendor.name), vendor);
    // The imported text may carry the city; either spelling should find the record.
    if (vendor.city) byKey.set(normaliseVendorName(`${vendor.name} ${vendor.city}`), vendor);
  }
  const created: Vendor[] = [];
  let linked = 0;
  let seq = data.vendors.length;

  for (const order of data.repairOrders) {
    if (order.vendorId) continue;
    const text = order.vendorName?.trim();
    if (!text) continue;
    const full = normaliseVendorName(text);
    const { name, city } = splitVendorText(text);
    let vendor = byKey.get(full) ?? byKey.get(normaliseVendorName(name));
    if (!vendor) {
      seq += 1;
      vendor = {
        id: `ven_m${seq.toString(36)}`,
        name,
        kind: 'shop',
        city: city ?? '',
        state: '',
        paymentTermsDays: 30,
        status: 'active',
        defaultCategory: 'maintenance',
        contactName: null,
        contactEmail: null,
        notes: `Imported from work order text: "${text}"`,
        contacts: [],
      };
      data.vendors.push(vendor);
      byKey.set(full, vendor);
      byKey.set(normaliseVendorName(name), vendor);
      created.push(vendor);
    } else if (full !== normaliseVendorName(vendor.name) && !(vendor.notes ?? '').includes(text)) {
      // A second spelling of a known shop: remembered, so the merge is visible later.
      vendor.notes = [vendor.notes, `Also written as: "${text}"`].filter(Boolean).join('\n');
    }
    order.vendorId = vendor.id;
    linked += 1;
  }
  return { created, linked };
}
