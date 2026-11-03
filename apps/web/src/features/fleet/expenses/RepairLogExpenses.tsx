import { Receipt, Search } from 'lucide-react';
import { useState } from 'react';
import { FLEET_EXPENSE_CATEGORIES, FLEET_EXPENSE_CATEGORY_LABEL, type FleetExpenseCategory, type FleetExpenseRow } from '@neway/shared';
import { EmptyState, ErrorState, Pagination, Select } from '@/design-system';
import { useExpenseList } from './api';
import { money } from './expense-format';
import { ExpensesTable } from './ExpensesTable';
import { EXPENSE_PAGE_SIZE, type ExpenseSort } from './expenses-search';

/**
 * Repair log › Expenses (owner, 2026-10-13): what a truck cost that is not maintenance - cash
 * advances, parking, tolls, washes. Repairs stay in the log's own tabs, so nothing is listed
 * twice; Add expense sits beside Create repair.
 */
export function RepairLogExpenses({ onOpen }: { onOpen: (row: FleetExpenseRow) => void }) {
  const [category, setCategory] = useState<FleetExpenseCategory | ''>('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ExpenseSort>('amount_desc');
  const [page, setPage] = useState(1);
  const list = useExpenseList({
    nonMaintenance: true,
    category: category || undefined,
    search: search.trim() || undefined,
    sort,
    page,
    pageSize: EXPENSE_PAGE_SIZE,
  });
  const data = list.data;
  const t = data?.totals;
  return (
    <div className="flex flex-col" data-testid="repair-log-expenses">
      <div className="flex flex-wrap items-center gap-2 border-b border-nw-border px-3 py-2.5">
        <label className="flex h-9 w-[220px] items-center gap-2 rounded-lg border border-nw-border-strong bg-nw-field px-2.5 text-[12.5px] text-nw-text-3 focus-within:border-nw-accent">
          <Search className="size-3.5 shrink-0" aria-hidden />
          <input
            type="search"
            aria-label="Search expenses"
            placeholder="Search expense, unit or place"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="w-full min-w-0 bg-transparent text-nw-text outline-none placeholder:text-nw-text-3"
          />
        </label>
        <Select
          aria-label="Category"
          className="w-44"
          options={[
            { value: '', label: 'All categories' },
            ...FLEET_EXPENSE_CATEGORIES.filter((c) => c !== 'repair_maintenance').map((c) => ({ value: c, label: FLEET_EXPENSE_CATEGORY_LABEL[c] })),
          ]}
          value={category}
          onValueChange={(v) => {
            setCategory(v as FleetExpenseCategory | '');
            setPage(1);
          }}
        />
        {t ? (
          <span className="ml-auto text-xs text-nw-text-3">
            {t.count} {t.count === 1 ? 'expense' : 'expenses'} · <span className="tabular font-bold text-nw-text">{money(t.spendCents)}</span>
            {t.investigationCents > 0 ? ` · ${money(t.investigationCents)} under investigation` : ''}
          </span>
        ) : null}
      </div>
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : !data ? (
        <p className="px-5 py-10 text-center text-sm text-nw-text-3">Loading…</p>
      ) : data.rows.length === 0 ? (
        <EmptyState
          icon={<Receipt />}
          title={search || category ? 'Nothing matches' : 'No expenses yet'}
          description={search || category ? 'Clear the search or the category.' : 'Cash advances, parking, tolls and washes appear here once they are added with Add expense.'}
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <ExpensesTable
              rows={data.rows}
              onOpen={onOpen}
              sort={sort}
              onSort={(s) => {
                setSort(s);
                setPage(1);
              }}
            />
          </div>
          {data.total > EXPENSE_PAGE_SIZE ? (
            <div className="border-t border-nw-border px-3 py-2">
              <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
