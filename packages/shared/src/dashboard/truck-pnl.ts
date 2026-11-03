import { z } from 'zod';
import { DashboardMetaSchema } from './meta.js';
import { OpsNetPayTypeSchema } from './ops-net.js';
import { PeriodQueryShape, withPeriodRules } from './period.js';

export const TRUCK_STATUSES = [
  'available',
  'assigned',
  'driving',
  'idle',
  'in_shop',
  'out_of_service',
  'accident',
  'maintenance',
  'sold',
  'archived',
] as const;
export const TruckStatusSchema = z.enum(TRUCK_STATUSES);
export type TruckStatus = z.infer<typeof TruckStatusSchema>;

export const TRUCK_PNL_VIEWS = ['all', 'best', 'worst', 'inactive', 'unprofitable'] as const;
export const TruckPnlViewSchema = z.enum(TRUCK_PNL_VIEWS);
export type TruckPnlView = z.infer<typeof TruckPnlViewSchema>;

export const TRUCK_PNL_SORT_FIELDS = [
  'unitNumber',
  'driverName',
  'gross',
  'miles',
  'loads',
  'cost',
  'profit',
] as const;
export type TruckPnlSortField = (typeof TRUCK_PNL_SORT_FIELDS)[number];

/** Sort as `field` or `-field` (descending). */
export const TruckPnlSortSchema = z
  .string()
  .regex(/^-?[a-zA-Z]+$/)
  .refine((s) => (TRUCK_PNL_SORT_FIELDS as readonly string[]).includes(s.replace(/^-/, '')), {
    message: 'unknown sort field',
  });

/** Query of `GET /dashboard/truck-pnl`: period fields plus server-side filters (docs/DASHBOARD.md §6). */
export const TruckPnlQuerySchema = withPeriodRules(
  z.object({
    ...PeriodQueryShape,
    q: z.string().trim().max(100).optional(),
    payType: OpsNetPayTypeSchema.optional(),
    status: TruckStatusSchema.optional(),
    unit: z.string().trim().max(50).optional(),
    view: TruckPnlViewSchema.default('all'),
    sort: TruckPnlSortSchema.default('-profit'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  }),
);
export type TruckPnlQuery = z.infer<typeof TruckPnlQuerySchema>;
export type TruckPnlQueryInput = z.input<typeof TruckPnlQuerySchema>;

const money = z.number().nullable();

export const TruckPnlRowSchema = z.object({
  truckId: z.string().min(1),
  unitNumber: z.string(),
  status: TruckStatusSchema,
  driverId: z.string().nullable(),
  driverName: z.string().nullable(),
  payType: OpsNetPayTypeSchema,
  gross: money,
  miles: z.number().nullable(),
  loads: z.number().int().nonnegative(),
  cost: money,
  costEstimated: money,
  profit: money,
  /** `gross === 0 && cost > 0`; never true when cost is null. */
  inactiveLoss: z.boolean(),
});
export type TruckPnlRow = z.infer<typeof TruckPnlRowSchema>;

export const TruckPnlTotalsSchema = z.object({
  trucks: z.number().int().nonnegative(),
  gross: money,
  miles: z.number().nullable(),
  loads: z.number().int().nonnegative(),
  cost: money,
  costEstimated: money,
  profit: money,
  inactiveLoss: money,
  inactiveTrucks: z.number().int().nonnegative(),
});
export type TruckPnlTotals = z.infer<typeof TruckPnlTotalsSchema>;

export const PageInfoSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().nonnegative(),
});
export type PageInfo = z.infer<typeof PageInfoSchema>;

/** Response of `GET /dashboard/truck-pnl`. */
export const DashboardTruckPnlSchema = z.object({
  meta: DashboardMetaSchema,
  rows: z.array(TruckPnlRowSchema),
  totals: TruckPnlTotalsSchema,
  page: PageInfoSchema,
  masked: z.boolean(),
});
export type DashboardTruckPnl = z.infer<typeof DashboardTruckPnlSchema>;
