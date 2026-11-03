import { Info } from 'lucide-react';
import { ToggleGroup } from 'radix-ui';
import type { HTMLAttributes, ReactNode } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  StatusSymbol,
  cn,
} from '@/design-system';

/**
 * Analytics building blocks (owner, 2026-10-25). Every colour is a `--nw-an-*` or Porcelain
 * token; nothing here is reused outside the Analytics section.
 */

export function AnCard({
  className,
  lift = false,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { lift?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-an-card border border-an-card-border bg-an-card shadow-an-card',
        lift && 'nw-an-lift',
        className,
      )}
      {...rest}
    />
  );
}

export function AnCardHeader({
  title,
  description,
  actions,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  id?: string;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
      <div className="min-w-0">
        <h3 id={id} className="text-[15px] leading-5 font-bold text-nw-text">
          {title}
        </h3>
        {description ? <p className="mt-0.5 text-xs text-nw-text-3">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Segmented pill control: the active option is a dark pill on a soft track. */
export function PillToggle<T extends string>({
  value,
  onValueChange,
  options,
  label,
  size = 'md',
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: ReactNode; icon?: ReactNode }>;
  label: string;
  size?: 'sm' | 'md';
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange(next as T);
      }}
      aria-label={label}
      className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-an-pill bg-an-pill-track p-1"
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          aria-label={typeof option.label === 'string' ? option.label : undefined}
          className={cn(
            'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-an-pill font-semibold whitespace-nowrap text-nw-text-2',
            'transition-colors duration-(--duration-base) hover:text-nw-text',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-an-accent',
            'data-[state=on]:bg-an-pill-active data-[state=on]:text-an-on-pill-active',
            size === 'sm' ? 'h-7 px-2.5 text-xs [&_svg]:size-3.5' : 'h-8 px-3.5 text-[12.5px] [&_svg]:size-4',
          )}
        >
          {option.icon}
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

/** Where the figures come from: live records, or the generated reporting dataset. */
export function DataSourceBadge({ source }: { source: 'demo' | 'database' }) {
  const live = source === 'database';
  return (
    <StatusTag
      family={live ? 'done' : 'warning'}
      label={live ? 'Live records' : 'Sample data — not live records'}
    />
  );
}

export type TagFamily = 'done' | 'urgent' | 'warning' | 'neutral' | 'info';

const TAG_STYLE: Record<TagFamily, { pill: string; icon: string }> = {
  done: {
    pill: 'bg-nw-done-bg text-nw-done-text ring-nw-done-border',
    icon: 'text-nw-done-icon',
  },
  urgent: {
    pill: 'bg-nw-urgent-bg text-nw-urgent-text ring-nw-urgent-border',
    icon: 'text-nw-urgent-icon',
  },
  warning: {
    pill: 'bg-nw-warning-bg text-nw-warning-text ring-nw-warning-border',
    icon: 'text-nw-warning-icon',
  },
  neutral: {
    pill: 'bg-nw-neutral-bg text-nw-neutral-text ring-nw-neutral-border',
    icon: 'text-nw-neutral-icon',
  },
  info: {
    pill: 'bg-nw-neutral-bg text-nw-neutral-text ring-nw-neutral-border',
    icon: 'text-nw-neutral-icon',
  },
};

/** A status as symbol + word + colour (never colour alone), as a rounded pill. */
export function StatusTag({
  family,
  label,
  className,
}: {
  family: TagFamily;
  label: string;
  className?: string;
}) {
  const style = TAG_STYLE[family];
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-an-pill pr-2.5 pl-2 text-xs font-semibold whitespace-nowrap ring-1 ring-inset',
        style.pill,
        className,
      )}
    >
      <StatusSymbol family={family} size={13} className={style.icon} />
      {label}
    </span>
  );
}

/**
 * "How is this worked out?" A button, so the formula opens by keyboard and by touch as well as by
 * pointer — the old `title` attribute reached neither.
 */
export function FormulaInfo({
  label,
  formula,
  details,
}: {
  label: string;
  formula: string;
  /** Figures behind the number (e.g. cost before recovery and recovered), shown under the formula. */
  details?: ReadonlyArray<{ label: string; value: string }>;
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`How ${label} is worked out`}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-an-pill text-nw-text-3 hover:bg-an-pill-track hover:text-nw-text-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-an-accent"
      >
        <Info aria-hidden className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 text-xs">
        <p className="font-semibold text-nw-text">{label}</p>
        <p className="mt-1 text-nw-text-2">{formula}</p>
        {details && details.length > 0 ? (
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 border-t border-nw-border pt-2">
            {details.map((detail) => (
              <div key={detail.label} className="contents">
                <dt className="text-nw-text-2">{detail.label}</dt>
                <dd className="text-right font-semibold text-nw-text tabular-nums">{detail.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** Skeleton blocks plus the words a screen reader hears: "Loading…" (CLAUDE.md). */
export function LoadingBlock({ className, label = 'Loading…' }: { className?: string; label?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn('relative', className)}>
      <span className="sr-only">{label}</span>
      <Skeleton className="h-full w-full rounded-an-card" />
    </div>
  );
}

export function SectionError({ title, error }: { title: string; error: unknown }) {
  return (
    <AnCard role="alert" className="flex items-start gap-3 px-5 py-4">
      <StatusSymbol family="urgent" size={16} className="mt-0.5 text-nw-urgent-icon" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-nw-urgent-text">{title}</p>
        <p className="mt-0.5 text-xs text-nw-text-2">
          {error instanceof Error ? error.message : 'Please try again in a moment.'}
        </p>
      </div>
    </AnCard>
  );
}

export function EmptyCard({ title, description }: { title: string; description?: string }) {
  return (
    <AnCard className="flex flex-col items-center gap-1 px-5 py-10 text-center">
      <StatusSymbol family="info" size={18} className="text-nw-neutral-icon" />
      <p className="mt-1 text-sm font-semibold text-nw-text">{title}</p>
      {description ? <p className="max-w-md text-xs text-nw-text-3">{description}</p> : null}
    </AnCard>
  );
}

/** A note under a section, with the info symbol. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-xs text-nw-text-2">
      <StatusSymbol family="info" size={14} className="mt-px text-nw-neutral-icon" />
      <span>{children}</span>
    </p>
  );
}
