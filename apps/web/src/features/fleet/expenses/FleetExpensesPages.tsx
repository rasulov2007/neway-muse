import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Building2, CircleDollarSign, FileDown, Fuel, Info, Plus, Receipt, UserRound, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  FLEET_EXPENSE_CATEGORIES,
  FLEET_EXPENSE_CATEGORY_LABEL,
  FLEET_EXPENSE_CHARGE_TO,
  FLEET_EXPENSE_CHARGE_TO_LABEL,
  FLEET_EXPENSE_PAYERS,
  FLEET_EXPENSE_PAYER_LABEL,
  FLEET_EXPENSE_SOURCES,
  FLEET_EXPENSE_SOURCE_LABEL,
  FLEET_PAYMENT_STATUSES,
  FLEET_PAYMENT_STATUS_LABEL,
  FLEET_RECOVERY_STATUSES,
  FLEET_RECOVERY_STATUS_LABEL,
  type FleetExpenseTotals,
} from '@neway/shared';
import {
  Button,
  Card,
  DateRangePicker,
  EmptyState,
  ErrorState,
  FilterBar,
  PageHeader,
  Pagination,
  Select,
  cn,
  useToast,
  type DateRange,
  type DateRangePreset,
  type FilterDefinition,
} from '@/design-system';
import { today as companyToday } from '@/lib/clock';
import { FUEL_RANGE_PRESETS, formatRange } from '../fuel-ledger';
import { SpendDonut, type SpendSlice } from '../SpendDonut';
import { EXPENSE_REPORT_PDF_PATH, errorText, fetchPdf, useExpenseDashboard, useExpenseList, useExpenseOptions } from './api';
import { ExpenseKpi } from './expense-ui';
import { money } from './expense-format';
import { ExpensesTable } from './ExpensesTable';
import { useExpenseOverlays } from './use-expense-overlays';
import {
  EXPENSE_FIGURE_LABEL,
  EXPENSE_PAGE_SIZE,
  fleetExpensesSearchSchema,
  listQueryOf,
  type FleetExpensesSearch,
} from './expenses-search';

type Patch = Partial<Record<keyof FleetExpensesSearch, unknown>>;

function useExpensesSearch(): FleetExpensesSearch {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  return useMemo(() => fleetExpensesSearchSchema.parse(raw), [raw]);
}

/** Writes a patch into the URL; an empty value removes the parameter. */
function useSetSearch(to: '/fleet/expenses' | '/fleet/expenses/list') {
  const navigate = useNavigate();
  return (patch: Patch) =>
    void navigate({
      to,
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        for (const [key, value] of Object.entries(next)) if (value === undefined || value === '' || value === null || value === false) delete next[key];
        return next;
      },
      replace: true,
      resetScroll: false,
    });
}

/** Dashboard | Expenses: two pages of one area, switched like a segment. */
function ExpensesTabs({ active }: { active: 'dashboard' | 'list' }) {
  const tab = (to: '/fleet' | '/fleet/expenses/list', label: string, on: boolean) => (
    <Link
      to={to}
      className={cn('inline-flex h-8 items-center rounded-md px-3.5 text-[12.5px] font-semibold text-nw-text-2 hover:text-nw-text', on && 'bg-nw-accent text-nw-on-accent shadow-sm hover:text-nw-on-accent')}
      aria-current={on ? 'page' : undefined}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Fleet Expenses" className="inline-flex w-fit gap-0.5 rounded-lg bg-nw-segment p-0.5">
      {/* The dashboard is Costs now (owner, 2026-10-13): one Fleet dashboard. */}
      {tab('/fleet', 'Costs', active === 'dashboard')}
      {tab('/fleet/expenses/list', 'Expenses', active === 'list')}
    </nav>
  );
}

const toPickerDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};
const fromPickerDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** The date range, with presets counted from the company's today (never the browser's). */
function RangePicker({ from, to, onChange, allowAll }: { from?: string; to?: string; onChange: (r: { from?: string; to?: string }) => void; allowAll?: boolean }) {
  const today = companyToday();
  const presets: DateRangePreset[] = [
    ...FUEL_RANGE_PRESETS.map((p) => ({
      label: p.label,
      range: () => {
        const r = p.range(today);
        return { from: toPickerDate(r.from), to: toPickerDate(r.to) };
      },
    })),
    { label: 'Year to date', range: () => ({ from: toPickerDate(`${today.slice(0, 4)}-01-01`), to: toPickerDate(today) }) },
  ];
  return (
    <span className="inline-flex items-center gap-1">
      <DateRangePicker
        aria-label="Date range"
        className="w-auto min-w-0 sm:min-w-56"
        value={from && to ? { from: toPickerDate(from), to: toPickerDate(to) } : null}
        presets={presets}
        placeholder={allowAll ? 'All dates' : 'Loading…'}
        formatValue={() => (from && to ? formatRange({ from, to }) : '')}
        onChange={(next: DateRange | undefined) =>
          next?.from ? onChange({ from: fromPickerDate(next.from), to: fromPickerDate(next.to ?? next.from) }) : onChange({ from: undefined, to: undefined })
        }
      />
      {allowAll && from ? (
        <button type="button" aria-label="All dates" onClick={() => onChange({ from: undefined, to: undefined })} className="grid size-7 place-items-center rounded-md text-nw-text-3 hover:bg-nw-hover">
          <X aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </span>
  );
}

const ALL = (label: string) => ({ value: '', label });

// ============================================================================ Dashboard

export function FleetExpensesDashboardPage() {
  const search = useExpensesSearch();
  const setSearch = useSetSearch('/fleet/expenses');
  const navigate = useNavigate();
  const options = useExpenseOptions();
  const params = { from: search.from, to: search.to, truckId: search.truckId, category: search.category, chargeTo: search.chargeTo };
  const dash = useExpenseDashboard(params);
  const data = dash.data;
  const { openRow, addExpense, overlays } = useExpenseOverlays();
  const canEdit = options.data?.permissions.canEdit ?? false;

  // The range on screen: the URL's, else what the server counted (the company's default).
  const from = search.from ?? data?.from ?? options.data?.defaultFrom;
  const to = search.to ?? data?.to ?? options.data?.defaultTo;
  const filtered = Boolean(search.truckId || search.category || search.chargeTo);

  /** A KPI opens the list narrowed to exactly the rows behind it. */
  const openList = (extra: Patch = {}) =>
    void navigate({
      to: '/fleet/expenses/list',
      search: Object.fromEntries(Object.entries({ from, to, truckId: search.truckId, category: search.category, chargeTo: search.chargeTo, ...extra }).filter(([, v]) => v !== undefined)) as never,
    });

  const t = data?.totals;
  const value = (pick: (x: FleetExpenseTotals) => number) => (t ? money(pick(t)) : null);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Fleet Expenses"
        description="What every truck costs the fleet, who paid it and who bears it."
        actions={canEdit ? <Button icon={<Plus />} onClick={addExpense}>Add expense</Button> : null}
      />
      <ExpensesTabs active="dashboard" />

      <div className="flex flex-wrap items-center gap-2">
        <RangePicker from={from} to={to} onChange={(r) => setSearch(r)} />
        <Select
          aria-label="Truck"
          className="w-36"
          options={[ALL('All trucks'), ...(options.data?.trucks ?? []).map((tk) => ({ value: tk.id, label: `Unit ${tk.unitNumber}` }))]}
          value={search.truckId ?? ''}
          onValueChange={(v) => setSearch({ truckId: v })}
        />
        <Select
          aria-label="Category"
          className="w-44"
          options={[ALL('All categories'), ...FLEET_EXPENSE_CATEGORIES.map((c) => ({ value: c, label: FLEET_EXPENSE_CATEGORY_LABEL[c] }))]}
          value={search.category ?? ''}
          onValueChange={(v) => setSearch({ category: v })}
        />
        <Select
          aria-label="Charge to"
          className="w-40"
          options={[ALL('Any charge party'), ...FLEET_EXPENSE_CHARGE_TO.map((c) => ({ value: c, label: `Charge to ${FLEET_EXPENSE_CHARGE_TO_LABEL[c]}` }))]}
          value={search.chargeTo ?? ''}
          onValueChange={(v) => setSearch({ chargeTo: v })}
        />
      </div>

      {dash.isError ? (
        <ErrorState error={dash.error} onRetry={() => void dash.refetch()} />
      ) : data && data.totals.count === 0 && !filtered && !search.from ? (
        <Card>
          <EmptyState
            icon={<Receipt />}
            title="No fleet expenses in this period"
            description="Add the first one with Add expense: choose the truck, the category and the amount, then who paid and who bears it. A parking receipt takes under a minute. Completed repairs from Maintenance appear here on their own."
            action={canEdit ? <Button icon={<Plus />} onClick={addExpense}>Add expense</Button> : undefined}
          />
        </Card>
      ) : (
        <>
          <section aria-label="Figures" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <ExpenseKpi
              icon={<Receipt />}
              label="Total fleet spend"
              value={value((x) => x.spendCents)}
              hint={t ? `${t.count.toLocaleString('en-US')} ${t.count === 1 ? 'expense' : 'expenses'}${t.externalCents > 0 ? ` · ${money(t.externalCents)} paid externally` : ''}` : undefined}
              onOpen={() => openList()}
            />
            <ExpenseKpi icon={<Building2 />} label="Company cost" value={value((x) => x.companyCents)} hint="What the company bears" onOpen={() => openList({ figure: 'company' })} />
            <ExpenseKpi icon={<UserRound />} label="Driver charge outstanding" value={value((x) => x.driverOutstandingCents)} hint={t ? `${money(t.driverChargeCents)} assigned to drivers` : undefined} onOpen={() => openList({ figure: 'driver_outstanding' })} tone="warning" />
            <ExpenseKpi icon={<CircleDollarSign />} label="Unpaid vendor bills" value={value((x) => x.unpaidBillsCents)} hint="Company-paid, not paid yet" onOpen={() => openList({ figure: 'unpaid_bills' })} tone="warning" />
            <ExpenseKpi icon={<Fuel />} label="EFS recovery remaining" value={value((x) => x.efsRemainingCents)} hint="EFS charged to drivers, not yet deducted" onOpen={() => openList({ figure: 'efs_remaining' })} />
          </section>
          <div className="-mt-2 flex flex-col gap-1 text-xs text-nw-text-3">
            <p className="flex items-start gap-1.5">
              <Info aria-hidden className="mt-px size-3.5 shrink-0" />
              These are separate measures that overlap; they do not add up to Total fleet spend. Drafts and unused EFS are not spend.
            </p>
            {data && data.timing.awaitingPostingCount > 0 ? (
              <p className="flex items-start gap-1.5">
                <Info aria-hidden className="mt-px size-3.5 shrink-0" />
                {data.timing.awaitingPostingCount.toLocaleString('en-US')} {data.timing.awaitingPostingCount === 1 ? 'expense' : 'expenses'} ({money(data.timing.awaitingPostingCents)}) recorded but not yet posted to Accounting.
              </p>
            ) : null}
          </div>

          <div className="grid items-stretch gap-4 min-[1200px]:grid-cols-2">
            <Panel title="Spend by category">
              {!data ? (
                <Loading />
              ) : data.totals.byCategory.length === 0 ? (
                <p className="py-10 text-center text-sm text-nw-text-3">Nothing counted with these filters.</p>
              ) : (
                <SpendDonut
                  slices={categorySlices(data.totals)}
                  total={data.totals.spendCents / 100}
                  hrefFor={(slice) =>
                    slice.key && slice.key !== '__rest__'
                      ? { to: '/fleet/expenses/list', params: {}, search: { from, to, truckId: search.truckId, chargeTo: search.chargeTo, category: slice.key } }
                      : null
                  }
                />
              )}
            </Panel>
            <Panel title="Spend by truck">
              {!data ? (
                <Loading />
              ) : data.byTruck.length === 0 ? (
                <p className="py-10 text-center text-sm text-nw-text-3">Nothing counted with these filters.</p>
              ) : (
                <TruckBars rows={data.byTruck} onOpen={(truckId) => openList({ truckId })} />
              )}
            </Panel>
          </div>

          <Card padding="none" className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-nw-border px-4 py-3">
              <h2 className="text-sm font-bold text-nw-text">Recent expenses</h2>
              <Link to="/fleet/expenses/list" search={{ from, to } as never} className="text-xs font-semibold text-nw-accent-ink hover:underline">
                View all
              </Link>
            </div>
            {!data ? (
              <Loading />
            ) : data.recent.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-nw-text-3">No expenses with these filters.</p>
            ) : (
              <ExpensesTable rows={data.recent} onOpen={openRow} compact />
            )}
          </Card>
        </>
      )}
      {overlays}
    </div>
  );
}

