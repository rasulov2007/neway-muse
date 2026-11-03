import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { CheckCircle2, ExternalLink, Play, Plus, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  DataTable,
  FilterBar,
  MenuItem,
  PageHeader,
  StatusBadge,
  cn,
  createColumns,
  getStatus,
  useToast,
  type DataTableState,
  type FilterDefinition,
} from '@/design-system';
import {
  updateRepairOrder,
  workOrderTransitions,
  type RepairOrder,
  type RepairOrderStatus,
} from '@/demo';
import { isLateWorkOrder } from '@neway/shared';
import { formatDate, formatMoney } from '@/lib/format';
import { CreateWorkOrderDialog } from './components/CreateWorkOrderDialog';
import { maintenanceSearchSchema, type MaintenanceSearch } from './maintenance-search';
import { FleetExceptionPanel } from './components/FleetExceptionPanel';
import { ConditionQueuePanel } from './components/PtiConditionPanels';
import { FleetSummaryStrip, type FleetSummarySegment } from './components/FleetSummaryStrip';
import { DASH } from './fleet-ui';
import { unitLinkFor } from './unit-link';
import { useLeaseOperatorTrucks } from './lease-operator';
import { useFleet, useInvalidateFleet } from './useFleet';

const ACTIVE_STATUSES = new Set<RepairOrderStatus>(['open', 'scheduled', 'in_shop']);

const PRIORITY_TONE: Record<RepairOrder['priority'], 'neutral' | 'info' | 'warning' | 'danger'> = {
  low: 'neutral',
  normal: 'info',
  high: 'warning',
  urgent: 'danger',
};

/**
 * The one predicate the table filters on and the strip counts with.
 *
 * `today` is passed in rather than read from the clock so the same call produces the same answer
 * for the counts and for the rows.
 */
function matchesOrder(order: RepairOrder, filters: MaintenanceSearch, today: string): boolean {
  const ids = filters.ids ? filters.ids.split(',').filter(Boolean) : [];
  if (ids.length > 0 && !ids.includes(order.id)) return false;

  if (filters.view === 'active' && !ACTIVE_STATUSES.has(order.status)) return false;
  // One definition of late, shared with the banner count and the Promised column (`isLateWorkOrder`),
  // so the filter can never show a different set of rows than the number that led here.
  if (filters.view === 'overdue' && !isLateWorkOrder(order, today)) return false;
  if (
    filters.view &&
    filters.view !== 'active' &&
    filters.view !== 'overdue' &&
    order.status !== filters.view
  ) {
    return false;
  }
  if (filters.unit && order.unitNumber !== filters.unit) return false;
  if (filters.priority && order.priority !== filters.priority) return false;

  const q = filters.q?.trim().toLowerCase();
  if (q) {
    const haystack = [
      order.roNumber,
      order.unitNumber,
      order.summary,
      order.vendorName,
      order.technician,
    ];
    if (!haystack.some((value) => value?.toLowerCase().includes(q))) return false;
  }
  return true;
}

const col = createColumns<RepairOrder>();

/**
 * The maintenance command centre.
 *
 * The status vocabulary here is the backend's own `RepairOrderStatus` — draft, open, scheduled,
 * in shop, completed, cancelled — not a friendlier set invented for the screen. The actions a row
 * offers come from `workOrderTransitions`, which is the same table the write path enforces, so the
 * UI cannot offer a move the API will refuse.
 */
