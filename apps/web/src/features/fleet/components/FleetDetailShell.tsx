import { CircleCheck, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, cn } from '@/design-system';

/**
 * The pieces a Fleet 360 page is made of.
 *
 * Trucks, trailers and work orders all get the same detail anatomy — an identity header, a strip of
 * compact facts, then tabs — so a dispatcher who learns one learns all three. Keeping the anatomy
 * here rather than in each page is what stops Trailers becoming a divergent copy of Trucks.
 */

export interface FleetMetric {
  label: string;
  /** Already formatted. Pass `null` for "not recorded" so the strip renders it honestly. */
  value: ReactNode | null;
  hint?: string;
  tone?: 'default' | 'warning' | 'danger' | 'success';
  /** Explains an unavailable value on hover, e.g. what the figure would need. */
  title?: string;
}

const TONE: Record<NonNullable<FleetMetric['tone']>, string> = {
  default: 'text-ink',
  warning: 'text-warning-text',
  danger: 'text-danger-text',
  success: 'text-success-text',
};

/** A row of compact facts. Never a row of oversized KPI cards — this sits under a page header. */
export function FleetMetricStrip({
  metrics,
  className,
}: {
  metrics: FleetMetric[];
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
              Insufficient data
            </p>
          ) : (
            <p
              className={cn(
                'mt-0.5 text-lg leading-7 font-semibold tabular-nums',
                TONE[metric.tone ?? 'default'],
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

/** A labelled fact list, used inside the Overview columns of every 360 page. */
export function FleetFactList({
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

/** A titled card used as an Overview column. */
export function FleetPanel({
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

const BAR_TONE = {
  info: 'border-info-border bg-info-soft',
  success: 'border-success-border bg-success-soft',
  neutral: 'border-line-soft bg-surface-muted',
} as const;

/**
 * A soft, one-line information bar: the note under a card's facts ("Assignments are managed from
 * the truck record"), or the confirmation under a page header. Never an alert — it carries a fact,
 * not a warning, so it must not compete with the warning tones around it.
 */
export function FleetInfoBar({
  tone = 'info',
  icon,
  className,
  children,
}: {
  tone?: keyof typeof BAR_TONE;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs text-secondary',
        BAR_TONE[tone],
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'mt-px shrink-0 [&_svg]:size-3.5',
          tone === 'success' ? 'text-success' : tone === 'info' ? 'text-info' : 'text-muted',
        )}
      >
        {icon ?? <Info />}
      </span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/**
 * The compact green confirmation the brief asks for after a service is booked.
 *
 * It states the booking as a fact with the number that makes it actionable, and nothing more —
 * a scheduled service is good news, not an alert, so it must not compete with the warning tones
 * above it.
 */
export function FleetScheduledNotice({ children }: { children: ReactNode }) {
  return (
    <FleetInfoBar tone="success" icon={<CircleCheck />}>
      <span className="font-medium text-success-text">{children}</span>
    </FleetInfoBar>
  );
}
