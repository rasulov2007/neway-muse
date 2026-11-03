import { z } from 'zod';
import { DashboardMetaSchema } from './meta.js';
import { PeriodQueryShape, withPeriodRules } from './period.js';
import { PageInfoSchema } from './truck-pnl.js';

export const DRILLDOWN_METRICS = [
  'gross',
  'cost',
  'fuel',
  'maintenance',
  'driver_pay',
  'inactive_loss',
] as const;
export const DrilldownMetricSchema = z.enum(DRILLDOWN_METRICS);
export type DrilldownMetric = z.infer<typeof DrilldownMetricSchema>;

/** Query of `GET /dashboard/drilldown` (docs/DASHBOARD.md §12). */
export const DrilldownQuerySchema = withPeriodRules(
  z.object({
    metric: DrilldownMetricSchema,
    ...PeriodQueryShape,
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  }),
);
export type DrilldownQuery = z.infer<typeof DrilldownQuerySchema>;
export type DrilldownQueryInput = z.input<typeof DrilldownQuerySchema>;

export const DrilldownColumnKindSchema = z.enum(['text', 'money', 'number', 'date', 'status']);
export type DrilldownColumnKind = z.infer<typeof DrilldownColumnKindSchema>;

export const DrilldownColumnSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  kind: DrilldownColumnKindSchema,
});
export type DrilldownColumn = z.infer<typeof DrilldownColumnSchema>;

export const DrilldownRowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
export type DrilldownRow = z.infer<typeof DrilldownRowSchema>;

/** Contributing records behind a headline number; `total` equals that number. */
export const DashboardDrilldownSchema = z.object({
  meta: DashboardMetaSchema,
  metric: DrilldownMetricSchema,
  title: z.string().min(1),
  total: z.number().nullable(),
  columns: z.array(DrilldownColumnSchema),
  rows: z.array(DrilldownRowSchema),
  page: PageInfoSchema,
});
export type DashboardDrilldown = z.infer<typeof DashboardDrilldownSchema>;
