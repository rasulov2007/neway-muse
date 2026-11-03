import type { Load, Stop } from '@/demo';
import { Card, cn } from '@/design-system';
import { formatMiles } from '@/lib/format';
import { formatAppointment, formatInstant } from '@neway/shared';

function StopNode({ stop, index, total }: { stop: Stop; index: number; total: number }) {
  const active = stop.status === 'in_progress';
  const kindLabel = stop.kind === 'pickup' ? 'Pickup' : 'Delivery';
  return (
    <li className="flex min-w-56 flex-1 flex-col">
      <div
        className={cn(
          'flex flex-1 flex-col gap-1.5 rounded-md border p-3',
          active ? 'border-primary-border bg-primary-soft' : 'border-line bg-surface',
        )}
      >
        {/* No status badge or progress line here: the lifecycle stepper at the
            top of the page already says where the load is. */}
        <span className="eyebrow">
          {kindLabel} · Stop {index + 1} of {total}
        </span>
        <div className="truncate text-sm font-medium text-ink" title={stop.facilityName}>
          {stop.facilityName}
        </div>
        <div className="text-sm text-secondary">
          {stop.city}, {stop.state}
        </div>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-muted">Appt</dt>
          <dd className="tabular text-ink">{formatAppointment(stop)}</dd>
          <dt className="text-muted">Arrived</dt>
          <dd className="tabular text-ink">
            <StopTime at={stop.arrivedAt} zone={stop.timezone} />
          </dd>
          <dt className="text-muted">Departed</dt>
          <dd className="tabular text-ink">
            <StopTime at={stop.departedAt} zone={stop.timezone} />
          </dd>
          {stop.detentionMinutes > 0 ? (
            <>
              <dt className="text-muted">Detention</dt>
              <dd className="tabular text-warning-text">{stop.detentionMinutes} min</dd>
            </>
          ) : null}
        </dl>
      </div>
    </li>
  );
}

/** The stops side by side, quiet: the page's stepper carries the lifecycle. */
export function RouteProgress({ load }: { load: Load }) {
  const stops = [...load.stops].sort((a, b) => a.sequence - b.sequence);
  return (
    <Card
      title="Route progress"
      description={`${load.origin.city}, ${load.origin.state} → ${load.destination.city}, ${load.destination.state} · ${formatMiles(load.loadedMiles)} loaded`}
    >
      <ol aria-label="Stops" className="scroll-quiet flex items-stretch gap-4 overflow-x-auto pb-1">
        {stops.map((stop, i) => (
          <StopNode key={stop.id} stop={stop} index={i} total={stops.length} />
        ))}
      </ol>
    </Card>
  );
}

/**
 * A time at a stop, in the stop's own clock (P0.4). The tooltip carries the same instant on the
 * company's clock and on the night desk's. "Not yet" is a fact, not a placeholder.
 */
export function StopTime({ at, zone }: { at: string | null; zone: string | null | undefined }) {
  if (!at) return <span className="text-muted">Not yet</span>;
  const f = formatInstant(at, zone);
  return (
    <span title={f.tooltip} className="whitespace-nowrap">
      {f.text}
    </span>
  );
}
