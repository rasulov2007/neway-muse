import type { ExpenseCategory, ReportingFacts, RevenueLine, TruckFact } from '../facts';
import {
  pct,
  roundMoney,
  roundNullable,
  roundPct,
  roundRatio,
  safeDivide,
  subtract,
  sum,
} from './money';
import {
  FINANCIAL_METRIC_KEYS,
  type ComparedFinancials,
  type ComparedMetric,
  type CostBreakdownEntry,
  type FinancialMetricKey,
  type FinancialReasons,
  type FinancialResult,
  type InactiveTruckLossRow,
  type MilesSource,
  type NullReason,
} from './types';

/** Category order for the cost breakdown, largest operating buckets first. */
const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  'fuel',
  'def',
  'driver_pay',
  'insurance',
  'maintenance',
  'repairs',
  'trailer_repairs',
  'tolls',
  'dispatch_fee',
  'factoring',
  'staff_payroll',
  'other',
  'recovered',
];

/**
 * What one revenue line earned: linehaul + billed accessorials + TONU (owner, 2026-10-25). Every
 * engine sums this, never `linehaul` alone, so gross means the same thing everywhere.
 */
export function revenueOf(line: RevenueLine): number {
  return line.linehaul + (line.accessorials ?? 0) + (line.tonu ?? 0);
}

/**
 * Whether the period has any expense data. Rule: "no expense data in period => cost unknown".
 * Cost is null when no coverage week reports data OR there are zero expense lines; either
 * condition alone means we cannot tell an unrecorded expense from a real zero.
 */
export function hasExpenseData(facts: ReportingFacts): boolean {
  const anyWeekCovered = facts.expenseCoverage.some((week) => week.hasExpenseData);
  return anyWeekCovered && facts.expenses.length > 0;
}

/** Company trucks that count for P&L and inactivity: everything except `sold` and `archived`. */
export function fleetTrucks(facts: ReportingFacts): TruckFact[] {
  return facts.trucks.filter((truck) => truck.status !== 'sold' && truck.status !== 'archived');
}

/** Unrounded linehaul per truck id from revenue lines (lines without a truck are skipped). */
export function grossByTruck(facts: ReportingFacts): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of facts.revenue) {
    if (line.truckId === null) continue;
    map.set(line.truckId, (map.get(line.truckId) ?? 0) + revenueOf(line));
  }
  return map;
}

/**
 * Unrounded cost per truck id. Only expense lines carrying a `truckId` are attributed (fuel
 * lines included); lines without a truck are company-level and never make a truck "inactive".
 */
export function costByTruck(
  facts: ReportingFacts,
): Map<string, { total: number; estimated: number }> {
  const map = new Map<string, { total: number; estimated: number }>();
  for (const line of facts.expenses) {
    if (line.truckId === null) continue;
    const entry = map.get(line.truckId) ?? { total: 0, estimated: 0 };
    entry.total += line.amount;
    if (line.isEstimate) entry.estimated += line.amount;
    map.set(line.truckId, entry);
  }
  return map;
}

/**
 * Miles per truck id. Odometer-derived mileage records win for a truck when any exist;
 * otherwise loaded + empty miles from its revenue lines. Trucks with neither are absent.
 */
export function milesByTruck(
  facts: ReportingFacts,
): Map<string, { miles: number; source: MilesSource }> {
  const map = new Map<string, { miles: number; source: MilesSource }>();
  for (const record of facts.mileage) {
    const entry = map.get(record.truckId);
    if (entry && entry.source === 'odometer') {
      entry.miles += record.miles;
    } else {
      map.set(record.truckId, { miles: record.miles, source: 'odometer' });
    }
  }
  for (const line of facts.revenue) {
    if (line.truckId === null) continue;
    const entry = map.get(line.truckId);
    if (entry?.source === 'odometer') continue;
    const loadMiles = line.loadedMiles + line.emptyMiles;
    if (entry) {
      entry.miles += loadMiles;
    } else {
      map.set(line.truckId, { miles: loadMiles, source: 'loads' });
    }
  }
  return map;
}

/**
 * Total miles for the period: the sum of mileage records when any exist, else load miles from
 * revenue lines; null when both are empty.
 */
