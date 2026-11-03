import { Skeleton } from '@/design-system';

/** Shown while a route's loader or lazy chunk is pending: a thin top progress bar and a page skeleton. */
export function RoutePending() {
  return (
    <div role="status" aria-label="Loading page" className="flex flex-col gap-(--section-gap)">
      <div aria-hidden className="fixed inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-primary-soft">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-3 w-80" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-line bg-surface p-(--card-padding) shadow-xs"
          >
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-6 w-20" />
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-line bg-surface p-(--card-padding) shadow-xs">
        <Skeleton variant="text" lines={5} />
      </div>
    </div>
  );
}
