import { demoCompany } from '@/demo';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';
import {
  Badge,
  DataTable,
  ErrorState,
  FilterBar,
  PageHeader,
  Skeleton,
  StatusBadge,
  createColumns,
  useDataTableState,
} from '@/design-system';
import { useGo } from '@/features/dashboard/links';
import { useEntityActions } from './EntityActionMenu';
import { usePrincipal } from './usePermissions';
import { formatMoney, formatNumber } from '@/lib/format';
import { CustomerDrawer, InsufficientData } from './CustomerDrawer';
import { customersSearchSchema, type CustomersSearch } from './customers-search';
import { useOperations, type OperationalCustomer } from './useOperations';

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'on_hold', label: 'On hold' },
];

function matches(haystack: Array<string | null | undefined>, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return haystack.some((value) => value && value.toLowerCase().includes(q));
}

/**
 * Customers as business relationships.
 *
 * Every figure is derived from the same load economics the dispatch board uses, so this page and
 * the board can never quote different profits for the same freight. A figure the system cannot
 * compute says so; it never falls back to `$0`.
 */
export function CustomersPage() {
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => customersSearchSchema.parse(rawSearch), [rawSearch]);
  const query = useOperations();

  function updateSearch(patch: Partial<CustomersSearch>) {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        for (const key of Object.keys(next)) {
          if (next[key] === undefined || next[key] === '') delete next[key];
        }
        return next;
      },
      replace: true,
    });
  }

  const rows = query.data?.customers ?? [];
  const selected = search.customer ? (query.data?.byCustomerId.get(search.customer) ?? null) : null;

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Customers"
        description="Who your freight actually comes from — what each relationship earns, how it runs and how it pays."
        meta={
          demoCompany.demo ? (
            <Badge tone="neutral" variant="outline" size="sm">
              Demo data
            </Badge>
          ) : undefined
        }
      />

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState
          title="Customers could not be loaded"
          description="Please try again."
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : (
        <>
          <CustomersTable
            rows={rows}
            search={search}
            onSearch={(q) => updateSearch({ q: q || undefined })}
            onStatus={(status) => updateSearch({ status })}
            onSelect={(id) => updateSearch({ customer: id })}
          />
          <CustomerDrawer
            customer={selected}
            onClose={() => updateSearch({ customer: undefined })}
          />
        </>
      )}
    </div>
  );
}

