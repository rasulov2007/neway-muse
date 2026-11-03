import type {
  DriverFact,
  DriverPayType,
  ExpenseCategory,
  ReportingFacts,
  TruckFact,
} from '../facts';
import { computeFinancials, revenueOf, totalMiles as periodMiles } from './financial-calculator';
import { pct, roundMoney, roundRatio, safeDivide, sum } from './money';
import {
  OPS_NET_BUCKET_KEYS,
  type NullReason,
  type OpsNetBucket,
  type OpsNetBucketKey,
  type OpsNetCategory,
  type OpsNetCostBreakdown,
  type OpsNetResult,
  opsNetCategory,
  type OpsNetTotalsRow,
  type UnknownPayTypeDriver,
} from './types';

/** Every expense category, in the order the ops-net table renders them. */
const EXPENSE_CATEGORIES: readonly OpsNetCategory[] = [
  'fuel',
  'insurance',
  'maintenance',
  'tolls',
  'repairs',
  'dispatch_fee',
  'factoring',
  'driver_pay',
  'staff_payroll',
  'other',
];

interface BucketAccumulator {
  gross: number;
  loads: number;
  fuel: number;
  insurance: number;
  factoring: number;
  driverPay: number;
  driverPayEstimated: number;
  other: number;
  /** Only categories with at least one line; an absent key renders as a dash, not a zero. */
  categories: Map<ExpenseCategory, number>;
  miles: number;
  activeTrucks: number;
  driverIds: Set<string>;
}

/** Creates an all-zero accumulator for one bucket. */
function emptyAccumulator(): BucketAccumulator {
  return {
    gross: 0,
    loads: 0,
    fuel: 0,
    insurance: 0,
    factoring: 0,
    driverPay: 0,
    driverPayEstimated: 0,
    other: 0,
    categories: new Map<ExpenseCategory, number>(),
    miles: 0,
    activeTrucks: 0,
    driverIds: new Set<string>(),
  };
}

/**
 * Resolves the driver a line belongs to: its own `driverId`, else the current driver of its
 * truck, else none. Returns the driver id (possibly one not in `drivers`) or null.
 */
export function resolveLineDriver(
  line: { driverId: string | null; truckId: string | null },
  trucks: ReadonlyMap<string, TruckFact>,
): string | null {
  if (line.driverId !== null) return line.driverId;
  if (line.truckId !== null) return trucks.get(line.truckId)?.driverId ?? null;
  return null;
}

/** Maps a driver id to its ops-net bucket; unknown drivers and null pay types go to `unknown`. */
export function bucketForDriver(
  driverId: string | null,
  drivers: ReadonlyMap<string, DriverFact>,
): OpsNetBucketKey {
  if (driverId === null) return 'unknown';
  const payType: DriverPayType | null = drivers.get(driverId)?.payType ?? null;
  return payType ?? 'unknown';
}

/** Indexes facts by id for O(1) allocation lookups. */
export function indexFacts(facts: ReportingFacts): {
  trucks: Map<string, TruckFact>;
  drivers: Map<string, DriverFact>;
} {
  return {
    trucks: new Map(facts.trucks.map((truck) => [truck.truckId, truck])),
    drivers: new Map(facts.drivers.map((driver) => [driver.driverId, driver])),
  };
}

/** A record with one entry per bucket key, all starting at zero. */
function zeroCounts(): Record<OpsNetBucketKey, number> {
  const counts = {} as Record<OpsNetBucketKey, number>;
  for (const key of OPS_NET_BUCKET_KEYS) counts[key] = 0;
  return counts;
}

/**
 * Assigns each active truck (gross > 0, matching `computeFinancials`) to exactly one bucket: the
 * pay type that earned the most of its revenue in the period, resolved per line as driver →
 * truck's current driver → unknown. Ties fall to the first bucket in `OPS_NET_BUCKET_KEYS`.
 * Counting each truck once is what makes the per-bucket counts sum to the fleet's active trucks.
 */
export function assignTrucksToBuckets(
  facts: ReportingFacts,
  trucks: ReadonlyMap<string, TruckFact>,
  drivers: ReadonlyMap<string, DriverFact>,
): Map<string, OpsNetBucketKey> {
  const perTruck = new Map<string, Map<OpsNetBucketKey, number>>();
  for (const line of facts.revenue) {
    if (line.truckId === null) continue;
    const key = bucketForDriver(resolveLineDriver(line, trucks), drivers);
    const byBucket = perTruck.get(line.truckId) ?? new Map<OpsNetBucketKey, number>();
    byBucket.set(key, (byBucket.get(key) ?? 0) + revenueOf(line));
    perTruck.set(line.truckId, byBucket);
  }
  const assignment = new Map<string, OpsNetBucketKey>();
  for (const [truckId, byBucket] of perTruck) {
    if (sum([...byBucket.values()]) <= 0) continue;
    let best: OpsNetBucketKey | null = null;
    let bestGross = Number.NEGATIVE_INFINITY;
    for (const key of OPS_NET_BUCKET_KEYS) {
      const gross = byBucket.get(key);
      if (gross !== undefined && gross > bestGross) {
        best = key;
        bestGross = gross;
      }
    }
    if (best !== null) assignment.set(truckId, best);
  }
  return assignment;
}