export function totalMiles(facts: ReportingFacts): { miles: number; source: MilesSource } | null {
  if (facts.mileage.length > 0) {
    return { miles: sum(facts.mileage.map((record) => record.miles)), source: 'odometer' };
  }
  if (facts.revenue.length > 0) {
    return {
      miles: sum(facts.revenue.map((line) => line.loadedMiles + line.emptyMiles)),
      source: 'loads',
    };
  }
  return null;
}

/** Creates an all-empty reasons record so every metric key is always present. */
function emptyReasons(): FinancialReasons {
  const reasons = {} as FinancialReasons;
  for (const key of FINANCIAL_METRIC_KEYS) reasons[key] = [];
  return reasons;
}

/** Builds the per-category cost breakdown with estimated portions and share of total cost. */
function buildCostBreakdown(facts: ReportingFacts, rawCost: number): CostBreakdownEntry[] {
  const totals = new Map<ExpenseCategory, { amount: number; estimated: number }>();
  for (const line of facts.expenses) {
    const entry = totals.get(line.category) ?? { amount: 0, estimated: 0 };
    entry.amount += line.amount;
    if (line.isEstimate) entry.estimated += line.amount;
    totals.set(line.category, entry);
  }
  return EXPENSE_CATEGORIES.filter((category) => totals.has(category)).map((category) => {
    const entry = totals.get(category) ?? { amount: 0, estimated: 0 };
    return {
      category,
      amount: roundMoney(entry.amount),
      estimated: roundMoney(entry.estimated),
      shareOfCostPct: pct(entry.amount, rawCost === 0 ? null : rawCost),
    };
  });
}

/** Computes the headline financial metrics for one period (docs/DASHBOARD.md §4). */
export function computeFinancials(facts: ReportingFacts): FinancialResult {
  const reasons = emptyReasons();
  const expenseKnown = hasExpenseData(facts);

  const gross = roundMoney(sum(facts.revenue.map(revenueOf)));
  const rawCost = expenseKnown ? sum(facts.expenses.map((line) => line.amount)) : null;
  const cost = roundNullable(rawCost, roundMoney);
  const costEstimated = roundMoney(
    sum(facts.expenses.filter((line) => line.isEstimate).map((line) => line.amount)),
  );
  const costBreakdown = expenseKnown ? buildCostBreakdown(facts, rawCost ?? 0) : [];
  const operatingProfit = roundNullable(subtract(gross, cost), roundMoney);

  const truckGross = grossByTruck(facts);
  const truckCost = costByTruck(facts);
  const fleet = fleetTrucks(facts);
  const activeTruckIds = new Set<string>();
  for (const [truckId, amount] of truckGross) {
    if (amount > 0) activeTruckIds.add(truckId);
  }
  const inactiveFleet = fleet.filter((truck) => (truckGross.get(truck.truckId) ?? 0) === 0);

  const inactiveTruckRows: InactiveTruckLossRow[] = expenseKnown
    ? inactiveFleet
        .map((truck) => ({ truck, cost: truckCost.get(truck.truckId)?.total ?? 0 }))
        .filter((entry) => entry.cost > 0)
        .map<InactiveTruckLossRow>((entry) => ({
          truckId: entry.truck.truckId,
          unitNumber: entry.truck.unitNumber,
          cost: roundMoney(entry.cost),
          gross: 0,
        }))
    : [];
  const inactiveTruckLoss = expenseKnown
    ? roundMoney(sum(inactiveTruckRows.map((row) => row.cost)))
    : null;
  const netOperatingProfit = roundNullable(
    subtract(operatingProfit, inactiveTruckLoss),
    roundMoney,
  );

  const milesInfo = totalMiles(facts);
  const miles = milesInfo === null ? null : roundRatio(milesInfo.miles);
  const milesSource = milesInfo?.source ?? null;
  const milesUsable = miles !== null && miles > 0 ? miles : null;

  const rpm = roundNullable(safeDivide(gross, milesUsable), roundRatio);
  const cpm = roundNullable(safeDivide(cost, milesUsable), roundRatio);
  const ppm = roundNullable(safeDivide(operatingProfit, milesUsable), roundRatio);
  const marginPct = pct(operatingProfit, gross === 0 ? null : gross);

  const activeTrucks = activeTruckIds.size;
  const activeDivisor = activeTrucks === 0 ? null : activeTrucks;
  const avgGrossPerTruck = roundNullable(safeDivide(gross, activeDivisor), roundMoney);
  const avgCostPerTruck = roundNullable(safeDivide(cost, activeDivisor), roundMoney);
  const avgProfitPerTruck = roundNullable(safeDivide(operatingProfit, activeDivisor), roundMoney);
  const avgMilesPerTruck = roundNullable(safeDivide(miles, activeDivisor), roundRatio);

  // Reasons: attach every cause that makes a metric null so the UI can explain the dash.
  const noExpense: NullReason[] = expenseKnown ? [] : ['no_expense_data'];
  const milesReason: NullReason[] =
    miles === null ? ['no_mileage_data'] : miles === 0 ? ['zero_miles'] : [];
  const noActive: NullReason[] = activeTrucks === 0 ? ['no_active_trucks'] : [];
  const zeroGross: NullReason[] = gross === 0 ? ['zero_gross'] : [];
  reasons.cost = [...noExpense];
  reasons.operatingProfit = [...noExpense];
  reasons.inactiveTruckLoss = [...noExpense];
  reasons.netOperatingProfit = [...noExpense];
  reasons.totalMiles = miles === null ? ['no_mileage_data'] : [];
  reasons.rpm = [...milesReason];
  reasons.cpm = [...noExpense, ...milesReason];
  reasons.ppm = [...noExpense, ...milesReason];
  reasons.marginPct = [...noExpense, ...zeroGross];
  reasons.avgGrossPerTruck = [...noActive];
  reasons.avgCostPerTruck = [...noExpense, ...noActive];
  reasons.avgProfitPerTruck = [...noExpense, ...noActive];
  reasons.avgMilesPerTruck = [...(miles === null ? milesReason : []), ...noActive];

  return {
    gross,
    cost,
    costEstimated,
    costBreakdown,
    operatingProfit,
    inactiveTruckLoss,
    inactiveTruckRows,
    netOperatingProfit,
    totalMiles: miles,
    milesSource,
    rpm,
    cpm,
    ppm,
    marginPct,
    activeTrucks,
    inactiveTrucks: inactiveFleet.length,
    avgGrossPerTruck,
    avgCostPerTruck,
    avgProfitPerTruck,
    avgMilesPerTruck,
    averagesBasis: 'active_trucks',
    hasExpenseData: expenseKnown,
    reasons,
  };
}

