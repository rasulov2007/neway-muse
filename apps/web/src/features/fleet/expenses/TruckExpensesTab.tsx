import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Building2, Info, Plus, Receipt, UserRound } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { FLEET_EXPENSE_CATEGORIES, FLEET_EXPENSE_CATEGORY_LABEL, type FleetExpenseCategory } from '@neway/shared';
import { Button, Card, EmptyState, ErrorState, Pagination, Select } from '@/design-system';
import { useExpenseList, useExpenseOptions } from './api';
import { CategoryLabel, ExpenseKpi } from './expense-ui';
import { money } from './expense-format';
import { ExpensesTable } from './ExpensesTable';
import { useExpenseOverlays } from './use-expense-overlays';
import { EXPENSE_PAGE_SIZE, listQueryOf, type ExpenseSort } from './expenses-search';

/**
 * Truck profile › Expenses: the fleet expenses list locked to this truck.
 *
 * It replaces the truck's own Costs tab (owner, 2026-10-12): the truck's repairs arrive here from
 * Maintenance through their work orders, so nothing is entered or counted twice. The freight and
 * fuel figures that tab also carried sit underneath (`children`), and the fleet-wide Costs report
 * is one link away.
 */
export function TruckExpensesTab({ truckId, unitNumber, children }: { truckId: string; unitNumber: string; children?: ReactNode }) {
  const options = useExpenseOptions();
  const [category, setCategory] = useState<FleetExpenseCategory | ''>('');
  const [sort, setSort] = useState<ExpenseSort>('date_desc');
  const [page, setPage] = useState(1);
  const list = useExpenseList(listQueryOf({ category: category || undefined, sort, page }, truckId));
  const data = list.data;
  const t = data?.totals;
  const { openRow, addExpense, overlays } = useExpenseOverlays({ lockedTruckId: truckId });
  const canEdit = options.data?.permissions.canEdit ?? false;

  return (
    <div className="flex flex-col gap-4">
      <Card padding="none" className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nw-border px-4 py-3">
          <div>
            <h2 className="text-base font-bold text-nw-text">Expenses</h2>
            <p className="text-xs text-nw-text-3">Only expenses for Unit {unitNumber}. Repairs come from Maintenance through their work order.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/fleet" className="inline-flex items-center gap-1 text-xs font-semibold text-nw-accent-ink hover:underline">
              Open fleet Costs report <ArrowUpRight aria-hidden className="size-3.5" />
            </Link>
            {canEdit ? <Button icon={<Plus />} onClick={addExpense}>Add expense</Button> : null}
          </div>
        </div>

        <div className="flex flex-col gap-4 p-4">
          {list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <ExpenseKpi icon={<Receipt />} label="Fleet tracked spend" value={t ? money(t.spendCents) : null} hint={t && t.externalCents > 0 ? `incl. ${money(t.externalCents)} paid externally` : t ? `${t.count} ${t.count === 1 ? 'expense' : 'expenses'}` : undefined} />
                <ExpenseKpi icon={<Building2 />} label="Company cost" value={t ? money(t.companyCents) : null} hint="What the company bears" />
                <ExpenseKpi icon={<UserRound />} label="Driver charge" value={t ? money(t.driverChargeCents) : null} hint={t ? `${money(t.driverChargeCents - t.driverOutstandingCents)} recovered · ${money(t.driverOutstandingCents)} outstanding` : undefined} tone="warning" />
              </div>

              {t && t.byCategory.length > 0 ? (
                <ul aria-label="Spend by category" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {t.byCategory.map((c) => (
                    <li key={c.category}>
                      <button
                        type="button"
                        onClick={() => {
                          setCategory(category === c.category ? '' : c.category);
                          setPage(1);
                        }}
                        aria-pressed={category === c.category}
                        className="flex w-full items-center justify-between gap-2 rounded-[10px] border border-nw-border bg-nw-subtle px-3 py-2 text-left text-[13px] hover:bg-nw-hover aria-pressed:border-nw-accent"
                      >
                        <CategoryLabel category={c.category} label={c.label} className="text-nw-text" />
                        <span className="tabular font-bold text-nw-text">{money(c.cents)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Select
                  aria-label="Category"
                  className="w-48"
                  options={[{ value: '', label: 'All categories' }, ...FLEET_EXPENSE_CATEGORIES.map((c) => ({ value: c, label: FLEET_EXPENSE_CATEGORY_LABEL[c] }))]}
                  value={category}
                  onValueChange={(v) => {
                    setCategory(v as FleetExpenseCategory | '');
                    setPage(1);
                  }}
                />
              </div>

              {!data ? (
                <p className="py-10 text-center text-sm text-nw-text-3">Loading…</p>
              ) : data.rows.length === 0 ? (
                <EmptyState
                  icon={<Receipt />}
                  title="No expenses on this truck"
                  description="Add parking, a wash, tolls or any other cost with Add expense. Completed repairs appear here from Maintenance on their own."
                  action={canEdit ? <Button icon={<Plus />} onClick={addExpense}>Add expense</Button> : undefined}
                />
              ) : (
                <div className="overflow-hidden rounded-[10px] border border-nw-border">
                  <div className="overflow-x-auto">
                    <ExpensesTable rows={data.rows} onOpen={openRow} hideTruck sort={sort} onSort={(s) => { setSort(s); setPage(1); }} />
                  </div>
                  {data.total > EXPENSE_PAGE_SIZE ? (
                    <div className="border-t border-nw-border px-3 py-2">
                      <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
                    </div>
                  ) : null}
                </div>
              )}
              <p className="flex items-start gap-1.5 text-xs text-nw-text-3">
                <Info aria-hidden className="mt-px size-3.5 shrink-0" />
                A repair’s amount comes from its invoice in Maintenance; open the RO for its checks, invoice and history. Estimates stay in Maintenance until the actual cost is recorded.
              </p>
            </>
          )}
        </div>
      </Card>

      {children}
      {overlays}
    </div>
  );
}
