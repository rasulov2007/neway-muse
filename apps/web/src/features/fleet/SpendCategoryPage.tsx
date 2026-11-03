import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft, ChevronDown, ChevronUp, Download, FileText, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  tirePositionChip,
  tirePositionLabel,
  type FleetSpendEvent,
  type FleetUnitTypeFilter,
  type TireEvent,
  type TireEventType,
  type TirePositionKey,
} from '@neway/shared';
import { TireChips, TireTagDialog, UnassignedDialog, recordKey, useCanTag, useTirePositions } from './tires/TirePositionMap';
import { TiresAnalytics } from './tires/TiresAnalytics';
import { Card, EmptyState, ErrorState, Input, PageHeader, Select, cn } from '@/design-system';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { useFleetExpense } from './useFleetExpense';
import { expenseSearchSchema, parseUnits } from './expense-search';

/**
 * One category's records — the rows that made the amount on the ring.
 *
 * Everything here comes from the summary the overview already asked for: the same period, the
 * same units, the same eligibility and the same category grouping, with this category's own
 * record ids picking the rows out. There is no second calculation, so the total on this page
 * cannot disagree with the slice that was clicked, and a work order that carries two categories
 * contributes only the lines that belong here.
 */

type SortKey = 'date' | 'unit' | 'amount';

