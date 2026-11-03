import type { ReactNode } from 'react';

/** One row of chart data; the x key and every series key are read from it. */
export type ChartDatum = Record<string, unknown>;

export interface ChartSeries {
  key: string;
  label: string;
  /** Defaults to `var(--chart-series-N)` by position. Status charts pass `chartTheme.status.*`. */
  color?: string;
}

export interface ChartTableColumn {
  key: string;
  label: ReactNode;
  align?: 'left' | 'right';
}

export interface ChartTableView {
  columns: ChartTableColumn[];
  rows: Record<string, ReactNode>[];
}

export type ValueFormatter = (value: number) => string;
export type XFormatter = (value: string | number) => string;
