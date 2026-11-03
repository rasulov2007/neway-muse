/**
 * Fuel analytics engine (docs/DASHBOARD.md §7).
 *
 * Pure function over normalized fuel transactions: totals, by truck, by driver, by state. Money
 * is rounded to cents, price per gallon to three decimals, and every ratio is null-safe: a ratio
 * whose denominator is missing or zero is `null` with a reason instead of NaN/Infinity.
 */
import type { FuelTransactionFact, ReportingFacts } from '../facts';

export type FuelSortDirection = 'asc' | 'desc';

/**
 * Totals are DIESEL ONLY (owner, 2026-10-25): DEF is its own cost line and is reported beside them
 * in `def`, never blended into gallons or $/gal - a gallon of DEF at $5 pulled the fleet's diesel
 * price down and its gallons up.
 */
export interface FuelTotals {
  fillUps: number;
  gallons: number;
  discountedCost: number;
  grossCost: number;
  /** Discounted diesel cost ÷ diesel gallons; null when there are no gallons. */
  avgPricePerGallon: number | null;
  /** Discounted diesel cost ÷ total miles; null when miles are unknown or zero. */
  fuelCostPerMile: number | null;
  /** Why a ratio above is null (empty when every ratio resolved). */
  reasons: string[];
  /** DEF purchases, apart from diesel. */
  def: { fillUps: number; gallons: number; cost: number };
}

export interface FuelByTruckRow {
  /** Null groups transactions that were not tied to a truck. */
  truckId: string | null;
  unitNumber: string | null;
  fillUps: number;
  /** Diesel only. */
  gallons: number;
  /** Diesel only. */
  cost: number;
  /** Share of the discounted diesel cost, in percent (0 when total cost is 0). */
  sharePct: number;
  /** DEF bought for this truck, apart from diesel. */
  defCost?: number;
  defGallons?: number;
}

/** Whether a card row is DEF rather than diesel; anything not marked DEF reads as diesel. */
export function isDefFuel(row: Pick<FuelTransactionFact, 'product'>): boolean {
  return (row.product ?? '').trim().toLowerCase() === 'def';
}

export interface FuelByDriverRow {
  /** Null groups transactions that were not tied to a driver. */
  driverId: string | null;
  name: string | null;
  fillUps: number;
  gallons: number;
  cost: number;
  sharePct: number;
}

export interface FuelByStateRow {
  state: string;
  fillUps: number;
  gallons: number;
  cost: number;
  avgPricePerGallon: number | null;
}

export type FuelByStateSortKey = keyof FuelByStateRow;

export interface FuelResult {
  totals: FuelTotals;
  byTruck: FuelByTruckRow[];
  byDriver: FuelByDriverRow[];
  /** Default order: average $/gal descending (see `sortFuelByState`). */
  byState: FuelByStateRow[];
}

/** The subset of facts the fuel engine reads. */
export type FuelFacts = Pick<ReportingFacts, 'fuel' | 'trucks' | 'drivers'>;

interface Accumulator {
  fillUps: number;
  gallons: number;
  cost: number;
  grossCost: number;
}

/** Rounds to cents without producing -0 or NaN. */
export function roundCents(value: number): number {
  return safeRound(value, 100);
}

/** Rounds a $/gal price to three decimals. */
export function roundPrice(value: number): number {
  return safeRound(value, 1000);
}

