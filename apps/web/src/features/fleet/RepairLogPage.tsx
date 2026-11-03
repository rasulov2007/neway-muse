import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Container,
  Download,
  FileText,
  Plus,
  Receipt,
  Search,
  Truck,
  Wrench,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  SHOP_STAGE_LABEL,
  WORK_TYPE_LABEL,
  type WorkOrder,
  type WorkOrderWithCost,
} from '@neway/shared';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
  StatusSymbol,
  cn,
  useToast,
  type StatusSymbolFamily,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { apiPost } from '@/lib/api-client';
import { syncDriverChargeDeduction } from '@/demo';
import { today as companyToday } from '@/lib/clock';
import { formatDate, formatMoney } from '@/lib/format';
import { isEnabled } from '@/lib/feature-flags';
import { maintenanceSearchSchema } from './maintenance-search';
import { MaintenancePage } from './MaintenancePage';
import { CreateWorkOrderDialog, type WorkOrderUnitRef } from './components/CreateWorkOrderDialog';
import { useFleet } from './useFleet';
import { useCanSeeExpenses, useExpenseOptions } from './expenses/api';
import { RepairLogExpenses } from './expenses/RepairLogExpenses';
import { useExpenseOverlays } from './expenses/use-expense-overlays';
import { useWorkOrders } from './useFleetToday';

const PAGE = 50;

/** Not finished, and the date the shop was booked for has gone by (against the start of today). */
function isLate(o: WorkOrder, today: string): boolean {
  return (
    o.status !== 'completed' &&
    o.scheduledFor !== null &&
    Date.parse(o.scheduledFor) < Date.parse(`${today}T00:00:00Z`)
  );
}

/** Truck / Trailer narrow the repairs; Expenses is everything that is not maintenance (owner, 2026-10-13). */
type Segment = 'all' | 'active' | 'completed' | 'truck' | 'trailer' | 'expenses';

/** The repair log needs the Fleet upgrade's work orders; without the flag the old table stands. */
export function RepairLogRoute() {
  return isEnabled('fleet_v2') ? <RepairLogPage /> : <MaintenancePage />;
}

/**
 * The repair log as the owner drew it (2026-09-20): every work order from opening to completion
 * in one table - who, what, where, how far along, when it was promised or finished, what it cost
 * - with five numbers above it that are counts of those same rows.
 */
