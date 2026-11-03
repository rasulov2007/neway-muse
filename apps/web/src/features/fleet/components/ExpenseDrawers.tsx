import { Link } from '@tanstack/react-router';
import { AlertTriangle, Info, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import type {
  FleetAnomaly,
  FleetAnomalyCheck,
  FleetSpendEvent,
  FleetVendorRow,
} from '@neway/shared';
import { Badge, Button, Drawer, EmptyState, cn } from '@/design-system';
import { formatIsoDate, formatMoney, formatNumber } from '@/lib/format';

/**
 * Where a number on the expense summary opens.
 *
 * Every count and total on the page carries the ids of the exact records behind it. The
 * Maintenance page can list work orders by id, but a standalone service record has no register of
 * its own — so a figure that mixes the two opens here, on precisely those records, each linking to
 * wherever it actually lives. A tile that says 12 must open 12, not "roughly the same filter".
 */

export interface RecordsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Every counted event on the page; the drawer picks the ones in `recordIds`. */
  events: FleetSpendEvent[];
  recordIds: string[];
}

export function ExpenseRecordsDrawer({
  open,
  onOpenChange,
  title,
  description,
  events,
  recordIds,
}: RecordsDrawerProps) {
  const rows = useMemo(() => {
    const wanted = new Set(recordIds);
    return events
      .filter((event) => wanted.has(event.id))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [events, recordIds]);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const orderIds = rows.filter((row) => row.kind === 'work_order').map((row) => row.id);
  // Ids the page counted but the event list does not carry (a roster unit, say) are not records.
  const missing = recordIds.length - rows.length;

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={title}
      description={description}
      footer={
        orderIds.length > 0 ? (
          <Link
            to="/fleet/maintenance"
            search={{ ids: orderIds.join(',') } as never}
            className="text-sm font-medium text-primary-text hover:underline"
          >
            Open the {orderIds.length} work order{orderIds.length === 1 ? '' : 's'} in Maintenance
          </Link>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          title="No records"
          description="Nothing was counted here in this period."
        />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted">
            {formatNumber(rows.length)} record{rows.length === 1 ? '' : 's'} · {formatMoney(total)}{' '}
            · completed work orders at their order total, standalone service records at their cost
            {missing > 0
              ? ` · ${missing} counted item${missing === 1 ? '' : 's'} not a spend record`
              : ''}
          </p>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm" aria-label={title}>
              <thead className="bg-surface-muted text-xs font-semibold text-secondary">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Record</th>
                  <th className="px-3 py-2 text-left font-medium">Unit</th>
                  <th className="px-3 py-2 text-left font-medium">Type</th>
                  <th className="px-3 py-2 text-left font-medium">Vendor</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="px-3 py-2 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                    <td className="max-w-56 px-3 py-2">
                      {row.kind === 'work_order' ? (
                        <Link
                          to="/fleet/maintenance/$orderId"
                          params={{ orderId: row.id }}
                          className="font-medium text-primary-text hover:underline"
                        >
                          {row.reference}
                        </Link>
                      ) : (
                        <span className="block truncate" title={row.reference}>
                          {row.reference}
                          <span className="ml-1 text-xs text-muted">service record</span>
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        to="/fleet/trucks/$truckId"
                        params={{ truckId: row.truckId }}
                        search={{ tab: 'history' } as never}
                        className="text-primary-text hover:underline"
                      >
                        {row.unitNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{typeLabel(row.type)}</td>
                    <td className="max-w-40 truncate px-3 py-2">
                      {row.vendorName ?? <span className="text-muted">Unknown</span>}
                    </td>
                    <td className="tabular px-3 py-2 text-right whitespace-nowrap">
                      {formatMoney(row.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Drawer>
  );
}

function typeLabel(type: string): string {
  return type.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export interface VendorsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vendors: FleetVendorRow[];
  onSelect: (vendor: FleetVendorRow) => void;
}

/** The full vendor table behind "View all". */
export function VendorsDrawer({ open, onOpenChange, vendors, onSelect }: VendorsDrawerProps) {
  const total = vendors.reduce((sum, row) => sum + row.spend, 0);
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="All vendors"
      description="Grouped by vendor record where the work order names one; orders that still carry only a typed name are grouped by that name."
    >
      {vendors.length === 0 ? (
        <EmptyState size="sm" title="No vendors" description="No spend in this period." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm" aria-label="All vendors">
            <thead className="bg-surface-muted text-xs font-semibold text-secondary">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Vendor</th>
                <th className="px-3 py-2 text-right font-medium">Events</th>
                <th className="px-3 py-2 text-right font-medium">Units</th>
                <th className="px-3 py-2 text-right font-medium">Spend</th>
                <th className="px-3 py-2 text-right font-medium">Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {vendors.map((row) => (
                <tr key={row.key}>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="text-left font-medium text-primary-text hover:underline"
                      onClick={() => onSelect(row)}
                    >
                      {row.name}
                    </button>
                    {row.vendorId ? (
                      <Link
                        to="/fleet/vendors/$vendorId"
                        params={{ vendorId: row.vendorId }}
                        className="ml-2 text-xs text-muted hover:underline"
                      >
                        record
                      </Link>
                    ) : null}
                  </td>
                  <td className="tabular px-3 py-2 text-right">{formatNumber(row.events)}</td>
                  <td className="tabular px-3 py-2 text-right">{formatNumber(row.truckCount)}</td>
                  <td className="tabular px-3 py-2 text-right">{formatMoney(row.spend)}</td>
                  <td className="tabular px-3 py-2 text-right text-muted">
                    {total > 0 ? `${((row.spend / total) * 100).toFixed(1)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Drawer>
  );
}

const SEVERITY: Record<
  FleetAnomaly['severity'],
  { icon: typeof AlertTriangle; ring: string; text: string; label: string }
> = {
  critical: {
    icon: TriangleAlert,
    ring: 'border-danger-border bg-danger-soft',
    text: 'text-danger-text',
    label: 'Critical',
  },
  warning: {
    icon: AlertTriangle,
    ring: 'border-warning-border bg-warning-soft',
    text: 'text-warning-text',
    label: 'Warning',
  },
  info: {
    icon: Info,
    ring: 'border-line bg-surface-muted',
    text: 'text-secondary',
    label: 'Review',
  },
};

export interface AnomalyRowProps {
  finding: FleetAnomaly;
  onRecords: (finding: FleetAnomaly) => void;
}

/** One finding: what, how much, on which unit, and the records to check it against. */
export function AnomalyRow({ finding, onRecords }: AnomalyRowProps) {
  const severity = SEVERITY[finding.severity];
  const Icon = severity.icon;
  // A finding about the present points at the unit; one about the period points at its records.
  const hasSpendRecords = !finding.current && finding.recordIds.length > 0;
  return (
    <li className={cn('flex gap-3 rounded-lg border p-3', severity.ring)}>
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', severity.text)} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">{finding.title}</span>
          <Badge tone="neutral" variant="outline" size="sm">
            {severity.label}
          </Badge>
          {finding.current ? (
            <Badge tone="neutral" variant="outline" size="sm">
              Now
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-secondary">{finding.detail}</p>
        <div className="flex flex-wrap gap-3 text-xs">
          <Link
            to="/fleet/trucks/$truckId"
            params={{ truckId: finding.truckId }}
            className="text-primary-text hover:underline"
          >
            Unit {finding.unitNumber}
          </Link>
          {hasSpendRecords ? (
            <button
              type="button"
              className="text-primary-text hover:underline"
              onClick={() => onRecords(finding)}
            >
              {finding.recordIds.length} record{finding.recordIds.length === 1 ? '' : 's'}
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export interface AnomaliesDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  findings: FleetAnomaly[];
  checks: FleetAnomalyCheck[];
  onRecords: (finding: FleetAnomaly) => void;
}

/** Every finding, with the rules that ran and the ones that could not. */
export function AnomaliesDrawer({
  open,
  onOpenChange,
  findings,
  checks,
  onRecords,
}: AnomaliesDrawerProps) {
  const ran = checks.filter((check) => check.status === 'ran');
  const unavailable = checks.filter((check) => check.status === 'unavailable');
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Review issues"
      description={`${findings.length} finding${findings.length === 1 ? '' : 's'} from ${ran.length} checks that ran`}
    >
      <div className="flex flex-col gap-5">
        {findings.length === 0 ? (
          <EmptyState
            size="sm"
            title="Nothing unusual in this period"
            description="From the checks listed below that actually ran."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {findings.map((finding) => (
              <AnomalyRow key={finding.key} finding={finding} onRecords={onRecords} />
            ))}
          </ul>
        )}
        <section className="flex flex-col gap-2">
          <h3 className="eyebrow">Checks</h3>
          <ul className="flex flex-col gap-2 text-xs">
            {ran.map((check) => (
              <li key={check.rule} className="rounded-md border border-line-soft px-3 py-2">
                <span className="font-medium text-ink">{check.label}</span>
                <span className="text-muted"> · {check.threshold}</span>
              </li>
            ))}
            {unavailable.map((check) => (
              <li
                key={check.rule}
                className="rounded-md border border-dashed border-line px-3 py-2"
              >
                <span className="font-medium text-ink">{check.label}</span>
                <Badge tone="neutral" variant="outline" size="sm" className="ml-2">
                  Did not run
                </Badge>
                <div className="mt-1 text-muted">{check.reason}</div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Drawer>
  );
}

export function RecordsButton({
  count,
  onClick,
  children,
}: {
  count: number;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Button variant="link" size="sm" onClick={onClick} disabled={count === 0}>
      {children ?? `${formatNumber(count)} record${count === 1 ? '' : 's'}`}
    </Button>
  );
}
