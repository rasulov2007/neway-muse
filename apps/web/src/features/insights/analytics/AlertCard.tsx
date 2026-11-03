import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { METRICS, type Insight } from '@neway/shared';
import { StatusSymbol } from '@/design-system';
import { AnCard, AnCardHeader, StatusTag } from './ui';

const SEVERITY = {
  critical: { label: 'Critical', family: 'urgent' },
  warning: { label: 'Warning', family: 'warning' },
  info: { label: 'Info', family: 'info' },
} as const;

/** One finding: severity (symbol + word + colour), what moved, the numbers, and where to go. */
export function AlertCard({ insight }: { insight: Insight }) {
  const severity = SEVERITY[insight.severity];
  return (
    <li className="flex flex-col gap-2 rounded-2xl border border-an-card-border bg-an-card px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <StatusTag family={severity.family} label={severity.label} />
        {insight.href ? (
          <Link
            to={insight.href as never}
            className="inline-flex h-7 items-center gap-1 rounded-an-pill bg-an-accent-tint px-3 text-xs font-semibold text-an-accent-ink hover:bg-an-accent hover:text-an-on-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-an-accent"
            aria-label={`Open ${insight.entity?.label ?? 'record'}`}
          >
            Open
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        ) : null}
      </div>
      <p className="text-sm leading-5 font-semibold text-nw-text">{insight.title}</p>
      <p className="text-xs text-nw-text-2">{insight.action}</p>
      <p className="text-xs text-nw-text-3 tabular-nums">
        {/* A metric this build does not know yet (added on the server) still reads by its key. */}
        {(METRICS as Partial<typeof METRICS>)[insight.evidence.metric]?.label ?? insight.evidence.metric}: {insight.evidence.previous?.toFixed(2) ?? '—'} →{' '}
        {insight.evidence.current?.toFixed(2) ?? '—'}
      </p>
    </li>
  );
}

export function NeedsAttention({ insights }: { insights: Insight[] }) {
  return (
    <AnCard className="flex min-w-0 flex-col">
      <AnCardHeader
        id="needs-attention"
        title="Needs attention"
        description={insights.length > 0 ? `${insights.length} finding${insights.length === 1 ? '' : 's'}` : undefined}
      />
      <div className="px-4 pb-4">
        {insights.length === 0 ? (
          <p className="flex items-start gap-2 rounded-2xl bg-nw-done-bg px-3.5 py-3 text-sm text-nw-done-text">
            <StatusSymbol family="done" size={14} className="mt-0.5 text-nw-done-icon" />
            <span>
              Nothing moved far enough this period to flag. Only changes above the reporting
              threshold, on units with enough miles to compare, appear here.
            </span>
          </p>
        ) : (
          <ul aria-labelledby="needs-attention" className="flex max-h-[520px] flex-col gap-2 overflow-y-auto pr-1">
            {insights.map((insight) => (
              <AlertCard key={insight.key} insight={insight} />
            ))}
          </ul>
        )}
      </div>
    </AnCard>
  );
}
