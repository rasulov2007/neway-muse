/**
 * Fuel economics from the transactions themselves.
 *
 * Every figure here is arithmetic on recorded fills. Nothing is assumed and nothing is carried over
 * from a vendor's own MPG claim.
 *
 * The one figure that needs care is MPG. A fill tells you gallons and an odometer reading, not
 * distance; distance only exists **between** two fills on the same unit. So MPG is computed per
 * consecutive pair — miles travelled since the previous fill divided by the gallons that previous
 * fill put in the tank — and a unit with a single fill has no MPG at all rather than a made-up one.
 *
 * Honesty rules:
 *  - Fewer than two diesel fills on a unit yields `mpg: null`, and the unit is named in
 *    `unitsWithoutMpg`.
 *  - DEF fills are excluded from MPG and from cost-per-mile, because DEF is not what moves the
 *    truck; they stay in total spend, which is what the money actually left the account for.
 *  - A pair whose odometer goes backwards or jumps implausibly far is dropped and counted in
 *    `discardedPairs`, never silently averaged in.
 */

export interface FuelFill {
  id: string;
  truckId: string;
  /** ISO timestamp of the fill. */
  at: string;
  product: 'diesel' | 'def' | string;
  gallons: number;
  pricePerGallon: number;
  amount: number;
  /** Odometer at the pump. Zero or missing means the driver did not enter one. */
  odometer?: number | null;
}

export interface FuelSummary {
  /** Total money spent across every fill in the window, diesel and DEF alike. */
  spend: number;
  /** Diesel gallons. */
  gallons: number;
  /** Weighted average price actually paid per diesel gallon. Null with no diesel gallons. */
  avgPricePerGallon: number | null;
  /** Fleet MPG: total measured miles over total gallons that produced them. Null when unmeasurable. */
  avgMpg: number | null;
  /** Diesel spend over measured miles. Null when no miles could be measured. */
  costPerMile: number | null;
  /** Miles the fill pairs actually measured. */
  measuredMiles: number;
  /** Distinct units that bought fuel in the window. */
  unitsFuelled: number;
  /** Spend divided by units fuelled. Null with no units. */
  spendPerUnit: number | null;
  transactions: number;
  /** Truck ids that bought diesel but could not produce a single usable pair. */
  unitsWithoutMpg: string[];
  /** Pairs rejected as implausible, so the caller can show the data-quality cost. */
  discardedPairs: number;
}

export interface UnitFuelSummary {
  truckId: string;
  spend: number;
  gallons: number;
  avgPricePerGallon: number | null;
  mpg: number | null;
  costPerMile: number | null;
  measuredMiles: number;
  transactions: number;
}

/** A pair spanning more than this many miles is a bad odometer entry, not a long run. */
const MAX_PLAUSIBLE_PAIR_MILES = 3000;

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

interface PairTotals {
  miles: number;
  gallons: number;
  discarded: number;
}

/**
 * Miles and gallons that can be honestly paired for one unit's diesel fills.
 *
 * The gallons charged to a pair are the gallons from the **earlier** fill, because those are what
 * the truck burned covering the distance to the later one.
 */
function pairTotals(fills: FuelFill[]): PairTotals {
  const usable = fills
    .filter((f) => f.product === 'diesel' && typeof f.odometer === 'number' && f.odometer > 0)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  let miles = 0;
  let gallons = 0;
  let discarded = 0;

  for (let i = 1; i < usable.length; i += 1) {
    const previous = usable[i - 1];
    const current = usable[i];
    if (!previous || !current) continue;
    const delta = (current.odometer as number) - (previous.odometer as number);
    if (delta <= 0 || delta > MAX_PLAUSIBLE_PAIR_MILES || previous.gallons <= 0) {
      discarded += 1;
      continue;
    }
    miles += delta;
    gallons += previous.gallons;
  }

  return { miles, gallons, discarded };
}

export function summarizeUnitFuel(truckId: string, fills: FuelFill[]): UnitFuelSummary {
  const spend = fills.reduce((sum, f) => sum + f.amount, 0);
  const diesel = fills.filter((f) => f.product === 'diesel');
  const gallons = diesel.reduce((sum, f) => sum + f.gallons, 0);
  const dieselSpend = diesel.reduce((sum, f) => sum + f.amount, 0);
  const { miles, gallons: pairedGallons } = pairTotals(fills);

  return {
    truckId,
    spend: round(spend, 2),
    gallons: round(gallons, 1),
    avgPricePerGallon: gallons > 0 ? round(dieselSpend / gallons, 3) : null,
    mpg: miles > 0 && pairedGallons > 0 ? round(miles / pairedGallons, 2) : null,
    costPerMile:
      miles > 0 && gallons > 0 ? round((dieselSpend / gallons) * (pairedGallons / miles), 3) : null,
    measuredMiles: miles,
    transactions: fills.length,
  };
}

export function summarizeFuel(fills: FuelFill[]): FuelSummary {
  const byUnit = new Map<string, FuelFill[]>();
  for (const fill of fills) {
    const bucket = byUnit.get(fill.truckId);
    if (bucket) bucket.push(fill);
    else byUnit.set(fill.truckId, [fill]);
  }

  const spend = fills.reduce((sum, f) => sum + f.amount, 0);
  const diesel = fills.filter((f) => f.product === 'diesel');
  const gallons = diesel.reduce((sum, f) => sum + f.gallons, 0);
  const dieselSpend = diesel.reduce((sum, f) => sum + f.amount, 0);

  let miles = 0;
  let pairedGallons = 0;
  let discardedPairs = 0;
  const unitsWithoutMpg: string[] = [];

  for (const [truckId, unitFills] of byUnit) {
    const totals = pairTotals(unitFills);
    miles += totals.miles;
    pairedGallons += totals.gallons;
    discardedPairs += totals.discarded;
    if (totals.miles === 0 && unitFills.some((f) => f.product === 'diesel')) {
      unitsWithoutMpg.push(truckId);
    }
  }

  const avgPrice = gallons > 0 ? dieselSpend / gallons : null;

  return {
    spend: round(spend, 2),
    gallons: round(gallons, 1),
    avgPricePerGallon: avgPrice === null ? null : round(avgPrice, 3),
    avgMpg: miles > 0 && pairedGallons > 0 ? round(miles / pairedGallons, 2) : null,
    // Cost per mile priced at what the fleet actually paid per gallon, on the gallons that
    // demonstrably produced the measured miles.
    costPerMile:
      miles > 0 && avgPrice !== null ? round((avgPrice * pairedGallons) / miles, 3) : null,
    measuredMiles: miles,
    unitsFuelled: byUnit.size,
    spendPerUnit: byUnit.size > 0 ? round(spend / byUnit.size, 2) : null,
    transactions: fills.length,
    unitsWithoutMpg: unitsWithoutMpg.sort(),
    discardedPairs,
  };
}
