import { useNavigate, useSearch } from '@tanstack/react-router';
import { ListFilter, Plus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  DataTable,
  ErrorState,
  FilterBar,
  Modal,
  PageHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  Skeleton,
  StatusBadge,
  cn,
  createColumns,
  useDataTableState,
} from '@/design-system';
import { useGo } from '@/features/dashboard/links';
import { useEntityActions } from './EntityActionMenu';
import { usePrincipal } from './usePermissions';
import { formatMoney, formatNumber } from '@/lib/format';
import { BrokerDrawer } from './BrokerDrawer';
import { BrokerForm } from './BrokerFormPage';
import { brokersSearchSchema, type BrokerStatusFilter, type BrokersSearch } from './brokers-search';
import { BROKER_RISK_LABEL, BROKER_RISK_ORDER, DASH } from './operations-ui';
import { useOperations, type OperationalBroker } from './useOperations';

/** The chip row under the header. `undefined` is "All brokers". */
const STATUS_CHIPS: ReadonlyArray<{ value: BrokerStatusFilter | undefined; label: string }> = [
  { value: undefined, label: 'All brokers' },
  { value: 'active', label: 'Active' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'do_not_use', label: 'Do not use' },
];

function matchesStatus(row: OperationalBroker, status: BrokerStatusFilter | undefined): boolean {
  if (!status) return true;
  if (status === 'do_not_use') return row.broker.doNotUse;
  return row.broker.status === status;
}

/**
 * Brokers as relationships to judge.
 *
 * Every number here is derived from the loads and invoices the system actually holds, and a figure
 * that cannot be derived says so instead of rendering `$0`. The risk column is the engine's own
 * grade; the drawer shows the factors behind it, because a grade nobody can argue with is a grade
 * nobody can act on.
 */
