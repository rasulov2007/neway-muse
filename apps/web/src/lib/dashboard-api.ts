/**
 * Typed client for `GET /api/v1/dashboard/*` (docs/DASHBOARD.md §2). Every response is validated
 * against the shared zod contracts, so widgets only ever see schema-valid data.
 *
 * Until Phase 3 auth exists the principal is chosen by the `X-Demo-Role` header, which exercises
 * the server-side financial masking path (docs/DASHBOARD.md §10).
 */
import {
  DashboardVendorsSchema,
  type DashboardVendors,
  DashboardDataHealthSchema,
  DashboardDispatchSchema,
  DashboardDrilldownSchema,
  DashboardFuelSchema,
  DashboardOpsNetSchema,
  DashboardOverviewSchema,
  DashboardTrendsSchema,
  DashboardTruckPnlSchema,
  type DashboardDataHealth,
  type DashboardDispatch,
  type DashboardDrilldown,
  type DashboardFuel,
  type DashboardOpsNet,
  type DashboardOverview,
  type DashboardPeriodQuery,
  type DashboardTrends,
  type DashboardTruckPnl,
  type DrilldownMetric,
  type OpsNetPayType,
  type TruckPnlView,
  type TruckStatus,
} from '@neway/shared';
import { apiRequest } from './api';

export const DEMO_ROLES = ['admin', 'executive', 'operations'] as const;
export type DemoRole = (typeof DEMO_ROLES)[number];
export const DEFAULT_DEMO_ROLE: DemoRole = 'admin';
export const DEMO_ROLE_HEADER = 'X-Demo-Role';

/** Period plus the demo principal; shared by every dashboard request. */
export interface DashboardRequest {
  period: DashboardPeriodQuery;
  role: DemoRole;
}

/** Server-side filters of `GET /dashboard/truck-pnl` (docs/DASHBOARD.md §6). */
export interface TruckPnlFilters {
  q?: string;
  payType?: OpsNetPayType;
  status?: TruckStatus;
  unit?: string;
  view?: TruckPnlView;
  /** `field` or `-field`. */
  sort?: string;
  page?: number;
  pageSize?: number;
}

type QueryValue = string | number | undefined;

function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function periodParams(period: DashboardPeriodQuery): Record<string, QueryValue> {
  return { period: period.period, from: period.from, to: period.to };
}

function roleInit(role: DemoRole): RequestInit {
  return { headers: { [DEMO_ROLE_HEADER]: role } };
}

export function fetchOverview(request: DashboardRequest): Promise<DashboardOverview> {
  return apiRequest(
    `/dashboard/overview${buildQuery(periodParams(request.period))}`,
    DashboardOverviewSchema,
    roleInit(request.role),
  );
}

export function fetchTrends(request: DashboardRequest): Promise<DashboardTrends> {
  return apiRequest(
    `/dashboard/trends${buildQuery(periodParams(request.period))}`,
    DashboardTrendsSchema,
    roleInit(request.role),
  );
}

/** Vendor trucks (owner, 2026-10-28): gross, company share, driver pay, costs, vendor net. */
export function fetchVendors(request: DashboardRequest): Promise<DashboardVendors> {
  return apiRequest(
    `/dashboard/vendors${buildQuery(periodParams(request.period))}`,
    DashboardVendorsSchema,
    roleInit(request.role),
  );
}

export function fetchOpsNet(request: DashboardRequest): Promise<DashboardOpsNet> {
  return apiRequest(
    `/dashboard/ops-net${buildQuery(periodParams(request.period))}`,
    DashboardOpsNetSchema,
    roleInit(request.role),
  );
}

export function fetchTruckPnl(
  request: DashboardRequest,
  filters: TruckPnlFilters = {},
): Promise<DashboardTruckPnl> {
  return apiRequest(
    `/dashboard/truck-pnl${buildQuery({ ...periodParams(request.period), ...filters })}`,
    DashboardTruckPnlSchema,
    roleInit(request.role),
  );
}

export function fetchFuel(request: DashboardRequest): Promise<DashboardFuel> {
  return apiRequest(
    `/dashboard/fuel${buildQuery(periodParams(request.period))}`,
    DashboardFuelSchema,
    roleInit(request.role),
  );
}

export function fetchDispatchPerformance(request: DashboardRequest): Promise<DashboardDispatch> {
  return apiRequest(
    `/dashboard/dispatch-performance${buildQuery(periodParams(request.period))}`,
    DashboardDispatchSchema,
    roleInit(request.role),
  );
}

export function fetchDataHealth(request: DashboardRequest): Promise<DashboardDataHealth> {
  return apiRequest(
    `/dashboard/data-health${buildQuery(periodParams(request.period))}`,
    DashboardDataHealthSchema,
    roleInit(request.role),
  );
}

export interface DrilldownPage {
  page?: number;
  pageSize?: number;
}

export function fetchDrilldown(
  request: DashboardRequest,
  metric: DrilldownMetric,
  paging: DrilldownPage = {},
): Promise<DashboardDrilldown> {
  return apiRequest(
    `/dashboard/drilldown${buildQuery({ metric, ...periodParams(request.period), ...paging })}`,
    DashboardDrilldownSchema,
    roleInit(request.role),
  );
}
