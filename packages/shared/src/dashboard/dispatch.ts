import { z } from 'zod';
import { DashboardMetaSchema } from './meta.js';
import { IsoDateSchema } from './period.js';

const money = z.number().nullable();

/** Count of trucks per weekly RPM band (docs/DASHBOARD.md §8). */
export const RpmBucketsSchema = z.object({
  lt150: z.number().int().nonnegative(),
  b150to200: z.number().int().nonnegative(),
  b200to250: z.number().int().nonnegative(),
  gte250: z.number().int().nonnegative(),
});
export type RpmBuckets = z.infer<typeof RpmBucketsSchema>;

export const DispatchWeekSchema = z.object({
  weekStart: IsoDateSchema,
  label: z.string().min(1),
  isComplete: z.boolean(),
});
export type DispatchWeek = z.infer<typeof DispatchWeekSchema>;

export const DispatchTeamSchema = z.object({
  teamId: z.string().min(1),
  teamName: z.string(),
  gross: money,
  loads: z.number().int().nonnegative(),
  activeTrucks: z.number().int().nonnegative(),
  activeDaysPct: z.number().nullable(),
  rpm: money,
  grossPerTruck: money,
  /** Actual gross for complete weeks; `gross / elapsedDays * 7` for the current week. */
  estimatedFullWeekGross: z.object({
    value: money,
    estimated: z.boolean(),
  }),
  rpmBuckets: RpmBucketsSchema,
  byWeek: z.array(
    z.object({
      weekStart: IsoDateSchema,
      gross: money,
      estimated: z.boolean(),
    }),
  ),
  /** Sum of actual weekly gross; never includes estimates. */
  total: money,
});
export type DispatchTeam = z.infer<typeof DispatchTeamSchema>;

/** Response of `GET /dashboard/dispatch-performance`. */
export const DashboardDispatchSchema = z.object({
  meta: DashboardMetaSchema,
  weeks: z.array(DispatchWeekSchema),
  teams: z.array(DispatchTeamSchema),
  rpmBucketsTotal: RpmBucketsSchema,
  masked: z.boolean(),
});
export type DashboardDispatch = z.infer<typeof DashboardDispatchSchema>;
