import { and, eq, inArray, sql } from 'drizzle-orm';
import { TRUCK_VENDOR_KIND, arrangementOn, companyBpsOf, type TruckVendor } from '@neway/shared';
import type { Database } from '../../database/client';
import { acctVendorArrangements } from '../../database/schema/accounting';
import { vendors } from '../../database/schema/fleet';

/**
 * Vendor trucks (owner, 2026-10-28): the truck -> vendor arrangements as the roster reads them.
 * The arrangement table is Accounting's (VT statements pay from it); the truck pages, the
 * dashboard and analytics read the same rows, so there is one answer to "whose truck is it".
 */

export interface ArrangementRow {
  id: string;
  vendorId: string;
  truckId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  percentBps: number | null;
  companyPercentBps: number | null;
  vendorName: string | null;
}

export async function arrangementsFor(db: Pick<Database, 'select'>, companyId: string, truckIds?: string[]): Promise<ArrangementRow[]> {
  if (truckIds && truckIds.length === 0) return [];
  const rows = await db
    .select()
    .from(acctVendorArrangements)
    .where(and(eq(acctVendorArrangements.companyId, companyId), truckIds ? inArray(acctVendorArrangements.truckId, truckIds) : undefined));
  return rows.map((r) => {
    const rec = (r.record ?? {}) as { companyPercentBps?: number | null; vendorName?: string | null };
    return {
      id: r.id,
      vendorId: r.vendorId,
      truckId: r.truckId,
      effectiveFrom: String(r.effectiveFrom).slice(0, 10),
      effectiveTo: r.effectiveTo ? String(r.effectiveTo).slice(0, 10) : null,
      percentBps: r.percentBps ?? null,
      companyPercentBps: typeof rec.companyPercentBps === 'number' ? rec.companyPercentBps : null,
      vendorName: rec.vendorName ?? null,
    };
  });
}

/** Vendor id -> name, from the vendors table. */
export async function vendorNames(db: Pick<Database, 'select'>, companyId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(and(eq(vendors.companyId, companyId), inArray(vendors.id, ids)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Each truck's vendor on `day`; trucks without one are absent. */
export async function truckVendorsOn(db: Pick<Database, 'select'>, companyId: string, truckIds: string[], day: string): Promise<Map<string, TruckVendor>> {
  const all = await arrangementsFor(db, companyId, truckIds);
  const names = await vendorNames(db, companyId, [...new Set(all.map((a) => a.vendorId))]);
  const out = new Map<string, TruckVendor>();
  for (const truckId of new Set(all.map((a) => a.truckId))) {
    const a = arrangementOn(all.filter((x) => x.truckId === truckId), day);
    if (!a) continue;
    const bps = companyBpsOf(a);
    out.set(truckId, {
      arrangementId: a.id,
      vendorId: a.vendorId,
      vendorName: names.get(a.vendorId) ?? a.vendorName ?? 'Vendor',
      companyPercent: bps === null ? 0 : bps / 100,
      since: a.effectiveFrom,
    });
  }
  return out;
}

/** The truck owners on file, for the Move to vendor picker. */
export async function truckVendorOwners(db: Pick<Database, 'select'>, companyId: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(and(eq(vendors.companyId, companyId), eq(vendors.kind, TRUCK_VENDOR_KIND), sql`${vendors.status} <> 'inactive'`));
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}