export function MaintenancePage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => maintenanceSearchSchema.parse(rawSearch), [rawSearch]);
  const navigate = useNavigate();
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();
  const [rowSelection, setRowSelection] = useState<DataTableState['rowSelection']>({});
  const [columnVisibility, setColumnVisibility] = useState<DataTableState['columnVisibility']>({});
  const [creating, setCreating] = useState(false);

  const fleetQuery = useFleet();
  const bundle = fleetQuery.data;
  const today = bundle?.today ?? '';

  const loTrucks = useLeaseOperatorTrucks();
  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: RepairOrderStatus }) => {
      const order = bundle?.workOrders.find((o) => o.id === id);
      return updateRepairOrder({ id, status, invoiceOptional: order ? order.unitType !== 'trailer' && loTrucks.has(order.truckId) : false });
    },
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({ tone: 'danger', title: 'That change was refused', description: result.blocked });
        return;
      }
      await invalidate();
      toast({
        tone: 'success',
        title: `${result.order?.roNumber} is now ${getStatus(result.order?.status ?? 'open').label.toLowerCase()}`,
      });
    },
  });

  function updateSearch(patch: Partial<MaintenanceSearch>) {
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

  const rows = useMemo(
    () => (bundle?.workOrders ?? []).filter((order) => matchesOrder(order, search, today)),
    [bundle, search, today],
  );

  const counts = useMemo(() => {
    const base = (bundle?.workOrders ?? []).filter((order) =>
      matchesOrder(order, { ...search, view: undefined }, today),
    );
    return {
      total: base.length,
      active: base.filter((o) => ACTIVE_STATUSES.has(o.status)).length,
      scheduled: base.filter((o) => o.status === 'scheduled').length,
      in_shop: base.filter((o) => o.status === 'in_shop').length,
      completed: base.filter((o) => o.status === 'completed').length,
      overdue: base.filter((o) => isLateWorkOrder(o, today)).length,
    };
  }, [bundle, search, today]);

  const segments: FleetSummarySegment[] = useMemo(() => {
    const define = (
      key: string,
      label: string,
      count: number,
      tone?: FleetSummarySegment['tone'],
    ): FleetSummarySegment => ({
      key,
      label,
      count: bundle ? count : null,
      tone,
      onSelect: () =>
        updateSearch({
          view: search.view === key ? undefined : key === '__total' ? undefined : key,
          ids: undefined,
          page: undefined,
        }),
    });
    return [
      define('__total', 'All', counts.total),
      define('active', 'Active', counts.active),
      define('scheduled', 'Scheduled', counts.scheduled),
      define('in_shop', 'In progress', counts.in_shop),
      define('completed', 'Completed', counts.completed, 'success'),
      // Overdue is last and red because it is the only segment that is a problem rather than a
      // stage; a foreman scanning the strip should find it without reading the labels.
      define('overdue', 'Overdue', counts.overdue, 'danger'),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle, counts, search.view]);

  const filters = useMemo<FilterDefinition[]>(
    () => [
      {
        key: 'view',
        label: 'Status',
        type: 'select',
        options: [
          { value: 'active', label: 'Active' },
          { value: 'open', label: 'Open' },
          { value: 'scheduled', label: 'Scheduled' },
          { value: 'in_shop', label: 'In progress' },
          { value: 'completed', label: 'Completed' },
          { value: 'cancelled', label: 'Cancelled' },
          { value: 'overdue', label: 'Past promised date' },
        ],
      },
      {
        key: 'priority',
        label: 'Priority',
        type: 'select',
        options: (['urgent', 'high', 'normal', 'low'] as const).map((value) => ({
          value,
          label: value[0]?.toUpperCase() + value.slice(1),
        })),
      },
    ],
    [bundle],
  );

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor('openedAt', {
          header: 'Date',
          cell: ({ getValue }) => formatDate(getValue()),
          meta: { width: 110 },
        }),
        col.display({
          id: 'roNumber',
          header: 'WO #',
          meta: { primary: true, width: 110 },
          cell: ({ row }) => (
            <Link
              to="/fleet/maintenance/$orderId"
              params={{ orderId: row.original.id }}
              className="font-medium text-primary-text hover:underline"
            >
              {row.original.roNumber}
            </Link>
          ),
        }),
        col.display({
          id: 'unit',
          header: 'Unit',
          meta: { width: 90 },
          cell: ({ row }) => (
            <Link {...unitLinkFor(row.original)} className="hover:underline">
              {row.original.unitType === 'trailer'
                ? `T ${row.original.unitNumber}`
                : row.original.unitNumber}
            </Link>
          ),
        }),
        col.accessor('type', {
          header: 'Type',
          cell: ({ getValue }) => getValue().replace(/_/g, ' '),
          meta: { width: 140 },
        }),
        col.accessor('summary', { header: 'Description' }),
        col.accessor('status', {
          header: 'Status',
          cell: ({ getValue }) => <StatusBadge status={getValue()} />,
          meta: { width: 120 },
        }),
        col.accessor('priority', {
          header: 'Priority',
          cell: ({ getValue }) => (
            <Badge tone={PRIORITY_TONE[getValue()]}>
              {getValue()[0]?.toUpperCase() + getValue().slice(1)}
            </Badge>
          ),
          meta: { width: 100 },
        }),
        col.accessor('technician', {
          header: 'Technician',
          cell: ({ getValue }) => getValue() || <span className="text-faint">{DASH}</span>,
        }),
        col.accessor('total', {
          header: 'Cost',
          cell: ({ getValue, row }) =>
            row.original.status === 'completed' || getValue() > 0 ? (
              formatMoney(getValue())
            ) : (
              <span className="text-faint" title="Costs are recorded when the shop invoices.">
                {DASH}
              </span>
            ),
          meta: { align: 'right', width: 110 },
        }),
        col.accessor('promisedAt', {
          header: 'Promised',
          cell: ({ getValue, row }) => {
            const value = getValue();
            if (!value) return <span className="text-faint">{DASH}</span>;
            const late = isLateWorkOrder(row.original, today);
            return (
              <span className={cn(late && 'font-medium text-danger-text')}>
                {formatDate(value)}
              </span>
            );
          },
          meta: { width: 120 },
        }),
      ]),
    [today],
  );

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Maintenance"
        description="Every work order in the fleet — what is booked, what is in a shop, and what is running late."
      />

      {/* Planning: what the walk-around videos say needs the shop, before it becomes a breakdown. */}
      <ConditionQueuePanel />

      {bundle ? (
        <FleetExceptionPanel
          items={bundle.exceptions.items.filter((item) => item.target.to === '/fleet/maintenance')}
          onSelect={(item) =>
            updateSearch({
              ...item.target.search,
              ids: item.ids.length > 0 ? item.ids.join(',') : undefined,
              page: undefined,
            })
          }
        />
      ) : null}

      <FleetSummaryStrip
        segments={segments}
        activeKey={search.view ?? (search.ids ? null : '__total')}
        loading={fleetQuery.isPending}
      />

      <DataTable
        columns={columns}
        data={rows}
        rowKey={(order) => order.id}
        state={{
          sorting: [],
          pagination: { page: search.page ?? 1, pageSize: 25 },
          rowSelection,
          columnVisibility,
          globalFilter: '',
        }}
        onStateChange={(patch) => {
          if (patch.pagination !== undefined) {
            updateSearch({
              page: patch.pagination.page > 1 ? patch.pagination.page : undefined,
            });
          }
          if (patch.rowSelection !== undefined) setRowSelection(patch.rowSelection);
          if (patch.columnVisibility !== undefined) setColumnVisibility(patch.columnVisibility);
        }}
        loading={fleetQuery.isPending}
        error={fleetQuery.error ?? undefined}
        onRetry={() => void fleetQuery.refetch()}
        emptyTitle="No work orders match"
        emptyDescription="Try another search or clear the filters."
        selectable
        caption="Work orders"
        onRowClick={(order) =>
          setRowSelection((current) => {
            // `RowSelectionState` carries only selected keys, so deselecting removes
            // the key rather than storing `false`.
            const next = { ...current };
            if (next[order.id]) delete next[order.id];
            else next[order.id] = true;
            return next;
          })
        }
        onRowDoubleClick={(order) =>
          void navigate({ to: '/fleet/maintenance/$orderId', params: { orderId: order.id } })
        }
        toolbar={
          <FilterBar
            search={{
              value: search.q ?? '',
              onChange: (value) => updateSearch({ q: value || undefined, page: undefined }),
              placeholder: 'Search WO, unit, vendor…',
            }}
            filters={filters}
            values={{ view: search.view, priority: search.priority }}
            onChange={(key, value) =>
              updateSearch({
                [key]: (value as string | undefined) || undefined,
                ids: undefined,
                page: undefined,
              })
            }
            onClear={() =>
              updateSearch({
                view: undefined,
                unit: undefined,
                priority: undefined,
                ids: undefined,
                page: undefined,
              })
            }
          >
            {/* Search, filters and the primary action on one row. */}
            <span className="ml-auto flex items-center gap-2">
              <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                Create work order
              </Button>
            </span>
          </FilterBar>
        }
        rowActions={(order) => (
          <WorkOrderActions
            order={order}
            onOpen={() =>
              void navigate({ to: '/fleet/maintenance/$orderId', params: { orderId: order.id } })
            }
            onMove={(status) => move.mutate({ id: order.id, status })}
          />
        )}
      />

      <CreateWorkOrderDialog
        open={creating}
        onOpenChange={setCreating}
        trucks={bundle?.trucks ?? []}
        trailers={bundle?.trailers ?? []}
        onDone={() => setCreating(false)}
      />
    </div>
  );
}

