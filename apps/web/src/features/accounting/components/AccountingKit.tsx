import { AlertTriangle, ChevronRight, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Comparison, PeriodPreset } from '@neway/shared';
import { Card, cn } from '@/design-system';
import { formatMoney, formatNumber } from '@/lib/format';
import type { AccountingException } from '../useAccounting';

/**
 * The pieces every Accounting page is made of.
 *
 * Same language as the Fleet and Safety kits, with one addition that only finance needs: a metric
 * knows the difference between "no money" and "no data". `null` renders as an em dash with an
 * explanation on hover; `0` renders as $0.00. Conflating them on a financial screen is how a month
 * with nothing posted gets read as a month with nothing earned.
 */

// ---------------------------------------------------------------------------------------------
// Period selector
// ---------------------------------------------------------------------------------------------

const PRESETS: ReadonlyArray<{ value: PeriodPreset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
];

export function FinancialPeriodSelector({
  value,
  onChange,
  range,
  className,
}: {
  value: PeriodPreset;
  onChange: (preset: PeriodPreset) => void;
  range: { from: string; to: string };
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-3', className)}>
      <div className="inline-flex items-center rounded-lg border border-line bg-surface p-0.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => onChange(preset.value)}
            aria-pressed={value === preset.value}
            className={cn(
              'rounded-md px-2.5 py-1 text-sm font-medium transition-colors',
              value === preset.value
                ? 'bg-primary-soft text-primary-text'
                : 'text-secondary hover:bg-surface-hover hover:text-ink',
            )}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <span className="text-xs text-muted">
        {range.from} to {range.to}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Financial metric
// ---------------------------------------------------------------------------------------------

export interface FinancialMetricProps {
  label: string;
  /** Null means nothing was posted. Zero means zero. They render differently on purpose. */
  value: number | null;
  comparison?: Comparison;
  /** True when a rise is bad — cost, payables, overdue. */
  inverse?: boolean;
  hint?: string;
  /** What the figure would need, shown when it is null. */
  requires?: string;
  format?: 'money' | 'number' | 'percent' | 'perMile';
  tone?: 'default' | 'success' | 'warning' | 'danger';
}

function render(value: number, format: FinancialMetricProps['format']): string {
  switch (format) {
    case 'number':
      return formatNumber(value);
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'perMile':
      return `$${value.toFixed(3)}`;
    default:
      return formatMoney(value);
  }
}

const TONE: Record<NonNullable<FinancialMetricProps['tone']>, string> = {
  default: 'text-ink',
  success: 'text-success-text',
  warning: 'text-warning-text',
  danger: 'text-danger-text',
};

/** Solid triangle: a filled mark reads as a change, where an arrow reads as navigation. */
function Delta({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg viewBox="0 0 10 8" aria-hidden className="size-2.5 shrink-0">
      <path d={direction === 'up' ? 'M5 0 10 8H0Z' : 'M5 8 0 0h10Z'} fill="currentColor" />
    </svg>
  );
}

export function FinancialMetric({
  label,
  value,
  comparison,
  inverse,
  hint,
  requires,
  format = 'money',
  tone = 'default',
}: FinancialMetricProps) {
  const change = comparison?.changePct;
  const rising = change !== null && change !== undefined && change > 0;
  const good = inverse ? !rising : rising;

  return (
    <div className="min-w-40 flex-1 px-4 py-3">
      <p className="eyebrow">{label}</p>
      {value === null ? (
        <p
          className="mt-0.5 text-lg leading-7 font-medium text-faint"
          title={requires ?? 'Nothing has been posted for this period.'}
        >
          —
        </p>
      ) : (
        <p className={cn('mt-0.5 text-xl leading-7 font-semibold tabular-nums', TONE[tone])}>
          {render(value, format)}
        </p>
      )}
      {change !== null && change !== undefined ? (
        <p
          className={cn(
            'mt-0.5 inline-flex items-center gap-1 text-xs font-medium',
            good ? 'text-success-text' : 'text-danger-text',
          )}
        >
          <Delta direction={rising ? 'up' : 'down'} />
          {Math.abs(change).toFixed(1)}%<span className="font-normal text-muted">vs previous</span>
        </p>
      ) : comparison && comparison.previous === null && value !== null ? (
        <p
          className="mt-0.5 text-xs text-faint"
          title="The previous period has no postings to compare against."
        >
          No comparison
        </p>
      ) : hint ? (
        <p className="mt-0.5 text-xs text-faint">{hint}</p>
      ) : null}
    </div>
  );
}

export function FinancialSummaryStrip({
  metrics,
  loading,
  className,
}: {
  metrics: FinancialMetricProps[];
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
      {metrics.map((metric, index) => (
        <div
          key={metric.label}
          className={cn('flex min-w-40 flex-1', index > 0 && 'border-l border-line')}
        >
          {loading ? (
            <div className="min-w-40 flex-1 px-4 py-3">
              <p className="eyebrow">
                {metric.label}
              </p>
              <span className="mt-1 block h-6 w-24 animate-pulse rounded bg-surface-muted" />
            </div>
          ) : (
            <FinancialMetric {...metric} />
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Clickable count strip
// ---------------------------------------------------------------------------------------------

export interface CountSegment {
  key: string;
  label: string;
  count: number | null;
  amount?: number | null;
  tone?: 'default' | 'warning' | 'danger' | 'success';
  onSelect?: () => void;
}

const SEGMENT_TONE: Record<NonNullable<CountSegment['tone']>, string> = {
  default: 'text-ink',
  warning: 'text-warning-text',
  danger: 'text-danger-text',
  success: 'text-success-text',
};

export function AccountingSummaryStrip({
  segments,
  activeKey,
  loading,
  className,
}: {
  segments: CountSegment[];
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
              <>
                <span
                  className={cn(
                    'mt-0.5 block text-2xl leading-8 font-semibold tabular-nums',
                    SEGMENT_TONE[segment.tone ?? 'default'],
                  )}
                >
                  {segment.count === null ? '—' : formatNumber(segment.count)}
                </span>
                {segment.amount !== undefined ? (
                  <span className="mt-0.5 block text-xs text-muted tabular-nums">
                    {segment.amount === null ? '—' : formatMoney(segment.amount, { compact: true })}
                  </span>
                ) : null}
              </>
            )}
          </>
        );
        const shared = cn(
          'min-w-28 flex-1 px-4 py-3 text-left',
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
// Needs attention
// ---------------------------------------------------------------------------------------------

const EXCEPTION_TONE: Record<
  AccountingException['severity'],
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
 * What needs a person today, with the money attached.
 *
 * Renders nothing when the books are clean; its absence is the all-clear. Each row states the
 * count, the amount, and why it matters — which is what the brief asks every financial exception
 * to answer.
 */
export function NeedsAttentionPanel({
  items,
  onSelect,
  className,
}: {
  items: AccountingException[];
  onSelect: (item: AccountingException) => void;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <section
      aria-labelledby="accounting-needs-attention"
      className={cn('rounded-xl border border-line bg-surface p-4', className)}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="accounting-needs-attention"
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
                  {item.amount !== null ? (
                    <span className={cn('block text-sm font-semibold tabular-nums', tone.text)}>
                      {formatMoney(item.amount)}
                    </span>
                  ) : null}
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
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Aging bar
// ---------------------------------------------------------------------------------------------

export interface AgingSegment {
  key: string;
  label: string;
  amount: number;
  tone: 'success' | 'info' | 'warning' | 'danger' | 'critical';
}

const BAR_TONE: Record<AgingSegment['tone'], string> = {
  success: 'bg-success',
  info: 'bg-info',
  warning: 'bg-warning',
  danger: 'bg-danger',
  critical: 'bg-danger-hover',
};

/**
 * Aging as one bar plus its figures.
 *
 * The bar is proportional to the real amounts, so a sliver genuinely is a sliver. A chart that
 * rounds small buckets up to a visible minimum is a chart that misrepresents the thing it exists
 * to show.
 */
export function AgingPanel({
  title,
  segments,
  total,
  onSelect,
  className,
}: {
  title: string;
  segments: AgingSegment[];
  total: number;
  onSelect?: (key: string) => void;
  className?: string;
}) {
  return (
    <Card className={cn('flex flex-col gap-3 p-4', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-md font-bold text-ink">{title}</h3>
        <span className="text-sm font-semibold tabular-nums text-ink">{formatMoney(total)}</span>
      </div>

      {total > 0 ? (
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-nw-track">
          {segments.map((segment) =>
            segment.amount > 0 ? (
              <span
                key={segment.key}
                className={BAR_TONE[segment.tone]}
                style={{ width: `${(segment.amount / total) * 100}%` }}
                title={`${segment.label}: ${formatMoney(segment.amount)}`}
              />
            ) : null,
          )}
        </div>
      ) : (
        <p className="text-sm text-faint">Nothing outstanding.</p>
      )}

      <ul className="divide-y divide-line-soft">
        {segments.map((segment) => {
          const row = (
            <>
              <span className="flex items-center gap-2 text-sm text-secondary">
                <span
                  aria-hidden
                  className={cn('size-2 shrink-0 rounded-full', BAR_TONE[segment.tone])}
                />
                {segment.label}
              </span>
              <span className="text-sm font-medium tabular-nums text-ink">
                {formatMoney(segment.amount)}
              </span>
            </>
          );
          return (
            <li key={segment.key}>
              {onSelect ? (
                <button
                  type="button"
                  onClick={() => onSelect(segment.key)}
                  className="flex w-full items-center justify-between gap-3 rounded-md py-2 text-left transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                >
                  {row}
                </button>
              ) : (
                <div className="flex items-center justify-between gap-3 py-2">{row}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Detail anatomy
// ---------------------------------------------------------------------------------------------

export function AccountingPanel({
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

export function AccountingFactList({
  facts,
  className,
}: {
  facts: Array<{ label: string; value: ReactNode; title?: string; emphasis?: boolean }>;
  className?: string;
}) {
  return (
    <dl className={cn('divide-y divide-line-soft', className)}>
      {facts.map((fact) => (
        <div key={fact.label} className="flex items-baseline justify-between gap-4 py-2">
          <dt className="shrink-0 text-sm text-muted">{fact.label}</dt>
          <dd
            className={cn(
              'min-w-0 text-right text-sm tabular-nums',
              fact.emphasis ? 'font-semibold text-ink' : 'text-ink',
            )}
            title={fact.title}
          >
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A figure that may not exist. Never renders a zero for missing data. */
export function Money({
  value,
  requires,
  className,
}: {
  value: number | null;
  requires?: string;
  className?: string;
}) {
  if (value === null) {
    return (
      <span className={cn('text-faint', className)} title={requires ?? 'Not recorded'}>
        —
      </span>
    );
  }
  return <span className={cn('tabular-nums', className)}>{formatMoney(value)}</span>;
}