export function RepairLogPage() {
  const account = useAccount();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => maintenanceSearchSchema.parse(rawSearch), [rawSearch]);
  const seesCost = account?.permissions.includes('maintenance_costs.view') ?? false;
  const orders = useWorkOrders();
  const fleet = useFleet();
  const [repairFor, setRepairFor] = useState<WorkOrderUnitRef | null>(null);
  const today = companyToday();

  const [q, setQ] = useState('');
  const [shop, setShop] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(search.create === 'tires' || search.create === 'repair');
  const canSeeExpenses = useCanSeeExpenses();
  const expenseOptions = useExpenseOptions();
  const canAddExpense = expenseOptions.data?.permissions.canEdit ?? false;
  const expenseOverlays = useExpenseOverlays();
  // The nav's five views map onto the segments; `view` stays in the URL as it always has.
  const segment: Segment =
    search.view === 'completed'
      ? 'completed'
      : search.view === 'truck' || search.view === 'trailer' || (search.view === 'expenses' && canSeeExpenses)
        ? search.view
        : search.view === 'active' ||
          search.view === 'in_shop' ||
          search.view === 'scheduled' ||
          search.view === 'overdue'
        ? 'active'
        : 'all';
  const setSegment = (next: Segment) => {
    setPage(1);
    void navigate({
      to: '/fleet/maintenance',
      search: next === 'all' ? {} : { view: next },
      replace: true,
    });
  };

  // Active orders first, newest opened first; the completed ones follow in the same order.
  const rows = useMemo(
    () =>
      [...(orders.data ?? [])].sort(
        (a, b) =>
          Number(a.status === 'completed') - Number(b.status === 'completed') ||
          Date.parse(b.createdAt) - Date.parse(a.createdAt),
      ),
    [orders.data],
  );
  /*
   * Units held in maintenance on the unit itself with no open repair behind them (owner,
   * 2026-10-16: 0018 and 0031 read In maintenance on Trucks but were nowhere here). They count in
   * In maintenance and are listed with Create repair, the one step that puts the work on record.
   */
  const unitsWithoutRepair = useMemo(() => {
    if (!fleet.data || !orders.data) return [];
    const covered = new Set(
      orders.data
        .filter((o) => o.status !== 'completed')
        .map((o) => `${o.assetType}:${o.unitId}`),
    );
    const held = (status: string) => status === 'in_shop' || status === 'maintenance';
    return [
      ...fleet.data.trucks
        .filter((t) => held(t.truck.status) && !covered.has(`truck:${t.truck.id}`))
        .map((t) => ({ kind: 'truck' as const, id: t.truck.id, unitNumber: t.truck.unitNumber })),
      ...fleet.data.trailers
        .filter((t) => held(t.trailer.status) && !covered.has(`trailer:${t.trailer.id}`))
        .map((t) => ({ kind: 'trailer' as const, id: t.trailer.id, unitNumber: t.trailer.unitNumber })),
    ];
  }, [fleet.data, orders.data]);
  const counts = useMemo(
    () => ({
      active: rows.filter((o) => o.status !== 'completed').length,
      scheduled: rows.filter((o) => o.status === 'scheduled').length,
      inShop: rows.filter((o) => o.status === 'in_shop').length,
      completed: rows.filter((o) => o.status === 'completed').length,
      truck: rows.filter((o) => o.assetType === 'truck').length,
      trailer: rows.filter((o) => o.assetType === 'trailer').length,
      overdue: rows.filter((o) => isLate(o, today)).length,
    }),
    [rows, today],
  );
  /*
   * Charges waiting on the driver being told.
   *
   * A repair charged to a driver who has not been told is money nobody may take yet, so it is
   * said here in words rather than left as a quiet flag: the list is the place the person who can
   * make the call is already looking.
   */
  const held = useMemo(
    () => rows.filter((o) => o.charge.party === 'driver' && o.charge.driverInformed !== true),
    [rows],
  );
  const heldTotal = held.reduce((sum, o) => (hasCost(o) ? sum + o.total : sum), 0);
  const markInformed = useMutation({
    mutationFn: async (order: WorkOrder | WorkOrderWithCost) => {
      const saved = await apiPost<WorkOrder>(`/fleet/work-orders/${order.id}/charge`, {
        party: 'driver',
        driverInformed: true,
        note: 'Driver told about the charge',
      });
      // The held deduction starts running now, and only now.
      if (saved.charge.driverId) {
        syncDriverChargeDeduction({
          orderId: saved.id,
          orderNumber: saved.number,
          driverId: saved.charge.driverId,
          amount: hasCost(order) ? order.total : 0,
          informed: true,
          summary: saved.workDone ?? saved.label,
          startsOn: saved.completedAt ?? saved.createdAt,
        });
      }
      return saved;
    },
    onSuccess: async () => {
      toast({ title: 'Driver informed', description: 'Accounting can take this off their pay.' });
      await queryClient.invalidateQueries({ queryKey: ['work-orders'] });
    },
    onError: (e: unknown) => {
      toast({
        title: 'That did not save',
        description: e instanceof Error ? e.message : 'Try again.',
        tone: 'danger',
      });
    },
  });

  const shops = useMemo(
    () => [...new Set(rows.map((o) => o.vendorName).filter((v): v is string => Boolean(v)))].sort(),
    [rows],
  );
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((o) => {
      if (segment === 'active' && o.status === 'completed') return false;
      if (segment === 'completed' && o.status !== 'completed') return false;
      if (segment === 'truck' && o.assetType !== 'truck') return false;
      if (segment === 'trailer' && o.assetType !== 'trailer') return false;
      if (search.view === 'overdue' && !isLate(o, today)) return false;
      if (search.view === 'in_shop' && o.status !== 'in_shop') return false;
      if (search.view === 'scheduled' && o.status !== 'scheduled') return false;
      if (shop && o.vendorName !== shop) return false;
      if (
        needle &&
        !`${o.number} ${o.unitNumber} ${o.driverName ?? ''} ${o.vendorName ?? ''} ${o.workDone ?? ''} ${o.label}`
          .toLowerCase()
          .includes(needle)
      )
        return false;
      return true;
    });
  }, [rows, segment, search.view, shop, q, today]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const current = Math.min(page, pages);
  const shown = filtered.slice((current - 1) * PAGE, current * PAGE);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Repair log"
        description="Track every repair from opening to completion."
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Download />}
              disabled={filtered.length === 0}
              onClick={() => exportCsv(filtered, seesCost)}
            >
              Export
            </Button>
            {canAddExpense ? (
              // Its own button beside Create repair (owner, 2026-10-13): cash advance, parking, tolls...
              <Button variant="primary" icon={<Receipt />} onClick={expenseOverlays.addExpense} data-testid="add-expense">
                Add expense
              </Button>
            ) : null}
            <Button
              variant="primary"
              icon={<Plus />}
              onClick={() => setCreating(true)}
            >
              Create repair
            </Button>
          </>
        }
      />

      <section
        aria-label="Summary"
        className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5"
      >
        <Tile
          label="Active"
          value={orders.data ? counts.active : undefined}
          icon={<FileText />}
          family="moving"
        />
        <Tile
          label="Scheduled"
          value={orders.data ? counts.scheduled : undefined}
          icon={<Calendar />}
          family="moving"
        />
        <Tile
          label="In maintenance"
          value={orders.data && fleet.data ? counts.inShop + unitsWithoutRepair.length : undefined}
          icon={<Wrench />}
          family="warning"
        />
        <Tile
          label="Completed"
          value={orders.data ? counts.completed : undefined}
          icon={<CircleCheck />}
          family="done"
        />
        <Tile
          label="Overdue"
          value={orders.data ? counts.overdue : undefined}
          hint="Across active repairs"
          icon={<StatusSymbol family="urgent" size={16} />}
          family="urgent"
        />
      </section>

      {unitsWithoutRepair.length > 0 ? (
        <section
          aria-label="In maintenance with no repair"
          className="rounded-md border border-nw-warning-text bg-nw-warning-bg px-4 py-3"
        >
          <h2 className="flex items-center gap-2 text-sm font-bold text-nw-warning-text">
            <StatusSymbol family="warning" size={14} />
            {unitsWithoutRepair.length === 1
              ? '1 unit is in maintenance with no repair'
              : `${unitsWithoutRepair.length} units are in maintenance with no repair`}
          </h2>
          <p className="mt-1 text-xs text-nw-warning-text">
            They were added as In shop, so the shop, the work and its cost are not on record. Create
            the repair; closing it returns the unit to service.
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {unitsWithoutRepair.map((u) => (
              <li key={`${u.kind}:${u.id}`}>
                <Button size="sm" variant="secondary" icon={<Wrench />} onClick={() => setRepairFor({ kind: u.kind, id: u.id })}>
                  {u.kind === 'trailer' ? 'Trailer' : 'Unit'} {u.unitNumber} · Create repair
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {held.length > 0 ? (
        <section
          aria-label="Charges waiting on the driver"
          className="rounded-md border border-nw-urgent-text bg-nw-urgent-bg px-4 py-3"
        >
          <h2 className="flex items-center gap-2 text-sm font-bold text-nw-urgent-text">
            <StatusSymbol family="urgent" size={14} className="text-nw-urgent-icon" />
            {held.length === 1
              ? '1 repair is charged to a driver who has not been told'
              : `${held.length} repairs are charged to drivers who have not been told`}
            {seesCost && heldTotal > 0 ? ` · ${formatMoney(heldTotal)} held` : ''}
          </h2>
          <p className="mt-1 text-xs text-nw-urgent-text">
            Nothing comes off a driver's pay until somebody tells them. Accounting shows the same
            charges as held. Use "Driver told" on the row once the driver knows.
          </p>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-nw-urgent-text">
            {held.slice(0, 6).map((o) => (
              <li key={o.id}>
                {o.number} · Unit {o.unitNumber}
                {o.charge.driverName ? ` · ${o.charge.driverName}` : ''}
                {seesCost && hasCost(o) ? ` · ${formatMoney(o.total)}` : ''}
              </li>
            ))}
            {held.length > 6 ? <li>and {held.length - 6} more</li> : null}
          </ul>
        </section>
      ) : null}
      <Card padding="none" className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nw-border px-3 py-2.5">
          <div
            className="flex gap-0.5 rounded-lg bg-nw-segment p-0.5"
            role="group"
            aria-label="Show"
          >
            {(
              [
                ['all', 'All repairs', rows.length],
                ['active', 'Active', counts.active],
                ['completed', 'Completed', counts.completed],
                ['truck', 'Truck', counts.truck],
                ['trailer', 'Trailer', counts.trailer],
                ...(canSeeExpenses ? ([['expenses', 'Expenses', null]] as const) : []),
              ] as ReadonlyArray<readonly [Segment, string, number | null]>
            ).map(([value, label, count]) => (
              <button
                key={value}
                type="button"
                aria-pressed={segment === value}
                onClick={() => setSegment(value)}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-semibold text-nw-text-2',
                  segment === value && 'bg-nw-accent text-nw-on-accent',
                )}
              >
                {label}
                {orders.data && count !== null ? (
                  <span
                    className={cn(
                      'tabular rounded-full px-1.5 text-[11px] font-bold',
                      segment === value ? 'bg-nw-on-accent/20' : 'bg-nw-panel text-nw-text-3',
                    )}
                  >
                    {count}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <div className={cn('flex flex-wrap items-center gap-2', segment === 'expenses' && 'hidden')}>
            <label className="flex h-9 w-[220px] items-center gap-2 rounded-lg border border-nw-border-strong bg-nw-field px-2.5 text-[12.5px] text-nw-text-3 focus-within:border-nw-accent">
              <Search className="size-3.5 shrink-0" aria-hidden />
              <input
                type="search"
                aria-label="Search order, unit or shop"
                placeholder="Search order, unit or shop"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
                className="w-full min-w-0 bg-transparent text-nw-text outline-none placeholder:text-nw-text-3"
              />
            </label>
            <Select
              aria-label="Shop"
              className="w-40"
              options={[
                { value: '', label: 'All shops' },
                ...shops.map((s) => ({ value: s, label: s })),
              ]}
              value={shop}
              onValueChange={(v) => {
                setShop(v);
                setPage(1);
              }}
              placeholder="All shops"
            />
          </div>
        </div>

        {segment === 'expenses' ? (
          <RepairLogExpenses onOpen={expenseOverlays.openRow} />
        ) : orders.isPending ? (
          <p className="px-5 py-10 text-center text-sm text-nw-text-3">Loading…</p>
        ) : orders.isError ? (
          <ErrorState error={orders.error} onRetry={() => void orders.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No repairs on record"
            description="The first work order opened from a repair, a walk-around defect or an oil change appears here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] table-fixed border-collapse text-[13px]">
              <colgroup>
                <col style={{ width: 118 }} />
                <col style={{ width: 130 }} />
                <col />
                <col style={{ width: 180 }} />
                <col style={{ width: 138 }} />
                <col style={{ width: 138 }} />
                {seesCost ? <col style={{ width: 90 }} /> : null}
                <col style={{ width: 196 }} />
              </colgroup>
              <thead>
                <tr className="border-b border-nw-border bg-nw-subtle text-left text-[11px] font-bold tracking-[.06em] text-nw-text-2 uppercase">
                  <Th>Order / opened</Th>
                  <Th>Unit / driver</Th>
                  <Th>Repair description</Th>
                  <Th>Shop / vendor</Th>
                  <Th>Status</Th>
                  <Th>Due / completed</Th>
                  {seesCost ? <Th>Cost</Th> : null}
                  <Th>Action</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((o) => (
                  <Row
                    key={o.id}
                    order={o}
                    late={isLate(o, today)}
                    seesCost={seesCost}
                    onInformed={() => markInformed.mutate(o)}
                    saving={markInformed.isPending}
                  />
                ))}
                {shown.length === 0 ? (
                  <tr>
                    <td
                      colSpan={seesCost ? 8 : 7}
                      className="px-5 py-10 text-center text-sm text-nw-text-3"
                    >
                      Nothing matches. Clear the search or the shop.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
        <div className={cn('flex items-center justify-between gap-3 border-t border-nw-border px-4 py-2 text-xs text-nw-text-3', segment === 'expenses' && 'hidden')}>
          <span>
            {filtered.length === 0
              ? 'Showing 0'
              : `Showing ${(current - 1) * PAGE + 1}–${Math.min(current * PAGE, filtered.length)} of ${filtered.length}`}
          </span>
          {pages > 1 ? (
            <nav className="flex items-center gap-1" aria-label="Pages">
              <button
                type="button"
                aria-label="Previous page"
                disabled={current === 1}
                onClick={() => setPage(current - 1)}
                className="grid size-7 place-items-center rounded-md border border-nw-border text-nw-text-2 disabled:opacity-40"
              >
                <ChevronLeft className="size-3.5" aria-hidden />
              </button>
              {Array.from({ length: Math.min(pages, 7) }, (_, i) => i + 1).map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-current={p === current ? 'page' : undefined}
                  onClick={() => setPage(p)}
                  className={cn(
                    'tabular grid size-7 place-items-center rounded-md border text-xs font-semibold',
                    p === current
                      ? 'border-nw-accent bg-nw-accent text-nw-on-accent'
                      : 'border-nw-border text-nw-text-2',
                  )}
                >
                  {p}
                </button>
              ))}
              <button
                type="button"
                aria-label="Next page"
                disabled={current === pages}
                onClick={() => setPage(current + 1)}
                className="grid size-7 place-items-center rounded-md border border-nw-border text-nw-text-2 disabled:opacity-40"
              >
                <ChevronRight className="size-3.5" aria-hidden />
              </button>
            </nav>
          ) : null}
        </div>
      </Card>
      {/* Tires open on the Tires type: the Tire work order lives in Create work order (owner, 2026-10-15). */}
      <CreateWorkOrderDialog
        open={creating || repairFor !== null}
        defaultUnit={repairFor}
        defaultWorkType={search.create === 'tires' ? 'tires' : undefined}
        onOpenChange={(open) => {
          setCreating(open);
          if (!open) setRepairFor(null);
          if (!open && search.create) void navigate({ to: '.', search: (prev: Record<string, unknown>) => ({ ...prev, create: undefined }) as never, replace: true });
        }}
        onDone={() => {
          setCreating(false);
          setRepairFor(null);
        }}
      />
      {expenseOverlays.overlays}
    </div>
  );
}

// ------------------------------------------------------------------------------------ pieces

const TILE_ICON: Record<'urgent' | 'warning' | 'done' | 'moving', string> = {
  urgent: 'bg-nw-urgent-bg text-nw-urgent-icon',
  warning: 'bg-nw-warning-bg text-nw-warning-icon',
  done: 'bg-nw-done-bg text-nw-done-icon',
  moving: 'bg-nw-moving-bg text-nw-moving-icon',
};

function Tile({
  label,
  value,
  hint,
  icon,
  family,
}: {
  label: string;
  value: number | undefined;
  hint?: string;
  icon: ReactNode;
  family: 'urgent' | 'warning' | 'done' | 'moving';
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-nw-border bg-nw-panel px-4 py-3">
      <span
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-lg [&_svg]:size-4',
          TILE_ICON[family],
        )}
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold text-nw-text-2">{label}</span>
        <span className="flex items-baseline gap-2">
          <span className="tabular text-[24px] leading-[1.15] font-bold tracking-[-0.02em] text-nw-text">
            {value === undefined ? (
              <span className="text-sm font-medium text-nw-text-3">Loading…</span>
            ) : (
              value
            )}
          </span>
          {hint ? <span className="text-xs text-nw-text-3">{hint}</span> : null}
        </span>
      </span>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th className="h-[36px] border-r border-nw-border px-3 align-middle font-bold last:border-r-0">
      {children}
    </th>
  );
}

function Td({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <td
      className={cn(
        'h-[48px] border-r border-nw-border px-3 py-1.5 align-middle last:border-r-0',
        className,
      )}
    >
      {children}
    </td>
  );
}

const PILL: Record<StatusSymbolFamily, string> = {
  urgent: 'bg-nw-urgent-bg text-nw-urgent-text ring-nw-urgent-border',
  warning: 'bg-nw-warning-bg text-nw-warning-text ring-nw-warning-border',
  done: 'bg-nw-done-bg text-nw-done-text ring-nw-done-border',
  moving: 'bg-nw-moving-bg text-nw-moving-text ring-nw-moving-border',
  neutral: 'bg-nw-neutral-bg text-nw-neutral-text ring-nw-neutral-border',
  inShop: 'bg-nw-warning-bg text-nw-warning-text ring-nw-warning-border',
  info: 'bg-nw-neutral-bg text-nw-neutral-text ring-nw-neutral-border',
};
const ICON: Record<StatusSymbolFamily, string> = {
  urgent: 'text-nw-urgent-icon',
  warning: 'text-nw-warning-icon',
  done: 'text-nw-done-icon',
  moving: 'text-nw-moving-icon',
  neutral: 'text-nw-neutral-icon',
  inShop: 'text-nw-warning-icon',
  info: 'text-nw-neutral-icon',
};

function shortDate(iso: string): string {
  return formatDate(iso).replace(/, \d{4}$/, '');
}

function hasCost(o: WorkOrder | WorkOrderWithCost): o is WorkOrderWithCost {
  return 'total' in o;
}

function Row({
  order: o,
  late,
  seesCost,
  onInformed,
  saving,
}: {
  order: WorkOrder | WorkOrderWithCost;
  late: boolean;
  seesCost: boolean;
  onInformed: () => void;
  saving: boolean;
}) {
  const driverCharge = o.charge.party === 'driver';
  const heldCharge = driverCharge && o.charge.driverInformed !== true;
  const family: StatusSymbolFamily =
    o.status === 'completed' ? 'done' : o.status === 'in_shop' ? 'inShop' : 'moving';
  const statusWord =
    o.status === 'completed' ? 'Completed' : o.status === 'in_shop' ? 'In maintenance' : 'Scheduled';
  const stage = o.status === 'in_shop' && o.shopStage ? SHOP_STAGE_LABEL[o.shopStage] : null;
  const cost = hasCost(o)
    ? o.status === 'completed'
      ? { value: o.total, kind: 'Final' }
      : o.estimatedCost !== null
        ? { value: o.estimatedCost, kind: 'Estimate' }
        : null
    : null;
  return (
    <tr className="border-b border-nw-border last:border-b-0 hover:bg-nw-hover">
      <Td>
        <span className="block font-bold text-nw-text">{o.number}</span>
        <span className="block text-[11.5px] text-nw-text-3">opened {shortDate(o.createdAt)}</span>
      </Td>
      <Td>
        <span className="flex items-center gap-2">
          {o.assetType === 'trailer' ? (
            <Container className="size-3.5 shrink-0 text-nw-text-3" aria-hidden />
          ) : (
            <Truck className="size-3.5 shrink-0 text-nw-text-3" aria-hidden />
          )}
          <span className="min-w-0">
            {o.assetType === 'truck' ? (
              <Link
                to="/fleet/trucks/$truckId"
                params={{ truckId: o.unitId }}
                /* Straight to the unit's Maintenance tab: somebody clicking a repair wants that
                   unit's work, not its overview. */
                search={{ tab: 'maintenance' }}
                className="block truncate font-bold text-nw-text hover:underline"
              >
                Unit {o.unitNumber}
              </Link>
            ) : (
              <span className="block truncate font-bold text-nw-text">{o.unitNumber}</span>
            )}
            <span className="block truncate text-[11.5px] text-nw-text-3">
              {o.driverName ?? (o.assetType === 'trailer' ? 'Trailer' : 'No driver')}
            </span>
          </span>
        </span>
      </Td>
      <Td>
        <span className="block truncate font-semibold text-nw-text">{o.workDone ?? o.label}</span>
        <span className="block truncate text-[11.5px] text-nw-text-3">
          {WORK_TYPE_LABEL[o.workType]}
          {o.pmServiceCode ? ' · PM' : ''}
          {o.defectId ? ' · from a walk-around defect' : ''}
        </span>
        {driverCharge ? (
          <span className="mt-1 flex flex-wrap items-center gap-1">
            <span className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-semibold bg-nw-info-bg text-nw-info-text">
              <StatusSymbol family="info" size={10} className="text-nw-info-icon" />
              Driver charge{o.charge.driverName ? ` · ${o.charge.driverName}` : ''}
            </span>
            {heldCharge ? (
              <span className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-bold bg-nw-urgent-bg text-nw-urgent-text">
                <StatusSymbol family="urgent" size={10} className="text-nw-urgent-icon" />
                Driver not informed
              </span>
            ) : null}
          </span>
        ) : null}
        {o.charge.party === 'investigation' ? (
          <span className="mt-1 inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-bold bg-nw-warning-bg text-nw-warning-text">
            <StatusSymbol family="warning" size={10} className="text-nw-warning-icon" />
            Under investigation{o.charge.driverName ? ` · ${o.charge.driverName}` : ''}
          </span>
        ) : o.charge.party === 'warranty' ? (
          <span className="mt-1 inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-semibold bg-nw-moving-bg text-nw-moving-text">
            <StatusSymbol family="info" size={10} className="text-nw-moving-icon" />
            Warranty claim
          </span>
        ) : null}
      </Td>
      <Td>
        {/* No shop on the order: whoever did the work reads as the shop, bold (owner, 2026-10-19). */}
        <span className="block truncate font-semibold text-nw-text">{o.vendorName?.trim() || o.assignedTo?.trim() || o.responsibleName || '—'}</span>
        {o.vendorName?.trim() ? (
          <span className="block truncate text-[11.5px] text-nw-text-3">{o.responsibleName ?? o.assignedTo ?? ''}</span>
        ) : null}
      </Td>
      <Td>
        <span
          className={cn(
            'inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-semibold whitespace-nowrap ring-1 ring-inset',
            PILL[family],
          )}
        >
          <StatusSymbol family={family} size={12} className={ICON[family]} />
          {statusWord}
        </span>
        {stage ? <span className="block pl-0.5 text-[11.5px] text-nw-text-3">{stage}</span> : null}
      </Td>
      <Td>
        {o.status === 'completed' && o.completedAt ? (
          <span className="text-nw-text-2">Completed {shortDate(o.completedAt)}</span>
        ) : o.scheduledFor ? (
          <>
            <span
              className={cn('block', late ? 'font-semibold text-nw-urgent-text' : 'text-nw-text-2')}
            >
              Due {shortDate(o.scheduledFor)}
            </span>
            {late ? <span className="block text-[11.5px] text-nw-urgent-text">Overdue</span> : null}
          </>
        ) : (
          <span className="text-nw-text-3">—</span>
        )}
      </Td>
      {seesCost ? (
        <Td>
          {cost ? (
            <>
              <span className="tabular block font-semibold text-nw-text">
                {formatMoney(cost.value, { compact: cost.value >= 10_000 })}
              </span>
              <span className="block text-[11.5px] text-nw-text-3">{cost.kind}</span>
            </>
          ) : (
            <span className="text-nw-text-3">—</span>
          )}
        </Td>
      ) : null}
      <Td>
        {/* Driver told, the invoice and View fit the column, wrapping rather than spilling (owner, 2026-10-19). */}
        <span className="flex flex-wrap items-center justify-end gap-1">
          {o.status === 'completed' && hasCost(o) && o.invoiceFileIds.length > 0 ? (
            <Link
              to="/fleet/shop/$orderId"
              params={{ orderId: o.id }}
              aria-label="Invoice on file"
              className="grid size-7 place-items-center rounded-md border border-nw-border text-nw-text-2 hover:bg-nw-hover"
            >
              <FileText className="size-3.5" aria-hidden />
            </Link>
          ) : null}
          {heldCharge ? (
            <button
              type="button"
              onClick={onInformed}
              disabled={saving}
              title="Record that the driver has been told; accounting may then take it off their pay"
              className="inline-flex h-7 items-center rounded-md border border-nw-urgent-text bg-nw-urgent-bg px-2 text-[11px] font-bold whitespace-nowrap text-nw-urgent-text disabled:opacity-50"
            >
              Driver told
            </button>
          ) : null}
          <Link
            to="/fleet/shop/$orderId"
            params={{ orderId: o.id }}
            className="inline-flex h-7 items-center rounded-md border border-nw-border-strong bg-nw-panel px-2.5 text-xs font-semibold text-nw-text hover:bg-nw-hover"
          >
            View
          </Link>
          <ChevronRight className="size-3.5 text-nw-text-3" aria-hidden />
        </span>
      </Td>
    </tr>
  );
}

function exportCsv(rows: (WorkOrder | WorkOrderWithCost)[], seesCost: boolean) {
  const head = [
    'Order',
    'Opened',
    'Unit',
    'Driver',
    'Description',
    'Type',
    'Shop',
    'Status',
    'Stage',
    'Due',
    'Completed',
    ...(seesCost ? ['Estimate', 'Total', 'Invoice #'] : []),
  ];
  const lines = rows.map((o) => [
    o.number,
    o.createdAt,
    o.unitNumber,
    o.driverName ?? '',
    o.workDone ?? o.label,
    WORK_TYPE_LABEL[o.workType],
    o.vendorName ?? '',
    o.status,
    o.shopStage ?? '',
    o.scheduledFor ?? '',
    o.completedAt ?? '',
    ...(seesCost && hasCost(o)
      ? [o.estimatedCost ?? '', o.total, o.invoiceNumber ?? '']
      : seesCost
        ? ['', '', '']
        : []),
  ]);
  const csv = [head, ...lines]
    .map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `repair-log-${companyToday()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
