import {
  OPS_NET_PAY_TYPES,
  TRUCK_STATUSES,
  type DashboardTruckPnl,
  type OpsNetPayType,
  type TruckPnlRow,
  type TruckPnlTotals,
  type TruckPnlView,
  type TruckStatus,
} from '@neway/shared';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Badge,
  Card,
  DataTable,
  Input,
  Select,
  StatusBadge,
  Tabs,
  createColumns,
  createDataTableState,
  getStatus,
  type DataTableState,
} from '@/design-system';
import { fetchTruckPnl, type TruckPnlFilters } from '@/lib/dashboard-api';
import { formatNumber } from '@/lib/format';
import { RouterLink } from '../RouterLink';
import { hrefs, linkClass, useGo } from '../links';
import { Value } from './Value';
import type { PeriodState } from '../period/usePeriod';
import { dashboardKey } from '../queries';
import { visibilityOf } from '../visibility';

const PAGE_SIZES = [10, 25, 50];
const DEFAULT_SORT = '-profit';

const VIEW_ITEMS: Array<{ value: TruckPnlView; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'best', label: 'Best' },
  { value: 'worst', label: 'Worst' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'unprofitable', label: 'Unprofitable' },
];

const PAY_TYPE_LABEL: Record<OpsNetPayType, string> = {
  company: 'Company',
  owner_operator: 'Owner operator',
  lease_owner: 'Lease owner',
  percentage: 'Percentage',
  unknown: 'Unknown',
};

const ANY = '__any';

const payTypeOptions = [
  { value: ANY, label: 'All driver types' },
  ...OPS_NET_PAY_TYPES.map((value) => ({ value, label: PAY_TYPE_LABEL[value] })),
];

const statusOptions = [
  { value: ANY, label: 'All statuses' },
  // Archived trucks (owner, 2026-10-05) are not in the P&L, so there is nothing to filter to.
  ...TRUCK_STATUSES.filter((value) => value !== 'archived').map((value) => ({
    value,
    label: getStatus(value).label,
  })),
];

/** A truck row or the totals row rendered as the last line of every page. */
interface PnlTableRow {
  id: string;
  totals: boolean;
  unitNumber: string;
  status: TruckStatus | null;
  driverName: string | null;
  payType: OpsNetPayType | null;
  trucks: number;
  gross: number | null;
  miles: number | null;
  loads: number;
  cost: number | null;
  costEstimated: number | null;
  profit: number | null;
  inactiveLoss: boolean;
}

function toRow(row: TruckPnlRow): PnlTableRow {
  return { id: row.truckId, totals: false, trucks: 1, ...row };
}

function totalsRow(totals: TruckPnlTotals): PnlTableRow {
  return {
    id: '__totals',
    totals: true,
    unitNumber: 'Total',
    status: null,
    driverName: null,
    payType: null,
    trucks: totals.trucks,
    gross: totals.gross,
    miles: totals.miles,
    loads: totals.loads,
    cost: totals.cost,
    costEstimated: totals.costEstimated,
    profit: totals.profit,
    inactiveLoss: false,
  };
}

function buildColumns(masked: boolean) {
  const col = createColumns<PnlTableRow>();
  const money = (key: 'gross' | 'cost' | 'profit', header: string) =>
    col.accessor(key, {
      header,
      meta: { align: 'right' },
      cell: ({ row }) => (
        <Value
          value={row.original[key]}
          kind="moneyCompact"
          masked={masked}
          className={
            key === 'profit' && !masked && row.original.profit !== null && row.original.profit < 0
              ? 'text-danger-text'
              : undefined
          }
        />
      ),
    });
  return col.columns([
    col.accessor('unitNumber', {
      header: 'Unit',
      meta: { primary: true },
      cell: ({ row }) =>
        row.original.totals ? (
          <span className="font-medium text-ink" data-totals>
            Total · {formatNumber(row.original.trucks)} trucks
          </span>
        ) : (
          <span className="inline-flex items-center gap-2">
            <RouterLink to={hrefs.truck(row.original.unitNumber)} className={linkClass}>
              {row.original.unitNumber}
            </RouterLink>
            {row.original.inactiveLoss ? (
              <Badge tone="danger" size="sm" data-inactive-loss>
                Inactive truck loss
              </Badge>
            ) : null}
          </span>
        ),
    }),
    col.accessor('driverName', {
      header: 'Driver',
      cell: ({ row }) =>
        row.original.totals
          ? null
          : (row.original.driverName ?? <span className="text-faint">Unassigned</span>),
    }),
    col.accessor('payType', {
      header: 'Type',
      enableSorting: false,
      cell: ({ row }) => {
        const payType = row.original.payType;
        if (!payType) return null;
        return payType === 'unknown' ? (
          <Badge tone="warning" size="sm">
            Unknown
          </Badge>
        ) : (
          <span className="text-secondary">{PAY_TYPE_LABEL[payType]}</span>
        );
      },
    }),
    col.accessor('status', {
      header: 'Status',
      enableSorting: false,
      cell: ({ row }) =>
        row.original.status ? <StatusBadge status={row.original.status} size="sm" /> : null,
    }),
    money('gross', 'Gross'),
    col.accessor('miles', {
      header: 'Miles',
      meta: { align: 'right' },
      cell: ({ row }) => <Value value={row.original.miles} kind="number" />,
    }),
    col.accessor('loads', {
      header: 'Loads',
      meta: { align: 'right' },
      cell: ({ row }) => <Value value={row.original.loads} kind="number" />,
    }),
    money('cost', 'Cost'),
    money('profit', 'Profit'),
  ]);
}

