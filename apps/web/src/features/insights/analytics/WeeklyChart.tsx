import { useState } from 'react';
import { cn } from '@/design-system';
import { formatIsoDate, formatMoney } from '@/lib/format';
import type { TrendPoint } from '../useInsights';
import { AnCard, AnCardHeader, EmptyCard } from './ui';
import { axisPosition, chartAxis } from './view-model';

const SERIES = [
  { key: 'gross', label: 'Gross', bar: 'bg-an-gross' },
  { key: 'cost', label: 'Cost', bar: 'bg-an-cost' },
  { key: 'profit', label: 'Profit', bar: 'bg-an-profit' },
] as const;

function money(value: number): string {
  return formatMoney(value, { compact: true });
}

const WEEK_LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Oct 19" for a week start, read as a calendar day (no zone shift). */
function weekLabel(iso: string): string {
  return WEEK_LABEL.format(new Date(`${iso}T12:00:00Z`));
}

/**
 * Bar width by how many weeks share the plot (owner, 2026-10-25: "make it prettier"): a month of
 * weeks gets solid bars, a quarter thinner ones, so the plot never looks empty or crowded.
 */
function barWidth(weeks: number, series: number): { bar: string; group: string } {
  // One series on the plot (e.g. cost only while revenue is not connected): one broad bar a week.
  if (series === 1) return weeks <= 6 ? { bar: 'w-12', group: 'max-w-28' } : { bar: 'w-6', group: 'max-w-16' };
  if (weeks <= 6) return { bar: 'w-6', group: 'max-w-28 gap-1.5' };
  if (weeks <= 10) return { bar: 'w-4', group: 'max-w-20 gap-1' };
  return { bar: 'w-3', group: 'max-w-16 gap-1' };
}

/**
 * Weekly gross, cost and profit, from the server's trend.
 *
 * Bars, not a line: these are separate weeks, and a line between two week totals implies values in
 * between that do not exist. A week with no cost data draws no cost bar and no profit bar — a zero
 * bar would claim a cost of zero — and its tooltip says "No cost data". A loss hangs below the
 * zero line.
 */
