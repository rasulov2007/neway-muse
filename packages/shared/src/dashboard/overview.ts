import { z } from 'zod';
import { DashboardMetaSchema } from './meta.js';
import { MoneyMetricSchema, NumberMetricSchema } from './metric.js';

export const EXPENSE_CATEGORIES = [
  'fuel',
  /** Diesel exhaust fluid: its own line, never blended into diesel (owner, 2026-10-25). */
  'def',
  'insurance',
  'maintenance',
  'tolls',
  'repairs',
  'dispatch_fee',
  'factoring',
  'driver_pay',
  /** Staff wages and payroll taxes: company overhead, never a truck's cost. */
  'staff_payroll',
  /** Repairs written to a trailer: the trailer's cost, never a truck's (owner, 2026-10-25). */
  'trailer_repairs',
  'other',
  /** Money held back from drivers for company-paid costs: a negative line (owner, 2026-10-25). */
  'recovered',
] as const;
export const ExpenseCategorySchema = z.enum(EXPENSE_CATEGORIES);
export type ExpenseCategory = z.infer<typeof ExpenseCategorySchema>;

/** One slice of the cost breakdown; `share` is a percentage of total cost (null when masked). */
export const CostBreakdownItemSchema = z.object({
  category: ExpenseCategorySchema,
  amount: z.number().nullable(),
  estimatedAmount: z.number().nullable(),
  share: z.number().nullable(),
});
export type CostBreakdownItem = z.infer<typeof CostBreakdownItemSchema>;

export const ReconciliationStatusSchema = z.enum(['ok', 'mismatch', 'unavailable']);
export type ReconciliationStatus = z.infer<typeof ReconciliationStatusSchema>;

/** Response of `GET /dashboard/overview` (docs/DASHBOARD.md §4). */
export const DashboardOverviewSchema = z.object({
  meta: DashboardMetaSchema,
  financial: z.object({
    gross: MoneyMetricSchema,
    cost: MoneyMetricSchema,
    operatingProfit: MoneyMetricSchema,
    inactiveTruckLoss: MoneyMetricSchema,
    netOperatingProfit: MoneyMetricSchema,
  }),
  unitEconomics: z.object({
    rpm: NumberMetricSchema,
    cpm: NumberMetricSchema,
    ppm: NumberMetricSchema,
    marginPct: NumberMetricSchema,
    totalMiles: NumberMetricSchema,
  }),
  fleet: z.object({
    activeTrucks: NumberMetricSchema,
    inactiveTrucks: NumberMetricSchema,
    avgGrossPerTruck: MoneyMetricSchema,
    avgCostPerTruck: MoneyMetricSchema,
    avgProfitPerTruck: MoneyMetricSchema,
    avgMilesPerTruck: NumberMetricSchema,
    /** Averages are always divided by active trucks (trucks with revenue in the period). */
    averagesBasis: z.literal('active_trucks'),
  }),
  costBreakdown: z.array(CostBreakdownItemSchema),
  reconciliation: z.object({
    status: ReconciliationStatusSchema,
    dashboardGross: z.number().nullable(),
    ledgerGross: z.number().nullable(),
    difference: z.number().nullable(),
  }),
  expenseCoverage: z.object({
    hasData: z.boolean(),
    note: z.string().optional(),
  }),
  /**
   * What the cost figure is made of. A reader has to be able to tell the books from a projection:
   * `posted` is what Accounting recorded, `estimated` is what the period still owes and has not
   * been posted, and `unallocatedPosted` is the part of the posted total that names no truck,
   * driver or load. `dateBasis` explains why a delivered load and its driver pay can fall in
   * different weeks.
   */
  costMix: z.object({
    posted: z.number(),
    estimated: z.number(),
    unallocatedPosted: z.number(),
    hasEstimates: z.boolean(),
    dateBasis: z.string(),
  }),
});
export type DashboardOverview = z.infer<typeof DashboardOverviewSchema>;