function toSort(state: DataTableState): string {
  const first = state.sorting[0];
  if (!first) return DEFAULT_SORT;
  return `${first.desc ? '-' : ''}${first.id}`;
}

export interface TruckPnlWidgetProps {
  period: PeriodState;
}

/** Server-side P&L per truck table with quick views and filters (docs/DASHBOARD.md §6). */
export function TruckPnlWidget({ period }: TruckPnlWidgetProps) {
  const go = useGo();
  const [view, setView] = useState<TruckPnlView>('all');
  const [search, setSearch] = useState('');
  const [unit, setUnit] = useState('');
  const [payType, setPayType] = useState<string>(ANY);
  const [status, setStatus] = useState<string>(ANY);
  const [tableState, setTableState] = useState<DataTableState>(() =>
    createDataTableState({
      sorting: [{ id: 'profit', desc: true }],
      pagination: { page: 1, pageSize: PAGE_SIZES[0]! },
    }),
  );

  const filters: TruckPnlFilters = {
    q: search.trim() || undefined,
    unit: unit.trim() || undefined,
    payType: payType === ANY ? undefined : (payType as OpsNetPayType),
    status: status === ANY ? undefined : (status as TruckStatus),
    view,
    sort: toSort(tableState),
    page: tableState.pagination.page,
    pageSize: tableState.pagination.pageSize,
  };

  const query = useQuery({
    queryKey: dashboardKey('truck-pnl', period, filters),
    queryFn: () => fetchTruckPnl(period.request, filters),
    placeholderData: (previous) => previous,
  });

  const data: DashboardTruckPnl | undefined = query.data;
  const masked = data?.masked ?? false;
  const visibility = visibilityOf(masked);
  const columns = useMemo(() => buildColumns(!visibility.financial), [visibility.financial]);
  const rows = useMemo<PnlTableRow[]>(
    () => (data && data.rows.length > 0 ? [...data.rows.map(toRow), totalsRow(data.totals)] : []),
    [data],
  );

  const resetPage = () =>
    setTableState((s) => ({ ...s, pagination: { ...s.pagination, page: 1 } }));

  return (
    <Card
      title="P&L per truck"
      description={
        data
          ? `${formatNumber(data.totals.trucks)} trucks · ${formatNumber(data.totals.inactiveTrucks)} inactive`
          : 'Gross, miles, cost and profit per truck'
      }
      padding="none"
      className="min-w-0"
      data-testid="truck-pnl-widget"
      actions={
        <Tabs
          variant="segmented"
          size="sm"
          aria-label="Quick view"
          items={VIEW_ITEMS}
          value={view}
          onValueChange={(value) => {
            setView(value as TruckPnlView);
            resetPage();
          }}
        />
      }
    >
      <DataTable
        caption="P&L per truck"
        columns={columns}
        data={rows}
        rowKey={(row) => row.id}
        state={tableState}
        onStateChange={(patch) => setTableState((s) => ({ ...s, ...patch }))}
        total={data?.page.total}
        serverSide
        loading={query.isPending}
        error={query.isError ? query.error : undefined}
        onRetry={() => void query.refetch()}
        dense
        showColumnChooser={false}
        pageSizes={PAGE_SIZES}
        emptyTitle="No trucks match"
        emptyDescription="Try another quick view or clear the filters."
        onRowClick={(row) => {
          if (!row.totals) go(hrefs.truck(row.unitNumber));
        }}
        getRowStatus={(row) => (row.totals ? 'muted' : undefined)}
        className="rounded-none border-0 shadow-none [&_tbody_tr:has([data-inactive-loss])>td]:bg-danger-soft/40 [&_tbody_tr:has([data-totals])>td]:border-t [&_tbody_tr:has([data-totals])>td]:border-line [&_tbody_tr:has([data-totals])>td]:bg-surface-muted [&_tbody_tr:has([data-totals])>td]:font-medium [&_tbody_tr:has([data-totals])>td]:text-ink"
        toolbar={
          <>
            <Input
              size="sm"
              aria-label="Search unit or driver"
              placeholder="Search unit or driver"
              prefix={<Search />}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                resetPage();
              }}
              className="w-48"
            />
            <Select
              size="sm"
              aria-label="Driver type"
              options={payTypeOptions}
              value={payType}
              onValueChange={(value) => {
                setPayType(value);
                resetPage();
              }}
              className="w-40"
            />
            <Select
              size="sm"
              aria-label="Status"
              options={statusOptions}
              value={status}
              onValueChange={(value) => {
                setStatus(value);
                resetPage();
              }}
              className="w-36"
            />
            <Input
              size="sm"
              aria-label="Unit"
              placeholder="Unit"
              value={unit}
              onChange={(e) => {
                setUnit(e.target.value);
                resetPage();
              }}
              className="w-24"
            />
          </>
        }
      />
    </Card>
  );
}
