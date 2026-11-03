import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  /** A <BackButton /> rendered above the title. Detail and form pages only. */
  back?: ReactNode;
  /** Right-aligned actions (at most one primary button). */
  actions?: ReactNode;
  /** A <Tabs /> strip rendered below the header row; adds the bottom border. */
  tabs?: ReactNode;
  /** Badges / metadata rendered next to the title. */
  meta?: ReactNode;
}

/** Back action, title, description and actions; optional tab strip below. */
export function PageHeader({
  title,
  description,
  back,
  actions,
  tabs,
  meta,
  className,
  ...rest
}: PageHeaderProps) {
  return (
    <header
      className={cn('flex flex-col gap-3', tabs ? 'border-b border-nw-border-strong' : undefined, className)}
      {...rest}
    >
      {back ? <div className="flex w-fit">{back}</div> : null}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-bold tracking-[-0.015em] text-nw-text">{title}</h1>
            {meta ? <div className="flex min-w-0 flex-wrap items-center gap-1.5">{meta}</div> : null}
          </div>
          {description ? <p className="mt-0.5 text-xs text-nw-text-3">{description}</p> : null}
        </div>
        {actions ? <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {tabs ? <div className="-mb-px mt-1">{tabs}</div> : null}
    </header>
  );
}
