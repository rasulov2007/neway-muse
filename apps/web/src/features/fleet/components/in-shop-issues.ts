import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { WORK_TYPE_LABEL, type WorkOrder } from '@neway/shared';
import { apiGet } from '@/lib/api-client';

export interface InShopIssue {
  orderId: string;
  number: string;
  /** When the order last changed: a note, a stage, an edit - the shop's last update. */
  updatedAt: string;
  shopInAt: string;
  /** Short words for the list: the work type, or the words of a plain repair. */
  short: string;
  /** The order number, type and title, for the tooltip. */
  detail: string;
}

/**
 * What each unit in the shop is in for (owner, 2026-10-19: "In maintenance" should say why, as
 * Inactive does). One read of the open in-shop orders, shared by every status cell on the page. A
 * viewer without maintenance access gets nothing back and the cell simply says "In maintenance".
 */
export const IN_SHOP_ISSUES_KEY = ['work-orders', 'in-shop-issues'] as const;

export function useInShopIssues(enabled: boolean): Map<string, InShopIssue> {
  const query = useQuery({
    queryKey: IN_SHOP_ISSUES_KEY,
    queryFn: async () => {
      try {
        return await apiGet<WorkOrder[]>('/fleet/work-orders', { status: 'in_shop' });
      } catch {
        return [];
      }
    },
    enabled,
    staleTime: 60_000,
  });
  return useMemo(() => {
    const map = new Map<string, InShopIssue>();
    for (const o of query.data ?? []) {
      if (map.has(o.unitId)) continue;
      const type = WORK_TYPE_LABEL[o.workType] ?? o.workType;
      const said = o.workDone?.trim() ?? '';
      // The type names the issue now (Engine, DPF …); a plain Repair or Other says it in words.
      const generic = o.workType === 'repair' || o.workType === 'other';
      const short = generic && said ? (said.length > 28 ? `${said.slice(0, 27)}…` : said) : type;
      map.set(o.unitId, { orderId: o.id, number: o.number, updatedAt: o.updatedAt, shopInAt: o.shopInAt, short, detail: `${o.number} · ${type}${said ? ` · ${said}` : ''}` });
    }
    return map;
  }, [query.data]);
}
