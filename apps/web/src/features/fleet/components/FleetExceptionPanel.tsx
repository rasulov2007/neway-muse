import { AlertTriangle, ChevronRight, Info, TriangleAlert } from 'lucide-react';
import type { FleetException, FleetUnavailableCheck } from '@neway/shared';
import { cn } from '@/design-system';

/**
 * What is wrong in the fleet right now — and nothing else.
 *
 * The panel renders only when `buildFleetExceptions` actually found something. There is no "all
 * clear" card, because a permanent panel trains people to stop reading it; its absence is the
 * all-clear. Every row is clickable and lands on the filtered list holding the exact records
 * behind its count.
 *
 * `unavailable` is listed quietly underneath so the reader knows which checks did not run and what
 * they would need, rather than mistaking a check that could not run for a check that passed.
 */

const SEVERITY: Record<
  FleetException['severity'],
  { icon: typeof AlertTriangle; ring: string; text: string; dot: string }
> = {
  critical: {
    icon: TriangleAlert,
    ring: 'border-danger-border bg-danger-soft',
    text: 'text-danger-text',
    dot: 'bg-danger',
  },
  warning: {
    icon: AlertTriangle,
    ring: 'border-warning-border bg-warning-soft',
    text: 'text-warning-text',
    dot: 'bg-warning',
  },
  info: {
    icon: Info,
    ring: 'border-line bg-surface-muted',
    text: 'text-secondary',
    dot: 'bg-neutral',
  },
};

export interface FleetExceptionPanelProps {
  items: FleetException[];
  unavailable?: FleetUnavailableCheck[];
  /** Required unless `interactive` is false. */
  onSelect?: (item: FleetException) => void;
  /**
   * Whether a row does anything when pressed. Pages that have no filter to apply pass false and
   * get plain rows: a control that looks pressable and answers with nothing is worse than text.
   */
  interactive?: boolean;
  className?: string;
}

export function FleetExceptionPanel({
  items,
  unavailable = [],
  onSelect,
  interactive = true,
  className,
}: FleetExceptionPanelProps) {
  if (items.length === 0) return null;

  return (
    <section
      aria-labelledby="fleet-needs-attention"
      className={cn('rounded-xl border border-line bg-surface p-4', className)}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="fleet-needs-attention"
          className="eyebrow"
        >
          Needs attention
        </h2>
        <span className="text-xs text-faint">
          {items.length} {items.length === 1 ? 'finding' : 'findings'}
        </span>
      </div>

      <ul className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => {
          const severity = SEVERITY[item.severity];
          const Icon = severity.icon;
          return (
            <li key={item.key}>
              {(() => {
                const Row = interactive ? 'button' : 'div';
                return (
                  <Row
                    {...(interactive
                      ? {
                          type: 'button' as const,
                          onClick: () => onSelect?.(item),
                        }
                      : {})}
                    title={item.reason}
                    className={cn(
                      'group flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                      severity.ring,
                      interactive
                        ? 'hover:brightness-[0.98] focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none'
                        : undefined,
                    )}
                  >
                    <Icon className={cn('mt-0.5 size-4 shrink-0', severity.text)} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-sm font-medium', severity.text)}>
                        {item.ids.length > 0 ? `${item.count} ` : ''}
                        {item.label}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted">
                        {item.reason}
                      </span>
                    </span>
                    {interactive ? (
                      <ChevronRight
                        className="mt-0.5 size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5"
                        aria-hidden
                      />
                    ) : null}
                  </Row>
                );
              })()}
            </li>
          );
        })}
      </ul>

      {unavailable.length > 0 ? (
        <p className="mt-3 border-t border-line-soft pt-3 text-xs text-faint">
          Not checked:{' '}
          {unavailable.map((check, index) => (
            <span key={check.key} title={`Needs: ${check.requires}`}>
              {index > 0 ? ', ' : ''}
              <span className="underline decoration-dotted underline-offset-2">{check.label}</span>
            </span>
          ))}
          .
        </p>
      ) : null}
    </section>
  );
}
