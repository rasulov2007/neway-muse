import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, EmptyState, cn } from '@/design-system';
import { RouterLink } from './RouterLink';
import { viewAllClass } from './links';

interface ListCardProps {
  title: ReactNode;
  /** Small count next to the title (rows in the full list). */
  count?: number;
  description?: ReactNode;
  viewAllHref: string;
  viewAllLabel?: string;
  empty: { icon?: ReactNode; title: ReactNode; description?: ReactNode };
  /** Row nodes; the card renders dividers between them. */
  rows: ReactNode[];
  className?: string;
}

/** Card with a compact divided list (≤ 5–8 rows), a designed empty state and a "View all" footer. */
export function ListCard({
  title,
  count,
  description,
  viewAllHref,
  viewAllLabel = 'View all',
  empty,
  rows,
  className,
}: ListCardProps) {
  return (
    <Card
      padding="none"
      className={cn('min-w-0', className)}
      title={
        <span className="inline-flex items-center gap-2">
          {title}
          {count !== undefined ? (
            <span className="tabular text-xs font-normal text-muted">{count}</span>
          ) : null}
        </span>
      }
      description={description}
      footer={
        <RouterLink to={viewAllHref} className={viewAllClass}>
          {viewAllLabel}
          <ArrowRight aria-hidden className="size-3.5" />
        </RouterLink>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={empty.icon}
          title={empty.title}
          description={empty.description}
        />
      ) : (
        <ul className="flex flex-col divide-y divide-line-soft">
          {rows.map((row, i) => (
            <li key={i} className="px-(--card-padding) py-2.5">
              {row}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