/**
 * Active trucks split by the driver's pay type, each truck counted once so the values sum to
 * `computeFinancials(facts).activeTrucks`. Null when the period has no revenue at all, because
 * "which pay type was driving" is then unknown rather than zero.
 */
export function activeTrucksByPayType(
  facts: ReportingFacts,
): Record<OpsNetBucketKey, number> | null {
  if (facts.revenue.length === 0) return null;
  const { trucks, drivers } = indexFacts(facts);
  const counts = zeroCounts();
  for (const key of assignTrucksToBuckets(facts, trucks, drivers).values()) counts[key] += 1;
  return counts;
}

/** Reads a category total, or null when the bucket has no line in that category. */
function categoryValue(
  categories: ReadonlyMap<ExpenseCategory, number>,
  category: ExpenseCategory,
  expenseKnown: boolean,
): number | null {
  if (!expenseKnown) return null;
  const amount = categories.get(category);
  return amount === undefined ? null : roundMoney(amount);
}

/** Builds the nine-category breakdown for one accumulator. */
function buildCosts(
  categories: ReadonlyMap<ExpenseCategory, number>,
  expenseKnown: boolean,
): OpsNetCostBreakdown {
  const costs = {} as OpsNetCostBreakdown;
  for (const category of EXPENSE_CATEGORIES) {
    costs[category] = categoryValue(categories, category, expenseKnown);
  }
  return costs;
}

/** Shapes one accumulator into a bucket row (minus its key), applying every honesty rule. */
function toRow(
  acc: BucketAccumulator,
  options: { expenseKnown: boolean; hasMiles: boolean; driverCount: number },
): OpsNetTotalsRow {
  const { expenseKnown, hasMiles, driverCount } = options;
  const money = (value: number): number | null => (expenseKnown ? roundMoney(value) : null);
  const gross = roundMoney(acc.gross);
  const rawCost = acc.fuel + acc.insurance + acc.factoring + acc.driverPay + acc.other;
  const totalCost = money(rawCost);
  const operatingProfit = totalCost === null ? null : roundMoney(gross - totalCost);
  const marginPct = gross === 0 ? null : pct(operatingProfit, gross);

  const miles = hasMiles ? roundRatio(acc.miles) : null;
  const milesUsable = miles !== null && miles > 0 ? miles : null;
  const activeDivisor = acc.activeTrucks === 0 ? null : acc.activeTrucks;

  const reasons: NullReason[] = expenseKnown ? [] : ['no_expense_data'];
  if (marginPct === null && gross === 0) reasons.push('zero_gross');

  return {
    gross,
    loads: acc.loads,
    costs: buildCosts(acc.categories, expenseKnown),
    fuel: money(acc.fuel),
    insurance: money(acc.insurance),
    factoring: money(acc.factoring),
    driverPay: money(acc.driverPay),
    driverPayEstimated: money(acc.driverPayEstimated),
    other: money(acc.other),
    totalCost,
    operatingProfit,
    marginPct,
    driverCount,
    rpm: nullableRatio(safeDivide(gross, milesUsable)),
    totalMiles: miles,
    activeTrucks: acc.activeTrucks,
    avgGrossPerTruck: nullableMoney(safeDivide(gross, activeDivisor)),
    avgMilesPerTruck: nullableRatio(safeDivide(miles, activeDivisor)),
    reasons,
  };
}

function nullableMoney(value: number | null): number | null {
  return value === null ? null : roundMoney(value);
}

function nullableRatio(value: number | null): number | null {
  return value === null ? null : roundRatio(value);
}

/** Folds `source` into `target`, so the totals row is built the same way as every bucket. */
function mergeAccumulator(target: BucketAccumulator, source: BucketAccumulator): void {
  target.gross += source.gross;
  target.loads += source.loads;
  target.fuel += source.fuel;
  target.insurance += source.insurance;
  target.factoring += source.factoring;
  target.driverPay += source.driverPay;
  target.driverPayEstimated += source.driverPayEstimated;
  target.other += source.other;
  target.miles += source.miles;
  target.activeTrucks += source.activeTrucks;
  for (const [category, amount] of source.categories) {
    target.categories.set(category, (target.categories.get(category) ?? 0) + amount);
  }
  for (const driverId of source.driverIds) target.driverIds.add(driverId);
}

