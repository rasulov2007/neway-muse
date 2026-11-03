import { z } from 'zod';

/**
 * Vendor trucks (owner, 2026-10-28).
 *
 * A vendor is a person who puts their own truck into our fleet. The truck runs our loads with our
 * driver; the company keeps an agreed percentage of the truck's gross, the driver is paid as
 * Accounting sets their pay, and what is left is the vendor's. The vendor's own split does not
 * concern us - what does is what we pay the driver out of it and what the company keeps.
 *
 * The truck's repairs, fuel and other running costs are the vendor's, never a company expense.
 * In the dashboard and analytics the company's percentage counts as company revenue and profit,
 * the truck's costs stay out of company expenses, and the vendor's money is shown on its own.
 *
 * Stored on the existing truck -> vendor arrangement (`acct_vendor_arrangements`). Its
 * `percent_bps` column has always been the VENDOR's share of gross (what VT statements pay out
 * of), so the company's kept percentage is written beside it in the record and the column holds
 * the complement.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/** The `vendors.kind` a truck's owner is kept under, apart from repair shops. */
export const TRUCK_VENDOR_KIND = 'truck_owner';

/** The vendor a truck runs for, as every truck read carries it. Null on a company truck. */
export const TruckVendorSchema = z.object({
  arrangementId: z.string(),
  vendorId: z.string(),
  vendorName: z.string(),
  /** What the company keeps, percent of gross (20 = 20%). */
  companyPercent: z.number(),
  since: isoDate,
});
export type TruckVendor = z.infer<typeof TruckVendorSchema>;

export const MoveTruckToVendorSchema = z
  .object({
    /** An existing vendor, or `vendorName` to add a new one. */
    vendorId: z.string().min(1).nullable().optional(),
    vendorName: z.string().trim().min(2, 'Name the vendor').max(120).nullable().optional(),
    /** Percent of the truck's gross the company keeps (20 = 20%). */
    companyPercent: z.number().min(0).max(100),
    effectiveFrom: isoDate,
    note: z.string().trim().max(300).optional(),
    /** The truck's updatedAt as read; a stale one is a conflict. */
    expectedUpdatedAt: z.string().optional(),
  })
  .refine((v) => Boolean(v.vendorId) || Boolean(v.vendorName?.trim()), {
    message: 'Choose the vendor or type a new vendor’s name.',
    path: ['vendorId'],
  });
export type MoveTruckToVendorRequest = z.infer<typeof MoveTruckToVendorSchema>;

export const EndTruckVendorSchema = z.object({
  /** The last day the truck ran for the vendor. */
  effectiveTo: isoDate,
  reason: z.string().trim().min(3, 'Say why').max(300),
  expectedUpdatedAt: z.string().optional(),
});
export type EndTruckVendorRequest = z.infer<typeof EndTruckVendorSchema>;

/**
 * Edit percentage (owner, 2026-10-28): what the company keeps changes from a day on. Loads
 * delivered before it keep the old split; the arrangement is closed and a new one opened.
 */
export const ChangeTruckVendorPercentSchema = z.object({
  companyPercent: z.number().min(0).max(100),
  effectiveFrom: isoDate,
  reason: z.string().trim().max(300).optional(),
  expectedUpdatedAt: z.string().optional(),
});
export type ChangeTruckVendorPercentRequest = z.infer<typeof ChangeTruckVendorPercentSchema>;

/** Percent (20 or 20.5) to basis points, never a float that drifts. */
export function percentToBps(percent: number): number {
  return Math.round(percent * 100);
}

/** The vendor's share of gross, which is what `percent_bps` holds: everything the company does not keep. */
export function vendorShareBps(companyBps: number): number {
  return 10_000 - Math.min(10_000, Math.max(0, companyBps));
}

/** The company's part of a gross amount, in cents. */
export function companyShareCents(grossCents: number, companyBps: number): number {
  return Math.round((grossCents * companyBps) / 10_000);
}

/** The company's kept percent from a stored arrangement: the record's own figure, else the complement of the vendor share. */
export function companyBpsOf(arrangement: { companyPercentBps?: number | null; percentBps?: number | null }): number | null {
  if (typeof arrangement.companyPercentBps === 'number') return arrangement.companyPercentBps;
  if (typeof arrangement.percentBps === 'number') return 10_000 - arrangement.percentBps;
  return null;
}

/** An arrangement in force on a day (`effectiveTo` inclusive). */
export function arrangementOn<T extends { effectiveFrom: string; effectiveTo: string | null }>(rows: readonly T[], day: string): T | null {
  return rows.filter((a) => a.effectiveFrom <= day && (!a.effectiveTo || a.effectiveTo >= day)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
}

// ------------------------------------------------------------------------- the money section

/** One vendor truck's period, as the dashboard and analytics show it. Dollars. */
export const VendorTruckMoneySchema = z.object({
  truckId: z.string(),
  unitNumber: z.string(),
  vendorId: z.string(),
  vendorName: z.string(),
  companyPercent: z.number(),
  loads: z.number().int(),
  /** Everything the truck's loads billed. */
  gross: z.number(),
  /** What the company keeps: counted in company revenue and profit. */
  companyShare: z.number(),
  /** Paid to the driver out of the vendor's part. */
  driverPay: z.number(),
  /** Fuel, repairs and other costs the company paid on the truck, taken from the vendor's part; never company expense. A repair the vendor paid the shop for directly is not here. */
  truckCosts: z.number(),
  /** What is left for the vendor: gross - company share - driver pay - truck costs. */
  vendorNet: z.number(),
});
export type VendorTruckMoney = z.infer<typeof VendorTruckMoneySchema>;

export const VendorMoneySummarySchema = z.object({
  from: isoDate,
  to: isoDate,
  trucks: z.array(VendorTruckMoneySchema),
  totals: z.object({
    trucks: z.number().int(),
    loads: z.number().int(),
    gross: z.number(),
    companyShare: z.number(),
    driverPay: z.number(),
    truckCosts: z.number(),
    vendorNet: z.number(),
  }),
});
export type VendorMoneySummary = z.infer<typeof VendorMoneySummarySchema>;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Adds the per-truck rows up; rounding to cents at the end, never per step. */
export function vendorMoneyTotals(rows: readonly VendorTruckMoney[]): VendorMoneySummary['totals'] {
  const sum = (k: 'gross' | 'companyShare' | 'driverPay' | 'truckCosts' | 'vendorNet') => round2(rows.reduce((s, r) => s + r[k], 0));
  return {
    trucks: rows.length,
    loads: rows.reduce((s, r) => s + r.loads, 0),
    gross: sum('gross'),
    companyShare: sum('companyShare'),
    driverPay: sum('driverPay'),
    truckCosts: sum('truckCosts'),
    vendorNet: sum('vendorNet'),
  };
}

/** `GET /dashboard/vendors`: the summary, with the period meta and whether money was withheld. */
export const DashboardVendorsSchema = VendorMoneySummarySchema.extend({
  meta: z.unknown(),
  masked: z.boolean(),
});
export type DashboardVendors = z.infer<typeof DashboardVendorsSchema>;