export function BrokersPage() {
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => brokersSearchSchema.parse(rawSearch), [rawSearch]);
  const query = useOperations();

  function updateSearch(patch: Partial<BrokersSearch>) {
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

  // Memoised so the empty fallback is not a fresh array on every render.
  const brokers = useMemo(() => query.data?.brokers ?? [], [query.data]);
  // Resolved from the bundle rather than fetched again, so the drawer and the row it opened from
  // can never disagree about the same broker.
  const selected = (search.broker ? query.data?.byBrokerId.get(search.broker) : undefined) ?? null;

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Brokers"
        description="Manage broker relationships, performance and payment terms."
      />

      <div role="group" aria-label="Broker status" className="flex flex-wrap items-center gap-2">
        {STATUS_CHIPS.map((chip) => {
          const active = search.status === chip.value;
          return (
            <button
              key={chip.label}
              type="button"
              aria-pressed={active}
              onClick={() => updateSearch({ status: chip.value })}
              className={cn(
                'inline-flex h-6 items-center rounded-xl border px-2.5 text-xs font-semibold whitespace-nowrap',
                'transition-colors duration-(--duration-base) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                active
                  ? 'border-nw-accent-tint bg-nw-accent-tint text-nw-accent-ink'
                  : 'border-line-soft bg-surface-muted text-secondary hover:bg-surface-hover hover:text-ink',
              )}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {query.isPending ? (
        <BrokersSkeleton />
      ) : query.isError ? (
        <ErrorState
          title="Brokers could not be loaded"
          description="Please try again."
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : (
        <>
          <BrokerTable
            rows={brokers}
            search={search}
            onSelect={(broker) => updateSearch({ broker: broker.broker.id })}
            onSearch={(q) => updateSearch({ q: q || undefined })}
            onRisk={(risk) => updateSearch({ risk })}
            onAdd={() => setAdding(true)}
          />

          <BrokerDrawer broker={selected} onClose={() => updateSearch({ broker: undefined })} />

          {/* Adding happens over the register, the same way a load is booked. */}
          <Modal
            open={adding}
            onOpenChange={setAdding}
            size="lg"
            title="Add broker"
            description="Who they are, how to reach them, and how they pay."
          >
            <BrokerForm
              onCancel={() => setAdding(false)}
              onCreated={(brokerId) => {
                setAdding(false);
                updateSearch({ broker: brokerId });
              }}
            />
          </Modal>
        </>
      )}
    </div>
  );
}

function matches(haystack: Array<string | null | undefined>, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return haystack.some((value) => value && value.toLowerCase().includes(q));
}

/** A figure the system genuinely could not derive. Never `$0`, never `0%`. */
function Unknown({ reason }: { reason: string }) {
  return (
    <span className="text-faint" title={`Insufficient data: ${reason}`}>
      {DASH}
    </span>
  );
}

/** Renders a nullable metric honestly: the formatted value, or why it is missing. */
function metric(
  value: number | null,
  format: (value: number) => ReactNode,
  reason: string,
): ReactNode {
  return value === null ? <Unknown reason={reason} /> : format(value);
}

function moneyReason(row: OperationalBroker): string {
  return row.performance.reasons.length > 0
    ? row.performance.reasons.join(' · ')
    : 'No priced load on file for this broker, so money cannot be computed';
}

function paymentReason(row: OperationalBroker): string {
  return row.payment.reasons.length > 0
    ? row.payment.reasons.join(' · ')
    : 'No paid invoice carries both an issue and a payment date';
}

function BrokerTable({
  rows,
  search,
  onSelect,
  onSearch,
  onRisk,
  onAdd,
}: {
  rows: OperationalBroker[];
  search: BrokersSearch;
  onSelect: (broker: OperationalBroker) => void;
  onSearch: (q: string) => void;
  onRisk: (risk: BrokersSearch['risk']) => void;
  /** Adding a broker sits on the filter row, where the eye already is. */
  onAdd: () => void;
}) {
  const principal = usePrincipal();
  const go = useGo();
  const actions = useEntityActions({
    permissions: principal.permissions,
    onAction: (action, target) => {
      if (action.key === 'create_load') go('/loads/new');
      if (action.key === 'edit') {
        const found = rows.find((r) => r.broker.id === target.id);
        if (found) onSelect(found);
      }
    },
  });
  const [state, onStateChange] = useDataTableState();
  const query = search.q ?? '';

  const data = useMemo(
    () =>
      rows
        .filter((row) => (search.risk ? row.risk.level === search.risk : true))
        .filter((row) => matchesStatus(row, search.status))
        .filter((row) =>
          matches(
            [
              row.broker.name,
              row.broker.mcNumber,
              row.broker.usdot,
              row.broker.primaryContact.name,
              row.broker.primaryContact.email,
            ],
            query,
          ),
        )
        .sort(
          (a, b) =>
            BROKER_RISK_ORDER.indexOf(a.risk.level) - BROKER_RISK_ORDER.indexOf(b.risk.level),
        ),
    [rows, search.risk, search.status, query],
  );

  const col = createColumns<OperationalBroker>();
  // Two header rows: a group label on top, the measure underneath. Single measures sit in a group
  // of their own with a blank leaf so every top-row label lines up on one baseline.
  const columns = col.columns([
    col.group({
      id: 'broker',
      header: 'Broker',
      columns: col.columns([
        col.accessor((row) => row.broker.mcNumber, {
          id: 'mc',
          header: 'MC',
          meta: { primary: true, width: 240, label: 'Broker' },
          cell: ({ row }) => (
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-semibold text-ink">{row.original.broker.name}</span>
                {/* A do-not-use broker has to be unmissable in the row, not only inside the drawer. */}
                {row.original.broker.doNotUse ? (
                  <span title={row.original.broker.doNotUseReason ?? undefined}>
                    <Badge tone="danger" size="sm">
                      Do not use
                    </Badge>
                  </span>
                ) : null}
              </span>
              <span className="text-xs font-normal text-muted">
                MC · {row.original.broker.mcNumber}
              </span>
            </span>
          ),
        }),
      ]),
    }),
    col.group({
      id: 'statusGroup',
      header: 'Status',
      columns: col.columns([
        col.display({
          id: 'status',
          header: '',
          meta: { label: 'Status', width: 120 },
          cell: ({ row }) => <StatusBadge status={row.original.broker.status} />,
        }),
      ]),
    }),
    col.group({
      id: 'loads',
      header: 'Loads',
      columns: col.columns([
        col.display({
          id: 'activeLoads',
          header: 'Active',
          meta: { align: 'right', label: 'Active loads' },
          cell: ({ row }) => formatNumber(row.original.performance.counts.active),
        }),
        col.display({
          id: 'totalLoads',
          header: 'Total',
          meta: { align: 'right', label: 'Total loads' },
          cell: ({ row }) => formatNumber(row.original.performance.counts.total),
        }),
      ]),
    }),
    col.group({
      id: 'revenueGroup',
      header: 'Revenue',
      meta: { align: 'right' },
      columns: col.columns([
        col.display({
          id: 'revenue',
          header: '',
          meta: { align: 'right', label: 'Revenue' },
          cell: ({ row }) =>
            metric(
              row.original.performance.revenue,
              (v) => formatMoney(v),
              moneyReason(row.original),
            ),
        }),
      ]),
    }),
    col.group({
      id: 'rpmGroup',
      header: 'Avg RPM',
      meta: { align: 'right' },
      columns: col.columns([
        col.display({
          id: 'rpm',
          header: '',
          meta: { align: 'right', label: 'Avg RPM' },
          cell: ({ row }) =>
            metric(
              row.original.performance.revenuePerLoadedMile,
              (v) => formatMoney(v),
              moneyReason(row.original),
            ),
        }),
      ]),
    }),
    col.group({
      id: 'rptmGroup',
      header: 'Rev / total mi',
      meta: { align: 'right' },
      columns: col.columns([
        col.display({
          id: 'rptm',
          header: '',
          meta: { align: 'right', label: 'Rev / total mi' },
          cell: ({ row }) =>
            metric(
              row.original.performance.revenuePerTotalMile,
              (v) => formatMoney(v),
              moneyReason(row.original),
            ),
        }),
      ]),
    }),
    col.group({
      id: 'profitGroup',
      header: 'Profit / Margin',
      columns: col.columns([
        col.display({
          id: 'profit',
          header: 'Profit',
          meta: { align: 'right' },
          cell: ({ row }) =>
            metric(
              row.original.performance.profit,
              (v) => formatMoney(v),
              moneyReason(row.original),
            ),
        }),
        col.display({
          id: 'margin',
          header: 'Margin',
          meta: { align: 'right' },
          cell: ({ row }) =>
            metric(
              row.original.performance.marginPct,
              (v) => <span className={v < 0 ? 'text-danger-text' : undefined}>{v}%</span>,
              moneyReason(row.original),
            ),
        }),
      ]),
    }),
    col.group({
      id: 'payment',
      header: 'Payment',
      columns: col.columns([
        col.accessor((row) => `${row.broker.paymentTermsDays}d`, {
          id: 'terms',
          header: 'Terms',
          meta: { align: 'right', label: 'Payment terms' },
        }),
        col.display({
          id: 'daysToPay',
          header: 'Avg days',
          meta: { align: 'right', label: 'Avg days to pay' },
          cell: ({ row }) =>
            metric(
              row.original.payment.avgDaysToPay,
              (v) => formatNumber(v),
              paymentReason(row.original),
            ),
        }),
      ]),
    }),
    col.group({
      id: 'overdueGroup',
      header: 'Overdue',
      meta: { align: 'right' },
      columns: col.columns([
        col.display({
          id: 'overdue',
          header: '',
          meta: { align: 'right', label: 'Overdue' },
          cell: ({ row }) => {
            const payment = row.original.payment;
            if (payment.overdueCount === 0) return <span className="text-faint">{DASH}</span>;
            return (
              <span className="font-medium text-danger-text">
                {formatNumber(payment.overdueCount)}
                {payment.overdueAmount === null ? '' : ` · ${formatMoney(payment.overdueAmount)}`}
              </span>
            );
          },
        }),
      ]),
    }),
  ]);

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-line-soft bg-surface">
      <DataTable
        columns={columns}
        data={data}
        rowKey={(row) => row.broker.id}
        state={state}
        onStateChange={onStateChange}
        stickyHeader
        className="rounded-none border-0 shadow-none"
        caption="Brokers with freight performance and payment behaviour"
        emptyTitle="No brokers match"
        emptyDescription="Clear the filter or widen the search."
        onRowClick={onSelect}
        rowActions={(row) =>
          actions.items({
            entity: 'broker',
            id: row.broker.id,
            name: row.broker.name,
            status: row.broker.status,
          })
        }
        toolbar={
          <FilterBar
            search={{
              value: query,
              onChange: onSearch,
              placeholder: 'Search broker, MC or contact',
            }}
            values={{}}
            onChange={() => {}}
            onClear={() => onSearch('')}
          >
            <Button variant="primary" size="sm" icon={<Plus />} onClick={onAdd}>
              Add broker
            </Button>
          </FilterBar>
        }
        toolbarRight={
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="secondary" size="sm" icon={<ListFilter />}>
                Filters{search.risk ? ' · 1' : ''}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="flex w-64 flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Risk
                <Select
                  size="sm"
                  options={[
                    { value: '', label: 'Any risk' },
                    ...BROKER_RISK_ORDER.map((level) => ({
                      value: level,
                      label: BROKER_RISK_LABEL[level],
                    })),
                  ]}
                  value={search.risk ?? ''}
                  onValueChange={(value) => onRisk((value || undefined) as BrokersSearch['risk'])}
                />
              </label>
              {search.risk ? (
                <Button variant="ghost" size="sm" onClick={() => onRisk(undefined)}>
                  Clear filters
                </Button>
              ) : null}
            </PopoverContent>
          </Popover>
        }
      />
      <p className="border-t border-line-soft px-5 py-2 text-xs text-muted">
        Unavailable metrics are shown as {DASH}.
      </p>
      {actions.dialog}
    </div>
  );
}

function BrokersSkeleton() {
  return (
    <div role="status" aria-label="Loading brokers" className="flex flex-col gap-3">
      <Skeleton className="h-96 rounded-lg" />
    </div>
  );
}
