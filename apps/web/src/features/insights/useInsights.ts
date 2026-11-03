import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  Insight,
  MetricComparison,
  ReportDefinition,
  ReportResult,
  RunReportRequest,
  SavedReportRecord,
} from '@neway/shared';
import { apiGet, apiPost } from '@/lib/api-client';
import type { VendorMoneySummary } from '@neway/shared';

/**
 * Reports and analytics data.
 *
 * Every figure here is computed on the server by the same reporting engines the dashboard uses.
 * Nothing is aggregated in the browser — a carrier with a thousand trucks would ship megabytes of
 * loads to add them up in React, and the totals would then be a second calculation that can drift.
 */

export interface TrendPoint {
  weekStart: string;
  /** Linehaul + accessorials + TONU. */
  gross: number;
  linehaul?: number;
  accessorials?: number;
  tonu?: number;
  /** Net of recoveries; null when the week has no cost line. */
  cost: number | null;
  /** Null unless the week has both delivered loads and cost. */
  profit: number | null;
  miles: number;
}

export interface CostDriver {
  /** Includes `def`, `trailer_repairs` and `recovered` (a negative amount). */
  category: string;
  amount: number;
  perMile: number | null;
  shareOfRevenue: number | null;
  changePct: number | null;
}

export interface RankedEntity {
  id: string;
  label: string;
  gross: number;
  cost: number | null;
  profit: number | null;
  miles: number | null;
  rpm: number | null;
  cpm: number | null;
  marginPct: number | null;
  href: string;
  linehaulRpm?: number | null;
  oneSided?: 'cost_only' | 'revenue_only' | null;
  /** Why profit is not shown for this row. */
  profitReason?: string | null;
}

export interface DataStatus {
  generated: boolean;
  revenue: { source: 'neway_loads'; loadsOnFile: number; connected: boolean; linesInPeriod: number };
  cost: { linesInPeriod: number; bySource: Record<string, number> };
  fuel: { rowsInPeriod: number; latestAt: string | null; unlinkedLedgerFuel: number };
  profit: { available: boolean; code: string; reason: string | null };
}

export interface ExecutiveAnalytics {
  range: { from: string; to: string; label: string };
  comparison: { from: string; to: string };
  source: 'demo' | 'database';
  metrics: MetricComparison[];
  notes: string[];
  trend: TrendPoint[];
  insights: Insight[];
  dataStatus?: DataStatus;
  profitHidden?: { code: string; reason: string } | null;
}

export interface WorkforceAnalytics {
  source: 'database';
  headcount: number;
  /** The working roster (drivers table), not employee records. */
  drivers: number;
  staff: number;
  employees?: number;
  driversOnboarding?: number;
  driversByStatus?: { status: string; count: number }[];
  byDepartment: { department: string; count: number }[];
  byStatus: { status: string; count: number }[];
  ptoPending: number;
  attendanceExceptions: number;
  onboardingActive: number;
  candidatesInPipeline: number;
  /** What "Candidates in pipeline" counts: `open_leads` = hiring leads not converted or dead. */
  candidatesBasis?: string;
  notes: string[];
}

/** The date presets analytics and reports share, so both mean the same thing by "this month". */
export const PERIOD_PRESETS = [
  { value: 'today', label: 'Today' },
  { value: 'this_week', label: 'This week' },
  { value: 'last_week', label: 'Last week' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
] as const;

export function useReportCatalog(): UseQueryResult<ReportDefinition[]> {
  return useQuery({
    queryKey: ['reports', 'catalog'],
    queryFn: () => apiGet<ReportDefinition[]>('/reports/catalog'),
    staleTime: 5 * 60_000,
  });
}

export function useSavedReports(): UseQueryResult<SavedReportRecord[]> {
  return useQuery({
    queryKey: ['reports', 'saved'],
    queryFn: () => apiGet<SavedReportRecord[]>('/reports/saved'),
  });
}

export function useRunReport() {
  return useMutation({
    mutationFn: (input: Partial<RunReportRequest> & { reportKey: string }) =>
      apiPost<ReportResult>('/reports/run', input),
  });
}

export function useSaveReport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; reportKey: string; config: Record<string, unknown> }) =>
      apiPost<SavedReportRecord[]>('/reports/saved', input),
    onSuccess: () => client.invalidateQueries({ queryKey: ['reports', 'saved'] }),
  });
}

