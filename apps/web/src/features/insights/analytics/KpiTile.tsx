import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { METRICS, describeChange, type MetricComparison } from '@neway/shared';
import { Sparkline, cn } from '@/design-system';
import { useCountUp } from './useCountUp';
import { AnCard, FormulaInfo } from './ui';
import { deltaDirection, formatMetric } from './view-model';

export type SparkSeries = 'gross' | 'cost' | 'profit' | 'miles';

const SPARK_COLOR: Record<SparkSeries, string> = {
  gross: 'var(--nw-an-series-gross)',
  cost: 'var(--nw-an-series-cost)',
  profit: 'var(--nw-an-series-profit)',
  miles: 'var(--nw-an-series-gross)',
};

/** The figure, counting to its value once it has arrived. Screen readers hear the final value. */
export function CountUpValue({
  value,
  format,
  className,
}: {
  value: number | null;
  format: (value: number | null) => string;
  className?: string;
}) {
  const shown = useCountUp(value);
  const final = format(value);
  return (
    <span className={className}>
      <span aria-hidden>{format(shown === null ? null : value === null ? null : shown)}</span>
      <span className="sr-only">{final}</span>
    </span>
  );
}

/**
 * A metric card: tinted icon chip, big number, change against the previous period, and a
 * sparkline only where the server has a value per week for that metric.
 */
export function KpiTile({
  metric,
  icon,
  sparkline,
  sparkSeries,
  label: labelOverride,
  unavailableReason,
  details,
}: {
  metric: MetricComparison;
  icon: ReactNode;
  sparkline?: (number | null)[] | null;
  sparkSeries?: SparkSeries;
  /** A clearer name where two metrics share one ("Empty miles" as miles and as a share). */
  label?: string;
  /** Why the server withheld this figure (e.g. profit from one side only); shown under the dash. */
  unavailableReason?: string | null;
  /** Figures behind the number, shown in the formula popover. */
  details?: ReadonlyArray<{ label: string; value: string }>;
}) {
  const withheld = metric.current === null && unavailableReason ? unavailableReason : null;
  // A change written as a sentence ("No activity in the previous period") is text, not a pill.
  const sentence = /^No /.test(describeChange(metric));
  // Tolerant of a metric the server adds before this build knows it: no formula, nothing breaks.
  const definition = (METRICS as Partial<typeof METRICS>)[metric.key];
  const label = labelOverride ?? metric.label;
  const direction = deltaDirection(metric);
  const tone =
    metric.verdict === 'better' ? 'better' : metric.verdict === 'worse' ? 'worse' : 'neutral';
  const Arrow = direction === 'up' ? ArrowUpRight : direction === 'down' ? ArrowDownRight : ArrowRight;

  return (
    <AnCard lift className="flex h-full min-w-0 flex-col gap-3 p-4" data-testid={`kpi-${metric.key}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-an-accent-tint text-an-accent-ink [&_svg]:size-4"
          >
            {icon}
          </span>
          <span className="truncate text-[12.5px] font-semibold text-nw-text-2" title={label}>{label}</span>
        </span>
        {definition ? (
          <FormulaInfo label={label} formula={definition.formula} details={details} />
        ) : null}
      </div>

      <CountUpValue
        value={metric.current}
        format={(value) => formatMetric(metric.unit, value)}
        className={cn(
          'min-w-0 text-[22px] leading-7 font-extrabold tracking-[-0.02em] break-words tabular-nums',
          metric.current === null ? 'text-nw-text-3' : 'text-nw-text',
        )}
      />

      <div className="mt-auto flex items-end justify-between gap-2">
      <div className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {withheld ? (
          <span className="text-xs text-nw-text-2" data-testid={`withheld-${metric.key}`}>
            {withheld}
          </span>
        ) : direction === 'none' ||
          sentence ? (
          // Sentences ("No activity in the previous period") read as text, not as a change pill.
          <span className="text-xs text-nw-text-3">{describeChange(metric)}</span>
        ) : (
          <span
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-an-pill px-2 text-xs font-bold tabular-nums',
              tone === 'better'
                ? 'bg-nw-done-bg text-nw-done-text'
                : tone === 'worse'
                  ? 'bg-nw-urgent-bg text-nw-urgent-text'
                  : 'bg-nw-neutral-bg text-nw-neutral-text',
            )}
          >
            <Arrow aria-hidden className="size-3.5" />
            <span className="sr-only">
              {direction === 'up' ? 'Up ' : direction === 'down' ? 'Down ' : 'Unchanged '}
            </span>
            {describeChange(metric)}
            <span className="sr-only">
              {tone === 'better' ? ', better' : tone === 'worse' ? ', worse' : ''}
            </span>
          </span>
        )}
        {!withheld && direction !== 'none' && !sentence ? (
          <span className="text-2xs text-nw-text-3">vs previous period</span>
        ) : null}
      </div>
        {sparkline && sparkSeries ? (
          <div className="w-16 shrink-0" data-testid={`spark-${metric.key}`}>
            <Sparkline data={sparkline} color={SPARK_COLOR[sparkSeries]} width={64} height={26} />
          </div>
        ) : null}
      </div>
    </AnCard>
  );
}

/** A plain figure card for values with no comparison (fuel, workforce counts). */
export function StatTileCard({
  label,
  value,
  format,
  icon,
  hint,
  info,
}: {
  label: string;
  value: number | null;
  format: (value: number | null) => string;
  icon: ReactNode;
  hint?: ReactNode;
  /** What the figure counts, behind an info button (keyboard and touch reachable). */
  info?: string;
}) {
  return (
    <AnCard lift className="flex h-full min-w-0 flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-an-accent-tint text-an-accent-ink [&_svg]:size-4"
          >
            {icon}
          </span>
          <span className="truncate text-[12.5px] font-semibold text-nw-text-2" title={label}>{label}</span>
        </span>
        {info ? <FormulaInfo label={label} formula={info} /> : null}
      </div>
      <CountUpValue
        value={value}
        format={format}
        className={cn(
          'text-[24px] leading-7 font-extrabold tracking-[-0.02em] tabular-nums',
          value === null ? 'text-nw-text-3' : 'text-nw-text',
        )}
      />
      {hint ? <span className="text-2xs text-nw-text-3">{hint}</span> : null}
    </AnCard>
  );
}