/**
 * Computes ops net by driver pay type (docs/DASHBOARD.md §5). Nothing is dropped: money that
 * cannot be classified lands in the `unknown` bucket, and totals equal `computeFinancials`.
 */
export function computeOpsNet(facts: ReportingFacts): OpsNetResult {
  const financials = computeFinancials(facts);
  const expenseKnown = financials.hasExpenseData;
  const { trucks, drivers } = indexFacts(facts);

  const accumulators = new Map<OpsNetBucketKey, BucketAccumulator>();
  for (const key of OPS_NET_BUCKET_KEYS) accumulators.set(key, emptyAccumulator());
  const bucketOf = (key: OpsNetBucketKey): BucketAccumulator =>
    accumulators.get(key) ?? emptyAccumulator();

  for (const line of facts.revenue) {
    const driverId = resolveLineDriver(line, trucks);
    const bucket = bucketOf(bucketForDriver(driverId, drivers));
    bucket.gross += revenueOf(line);
    bucket.loads += 1;
    if (driverId !== null) bucket.driverIds.add(driverId);
  }

  for (const line of facts.expenses) {
    const driverId = resolveLineDriver(line, trucks);
    const bucket = bucketOf(bucketForDriver(driverId, drivers));
    if (driverId !== null) bucket.driverIds.add(driverId);
    const category = opsNetCategory(line.category);
    bucket.categories.set(category, (bucket.categories.get(category) ?? 0) + line.amount);
    switch (category) {
      case 'fuel':
        bucket.fuel += line.amount;
        break;
      case 'insurance':
        bucket.insurance += line.amount;
        break;
      case 'factoring':
        bucket.factoring += line.amount;
        break;
      case 'driver_pay':
        bucket.driverPay += line.amount;
        if (line.isEstimate) bucket.driverPayEstimated += line.amount;
        break;
      default:
        bucket.other += line.amount;
    }
  }

  // Miles use the period-wide source precedence of the financial engine (odometer records when
  // any exist, else load miles), so the bucket miles always add up to the headline total.
  const milesInfo = periodMiles(facts);
  if (milesInfo?.source === 'odometer') {
    for (const record of facts.mileage) {
      const driverId = resolveLineDriver(record, trucks);
      bucketOf(bucketForDriver(driverId, drivers)).miles += record.miles;
    }
  } else if (milesInfo?.source === 'loads') {
    for (const line of facts.revenue) {
      const driverId = resolveLineDriver(line, trucks);
      bucketOf(bucketForDriver(driverId, drivers)).miles += line.loadedMiles + line.emptyMiles;
    }
  }
  const hasMiles = milesInfo !== null;

  for (const key of assignTrucksToBuckets(facts, trucks, drivers).values()) {
    bucketOf(key).activeTrucks += 1;
  }

  const unknownDrivers: UnknownPayTypeDriver[] = facts.drivers
    .filter((driver) => driver.payType === null)
    .map((driver) => ({
      driverId: driver.driverId,
      name: driver.name,
      rawPayTag: driver.rawPayTag,
    }));

  const driverCountOf = (key: OpsNetBucketKey, acc: BucketAccumulator): number =>
    key === 'unknown'
      ? unknownDrivers.length
      : [...acc.driverIds].filter((id) => drivers.get(id)?.payType === key).length;

  const buckets: OpsNetBucket[] = OPS_NET_BUCKET_KEYS.map((key) => {
    const acc = bucketOf(key);
    return {
      key,
      ...toRow(acc, { expenseKnown, hasMiles, driverCount: driverCountOf(key, acc) }),
    };
  });

  const totalAcc = emptyAccumulator();
  let totalDriverCount = 0;
  for (const key of OPS_NET_BUCKET_KEYS) {
    const acc = bucketOf(key);
    mergeAccumulator(totalAcc, acc);
    totalDriverCount += driverCountOf(key, acc);
  }
  // Derived from the buckets themselves; equals computeFinancials because every line lands in
  // exactly one bucket, and each active truck in exactly one bucket.
  const totals = toRow(totalAcc, { expenseKnown, hasMiles, driverCount: totalDriverCount });

  const unknownBucket = buckets.find((bucket) => bucket.key === 'unknown');

  return {
    buckets,
    totals,
    inactiveTruckLoss: financials.inactiveTruckLoss,
    netOperatingProfit: financials.netOperatingProfit,
    unknown: {
      driverCount: unknownDrivers.length,
      gross: unknownBucket?.gross ?? 0,
      drivers: unknownDrivers,
    },
    hasExpenseData: expenseKnown,
  };
}
