import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface ChartLegendItem {
  label: ReactNode;
  color: string;
}

export interface ChartLegendProps extends HTMLAttributes<HTMLUListElement> {
  items: ChartLegendItem[];
}

/**
 * Text in text tokens, identity carried by an 8px colored square beside it (never colored text).
 * Items lift to ink on hover (100 ms) so the legend reads as part of the same surface as the plot.
 */
export function ChartLegend({ items, className, ...rest }: ChartLegendProps) {
  return (
    <ul
      aria-label="Legend"
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-secondary',
        className,
      )}
      {...rest}
    >
      {items.map((item, i) => (
        <li
          key={i}
          className="flex items-center gap-1.5 transition-colors duration-(--duration-fast) hover:text-ink"
        >
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-xs"
            style={{ background: item.color }}
          />
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
