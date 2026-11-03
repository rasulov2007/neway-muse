import type { ReactNode } from 'react';
import { cn } from '@/design-system';
import { barWidth } from './view-model';

export interface RankedItem {
  key: string;
  label: ReactNode;
  /** The value that sets the bar's length. */
  value: number;
  /** The value as written; always shown beside the bar. */
  display: string;
  secondary?: ReactNode;
}

/**
 * A ranked list with a bar per row. The bar is a scale against the largest row; the figure itself
 * is always printed, because a bar alone is not a number.
 */
export function RankedList({
  items,
  label,
  max,
  barClassName = 'bg-an-accent',
}: {
  items: RankedItem[];
  label: string;
  /** Scale for the bars; defaults to the largest value in the list. */
  max?: number;
  barClassName?: string;
}) {
  const scale = max ?? Math.max(...items.map((item) => item.value), 0);
  return (
    <ol aria-label={label} className="flex flex-col gap-3">
      {items.map((item, index) => (
        <li key={item.key} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="w-5 shrink-0 text-xs font-semibold text-nw-text-3 tabular-nums">
                {index + 1}
              </span>
              <span className="truncate font-medium text-nw-text">{item.label}</span>
            </span>
            <span className="flex shrink-0 items-baseline gap-2">
              {item.secondary ? (
                <span className="text-xs text-nw-text-3 tabular-nums">{item.secondary}</span>
              ) : null}
              <span className="font-semibold text-nw-text tabular-nums">{item.display}</span>
            </span>
          </div>
          <span aria-hidden className="ml-7 block h-2 overflow-hidden rounded-full bg-an-track">
            <span
              className={cn('block h-full rounded-full', barClassName)}
              style={{ width: `${barWidth(item.value, scale)}%` }}
            />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Loaded against empty miles as one split bar, with both figures printed. */
export function SplitBar({
  loaded,
  empty,
  format,
}: {
  loaded: number;
  empty: number;
  format: (value: number) => string;
}) {
  const total = loaded + empty;
  const loadedShare = total > 0 ? (loaded / total) * 100 : 0;
  return (
    <div className="flex flex-col gap-3">
      <div
        role="img"
        aria-label={`Loaded miles ${format(loaded)}, empty miles ${format(empty)}`}
        className="flex h-4 overflow-hidden rounded-full bg-an-track"
      >
        {total > 0 ? (
          <>
            <span className="h-full bg-an-gross" style={{ width: `${loadedShare}%` }} />
            <span className="h-full bg-an-cost" style={{ width: `${100 - loadedShare}%` }} />
          </>
        ) : null}
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-2.5 rounded-[3px] bg-an-gross" />
          <dt className="text-nw-text-2">Loaded</dt>
          <dd className="font-semibold text-nw-text tabular-nums">{format(loaded)}</dd>
        </div>
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-2.5 rounded-[3px] bg-an-cost" />
          <dt className="text-nw-text-2">Empty</dt>
          <dd className="font-semibold text-nw-text tabular-nums">{format(empty)}</dd>
        </div>
      </dl>
    </div>
  );
}
