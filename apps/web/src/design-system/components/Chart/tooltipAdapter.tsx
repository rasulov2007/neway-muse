import type { ReactNode } from 'react';
import { ChartTooltip, type ChartTooltipRow } from './ChartTooltip';
import { formatChartValue } from './chartTheme';
import type { ValueFormatter } from './types';

/** The shape Recharts hands to a custom `Tooltip content`. Typed loosely so wrappers stay thin. */
export interface RechartsTooltipEntry {
  name?: string | number;
  value?: unknown;
  color?: string;
  fill?: string;
  stroke?: string;
  dataKey?: unknown;
  payload?: unknown;
}

export interface RechartsTooltipContentProps {
  active?: boolean;
  label?: ReactNode;
  payload?: ReadonlyArray<RechartsTooltipEntry>;
}

export interface TooltipAdapterOptions {
  valueFormatter?: ValueFormatter;
  labelFormatter?: (label: ReactNode) => ReactNode;
  /** Resolve the swatch color for an entry (defaults to its stroke/fill). */
  colorOf?: (entry: RechartsTooltipEntry) => string | undefined;
  /** Hide the label line (single-value charts like donuts). */
  hideLabel?: boolean;
}

/** Adapter for Recharts' `<Tooltip content={...} />`. */
export function renderChartTooltip(options: TooltipAdapterOptions = {}) {
  return function ChartTooltipContent({ active, label, payload }: RechartsTooltipContentProps) {
    if (!active || !payload || payload.length === 0) return null;
    const rows: ChartTooltipRow[] = payload.map((entry) => ({
      name: entry.name ?? '',
      value:
        typeof entry.value === 'number' && options.valueFormatter
          ? options.valueFormatter(entry.value)
          : formatChartValue(entry.value),
      color: options.colorOf?.(entry) ?? entry.color ?? entry.stroke ?? entry.fill,
    }));
    const shownLabel = options.hideLabel
      ? undefined
      : options.labelFormatter
        ? options.labelFormatter(label)
        : label;
    return <ChartTooltip label={shownLabel} rows={rows} />;
  };
}
