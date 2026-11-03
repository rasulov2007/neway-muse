import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Building2,
  CircleDashed,
  CircleDollarSign,
  Download,
  FileText,
  Fuel,
  Gauge,
  Octagon,
  Receipt,
  Scale,
  Truck,
  UserRound,
  Wrench,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  MAINTENANCE_TYPE_LABEL,
  weekStartMonday,
  type FleetAnomaly,
  type FleetExpenseListQueryInput,
  type FleetExpenseSummary,
  type FleetMetric,
  type FleetSpendEvent,
  type FleetSpendPeriod,
  type FleetUnitTypeFilter,
  type FleetVehicleRow,
} from '@neway/shared';
import {
  Badge,
  Button,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
  StatusSymbol,
  cn,
} from '@/design-system';
import { today as companyToday } from '@/lib/clock';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { ExpensePeriodPicker } from './ExpensePeriodPicker';
import { useCanSeeExpenses, useExpenseDashboard } from './expenses/api';
import { ExpenseKpi } from './expenses/expense-ui';
import { money } from './expenses/expense-format';
import { InvestigationPanel } from './expenses/investigations';
import { useCanSeeInvestigations, useInvestigations } from './expenses/investigations-api';
import { useExpenseOverlays } from './expenses/use-expense-overlays';
import { expenseSearchSchema, parseUnits, periodStart } from './expense-search';
import { SpendDonut } from './SpendDonut';
import { useFleetExpense } from './useFleetExpense';

const n = (v: number) => v.toLocaleString('en-US');
const PERIODS: ReadonlyArray<{ value: FleetSpendPeriod; label: string }> = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
];
const CATEGORY_BAR = [
  'bg-nw-chart-1',
  'bg-nw-done-icon',
  'bg-nw-warning-icon',
  'bg-nw-chart-2',
  'bg-nw-text-3',
  'bg-nw-neutral-icon',
];

/**
 * Expense summary as the owner drew it (2026-09-20): four figures, the last six months as bars,
 * spend by category, and the detail by truck, by shop or every expense. Every number is the
 * spend summary the API already computes - the period, the units and the shop only narrow it -
 * and a figure that cannot be measured says so rather than showing a smaller number.
 */
