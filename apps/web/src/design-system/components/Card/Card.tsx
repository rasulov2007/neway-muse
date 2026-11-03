import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned header actions (buttons, menus). */
  actions?: ReactNode;
  padding?: 'none' | 'sm' | 'md';
  footer?: ReactNode;
  /** Hover affordance for clickable cards. */
  interactive?: boolean;
}

const paddings = { none: '', sm: 'p-3', md: 'p-(--card-padding)' } as const;

/** Panel: --nw-panel fill, 1px border, radius 10, no shadow. Header only renders when it has content. */
export function Card({
  title,
  description,
  actions,
  padding = 'md',
  footer,
  interactive = false,
  className,
  children,
  ...rest
}: CardProps) {
  const hasHeader = title || description || actions;
  return (
    <section
      className={cn(
        'flex flex-col rounded-lg border border-nw-border bg-nw-panel',
        interactive &&
          'cursor-pointer transition-colors duration-(--duration-base) hover:border-nw-border-strong hover:bg-nw-hover',
        className,
      )}
      {...rest}
    >
      {hasHeader ? (
        <header className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-nw-border px-4 py-3">
          <div className="min-w-0">
            {title ? <h3 className="text-md font-bold text-nw-text">{title}</h3> : null}
            {description ? <p className="mt-0.5 text-xs text-nw-text-3">{description}</p> : null}
          </div>
          {actions ? <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn('min-w-0 flex-1', paddings[padding])}>{children}</div>
      {footer ? (
        <footer className="border-t border-nw-border px-(--card-padding) py-2.5 text-xs text-nw-text-3">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}

/** Small uppercase label used above groups inside a card or a page section. */
export function SectionLabel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('eyebrow', className)} {...rest} />;
}