function safeRound(value: number, factor: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/** Division that returns null instead of NaN/Infinity when the denominator is unusable. */
function ratio(numerator: number, denominator: number | null): number | null {
  if (denominator === null || !Number.isFinite(denominator) || denominator === 0) return null;
  if (!Number.isFinite(numerator)) return null;
  return numerator / denominator;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function emptyAccumulator(): Accumulator {
  return { fillUps: 0, gallons: 0, cost: 0, grossCost: 0 };
}

function accumulate<K>(
  rows: readonly FuelTransactionFact[],
  keyOf: (row: FuelTransactionFact) => K,
): Map<K, Accumulator> {
  const groups = new Map<K, Accumulator>();
  for (const row of rows) {
    const key = keyOf(row);
    const acc = groups.get(key) ?? emptyAccumulator();
    acc.fillUps += 1;
    acc.gallons += finite(row.gallons);
    acc.cost += finite(row.discountedCost);
    acc.grossCost += finite(row.grossCost);
    groups.set(key, acc);
  }
  return groups;
}

function sharePct(cost: number, totalCost: number): number {
  const pct = ratio(cost * 100, totalCost);
  return pct === null ? 0 : roundCents(pct);
}

function compareText(a: string | number | null, b: string | number | null): number {
  return String(a ?? '').localeCompare(String(b ?? ''));
}

/** Computes §7 fuel analytics for the facts' fuel transactions; `totalMiles` feeds cost per mile. */
export function computeFuelAnalytics(facts: FuelFacts, totalMiles: number | null): FuelResult {
  const rows = facts.fuel.filter((row) => !isDefFuel(row));
  const defRows = facts.fuel.filter(isDefFuel);
  const all = accumulate(rows, () => 'all').get('all') ?? emptyAccumulator();
  const defAll = accumulate(defRows, () => 'all').get('all') ?? emptyAccumulator();
  const defByTruck = accumulate(defRows, (r) => r.truckId);

  const reasons: string[] = [];
  const avgPricePerGallon = ratio(all.cost, all.gallons);
  if (avgPricePerGallon === null) reasons.push('No gallons recorded in the period.');
  const fuelCostPerMile = ratio(all.cost, totalMiles);
  if (fuelCostPerMile === null) {
    reasons.push(
      totalMiles === null ? 'Total miles are unknown for the period.' : 'Total miles are zero.',
    );
  }

  const totals: FuelTotals = {
    fillUps: all.fillUps,
    gallons: roundCents(all.gallons),
    discountedCost: roundCents(all.cost),
    grossCost: roundCents(all.grossCost),
    avgPricePerGallon: avgPricePerGallon === null ? null : roundPrice(avgPricePerGallon),
    fuelCostPerMile: fuelCostPerMile === null ? null : roundPrice(fuelCostPerMile),
    reasons,
    def: {
      fillUps: defAll.fillUps,
      gallons: roundCents(defAll.gallons),
      cost: roundCents(defAll.cost),
    },
  };

  const unitByTruck = new Map(facts.trucks.map((t) => [t.truckId, t.unitNumber]));
  const dieselByTruck = accumulate(rows, (r) => r.truckId);
  const truckKeys = new Set<string | null>([...dieselByTruck.keys(), ...defByTruck.keys()]);
  const byTruck: FuelByTruckRow[] = [...truckKeys]
    .map((truckId) => {
      const acc = dieselByTruck.get(truckId) ?? emptyAccumulator();
      const def = defByTruck.get(truckId);
      return {
        truckId,
        unitNumber: truckId === null ? null : (unitByTruck.get(truckId) ?? null),
        fillUps: acc.fillUps,
        gallons: roundCents(acc.gallons),
        cost: roundCents(acc.cost),
        sharePct: sharePct(acc.cost, all.cost),
        ...(defRows.length > 0
          ? { defCost: roundCents(def?.cost ?? 0), defGallons: roundCents(def?.gallons ?? 0) }
          : {}),
      };
    })
    .sort((a, b) => b.cost - a.cost || compareText(a.unitNumber, b.unitNumber));

  const nameByDriver = new Map(facts.drivers.map((d) => [d.driverId, d.name]));
  const byDriver: FuelByDriverRow[] = [...accumulate(rows, (r) => r.driverId)]
    .map(([driverId, acc]) => ({
      driverId,
      name: driverId === null ? null : (nameByDriver.get(driverId) ?? null),
      fillUps: acc.fillUps,
      gallons: roundCents(acc.gallons),
      cost: roundCents(acc.cost),
      sharePct: sharePct(acc.cost, all.cost),
    }))
    .sort((a, b) => b.cost - a.cost || compareText(a.name, b.name));

  const byState: FuelByStateRow[] = [...accumulate(rows, (r) => r.state.toUpperCase())].map(
    ([state, acc]) => {
      const price = ratio(acc.cost, acc.gallons);
      return {
        state,
        fillUps: acc.fillUps,
        gallons: roundCents(acc.gallons),
        cost: roundCents(acc.cost),
        avgPricePerGallon: price === null ? null : roundPrice(price),
      };
    },
  );

  return {
    totals,
    byTruck,
    byDriver,
    byState: sortFuelByState(byState, 'avgPricePerGallon', 'desc'),
  };
}

/** Returns a sorted copy of by-state rows; null prices always sort last, ties break by state. */
export function sortFuelByState(
  rows: readonly FuelByStateRow[],
  key: FuelByStateSortKey,
  dir: FuelSortDirection,
): FuelByStateRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === null && bv === null) return compareText(a.state, b.state);
    if (av === null) return 1;
    if (bv === null) return -1;
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : compareText(av, bv);
    return cmp !== 0 ? sign * cmp : compareText(a.state, b.state);
  });
}
