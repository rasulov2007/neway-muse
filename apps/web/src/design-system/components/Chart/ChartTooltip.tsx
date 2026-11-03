import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { chartTheme } from './chartTheme';

export interface ChartTooltipRow {
  name: ReactNode;
  value: ReactNode;
  color?: string;
}

export interface ChartTooltipProps {
  label?: ReactNode;
  rows: ChartTooltipRow[];
  className?: string;
}

/** Token-styled readout: value leads (ink, tabular), the series name follows, a square key. */
export function ChartTooltip({ label, rows, className }: ChartTooltipProps) {
  return (
    <div className={cn(chartTheme.tooltip.className, className)} role="presentation">
      {label !== undefined && label !== null && label !== '' ? (
        <div className="mb-1 font-medium text-ink">{label}</div>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {rows.map((row, i) => (
          <li key={i} className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-xs"
              style={{ background: row.color ?? chartTheme.other }}
            />
            <span className="min-w-0 flex-1 truncate text-muted">{row.name}</span>
            <span className="tabular font-medium text-ink">{row.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