/** Output precision per metric so deltas round the same way as the values they compare. */
const METRIC_ROUNDING: Record<FinancialMetricKey, (value: number) => number> = {
  gross: roundMoney,
  cost: roundMoney,
  costEstimated: roundMoney,
  operatingProfit: roundMoney,
  inactiveTruckLoss: roundMoney,
  netOperatingProfit: roundMoney,
  totalMiles: roundRatio,
  rpm: roundRatio,
  cpm: roundRatio,
  ppm: roundRatio,
  marginPct: roundPct,
  activeTrucks: (value) => Math.round(value),
  inactiveTrucks: (value) => Math.round(value),
  avgGrossPerTruck: roundMoney,
  avgCostPerTruck: roundMoney,
  avgProfitPerTruck: roundMoney,
  avgMilesPerTruck: roundRatio,
};

/** Compares one metric: `delta = value - previous`, `deltaPct = delta / |previous| * 100`. */
export function compareMetric(
  value: number | null,
  previous: number | null,
  round: (v: number) => number = roundMoney,
): ComparedMetric {
  const rawDelta = subtract(value, previous);
  const delta = roundNullable(rawDelta, round);
  const deltaPct =
    rawDelta === null || previous === null || previous === 0
      ? null
      : pct(rawDelta, Math.abs(previous));
  return { value, previous, delta, deltaPct };
}

/** Compares every financial metric of the current period against the comparison period. */
export function compareFinancials(
  current: FinancialResult,
  previous: FinancialResult | null,
): ComparedFinancials {
  const compared = {} as ComparedFinancials;
  for (const key of FINANCIAL_METRIC_KEYS) {
    compared[key] = compareMetric(
      current[key],
      previous ? previous[key] : null,
      METRIC_ROUNDING[key],
    );
  }
  return compared;
}