/** At most six slices (the chart's colour budget); the tail folds into one that names them. */
function categorySlices(totals: FleetExpenseTotals): SpendSlice[] {
  const total = Math.max(1, totals.spendCents);
  const sorted = [...totals.byCategory].sort((a, b) => b.cents - a.cents);
  const head = sorted.length > 6 ? sorted.slice(0, 5) : sorted;
  const rest = sorted.length > 6 ? sorted.slice(5) : [];
  const slices: SpendSlice[] = head.map((c) => ({ key: c.category, label: c.label, spend: c.cents / 100, sharePct: (c.cents / total) * 100 }));
  if (rest.length > 0) {
    const cents = rest.reduce((n, c) => n + c.cents, 0);
    slices.push({ key: '__rest__', label: rest.map((c) => c.label).join(', '), spend: cents / 100, sharePct: (cents / total) * 100 });
  }
  return slices;
}

function TruckBars({ rows, onOpen }: { rows: Array<{ truckId: string; unitNumber: string; cents: number; companyCents: number; count: number }>; onOpen: (truckId: string) => void }) {
  const [all, setAll] = useState(false);
  const max = Math.max(1, ...rows.map((r) => r.cents));
  const shown = all ? rows : rows.slice(0, 8);
  return (
    <div className="flex w-full flex-col gap-1">
      {shown.map((r) => (
        <button key={r.truckId} type="button" onClick={() => onOpen(r.truckId)} className="grid grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-nw-hover">
          <span className="text-[13px] font-semibold text-nw-text">Unit {r.unitNumber}</span>
          <span className="h-2.5 overflow-hidden rounded-full bg-nw-chart-band">
            <span className="block h-full rounded-full bg-nw-accent" style={{ width: `${Math.max(2, (r.cents / max) * 100)}%` }} />
          </span>
          <span className="text-right">
            <span className="tabular block text-[13px] font-bold text-nw-text">{money(r.cents)}</span>
            <span className="block text-[11px] text-nw-text-3">{r.count} {r.count === 1 ? 'expense' : 'expenses'}</span>
          </span>
        </button>
      ))}
      {rows.length > 8 ? (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 self-start px-2 text-xs font-semibold text-nw-accent-ink hover:underline">
          {all ? 'Show fewer' : `Show all ${rows.length} trucks`}
        </button>
      ) : null}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card padding="none" className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-nw-border px-4 py-3">
        <h2 className="text-sm font-bold text-nw-text">{title}</h2>
      </div>
      <div className="flex flex-1 items-center px-4 py-4">{children}</div>
    </Card>
  );
}

