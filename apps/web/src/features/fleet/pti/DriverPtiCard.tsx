import { useState } from 'react';
import { Badge, cn } from '@/design-system';
import { type DriverPtiRow, type DriverPtiState, driverPti } from './board-view';

const STATE: Record<DriverPtiState, { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  sent: { label: 'Sent', tone: 'success' },
  waiting: { label: 'Not sent yet', tone: 'warning' },
  missed: { label: 'Missed', tone: 'danger' },
};

type Summary = ReturnType<typeof driverPti>;

/**
 * Drivers this week (owner, 2026-10-12): the fifth counter beside Clean, in the same look. How
 * many drivers sent their PTI out of those on a unit; tap it for the names.
 */
export function DriverPtiTile({ summary: d, loading, on, onToggle }: { summary: Summary; loading: boolean; on: boolean; onToggle: () => void }) {
  const notSent = d.waiting.length + d.missed.length;
  const pct = d.total > 0 ? Math.round((d.sent.length / d.total) * 100) : 0;
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      data-testid="driver-pti"
      className={cn(
        'col-span-2 rounded-[10px] border border-nw-border border-t-[3px] border-t-nw-accent bg-nw-panel px-3.5 py-3 text-left hover:bg-nw-hover sm:col-span-1',
        on && 'outline-2 -outline-offset-2 outline-nw-accent',
      )}
    >
      <span className="tabular block text-[25px] leading-[1.05] font-extrabold tracking-[-.03em] text-nw-text" data-testid="driver-pti-summary">
        {loading ? '…' : (
          <>
            {d.sent.length}
            <span className="text-[15px] font-bold text-nw-text-3">/{d.total}</span>
          </>
        )}
      </span>
      <span className="mt-0.5 block text-[12.5px] font-bold text-nw-text">Drivers sent PTI</span>
      <span className="mt-0.5 block text-[10.5px] text-nw-text-3">
        {loading ? 'Loading…' : d.total === 0 ? 'No drivers on a unit' : `${notSent} not sent${d.missed.length > 0 ? ` · ${d.missed.length} missed` : ''}`}
      </span>
      {!loading && d.total > 0 ? (
        <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-nw-subtle" aria-hidden>
          <span className="block h-full rounded-full bg-nw-done-icon" style={{ width: `${pct}%` }} />
        </span>
      ) : null}
    </button>
  );
}

/** The names behind the tile: who has not sent (missed first), or who has. */
export function DriverPtiList({ summary: d, current, onOpen }: { summary: Summary; current: boolean; onOpen: (unitId: string) => void }) {
  const [tab, setTab] = useState<'not' | 'sent'>('not');
  const notSent = [...d.missed, ...d.waiting];
  const list: DriverPtiRow[] = tab === 'sent' ? d.sent : notSent;
  return (
    <section className="rounded-[10px] border border-nw-border bg-nw-panel px-4 py-3.5" data-testid="driver-pti-list">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-2 text-[12.5px] font-bold text-nw-text">Drivers this week</p>
        {(['not', 'sent'] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            className={cn('h-7 rounded-md px-2.5 text-xs font-semibold', tab === t ? 'bg-nw-selected text-nw-text' : 'text-nw-text-3 hover:bg-nw-hover')}
            data-testid={t === 'not' ? 'driver-pti-not-sent' : 'driver-pti-sent'}
          >
            {t === 'not' ? `Not sent ${notSent.length}` : `Sent ${d.sent.length}`}
          </button>
        ))}
      </div>
      <ul className="mt-2.5 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {list.length === 0 ? (
          <li className="px-2 py-1.5 text-sm text-nw-text-3">{tab === 'sent' ? 'Nobody has sent one yet.' : current ? 'Every driver has sent theirs.' : 'Every driver sent theirs.'}</li>
        ) : null}
        {list.map((r) => (
          <li key={r.driverId}>
            <button type="button" onClick={() => onOpen(r.unitId)} className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-nw-hover">
              <span className="min-w-0 truncate text-sm text-nw-text">
                {r.driverName} <span className="text-nw-text-3">· Unit {r.unitNumber}</span>
              </span>
              <Badge tone={STATE[r.state].tone} size="sm" dot>
                {STATE[r.state].label}
              </Badge>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
