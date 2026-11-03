import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { WorkOrder, WorkOrderWithCost } from '@neway/shared';
import { demoData, type Vendor } from '@/demo';
import { normaliseVendorName } from '@/demo/vendor-migration';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet } from '@/lib/api-client';
import { isEnabled } from '@/lib/feature-flags';

/**
 * A vendor's work orders from both stores (owner, 2026-10-14: the Vendors page counted only the
 * workspace's old orders, so every shop read 0 orders and $0.00 once orders moved to the server).
 *
 * Server orders match by vendor id - or by name for a reader who may not see costs, whose rows
 * carry no id - and a workspace order whose number the server already has is the same record,
 * counted once.
 */
export interface VendorOrderRow {
  id: string;
  number: string;
  vendorId: string | null;
  vendorKey: string;
  unitId: string;
  unitNumber: string;
  unitType: 'truck' | 'trailer';
  summary: string;
  status: string;
  openedAt: string;
  /** Completed orders only; null when the reader may not see money. */
  cost: number | null;
  server: boolean;
}

export interface VendorStatsRow {
  workOrders: number;
  spend: number;
  lastUsedAt: string | null;
}

export function useVendorOrders(): { rows: VendorOrderRow[]; loading: boolean } {
  const account = useAccount();
  const server = useQuery({
    queryKey: ['work-orders', 'all', account?.companyId ?? null],
    queryFn: () => apiGet<(WorkOrder | WorkOrderWithCost)[]>('/fleet/work-orders'),
    enabled: account !== null && isEnabled('fleet_v2'),
    staleTime: 15_000,
  });
  const rows = useMemo(() => {
    const fromApi: VendorOrderRow[] = (server.data ?? []).map((o) => {
      const withCost = 'total' in o ? (o as WorkOrderWithCost) : null;
      const money = withCost ? (withCost.invoiceTotal ?? withCost.total) : null;
      return {
        id: o.id,
        number: o.number,
        vendorId: withCost?.vendorId ?? null,
        vendorKey: normaliseVendorName(withCost?.vendorName ?? o.vendorName ?? ''),
        unitId: o.unitId,
        unitNumber: o.unitNumber,
        unitType: o.assetType,
        summary: o.workDone ?? '',
        status: o.status,
        openedAt: o.completedAt ?? o.shopInAt,
        cost: withCost && o.status === 'completed' ? Number(money ?? 0) : null,
        server: true,
      };
    });
    const numbers = new Set(fromApi.map((r) => r.number));
    const local: VendorOrderRow[] = demoData.repairOrders
      .filter((o) => !numbers.has(o.roNumber))
      .map((o) => ({
        id: o.id,
        number: o.roNumber,
        vendorId: o.vendorId ?? null,
        vendorKey: normaliseVendorName(o.vendorName ?? ''),
        unitId: o.unitType === 'trailer' ? (o.trailerId ?? '') : o.truckId,
        unitNumber: o.unitNumber,
        unitType: o.unitType === 'trailer' ? 'trailer' : 'truck',
        summary: o.summary,
        status: o.status,
        openedAt: o.openedAt,
        cost: o.status === 'completed' ? o.total : null,
        server: false,
      }));
    return [...fromApi, ...local].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  }, [server.data]);
  return { rows, loading: server.isPending && isEnabled('fleet_v2') };
}

/** This vendor's orders: by id, or by name when the row carries no id. */
export function ordersOf(vendor: Pick<Vendor, 'id' | 'name'>, rows: VendorOrderRow[]): VendorOrderRow[] {
  const key = normaliseVendorName(vendor.name);
  return rows.filter((r) => (r.vendorId ? r.vendorId === vendor.id : r.vendorKey === key));
}

export function statsOf(orders: VendorOrderRow[]): VendorStatsRow {
  return {
    workOrders: orders.length,
    spend: Math.round(orders.reduce((s, o) => s + (o.cost ?? 0), 0) * 100) / 100,
    lastUsedAt: orders[0]?.openedAt ?? null,
  };
}