function Loading() {
  return <p className="w-full py-10 text-center text-sm text-nw-text-3">Loading…</p>;
}

// ============================================================================ List

export function FleetExpensesListPage() {
  const search = useExpensesSearch();
  const setSearch = useSetSearch('/fleet/expenses/list');
  const { toast } = useToast();
  const options = useExpenseOptions();
  const query = listQueryOf(search);
  const list = useExpenseList(query);
  const data = list.data;
  const { openRow, addExpense, overlays } = useExpenseOverlays({
    openId: search.expense ?? null,
    onOpenId: (id) => setSearch({ expense: id ?? undefined }),
  });
  const canEdit = options.data?.permissions.canEdit ?? false;
  const [pdfBusy, setPdfBusy] = useState(false);

  const filters: FilterDefinition[] = [
    { key: 'truckId', label: 'Truck', type: 'select', options: (options.data?.trucks ?? []).map((t) => ({ value: t.id, label: `Unit ${t.unitNumber}` })) },
    { key: 'category', label: 'Category', type: 'select', options: FLEET_EXPENSE_CATEGORIES.map((c) => ({ value: c, label: FLEET_EXPENSE_CATEGORY_LABEL[c] })) },
    { key: 'paidBy', label: 'Paid by', type: 'select', options: FLEET_EXPENSE_PAYERS.map((c) => ({ value: c, label: FLEET_EXPENSE_PAYER_LABEL[c] })) },
    { key: 'chargeTo', label: 'Charge to', type: 'select', options: FLEET_EXPENSE_CHARGE_TO.map((c) => ({ value: c, label: FLEET_EXPENSE_CHARGE_TO_LABEL[c] })) },
    { key: 'paymentStatus', label: 'Payment', type: 'select', options: FLEET_PAYMENT_STATUSES.map((c) => ({ value: c, label: FLEET_PAYMENT_STATUS_LABEL[c] })) },
    { key: 'recoveryStatus', label: 'Recovery', type: 'select', options: FLEET_RECOVERY_STATUSES.map((c) => ({ value: c, label: FLEET_RECOVERY_STATUS_LABEL[c] })) },
    { key: 'source', label: 'Source', type: 'select', options: FLEET_EXPENSE_SOURCES.map((c) => ({ value: c, label: FLEET_EXPENSE_SOURCE_LABEL[c] })) },
    { key: 'include', label: 'Show', type: 'multiselect', options: [{ value: 'drafts', label: 'Drafts' }, { value: 'voided', label: 'Void' }] },
  ];
  const include = [search.drafts ? 'drafts' : null, search.voided ? 'voided' : null].filter(Boolean) as string[];

  async function downloadReport() {
    setPdfBusy(true);
    try {
      // The report takes the list's filters, not its page.
      const filtersOnly: Record<string, unknown> = { ...query };
      delete filtersOnly.page;
      delete filtersOnly.pageSize;
      await fetchPdf(EXPENSE_REPORT_PDF_PATH, filtersOnly, 'download', `fleet-expenses${search.from ? `-${search.from}-to-${search.to}` : ''}.pdf`);
    } catch (error) {
      toast({ tone: 'danger', title: 'The PDF could not be prepared', description: errorText(error) });
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Expenses"
        description="Every fleet expense, with repairs from Maintenance counted once."
        actions={
          <>
            <Button variant="outline" icon={<FileDown />} onClick={() => void downloadReport()} disabled={pdfBusy || !data}>
              <span className="hidden sm:inline">Download PDF</span>
              <span className="sm:hidden">PDF</span>
            </Button>
            {canEdit ? <Button icon={<Plus />} onClick={addExpense}>Add expense</Button> : null}
          </>
        }
      />
      <ExpensesTabs active="list" />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <RangePicker from={search.from} to={search.to} allowAll onChange={(r) => setSearch({ ...r, page: undefined })} />
          {search.figure ? (
            <span className="inline-flex h-7 items-center gap-1 rounded-xl border border-nw-accent-tint bg-nw-accent-tint pr-1 pl-2.5 text-xs font-semibold text-nw-accent-ink">
              {EXPENSE_FIGURE_LABEL[search.figure]}
              <button type="button" aria-label="Remove this filter" onClick={() => setSearch({ figure: undefined, page: undefined })} className="grid size-5 place-items-center rounded-full hover:bg-nw-hover">
                <X aria-hidden className="size-3" />
              </button>
            </span>
          ) : null}
        </div>
        <FilterBar
          search={{ value: search.search ?? '', onChange: (v) => setSearch({ search: v, page: undefined }), placeholder: 'Search reference, unit, vendor, place…' }}
          filters={filters}
          values={{
            truckId: search.truckId,
            category: search.category,
            paidBy: search.paidBy,
            chargeTo: search.chargeTo,
            paymentStatus: search.paymentStatus,
            recoveryStatus: search.recoveryStatus,
            source: search.source,
            include,
          }}
          onChange={(key, value) => {
            if (key === 'include') {
              const v = (value as string[] | undefined) ?? [];
              setSearch({ drafts: v.includes('drafts') || undefined, voided: v.includes('voided') || undefined, page: undefined });
            } else setSearch({ [key]: (value as string | undefined) || undefined, page: undefined });
          }}
          onClear={() =>
            setSearch({
              truckId: undefined, category: undefined, paidBy: undefined, chargeTo: undefined, paymentStatus: undefined,
              recoveryStatus: undefined, source: undefined, search: undefined, figure: undefined, drafts: undefined, voided: undefined, page: undefined,
            })
          }
        />
      </div>

      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <Card padding="none" className="overflow-hidden">
          {!data ? (
            <Loading />
          ) : data.rows.length === 0 ? (
            <EmptyState
              icon={<Receipt />}
              title="No expenses match"
              description="Change the filters, or add an expense: the truck, the category and the amount are all it needs."
              action={canEdit ? <Button icon={<Plus />} onClick={addExpense}>Add expense</Button> : undefined}
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <ExpensesTable rows={data.rows} onOpen={openRow} sort={query.sort} onSort={(sort) => setSearch({ sort: sort === 'amount_desc' ? undefined : sort, page: undefined })} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-nw-border px-4 py-3 text-[13px]">
                <span className="flex flex-wrap gap-x-5 gap-y-1 text-nw-text-2">
                  <span>{data.total.toLocaleString('en-US')} {data.total === 1 ? 'expense' : 'expenses'}</span>
                  <span>Total <b className="tabular text-nw-text">{money(data.totals.spendCents)}</b></span>
                  <span>Company <b className="tabular text-nw-text">{money(data.totals.companyCents)}</b></span>
                  <span>Driver charge <b className="tabular text-nw-text">{money(data.totals.driverChargeCents)}</b></span>
                </span>
                <Pagination page={data.page} pageSize={data.pageSize || EXPENSE_PAGE_SIZE} total={data.total} onPageChange={(page) => setSearch({ page: page > 1 ? page : undefined })} />
              </div>
            </>
          )}
        </Card>
      )}
      <p className="flex items-start gap-1.5 text-xs text-nw-text-3">
        <Info aria-hidden className="mt-px size-3.5 shrink-0" />
        Open an expense for its receipt, history and Accounting links. A repair from Maintenance opens its work order. Totals leave out drafts and void expenses.
      </p>
      {overlays}
    </div>
  );
}
