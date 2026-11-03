import { z } from 'zod';
import { DashboardMetaSchema } from './meta.js';
import { MoneyMetricSchema, NumberMetricSchema } from './metric.js';
import { OpsNetPayTypeSchema } from './ops-net.js';
import { IsoDateSchema } from './period.js';

const money = z.number().nullable();
const count = z.number().int().nonnegative().nullable();

/** One reporting week of the trailing-8-week trend. */
export const TrendWeekSchema = z.object({
  weekStart: IsoDateSchema,
  weekEnd: IsoDateSchema,
  label: z.string().min(1),
  /** True for the week(s) overlapping the selected period. */
  highlighted: z.boolean(),
  isComplete: z.boolean(),
  gross: money,
  cost: money,
  profit: money,
  rpm: money,
  cpm: money,
  ppm: money,
  marginPct: money,
  totalMiles: money,
  activeTrucks: count,
  inactiveTrucks: count,
  /** Active trucks split by the driver's pay type; `null` when driver attribution is unavailable. */
  activeByPayType: z.record(OpsNetPayTypeSchema, z.number().int().nonnegative()).nullable(),
  avgGrossPerTruck: money,
  avgCostPerTruck: money,
  avgProfitPerTruck: money,
  avgMilesPerTruck: money,
  hasExpenseData: z.boolean(),
});
export type TrendWeek = z.infer<typeof TrendWeekSchema>;

/**
 * The whole window rolled up, against the equivalent window immediately before it. This is what
 * the section's headline strip reads ("vs. previous 8 weeks") and what the per-metric delta column
 * compares; it is computed by the same engine as every other figure, never in the browser.
 */
export const TrendSummarySchema = z.object({
  window: z.object({ from: IsoDateSchema, to: IsoDateSchema, weeks: z.number().int().positive() }),
  previousWindow: z.object({
    from: IsoDateSchema,
    to: IsoDateSchema,
    weeks: z.number().int().nonnegative(),
  }),
  gross: MoneyMetricSchema,
  cost: MoneyMetricSchema,
  profit: MoneyMetricSchema,
  rpm: MoneyMetricSchema,
  cpm: MoneyMetricSchema,
  ppm: MoneyMetricSchema,
  marginPct: NumberMetricSchema,
  totalMiles: NumberMetricSchema,
  activeTrucks: NumberMetricSchema,
  /**
   * How much of the window actually has expense data. A window where some weeks carry revenue but
   * no costs still produces a cost and a profit — they are simply incomplete, and the rolled-up
   * margin reads better than any individual week. `weeksWithData < weeks` means the UI must say so
   * rather than present the rollup as a clean comparison.
   */
  expenseCoverage: z.object({
    weeks: z.number().int().nonnegative(),
    weeksWithData: z.number().int().nonnegative(),
  }),
});
export type TrendSummary = z.infer<typeof TrendSummarySchema>;

/** Response of `GET /dashboard/trends`. */
export const DashboardTrendsSchema = z.object({
  meta: DashboardMetaSchema,
  weeks: z.array(TrendWeekSchema),
  /** Absent only when the window has no weeks at all. */
  summary: TrendSummarySchema.nullable(),
  masked: z.boolean(),
});
export type DashboardTrends = z.infer<typeof DashboardTrendsSchema>;