export function useExecutiveAnalytics(preset: string): UseQueryResult<ExecutiveAnalytics> {
  return useQuery({
    queryKey: ['analytics', 'executive', preset],
    queryFn: () => apiGet<ExecutiveAnalytics>('/analytics/executive', { preset }),
    placeholderData: (previous) => previous,
  });
}

export interface CostDriversResponse {
  drivers: CostDriver[];
  notes: string[];
  totals?: {
    costBeforeRecovery: number | null;
    recovered: number | null;
    net: number | null;
    /** Recoveries on file that have not been applied to a cost line yet. */
    recoveredUnapplied?: number | null;
  };
  recoveredByKind?: Record<string, number> | { kind: string; amount: number }[];
  byTrailer?: { trailerId: string | null; unitNumber: string | null; amount: number; orders: number }[];
  /** Repairs and maintenance per truck, most first. */
  byTruck?: { truckId: string | null; unitNumber: string | null; amount: number; orders: number }[];
}

/** Vendor trucks (owner, 2026-10-28): what the company keeps and the vendor's side, per truck. */
export function useVendorAnalytics(preset: string): UseQueryResult<VendorMoneySummary> {
  return useQuery({
    queryKey: ['analytics', 'vendors', preset],
    queryFn: () => apiGet<VendorMoneySummary>('/analytics/vendors', { preset }),
  });
}

export function useCostDrivers(preset: string): UseQueryResult<CostDriversResponse> {
  return useQuery({
    queryKey: ['analytics', 'cost-drivers', preset],
    queryFn: () => apiGet<CostDriversResponse>('/analytics/cost-drivers', { preset }),
    placeholderData: (previous) => previous,
  });
}

export type AccessorialType = 'detention' | 'layover' | 'tonu' | 'lumper' | 'other';
export type AccessorialDriverBasis = 'statement' | 'allocation' | 'for_driver' | 'excluded' | 'no_charge' | 'unknown';

/** One accessorial type's split for the period, or the totals (no type/label). */
export interface AccessorialSplitRow {
  type: AccessorialType;
  label: string;
  loads: number;
  charges: number;
  claims: number;
  billed: number;
  /** Null when any driver share in the row is not known yet; the reason says why. */
  toDriver: number | null;
  toDriverReason: string | null;
  unknownDriver: number;
  toDispatcher: number;
  /** Null whenever To driver is. */
  companyKeeps: number | null;
}

export interface AccessorialSplitEntry {
  loadId: string;
  loadNumber: string;
  brokerReference: string | null;
  type: AccessorialType;
  label: string;
  day: string;
  charges: number;
  billed: number;
  toDriver: number | null;
  driverBasis: AccessorialDriverBasis;
  driverReason: string | null;
  toDispatcher: number;
  companyKeeps: number | null;
  driverName: string | null;
  dispatcherName: string | null;
  claimStatus: string | null;
  href: string;
}

export interface AccessorialSplitResponse {
  range: { from: string; to: string };
  source: 'database';
  rows: AccessorialSplitRow[];
  totals: Omit<AccessorialSplitRow, 'type' | 'label'>;
  loads: { items: AccessorialSplitEntry[]; total: number; page: number; pageSize: number };
  driverBases: Partial<Record<AccessorialDriverBasis, number>>;
  notes: string[];
}

/** Accessorials - who gets what: billed, to driver, to dispatcher, company keeps (server figures). */
export function useAccessorialSplit(preset: string, page = 1, pageSize = 10): UseQueryResult<AccessorialSplitResponse> {
  return useQuery({
    queryKey: ['analytics', 'accessorials', preset, page, pageSize],
    queryFn: () =>
      apiGet<AccessorialSplitResponse>('/analytics/accessorials', {
        preset,
        page: String(page),
        pageSize: String(pageSize),
      }),
    placeholderData: (previous) => previous,
  });
}

/** The sort keys the ranking endpoints accept (server-side, over every row). */
export type RankingSortKey =
  | 'label'
  | 'miles'
  | 'gross'
  | 'cost'
  | 'profit'
  | 'rpm'
  | 'linehaulRpm'
  | 'cpm'
  | 'marginPct';

export interface RankingParams {
  page: number;
  pageSize: number;
  sort: RankingSortKey;
  dir: 'asc' | 'desc';
  q: string;
}

/** One page of a ranking. `total` counts rows matching the search; `totalAll` counts every row. */
export interface RankingPage {
  rows: RankedEntity[];
  total: number;
  totalAll: number;
  page: number;
  pageSize: number;
  sort: RankingSortKey;
  dir: 'asc' | 'desc';
  q: string;
}

