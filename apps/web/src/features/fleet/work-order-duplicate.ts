/**
 * Is this new work order the same repair as one already saved? (owner, 2026-09-30: a trailer
 * repair was entered twice because the first did not show.)
 *
 * Same unit (the caller passes that unit's orders), same shop, within a week, and the same total -
 * or, for an account that may not see money, the same description. A voided order never counts.
 */
export interface ExistingOrder {
  number: string;
  vendorName: string | null;
  workDone: string | null;
  label: string;
  shopInAt: string;
  completedAt: string | null;
  createdAt: string;
  total?: number | null;
  voided?: unknown;
}

const WEEK_MS = 7 * 86_400_000;
const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export function findDuplicateOrder(
  existing: readonly ExistingOrder[],
  next: { vendorName: string | null; total: number | null; title: string; at: number },
): ExistingOrder | null {
  if (!next.vendorName) return null;
  return (
    existing.find((o) => {
      if (o.voided) return false;
      if (norm(o.vendorName) !== norm(next.vendorName)) return false;
      const at = Date.parse(o.completedAt ?? o.shopInAt ?? o.createdAt);
      if (!Number.isFinite(at) || Math.abs(at - next.at) > WEEK_MS) return false;
      if (typeof o.total === 'number' && next.total !== null) return Math.abs(o.total - next.total) < 0.005;
      return norm(o.workDone ?? o.label) === norm(next.title);
    }) ?? null
  );
}
