import { Link } from '@tanstack/react-router';
import type { UseQueryResult } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, LayoutGrid, List, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/design-system';
import { formatMoney, formatNumber } from '@/lib/format';
import type { RankedEntity, RankingPage, RankingParams, RankingSortKey } from '../useInsights';
import {
  AnCard,
  AnCardHeader,
  EmptyCard,
  FormulaInfo,
  LoadingBlock,
  PillToggle,
  SectionError,
  StatusTag,
} from './ui';
import { DRIVER_COST_NOTE, PAGE_SIZES, PROFIT_TAG, marginBarWidth, profitTag } from './view-model';

const COLUMNS: ReadonlyArray<{ key: RankingSortKey; label: string; numeric: boolean }> = [
  { key: 'label', label: '', numeric: false },
  { key: 'miles', label: 'Miles', numeric: true },
  { key: 'gross', label: 'Gross', numeric: true },
  { key: 'cost', label: 'Cost', numeric: true },
  { key: 'profit', label: 'Profit', numeric: true },
  { key: 'rpm', label: 'RPM', numeric: true },
  { key: 'linehaulRpm', label: 'Linehaul RPM', numeric: true },
  { key: 'cpm', label: 'CPM', numeric: true },
  { key: 'marginPct', label: 'Margin', numeric: true },
];

/** Columns a driver row never has (the facts carry no cost per driver). */
const DRIVER_UNAVAILABLE = new Set<RankingSortKey>(['cost', 'profit', 'cpm', 'marginPct']);

/** Why a profit-side cell is empty: the server's reason for the row, when it gave one. */
function missingReason(entity: 'truck' | 'driver', key: RankingSortKey, row: RankedEntity): string {
  if (entity === 'driver' && DRIVER_UNAVAILABLE.has(key)) return DRIVER_COST_NOTE;
  if ((key === 'profit' || key === 'marginPct') && row.profitReason) return row.profitReason;
  return 'Not available';
}

/** Written exactly as the old tables wrote them. */
function cellText(key: RankingSortKey, row: RankedEntity): string {
  const value = row[key as keyof RankedEntity] as number | null | undefined;
  if (value === null || value === undefined) return '—';
  switch (key) {
    case 'miles':
      return formatNumber(Math.round(value));
    case 'gross':
    case 'cost':
    case 'profit':
      return formatMoney(value, { compact: true });
    case 'rpm':
    case 'linehaulRpm':
    case 'cpm':
      return formatMoney(value);
    case 'marginPct':
      return `${value.toFixed(1)}%`;
    default:
      return String(value);
  }
}

/**
 * Trucks or drivers: search, sort and page on the server over every row, as a sortable table with
 * a sticky header — and, for trucks, a grid of cards.
 */