function rankingQuery(preset: string, params: RankingParams) {
  return {
    preset,
    page: String(params.page),
    pageSize: String(params.pageSize),
    sort: params.sort,
    dir: params.dir,
    ...(params.q ? { q: params.q } : {}),
  };
}

/** Trucks, one page at a time; sorting and search run on the server over the whole fleet. */
export function useTruckRankingPage(
  preset: string,
  params: RankingParams,
): UseQueryResult<RankingPage> {
  return useQuery({
    queryKey: ['analytics', 'trucks', preset, params],
    queryFn: () => apiGet<RankingPage>('/analytics/trucks', rankingQuery(preset, params)),
    placeholderData: (previous) => previous,
  });
}

/** Drivers, one page at a time, the same way. */
export function useDriverRankingPage(
  preset: string,
  params: RankingParams,
): UseQueryResult<RankingPage> {
  return useQuery({
    queryKey: ['analytics', 'drivers', preset, params],
    queryFn: () => apiGet<RankingPage>('/analytics/drivers', rankingQuery(preset, params)),
    placeholderData: (previous) => previous,
  });
}

export interface OperationsAnalytics {
  loads: number;
  /** TONU lines, counted apart from delivered loads. */
  tonuLoads?: number;
  loadedMiles: number;
  emptyMiles: number;
  totalMiles: number;
  /** Loads, loaded miles and empty miles against the previous period (same sums). */
  volume: MetricComparison[];
  metrics: MetricComparison[];
  notes: string[];
}

export function useOperationsAnalytics(preset: string): UseQueryResult<OperationsAnalytics> {
  return useQuery({
    queryKey: ['analytics', 'operations', preset],
    queryFn: () => apiGet<OperationsAnalytics>('/analytics/operations', { preset }),
    placeholderData: (previous) => previous,
  });
}

export interface FuelTotals {
  fillUps: number;
  gallons: number;
  discountedCost: number;
  grossCost: number;
  avgPricePerGallon: number | null;
  fuelCostPerMile: number | null;
  /** Why a ratio above is null. Shown rather than swallowed. */
  reasons: string[];
  /** DEF, apart from the diesel figures above. */
  def?: { fillUps: number; gallons: number; cost: number };
}

export interface FuelAnalytics {
  totals: FuelTotals;
  byTruck: {
    truckId: string | null;
    unitNumber: string | null;
    gallons: number;
    cost: number;
    defCost?: number;
    defGallons?: number;
  }[];
  /** The newest fuel-card row on file and how many rows fall in the period. */
  freshness?: { latestAt: string | null; rowsInPeriod: number };
  notes: string[];
}

export function useFuelAnalytics(preset: string): UseQueryResult<FuelAnalytics> {
  return useQuery({
    queryKey: ['analytics', 'fuel', preset],
    queryFn: () => apiGet<FuelAnalytics>('/analytics/fuel', { preset }),
    placeholderData: (previous) => previous,
  });
}

export function useWorkforceAnalytics(): UseQueryResult<WorkforceAnalytics> {
  return useQuery({
    queryKey: ['analytics', 'workforce'],
    queryFn: () => apiGet<WorkforceAnalytics>('/analytics/workforce'),
  });
}

/**
 * Turns a result into CSV.
 *
 * The header carries the report name, the exact range and when it ran, so an exported file can be
 * read months later without anybody having to remember which filters produced it. Rows are the
 * ones on screen, and the totals line is the one on screen — an export that recomputes is an
 * export that can disagree with what the person was looking at.
 */
export function toCsv(result: ReportResult): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines: string[] = [
    `# ${result.name}`,
    `# Period,${result.range.from} to ${result.range.to}`,
    `# Generated,${result.generatedAt}`,
    `# Source,${result.source === 'database' ? 'Live records' : 'Reporting dataset'}`,
    ...result.notes.map((note) => `# Note,${escape(note)}`),
    '',
    result.columns.map((c) => escape(c.label)).join(','),
    ...result.rows.map((row) => result.columns.map((c) => escape(row.cells[c.key])).join(',')),
  ];

  if (Object.keys(result.totals).length > 0) {
    lines.push(
      result.columns
        .map((c, index) => (index === 0 ? 'Total' : escape(result.totals[c.key])))
        .join(','),
    );
  }
  return lines.join('\n');
}

export function downloadCsv(result: ReportResult): void {
  const blob = new Blob([toCsv(result)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${result.reportKey}_${result.range.from}_${result.range.to}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
