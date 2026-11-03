import { Inbox } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  size?: 'sm' | 'md';
}

/** Designed empty state: icon, one-line title, one-line explanation, an action when creation is possible. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  size = 'md',
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'md' ? 'px-6 py-12' : 'px-4 py-8',
        className,
      )}
      {...rest}
    >
      <div
        aria-hidden
        className={cn(
          'flex items-center justify-center rounded-md bg-nw-subtle text-nw-text-3',
          size === 'md' ? 'size-10 [&_svg]:size-5' : 'size-8 [&_svg]:size-4',
        )}
      >
        {icon ?? <Inbox />}
      </div>
      <h3 className={cn('mt-3 font-bold text-nw-text', size === 'md' ? 'text-md' : 'text-sm')}>
        {title}
      </h3>
      {description ? <p className="mt-1 max-w-sm text-xs text-nw-text-3">{description}</p> : null}
      {action || secondaryAction ? (
        <div className="mt-4 flex items-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
