import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '@/design-system';

export interface CompactColumn<T> {
  key: string;
  label: ReactNode;
  align?: 'left' | 'right';
  render: (row: T) => ReactNode;
  /** Value used for client-side sorting; presentation only (rows come sorted from the API). */
  sortValue?: (row: T) => number | string | null;
  className?: string;
}

export interface CompactTableProps<T> {
  columns: ReadonlyArray<CompactColumn<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T) => string;
  caption: string;
  /** Extra classes for a row (tint, emphasis). */
  rowClassName?: (row: T) => string | undefined;
  /** Rendered as the last row, bold, above a stronger border. */
  footer?: ReactNode[];
  /** Enables header sorting on columns with `sortValue`. */
  sortable?: boolean;
  defaultSort?: { key: string; direction: 'asc' | 'desc' };
  className?: string;
}

function compare(a: number | string | null, b: number | string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Dense `<table>` for short analytic lists (≤ ~12 rows) that need no toolbar or pagination:
 * 34px rows, uppercase 11px headers, right-aligned tabular numbers.
 */
export function CompactTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  rowClassName,
  footer,
  sortable = false,
  defaultSort,
  className,
}: CompactTableProps<T>) {
  const [sort, setSort] = useState(defaultSort);
  const sorted =
    sortable && sort
      ? [...rows].sort((a, b) => {
          const column = columns.find((c) => c.key === sort.key);
          if (!column?.sortValue) return 0;
          const result = compare(column.sortValue(a), column.sortValue(b));
          return sort.direction === 'asc' ? result : -result;
        })
      : rows;

  function toggle(key: string) {
    setSort((prev) =>
      prev?.key === key
        ? { key, direction: prev.direction === 'desc' ? 'asc' : 'desc' }
        : { key, direction: 'desc' },
    );
  }

  return (
    <div className={cn('scroll-quiet w-full overflow-x-auto', className)}>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="bg-surface-muted">
            {columns.map((column) => {
              const canSort = sortable && Boolean(column.sortValue);
              const active = sort?.key === column.key;
              const ariaSort = active
                ? sort?.direction === 'asc'
                  ? 'ascending'
                  : 'descending'
                : undefined;
              const label = (
                <span className="inline-flex items-center gap-1">
                  {column.label}
                  {canSort ? (
                    active ? (
                      sort?.direction === 'asc' ? (
                        <ArrowUp aria-hidden className="size-3" />
                      ) : (
                        <ArrowDown aria-hidden className="size-3" />
                      )
                    ) : (
                      <ChevronsUpDown aria-hidden className="size-3 opacity-50" />
                    )
                  ) : null}
                </span>
              );
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={ariaSort}
                  className={cn(
                    'h-9 border-b border-line px-3 text-xs font-semibold whitespace-nowrap text-secondary',
                    column.align === 'right' ? 'text-right' : 'text-left',
                    column.className,
                  )}
                >
                  {canSort ? (
                    <button
                      type="button"
                      onClick={() => toggle(column.key)}
                      className={cn(
                        'rounded-xs hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                        active && 'text-ink',
                      )}
                    >
                      {label}
                    </button>
                  ) : (
                    label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              className={cn('transition-colors hover:bg-surface-hover', rowClassName?.(row))}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    'h-(--table-row-height-dense) border-b border-line-soft px-3 whitespace-nowrap text-ink',
                    column.align === 'right' ? 'tabular text-right' : 'text-left',
                    column.className,
                  )}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
          {footer ? (
            <tr className="bg-surface-muted font-medium">
              {footer.map((cell, i) => (
                <td
                  key={columns[i]?.key ?? i}
                  className={cn(
                    'h-(--table-row-height-dense) border-t border-line px-3 whitespace-nowrap text-ink',
                    columns[i]?.align === 'right' ? 'tabular text-right' : 'text-left',
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
