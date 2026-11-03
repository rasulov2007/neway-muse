import { Link } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { BREAKDOWN_STATUSES, BREAKDOWN_STATUS_LABEL, type BreakdownStatus } from '@neway/shared';
import { Badge, EmptyState, ErrorState, Input, PageHeader, cn } from '@/design-system';
import { formatDateTime } from '@/lib/format';
import { BREAKDOWN_TONE, useBreakdowns } from './api';

/**
 * Fleet → Breakdowns (mobile M3): what drivers reported from the road, newest first, with who is
 * working each one and where it stands. Open shows everything not closed; a case opens on its own
 * page where Fleet assigns it, arranges the shop and links the work order.
 */
export function BreakdownsPage() {
  const [scope, setScope] = useState<'open' | 'all'>('open');
  const [status, setStatus] = useState<BreakdownStatus | 'any'>('any');
  const [q, setQ] = useState('');
  const list = useBreakdowns(scope === 'open');
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data?.breakdowns ?? []).filter(
      (b) =>
        (status === 'any' || b.status === status) &&
        (!needle ||
          `${b.number} ${b.truck?.unitNumber ?? ''} ${b.trailer?.unitNumber ?? ''} ${b.driver?.name ?? ''} ${b.load?.loadNumber ?? ''} ${b.categoryLabel}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [list.data, status, q]);
  const counts = list.data?.counts;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Breakdowns"
        description={counts ? `${counts.open} open · ${counts.received} not picked up yet` : 'Loading…'}
        actions={
          <Input size="sm" prefix={<Search />} placeholder="Search case, unit, driver or load" aria-label="Search breakdowns" value={q} onChange={(e) => setQ(e.target.value)} className="w-72" />
        }
      />

      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Filter breakdowns">
        {(['open', 'all'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={scope === s}
            onClick={() => setScope(s)}
            className={cn('rounded-md border px-3 py-1.5 text-sm font-semibold', scope === s ? 'border-nw-accent bg-nw-accent-tint text-nw-accent-ink shadow-sm' : 'border-nw-border text-nw-text-2 hover:bg-nw-hover')}
          >
            {s === 'open' ? 'Open' : 'All'}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-nw-border" aria-hidden />
        {(['any', ...BREAKDOWN_STATUSES] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={status === s}
            onClick={() => setStatus(s)}
            className={cn('rounded-md px-2.5 py-1 text-[13px] font-medium', status === s ? 'bg-nw-accent-tint text-nw-accent-ink' : 'text-nw-text-2 hover:bg-nw-hover')}
          >
            {s === 'any' ? 'Any status' : `${BREAKDOWN_STATUS_LABEL[s]}${counts ? ` (${counts.byStatus[s]})` : ''}`}
          </button>
        ))}
      </div>

      <section aria-label="Breakdown cases" className="rounded-[10px] border border-nw-border-strong bg-nw-panel">
        {list.isError ? (
          <ErrorState onRetry={() => void list.refetch()} />
        ) : list.isPending ? (
          <p className="p-4 text-sm text-nw-text-3">Loading…</p>
        ) : rows.length === 0 ? (
          <EmptyState title={q || status !== 'any' ? 'No case matches' : scope === 'open' ? 'No open breakdowns' : 'No breakdowns reported yet'} description={scope === 'open' && !q ? 'Drivers report breakdowns from the driver app; they appear here as they arrive.' : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-sm" data-testid="breakdowns-table">
              <thead className="border-b border-nw-border text-left text-[13px] text-nw-text-2">
                <tr>
                  <th className="px-3 py-2 font-medium">Case</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Unit</th>
                  <th className="px-3 py-2 font-medium">Driver</th>
                  <th className="px-3 py-2 font-medium">Where</th>
                  <th className="px-3 py-2 font-medium">Working it</th>
                  <th className="px-3 py-2 font-medium">Reported</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nw-border">
                {rows.map((b) => (
                  <tr key={b.id} className="hover:bg-nw-hover">
                    <td className="px-3 py-3">
                      <Link to="/fleet/breakdowns/$breakdownId" params={{ breakdownId: b.id }} className="font-semibold text-nw-accent-ink hover:underline">
                        {b.number}
                      </Link>
                      <span className="block text-xs text-nw-text-3">{b.categoryLabel}</span>
                    </td>
                    <td className="px-3 py-3">
                      <Badge tone={BREAKDOWN_TONE[b.status]} dot size="sm">
                        {b.statusLabel}
                      </Badge>
                    </td>
                    <td className="px-3 py-3">
                      {b.truck ? `Truck ${b.truck.unitNumber}` : null}
                      {b.trailer ? <span className="block text-xs text-nw-text-3">Trailer {b.trailer.unitNumber}</span> : null}
                    </td>
                    <td className="px-3 py-3">
                      {b.driver?.name ?? '—'}
                      {b.load ? <span className="block text-xs text-nw-text-3">Load {b.load.loadNumber}</span> : null}
                    </td>
                    <td className="max-w-[220px] truncate px-3 py-3 text-nw-text-2" title={b.location?.text ?? undefined}>
                      {b.location?.text || 'Not given'}
                    </td>
                    <td className="px-3 py-3 text-nw-text-2">{b.responsible?.name ?? <span className="text-nw-text-3">Nobody yet</span>}</td>
                    <td className="px-3 py-3 tabular-nums text-nw-text-2">{formatDateTime(b.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
