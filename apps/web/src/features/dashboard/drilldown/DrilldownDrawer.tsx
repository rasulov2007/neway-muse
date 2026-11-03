import type { DrilldownColumn, DrilldownMetric, DrilldownRow } from '@neway/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import {
  Badge,
  Button,
  DataTable,
  Drawer,
  ErrorState,
  StatusBadge,
  TableSkeleton,
  createColumns,
} from '@/design-system';
import { fetchDrilldown } from '@/lib/dashboard-api';
import { formatDate, formatIsoDate, formatMoney, formatNumber } from '@/lib/format';
import { RouterLink } from '../RouterLink';
import { hrefs, useGo, viewAllClass } from '../links';
import { DASH, MASK } from '../metric';
import type { PeriodState } from '../period/usePeriod';
import { dashboardKey } from '../queries';
import type { DrilldownRequest } from './types';

/** Owning module per metric (docs/DASHBOARD.md §12). */
const MODULE_HREF: Record<DrilldownMetric, { label: string; href: string }> = {
  gross: { label: 'Open in Loads', href: hrefs.loads },
  cost: { label: 'Open in Accounting', href: hrefs.expenses },
  fuel: { label: 'Open in Fuel', href: hrefs.fuel },
  maintenance: { label: 'Open in Maintenance', href: hrefs.maintenance },
  driver_pay: { label: 'Open in Settlements', href: hrefs.settlements },
  inactive_loss: { label: 'Open in Trucks', href: hrefs.trucks },
};

const DRILLDOWN_PAGE_SIZE = 200;

interface RowWithKey extends DrilldownRow {
  __key: string;
}

function cellText(value: string | number | null, column: DrilldownColumn): string {
  if (value === null) return DASH;
  switch (column.kind) {
    case 'money':
      return typeof value === 'number' ? formatMoney(value) : String(value);
    case 'number':
      return typeof value === 'number'
        ? formatNumber(value, Number.isInteger(value) ? 0 : 2)
        : String(value);
    case 'date':
      // A drill-down date is a business day the record carries, not an instant. Converting
      // `2026-09-27` into the company timezone renders it as Sep 26, a day earlier than the
      // ledger, the P&L and the period it was posted in.
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? formatIsoDate(value)
        : formatDate(value);
    default:
      return String(value);
  }
}

function buildColumns(columns: DrilldownColumn[]) {
  const col = createColumns<RowWithKey>();
  return col.columns(
    columns.map((column, index) =>
      col.accessor((row) => row[column.key] ?? null, {
        id: column.key,
        header: column.label,
        meta: {
          align: column.kind === 'money' || column.kind === 'number' ? 'right' : 'left',
          primary: index === 0,
        },
        cell: ({ getValue }) => {
          const value = getValue() as string | number | null;
          if (column.kind === 'status' && typeof value === 'string') {
            return <StatusBadge status={value} size="sm" />;
          }
          return cellText(value, column);
        },
      }),
    ),
  );
}

interface MetricBodyProps {
  period: PeriodState;
  metric: DrilldownMetric;
  onNavigate: (href: string) => void;
}

