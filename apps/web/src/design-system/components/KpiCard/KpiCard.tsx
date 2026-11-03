import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Sparkline } from '../Chart/Sparkline';
import { KpiSkeleton } from '../Skeleton';

export type KpiDeltaDirection = 'up' | 'down' | 'flat';

export interface KpiDelta {
  /**
   * Signed change driving the direction, the tone and the arrow. Rendered as a percentage
   * (e.g. -4.2 → "−4.2%") unless `text` supplies its own display string.
   */
  value: number;
  /**
   * Preformatted change shown instead of the percentage — typically the absolute change
   * (`"$76,786.00"`). Pass it unsigned: the triangle and the tone already carry the direction.
   */
  text?: string;
  /** Inferred from the sign of `value` when omitted. */
  direction?: KpiDeltaDirection;
  /** e.g. "vs last week" */
  label?: string;
  /** Whether an increase is good (revenue: true; overdue invoices: false). Default true. */
  positiveIsGood?: boolean;
}

/**
 * Solid up/down triangle used by the `feature` variant. Lucide's arrows read as navigation at
 * this size; a filled triangle reads as a change indicator.
 */
function DeltaTriangle({ direction }: { direction: KpiDeltaDirection }) {
  if (direction === 'flat') return <Minus className="size-3" aria-hidden />;
  return (
    <svg viewBox="0 0 10 8" aria-hidden className="size-2.5 shrink-0">
      <path d={direction === 'up' ? 'M5 0 10 8H0Z' : 'M5 8 0 0h10Z'} fill="currentColor" />
    </svg>
  );
}

export interface KpiCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onClick'> {
  /** Eyebrow label, sentence case. */
  label: ReactNode;
  value: string | number;
  delta?: KpiDelta;
  /** Small muted text under the value/delta. */
  hint?: ReactNode;
  /** 16px Lucide icon shown top-right, muted. */
  icon?: ReactNode;
  /**
   * Renders `icon` as a tinted rounded tile leading the card instead of a muted top-right mark.
   * Use for a headline summary strip where the tile carries the scanning weight.
   */
  iconTile?: boolean;
  /**
   * `feature` is the headline treatment: borderless, softer corners, a larger value and a solid
   * triangle for the change. Use it for a page's lead metric strip. `default` is the compact tile.
   */
  /**
   * `feature` is the hero tile; `compact` is the dense-grid tile, where the label and value share
   * a line so a grid of ten metrics stays scannable in a single band.
   */
  variant?: 'default' | 'feature' | 'compact';
  loading?: boolean;
  /** Renders the card as a button with hover affordance. */
  onClick?: () => void;
  /** 12-ish points; renders a 32px series-1 sparkline on the right. */
  sparkline?: number[];
  /**
   * Colours the value with a status family (SPEC §7): a queue tile whose count is the size of a
   * problem. Pair it with a StatusSymbol in the label, never colour alone. Unset renders as before.
   */
  tone?: 'urgent' | 'warning' | 'done' | 'moving' | 'neutral';
}

const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

function resolveDirection(delta: KpiDelta): KpiDeltaDirection {
  if (delta.direction) return delta.direction;
  if (delta.value > 0) return 'up';
  if (delta.value < 0) return 'down';
  return 'flat';
}

