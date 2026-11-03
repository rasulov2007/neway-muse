import type { DriverPayType, ExpenseCategory, IsoDate, TruckStatus } from '../facts';

/** Why a metric is `null` instead of a number (docs/DASHBOARD.md §4 honesty rule). */
export type NullReason =
  'no_expense_data' | 'zero_miles' | 'no_mileage_data' | 'zero_gross' | 'no_active_trucks';

/** Numeric metrics of a `FinancialResult`, in the order the KPI strip presents them. */
export const FINANCIAL_METRIC_KEYS = [
  'gross',
  'cost',
  'costEstimated',
  'operatingProfit',
  'inactiveTruckLoss',
  'netOperatingProfit',
  'totalMiles',
  'rpm',
  'cpm',
  'ppm',
  'marginPct',
  'activeTrucks',
  'inactiveTrucks',
  'avgGrossPerTruck',
  'avgCostPerTruck',
  'avgProfitPerTruck',
  'avgMilesPerTruck',
] as const;

export type FinancialMetricKey = (typeof FINANCIAL_METRIC_KEYS)[number];

/** Null reasons per metric; an empty list means the metric is a real number. */
export type FinancialReasons = Record<FinancialMetricKey, NullReason[]>;

export interface CostBreakdownEntry {
  category: ExpenseCategory;
  amount: number;
  /** Portion of `amount` coming from `isEstimate` lines. */
  estimated: number;
  /** `amount / cost * 100`, null when cost is 0. */
  shareOfCostPct: number | null;
}

/** A truck that cost money in the period without producing revenue. */
export interface InactiveTruckLossRow {
  truckId: string;
  unitNumber: string;
  cost: number;
  gross: 0;
}

export type MilesSource = 'odometer' | 'loads';

export interface FinancialResult {
  gross: number;
  /** Null when the period has no expense data at all ("cost unknown", never 0). */
  cost: number | null;
  costEstimated: number;
  costBreakdown: CostBreakdownEntry[];
  operatingProfit: number | null;
  inactiveTruckLoss: number | null;
  /** Trucks (excluding `sold`) with gross 0 and truck-attributed cost > 0. */
  inactiveTruckRows: InactiveTruckLossRow[];
  netOperatingProfit: number | null;
  totalMiles: number | null;
  milesSource: MilesSource | null;
  rpm: number | null;
  cpm: number | null;
  ppm: number | null;
  marginPct: number | null;
  /** Trucks with gross > 0 in the period. */
  activeTrucks: number;
  /** Company trucks (excluding `sold`) with gross 0 in the period. */
  inactiveTrucks: number;
  avgGrossPerTruck: number | null;
  avgCostPerTruck: number | null;
  avgProfitPerTruck: number | null;
  avgMilesPerTruck: number | null;
  averagesBasis: 'active_trucks';
  hasExpenseData: boolean;
  reasons: FinancialReasons;
}

export interface ComparedMetric {
  value: number | null;
  previous: number | null;
  delta: number | null;
  /** `delta / |previous| * 100`; null when either side is null or previous is 0. */
  deltaPct: number | null;
}

export type ComparedFinancials = Record<FinancialMetricKey, ComparedMetric>;

export type OpsNetBucketKey = DriverPayType | 'unknown';

export const OPS_NET_BUCKET_KEYS: readonly OpsNetBucketKey[] = [
  'company',
  'owner_operator',
  'lease_owner',
  'percentage',
  'unknown',
];

/** Per-category cost breakdown for a bucket. `null` means the bucket has no line in that
 * category at all (or the period has no expense data): a dash, never a fake zero. */
export type OpsNetCostBreakdown = Record<OpsNetCategory, number | null>;

/**
 * The ops-net table's columns. Its schema predates the DEF, trailer-repair and recovery lines
 * (2026-10-25), so those fold into the nearest column there: DEF into fuel, trailer repairs into
 * repairs, recoveries into other - its totals still equal `computeFinancials`.
 */
export type OpsNetCategory = Exclude<ExpenseCategory, 'def' | 'trailer_repairs' | 'recovered'>;

