import { expiryTone, type ExpiryTone, type ExpiryToneResult } from '@neway/shared';
import { Badge, StatusSymbol, type BadgeSize, type BadgeTone, type BadgeVariant } from '@/design-system';
import type { StatusSymbolFamily } from '@/design-system';

/**
 * How every expiry date in the product looks (owner, 2026-10-08). The band comes from the one
 * shared rule, `expiryTone` in `@neway/shared`; this only turns it into symbol + word + colour:
 *
 * | Band     | Colour family        | Symbol                 | Word                          |
 * |----------|----------------------|------------------------|-------------------------------|
 * | expired  | urgent (red)         | octagon "!"            | Expired                       |
 * | danger   | urgent (red)         | diamond "!"            | Expires today / in N days     |
 * | warning  | warning (yellow)     | diamond "!"            | Expires in N days             |
 * | info     | moving (blue)        | "i" circle             | Expires in N days             |
 * | normal   | done (green)         | check circle           | Valid                         |
 * | none     | neutral              | dashed ring            | No expiry                     |
 *
 * Expired and "within a month" are both red; the octagon and the word "Expired" are what tell them
 * apart, so the difference never rests on colour.
 */
export interface ExpiryLook {
  tone: BadgeTone;
  symbol: StatusSymbolFamily;
  /** The icon colour utility for the symbol (the family's `-icon` token). */
  iconClass: string;
  /** The text colour utility, for a plain line rather than a pill. */
  textClass: string;
}

export const EXPIRY_LOOK: Record<ExpiryTone, ExpiryLook> = {
  expired: { tone: 'danger', symbol: 'urgent', iconClass: 'text-nw-urgent-icon', textClass: 'text-nw-urgent-text' },
  danger: { tone: 'danger', symbol: 'warning', iconClass: 'text-nw-urgent-icon', textClass: 'text-nw-urgent-text' },
  warning: { tone: 'warning', symbol: 'warning', iconClass: 'text-nw-warning-icon', textClass: 'text-nw-warning-text' },
  info: { tone: 'info', symbol: 'info', iconClass: 'text-nw-moving-icon', textClass: 'text-nw-moving-text' },
  normal: { tone: 'success', symbol: 'done', iconClass: 'text-nw-done-icon', textClass: 'text-nw-done-text' },
  none: { tone: 'neutral', symbol: 'neutral', iconClass: 'text-nw-neutral-icon', textClass: 'text-nw-neutral-text' },
};

export function ExpiryBadge({
  expiresOn,
  today,
  result,
  label,
  size = 'sm',
  variant,
  className,
}: {
  expiresOn?: string | null;
  /** Eastern today (`today()` from `@/lib/clock`). */
  today: string;
  /** A result already computed by the caller, instead of `expiresOn`. */
  result?: ExpiryToneResult;
  /** Overrides the word, e.g. "Registration expires in 12 days". */
  label?: string;
  size?: BadgeSize;
  variant?: BadgeVariant;
  className?: string;
}) {
  const r = result ?? expiryTone(expiresOn ?? null, today);
  const look = EXPIRY_LOOK[r.tone];
  return (
    <Badge
      tone={look.tone}
      size={size}
      variant={variant}
      dot
      icon={<StatusSymbol family={look.symbol} size={variant === 'text' ? 14 : 13} className={look.iconClass} />}
      className={className}
      data-expiry-tone={r.tone}
    >
      {label ?? r.label}
    </Badge>
  );
}