function MetricBody({ period, metric, onNavigate }: MetricBodyProps) {
  const query = useQuery({
    queryKey: dashboardKey('drilldown', period, metric),
    queryFn: () =>
      fetchDrilldown(period.request, metric, { page: 1, pageSize: DRILLDOWN_PAGE_SIZE }),
  });
  const data = query.data;
  const columns = useMemo(() => (data ? buildColumns(data.columns) : []), [data]);
  const rows = useMemo<RowWithKey[]>(
    () => (data ? data.rows.map((row, i) => ({ ...row, __key: String(i) })) : []),
    [data],
  );
  const module = MODULE_HREF[metric];

  if (query.isError) {
    return (
      <ErrorState
        size="sm"
        title="Unable to load the records"
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  if (!data) return <TableSkeleton rows={8} columns={4} />;
  const total = data.total;
  return (
    <div className="flex flex-col gap-3">
      <DrilldownHeader
        title={data.title}
        total={total === null ? (data.meta.source === 'demo' ? DASH : MASK) : formatMoney(total)}
        count={data.page.total}
        note={
          data.page.total > rows.length
            ? `Showing the first ${formatNumber(rows.length)} of ${formatNumber(data.page.total)} records.`
            : undefined
        }
        action={
          <RouterLink to={module.href} className={viewAllClass}>
            {module.label}
            <ArrowUpRight aria-hidden className="size-3.5" />
          </RouterLink>
        }
      />
      <DataTable
        caption={data.title}
        columns={columns}
        data={rows}
        rowKey={(row) => row.__key}
        dense
        showColumnChooser={false}
        pageSizes={[25, 50]}
        emptyTitle="No contributing records"
        emptyDescription="Nothing contributed to this number in the selected period."
        onRowClick={
          metric === 'gross' || metric === 'inactive_loss'
            ? (row) => {
                const first = data.columns[0]?.key;
                const value = first ? row[first] : null;
                if (typeof value === 'string') {
                  onNavigate(metric === 'gross' ? hrefs.load(value) : hrefs.truck(value));
                }
              }
            : undefined
        }
      />
    </div>
  );
}

function DrilldownHeader({
  title,
  total,
  count,
  note,
  action,
}: {
  title: string;
  total: string;
  count: number;
  note?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="eyebrow">{title}</div>
        <div className="tabular mt-1 text-2xl font-semibold text-ink" data-testid="drilldown-total">
          {total}
        </div>
        <div className="mt-0.5 text-xs text-muted">
          {formatNumber(count)} {count === 1 ? 'record' : 'records'}
          {note ? ` · ${note}` : ''}
        </div>
      </div>
      {action}
    </div>
  );
}

type UnknownRequest = Extract<DrilldownRequest, { kind: 'unknown_pay_types' }>;

function UnknownPayTypesBody({ unknown }: { unknown: UnknownRequest }) {
  const drivers = unknown.unknown.drivers;
  return (
    <div className="flex flex-col gap-3">
      <DrilldownHeader
        title="Unclassified gross"
        total={unknown.unknown.gross === null ? MASK : formatMoney(unknown.unknown.gross)}
        count={unknown.unknown.driverCount}
        action={
          <RouterLink to={hrefs.drivers} className={viewAllClass}>
            Open in Drivers
            <ArrowUpRight aria-hidden className="size-3.5" />
          </RouterLink>
        }
      />
      <p className="text-sm text-secondary">
        These drivers have no recognised pay type, so their revenue and costs are reported in the{' '}
        <Badge tone="warning" size="sm">
          Unknown
        </Badge>{' '}
        bucket. Set the pay type on each driver to classify them.
      </p>
      {drivers.length === 0 ? (
        <p className="text-sm text-muted">No drivers to show.</p>
      ) : (
        <ul className="divide-y divide-line-soft rounded-lg border border-line">
          {drivers.map((driver) => (
            <li key={driver.driverId} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="text-sm font-medium text-ink">{driver.name}</span>
              <span className="text-xs text-muted">
                {driver.rawPayTag ? (
                  <>
                    Pay tag{' '}
                    <code className="rounded-xs bg-surface-muted px-1">{driver.rawPayTag}</code>
                  </>
                ) : (
                  'No pay tag'
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface DrilldownDrawerProps {
  period: PeriodState;
  request: DrilldownRequest | null;
  onClose: () => void;
}

/** Right-side drawer listing the records behind a headline number (docs/DASHBOARD.md §12). */
export function DrilldownDrawer({ period, request, onClose }: DrilldownDrawerProps) {
  const go = useGo();
  const title =
    request?.kind === 'metric' ? 'Drill-down' : request ? 'Unknown pay types' : 'Drill-down';
  return (
    <Drawer
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="xl"
      title={title}
      description={`${period.query.period === 'custom' ? `${period.query.from} – ${period.query.to}` : 'Selected period'} · records sum to the headline`}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {request?.kind === 'metric' ? (
        <MetricBody
          period={period}
          metric={request.metric}
          onNavigate={(href) => {
            onClose();
            go(href);
          }}
        />
      ) : request ? (
        <UnknownPayTypesBody unknown={request} />
      ) : null}
    </Drawer>
  );
}
