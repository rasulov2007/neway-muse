import { z } from 'zod';
import { DashboardMetaSchema } from './meta.js';

export const DATA_HEALTH_CHECK_KEYS = [
  'revenue_reconciliation',
  'expense_completeness',
  'unknown_pay_types',
  'missing_truck_assignments',
  'missing_driver_assignments',
  'missing_fuel_data',
] as const;
export const DataHealthCheckKeySchema = z.enum(DATA_HEALTH_CHECK_KEYS);
export type DataHealthCheckKey = z.infer<typeof DataHealthCheckKeySchema>;

export const DataHealthStatusSchema = z.enum(['ok', 'warning', 'error']);
export type DataHealthStatus = z.infer<typeof DataHealthStatusSchema>;

export const DataHealthCheckSchema = z.object({
  key: DataHealthCheckKeySchema,
  status: DataHealthStatusSchema,
  title: z.string().min(1),
  detail: z.string(),
  count: z.number().int().nonnegative().optional(),
  amount: z.number().nullable().optional(),
  /** Link to the owning module's investigation view. */
  href: z.string().optional(),
});
export type DataHealthCheck = z.infer<typeof DataHealthCheckSchema>;

/** Response of `GET /dashboard/data-health` (docs/DASHBOARD.md §9). */
export const DashboardDataHealthSchema = z.object({
  meta: DashboardMetaSchema,
  checks: z.array(DataHealthCheckSchema),
  summary: z.object({
    ok: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
  }),
});
export type DashboardDataHealth = z.infer<typeof DashboardDataHealthSchema>;
