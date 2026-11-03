import { z } from 'zod';

/** Period presets accepted by every dashboard endpoint (docs/DASHBOARD.md §3). */
export const DASHBOARD_PERIOD_PRESETS = [
  'today',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'custom',
] as const;

export const DashboardPeriodPresetSchema = z.enum(DASHBOARD_PERIOD_PRESETS);
export type DashboardPeriodPreset = z.infer<typeof DashboardPeriodPresetSchema>;

/** Company-local calendar day as `YYYY-MM-DD`. */
export const IsoDateSchema = z.iso.date();

/** Period fields shared by every dashboard query schema. */
export const PeriodQueryShape = {
  period: DashboardPeriodPresetSchema.default('this_week'),
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
};

interface PeriodQueryLike {
  period: DashboardPeriodPreset;
  from?: string | undefined;
  to?: string | undefined;
}

/** Adds the period rules (`custom` needs both dates; `from <= to`) to a query schema. */
export function withPeriodRules<T extends z.ZodType<PeriodQueryLike>>(schema: T): T {
  return schema
    .refine((q) => q.period !== 'custom' || (q.from !== undefined && q.to !== undefined), {
      message: 'custom period requires both from and to',
      path: ['period'],
    })
    .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
      message: 'from must be on or before to',
      path: ['from'],
    });
}

/** Query string shared by all dashboard endpoints. `custom` requires `from` and `to`. */
export const DashboardPeriodQuerySchema = withPeriodRules(z.object(PeriodQueryShape));

export type DashboardPeriodQuery = z.infer<typeof DashboardPeriodQuerySchema>;
/** Input shape of the query before defaults are applied. */
export type DashboardPeriodQueryInput = z.input<typeof DashboardPeriodQuerySchema>;

/** Inclusive company-local date range. */
export const DateRangeSchema = z.object({
  from: IsoDateSchema,
  to: IsoDateSchema,
});
export type DateRange = z.infer<typeof DateRangeSchema>;

/** Output of `ReportingPeriodService.resolve`; embedded in every response `meta`. */
export const ResolvedPeriodSchema = z.object({
  preset: DashboardPeriodPresetSchema,
  from: IsoDateSchema,
  to: IsoDateSchema,
  /** Human label, e.g. "Sep 1 - Sep 7, 2026", "Sep 2026", "Today · Sep 6". */
  label: z.string().min(1),
  /** True when the range ends before the company-local today. */
  isComplete: z.boolean(),
  /** IANA timezone the range was resolved in. */
  timezone: z.string().min(1),
  comparison: z.object({
    from: IsoDateSchema,
    to: IsoDateSchema,
    label: z.string().min(1),
  }),
  /** First day of the reporting week, 0 = Sunday ... 6 = Saturday. */
  weekStart: z.number().int().min(0).max(6),
});
export type ResolvedPeriod = z.infer<typeof ResolvedPeriodSchema>;
