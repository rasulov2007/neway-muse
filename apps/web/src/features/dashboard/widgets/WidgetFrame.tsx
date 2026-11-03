import { demoCompany } from '@/demo';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Badge, Card, CardSkeleton, EmptyState, ErrorState, cn } from '@/design-system';

export interface QueryBoundaryProps<T> {
  query: UseQueryResult<T>;
  /** Skeleton matching the final layout. */
  skeleton?: ReactNode;
  /** Human title for the error state ("Unable to load fuel analytics"). */
  errorTitle: string;
  isEmpty?: (data: T) => boolean;
  empty?: { title: ReactNode; description?: ReactNode; icon?: ReactNode };
  children: (data: T) => ReactNode;
  className?: string;
}

/**
 * Loading / error / empty / data states for one widget. A failed section renders its own
 * ErrorState with a retry and never blanks the rest of the page.
 */
export function QueryBoundary<T>({
  query,
  skeleton,
  errorTitle,
  isEmpty,
  empty,
  children,
  className,
}: QueryBoundaryProps<T>) {
  if (query.isPending) {
    return <div className={cn('min-w-0', className)}>{skeleton ?? <CardSkeleton lines={6} />}</div>;
  }
  if (query.isError) {
    return (
      <Card padding="none" className={cn('min-w-0', className)}>
        <ErrorState
          size="sm"
          title={errorTitle}
          description="This section could not be loaded. The rest of the dashboard is unaffected."
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      </Card>
    );
  }
  if (isEmpty?.(query.data)) {
    return (
      <Card padding="none" className={cn('min-w-0', className)}>
        <EmptyState
          size="sm"
          icon={empty?.icon}
          title={empty?.title ?? 'No data'}
          description={empty?.description ?? 'Nothing to show for this period.'}
        />
      </Card>
    );
  }
  return <>{children(query.data)}</>;
}

/** "Demo" label for widgets that still read the Phase 2 web demo API. */
export function DemoBadge({ className }: { className?: string }) {
  if (!demoCompany.demo) return null;
  return (
    <Badge tone="neutral" variant="outline" size="sm" className={className} title="Demo data">
      Demo
    </Badge>
  );
}

/** Eyebrow + optional trailing note above a dashboard section (docs/DASHBOARD.md §13). */
export function SectionHeading({
  id,
  label,
  note,
}: {
  id: string;
  label: string;
  note?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 id={id} className="eyebrow">
        {label}
      </h2>
      {note ? <div className="text-xs text-muted">{note}</div> : null}
    </div>
  );
}
