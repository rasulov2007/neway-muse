import type { Vendor, VendorContact, VendorKind } from './accounting-types';
import { demoData } from './data';
import { saveSoon } from './state-persist';
import { migrateWorkOrderVendors, normaliseVendorName } from './vendor-migration';
import type { RepairOrder } from './types';

/**
 * Vendors as the fleet uses them: the shops, dealers and tyre trucks a work order names.
 *
 * The same rows the accounting module bills against — one vendor list, not two — with the fields
 * a shop record needs (address, phone, contacts, account number) added. Everything here reads and
 * writes the workspace's own rows.
 */

export const VENDOR_KIND_LABEL: Record<VendorKind, string> = {
  shop: 'Shop',
  dealer: 'Dealer',
  tire: 'Tyre service',
  mobile_repair: 'Mobile repair',
  parts: 'Parts supplier',
  towing: 'Towing',
  fuel: 'Fuel',
  tolls: 'Tolls',
  insurance: 'Insurance',
  lease: 'Leasing',
  other: 'Other',
};

/** The kinds the fleet dialog offers; accounting's fuel/tolls/insurance vendors are not shops. */
export const FLEET_VENDOR_KINDS: VendorKind[] = [
  'shop',
  'dealer',
  'tire',
  'mobile_repair',
  'parts',
  'towing',
  'other',
];

export interface VendorStats {
  workOrders: number;
  spend: number;
  lastUsedAt: string | null;
}

/** Runs the one-time text → record migration; safe to call on every read. */
export function ensureVendorRecords(): void {
  const result = migrateWorkOrderVendors(demoData);
  if (result.created.length > 0 || result.linked > 0) saveSoon();
}

export function listFleetVendors(includeInactive = false): Vendor[] {
  ensureVendorRecords();
  return [...demoData.vendors]
    .filter((v) => includeInactive || v.status === 'active')
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getVendor(id: string): Vendor | null {
  ensureVendorRecords();
  return demoData.vendors.find((v) => v.id === id) ?? null;
}

export function vendorWorkOrders(vendorId: string): RepairOrder[] {
  ensureVendorRecords();
  return demoData.repairOrders
    .filter((o) => o.vendorId === vendorId)
    .sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
}

/** Orders and spend against a vendor; spend counts completed orders at their total. */
export function vendorStats(vendorId: string): VendorStats {
  const orders = vendorWorkOrders(vendorId);
  return {
    workOrders: orders.length,
    spend: Math.round(orders.filter((o) => o.status === 'completed').reduce((s, o) => s + o.total, 0) * 100) / 100,
    lastUsedAt: orders[0]?.openedAt ?? null,
  };
}

export interface VendorInput {
  name: string;
  kind: VendorKind;
  phone?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  email?: string | null;
  website?: string | null;
  accountNumber?: string | null;
  paymentTermsDays?: number;
  notes?: string | null;
  status?: Vendor['status'];
  contacts?: Array<Omit<VendorContact, 'id'> & { id?: string }>;
}

function clean(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function contactsFrom(input: VendorInput['contacts']): VendorContact[] {
  return (input ?? [])
    .filter((c) => c.name.trim())
    .map((c, i) => ({
      id: c.id ?? `vc_${Date.now().toString(36)}_${i}`,
      name: c.name.trim(),
      role: clean(c.role),
      phone: clean(c.phone),
      email: clean(c.email),
    }));
}

/**
 * The name two records clash on: case, punctuation and a company suffix (LLC, Inc, Co, Corp, Ltd)
 * do not make a second shop - "TRAILER AND TIRE REPAIR" is "Trailer and Tire Repair LLC".
 */
export function vendorClashKey(name: string): string {
  return normaliseVendorName(name).replace(/\b(llc|l l c|inc|incorporated|co|corp|corporation|company|ltd)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Retires a duplicate: hidden from lists and pickers, kept, pointing at the record that stays. */
export async function retireVendor(id: string, intoId: string, reason: string): Promise<Vendor> {
  const vendor = getVendor(id);
  const into = getVendor(intoId);
  if (!vendor || !into) throw new Error('That vendor no longer exists');
  vendor.status = 'inactive';
  vendor.mergedIntoId = into.id;
  vendor.notes = [vendor.notes, `Merged into ${into.name} on ${new Date().toISOString().slice(0, 10)}: ${reason}`].filter(Boolean).join('\n');
  saveSoon();
  return vendor;
}

/** Adds a vendor. A second record with the same normalised name is refused: that is the bug the migration fixed. */
export async function createVendor(input: VendorInput): Promise<Vendor> {
  ensureVendorRecords();
  const name = input.name.trim();
  if (!name) throw new Error('A vendor needs a name');
  const key = vendorClashKey(name);
  const clash = demoData.vendors.find((v) => vendorClashKey(v.name) === key);
  if (clash) {
    const live = clash.mergedIntoId ? (getVendor(clash.mergedIntoId) ?? clash) : clash;
    throw new Error(`${live.name} is already on the vendor list`);
  }
  const vendor: Vendor = {
    id: `ven_${Date.now().toString(36)}`,
    name,
    kind: input.kind,
    city: clean(input.city) ?? '',
    state: (clean(input.state) ?? '').toUpperCase(),
    paymentTermsDays: input.paymentTermsDays ?? 30,
    status: input.status ?? 'active',
    defaultCategory: 'maintenance',
    contactName: null,
    contactEmail: clean(input.email),
    phone: clean(input.phone),
    street: clean(input.street),
    zip: clean(input.zip),
    email: clean(input.email),
    website: clean(input.website),
    accountNumber: clean(input.accountNumber),
    notes: clean(input.notes),
    contacts: contactsFrom(input.contacts),
  };
  demoData.vendors.push(vendor);
  saveSoon();
  return vendor;
}

export async function updateVendor(id: string, input: Partial<VendorInput>): Promise<Vendor> {
  const vendor = getVendor(id);
  if (!vendor) throw new Error('That vendor no longer exists');
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error('A vendor needs a name');
    const key = vendorClashKey(name);
    const clash = demoData.vendors.find((v) => v.id !== id && !v.mergedIntoId && vendorClashKey(v.name) === key);
    if (clash) throw new Error(`${clash.name} is already on the vendor list`);
    vendor.name = name;
  }
  if (input.kind !== undefined) vendor.kind = input.kind;
  if (input.phone !== undefined) vendor.phone = clean(input.phone);
  if (input.street !== undefined) vendor.street = clean(input.street);
  if (input.city !== undefined) vendor.city = clean(input.city) ?? '';
  if (input.state !== undefined) vendor.state = (clean(input.state) ?? '').toUpperCase();
  if (input.zip !== undefined) vendor.zip = clean(input.zip);
  if (input.email !== undefined) {
    vendor.email = clean(input.email);
    vendor.contactEmail = vendor.email;
  }
  if (input.website !== undefined) vendor.website = clean(input.website);
  if (input.accountNumber !== undefined) vendor.accountNumber = clean(input.accountNumber);
  if (input.paymentTermsDays !== undefined) vendor.paymentTermsDays = input.paymentTermsDays;
  if (input.notes !== undefined) vendor.notes = clean(input.notes);
  if (input.status !== undefined) vendor.status = input.status;
  if (input.contacts !== undefined) vendor.contacts = contactsFrom(input.contacts);
  saveSoon();
  return vendor;
}
