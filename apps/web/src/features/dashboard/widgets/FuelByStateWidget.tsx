import type { DashboardFuel, FuelByState } from '@neway/shared';
import { Card, CardSkeleton } from '@/design-system';
import { formatNumber } from '@/lib/format';
import { Value } from './Value';
import type { Visibility } from '../visibility';
import { CompactTable, type CompactColumn } from './CompactTable';

export interface FuelByStateWidgetProps {
  fuel: DashboardFuel;
  visibility: Visibility;
}

/** Fuel by state, sortable, default by average price per gallon descending (§7). */
export function FuelByStateWidget({ fuel, visibility }: FuelByStateWidgetProps) {
  const masked = !visibility.financial || fuel.masked;
  const rows = fuel.byState;
  const highest = rows.reduce<FuelByState | null>(
    (best, row) =>
      row.avgPricePerGallon !== null &&
      (best === null || (best.avgPricePerGallon ?? -Infinity) < row.avgPricePerGallon)
        ? row
        : best,
    null,
  );

  const columns: CompactColumn<FuelByState>[] = [
    {
      key: 'state',
      label: 'State',
      render: (r) => <span className="font-medium">{r.state}</span>,
      sortValue: (r) => r.state,
    },
    {
      key: 'fillUps',
      label: 'Fills',
      align: 'right',
      render: (r) => formatNumber(r.fillUps),
      sortValue: (r) => r.fillUps,
    },
    {
      key: 'gallons',
      label: 'Gallons',
      align: 'right',
      render: (r) => formatNumber(r.gallons),
      sortValue: (r) => r.gallons,
    },
    {
      key: 'cost',
      label: 'Cost',
      align: 'right',
      render: (r) => <Value value={r.cost} kind="moneyCompact" masked={masked} />,
      sortValue: masked ? undefined : (r) => r.cost,
    },
    {
      key: 'avg',
      label: '$/gal',
      align: 'right',
      render: (r) => {
        const isHighest = !masked && r === highest;
        return (
          <span
            className="inline-flex items-center justify-end gap-1"
            title={isHighest ? 'Highest average price per gallon' : undefined}
          >
            <Value
              value={r.avgPricePerGallon}
              kind="rate"
              masked={masked}
              className={isHighest ? 'font-medium text-warning-text' : undefined}
            />
            {/* Weight and tint alone would not survive a screen reader or a mono display. */}
            {isHighest ? <span className="sr-only">Highest average price per gallon</span> : null}
          </span>
        );
      },
      sortValue: masked ? undefined : (r) => r.avgPricePerGallon,
    },
  ];

  return (
    <Card
      title="Fuel by state"
      description="Where fuel was bought and what it cost"
      padding="none"
      className="min-w-0"
      data-testid="fuel-by-state-widget"
    >
      {rows.length === 0 ? (
        <p className="px-(--card-padding) py-6 text-center text-sm text-muted">
          No fuel transactions in this period.
        </p>
      ) : (
        <CompactTable
          caption="Fuel by state"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.state}
          sortable
          defaultSort={{ key: 'avg', direction: 'desc' }}
          rowClassName={(r) => (!masked && r === highest ? 'bg-warning-soft/40' : undefined)}
        />
      )}
    </Card>
  );
}

export function FuelByStateWidgetSkeleton() {
  return <CardSkeleton lines={6} />;
}
