import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'text' | 'block' | 'circle';
  /** For `text`: number of lines. */
  lines?: number;
}

/** Neutral placeholder matching the final layout. Never a spinner replacing a page. */
export function Skeleton({ variant = 'block', lines = 1, className, ...rest }: SkeletonProps) {
  if (variant === 'text') {
    return (
      <div className={cn('flex flex-col gap-2', className)} aria-hidden {...rest}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={cn(
              'h-3 animate-pulse rounded-sm bg-nw-subtle',
              i === lines - 1 && lines > 1 ? 'w-2/3' : 'w-full',
            )}
          />
        ))}
      </div>
    );
  }
  return (
    <div
      aria-hidden
      className={cn(
        'animate-pulse bg-nw-subtle',
        variant === 'circle' ? 'rounded-full' : 'rounded-md',
        className,
      )}
      {...rest}
    />
  );
}

export function KpiSkeleton() {
  return (
    <div className="rounded-xl border border-nw-border bg-nw-panel p-(--card-padding) shadow-card">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-6 w-20" />
      <Skeleton className="mt-2 h-3 w-28" />
    </div>
  );
}

export function CardSkeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="rounded-lg border border-nw-border bg-nw-panel p-(--card-padding)">
      <Skeleton className="h-4 w-40" />
      <Skeleton variant="text" lines={lines} className="mt-4" />
    </div>
  );
}

export function TableSkeleton({ rows = 8, columns = 6 }: { rows?: number; columns?: number }) {
  return (
    <div role="status" aria-label="Loading" className="w-full">
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex h-(--table-row-height) items-center gap-4 border-b border-nw-border px-2.5"
        >
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton
              key={c}
              className={cn('h-3', c === 0 ? 'w-24' : c === columns - 1 ? 'w-12' : 'w-full')}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