export function opsNetCategory(category: ExpenseCategory): OpsNetCategory {
  if (category === 'def') return 'fuel';
  if (category === 'trailer_repairs') return 'repairs';
  if (category === 'recovered') return 'other';
  return category;
}

export interface OpsNetBucket {
  key: OpsNetBucketKey;
  gross: number;
  loads: number;
  /** Authoritative per-category breakdown; its non-null entries sum to `totalCost`. */
  costs: OpsNetCostBreakdown;
  fuel: number | null;
  insurance: number | null;
  factoring: number | null;
  driverPay: number | null;
  driverPayEstimated: number | null;
  /** maintenance + tolls + repairs + dispatch_fee + other. */
  other: number | null;
  totalCost: number | null;
  operatingProfit: number | null;
  marginPct: number | null;
  /** Drivers of this pay type with any revenue or expense in the period. */
  driverCount: number;
  /** `gross / totalMiles`, null without usable miles. */
  rpm: number | null;
  /** Miles attributed to the bucket, using the period-wide miles source. */
  totalMiles: number | null;
  /** Trucks with revenue in the period whose dominant bucket is this one. */
  activeTrucks: number;
  avgGrossPerTruck: number | null;
  avgMilesPerTruck: number | null;
  reasons: NullReason[];
}

/** The company row of the ops-net table: every bucket summed, `unknown` included. */
export type OpsNetTotalsRow = Omit<OpsNetBucket, 'key'>;

export interface UnknownPayTypeDriver {
  driverId: string;
  name: string;
  rawPayTag: string | null;
}

export interface OpsNetResult {
  buckets: OpsNetBucket[];
  /** Every bucket summed. `gross` / `totalCost` equal `computeFinancials` to the cent. */
  totals: OpsNetTotalsRow;
  /** Company-level rows that no pay type can own. */
  inactiveTruckLoss: number | null;
  netOperatingProfit: number | null;
  unknown: {
    driverCount: number;
    gross: number;
    drivers: UnknownPayTypeDriver[];
  };
  hasExpenseData: boolean;
}

export interface TruckPnlRow {
  truckId: string;
  unitNumber: string;
  status: TruckStatus;
  driverId: string | null;
  driverName: string | null;
  payType: DriverPayType | null;
  gross: number;
  miles: number | null;
  loads: number;
  cost: number | null;
  costEstimated: number | null;
  profit: number | null;
  rpm: number | null;
  inactiveLoss: boolean;
}

export type TruckPnlView = 'best' | 'worst' | 'inactive' | 'unprofitable';

export interface TruckPnlFilter {
  /** Case-insensitive substring over unit number and driver name. */
  q?: string;
  /** Driver pay type, or `'unknown'` for rows whose driver type is null. */
  payType?: OpsNetBucketKey;
  status?: TruckStatus;
  unit?: string;
  view?: TruckPnlView;
  /** Row cap for the `best` / `worst` views (default 5). */
  limit?: number;
}

export type TruckPnlSortField =
  'unitNumber' | 'driverName' | 'payType' | 'gross' | 'miles' | 'loads' | 'cost' | 'profit' | 'rpm';

export interface TruckPnlSort {
  field: TruckPnlSortField;
  direction: 'asc' | 'desc';
}

export interface TruckPnlSummary {
  trucks: number;
  gross: number;
  miles: number | null;
  loads: number;
  cost: number | null;
  profit: number | null;
  inactiveLossTrucks: number;
  inactiveLoss: number | null;
}

export type DataQualityStatus = 'ok' | 'warning' | 'error';

export type DataQualityKey =
  | 'revenue_reconciliation'
  | 'expense_completeness'
  | 'unknown_pay_types'
  | 'missing_truck_assignments'
  | 'missing_driver_assignments'
  | 'missing_fuel_data';

export interface DataQualityCheck {
  key: DataQualityKey;
  status: DataQualityStatus;
  title: string;
  detail: string;
  count?: number;
  amount?: number;
  data?: Record<string, unknown>;
}

/** Week coverage input for the expense-completeness check. */
export interface WeekCoverage {
  weekStart: IsoDate;
  hasExpenseData: boolean;
}
