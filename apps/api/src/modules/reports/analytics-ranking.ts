/**
 * Paging, sorting and search for the truck and driver rankings (2026-10-25).
 *
 * The rankings are computed in full first, exactly as before; this only orders, filters and slices
 * the finished rows. No value in a row is touched, so a page is always a window onto the same
 * figures the unpaged response carries. Sorting and search run over every row on the server, so
 * "most profitable first" means most profitable of the whole fleet, not of the rows on screen.
 */

export const RANKING_SORT_KEYS = [
  'label',
  'miles',
  'gross',
  'cost',
  'profit',
  'rpm',
  'linehaulRpm',
  'cpm',
  'marginPct',
] as const;
export type RankingSortKey = (typeof RANKING_SORT_KEYS)[number];

export const RANKING_PAGE_SIZES = [25, 50, 100] as const;

export interface RankingQuery {
  page: number;
  pageSize: number;
  sort: RankingSortKey;
  dir: 'asc' | 'desc';
  q: string;
}

export interface RankingPage<T> {
  rows: T[];
  /** Rows matching the search, across all pages. */
  total: number;
  /** Rows before the search. */
  totalAll: number;
  page: number;
  pageSize: number;
  sort: RankingSortKey;
  dir: 'asc' | 'desc';
  q: string;
}

type RankingParam = string | string[] | undefined;

function first(value: RankingParam): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Reads the paging parameters. Returns `null` when none was sent, so a caller that never asked
 * for a page gets the response it always got.
 */
export function parseRankingQuery(
  params: Record<string, RankingParam>,
  defaults: { sort: RankingSortKey; dir: 'asc' | 'desc' },
): RankingQuery | null {
  const raw = {
    page: first(params.page),
    pageSize: first(params.pageSize),
    sort: first(params.sort),
    dir: first(params.dir),
    q: first(params.q),
  };
  if (Object.values(raw).every((v) => v === undefined)) return null;

  const pageSize = Number.parseInt(raw.pageSize ?? '', 10);
  const page = Number.parseInt(raw.page ?? '', 10);
  const sort = (RANKING_SORT_KEYS as readonly string[]).includes(raw.sort ?? '')
    ? (raw.sort as RankingSortKey)
    : defaults.sort;
  const dir = raw.dir === 'asc' || raw.dir === 'desc' ? raw.dir : defaults.dir;
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: Number.isFinite(pageSize) ? Math.min(100, Math.max(1, pageSize)) : 25,
    sort,
    dir,
    q: (raw.q ?? '').trim().slice(0, 100),
  };
}

/**
 * Orders, filters and slices finished rows. Missing values sort last in both directions (a truck
 * with no cost data is never "the cheapest"), and ties keep the order the ranking produced.
 */
export function pageRanking<T extends { label: string } & Partial<Record<RankingSortKey, unknown>>>(
  rows: readonly T[],
  query: RankingQuery,
): RankingPage<T> {
  const needle = query.q.toLowerCase();
  const matching = needle
    ? rows.filter((row) => row.label.toLowerCase().includes(needle))
    : [...rows];

  const sign = query.dir === 'asc' ? 1 : -1;
  const indexed = matching.map((row, index) => ({ row, index }));
  indexed.sort((a, b) => {
    const av = a.row[query.sort];
    const bv = b.row[query.sort];
    const aMissing = av === null || av === undefined;
    const bMissing = bv === null || bv === undefined;
    if (aMissing || bMissing) {
      if (aMissing && bMissing) return a.index - b.index;
      return aMissing ? 1 : -1;
    }
    const order =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), 'en', { numeric: true, sensitivity: 'base' });
    return order === 0 ? a.index - b.index : order * sign;
  });

  const total = indexed.length;
  const lastPage = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, lastPage);
  const start = (page - 1) * query.pageSize;
  return {
    rows: indexed.slice(start, start + query.pageSize).map((entry) => entry.row),
    total,
    totalAll: rows.length,
    page,
    pageSize: query.pageSize,
    sort: query.sort,
    dir: query.dir,
    q: query.q,
  };
}
