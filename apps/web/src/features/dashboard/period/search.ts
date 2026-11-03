import { DashboardPeriodPresetSchema, IsoDateSchema } from '@neway/shared';
import { z } from 'zod';
import { DEMO_ROLES } from '@/lib/dashboard-api';

/**
 * `/dashboard?period=&from=&to=&role=` — the period selection and the demo principal live in
 * the URL so a view can be shared and reloaded (docs/DASHBOARD.md §13).
 */
export const dashboardSearchSchema = z.object({
  period: DashboardPeriodPresetSchema.optional(),
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  role: z.enum(DEMO_ROLES).optional(),
});

export type DashboardSearch = z.infer<typeof dashboardSearchSchema>;

/** Lenient parse: an unknown or malformed search falls back to the defaults instead of a crash. */
export function parseDashboardSearch(search: unknown): DashboardSearch {
  const parsed = dashboardSearchSchema.safeParse(search);
  return parsed.success ? parsed.data : {};
}
