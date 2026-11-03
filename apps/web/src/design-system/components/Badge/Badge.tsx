import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import {
  getStatus,
  getStatusLook,
  toneFamily,
  type StatusFamily,
  type StatusTone,
} from '../../status';
import { StatusSymbol } from './StatusSymbol';

export type BadgeTone = StatusTone;
/** `soft` is the pill; `outline` keeps the pill shape on the panel fill; `text` is the SPEC "text form". */
export type BadgeVariant = 'soft' | 'outline' | 'text';
export type BadgeSize = 'sm' | 'md';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  variant?: BadgeVariant;
  size?: BadgeSize;
  /** Leading status symbol in the family colour (Porcelain replaces the old dot with a symbol). */
  dot?: boolean;
  /** Leading icon (overrides the symbol). */
  icon?: ReactNode;
  /**
   * The leading symbol breathes on and off, for a record that is live (a load waiting or on the
   * road). Decorative; stands still under reduced motion. Opt-in per use, never product-wide.
   */
  pulse?: boolean;
}

const familyPill: Record<StatusFamily, string> = {
  done: 'bg-nw-done-bg text-nw-done-text ring-nw-done-border',
  moving: 'bg-nw-moving-bg text-nw-moving-text ring-nw-moving-border',
  warning: 'bg-nw-warning-bg text-nw-warning-text ring-nw-warning-border',
  urgent: 'bg-nw-urgent-bg text-nw-urgent-text ring-nw-urgent-border',
  neutral: 'bg-nw-neutral-bg text-nw-neutral-text ring-nw-neutral-border',
};

const familyOutline: Record<StatusFamily, string> = {
  done: 'bg-nw-panel text-nw-done-text ring-nw-done-border',
  moving: 'bg-nw-panel text-nw-moving-text ring-nw-moving-border',
  warning: 'bg-nw-panel text-nw-warning-text ring-nw-warning-border',
  urgent: 'bg-nw-panel text-nw-urgent-text ring-nw-urgent-border',
  neutral: 'bg-nw-panel text-nw-neutral-text ring-nw-neutral-border',
};

const familyText: Record<StatusFamily, string> = {
  done: 'text-nw-done-text',
  moving: 'text-nw-moving-text',
  warning: 'text-nw-warning-text',
  urgent: 'text-nw-urgent-text',
  neutral: 'text-nw-neutral-text',
};

/** The symbol shape is drawn in the family's icon colour. */
const familyIcon: Record<StatusFamily, string> = {
  done: 'text-nw-done-icon',
  moving: 'text-nw-moving-icon',
  warning: 'text-nw-warning-icon',
  urgent: 'text-nw-urgent-icon',
  neutral: 'text-nw-neutral-icon',
};

/* Pill: 22px, radius 6, padding 0 8 0 6, 12/600, 13px symbol. `sm` keeps its 18px height. */
const pillSizes: Record<BadgeSize, string> = {
  sm: 'h-[18px] pr-1.5 pl-1 text-2xs gap-1 [&_svg]:size-3',
  md: 'h-[22px] pr-2 pl-1.5 text-xs gap-1.5 [&_svg]:size-[13px]',
};

/* Text form: 14px symbol plus the word, no fill. */
const textSizes: Record<BadgeSize, string> = {
  sm: 'text-2xs gap-1 [&_svg]:size-3',
  md: 'text-xs gap-1.5 [&_svg]:size-3.5',
};

/** Quiet, small label. Text is always present; colour never carries meaning alone. */
export function Badge({
  tone = 'neutral',
  variant = 'soft',
  size = 'md',
  dot = false,
  icon,
  pulse = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  const family = toneFamily(tone);
  const isText = variant === 'text';
  const lead =
    icon ??
    (dot ? (
      <StatusSymbol family={family} size={isText ? 14 : 13} className={familyIcon[family]} />
    ) : null);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center font-semibold whitespace-nowrap',
        isText
          ? cn(familyText[family], textSizes[size])
          : cn(
              'rounded-sm ring-1 ring-inset',
              variant === 'soft' ? familyPill[family] : familyOutline[family],
              pillSizes[size],
            ),
        className,
      )}
      {...rest}
    >
      {lead && pulse ? (
        <span aria-hidden className="nw-pulse inline-flex shrink-0">
          {lead}
        </span>
      ) : (
        lead
      )}
      {children}
    </span>
  );
}

export interface StatusBadgeProps extends Omit<BadgeProps, 'tone' | 'children'> {
  /** A code from the status system (design-system/status.ts). Unknown codes render neutral. */
  status: string;
  /** Override the label from the status map. */
  label?: string;
}

/* Family → the product tone that Badge maps back onto that family. */
const familyTone: Record<StatusFamily, StatusTone> = {
  done: 'success',
  moving: 'info',
  warning: 'warning',
  urgent: 'danger',
  neutral: 'neutral',
};

/**
 * Status rendered through the shared status system: always the family symbol plus the word, so a
 * column of statuses reads as one system and no status relies on colour alone.
 */
export function StatusBadge({ status, label, variant, size = 'md', className, ...rest }: StatusBadgeProps) {
  const def = getStatus(status);
  const look = getStatusLook(status);
  const symbolSize = variant === 'text' ? 14 : 13;
  // Dispatched wears the Daily board's DISPATCHED colour, apart from In transit's blue (owner, 2026-10-30); same arrow.
  const accent = status === 'dispatched';
  const accentClass =
    variant === 'text' ? 'text-(--bd-amber-text)' : cn('text-(--bd-dispatched-text) ring-nw-warning-border', variant === 'outline' ? 'bg-nw-panel' : 'bg-(--bd-dispatched)');
  return (
    <Badge
      tone={familyTone[look.family]}
      variant={variant}
      size={size}
      dot
      icon={
        accent ? (
          <StatusSymbol family={look.symbol} size={symbolSize} className="text-(--bd-amber-text)" />
        ) : look.symbol !== look.family ? (
          <StatusSymbol family={look.symbol} size={symbolSize} className={familyIcon[look.family]} />
        ) : undefined
      }
      className={cn(accent && accentClass, className)}
      {...rest}
    >
      {label ?? def.label}
    </Badge>
  );
}
