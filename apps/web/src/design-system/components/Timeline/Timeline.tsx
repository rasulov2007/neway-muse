import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { toneFamily, type StatusFamily, type StatusTone } from '../../status';
import { StatusSymbol } from '../Badge/StatusSymbol';
import { formatTimelineTime, toDate } from './timelineUtils';

export interface TimelineItem {
  id: string;
  at: Date | string;
  title: ReactNode;
  description?: ReactNode;
  /** Picks the status family for the marker symbol; neutral by default. */
  tone?: StatusTone;
  /** Replaces the status symbol with a 16px icon in a 24px circle. */
  icon?: ReactNode;
  actor?: { name: string };
}

export interface TimelineProps extends HTMLAttributes<HTMLOListElement> {
  items: TimelineItem[];
  /** Tighter vertical rhythm for drawers and side panels. */
  dense?: boolean;
  /** Time label; defaults to "2:14 PM". */
  formatTime?: (date: Date) => string;
}

/* The marker is the family's status symbol (SPEC: never colour alone), drawn in the icon colour. */
const symbolTone: Record<StatusFamily, string> = {
  done: 'text-nw-done-icon',
  moving: 'text-nw-moving-icon',
  warning: 'text-nw-warning-icon',
  urgent: 'text-nw-urgent-icon',
  neutral: 'text-nw-neutral-icon',
};

const iconTone: Record<StatusFamily, string> = {
  done: 'border-nw-done-border bg-nw-done-bg text-nw-done-text',
  moving: 'border-nw-moving-border bg-nw-moving-bg text-nw-moving-text',
  warning: 'border-nw-warning-border bg-nw-warning-bg text-nw-warning-text',
  urgent: 'border-nw-urgent-border bg-nw-urgent-bg text-nw-urgent-text',
  neutral: 'border-nw-border bg-nw-panel text-nw-text-3',
};

/** Vertical list of events with a rail, a status symbol (or icon) per item, and the time on the right. */
export function Timeline({
  items,
  dense = false,
  formatTime = formatTimelineTime,
  className,
  ...rest
}: TimelineProps) {
  return (
    <ol className={cn('flex flex-col', className)} {...rest}>
      {items.map((item, i) => {
        const date = toDate(item.at);
        const iso = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
        const family = toneFamily(item.tone ?? 'neutral');
        const isLast = i === items.length - 1;
        return (
          <li
            key={item.id}
            className={cn('relative flex gap-3', isLast ? 'pb-0' : dense ? 'pb-3' : 'pb-5')}
          >
            {/* rail */}
            {!isLast ? (
              <span
                aria-hidden
                className="absolute top-6 bottom-0 left-3 w-px -translate-x-1/2 bg-nw-border"
              />
            ) : null}
            {/* marker */}
            <span className="relative flex h-5 w-6 shrink-0 items-center justify-center">
              {item.icon ? (
                <span
                  aria-hidden
                  className={cn(
                    'flex size-6 items-center justify-center rounded-full border [&_svg]:size-3.5',
                    iconTone[family],
                  )}
                >
                  {item.icon}
                </span>
              ) : (
                <span
                  aria-hidden
                  className={cn('flex items-center justify-center bg-nw-panel', symbolTone[family])}
                >
                  <StatusSymbol family={family} size={14} />
                </span>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 text-sm text-nw-text">{item.title}</div>
                {iso ? (
                  <time
                    dateTime={iso}
                    title={iso}
                    className="tabular shrink-0 text-xs whitespace-nowrap text-nw-text-3"
                  >
                    {formatTime(date)}
                  </time>
                ) : null}
              </div>
              {item.description ? (
                <div className="mt-0.5 text-xs text-nw-text-2">{item.description}</div>
              ) : null}
              {item.actor ? (
                <div className="mt-0.5 text-xs text-nw-text-3">by {item.actor.name}</div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
