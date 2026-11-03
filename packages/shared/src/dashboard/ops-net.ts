import { z } from 'zod';
import { DashboardMetaSchema } from './meta.js';

/** Driver pay-type buckets, including `unknown` for unclassified drivers (docs/DASHBOARD.md §5). */
export const OPS_NET_PAY_TYPES = [
  'company',
  'owner_operator',
  'lease_owner',
  'percentage',
  'unknown',
] as const;
export const OpsNetPayTypeSchema = z.enum(OPS_NET_PAY_TYPES);
export type OpsNetPayType = z.infer<typeof OpsNetPayTypeSchema>;

const money = z.number().nullable();
const count = z.number().int().nonnegative().nullable();

/** Per-category cost breakdown; a category with no expense line for the bucket is `null`. */
export const OpsNetCostsSchema = z.object({
  fuel: money,
  insurance: money,
  maintenance: money,
  tolls: money,
  repairs: money,
  dispatch_fee: money,
  factoring: money,
  driver_pay: money,
  staff_payroll: money,
  other: money,
});
export type OpsNetCosts = z.infer<typeof OpsNetCostsSchema>;

export const OpsNetBucketSchema = z.object({
  payType: OpsNetPayTypeSchema,
  label: z.string().min(1),
  driverCount: z.number().int().nonnegative(),
  gross: money,
  /** Authoritative per-category breakdown. Sums to `totalCost`. */
  costs: OpsNetCostsSchema,
  /** Flat summary fields kept for compatibility; `costs` is the detailed source of truth. */
  fuel: money,
  insurance: money,
  factoring: money,
  driverPay: money,
  /** Estimated portion of `driverPay`. */
  driverPayEstimated: money,
  other: money,
  totalCost: money,
  operatingProfit: money,
  marginPct: money,
  /** Unit economics for the bucket. */
  rpm: money,
  totalMiles: money,
  activeTrucks: count,
  avgGrossPerTruck: money,
  avgMilesPerTruck: money,
});
export type OpsNetBucket = z.infer<typeof OpsNetBucketSchema>;

/**
 * The company row. It is a bucket in every respect except that it spans all pay types, so it
 * carries no `payType` of its own -- labelling the sum of five buckets `company` (or `unknown`)
 * would be a lie the table then renders.
 */
export const OpsNetTotalsSchema = OpsNetBucketSchema.omit({ payType: true });
export type OpsNetTotals = z.infer<typeof OpsNetTotalsSchema>;

/** Response of `GET /dashboard/ops-net`. */
export const DashboardOpsNetSchema = z.object({
  meta: DashboardMetaSchema,
  buckets: z.array(OpsNetBucketSchema),
  /**
   * The company column: every bucket summed, including `unknown`, so the table's TOTAL always
   * reconciles with the overview gross even when a driver has no parseable pay tag.
   */
  totals: OpsNetTotalsSchema,
  /** Company-level rows that cannot be attributed to a pay type. */
  inactiveTruckLoss: money,
  netOperatingProfit: money,
  unknown: z.object({
    driverCount: z.number().int().nonnegative(),
    gross: money,
    drivers: z.array(
      z.object({
        driverId: z.string().min(1),
        name: z.string(),
        rawPayTag: z.string().nullable(),
      }),
    ),
  }),
  masked: z.boolean(),
});
export type DashboardOpsNet = z.infer<typeof DashboardOpsNetSchema>;