export function ExpenseSummaryPage() {
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => expenseSearchSchema.parse(rawSearch), [rawSearch]);
  const period = search.period ?? 'month';
  const units = useMemo(() => parseUnits(search.units), [search.units]);
  const unitType: FleetUnitTypeFilter = search.unitType ?? 'all';
  // Any day of the chosen week, month, quarter or year; absent means the current one (owner, 2026-10-09).
  const today = companyToday();
  const at = search.at ?? search.week ?? today;
  const isCurrent = (day: string) =>
    period === 'week' ? weekStartMonday(day) >= weekStartMonday(today) : periodStart(period, day) >= periodStart(period, today);
  // One Fleet dashboard (owner, 2026-10-13): maintenance and every other fleet expense together,
  // with one total and each part shown on its own beneath it.
  const scope = 'all' as const;
  const summary = useFleetExpense({ period, units, unitType, at: isCurrent(at) ? undefined : at, scope });
  const data = summary.data;
  const canSeeExpenses = useCanSeeExpenses();
  const expenseDash = useExpenseDashboard(data ? { from: data.meta.period.from, to: data.meta.period.to } : {});
  const xt = data && expenseDash.data && expenseDash.data.from === data.meta.period.from ? expenseDash.data.totals : null;
  const seesInvestigations = useCanSeeInvestigations();
  const investigations = useInvestigations({});
  const [openExpenseId, setOpenExpenseId] = useState<string | null>(null);
  const expenseOverlays = useExpenseOverlays({ openId: openExpenseId, onOpenId: setOpenExpenseId });
  const openList = (query: FleetExpenseListQueryInput) =>
    void navigate({ to: '/fleet/expenses/list', search: { ...query, from: data?.meta.period.from, to: data?.meta.period.to } as never });

  const [shop, setShop] = useState('');
  const [showAll, setShowAll] = useState(false);

  const setSearch = (patch: { period?: FleetSpendPeriod; unitType?: FleetUnitTypeFilter; at?: string }) =>
    void navigate({
      to: '/fleet',
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        if (next.period === 'month') delete next.period;
        // A new period starts at its current one; the current one needs no parameter.
        delete next.week;
        if (patch.period !== undefined || (typeof next.at === 'string' && isCurrent(next.at))) delete next.at;
        if (next.unitType === 'all') delete next.unitType;
        delete next.scope;
        return next;
      },
      replace: true,
    });

  const shops = useMemo(() => (data?.vendors.rows ?? []).map((v) => v.name).sort(), [data]);
  const shopEvents = useMemo(
    () => (data?.events ?? []).filter((e) => !shop || e.vendorName === shop),
    [data, shop],
  );
  const shopUnits = useMemo(() => new Set(shopEvents.map((e) => e.truckId)), [shopEvents]);

  const vehicleRows = useMemo(() => {
    return (data?.vehicles.rows ?? []).filter((r) => !shop || shopUnits.has(r.truckId));
  }, [data, shop, shopUnits]);
  // Flagged first (highest spend at the top), then the rest when asked for.
  const highSpend = useMemo(
    () =>
      new Set(
        (data?.anomalies.findings ?? [])
          .filter((a) => SPEND_RULES.has(a.rule))
          .map((a) => a.truckId),
      ),
    [data],
  );
  const flaggedRows = useMemo(
    () => vehicleRows.filter((r) => spendState(r, highSpend) !== 'normal'),
    [vehicleRows, highSpend],
  );
  const breakdownRows = useMemo(() => {
    const rows = showAll
      ? vehicleRows
      : vehicleRows.filter((r) => r.spend > 0 || flaggedRows.includes(r));
    return [...rows].sort((a, b) => {
      const rank = (r: FleetVehicleRow) =>
        spendState(r, highSpend) === 'high' ? 0 : spendState(r, highSpend) === 'shop' ? 1 : 2;
      return rank(a) - rank(b) || b.spend - a.spend;
    });
  }, [vehicleRows, flaggedRows, showAll, highSpend]);

  // Fleet Expenses (All fleet costs only) by unit: each gets its own breakdown line with its
  // reference and category, never a made-up work order.
  const fleetExpenses = useMemo(() => {
    const byUnit = new Map<string, FleetSpendEvent[]>();
    for (const e of data?.events ?? []) {
      if (e.kind !== 'fleet_expense') continue;
      byUnit.set(e.truckId, [...(byUnit.get(e.truckId) ?? []), e]);
    }
    return byUnit;
  }, [data]);

  const expenseEvents = useMemo(
    () => (data?.events ?? []).filter((e) => e.kind === 'fleet_expense').sort((a, b) => b.amount - a.amount || b.date.localeCompare(a.date)),
    [data],
  );

  const maxMonth = data ? Math.max(1, ...data.series.months.map((m) => m.spend)) : 1;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Costs"
        description="Every fleet cost in one place: maintenance and expenses, and who bears them."
        actions={
          <>
            <div
              className="flex gap-0.5 rounded-lg bg-nw-segment p-0.5"
              role="group"
              aria-label="Period"
            >
              {PERIODS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={period === p.value}
                  onClick={() => setSearch({ period: p.value })}
                  className={cn(
                    'h-8 rounded-md px-3 text-[12.5px] font-semibold text-nw-text-2',
                    period === p.value && 'bg-nw-accent text-nw-on-accent',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {/* One control: the week picker for Week, a month / quarter / year list for the others. */}
            <ExpensePeriodPicker period={period} at={at} today={today} onChange={(next) => setSearch({ at: next })} />
            <Select
              aria-label="Units"
              className="w-32"
              options={[
                { value: 'all', label: 'All units' },
                { value: 'truck', label: 'Trucks' },
                { value: 'trailer', label: 'Trailers' },
              ]}
              value={unitType}
              onValueChange={(v) => setSearch({ unitType: v as FleetUnitTypeFilter })}
            />
            <Select
              aria-label="Shops"
              className="w-40"
              options={[
                { value: '', label: 'All shops' },
                ...shops.map((s) => ({ value: s, label: s })),
              ]}
              value={shop}
              onValueChange={setShop}
              placeholder="All shops"
            />
            <Button
              variant="secondary"
              icon={<Download />}
              disabled={!data}
              onClick={() => data && exportCsv(data)}
            >
              Export
            </Button>
          </>
        }
      />

      {summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      ) : (
        <>
          {/* Figures: the total (maintenance and expenses beneath it), cost per mile, average, open estimates */}
          <section aria-label="Figures" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Figure
              icon={<Receipt />}
              family="done"
              label="Total fleet spend"
              metric={data?.kpis.totalSpend}
              format={(v) => formatMoney(v, { compact: v >= 1_000_000 })}
              hint={data ? `Maintenance ${formatMoney(data.split.maintenance)} · Expenses ${formatMoney(data.split.expenses)}` : undefined}
            />
            <Figure
              icon={<Gauge />}
              family="done"
              label="Maintenance cost per mile"
              metric={data?.kpis.costPerMile}
              format={(v) => `$${v.toFixed(3)}`}
              hint={data ? data.kpis.costPerMile.basis : undefined}
            />
            <Figure
              icon={<Truck />}
              family="done"
              label="Average per truck"
              metric={data?.kpis.averagePerVehicle}
              format={(v) => formatMoney(v)}
              hint={data ? `${data.meta.fleet.trucks} trucks` : undefined}
            />
            <Figure
              icon={<FileText />}
              family="warning"
              label="Open repair estimates"
              metric={undefined}
              value={data ? data.split.openRepairs.amount : undefined}
              format={(v) => formatMoney(v)}
              hint={data ? `${n(data.split.openRepairs.orders)} open ${data.split.openRepairs.orders === 1 ? 'repair' : 'repairs'} · not in spend yet` : undefined}
              loaded={Boolean(data)}
            />
          </section>

          {/* The expense figures (owner, 2026-10-13): what is under investigation, then what the company bears and what is still owed. */}
          {canSeeExpenses || seesInvestigations ? (
            <section aria-label="Expense figures" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {seesInvestigations ? (
                <ExpenseKpi
                  icon={<Scale />}
                  label="Under investigation"
                  value={investigations.data ? money(investigations.data.totalCents) : null}
                  hint={investigations.data ? `${investigations.data.items.length} ${investigations.data.items.length === 1 ? 'item' : 'items'}${investigations.data.overdueCount > 0 ? ` · ${investigations.data.overdueCount} overdue` : ''} · not deducted` : undefined}
                  onOpen={() => document.getElementById('costs-investigations')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  tone="warning"
                />
              ) : null}
              {canSeeExpenses ? (
                <>
                  <ExpenseKpi icon={<Building2 />} label="Company cost" value={xt ? money(xt.companyCents) : null} hint="What the company bears" onOpen={() => openList({ figure: 'company' })} />
                  <ExpenseKpi icon={<UserRound />} label="Driver charge outstanding" value={xt ? money(xt.driverOutstandingCents) : null} hint={xt ? `${money(xt.driverChargeCents)} assigned to drivers` : undefined} onOpen={() => openList({ figure: 'driver_outstanding' })} tone="warning" />
                  <ExpenseKpi icon={<CircleDollarSign />} label="Unpaid vendor bills" value={xt ? money(xt.unpaidBillsCents) : null} hint="Company-paid, not paid yet" onOpen={() => openList({ figure: 'unpaid_bills' })} tone="warning" />
                  <ExpenseKpi icon={<Fuel />} label="EFS recovery remaining" value={xt ? money(xt.efsRemainingCents) : null} hint="EFS charged to drivers, not yet deducted" onOpen={() => openList({ figure: 'efs_remaining' })} />
                </>
              ) : null}
            </section>
          ) : null}

          <div className="grid items-stretch gap-4 min-[1200px]:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            {/* Spend by category first (owner, 2026-09-29): the ring sweeps in; the legend carries share and amount. */}
            <Card padding="none" className="flex h-full flex-col overflow-hidden">
              <div className="border-b border-nw-border px-4 py-3">
                <h2 className="text-sm font-bold text-nw-text">Spend by category</h2>
              </div>
              <div className="flex flex-1 flex-col justify-center gap-4 px-5 py-4">
                {!data ? (
                  <p className="w-full py-10 text-center text-sm text-nw-text-3">Loading…</p>
                ) : data.categories.slices.length === 0 ? (
                  <p className="w-full py-10 text-center text-sm text-nw-text-3">
                    Nothing counted in this period.
                  </p>
                ) : (
                  <SpendDonut
                    slices={data.categories.slices}
                    total={data.categories.total}
                    /* Each category opens its own records, in this tab, with the overview's
                       period and units carried across so the two totals cannot disagree. */
                    hrefFor={(slice) =>
                      slice.key
                        ? {
                            to: '/fleet/spending/categories/$categoryId',
                            params: { categoryId: slice.key },
                            search,
                          }
                        : null
                    }
                  />
                )}
                {/* Who bears the total (owner, 2026-10-13): the parts add up to it. */}
                {data && data.categories.total > 0 ? <PayerSplit data={data} onOpenExpense={setOpenExpenseId} /> : null}
              </div>
            </Card>

            {/* Monthly maintenance spend */}
            <Card padding="none" className="flex h-full flex-col overflow-hidden">
              <div className="border-b border-nw-border px-4 py-3">
                <h2 className="text-sm font-bold text-nw-text">Monthly fleet spend</h2>
                <p className="text-[11.5px] text-nw-text-3">
                  {data ? `${data.series.months.at(-1)?.label ?? ''} in progress.` : 'Loading…'}
                </p>
              </div>
              {data ? (
                <div className="px-4 pt-4 pb-3">
                  <div
                    className="grid h-52 grid-cols-6 items-end gap-4"
                    role="img"
                    aria-label="Spend by month"
                  >
                    {data.series.months.map((m) => (
                      <div
                        key={m.month}
                        className="flex h-full flex-col items-center justify-end gap-1.5"
                      >
                        <span className="tabular text-[11.5px] font-bold text-nw-text">
                          {formatMoney(m.spend, { compact: true })}
                        </span>
                        <span
                          className={cn(
                            'w-full max-w-[64px] rounded-t-[4px]',
                            m.current ? 'bg-nw-accent' : 'bg-nw-chart-band',
                          )}
                          style={{
                            height: `${Math.max(2, Math.round((m.spend / maxMonth) * 100))}%`,
                          }}
                          title={`${m.label}: ${formatMoney(m.spend)} · ${m.events} records`}
                        />
                        <span className="text-[11.5px] text-nw-text-3">{m.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="px-4 py-10 text-center text-sm text-nw-text-3">Loading…</p>
              )}
            </Card>
          </div>

          {/* Spend by truck (owner, 2026-10-13, in place of What keeps coming back) and where money leaks. */}
          <div className="grid items-stretch gap-4 min-[1200px]:grid-cols-2">
            <SpendByTruckCard data={data} />
            <LeaksCard data={data} />
          </div>

          {seesInvestigations ? (
            <div id="costs-investigations" className="scroll-mt-4">
              <InvestigationPanel query={{}} />
            </div>
          ) : null}

          {/* Vehicle spend breakdown: the flagged units first, the rest on request; ten rows tall, then it scrolls. */}
          <Card padding="none" className="overflow-hidden" data-testid="vehicle-breakdown">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nw-border px-4 py-3">
              <div className="flex items-baseline gap-2">
                <h2 className="text-base font-extrabold text-nw-text">Vehicle spend breakdown</h2>
                {data ? (
                  <span className="text-xs text-nw-text-3">
                    {flaggedRows.length} flagged of {vehicleRows.length}
                  </span>
                ) : null}
              </div>
              {data && vehicleRows.length > flaggedRows.length ? (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="text-xs font-semibold text-nw-accent-ink hover:underline"
                >
                  {showAll ? 'Show flagged only' : `Show all ${vehicleRows.length} units`}
                </button>
              ) : null}
            </div>
            {!data ? (
              <p className="px-4 py-10 text-center text-sm text-nw-text-3">Loading…</p>
            ) : breakdownRows.length === 0 ? (
              <EmptyState
                title="No spend in this period"
                description="Repairs and oil changes completed in the period appear here by unit."
              />
            ) : (
              <div className={BREAKDOWN_SCROLL}>
              <table className="w-full table-fixed border-collapse text-[13px]">
                <colgroup>
                  <col style={{ width: 150 }} />
                  <col style={{ width: 120 }} />
                  <col style={{ width: 110 }} />
                  <col />
                  <col style={{ width: 150 }} />
                  <col style={{ width: 140 }} />
                </colgroup>
                <thead className="sticky top-0 z-[1]">
                  <tr className="border-b border-nw-border bg-nw-accent-tint text-left text-[11px] font-bold tracking-[.06em] text-nw-accent-ink uppercase">
                    <Th>Work order</Th>
                    <Th>Unit #</Th>
                    <Th>Type</Th>
                    <Th>Top category</Th>
                    <Th>Total spend</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {breakdownRows.flatMap((r) => {
                    const state = spendState(r, highSpend);
                    const dotFor = (match: (c: { type: string; label: string }) => boolean) => {
                      const i = data.categories.slices.findIndex(match);
                      return i < 0 ? 'bg-nw-text-3' : (CATEGORY_BAR[i % CATEGORY_BAR.length] ?? 'bg-nw-text-3');
                    };
                    // A unit with several ROs gets one line per RO, each with its own category and
                    // spend (owner, 2026-10-06); spend outside any RO keeps a line of its own.
                    const expenses = fleetExpenses.get(r.truckId) ?? [];
                    const lines: BreakdownLine[] = expenses.length > 0
                      ? [
                          ...r.workOrders.map((o) => ({
                            key: o.id,
                            order: { id: o.id, number: o.number },
                            category: o.typeLabel,
                            services: o.services,
                            spend: o.spend,
                            dot: dotFor((c) => c.label === o.typeLabel),
                          })),
                          // Whatever the unit spent outside its orders and its expenses: service records.
                          ...(() => {
                            const rest = r.spend - r.workOrders.reduce((n, o) => n + o.spend, 0) - expenses.reduce((n, e) => n + e.amount, 0);
                            return rest > 0.005
                              ? [{ key: r.truckId + ':other', order: null, category: 'Service records', services: Math.max(0, r.events - r.workOrders.reduce((n, o) => n + o.services, 0) - expenses.length), spend: Math.round(rest * 100) / 100, dot: 'bg-nw-text-3' }]
                              : [];
                          })(),
                        ]
                      : r.workOrders.length > 1
                        ? [
                            ...r.workOrders.map((o) => ({
                              key: o.id,
                              order: { id: o.id, number: o.number },
                              category: o.typeLabel,
                              services: o.services,
                              spend: o.spend,
                              dot: dotFor((c) => c.label === o.typeLabel),
                            })),
                            ...(r.otherSpend > 0
                              ? [{ key: r.truckId + ':other', order: null, category: 'Service records', services: r.events - r.workOrders.reduce((n, o) => n + o.services, 0), spend: r.otherSpend, dot: 'bg-nw-text-3' }]
                              : []),
                          ]
                        : [
                            {
                              key: r.truckId,
                              order:
                                r.workOrders.length === 1
                                  ? { id: r.workOrders[0]!.id, number: r.workOrders[0]!.number }
                                  : null,
                              category: r.topTypeLabel ?? 'No category',
                              services: r.events,
                              spend: r.spend,
                              dot: r.topType ? dotFor((c) => c.type === r.topType) : 'bg-nw-text-3',
                            },
                          ];
                    return lines.map((line) => ({ r, state, line }));
                  })
                    // Biggest amount first across every line, not grouped by unit (owner, 2026-10-20).
                    .sort((x, y) => y.line.spend - x.line.spend)
                    .map(({ r, state, line }) => (
                      <tr key={line.key} className="rounded-md hover:bg-nw-hover">
                        <Td>
                          {line.order ? (
                            // The route takes the order's id; the RO number is what a person reads.
                            <Link
                              to="/fleet/shop/$orderId"
                              params={{ orderId: line.order.id }}
                              className="font-semibold text-nw-accent-ink hover:underline"
                            >
                              {line.order.number}
                            </Link>
                          ) : (
                            <span className="text-nw-text-3">No work order</span>
                          )}
                        </Td>
                        <Td>
                          {r.kind === 'truck' ? (
                            <Link
                              to="/fleet/trucks/$truckId"
                              params={{ truckId: r.truckId }}
                              search={{ tab: 'maintenance' }}
                              className="font-bold text-nw-text hover:underline"
                              title={`Unit ${r.unitNumber} · maintenance`}
                            >
                              {r.unitNumber}
                            </Link>
                          ) : (
                            <span className="font-bold text-nw-text">{r.unitNumber}</span>
                          )}
                        </Td>
                        <Td className="text-nw-text-2">
                          {r.kind === 'truck' ? 'Truck' : 'Trailer'}
                        </Td>
                        <Td>
                          <span className="flex items-start gap-2">
                            <span
                              className={cn('mt-1.5 size-2 shrink-0 rounded-full', line.dot)}
                              aria-hidden
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-nw-text">{line.category}</span>
                              <span className="block text-[11.5px] text-nw-text-3">
                                {line.services} {line.services === 1 ? 'service' : 'services'}
                              </span>
                            </span>
                          </span>
                        </Td>
                        <Td className="tabular font-bold text-nw-text">{formatMoney(line.spend)}</Td>
                        <Td>
                          {state === 'high' ? (
                            <span className="inline-flex h-6 items-center gap-1 rounded-full bg-nw-danger px-2.5 text-xs font-bold text-nw-on-danger">
                              <Octagon aria-hidden className="size-3" />
                              High spend
                            </span>
                          ) : state === 'shop' ? (
                            <Badge tone="warning" icon={<Wrench aria-hidden />}>
                              In shop
                            </Badge>
                          ) : (
                            <Badge tone="neutral" icon={<CircleDashed aria-hidden />}>
                              Normal
                            </Badge>
                          )}
                        </Td>
                      </tr>
                    ))}
                </tbody>
              </table>
              </div>
            )}
          </Card>

          {/* Expense breakdown (owner, 2026-10-13): the same table for what is not maintenance. */}
          {canSeeExpenses ? (
            <ExpenseBreakdown events={expenseEvents} loaded={Boolean(data)} onOpen={(id) => setOpenExpenseId(id)} />
          ) : null}
        </>
      )}
      {expenseOverlays.overlays}
    </div>
  );
}

/** Ten 44px rows under a 36px header, then the table scrolls inside its own border. */
const BREAKDOWN_SCROLL = 'max-h-[476px] overflow-y-auto';

const PAYER_PARTS = [
  { key: 'company', label: 'Company', hint: 'company maintenance and costs', family: 'done' },
  { key: 'driver', label: 'Driver', hint: 'charged to drivers', family: 'moving' },
  { key: 'investigation', label: 'Investigation', hint: 'not decided yet', family: 'warning' },
  { key: 'warranty', label: 'Warranty', hint: 'claimed back', family: 'neutral' },
] as const;
type PayerKey = (typeof PAYER_PARTS)[number]['key'] | 'owner';

/** Each part in its own status colour (owner, 2026-10-13), always with its symbol and word. */
const PAYER_LOOK: Record<'done' | 'moving' | 'warning' | 'neutral', string> = {
  done: 'border-nw-done-border bg-nw-done-bg text-nw-done-text',
  moving: 'border-nw-moving-border bg-nw-moving-bg text-nw-moving-text',
  warning: 'border-nw-warning-border bg-nw-warning-bg text-nw-warning-text',
  neutral: 'border-nw-neutral-border bg-nw-neutral-bg text-nw-neutral-text',
};

/** Which events make up a part: the driver's share wherever there is one, the rest by payer. */
function inPart(e: FleetSpendEvent, key: PayerKey): boolean {
  if (key === 'driver') return e.driverShare > 0;
  if (key === 'company') return (e.payer === 'company' || e.payer === 'driver') && e.amount - e.driverShare > 0.005;
  return e.payer === key;
}
function partAmount(e: FleetSpendEvent, key: PayerKey): number {
  if (key === 'driver') return e.driverShare;
  if (key === 'company') return e.amount - e.driverShare;
  return e.amount;
}

/**
 * Who bears the period's total (owner, 2026-10-13): Company, Driver, Investigation and Warranty
 * (and Owner when an owner paid their own). Server figures; the parts add up to the total. Each
 * part opens the repairs and expenses inside it.
 */
function PayerSplit({ data, onOpenExpense }: { data: FleetExpenseSummary; onOpenExpense: (id: string) => void }) {
  const total = data.categories.total;
  const [open, setOpen] = useState<PayerKey | null>(null);
  const parts: Array<{ key: PayerKey; label: string; hint: string; family: keyof typeof PAYER_LOOK; value: number }> = [
    ...PAYER_PARTS.map((p) => ({ ...p, value: data.split[p.key] })),
    ...(data.split.owner > 0 ? [{ key: 'owner' as const, label: 'Vendor', hint: 'paid by the truck’s vendor', family: 'neutral' as const, value: data.split.owner }] : []),
  ];
  const chosen = parts.find((p) => p.key === open) ?? null;
  const rows = open ? data.events.filter((e) => inPart(e, open)).sort((a, b) => partAmount(b, open) - partAmount(a, open)) : [];
  return (
    <>
      <ul aria-label="Who bears it" className="grid grid-cols-2 gap-2 border-t border-nw-border pt-3 sm:grid-cols-4" data-testid="payer-split">
        {parts.map((p) => {
          const share = total > 0 ? Math.round((p.value / total) * 1000) / 10 : 0;
          return (
            <li key={p.key}>
              <button
                type="button"
                onClick={() => setOpen(p.key)}
                disabled={p.value <= 0}
                className={cn('w-full rounded-lg border px-3 py-2 text-left transition-shadow enabled:hover:shadow-sm disabled:cursor-default', PAYER_LOOK[p.family])}
                data-testid={`payer-${p.key}`}
              >
                <span className="flex items-center gap-1.5 text-[12px] font-semibold">
                  <StatusSymbol family={p.family} size={10} />
                  {p.label}
                </span>
                <span className="tabular block text-[15px] font-bold">{formatMoney(p.value)}</span>
                <span className="block text-[11px] opacity-80">
                  {share}% · {p.hint}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <Drawer
        open={chosen !== null}
        onOpenChange={(o) => !o && setOpen(null)}
        size="lg"
        title={chosen ? `${chosen.label} · ${formatMoney(chosen.value)}` : ''}
        description={chosen ? `${rows.length} ${rows.length === 1 ? 'record' : 'records'} in ${data.meta.period.label}` : undefined}
      >
        <ul className="divide-y divide-nw-border" data-testid="payer-records">
          {rows.map((e) => (
            <li key={`${e.kind}:${e.id}`} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 text-[13px] font-bold text-nw-text">
                  {e.kind === 'work_order' ? (
                    <Link to="/fleet/shop/$orderId" params={{ orderId: e.id }} className="text-nw-accent-ink hover:underline">
                      {e.reference}
                    </Link>
                  ) : e.kind === 'fleet_expense' ? (
                    <button type="button" onClick={() => onOpenExpense(e.id)} className="text-nw-accent-ink hover:underline">
                      {e.reference}
                    </button>
                  ) : (
                    <span className="truncate">{e.reference}</span>
                  )}
                  <span className="font-semibold text-nw-text-2">
                    {e.unitKind === 'trailer' ? 'Trailer' : 'Unit'} {e.unitNumber}
                  </span>
                  <span className="text-[11.5px] font-semibold text-nw-text-3">{e.kind === 'fleet_expense' ? 'Expense' : 'Repair'}</span>
                </span>
                <span className="block truncate text-xs text-nw-text-3">
                  {formatIsoDate(e.date)} · {MAINTENANCE_TYPE_LABEL[e.type] ?? 'Other'}
                  {e.vendorName ? ` · ${e.vendorName}` : ''}
                </span>
              </span>
              <span className="tabular text-sm font-bold text-nw-text">{formatMoney(open ? partAmount(e, open) : e.amount)}</span>
            </li>
          ))}
        </ul>
      </Drawer>
    </>
  );
}

/** Spend by truck (owner, 2026-10-13): the trucks that cost most in the period, as bars. */
function SpendByTruckCard({ data }: { data: FleetExpenseSummary | undefined }) {
  const [all, setAll] = useState(false);
  const rows = (data?.vehicles.rows ?? []).filter((r) => r.kind === 'truck' && r.spend > 0).sort((a, b) => b.spend - a.spend);
  const shown = all ? rows : rows.slice(0, 8);
  const top = rows[0]?.spend ?? 1;
  return (
    <Card padding="none" className="flex h-full flex-col overflow-hidden" data-testid="spend-by-truck">
      <div className="border-b border-nw-border px-4 py-3">
        <h2 className="text-sm font-bold text-nw-text">Spend by truck</h2>
      </div>
      {!data ? (
        <p className="px-4 py-10 text-center text-sm text-nw-text-3">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState className="flex-1" icon={<Truck />} title="No truck spend in this period" description="Repairs and expenses on trucks appear here." />
      ) : (
        <>
          <ul className={cn('flex flex-col gap-1 px-3 py-3', all && 'max-h-[440px] overflow-y-auto')}>
            {shown.map((r) => (
              <li key={r.truckId}>
                <Link
                  to="/fleet/trucks/$truckId"
                  params={{ truckId: r.truckId }}
                  search={{ tab: 'maintenance' }}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-nw-hover"
                >
                  <span className="w-24 shrink-0 truncate text-[13px] font-semibold text-nw-text">Unit {r.unitNumber}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-nw-chart-band" aria-hidden>
                    <span className="block h-full rounded-full bg-nw-accent" style={{ width: `${Math.max(2, Math.round((r.spend / top) * 100))}%` }} />
                  </span>
                  <span className="w-28 shrink-0 text-right">
                    <span className="tabular block text-[13px] font-bold text-nw-text">{formatMoney(r.spend)}</span>
                    <span className="block text-[11px] text-nw-text-3">
                      {r.events} {r.events === 1 ? 'record' : 'records'}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {rows.length > 8 ? (
            <button type="button" onClick={() => setAll((v) => !v)} className="mx-4 mb-3 self-start text-xs font-semibold text-nw-accent-ink hover:underline">
              {all ? 'Show fewer' : `Show all ${rows.length} trucks`}
            </button>
          ) : null}
        </>
      )}
    </Card>
  );
}

const PAYER_WORD: Record<FleetSpendEvent['payer'], string> = {
  company: 'Company',
  driver: 'Driver',
  investigation: 'Under investigation',
  warranty: 'Warranty',
  owner: 'Vendor',
};

/** The expense lines of the period (cash advances, parking, tolls ...), ten rows tall, then it scrolls. */
function ExpenseBreakdown({ events, loaded, onOpen }: { events: FleetSpendEvent[]; loaded: boolean; onOpen: (id: string) => void }) {
  const total = events.reduce((s, e) => s + e.amount, 0);
  return (
    <Card padding="none" className="overflow-hidden" data-testid="expense-breakdown">
      <div className="flex flex-wrap items-baseline gap-2 border-b border-nw-border px-4 py-3">
        <h2 className="text-base font-extrabold text-nw-text">Expense breakdown</h2>
        {loaded ? (
          <span className="text-xs text-nw-text-3">
            {events.length} {events.length === 1 ? 'expense' : 'expenses'} · {formatMoney(total)} · not maintenance
          </span>
        ) : null}
      </div>
      {!loaded ? (
        <p className="px-4 py-10 text-center text-sm text-nw-text-3">Loading…</p>
      ) : events.length === 0 ? (
        <EmptyState title="No expenses in this period" description="Cash advances, parking, tolls and washes added from the Repair log appear here." />
      ) : (
        <div className={BREAKDOWN_SCROLL}>
          <table className="w-full table-fixed border-collapse text-[13px]">
            <colgroup>
              <col style={{ width: 150 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 110 }} />
              <col />
              <col style={{ width: 150 }} />
              <col style={{ width: 170 }} />
            </colgroup>
            <thead className="sticky top-0 z-[1]">
              <tr className="border-b border-nw-border bg-nw-accent-tint text-left text-[11px] font-bold tracking-[.06em] text-nw-accent-ink uppercase">
                <Th>Expense</Th>
                <Th>Unit #</Th>
                <Th>Date</Th>
                <Th>Category</Th>
                <Th>Amount</Th>
                <Th>Charge to</Th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="hover:bg-nw-hover">
                  <Td>
                    <button type="button" onClick={() => onOpen(e.id)} className="font-semibold text-nw-accent-ink hover:underline">
                      {e.reference}
                    </button>
                  </Td>
                  <Td>
                    <Link to="/fleet/trucks/$truckId" params={{ truckId: e.truckId }} search={{ tab: 'expenses' } as never} className="font-bold text-nw-text hover:underline">
                      {e.unitNumber}
                    </Link>
                  </Td>
                  <Td className="text-nw-text-2">{formatIsoDate(e.date)}</Td>
                  <Td>
                    <span className="block truncate text-nw-text">{MAINTENANCE_TYPE_LABEL[e.type] ?? 'Other'}</span>
                    {e.vendorName ? <span className="block truncate text-[11.5px] text-nw-text-3">{e.vendorName}</span> : null}
                  </Td>
                  <Td className="tabular font-bold text-nw-text">{formatMoney(e.amount)}</Td>
                  <Td>
                    {e.payer === 'investigation' ? (
                      <Badge tone="warning" icon={<StatusSymbol family="warning" size={10} />}>
                        Under investigation
                      </Badge>
                    ) : (
                      <span className="text-nw-text-2">
                        {PAYER_WORD[e.payer]}
                        {e.driverShare > 0 && e.driverShare < e.amount ? ` · driver ${formatMoney(e.driverShare)}` : ''}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/**
 * Where a unit stands on the breakdown: over its usual spend (a spend rule caught it), in the
 * shop now (its stored status), or nothing to say. The finding comes from the server's rules;
 * nothing is worked out here.
 */
const SPEND_RULES: ReadonlySet<FleetAnomaly['rule']> = new Set([
  'spend_spike',
  'expensive_service',
  'cpm_above_median',
]);

/** One line of the spend breakdown: a unit's RO, or the unit as a whole when it has one or none. */
interface BreakdownLine {
  key: string;
  order: { id: string; number: string } | null;
  category: string;
  services: number;
  spend: number;
  dot: string;
}

function spendState(
  r: FleetVehicleRow,
  highSpend: ReadonlySet<string>,
): 'high' | 'shop' | 'normal' {
  if (highSpend.has(r.truckId)) return 'high';
  if (r.status === 'in_shop') return 'shop';
  return 'normal';
}

// ------------------------------------------------------------------------------------ pieces

const ACTION_LINK =
  'inline-flex h-7 shrink-0 items-center rounded-md border border-nw-border-strong bg-nw-panel px-2.5 text-xs font-semibold text-nw-text hover:bg-nw-hover';


/**
 * Leaks - money and time to get back: every other rule the server ran, one line per rule with
 * the units it caught. A rule that could not run says why instead of showing a clean zero.
 */
function LeaksCard({ data }: { data: FleetExpenseSummary | undefined }) {
  const checks = (data?.anomalies.checks ?? []).filter((c) => c.rule !== 'repeat_service');
  const byRule = new Map<string, FleetAnomaly[]>();
  for (const f of data?.anomalies.findings ?? []) {
    if (f.rule === 'repeat_service') continue;
    byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  }
  return (
    <Card padding="none" className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-nw-border px-4 py-3">
        <h2 className="text-sm font-bold text-nw-text">Leaks — money and time we can get back</h2>
      </div>
      {!data ? (
        <p className="px-4 py-10 text-center text-sm text-nw-text-3">Loading…</p>
      ) : checks.length === 0 ? (
        <p className="px-4 py-6 text-sm text-nw-text-3">No checks ran for this period.</p>
      ) : (
        <ul className="divide-y divide-nw-border">
          {checks.map((c) => {
            const hits = byRule.get(c.rule) ?? [];
            const units = [...new Set(hits.map((h) => h.unitNumber))];
            const worst = hits.find((h) => h.severity === 'critical') ?? hits[0];
            const line =
              c.status === 'unavailable'
                ? `Not available · ${c.reason ?? ''}`
                : hits.length === 0
                  ? `Nothing found · ${c.threshold}`
                  : `${units.slice(0, 4).join(', ')}${units.length > 4 ? ` +${units.length - 4}` : ''} · ${c.threshold}`;
            return (
              <li key={c.rule} className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-bold text-nw-text">{c.label}</span>
                  <span className="block truncate text-xs text-nw-text-2">{line}</span>
                </span>
                <span className="text-right">
                  <span className="tabular block text-sm font-bold text-nw-text">
                    {c.status === 'unavailable' ? '—' : units.length}
                  </span>
                  <span className="block text-[11px] text-nw-text-3">
                    {units.length === 1 ? 'unit' : 'units'}
                  </span>
                </span>
                {worst ? (
                  <Link
                    to="/fleet/trucks/$truckId"
                    params={{ truckId: worst.truckId }}
                    className={ACTION_LINK}
                  >
                    Review
                  </Link>
                ) : (
                  <span className="inline-flex h-7 w-16 shrink-0" aria-hidden />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function Figure({
  icon,
  family,
  label,
  metric,
  value,
  format,
  hint,
  loaded,
}: {
  icon: ReactNode;
  family: 'done' | 'warning';
  label: string;
  metric: FleetMetric | undefined;
  /** A plain server number, when the figure is not a metric. */
  value?: number;
  format: (v: number) => string;
  hint?: string;
  loaded?: boolean;
}) {
  const ready = metric !== undefined || loaded;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-nw-border bg-nw-panel px-4 py-3.5">
      <span
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4',
          family === 'done'
            ? 'bg-nw-done-bg text-nw-done-icon'
            : 'bg-nw-warning-bg text-nw-warning-icon',
        )}
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold text-nw-text-2">{label}</span>
        <span className="tabular block text-[26px] leading-[1.15] font-bold tracking-[-0.02em] text-nw-text">
          {!ready ? (
            <span className="text-sm font-medium text-nw-text-3">Loading…</span>
          ) : value !== undefined ? (
            format(value)
          ) : metric && metric.value !== null ? (
            format(metric.value)
          ) : (
            '—'
          )}
        </span>
        <span className="block text-xs text-nw-text-3">
          {ready
            ? metric && metric.value === null && metric.reasons[0]
              ? metric.reasons[0]
              : hint
            : ''}
        </span>
      </span>
    </div>
  );
}

function Th({ children, className }: { children: ReactNode; className?: string }) {
  return <th className={cn('h-[36px] px-3 align-middle font-bold', className)}>{children}</th>;
}

function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn('h-[44px] px-3 py-1.5 align-middle', className)}>{children}</td>;
}

function exportCsv(data: FleetExpenseSummary) {
  const head = ['Date', 'Unit', 'Kind', 'Reference', 'Type', 'Shop', 'Amount', 'Source', 'Bears it', 'Driver share'];
  const lines = data.events.map((e) => [
    e.date,
    e.unitNumber,
    e.unitKind,
    e.reference,
    MAINTENANCE_TYPE_LABEL[e.type],
    e.vendorName ?? '',
    e.amount,
    e.kind === 'fleet_expense' ? 'expense' : e.amountSource,
    PAYER_WORD[e.payer],
    e.driverShare,
  ]);
  const csv = [head, ...lines]
    .map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `expense-summary-${data.meta.period.from}-to-${data.meta.period.to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
