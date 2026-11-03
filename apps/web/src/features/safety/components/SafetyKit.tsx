import { AlertTriangle, ChevronRight, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { SafetyException, SafetyUnavailableCheck } from '@neway/shared';
import { Badge, Card, cn } from '@/design-system';
import { formatNumber } from '@/lib/format';

/**
 * The pieces every Safety page is made of.
 *
 * These are the Fleet primitives' siblings, deliberately: a summary strip that filters, an
 * exception panel that disappears when there is nothing wrong, a compact metric strip and a fact
 * list. Inspections, Accidents and Violations share all of them, which is what makes the three
 * pages read as one product rather than three tables built by three people.
 */

// ---------------------------------------------------------------------------------------------
// Summary strip
// ---------------------------------------------------------------------------------------------

export interface SafetySummarySegment {
  key: string;
  label: string;
  /** Null renders "—". Zero renders "0" — the two mean different things. */
  count: number | null;
  tone?: 'default' | 'warning' | 'danger' | 'success';
  onSelect?: () => void;
}

const SEGMENT_TONE: Record<NonNullable<SafetySummarySegment['tone']>, string> = {
  default: 'text-ink',
  warning: 'text-warning-text',
  danger: 'text-danger-text',
  success: 'text-success-text',
};

export function SafetySummaryStrip({
  segments,
  activeKey,
  loading,
  className,
}: {
  segments: SafetySummarySegment[];
  activeKey?: string | null;
  loading?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-stretch overflow-hidden rounded-xl border border-line bg-surface',
        className,
      )}
    >
      {segments.map((segment, index) => {
        const active = activeKey != null && activeKey === segment.key;
        const body = (
          <>
            <span className="eyebrow">
              {segment.label}
            </span>
            {loading ? (
              <span className="mt-1 block h-7 w-10 animate-pulse rounded bg-surface-muted" />
            ) : (
              <span
                className={cn(
                  'mt-0.5 block text-2xl leading-8 font-semibold tabular-nums',
                  SEGMENT_TONE[segment.tone ?? 'default'],
                )}
              >
                {segment.count === null ? '—' : formatNumber(segment.count)}
              </span>
            )}
          </>
        );
        const shared = cn(
          'min-w-30 flex-1 px-4 py-3 text-left',
          index > 0 && 'border-l border-line',
          active && 'bg-primary-soft',
        );
        return segment.onSelect ? (
          <button
            key={segment.key}
            type="button"
            onClick={segment.onSelect}
            aria-pressed={active}
            className={cn(
              shared,
              'transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none',
              active && 'hover:bg-primary-soft-hover',
            )}
          >
            {body}
          </button>
        ) : (
          <div key={segment.key} className={shared}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Exception panel
// ---------------------------------------------------------------------------------------------

const EXCEPTION_TONE: Record<
  SafetyException['severity'],
  { icon: typeof AlertTriangle; ring: string; text: string }
> = {
  critical: {
    icon: TriangleAlert,
    ring: 'border-danger-border bg-danger-soft',
    text: 'text-danger-text',
  },
  warning: {
    icon: AlertTriangle,
    ring: 'border-warning-border bg-warning-soft',
    text: 'text-warning-text',
  },
  info: { icon: Info, ring: 'border-line bg-surface-muted', text: 'text-secondary' },
};

/**
 * What needs a safety manager today — and nothing else.
 *
 * Renders only when the engine actually found something. There is no "all clear" card, because a
 * panel that is always there is a panel people stop reading; its absence is the all-clear.
 */
export function SafetyExceptionPanel({
  items,
  unavailable = [],
  onSelect,
  className,
  title = 'Needs attention',
}: {
  items: SafetyException[];
  unavailable?: SafetyUnavailableCheck[];
  onSelect: (item: SafetyException) => void;
  className?: string;
  title?: string;
}) {
  if (items.length === 0) return null;
  return (
    <section
      aria-labelledby="safety-needs-attention"
      className={cn('rounded-xl border border-line bg-surface p-4', className)}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="safety-needs-attention"
          className="eyebrow"
        >
          {title}
        </h2>
        <span className="text-xs text-faint">
          {items.length} {items.length === 1 ? 'finding' : 'findings'}
        </span>
      </div>
      <ul className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => {
          const tone = EXCEPTION_TONE[item.severity];
          const Icon = tone.icon;
          return (
            <li key={item.key}>
              <button
                type="button"
                onClick={() => onSelect(item)}
                title={item.reason}
                className={cn(
                  'group flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                  tone.ring,
                  'hover:brightness-[0.98] focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none',
                )}
              >
                <Icon className={cn('mt-0.5 size-4 shrink-0', tone.text)} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-sm font-medium', tone.text)}>
                    {item.count} {item.label}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">{item.reason}</span>
                </span>
                <ChevronRight
                  className="mt-0.5 size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5"
                  aria-hidden
                />
              </button>
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

// ---------------------------------------------------------------------------------------------
// Detail anatomy
// ---------------------------------------------------------------------------------------------

export interface SafetyMetric {
  label: string;
  /** Null renders "Insufficient data" with `title` explaining what it would need. */
  value: ReactNode | null;
  hint?: string;
  tone?: 'default' | 'warning' | 'danger' | 'success';
  title?: string;
}

const METRIC_TONE: Record<NonNullable<SafetyMetric['tone']>, string> = {
  default: 'text-ink',
  warning: 'text-warning-text',
  danger: 'text-danger-text',
  success: 'text-success-text',
};

export function SafetyMetricStrip({
  metrics,
  className,
}: {
  metrics: SafetyMetric[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-stretch overflow-hidden rounded-xl border border-line bg-surface',
        className,
      )}
    >
      {metrics.map((metric, index) => (
        <div
          key={metric.label}
          className={cn('min-w-36 flex-1 px-4 py-3', index > 0 && 'border-l border-line')}
        >
          <p className="eyebrow">{metric.label}</p>
          {metric.value === null ? (
            <p className="mt-0.5 text-base leading-6 font-medium text-faint" title={metric.title}>
              Not recorded
            </p>
          ) : (
            <p
              className={cn(
                'mt-0.5 text-lg leading-7 font-semibold tabular-nums',
                METRIC_TONE[metric.tone ?? 'default'],
              )}
              title={metric.title}
            >
              {metric.value}
            </p>
          )}
          {metric.hint ? <p className="mt-0.5 text-xs text-faint">{metric.hint}</p> : null}
        </div>
      ))}
    </div>
  );
}

export function SafetyFactList({
  facts,
  className,
}: {
  facts: Array<{ label: string; value: ReactNode; title?: string }>;
  className?: string;
}) {
  return (
    <dl className={cn('divide-y divide-line-soft', className)}>
      {facts.map((fact) => (
        <div key={fact.label} className="flex items-baseline justify-between gap-4 py-2">
          <dt className="shrink-0 text-sm text-muted">{fact.label}</dt>
          <dd className="min-w-0 text-right text-sm text-ink" title={fact.title}>
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SafetyPanel({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('flex flex-col gap-3 p-4', className)}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-md font-bold text-ink">{title}</h3>
        {action}
      </div>
      {children}
    </Card>
  );
}

/**
 * A blocking notice: the thing that stops this record being closed, stated with what to do.
 *
 * Distinct from a warning badge because it carries a list of specific, checkable reasons rather
 * than one word.
 */
export function SafetyBlockerNotice({
  title,
  reasons,
  tone = 'warning',
}: {
  title: string;
  reasons: string[];
  tone?: 'warning' | 'danger';
}) {
  if (reasons.length === 0) return null;
  return (
    <div
      className={cn(
        'rounded-xl border px-4 py-3',
        tone === 'danger'
          ? 'border-danger-border bg-danger-soft'
          : 'border-warning-border bg-warning-soft',
      )}
    >
      <p
        className={cn(
          'text-sm font-medium',
          tone === 'danger' ? 'text-danger-text' : 'text-warning-text',
        )}
      >
        {title}
      </p>
      <ul className="mt-1.5 flex flex-col gap-0.5">
        {reasons.map((reason) => (
          <li key={reason} className="text-sm text-secondary">
            • {reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A risk indicator: a statement of fact with the records behind it.
 *
 * Never a score. Clicking one opens exactly the records it counted.
 */
export function SafetyIndicatorRow({
  indicators,
  onSelect,
  className,
}: {
  indicators: Array<{
    key: string;
    label: string;
    ids: string[];
    tone: 'critical' | 'warning' | 'info';
  }>;
  onSelect?: (ids: string[]) => void;
  className?: string;
}) {
  if (indicators.length === 0) return null;
  const tone: Record<string, 'danger' | 'warning' | 'info'> = {
    critical: 'danger',
    warning: 'warning',
    info: 'info',
  };
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {indicators.map((indicator) =>
        onSelect ? (
          <button
            key={indicator.key}
            type="button"
            onClick={() => onSelect(indicator.ids)}
            className="rounded-full focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          >
            <Badge tone={tone[indicator.tone] ?? 'neutral'}>{indicator.label}</Badge>
          </button>
        ) : (
          <Badge key={indicator.key} tone={tone[indicator.tone] ?? 'neutral'}>
            {indicator.label}
          </Badge>
        ),
      )}
    </div>
  );
}