function CustomersTable({
  rows,
  search,
  onSearch,
  onStatus,
  onSelect,
}: {
  rows: OperationalCustomer[];
  search: CustomersSearch;
  onSearch: (q: string) => void;
  onStatus: (status: CustomersSearch['status']) => void;
  onSelect: (customerId: string) => void;
}) {
  const principal = usePrincipal();
  const go = useGo();
  const actions = useEntityActions({
    permissions: principal.permissions,
    onAction: (action, target) => {
      if (action.key === 'create_load') go('/loads/new');
      if (action.key === 'edit') onSelect(target.id);
    },
  });
  const [state, onStateChange] = useDataTableState();
  const query = search.q ?? '';

  const data = useMemo(() => {
    return rows
      .filter((row) => (search.status ? row.customer.status === search.status : true))
      .filter((row) =>
        matches(
          [row.customer.name, row.customer.mcNumber, row.customer.primaryContact.name],
          query,
        ),
      )
      .sort((a, b) => {
        // Profit descending by default: the question this page answers is which relationships are
        // worth keeping, and that is the order in which to read them. Customers whose profit
        // cannot be computed sort last rather than being treated as zero-profit.
        const ap = a.performance.profit;
        const bp = b.performance.profit;
        if (ap === null && bp === null) return a.customer.name.localeCompare(b.customer.name);
        if (ap === null) return 1;
        if (bp === null) return -1;
        return bp - ap;
      });
  }, [rows, query, search.status]);

  const col = createColumns<OperationalCustomer>();
  const columns = col.columns([
    col.accessor((row) => row.customer.name, {
      id: 'name',
      header: 'Customer',
      meta: { primary: true, width: 220 },
    }),
    col.display({
      id: 'status',
      header: 'Status',
      cell: ({ row }) => <StatusBadge status={row.original.customer.status} size="sm" />,
    }),
    col.display({
      id: 'activeLoads',
      header: 'Active loads',
      meta: { align: 'right' },
      cell: ({ row }) => formatNumber(row.original.performance.counts.active),
    }),
    col.display({
      id: 'totalLoads',
      header: 'Total loads',
      meta: { align: 'right' },
      cell: ({ row }) => formatNumber(row.original.performance.counts.total),
    }),
    col.display({
      id: 'revenue',
      header: 'Revenue',
      meta: { align: 'right' },
      cell: ({ row }) => (
        <Metric value={row.original.performance.revenue} row={row.original} money />
      ),
    }),
    col.display({
      id: 'totalMiles',
      header: 'Total miles',
      meta: { align: 'right' },
      cell: ({ row }) => <Metric value={row.original.performance.totalMiles} row={row.original} />,
    }),
    col.display({
      id: 'rptm',
      header: 'Rev / total mi',
      meta: { align: 'right' },
      cell: ({ row }) => (
        <Metric value={row.original.performance.revenuePerTotalMile} row={row.original} money />
      ),
    }),
    col.display({
      id: 'profit',
      header: 'Profit',
      meta: { align: 'right' },
      cell: ({ row }) => (
        <Metric value={row.original.performance.profit} row={row.original} money />
      ),
    }),
    col.display({
      id: 'margin',
      header: 'Margin',
      meta: { align: 'right' },
      cell: ({ row }) => (
        <Metric value={row.original.performance.marginPct} row={row.original} suffix="%" />
      ),
    }),
    col.display({
      id: 'onTimeDelivery',
      header: 'On-time delivery',
      meta: { align: 'right' },
      cell: ({ row }) => (
        <Metric value={row.original.performance.onTimeDeliveryPct} row={row.original} suffix="%" />
      ),
    }),
    col.display({
      id: 'dwell',
      header: 'Avg dwell',
      meta: { align: 'right' },
      cell: ({ row }) => (
        <Metric value={row.original.performance.avgDwellMinutes} row={row.original} suffix=" min" />
      ),
    }),
    col.display({
      id: 'detention',
      header: 'Detention',
      meta: { align: 'right' },
      cell: ({ row }) => (
        <Metric
          value={row.original.performance.detentionMinutes}
          row={row.original}
          suffix=" min"
        />
      ),
    }),
  ]);

  return (
    <>
      <DataTable
        columns={columns}
        data={data}
        rowKey={(row) => row.customer.id}
        state={state}
        onStateChange={onStateChange}
        dense
        stickyHeader
        caption="Customers ranked by profit, with the coverage behind every figure"
        emptyTitle="No customers match"
        emptyDescription="Clear the filter or widen the search."
        onRowClick={(row) => onSelect(row.customer.id)}
        rowActions={(row) =>
          actions.items({
            entity: 'customer',
            id: row.customer.id,
            name: row.customer.name,
            status: row.customer.status,
          })
        }
        toolbar={
          <FilterBar
            search={{
              value: query,
              onChange: onSearch,
              placeholder: 'Search customer, MC number, contact',
            }}
            filters={[{ key: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS }]}
            values={{ status: search.status }}
            onChange={(key, value) => {
              if (key === 'status') onStatus((value as CustomersSearch['status']) ?? undefined);
            }}
            onClear={() => {
              onSearch('');
              onStatus(undefined);
            }}
          />
        }
      />
      {actions.dialog}
    </>
  );
}

/** A computed cell: the number when it is known, an honest "Insufficient data" when it is not. */
function Metric({
  value,
  row,
  money,
  suffix,
}: {
  value: number | null;
  row: OperationalCustomer;
  money?: boolean;
  suffix?: string;
}) {
  if (value === null) return <InsufficientData reason={row.performance.reasons.join(' · ')} />;
  // Percentages and rates arrive already rounded by the engine; keep the decimal it chose rather
  // than rounding a 12.4% margin to 12%.
  const digits = Number.isInteger(value) ? 0 : 1;
  return <>{money ? formatMoney(value) : `${formatNumber(value, digits)}${suffix ?? ''}`}</>;
}

function TableSkeleton() {
  return (
    <div role="status" aria-label="Loading customers" className="flex flex-col gap-3">
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  );
}
