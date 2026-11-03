import { Package } from 'lucide-react';
import { StatusBadge, cn } from '@/design-system';
import { useOperations } from '@/features/operations/useOperations';
import type { Load } from '@/demo';
import { formatRelative } from '@/lib/format';
import { ListCard } from '../ListCard';
import { RouterLink } from '../RouterLink';
import { hrefs, linkClass } from '../links';
import { DemoBadge } from './WidgetFrame';

const ROWS = 5;

export interface AtRiskLoadsWidgetProps {
  loads: Load[];
  /** Reference time for relative labels. */
  now: string;
}

/** Active loads with an exception (from the web demo API until the loads module exists). */
/**
 * Where every active load stands, in the four words a dispatcher acts on (rule 1.4).
 *
 * The counts add up to the active loads, and a load in "No update" is never counted as on time
 * — a stale position is an unknown, not a reassurance.
 */
function OnTimeSummary() {
  const ops = useOperations();
  const rows = ops.data?.loads ?? [];
  const active = rows.filter((r) => r.risk.state !== 'not_applicable');
  const count = (state: 'on_time' | 'at_risk' | 'late' | 'no_update') => active.filter((r) => r.delivery.state === state).length;
  const cells: { label: string; value: number; tone: string }[] = [
    { label: 'On time', value: count('on_time'), tone: 'text-nw-done-text' },
    { label: 'At risk', value: count('at_risk'), tone: 'text-nw-warning-text' },
    { label: 'Late', value: count('late'), tone: 'text-nw-urgent-text' },
    { label: 'No update', value: count('no_update'), tone: 'text-nw-text-3' },
  ];
  return (
    <div className="mt-2 grid grid-cols-4 gap-1 rounded-md bg-nw-subtle p-1.5" aria-label="Active loads by delivery outlook">
      {cells.map((c) => (
        <div key={c.label} className="rounded px-2 py-1 text-center">
          <div className={cn('tabular text-[16px] leading-none font-bold', ops.data ? c.tone : 'text-nw-text-3')}>
            {ops.data ? c.value : '…'}
          </div>
          <div className="mt-0.5 text-[11px] font-semibold tracking-[.04em] text-nw-text-3 uppercase">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

export function AtRiskLoadsWidget({ loads, now }: AtRiskLoadsWidgetProps) {
  return (
    <ListCard
      title={
        <span className="inline-flex items-center gap-2">
          At-risk loads
          <DemoBadge />
        </span>
      }
      count={loads.length}
      viewAllHref={hrefs.loads}
      // No claim that everything is on time: the strip above says what is, in four honest counts.
      empty={{
        icon: <Package />,
        title: 'No exceptions raised',
        description: 'See the counts above for where every active load stands.',
      }}
      description={<OnTimeSummary />}
      rows={loads.slice(0, ROWS).map((load) => (
        <div key={load.id} className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <RouterLink to={hrefs.load(load.loadNumber)} className={linkClass}>
                {load.loadNumber}
              </RouterLink>
              {load.exception ? <StatusBadge status={load.exception.code} size="sm" /> : null}
            </div>
            <p className="mt-0.5 truncate text-xs text-secondary">
              {load.origin.city}, {load.origin.state} → {load.destination.city},{' '}
              {load.destination.state}
            </p>
            {load.exception ? (
              <p className="mt-0.5 truncate text-xs text-muted">{load.exception.reason}</p>
            ) : null}
          </div>
          <div className="tabular shrink-0 text-right text-xs text-muted">
            <div className="eyebrow">ETA</div>
            <div className="mt-0.5 whitespace-nowrap text-secondary">
              {load.etaAt ? formatRelative(load.etaAt, { now }) : '—'}
            </div>
          </div>
        </div>
      ))}
    />
  );
}
