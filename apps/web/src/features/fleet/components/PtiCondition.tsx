import type { ReactNode } from 'react';
import {
  PTI_RATINGS,
  PTI_RATING_LABEL,
  conditionCaption,
  isDueSoon,
  type ComponentCondition,
  type PtiRating,
} from '@/demo';
import { Tooltip, cn } from '@/design-system';
import { formatIsoDate } from '@/lib/format';
import { detail } from '../pti-condition-detail';

/**
 * The four-step scale, everywhere it appears.
 *
 * One fixed width per segment and per pill, so a column of them reads as a clean band — the same
 * rule the SENT / NO / LATE pills already follow.
 */

const TONE: Record<PtiRating, { pill: string; segment: string }> = {
  good: {
    pill: 'border-success-border bg-success-soft text-success-text',
    segment:
      'data-[on=true]:border-success-border data-[on=true]:bg-success-soft data-[on=true]:text-success-text',
  },
  monitor: {
    pill: 'border-line bg-surface-muted text-secondary',
    segment: 'data-[on=true]:border-line data-[on=true]:bg-surface-active data-[on=true]:text-ink',
  },
  replace_soon: {
    pill: 'border-warning-border bg-warning-soft text-warning-text',
    segment:
      'data-[on=true]:border-warning-border data-[on=true]:bg-warning-soft data-[on=true]:text-warning-text',
  },
  replace_now: {
    pill: 'border-danger-border bg-danger-soft text-danger-text',
    segment:
      'data-[on=true]:border-danger-border data-[on=true]:bg-danger-soft data-[on=true]:text-danger-text',
  },
};

/**
 * `demoted` is a rating carried forward from an earlier week: the word stays, the fill goes and the
 * border is dashed, so an old rating is visibly not this week's without pretending to be nothing.
 */
export function ConditionPill({
  rating,
  demoted = false,
  className,
}: {
  rating: PtiRating;
  demoted?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-6 w-[6.5rem] items-center justify-center rounded-sm border text-2xs font-semibold tracking-wide uppercase',
        demoted ? 'border-dashed border-line bg-transparent text-muted' : TONE[rating].pill,
        className,
      )}
      title={demoted ? 'Carried forward from an earlier week' : undefined}
    >
      {PTI_RATING_LABEL[rating]}
    </span>
  );
}

/**
 * Four equal choices, read as one row of a rating table: Good · Monitor · Replace soon ·
 * Replace now. One click rates a component, and clicking the chosen one again clears it, so
 * "not observed" stays a real answer rather than a forced guess.
 *
 * It stays a group of pressable buttons rather than native radios because clearing a native radio
 * takes a fifth control, and the whole scale has to fit one line of a table.
 */
export function RatingControl({
  value,
  onChange,
  label,
  disabled,
}: {
  value: PtiRating | null;
  onChange: (rating: PtiRating | null) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={`${label} rating`} className="grid grid-cols-4 gap-1">
      {PTI_RATINGS.map((rating) => {
        const on = value === rating;
        return (
          <button
            key={rating}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            data-on={on}
            onClick={() => onChange(on ? null : rating)}
            className={cn(
              'flex min-h-9 flex-col items-center justify-center gap-1 rounded-md border border-line bg-surface px-1 py-1.5',
              'text-2xs leading-tight font-semibold text-secondary transition-colors',
              'hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:opacity-50',
              TONE[rating].segment,
            )}
          >
            <span
              aria-hidden
              className={cn(
                'size-2.5 shrink-0 rounded-full border',
                on ? 'border-current bg-current' : 'border-line-strong bg-surface',
              )}
            />
            <span className="text-center">{PTI_RATING_LABEL[rating]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The full breakdown of a unit: one line per component, worst first. */
export function ConditionBreakdown({
  conditions,
  today,
}: {
  conditions: ComponentCondition[];
  today: string;
}) {
  const rated = conditions.filter((c) => c.rating !== null);
  if (rated.length === 0)
    return <span className="text-xs text-muted">No components rated yet.</span>;
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {rated.map((c) => (
        <li key={c.component.id} className="flex items-center justify-between gap-3">
          <span className="text-secondary">{c.component.name}</span>
          <span className="flex items-center gap-2 whitespace-nowrap">
            {c.rating ? <ConditionPill rating={c.rating} /> : null}
            <span className="text-muted">{detail(c, today)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The board cell: the worst pill, the component driving it, and the breakdown on hover. */
export function ConditionCell({
  conditions,
  worst,
  today,
}: {
  conditions: ComponentCondition[];
  worst: ComponentCondition | null;
  today: string;
}) {
  if (!worst || !worst.rating) return <span className="text-faint">—</span>;
  const due = isDueSoon(worst, today);
  const content: ReactNode = <ConditionBreakdown conditions={conditions} today={today} />;
  return (
    <Tooltip content={content} side="left">
      <span className="flex cursor-default flex-col gap-0.5">
        <ConditionPill rating={worst.rating} />
        <span className={cn('text-xs whitespace-nowrap', due ? 'text-warning-text' : 'text-muted')}>
          {conditionCaption(worst, today)}
        </span>
        {worst.carriedOver && worst.source ? (
          <span className="text-2xs whitespace-nowrap text-faint">
            from {formatIsoDate(worst.source.weekStart)}
            {worst.stale ? ' · re-check' : ''}
          </span>
        ) : null}
      </span>
    </Tooltip>
  );
}
