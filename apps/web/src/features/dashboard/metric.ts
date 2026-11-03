/**
 * Presentation helpers for API metrics (docs/DASHBOARD.md §4 honesty rule, §10 masking).
 * No business math here: values, deltas and totals come from the API as-is.
 */
import type { MoneyMetric } from '@neway/shared';
import type { KpiDelta } from '@/design-system';
import { formatMoney, formatNumber, formatPercent, formatRpm } from '@/lib/format';

export const MASK = '••••••';
export const DASH = '—';

export type MetricKind =
  | 'money'
  | 'moneyCompact'
  /** Whole dollars, grouped: `$2,158,400`. For headline figures where cents are noise. */
  | 'moneyWhole'
  | 'number'
  | 'rate'
  | 'percent'
  | 'miles';

/** Human labels for the machine-readable null reasons (`METRIC_NULL_REASONS`). */
export const REASON_LABELS: Record<string, string> = {
  no_expense_data: 'No expense data for this period',
  no_mileage_data: 'No mileage data for this period',
  zero_miles: 'No miles recorded',
  zero_gross: 'No revenue in this period',
  no_active_trucks: 'No active trucks in this period',
  no_previous_value: 'No value for the comparison period',
  previous_zero: 'Comparison period is zero',
  masked: 'Hidden by your financial visibility',
  unavailable: 'Not available',
};

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason.replace(/_/g, ' ');
}

export function reasonsText(reasons: readonly string[]): string | undefined {
  if (reasons.length === 0) return undefined;
  return reasons.map(reasonLabel).join(' · ');
}

/** Formats a raw API number for display by kind. */
export function formatKind(value: number, kind: MetricKind): string {
  switch (kind) {
    case 'money':
      return formatMoney(value);
    case 'moneyCompact':
      return formatMoney(value, { compact: true });
    case 'moneyWhole':
      return `$${formatNumber(Math.round(value))}`;
    case 'rate':
      return formatRpm(value);
    case 'percent':
      return formatPercent(value, { signed: false });
    case 'miles':
      return `${formatNumber(Math.round(value))} mi`;
    case 'number':
    default:
      return formatNumber(value);
  }
}

export interface ValueOptions {
  /** True when the field is hidden by financial masking; renders "••••••". */
  masked?: boolean;
}

/**
 * `null` → "—", masked → "••••••", a number → formatted. Used by every table cell so the honesty
 * rule is applied in exactly one place.
 */
export function formatValue(
  value: number | null | undefined,
  kind: MetricKind,
  options: ValueOptions = {},
): string {
  if (options.masked) return MASK;
  if (value === null || value === undefined) return DASH;
  return formatKind(value, kind);
}

/** The KpiCard value text for a metric. */
export function metricText(metric: MoneyMetric, kind: MetricKind): string {
  if (metric.masked) return MASK;
  if (metric.value === null) return DASH;
  return formatKind(metric.value, kind);
}

/** KpiCard delta from the API's `deltaPct`; omitted when the API could not compute one. */
export function metricDelta(
  metric: MoneyMetric,
  positiveIsGood = true,
  label = 'vs previous period',
): KpiDelta | undefined {
  if (metric.masked || metric.deltaPct === null) return undefined;
  return { value: metric.deltaPct, label, positiveIsGood };
}

/**
 * The absolute change (`metric.delta`, computed by the API) formatted for a KpiCard, unsigned:
 * `"$76,786.00"`, `"0.68"`, `"5,460"`. Money keeps its symbol; rates, percentages, miles and
 * counts drop the unit because the card's value directly above already carries it.
 */
export function metricDeltaText(metric: MoneyMetric, kind: MetricKind): string | undefined {
  if (metric.masked || metric.delta === null) return undefined;
  const change = Math.abs(metric.delta);
  switch (kind) {
    case 'money':
    case 'moneyCompact':
    case 'moneyWhole':
      return formatMoney(change);
    case 'rate':
      return formatNumber(change, 2);
    case 'percent':
      return formatNumber(change, 1);
    case 'miles':
    case 'number':
    default:
      return formatNumber(Math.round(change));
  }
}

/** Tooltip/title text explaining a null value. */
export function metricTitle(metric: MoneyMetric): string | undefined {
  if (metric.masked) return REASON_LABELS.masked;
  if (metric.value !== null) return undefined;
  return reasonsText(metric.reasons) ?? REASON_LABELS.unavailable;
}

/** "estimated $1,200" sub-label when part of the value is an estimate. */
export function estimatedLabel(metric: MoneyMetric): string | undefined {
  if (!metric.estimated || metric.masked) return undefined;
  return `estimated ${formatMoney(metric.estimated.amount, { compact: true })}`;
}
