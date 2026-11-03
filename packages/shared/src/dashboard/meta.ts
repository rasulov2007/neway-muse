import { z } from 'zod';
import { ResolvedPeriodSchema } from './period.js';

/** Origin of the facts a response was computed from. */
export const DashboardSourceSchema = z.enum(['demo', 'database']);
export type DashboardSource = z.infer<typeof DashboardSourceSchema>;

/** Present on every dashboard response so the UI can label demo data and show the period. */
export const DashboardMetaSchema = z.object({
  source: DashboardSourceSchema,
  generatedAt: z.iso.datetime(),
  period: ResolvedPeriodSchema,
});
export type DashboardMeta = z.infer<typeof DashboardMetaSchema>;
