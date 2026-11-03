import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { StatusTone } from '../../status';

export interface StatTileProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onClick'> {
  /** Sentence-case label above the value. */
  label: ReactNode;
  value: ReactNode;
  /** Muted line under the value. */
  hint?: ReactNode;
  /** 16px Lucide icon, rendered in a tinted rounded tile leading the text. */
  icon?: ReactNode;
  /** Colours the icon tile (and, with `valueTone`, the value). Default is the primary tint. */
  tone?: StatusTone | 'primary';
  /** Colour the value with `tone` as well — for counts that are themselves the warning. */
  valueTone?: boolean;
  /** Put the icon on the trailing edge instead of leading the text. */
  iconRight?: boolean;
  /** Renders the tile as a pressable button. */
  onClick?: () => void;
  pressed?: boolean;
  size?: 'md' | 'lg';
}

const TILE: Record<NonNullable<StatTileProps['tone']>, string> = {
  primary: 'bg-nw-accent-tint text-nw-accent-ink',
  info: 'bg-nw-moving-bg text-nw-moving-text',
  success: 'bg-nw-done-bg text-nw-done-text',
  warning: 'bg-nw-warning-bg text-nw-warning-text',
  danger: 'bg-nw-urgent-bg text-nw-urgent-text',
  neutral: 'bg-nw-neutral-bg text-nw-neutral-text',
  violet: 'bg-nw-moving-bg text-nw-moving-text',
};

const VALUE: Record<NonNullable<StatTileProps['tone']>, string> = {
  primary: 'text-nw-accent-ink',
  info: 'text-nw-moving-text',
  success: 'text-nw-done-text',
  warning: 'text-nw-warning-text',
  danger: 'text-nw-urgent-text',
  neutral: 'text-nw-text',
  violet: 'text-nw-moving-text',
};

/**
 * Summary tile: icon tile, small label, large value, optional hint. The strip of these across the
 * top of a list page answers "how many, and how many are a problem" before the table does.
 */
export function StatTile({
  label,
  value,
  hint,
  icon,
  tone = 'primary',
  valueTone = false,
  iconRight = false,
  onClick,
  pressed,
  size = 'md',
  className,
  ...rest
}: StatTileProps) {
  const tile = icon ? (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg [&_svg]:size-5',
        size === 'lg' ? 'size-11' : 'size-9',
        TILE[tone],
      )}
    >
      {icon}
    </span>
  ) : null;
  const body = (
    <>
      {!iconRight ? tile : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm leading-tight font-semibold text-nw-text-2">{label}</span>
        <span
          className={cn(
            'truncate font-extrabold tracking-[-0.015em] text-nw-text tabular-nums',
            size === 'lg' ? 'text-3xl' : 'text-2xl',
            valueTone && VALUE[tone],
          )}
        >
          {value}
        </span>
        {hint ? <span className="truncate text-xs text-nw-text-3">{hint}</span> : null}
      </span>
      {iconRight ? tile : null}
    </>
  );
  const shell = cn(
    'flex items-center gap-3 rounded-xl border border-nw-border bg-nw-panel px-[18px] py-3.5 text-left shadow-card',
    onClick &&
      'cursor-pointer transition-colors duration-(--duration-base) hover:border-nw-border-strong hover:bg-nw-hover',
    pressed && 'border-nw-accent ring-1 ring-nw-accent',
    className,
  );
  if (onClick) {
    return (
      <button type="button" aria-pressed={pressed} className={shell} onClick={onClick}>
        {body}
      </button>
    );
  }
  return (
    <div className={shell} {...rest}>
      {body}
    </div>
  );
}