/** Compact stat tile: eyebrow, 20px value, delta with arrow + tone, optional sparkline. */
export function KpiCard({
  label,
  value,
  delta,
  hint,
  icon,
  iconTile = false,
  variant = 'default',
  loading = false,
  onClick,
  sparkline,
  tone,
  className,
  ...rest
}: KpiCardProps) {
  if (loading) return <KpiSkeleton />;

  const feature = variant === 'feature';
  const compact = variant === 'compact';
  const direction = delta ? resolveDirection(delta) : undefined;
  const positiveIsGood = delta?.positiveIsGood ?? true;
  /*
   * The arrow carries direction; the color carries judgement. A cost falling is a green ▼, which
   * is why `positiveIsGood` exists and why tone is never read off the sign of the number.
   */
  const deltaTone =
    direction === 'flat' || !direction
      ? 'text-nw-text-3'
      : (direction === 'up') === positiveIsGood
        ? 'text-nw-done-text'
        : 'text-nw-urgent-text';
  const DeltaIcon =
    direction === 'up' ? ArrowUpRight : direction === 'down' ? ArrowDownRight : Minus;

  const content = (
    <>
      <div className={cn('flex items-start justify-between gap-2', compact && 'hidden')}>
        <span className="flex min-w-0 items-center gap-2">
          {iconTile && icon ? (
            <span
              aria-hidden
              className="flex size-7 shrink-0 items-center justify-center rounded-md bg-nw-accent-tint text-nw-accent-ink [&_svg]:size-4"
            >
              {icon}
            </span>
          ) : null}
          <span className="truncate text-sm font-semibold text-nw-text-2">{label}</span>
        </span>
        {icon && !iconTile ? (
          <span aria-hidden className="shrink-0 text-nw-text-3 [&_svg]:size-4">
            {icon}
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          'flex items-end justify-between gap-3',
          feature ? 'mt-2' : compact ? 'mt-0' : 'mt-1.5',
        )}
      >
        <div className="min-w-0">
          {/* Value and delta share a baseline row: the number and its movement are one reading. */}
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {compact ? (
              <span className="min-w-0 text-sm font-semibold text-nw-text-2">{label}</span>
            ) : null}
            <div
              className={cn(
                'kpi-value',
                tone === 'urgent'
                  ? 'text-nw-urgent-text'
                  : tone === 'warning'
                    ? 'text-nw-warning-text'
                    : tone === 'done'
                      ? 'text-nw-done-text'
                      : tone === 'moving'
                        ? 'text-nw-moving-text'
                        : tone === 'neutral'
                          ? 'text-nw-neutral-text'
                          : 'text-nw-text',
                feature
                  ? 'max-w-full text-2xl font-extrabold tracking-[-0.02em] sm:text-3xl'
                  : compact
                    ? 'text-md font-extrabold'
                    : 'max-w-full text-xl font-extrabold tracking-[-0.015em] sm:text-2xl',
              )}
            >
              {value}
            </div>
            {delta ? (
              <span
                className={cn('inline-flex items-center gap-1 text-xs font-semibold', deltaTone)}
              >
                {feature ? (
                  <DeltaTriangle direction={direction ?? 'flat'} />
                ) : (
                  <DeltaIcon className="size-3" aria-hidden />
                )}
                <span className="tabular">
                  <span className="sr-only">
                    {direction === 'up' ? 'Up ' : direction === 'down' ? 'Down ' : 'Unchanged '}
                  </span>
                  {delta.text ??
                    `${direction === 'flat' ? '' : delta.value > 0 ? '+' : delta.value < 0 ? '−' : ''}${percent.format(Math.abs(delta.value))}%`}
                </span>
              </span>
            ) : null}
            {/* The comparison label sits beside the pill, not inside it: "vs previous 8 weeks" is
                a caption, and wrapping it inside the chip turns a delta into a paragraph. */}
            {delta?.label ? (
              <span className="text-2xs font-normal text-nw-text-3">{delta.label}</span>
            ) : null}
          </div>
          {/* Footnotes such as "after $6.1K inactive loss" stay: they are the caveat on the number. */}
          {hint ? <div className="mt-1 text-2xs text-nw-text-3">{hint}</div> : null}
        </div>
        {sparkline && sparkline.length > 1 ? (
          <div className="w-20 shrink-0">
            <Sparkline data={sparkline} width={80} height={32} />
          </div>
        ) : null}
      </div>
    </>
  );

  const base = cn(
    'flex w-full flex-col rounded-xl border border-nw-border bg-nw-panel shadow-card',
    feature
      ? 'min-h-[104px] px-[18px] pt-4 pb-3.5'
      : compact
        ? 'p-3'
        : 'min-h-[92px] px-[18px] pt-4 pb-3.5',
  );

  if (onClick) {
    return (
      // `rest` is forwarded here too: the props this component accepts must reach the DOM whether
      // or not the card happens to be clickable, or `title`, `data-*` and aria attributes vanish
      // exactly on the cards that carry an action.
      <button
        type="button"
        onClick={onClick}
        className={cn(
          base,
          'cursor-pointer text-left transition-colors duration-(--duration-base) hover:bg-nw-hover hover:border-nw-border-strong',
          className,
        )}
        {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
      >
        {content}
      </button>
    );
  }
  return (
    <div className={cn(base, className)} {...rest}>
      {content}
    </div>
  );
}