export function RankingExplorer({
  entity,
  title,
  query,
  params,
  onParamsChange,
}: {
  entity: 'truck' | 'driver';
  title: string;
  query: UseQueryResult<RankingPage>;
  params: RankingParams;
  onParamsChange: (next: RankingParams) => void;
}) {
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [search, setSearch] = useState(params.q);
  const noun = entity === 'truck' ? 'trucks' : 'drivers';

  // Search waits for a pause in typing, then starts again from page 1.
  useEffect(() => {
    if (search.trim() === params.q) return;
    const timer = window.setTimeout(
      () => onParamsChange({ ...params, q: search.trim(), page: 1 }),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [search, params, onParamsChange]);

  function sortBy(key: RankingSortKey) {
    const dir =
      params.sort === key ? (params.dir === 'desc' ? 'asc' : 'desc') : key === 'label' ? 'asc' : 'desc';
    onParamsChange({ ...params, sort: key, dir, page: 1 });
  }

  const data = query.data;
  const lastPage = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const count = data
    ? data.q
      ? `${formatNumber(data.total)} of ${formatNumber(data.totalAll)} ${noun}`
      : `${formatNumber(data.total)} ${noun}`
    : 'Loading…';

  return (
    <AnCard className="flex min-w-0 flex-col">
      <AnCardHeader
        title={title}
        description={count}
        actions={
          <>
            <label className="relative flex items-center">
              <span className="sr-only">Search {noun}</span>
              <Search aria-hidden className="pointer-events-none absolute left-3 size-4 text-nw-text-3" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={entity === 'truck' ? 'Search unit' : 'Search driver'}
                className="h-9 w-48 rounded-an-pill border border-an-card-border bg-an-card pr-3 pl-9 text-sm text-nw-text placeholder:text-nw-text-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-an-accent"
              />
            </label>
            {entity === 'truck' ? (
              <PillToggle
                size="sm"
                label="View"
                value={view}
                onValueChange={setView}
                options={[
                  { value: 'list', label: 'List', icon: <List aria-hidden /> },
                  { value: 'grid', label: 'Grid', icon: <LayoutGrid aria-hidden /> },
                ]}
              />
            ) : null}
          </>
        }
      />

      {query.error ? (
        <div className="px-5 pb-5">
          <SectionError title={`${title} could not be loaded`} error={query.error} />
        </div>
      ) : query.isPending ? (
        <div className="px-5 pb-5">
          <LoadingBlock className="h-72" />
        </div>
      ) : !data || data.totalAll === 0 ? (
        <div className="px-5 pb-5">
          <EmptyCard title={`No ${entity} activity for this period`} />
        </div>
      ) : data.rows.length === 0 ? (
        <div className="px-5 pb-5">
          <EmptyCard title={`No ${noun} match “${data.q}”`} />
        </div>
      ) : view === 'grid' && entity === 'truck' ? (
        <TruckGrid rows={data.rows} />
      ) : (
        <RankingTable entity={entity} rows={data.rows} params={params} onSort={sortBy} />
      )}

      {data && data.total > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-an-card-border px-5 py-3">
          <div className="flex items-center gap-2 text-xs text-nw-text-2">
            <span>Rows per page</span>
            <PillToggle
              size="sm"
              label="Rows per page"
              value={String(params.pageSize)}
              onValueChange={(value) => onParamsChange({ ...params, pageSize: Number(value), page: 1 })}
              options={PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-nw-text-2">
            <span aria-live="polite">
              Page {data.page} of {lastPage}
            </span>
            <PageButton
              label="Previous page"
              disabled={data.page <= 1}
              onClick={() => onParamsChange({ ...params, page: data.page - 1 })}
            >
              <ChevronLeft aria-hidden className="size-4" />
            </PageButton>
            <PageButton
              label="Next page"
              disabled={data.page >= lastPage}
              onClick={() => onParamsChange({ ...params, page: data.page + 1 })}
            >
              <ChevronRight aria-hidden className="size-4" />
            </PageButton>
          </div>
        </div>
      ) : null}
    </AnCard>
  );
}

function PageButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-an-pill border border-an-card-border bg-an-card text-nw-text-2 hover:text-nw-text disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-an-accent"
    >
      {children}
    </button>
  );
}