export function WeeklyChart({ points }: { points: TrendPoint[] }) {
  const [active, setActive] = useState<string | null>(null);

  if (points.length === 0) {
    return (
      <EmptyCard
        title="No financial data for this period"
        description="Weekly performance appears here once loads are delivered in the range."
      />
    );
  }

  const axis = chartAxis(points);
  const zero = axisPosition(axis, 0);
  // A series with nothing in it this period (e.g. no loads in NeWay Loads) stays in the legend,
  // muted and marked, and draws no bars at all.
  const empty = new Set(
    SERIES.filter((series) => points.every((p) => p[series.key] === null || p[series.key] === 0)).map((s) => s.key),
  );
  const labelled = points.length <= 6;
  const size = barWidth(points.length, SERIES.length - empty.size);

  return (
    <AnCard className="flex min-w-0 flex-col">
      <AnCardHeader
        title="Weekly performance"
        description="Gross, cost and profit per reporting week — the same buckets the weekly board uses."
        actions={
          <ul className="flex flex-wrap gap-3 text-xs text-nw-text-2" aria-label="Legend">
            {SERIES.map((series) => (
              <li key={series.key} className={cn('flex items-center gap-1.5', empty.has(series.key) && 'text-nw-text-3')}>
                <span aria-hidden className={cn('size-2.5 rounded-full', series.bar, empty.has(series.key) && 'opacity-30')} />
                {series.label}
                {empty.has(series.key) ? <span className="text-[11px]">· no data</span> : null}
              </li>
            ))}
          </ul>
        }
      />
      <div className="flex min-w-0 gap-3 px-5 pt-4 pb-4">
        {/* Axis labels */}
        <div aria-hidden className="relative mt-5 h-64 w-12 shrink-0 text-right text-[11px] text-nw-text-3">
          {axis.ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 translate-y-1/2 tabular-nums"
              style={{ bottom: `${axisPosition(axis, tick)}%` }}
            >
              {money(tick)}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="relative mt-5 h-64" style={{ minWidth: `${points.length * 56}px` }}>
            {/* Dashed gridlines */}
            {axis.ticks.map((tick) => (
              <span
                key={tick}
                aria-hidden
                className={cn(
                  'absolute inset-x-0 border-t',
                  tick === 0 ? 'border-solid border-an-grid' : 'border-dashed border-an-grid',
                )}
                style={{ bottom: `${axisPosition(axis, tick)}%` }}
              />
            ))}
            <ol className="absolute inset-0 flex items-stretch" aria-label="Weekly gross, cost and profit">
              {points.map((point, index) => {
                const open = active === point.weekStart;
                // A week with nothing to draw says so instead of leaving a gap that reads as zero.
                const blank = SERIES.every((series) => empty.has(series.key) || point[series.key] === null || point[series.key] === 0);
                // One figure per week, over its tallest bar, so labels never collide.
                const top = SERIES.filter((series) => !empty.has(series.key)).reduce<(typeof SERIES)[number]['key'] | null>(
                  (best, series) => ((point[series.key] ?? 0) > (best ? (point[best] ?? 0) : 0) ? series.key : best),
                  null,
                );
                const summary = SERIES.flatMap((series) => {
                  const value = point[series.key];
                  if (series.key === 'profit' && value === null) return [];
                  return [`${series.label} ${value === null ? 'no cost data' : money(value)}`];
                }).join(', ');
                return (
                  <li
                    key={point.weekStart}
                    tabIndex={0}
                    aria-label={`Week of ${formatIsoDate(point.weekStart)}: ${summary}`}
                    onMouseEnter={() => setActive(point.weekStart)}
                    onMouseLeave={() => setActive(null)}
                    onFocus={() => setActive(point.weekStart)}
                    onBlur={() => setActive(null)}
                    className="group relative flex flex-1 justify-center rounded-lg outline-none focus-visible:bg-an-pill-track hover:bg-an-pill-track/60"
                  >
                    {blank ? (
                      <span
                        aria-hidden
                        className="absolute inset-x-0 text-center text-[11px] text-nw-text-3"
                        style={{ bottom: `calc(${zero}% + 6px)` }}
                      >
                        No data
                      </span>
                    ) : null}
                    <div className={cn('relative flex h-full w-full justify-center', size.group)}>
                      {SERIES.map((series) => {
                        const value = point[series.key];
                        // Nothing to draw for a missing or zero value: a stub would read as a figure.
                        if (value === null || value === 0 || empty.has(series.key)) return null;
                        const position = axisPosition(axis, value);
                        const negative = value < 0;
                        return (
                          <span key={series.key} className={cn('relative', size.bar)}>
                            <span
                              data-series={series.key}
                              className={cn(
                                'absolute inset-x-0',
                                'transition-[filter] duration-150 group-hover:brightness-110',
                                negative ? 'rounded-b-[6px] bg-an-loss' : cn('rounded-t-[6px]', series.bar),
                              )}
                              style={
                                negative
                                  ? { top: `${100 - zero}%`, height: `${zero - position}%` }
                                  : {
                                      bottom: `${zero}%`,
                                      height: `max(2px, ${position - zero}%)`,
                                    }
                              }
                            />
                            {labelled && !negative && series.key === top ? (
                              <span
                                aria-hidden
                                className="absolute left-1/2 -translate-x-1/2 pb-1 text-[11px] font-semibold whitespace-nowrap text-nw-text tabular-nums"
                                style={{ bottom: `${position}%` }}
                              >
                                {money(value)}
                              </span>
                            ) : null}
                          </span>
                        );
                      })}
                    </div>
                    {open ? (
                      <div
                        role="tooltip"
                        // A white card beside the week, never over its bars; the last weeks open to the left.
                        className={cn(
                          'pointer-events-none absolute top-6 z-10 w-max rounded-xl border border-an-card-border bg-an-card px-3.5 py-2.5 text-xs text-nw-text shadow-menu',
                          index >= points.length - Math.max(1, Math.floor(points.length / 3)) ? 'right-[calc(50%+3.5rem)]' : 'left-[calc(50%+3.5rem)]',
                        )}
                      >
                        <p className="font-semibold text-nw-text">Week of {formatIsoDate(point.weekStart)}</p>
                        <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
                          {SERIES.map((series) => {
                            const value = point[series.key];
                            // Profit only when the week has both sides; the cost row says why not.
                            if (series.key === 'profit' && value === null) return null;
                            return (
                              <div key={series.key} className="contents">
                                <dt className="flex items-center gap-1.5">
                                  <span aria-hidden className={cn('size-2 rounded-[2px]', series.bar)} />
                                  {series.label}
                                </dt>
                                <dd className="text-right tabular-nums">
                                  {value === null ? 'No cost data' : money(value)}
                                </dd>
                              </div>
                            );
                          })}
                        </dl>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </div>
          <div aria-hidden className="flex" style={{ minWidth: `${points.length * 56}px` }}>
            {points.map((point) => (
              <span
                key={point.weekStart}
                className="flex-1 pt-2 text-center text-[11px] whitespace-nowrap text-nw-text-3"
              >
                {weekLabel(point.weekStart)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </AnCard>
  );
}
