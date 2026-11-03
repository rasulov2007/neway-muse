import { cn } from '@/design-system';
import type { PtiRecord } from '@/demo';

/**
 * Whether the walk-around arrived — on the board and in the update panel, the same pill.
 *
 * One fixed size for all of them, so the column reads as a clean vertical band rather than as
 * chips of different widths.
 *
 * Red is kept for the one case that deserves chasing: the deadline has passed and the walk-around
 * never arrived. A truck that simply has not sent yet in a week still running is printed quietly —
 * a column of red on every open row is a column nobody reads.
 */
export function PtiStatusPill({
  status,
  missing,
  className,
}: {
  status: PtiRecord['status'];
  /** The deadline has gone by and the truck was out on the road to send one. */
  missing: boolean;
  className?: string;
}) {
  const label =
    status === 'sent' ? 'SENT' : status === 'late' ? 'LATE' : missing ? 'MISSING' : 'NOT IN';
  const tone =
    status === 'sent'
      ? 'border-success-border bg-success-soft text-success-text'
      : status === 'late'
        ? 'border-warning-border bg-warning-soft text-warning-text'
        : missing
          ? 'border-danger-border bg-danger-soft text-danger-text'
          : 'border-line bg-surface-muted text-secondary';
  return (
    <span
      className={cn(
        'inline-flex h-6 w-[4.5rem] items-center justify-center rounded-sm border text-2xs font-semibold tracking-wide',
        tone,
        className,
      )}
    >
      {label}
    </span>
  );
}