/**
 * The actions a work order offers are the transitions the write path actually allows.
 *
 * Reading them from `workOrderTransitions` rather than hand-listing them here is what stops the
 * menu from offering "Complete" on a scheduled order that the API will refuse.
 */
function WorkOrderActions({
  order,
  onOpen,
  onMove,
}: {
  order: RepairOrder;
  onOpen: () => void;
  onMove: (status: RepairOrderStatus) => void;
}) {
  const allowed = workOrderTransitions(order.status);
  const ICON: Partial<Record<RepairOrderStatus, typeof Play>> = {
    in_shop: Play,
    completed: CheckCircle2,
    open: RotateCcw,
  };
  const LABEL: Partial<Record<RepairOrderStatus, string>> = {
    open: order.status === 'completed' ? 'Reopen' : 'Move to open',
    scheduled: 'Schedule',
    in_shop: order.status === 'completed' ? 'Reopen work' : 'Start work',
    completed: 'Complete',
    cancelled: 'Cancel work order',
  };

  return (
    <>
      <MenuItem icon={<ExternalLink />} onSelect={onOpen}>
        Open work order
      </MenuItem>
      {allowed.map((status) => {
        const Icon = ICON[status];
        return (
          <MenuItem
            key={status}
            icon={Icon ? <Icon /> : undefined}
            destructive={status === 'cancelled'}
            onSelect={() => onMove(status)}
          >
            {LABEL[status] ?? status.replace(/_/g, ' ')}
          </MenuItem>
        );
      })}
    </>
  );
}