function RankingTable({
  entity,
  rows,
  params,
  onSort,
}: {
  entity: 'truck' | 'driver';
  rows: RankedEntity[];
  params: RankingParams;
  onSort: (key: RankingSortKey) => void;
}) {
  return (
    <div className="max-h-[560px] overflow-auto border-t border-an-card-border">
      <table className="w-full min-w-[820px] text-sm">
        <thead className="sticky top-0 z-[1] bg-an-card">
          <tr className="border-b border-an-card-border">
            {COLUMNS.map((column) => {
              const sorted = params.sort === column.key;
              const unavailable = entity === 'driver' && DRIVER_UNAVAILABLE.has(column.key);
              const label = column.key === 'label' ? (entity === 'truck' ? 'Truck' : 'Driver') : column.label;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={sorted ? (params.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className={cn(
                    'h-10 px-4 text-xs font-semibold whitespace-nowrap text-nw-text-2',
                    column.numeric ? 'text-right' : 'text-left',
                  )}
                >
                  <span className={cn('inline-flex items-center gap-1', column.numeric && 'flex-row-reverse')}>
                    <button
                      type="button"
                      onClick={() => onSort(column.key)}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md hover:text-nw-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-an-accent',
                        sorted && 'text-nw-text',
                      )}
                    >
                      {label}
                      {sorted ? (
                        params.dir === 'asc' ? (
                          <ArrowUp aria-hidden className="size-3" />
                        ) : (
                          <ArrowDown aria-hidden className="size-3" />
                        )
                      ) : null}
                    </button>
                    {unavailable && column.key === 'cost' ? (
                      <FormulaInfo label="Cost, profit and margin per driver" formula={DRIVER_COST_NOTE} />
                    ) : null}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-an-card-border last:border-0 hover:bg-nw-hover">
              <td className="h-11 px-4">
                <Link
                  to={row.href as never}
                  className="font-semibold text-an-accent-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-an-accent"
                >
                  {row.label}
                </Link>
                {entity === 'truck' && row.oneSided ? (
                  <span className="ml-2 inline-block align-middle" title={row.profitReason ?? undefined}>
                    <StatusTag
                      family="neutral"
                      label={PROFIT_TAG[profitTag(row)].label}
                    />
                  </span>
                ) : null}
              </td>
              {COLUMNS.slice(1).map((column) => {
                const raw = row[column.key as keyof RankedEntity] as number | null | undefined;
                const value = raw ?? null;
                const negative =
                  value !== null && value < 0 && (column.key === 'profit' || column.key === 'marginPct');
                return (
                  <td key={column.key} className="h-11 px-4 text-right whitespace-nowrap tabular-nums">
                    {value === null ? (
                      <span
                        className="text-nw-text-3"
                        title={missingReason(entity, column.key, row)}
                      >
                        —
                      </span>
                    ) : (
                      <span className={cn(negative ? 'text-nw-urgent-text' : 'text-nw-text')}>
                        {cellText(column.key, row)}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Truck cards: unit, Profitable / Loss / Break-even / No cost data, and the margin as a bar. */
export function TruckGrid({ rows }: { rows: RankedEntity[] }) {
  return (
    <ul
      aria-label="Trucks"
      className="grid gap-3 border-t border-an-card-border p-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
    >
      {rows.map((row) => {
        const tag = PROFIT_TAG[profitTag(row)];
        return (
          <li key={row.id}>
            <AnCard lift className="flex h-full flex-col gap-3 p-4" data-testid="truck-card">
              <div className="flex items-start justify-between gap-2">
                <Link
                  to={row.href as never}
                  className="text-base font-bold text-nw-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-an-accent"
                >
                  {row.label}
                </Link>
                <span title={row.profitReason ?? undefined}>
                  <StatusTag family={tag.family} label={tag.label} />
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                <GridFigure label="Gross" value={cellText('gross', row)} />
                <GridFigure
                  label="Profit"
                  value={cellText('profit', row)}
                  negative={row.profit !== null && row.profit < 0}
                />
                <GridFigure label="Miles" value={cellText('miles', row)} />
                <GridFigure label="RPM" value={cellText('rpm', row)} />
                <GridFigure label="Cost" value={cellText('cost', row)} />
                <GridFigure label="CPM" value={cellText('cpm', row)} />
                <GridFigure label="Linehaul RPM" value={cellText('linehaulRpm', row)} />
              </dl>
              <div className="mt-auto flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-nw-text-2">Margin</span>
                  <span
                    className={cn(
                      'font-semibold tabular-nums',
                      row.marginPct !== null && row.marginPct < 0 ? 'text-nw-urgent-text' : 'text-nw-text',
                    )}
                  >
                    {cellText('marginPct', row)}
                  </span>
                </div>
                <span aria-hidden className="block h-2 overflow-hidden rounded-full bg-an-track">
                  <span
                    className="block h-full rounded-full bg-an-accent"
                    style={{ width: `${marginBarWidth(row.marginPct)}%` }}
                  />
                </span>
              </div>
            </AnCard>
          </li>
        );
      })}
    </ul>
  );
}

function GridFigure({ label, value, negative }: { label: string; value: string; negative?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-nw-text-3">{label}</dt>
      <dd
        className={cn(
          'text-sm font-semibold tabular-nums',
          value === '—' ? 'text-nw-text-3' : negative ? 'text-nw-urgent-text' : 'text-nw-text',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
