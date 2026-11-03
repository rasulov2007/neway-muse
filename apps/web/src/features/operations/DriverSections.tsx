import { loadStatusLabel } from '@/features/loads/loads-search';
import { useState, type ReactNode } from 'react';
import type { EvaluatedItem } from '@neway/shared';
import { Upload } from 'lucide-react';
import { UploadDocumentDialog } from '@/features/safety/UploadDocumentDialog';
import { Badge, Button, Card, StatusBadge } from '@/design-system';
import { hrefs, useGo } from '@/features/dashboard/links';
import {
  formatDate,
  formatDateTime,
  formatMiles,
  formatMoney,
  formatNumber,
  formatPhone,
} from '@/lib/format';
import {
  DASH,
  DRIVER_AVAILABILITY_LABEL,
  DRIVER_AVAILABILITY_TONE,
  DRIVER_TYPE_LABEL,
} from './operations-ui';
import type { OperationalDriver } from './useOperations';

/** Enough history to judge a driver without turning the panel into a load list. */
const LOAD_LIMIT = 25;

// ---------------------------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------------------------

export function Definition({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

/** An unknown figure is stated, never printed as zero. */
function Figure({ value, format }: { value: number | null; format: (value: number) => string }) {
  if (value === null) {
    return (
      <span className="text-faint italic" title="The loads behind this figure could not be priced">
        Insufficient data
      </span>
    );
  }
  return <>{format(value)}</>;
}

const money = (value: number) => formatMoney(value);
const percent = (value: number) => `${value}%`;

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

export function OverviewTab({ row }: { row: OperationalDriver }) {
  const d = row.driver;
  const availability = row.availability;
  return (
    <div className="flex flex-col gap-4">
      <Card padding="md">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
          <Definition label="Phone">{formatPhone(d.phone)}</Definition>
          <Definition label="Email">{d.email}</Definition>
          <Definition label="Employment">
            {DRIVER_TYPE_LABEL[d.driverType] ?? d.driverType}
            <span className="block text-xs text-muted">Dispatcher {d.dispatcherName}</span>
          </Definition>
          <Definition label="Status">
            <StatusBadge status={d.status} size="sm" />
          </Definition>
          <Definition label="Home terminal">
            {d.homeCity}, {d.homeState}
          </Definition>
          <Definition label="Hired">{formatDate(d.hireDate)}</Definition>
        </dl>
      </Card>

      <Card title="Availability" padding="md">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={DRIVER_AVAILABILITY_TONE[availability.state]} size="sm">
            {DRIVER_AVAILABILITY_LABEL[availability.state]}
          </Badge>
          <span className="text-sm text-secondary">
            {availability.assignable ? 'Can take a load now' : 'Cannot take a load now'}
          </span>
        </div>
        {availability.blocker ? (
          <p className="mt-2 rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger-text">
            {availability.blocker}
          </p>
        ) : null}
        <ul className="mt-2 flex flex-col gap-0.5">
          {availability.reasons.map((reason) => (
            <li key={reason} className="text-xs text-muted">
              · {reason}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Assignment" padding="md">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
          <Definition label="Current load">
            {row.currentLoad ? (
              <span className="flex flex-wrap items-center gap-2">
                {row.currentLoad.loadNumber}
                <StatusBadge status={row.currentLoad.status} size="sm" />
              </span>
            ) : (
              <span className="text-muted">None</span>
            )}
          </Definition>
          <Definition label="Unit">
            {row.driver.currentTruckUnit ?? <span className="text-muted">Unassigned</span>}
          </Definition>
          <Definition label="Trailer">
            {row.currentLoad?.trailerUnit ?? <span className="text-muted">None</span>}
          </Definition>
          <Definition label="Lane">
            {row.currentLoad ? (
              <span className="whitespace-nowrap">
                {row.currentLoad.origin.city}, {row.currentLoad.origin.state}
                <span className="text-faint"> → </span>
                {row.currentLoad.destination.city}, {row.currentLoad.destination.state}
              </span>
            ) : (
              DASH
            )}
          </Definition>
        </dl>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------------------------

export function LoadsTab({ row }: { row: OperationalDriver }) {
  const go = useGo();
  // Most recent first by booking time; the array from the bundle is in dataset order.
  const loads = [...row.loads]
    .sort((a, b) => (a.bookedAt < b.bookedAt ? 1 : -1))
    .slice(0, LOAD_LIMIT);

  if (loads.length === 0) {
    return <Card padding="md">This driver has not been assigned a load yet.</Card>;
  }

  return (
    <Card
      title="Loads"
      description={
        row.loads.length > LOAD_LIMIT
          ? `Most recent ${LOAD_LIMIT} of ${row.loads.length}`
          : `${row.loads.length} total`
      }
      padding="sm"
    >
      <ul className="divide-y divide-line-soft">
        {loads.map((load) => (
          <li key={load.id} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <button
                type="button"
                className="rounded-xs text-sm font-medium text-primary-text hover:underline"
                onClick={() => go(hrefs.load(load.loadNumber))}
              >
                {load.loadNumber}
              </button>
              <p className="truncate text-xs text-muted">
                {load.origin.city}, {load.origin.state} → {load.destination.city},{' '}
                {load.destination.state} · {formatDateTime(load.pickupAt)}
              </p>
            </div>
            <span className="tabular shrink-0 text-right text-sm text-secondary">
              {formatMiles(load.loadedMiles + load.emptyMiles)}
            </span>
            <StatusBadge status={load.status} label={loadStatusLabel(load.status)} size="sm" />
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------------------------

export function PerformanceTab({ row }: { row: OperationalDriver }) {
  const p = row.performance;
  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Work"
        description={`Priced ${p.coverage.priced} of ${p.coverage.loads} loads`}
        padding="md"
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
          <Definition label="Loads">{formatNumber(p.counts.total)}</Definition>
          <Definition label="Active">{formatNumber(p.counts.active)}</Definition>
          <Definition label="Delivered">{formatNumber(p.counts.delivered)}</Definition>
          <Definition label="Cancelled">{formatNumber(p.counts.cancelled)}</Definition>
        </dl>
      </Card>

      <Card title="Money" padding="md">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
          <Definition label="Revenue">
            <Figure value={p.revenue} format={money} />
          </Definition>
          <Definition label="Cost">
            <Figure value={p.totalCost} format={money} />
          </Definition>
          <Definition label="Profit">
            <Figure value={p.profit} format={money} />
          </Definition>
          <Definition label="Margin">
            <Figure value={p.marginPct} format={percent} />
          </Definition>
          <Definition label="Rev / loaded mi">
            <Figure value={p.revenuePerLoadedMile} format={money} />
          </Definition>
          <Definition label="Rev / total mi">
            <Figure value={p.revenuePerTotalMile} format={money} />
          </Definition>
          <Definition label="Profit / total mi">
            <Figure value={p.profitPerTotalMile} format={money} />
          </Definition>
        </dl>
      </Card>

      <Card title="Miles and service" padding="md">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
          <Definition label="Loaded miles">
            <Figure value={p.loadedMiles} format={formatMiles} />
          </Definition>
          <Definition label="Empty miles">
            <Figure value={p.emptyMiles} format={formatMiles} />
          </Definition>
          <Definition label="Total miles">
            <Figure value={p.totalMiles} format={formatMiles} />
          </Definition>
          <Definition label="Deadhead">
            <Figure value={p.deadheadPct} format={percent} />
          </Definition>
          <Definition label="On-time pickup">
            <Figure value={p.onTimePickupPct} format={percent} />
          </Definition>
          <Definition label="On-time delivery">
            <Figure value={p.onTimeDeliveryPct} format={percent} />
          </Definition>
          <Definition label="Avg dwell">
            <Figure value={p.avgDwellMinutes} format={(v) => `${formatNumber(v)} min`} />
          </Definition>
          <Definition label="Detention">
            <Figure value={p.detentionMinutes} format={(v) => `${formatNumber(v)} min`} />
          </Definition>
          <Definition label="Cancellation rate">
            <Figure value={p.cancellationRatePct} format={percent} />
          </Definition>
          <Definition label="Timed stops">
            {formatNumber(p.coverage.timedPickups)} pickups ·{' '}
            {formatNumber(p.coverage.timedDeliveries)} deliveries
          </Definition>
        </dl>
      </Card>

      {p.reasons.length > 0 ? (
        <Card title="Why some figures are missing" padding="md">
          <ul className="flex flex-col gap-1">
            {p.reasons.map((reason) => (
              <li key={reason} className="text-xs text-muted">
                · {reason}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {p.unavailable.length > 0 ? (
        <Card title="Not tracked yet" padding="md">
          <ul className="flex flex-col gap-1">
            {p.unavailable.map((entry) => (
              <li key={entry.metric} className="text-xs text-muted">
                <span className="text-secondary">{entry.metric}</span> — needs {entry.requires}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------------------------

export function ComplianceTab({ row }: { row: OperationalDriver }) {
  const go = useGo();
  const compliance = row.compliance;
  // The requirement being attached to or replaced, from the row's own button.
  const [attaching, setAttaching] = useState<EvaluatedItem | null>(null);

  if (!compliance) {
    return (
      <Card padding="md">
        <p className="text-sm text-muted">
          Safety holds no compliance record for this driver, so nothing can be reported here.
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {compliance.gateReasons.length > 0 ? (
        <div className="rounded-lg border border-danger-border bg-danger-soft px-4 py-3 text-sm text-danger-text">
          <p className="font-medium">Cannot be dispatched</p>
          <ul className="mt-1 list-disc pl-5">
            {compliance.gateReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Card
        title="Requirements"
        description={`${compliance.counts.satisfied} of ${compliance.counts.total} satisfied`}
        actions={
          <Button variant="ghost" size="sm" onClick={() => go(hrefs.compliance)}>
            Open compliance
          </Button>
        }
        padding="sm"
      >
        <ul className="divide-y divide-line-soft">
          {compliance.items.map((item) => (
            <li key={item.requirementCode} className="py-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge status={item.status} size="sm" />
                <span className="text-sm font-medium text-ink">{item.requirementName}</span>
                {item.blocksDispatch ? (
                  <Badge tone="danger" size="sm" variant="outline">
                    Blocks dispatch
                  </Badge>
                ) : null}
                <Button
                  size="sm"
                  variant={item.status === 'missing' ? 'secondary' : 'ghost'}
                  icon={<Upload />}
                  className="ml-auto"
                  onClick={() => setAttaching(item)}
                >
                  {item.status === 'missing' ? 'Attach file' : 'Replace file'}
                </Button>
              </div>
              <ul className="mt-1 flex flex-col gap-0.5">
                {item.reasons.map((reason) => (
                  <li key={reason} className="text-xs text-secondary">
                    · {reason}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Card>
      {attaching ? (
        <UploadDocumentDialog
          item={attaching}
          ownerType="driver"
          open
          onOpenChange={(open) => {
            if (!open) setAttaching(null);
          }}
        />
      ) : null}
    </div>
  );
}