export function SpendCategoryPage({ categoryId }: { categoryId: string }) {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => expenseSearchSchema.parse(rawSearch), [rawSearch]);
  /* The same three inputs the overview passes, read from the same search contract. */
  const period = search.period ?? 'month';
  const units = useMemo(() => parseUnits(search.units), [search.units]);
  const unitType: FleetUnitTypeFilter = search.unitType ?? 'all';
  /* Tire replacement carries the tire position map and its rolling window (owner, 2026-10-13). */
  const isTire = categoryId === 'tire_replacement';
  const tireWindow = isTire ? (search.window ?? '12m') : undefined;
  const navigate = useNavigate();
  // The period Costs is showing (owner, 2026-11-02: October picked on Costs, the category opened
  // November and read "not in this period"), and Costs' one scope: every fleet cost.
  const at = search.at ?? search.week;
  const scope = 'all' as const;
  const summary = useFleetExpense({ period, units, unitType, at, scope, window: tireWindow });
  const data = summary.data;
  const tires = useTirePositions({ period, units, unitType, scope, window: tireWindow ?? '12m' }, isTire);
  const canTag = useCanTag();
  const [metric] = useState<TireEventType>('replaced');
  const [position, setPosition] = useState<TirePositionKey | null>(null);
  const [tagging, setTagging] = useState<FleetSpendEvent | null>(null);
  const [showUnassigned, setShowUnassigned] = useState(false);
  const tireEvents = useMemo(() => {
    const m = new Map<string, TireEvent[]>();
    for (const e of tires.data?.events ?? []) {
      const k = `${e.recordKind}:${e.recordId}`;
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return m;
  }, [tires.data]);

  const [q, setQ] = useState('');
  const [shop, setShop] = useState('');
  const [unit, setUnit] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'date', desc: true });
  const [page, setPage] = useState(1);
  const PAGE = 25;

  const slice = data?.categories.slices.find((s) => s.key === categoryId) ?? null;
  const label = slice?.label ?? categoryId.replace(/_/g, ' ');

  /*
   * The category's own records. `recordIds` is the engine's answer to "what made this amount",
   * including the way `Other` folds the smaller categories together, so the page inherits that
   * rule instead of restating it.
   */
  const rows = useMemo<FleetSpendEvent[]>(() => {
    if (!data || !slice) return [];
    /*
     * The slice's own record ids, and its own types.
     *
     * Both, because an id is not a category: the same source record can reach the summary twice
     * - once from the workspace and once from the server's own table - and be typed differently
     * each time. Matching on the id alone pulls the other category's copy in with it, which is
     * how this page first showed $64,473.66 for a $33,938.06 slice. The roll-up's types are the
     * members the overview folded into it, so the grouping rule is inherited rather than
     * restated.
     */
    const ids = new Set(slice.recordIds);
    const types = new Set(
      slice.key === 'all-other-types' ? data.categories.otherMembers.map((m) => m.type) : [slice.type],
    );
    /*
     * No second de-duplication here. The summary counts a record once per source it arrives
     * from, and a handful of orders reach it twice - from the workspace and from the server's
     * own table. That is a defect in the summary, not in this page, and hiding it here would
     * make the two screens disagree while leaving the real double count in the total. The page
     * shows what the ring shows; the duplicate is reported separately.
     */
    return data.events.filter((e) => ids.has(e.id) && types.has(e.type));
  }, [data, slice]);

  const shops = useMemo(
    () => [...new Set(rows.map((r) => r.vendorName).filter((v): v is string => Boolean(v)))].sort(),
    [rows],
  );
  const unitNumbers = useMemo(() => [...new Set(rows.map((r) => r.unitNumber))].sort(), [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (shop && r.vendorName !== shop) return false;
      if (unit && r.unitNumber !== unit) return false;
      if (!needle) return true;
      return [r.unitNumber, r.reference, r.vendorName ?? '', r.description ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [rows, q, shop, unit]);

  /* A tire clicked on the map narrows the table to the records that touched it (this event type). */
  const shownRows = useMemo(
    () =>
      position
        ? filtered.filter((r) => (tireEvents.get(recordKey(r)) ?? []).some((e) => e.positionId === position && e.eventType === metric))
        : filtered,
    [filtered, position, tireEvents, metric],
  );

  const sorted = useMemo(() => {
    const dir = sort.desc ? -1 : 1;
    return [...shownRows].sort((a, b) => {
      if (sort.key === 'amount') return (a.amount - b.amount) * dir;
      if (sort.key === 'unit') return a.unitNumber.localeCompare(b.unitNumber) * dir;
      return (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) * dir;
    });
  }, [shownRows, sort]);

  /* The figures answer for every matching record, not the page on screen. */
  const total = shownRows.reduce((sum, r) => sum + r.amount, 0);
  const sharePct = data && data.categories.total > 0 ? (total / data.categories.total) * 100 : 0;
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
  const current = Math.min(page, pages);
  const shown = sorted.slice((current - 1) * PAGE, current * PAGE);

  const sortBy = (key: SortKey) =>
    setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'unit' }));

  const exportRecords = () =>
    exportCsv(sorted, label, data?.meta.period, isTire ? (r) => (tireEvents.get(recordKey(r)) ?? []).map((e) => `${tirePositionChip(e.positionId)}${e.quantity > 1 ? ` x${e.quantity}` : ''}${e.eventType !== 'replaced' ? ` (${e.eventType})` : ''}`).join('; ') : undefined);
  const recordsCard = (
          <Card padding="none" className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-nw-border px-4 py-3">
              <Input
                size="sm"
                type="search"
                prefix={<Search />}
                aria-label="Search unit, order or shop"
                placeholder="Search unit, order or shop"
                value={q}
                onChange={(e) => {
                  setPage(1);
                  setQ(e.target.value);
                }}
                className="w-64"
              />
              <Select
                aria-label="Shop"
                value={shop}
                placeholder="All shops"
                options={[{ value: '', label: 'All shops' }, ...shops.map((s) => ({ value: s, label: s }))]}
                onValueChange={(v) => {
                  setPage(1);
                  setShop(v);
                }}
                className="w-48"
              />
              <Select
                aria-label="Unit"
                value={unit}
                placeholder="All units"
                options={[{ value: '', label: 'All units' }, ...unitNumbers.map((u) => ({ value: u, label: `Unit ${u}` }))]}
                onValueChange={(v) => {
                  setPage(1);
                  setUnit(v);
                }}
                className="w-40"
              />
              {position ? (
                <button
                  type="button"
                  onClick={() => setPosition(null)}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-nw-accent bg-nw-accent-tint px-2 text-[12px] font-bold text-nw-accent-ink"
                  aria-label="Clear the position filter"
                  data-testid="position-chip"
                >
                  Position: {tirePositionLabel(position)}
                  <X className="size-3.5" aria-hidden />
                </button>
              ) : null}
              <span className="ml-auto inline-flex h-6 items-center rounded-md bg-nw-accent-tint px-2.5 text-[12px] font-bold text-nw-accent-ink">
                Category: {label}
              </span>
            </div>

            {sorted.length === 0 ? (
              <EmptyState
                title={isTire ? 'No tire records for this period' : 'No records for this category in the selected period'}
                description={position ? 'Nothing at this position: clear the position filter.' : 'Clear the search or the filters, or widen the period on Spending.'}
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[13px]">
                    <thead>
                      <tr className="border-b border-nw-border bg-nw-subtle text-left text-[11px] font-bold tracking-[.06em] text-nw-text-2 uppercase">
                        <Th onClick={() => sortBy('date')} sorted={sort.key === 'date'} desc={sort.desc}>
                          Date
                        </Th>
                        <Th onClick={() => sortBy('unit')} sorted={sort.key === 'unit'} desc={sort.desc}>
                          Unit
                        </Th>
                        <th className="px-3 py-2">Work completed</th>
                        {isTire ? <th className="px-3 py-2">Position</th> : null}
                        <th className="px-3 py-2">Shop</th>
                        <th className="px-3 py-2">Reference</th>
                        <Th onClick={() => sortBy('amount')} sorted={sort.key === 'amount'} desc={sort.desc} right>
                          Amount
                        </Th>
                        <th className="px-3 py-2">Invoice</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => (
                        <tr key={r.id} className="border-b border-nw-border last:border-b-0 hover:bg-nw-hover">
                          <td className="px-3 py-2 whitespace-nowrap text-nw-text-2">{formatIsoDate(r.date)}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {r.unitKind === 'truck' ? (
                              <Link
                                to="/fleet/trucks/$truckId"
                                params={{ truckId: r.truckId }}
                                className="font-semibold text-nw-accent-ink hover:underline"
                              >
                                Unit {r.unitNumber}
                              </Link>
                            ) : (
                              <span className="font-semibold text-nw-text">{r.unitNumber}</span>
                            )}
                          </td>
                          <td className="max-w-[360px] truncate px-3 py-2 text-nw-text" title={r.description ?? ''}>
                            {r.description ?? <span className="text-nw-text-3">—</span>}
                          </td>
                          {isTire ? (
                            <td className="max-w-[240px] px-3 py-2">
                              {tires.isPending ? (
                                <span className="text-nw-text-3">Loading…</span>
                              ) : (
                                <TireChips events={tireEvents.get(recordKey(r)) ?? []} onClick={canTag ? () => setTagging(r) : undefined} />
                              )}
                            </td>
                          ) : null}
                          <td className="px-3 py-2 text-nw-text-2">{r.vendorName ?? '—'}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {r.kind === 'work_order' ? (
                              <Link
                                to="/fleet/shop/$orderId"
                                params={{ orderId: r.id }}
                                className="font-semibold text-nw-accent-ink hover:underline"
                              >
                                {r.reference}
                              </Link>
                            ) : (
                              <span className="text-nw-text-2">{r.reference}</span>
                            )}
                          </td>
                          <td className="tabular px-3 py-2 text-right font-semibold text-nw-text">
                            {formatMoney(r.amount)}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {r.invoiceFileId ? (
                              <Link
                                to="/fleet/shop/$orderId"
                                params={{ orderId: r.id }}
                                search={{ tab: 'invoice' } as never}
                                className="inline-flex items-center gap-1 font-semibold text-nw-accent-ink hover:underline"
                              >
                                <FileText className="size-3.5" aria-hidden /> View invoice
                              </Link>
                            ) : (
                              <span className="text-nw-text-3">No invoice</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-nw-border px-4 py-2 text-xs">
                  <span className="text-nw-text-3">
                    {shownRows.length} record{shownRows.length === 1 ? '' : 's'}
                    {pages > 1 ? ` · showing ${(current - 1) * PAGE + 1}–${Math.min(current * PAGE, sorted.length)}` : ''}
                  </span>
                  <span className="flex items-center gap-3">
                    {pages > 1 ? (
                      <span className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={current === 1}
                          onClick={() => setPage(current - 1)}
                          className="h-7 rounded-md border border-nw-border px-2 font-semibold text-nw-text-2 disabled:opacity-40"
                        >
                          Previous
                        </button>
                        <span className="tabular text-nw-text-3">
                          {current} / {pages}
                        </span>
                        <button
                          type="button"
                          disabled={current === pages}
                          onClick={() => setPage(current + 1)}
                          className="h-7 rounded-md border border-nw-border px-2 font-semibold text-nw-text-2 disabled:opacity-40"
                        >
                          Next
                        </button>
                      </span>
                    ) : null}
                    <span className="tabular font-bold text-nw-text">Total {formatMoney(total)}</span>
                  </span>
                </div>
              </>
            )}
          </Card>
  );

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <div>
        <Link
          to="/fleet"
          search={search as never}
          className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-nw-accent-ink hover:underline"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> Back to Spending
        </Link>
        <nav aria-label="Breadcrumb" className="mt-1 text-[11.5px] text-nw-text-3">
          <Link to="/fleet" search={search as never} className="hover:underline">
            Spending
          </Link>
          <span aria-hidden> / </span>
          <span className="text-nw-text-2">{label}</span>
        </nav>
      </div>

      {isTire ? null : (
        <PageHeader
        title={label}
        description="Expense records for this category."
        actions={
          <button
            type="button"
            onClick={exportRecords}
            disabled={sorted.length === 0}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-nw-border-strong bg-nw-panel px-3 text-sm font-semibold text-nw-text hover:bg-nw-hover disabled:opacity-45"
          >
            <Download className="size-4" aria-hidden /> Export
          </button>
        }
      />
      )}

      {summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      ) : summary.isPending ? (
        <Card className="p-6 text-sm text-nw-text-3">Loading…</Card>
      ) : !slice && !isTire ? (
        <EmptyState
          title="That category is not in this period"
          description="Nothing in the selected range falls under it. Change the period on Spending and try again."
        />
      ) : (
        <>
          {isTire ? (
            <TiresAnalytics
              records={filtered}
              events={tires.data?.events}
              loading={tires.isPending}
              window={tireWindow ?? '12m'}
              onWindow={(w) => {
                setPage(1);
                void navigate({ to: '.', search: { ...(search as Record<string, unknown>), window: w } as never, replace: true });
              }}
              periodLabel={data?.meta.period ? `${formatIsoDate(data.meta.period.from)} – ${formatIsoDate(data.meta.period.to)}` : null}
              onExport={exportRecords}
              onTagUnassigned={() => setShowUnassigned(true)}
              recordsTable={recordsCard}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <Figure label="Category spend" value={formatMoney(total)} />
              <Figure label="Records" value={String(shownRows.length)} />
              <Figure label="Share of total" value={`${sharePct.toFixed(1)}%`} />
            </div>
          )}

          {isTire ? null : recordsCard}
          {tagging ? <TireTagDialog row={tagging} current={tireEvents.get(recordKey(tagging)) ?? []} onClose={() => setTagging(null)} /> : null}
          {showUnassigned ? (
            <UnassignedDialog
              rows={filtered}
              events={tires.data?.events ?? []}
              onClose={() => setShowUnassigned(false)}
              onTag={(r) => {
                setShowUnassigned(false);
                setTagging(r);
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-nw-border bg-nw-panel px-4 py-3">
      <div className="text-[11.5px] font-semibold text-nw-text-3">{label}</div>
      <div className="tabular mt-0.5 text-2xl font-extrabold text-nw-text">{value}</div>
    </div>
  );
}

function Th({
  children,
  onClick,
  sorted,
  desc,
  right,
}: {
  children: React.ReactNode;
  onClick: () => void;
  sorted: boolean;
  desc: boolean;
  right?: boolean;
}) {
  return (
    <th className={cn('px-3 py-2', right && 'text-right')}>
      <button
        type="button"
        onClick={onClick}
        className={cn('inline-flex items-center gap-1 font-bold uppercase', sorted && 'text-nw-text')}
      >
        {children}
        {sorted ? (
          desc ? (
            <ChevronDown className="size-3" aria-hidden />
          ) : (
            <ChevronUp className="size-3" aria-hidden />
          )
        ) : null}
      </button>
    </th>
  );
}

/** The same rows the table is showing, filters and all — never just the visible page. */
function exportCsv(
  rows: FleetSpendEvent[],
  label: string,
  period?: { from: string; to: string },
  positions?: (r: FleetSpendEvent) => string,
): void {
  const head = ['Date', 'Unit', 'Work completed', ...(positions ? ['Position'] : []), 'Shop', 'Reference', 'Amount', 'Invoice'];
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const body = rows.map((r) =>
    [
      r.date,
      r.unitNumber,
      r.description ?? '',
      ...(positions ? [positions(r)] : []),
      r.vendorName ?? '',
      r.reference,
      r.amount.toFixed(2),
      r.invoiceFileId ? 'on file' : 'none',
    ]
      .map((v) => cell(String(v)))
      .join(','),
  );
  const blob = new Blob([[head.map(cell).join(','), ...body].join('\n')], {
    type: 'text/csv;charset=utf-8',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `spend-${label.toLowerCase().replace(/\s+/g, '-')}${period ? `-${period.from}-to-${period.to}` : ''}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
