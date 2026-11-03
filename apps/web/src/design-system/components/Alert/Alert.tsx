import { X } from 'lucide-react';
import { useState, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { StatusSymbol, type StatusSymbolFamily } from '../Badge/StatusSymbol';

export type AlertTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: AlertTone;
  title?: ReactNode;
  description?: ReactNode;
  /** Buttons rendered under the text (use `link` / `secondary` sm buttons). */
  actions?: ReactNode;
  dismissible?: boolean;
  onDismiss?: () => void;
  /** Override the tone icon. */
  icon?: ReactNode;
}

/* Each tone is a Porcelain family: its bg / border / text plus the family symbol. */
const tones: Record<
  AlertTone,
  { box: string; icon: string; title: string; symbol: StatusSymbolFamily }
> = {
  success: {
    box: 'bg-nw-done-bg border-nw-done-border',
    icon: 'text-nw-done-icon',
    title: 'text-nw-done-text',
    symbol: 'done',
  },
  info: {
    box: 'bg-nw-neutral-bg border-nw-neutral-border',
    icon: 'text-nw-neutral-icon',
    title: 'text-nw-neutral-text',
    symbol: 'info',
  },
  warning: {
    box: 'bg-nw-warning-bg border-nw-warning-border',
    icon: 'text-nw-warning-icon',
    title: 'text-nw-warning-text',
    symbol: 'warning',
  },
  danger: {
    box: 'bg-nw-urgent-bg border-nw-urgent-border',
    icon: 'text-nw-urgent-icon',
    title: 'text-nw-urgent-text',
    symbol: 'urgent',
  },
  neutral: {
    box: 'bg-nw-neutral-bg border-nw-neutral-border',
    icon: 'text-nw-neutral-icon',
    title: 'text-nw-neutral-text',
    symbol: 'neutral',
  },
};

/** Inline banner. Danger/warning announce as alerts; the rest as polite status. */
export function Alert({
  tone = 'info',
  title,
  description,
  actions,
  dismissible = false,
  onDismiss,
  icon,
  className,
  children,
  ...rest
}: AlertProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const t = tones[tone];
  const urgent = tone === 'danger' || tone === 'warning';
  return (
    <div
      role={urgent ? 'alert' : 'status'}
      className={cn('flex items-start gap-3 rounded-md border p-3 text-xs text-nw-text-2', t.box, className)}
      {...rest}
    >
      <span aria-hidden className={cn('mt-0.5 shrink-0 [&_svg]:size-4', t.icon)}>
        {icon ?? <StatusSymbol family={t.symbol} size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        {title ? <div className={cn('font-semibold', t.title)}>{title}</div> : null}
        {description ? (
          <div className={cn('text-nw-text-2', title && 'mt-0.5')}>{description}</div>
        ) : null}
        {children}
        {actions ? <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {dismissible ? (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            setDismissed(true);
            onDismiss?.();
          }}
          className="-m-1 shrink-0 rounded-sm p-1 text-nw-text-3 transition-colors duration-(--duration-fast) hover:bg-nw-hover hover:text-nw-text"
        >
          <X className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
