import { z } from 'zod';

/** Machine-readable reasons a metric value is `null` (docs/DASHBOARD.md §4, honesty rule). */
export const METRIC_NULL_REASONS = [
  'no_expense_data',
  'no_mileage_data',
  'zero_miles',
  'zero_gross',
  'no_active_trucks',
  'no_previous_value',
  'previous_zero',
  'masked',
  'unavailable',
] as const;
export type MetricNullReason = (typeof METRIC_NULL_REASONS)[number];

const MetricShape = {
  /** Current-period value; `null` renders as a dash with `reasons`. 0 is a real zero. */
  value: z.number().nullable(),
  /** Value over the comparison period computed with identical rules. */
  previous: z.number().nullable(),
  /** `value - previous`; null when either side is null. */
  delta: z.number().nullable(),
  /** `delta / |previous| * 100`; null when either side is null or previous is 0. */
  deltaPct: z.number().nullable(),
  /** Why `value` is null (or partially unreliable). Empty when the value is real. */
  reasons: z.array(z.string()),
  /** Portion of `value` that is an estimate (e.g. driver-pay estimates). */
  estimated: z.object({ amount: z.number() }).optional(),
  /** True when the principal lacks financial visibility; all numbers are null. */
  masked: z.boolean(),
};

/** Money amount in dollars, rounded to cents. */
export const MoneyMetricSchema = z.object(MetricShape);
export type MoneyMetric = z.infer<typeof MoneyMetricSchema>;

/** Unit-less or ratio metric (miles, RPM, percentage, counts). */
export const NumberMetricSchema = z.object(MetricShape);
export type NumberMetric = z.infer<typeof NumberMetricSchema>;

/** A metric whose value is unavailable for `reason`. */
export function nullMetric(reason: MetricNullReason | (string & {})): MoneyMetric {
  return {
    value: null,
    previous: null,
    delta: null,
    deltaPct: null,
    reasons: [reason],
    masked: false,
  };
}

/** A metric hidden by financial masking (docs/DASHBOARD.md §10). */
export function maskedMetric(): MoneyMetric {
  return {
    value: null,
    previous: null,
    delta: null,
    deltaPct: null,
    reasons: ['masked'],
    masked: true,
  };
}
