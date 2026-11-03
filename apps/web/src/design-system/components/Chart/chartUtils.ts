import type { ChartDatum, ChartSeries, ChartTableView, ValueFormatter, XFormatter } from './types';
import { formatChartValue, humanizeKey } from './chartTheme';

/** Build the screen-reader / toggleable table twin of a cartesian chart. */
export function buildCartesianTable(
  data: ChartDatum[],
  xKey: string,
  series: ChartSeries[],
  options: { xLabel?: string; valueFormatter?: ValueFormatter; xFormatter?: XFormatter } = {},
): ChartTableView {
  const fmtValue = (v: unknown) =>
    typeof v === 'number' && options.valueFormatter
      ? options.valueFormatter(v)
      : formatChartValue(v);
  const fmtX = (v: unknown) =>
    (typeof v === 'string' || typeof v === 'number') && options.xFormatter
      ? options.xFormatter(v)
      : formatChartValue(v);
  return {
    columns: [
      { key: xKey, label: options.xLabel ?? humanizeKey(xKey), align: 'left' },
      ...series.map((s) => ({ key: s.key, label: s.label, align: 'right' as const })),
    ],
    rows: data.map((row) => {
      const out: Record<string, string> = { [xKey]: fmtX(row[xKey]) };
      for (const s of series) out[s.key] = fmtValue(row[s.key]);
      return out;
    }),
  };
}

export function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
