import { Link } from '@tanstack/react-router';
import { DataTable, StatusBadge, createColumns } from '@/design-system';
import { formatMiles } from '@/lib/format';
import type { FleetTruck } from '../useFleet';

const col = createColumns<FleetTruck>();

/**
 * Archived trucks (owner, 2026-10-05): the only list that shows them.
 *
 * Archived = hidden, kept, reversible, audited. Every other list, picker, board and count of the
 * fleet leaves these out; the unit's own page keeps its history and offers Restore.
 */
export function ArchivedTrucksTab({ rows, loading }: { rows: FleetTruck[]; loading: boolean }) {
  const columns = col.columns([
    col.display({
      id: 'unit',
      header: 'Unit / Vehicle',
      meta: { primary: true, width: 200 },
      cell: ({ row }) => (
        <span className="flex min-w-0 flex-col leading-tight">
          <Link
            to="/fleet/trucks/$truckId"
            params={{ truckId: row.original.truck.id }}
            className="w-fit font-semibold text-primary-text hover:underline"
          >
            {row.original.truck.unitNumber}
          </Link>
          <span className="truncate text-xs font-normal text-muted">
            {row.original.truck.year} {row.original.truck.make} {row.original.truck.model}
          </span>
        </span>
      ),
    }),
    col.display({
      id: 'status',
      header: 'Status',
      meta: { width: 140 },
      cell: () => <StatusBadge status="archived" />,
    }),
    col.display({
      id: 'vin',
      header: 'VIN',
      meta: { width: 200 },
      cell: ({ row }) => <span className="text-secondary">{row.original.truck.vin}</span>,
    }),
    col.display({
      id: 'odometer',
      header: 'Last odometer',
      meta: { width: 140 },
      cell: ({ row }) => (
        <span className="tabular text-secondary">{formatMiles(row.original.truck.odometer)}</span>
      ),
    }),
  ]);

  return (
    <DataTable
      data={rows}
      columns={columns}
      rowKey={(row) => row.truck.id}
      loading={loading}
      dense
      caption="Archived trucks"
      emptyTitle="No archived trucks"
      emptyDescription="A truck archived from its page (⋯ › Archive truck) is listed here, and can be restored from its page."
    />
  );
}
