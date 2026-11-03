import { formatDistanceToNowStrict } from 'date-fns';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Avatar } from '../Avatar';
import type { BreadcrumbLinkComponent } from '../Breadcrumb';

export interface ActivityItem {
  id: string;
  actor: { name: string; avatarUrl?: string };
  /** Verb phrase, e.g. "assigned Unit 2785 to". */
  action: ReactNode;
  target?: { label: ReactNode; href?: string };
  at: Date | string;
}

export interface ActivityFeedProps extends HTMLAttributes<HTMLOListElement> {
  items: ActivityItem[];
  /** Router link for targets with an href (defaults to a plain anchor). */
  linkComponent?: BreadcrumbLinkComponent;
  /** Relative time label; defaults to date-fns "3 minutes ago". */
  formatRelative?: (date: Date) => string;
  emptyMessage?: ReactNode;
}

const defaultRelative = (d: Date) => formatDistanceToNowStrict(d, { addSuffix: true });

const targetClass = 'font-semibold text-nw-accent-ink hover:underline underline-offset-2';

/** Compact rows: avatar, "Sarah Chen assigned Unit 2785 to Load L-100245", relative time. */
export function ActivityFeed({
  items,
  linkComponent: Link,
  formatRelative = defaultRelative,
  emptyMessage = 'No recent activity',
  className,
  ...rest
}: ActivityFeedProps) {
  if (items.length === 0) {
    return <p className={cn('py-3 text-sm text-nw-text-3', className)}>{emptyMessage}</p>;
  }
  return (
    <ol className={cn('flex flex-col', className)} {...rest}>
      {items.map((item) => {
        const date = item.at instanceof Date ? item.at : new Date(item.at);
        const iso = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
        const target = item.target;
        return (
          <li key={item.id} className="flex items-start gap-2.5 py-2">
            <Avatar name={item.actor.name} src={item.actor.avatarUrl} size="sm" className="mt-px" />
            <p className="min-w-0 flex-1 text-sm text-nw-text-2">
              <span className="font-semibold text-nw-text">{item.actor.name}</span> {item.action}
              {target ? (
                <>
                  {' '}
                  {target.href && Link ? (
                    <Link to={target.href} className={targetClass}>
                      {target.label}
                    </Link>
                  ) : target.href ? (
                    <a href={target.href} className={targetClass}>
                      {target.label}
                    </a>
                  ) : (
                    <span className="font-semibold text-nw-text">{target.label}</span>
                  )}
                </>
              ) : null}
            </p>
            {iso ? (
              <time
                dateTime={iso}
                title={iso}
                className="tabular shrink-0 text-xs whitespace-nowrap text-nw-text-3"
              >
                {formatRelative(date)}
              </time>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
