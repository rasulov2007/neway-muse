import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { StatusTone } from '../../status';

export interface SectionCardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** 16px Lucide icon shown in a tinted tile before the title. */
  icon?: ReactNode;
  tone?: StatusTone | 'primary';
  title: ReactNode;
  description?: ReactNode;
  /** Controls on the trailing edge of the header (buttons, segmented filters, a pill). */
  actions?: ReactNode;
  /** Renders a rule between the header and the body. Default on. */
  divider?: boolean;
  padding?: 'none' | 'sm' | 'md';
  footer?: ReactNode;
  children?: ReactNode;
}

const TILE: Record<NonNullable<SectionCardProps['tone']>, string> = {
  primary: 'bg-nw-accent-tint text-nw-accent-ink',
  info: 'bg-nw-moving-bg text-nw-moving-text',
  success: 'bg-nw-done-bg text-nw-done-text',
  warning: 'bg-nw-warning-bg text-nw-warning-text',
  danger: 'bg-nw-urgent-bg text-nw-urgent-text',
  neutral: 'bg-nw-neutral-bg text-nw-neutral-text',
  violet: 'bg-nw-moving-bg text-nw-moving-text',
};

const PADDING = { none: '', sm: 'p-4', md: 'p-5' } as const;

/**
 * A titled block on a detail or overview page: icon tile, title, one-line description, and the
 * controls that belong to that block on the right. The same header on every card is what lets a
 * page of six cards read as one system.
 */
export function SectionCard({
  icon,
  tone = 'primary',
  title,
  description,
  actions,
  divider = true,
  padding = 'md',
  footer,
  className,
  children,
  ...rest
}: SectionCardProps) {
  return (
    <section
      className={cn(
        // Clipped to its own corners: a scrolling list inside a card used to paint over the
        // rounded edge and past the bottom border, so the last row sat outside the panel. Menus,
        // dropdowns and popovers are portalled out of the card, so nothing that should escape is
        // caught by this.
        'flex flex-col overflow-hidden rounded-lg border border-nw-border bg-nw-panel',
        className,
      )}
      {...rest}
    >
      <header
        className={cn(
          'flex min-h-12 flex-wrap items-center justify-between gap-3 px-4 py-3',
          divider && 'border-b border-nw-border',
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          {icon ? (
            <span
              aria-hidden
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-lg [&_svg]:size-5',
                TILE[tone],
              )}
            >
              {icon}
            </span>
          ) : null}
          <div className="min-w-0">
            <h3 className="text-md font-bold text-nw-text">{title}</h3>
            {description ? <p className="text-xs text-nw-text-3">{description}</p> : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children !== undefined && children !== null ? (
        <div className={cn('min-w-0 flex-1', PADDING[padding])}>{children}</div>
      ) : null}
      {footer ? (
        <footer className="border-t border-nw-border px-4 py-3 text-xs text-nw-text-3">{footer}</footer>
      ) : null}
    </section>
  );
}
