export const DEFAULT_PAGE_SIZES = [25, 50, 100];

export function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : String(value);
}

/** "1–25 of 377" for the current page; "0 of 0" when there are no rows. */
export function formatPaginationRange(page: number, pageSize: number, total: number): string {
  if (total <= 0) return '0 of 0';
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return `${formatNumber(start)}–${formatNumber(end)} of ${formatNumber(total)}`;
}

/** Number of pages (at least 1). */
export function getPageCount(pageSize: number, total: number): number {
  if (pageSize <= 0 || !Number.isFinite(pageSize)) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}
