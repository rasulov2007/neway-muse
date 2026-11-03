import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { WorkOrder, WorkOrderWithCost } from '@neway/shared';
import type { RepairOrder } from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet } from '@/lib/api-client';
import { isEnabled } from '@/lib/feature-flags';

/**
 * One work order on a unit, whichever store it lives in.
 *
 * The Fleet is mid-transition: repairs written up through the Create work order form go to the
 * server's work orders, while the older screens still keep theirs in the workspace. A unit's
 * Maintenance and Costs tabs have to show both, or a repair recorded this morning is "missing"
 * from the truck it was recorded on — which is the bug this file closes (2026-09-21).
 */
export interface UnitWorkOrderRow {
  id: string;
  number: string;
  status: string;
  summary: string;
  vendorName: string;
  openedAt: string;
  completedAt: string | null;
  /** Null when the reader may not see money. */
  total: number | null;
  source: 'server' | 'workspace';
  /** The workspace record, for the invoice cell that still writes there. */
  order: RepairOrder | null;
  invoiceCount: number;
  /** The truck's vendor paid the shop (owner, 2026-10-28): not the company's spend. */
  vendorPays: boolean;
}

function fromServer(order: WorkOrder | WorkOrderWithCost): UnitWorkOrderRow {
  const cost = 'total' in order ? order : null;
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    summary: order.workDone ?? order.label,
    vendorName: order.vendorName ?? '',
    openedAt: order.shopInAt,
    completedAt: order.completedAt,
    total: cost ? cost.total : null,
    source: 'server',
    order: null,
    invoiceCount: cost ? cost.invoiceFileIds.length : 0,
    vendorPays: order.charge?.party === 'vendor',
  };
}

function fromWorkspace(order: RepairOrder): UnitWorkOrderRow {
  return {
    id: order.id,
    number: order.roNumber,
    status: order.status,
    summary: order.summary,
    vendorName: order.vendorName,
    openedAt: order.openedAt,
    completedAt: order.completedAt,
    total: order.total,
    source: 'workspace',
    order,
    invoiceCount: order.invoices?.length ?? 0,
    vendorPays: false,
  };
}

/** The server's work orders on one unit; nothing before the flag. */
export function useServerUnitWorkOrders(unitId: string) {
  const account = useAccount();
  return useQuery({
    queryKey: ['work-orders', 'unit', account?.companyId ?? null, unitId],
    queryFn: () => apiGet<(WorkOrder | WorkOrderWithCost)[]>('/fleet/work-orders', { unitId }),
    enabled: account !== null && isEnabled('fleet_v2'),
  });
}

/**
 * Every work order on the unit, newest first, from both stores. A record that was migrated from
 * the workspace keeps its number, so the same number on both sides is one record, shown once.
 */
export function useUnitWorkOrders(
  unitId: string,
  workspaceOrders: readonly RepairOrder[],
): { rows: UnitWorkOrderRow[]; loading: boolean } {
  const server = useServerUnitWorkOrders(unitId);
  const rows = useMemo(() => {
    const fromApi = (server.data ?? []).map(fromServer);
    const numbers = new Set(fromApi.map((r) => r.number));
    const local = workspaceOrders.filter((o) => !numbers.has(o.roNumber)).map(fromWorkspace);
    return [...fromApi, ...local].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  }, [server.data, workspaceOrders]);
  return { rows, loading: isEnabled('fleet_v2') && server.isPending };
}
