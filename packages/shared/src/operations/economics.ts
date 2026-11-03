/**
 * Load economics on **total** miles.
 *
 * The load record already carries a cost breakdown, but those lines are built against loaded miles
 * only — deadhead is stored and never costed. That flatters every load and flatters the ones with
 * the worst repositioning most, which is exactly backwards: a $3.00/mi load with 250 deadhead miles
 * can lose to a $2.50/mi load with 20. This engine restates the load on the miles the truck
 * actually turns.
 *
 * Honesty rules (docs/DASHBOARD.md §4 applies here too):
 *  - A missing input yields `null`, never `0`, and names itself in `insufficient`.
 *  - The deadhead figure is an **estimate** derived from the load's own per-mile costs; it says so
 *    in `reasons` and sets `estimated`, so nobody mistakes it for a booked cost.
 */

export interface LoadCostLines {
  fuel: number;
  driverPay: number;
  tolls: number;
  maintenanceAllocation: number;
  other: number;
}

export interface LoadEconomicsInput {
  revenue: number | null;
  loadedMiles: number | null;
  emptyMiles: number | null;
  /** The load's booked cost lines, all accrued against loaded miles. */
  costs: LoadCostLines | null;
}

export interface LoadEconomics {
  revenue: number | null;
  loadedMiles: number | null;
  emptyMiles: number | null;
  totalMiles: number | null;
  /** Deadhead as a share of total miles. */
  deadheadPct: number | null;
  /** The load's booked cost, as recorded. */
  bookedCost: number | null;
  /** Estimated cost of running the empty miles. Null when it cannot be derived. */
  deadheadCost: number | null;
  /** Booked plus deadhead. */
  totalCost: number | null;
  revenuePerLoadedMile: number | null;
  revenuePerTotalMile: number | null;
  costPerTotalMile: number | null;
  profit: number | null;
  profitPerTotalMile: number | null;
  marginPct: number | null;
  /** True when any figure leans on the deadhead estimate. */
  estimated: boolean;
  /** How each derived number was reached. */
  reasons: string[];
  /** Inputs that were missing, named so the UI can say what it needs. */
  insufficient: string[];
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function divide(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

const EMPTY: LoadEconomics = {
  revenue: null,
  loadedMiles: null,
  emptyMiles: null,
  totalMiles: null,
  deadheadPct: null,
  bookedCost: null,
  deadheadCost: null,
  totalCost: null,
  revenuePerLoadedMile: null,
  revenuePerTotalMile: null,
  costPerTotalMile: null,
  profit: null,
  profitPerTotalMile: null,
  marginPct: null,
  estimated: false,
  reasons: [],
  insufficient: [],
};

/**
 * Restates a load on total miles.
 *
 * Deadhead is costed at the load's own *running* rate — fuel, driver pay and maintenance per
 * loaded mile. Tolls and miscellaneous trip costs are deliberately excluded from that rate: they
 * are incurred by the routed trip, not by distance, so scaling them onto repositioning miles would
 * invent cost. The basis is stated in `reasons` on every result that uses it.
 */
export function computeLoadEconomics(input: LoadEconomicsInput): LoadEconomics {
  const reasons: string[] = [];
  const insufficient: string[] = [];

  const revenue = input.revenue ?? null;
  const loadedMiles = input.loadedMiles ?? null;
  const emptyMiles = input.emptyMiles ?? null;

  if (revenue === null) insufficient.push('revenue');
  if (loadedMiles === null) insufficient.push('loaded miles');
  if (emptyMiles === null) insufficient.push('deadhead miles');
  if (input.costs === null) insufficient.push('cost breakdown');

  if (loadedMiles === null || emptyMiles === null) {
    return {
      ...EMPTY,
      revenue,
      loadedMiles,
      emptyMiles,
      reasons: ['Total miles cannot be established, so this load cannot be restated'],
      insufficient,
    };
  }

  const totalMiles = loadedMiles + emptyMiles;
  const deadheadPct = totalMiles > 0 ? round((emptyMiles / totalMiles) * 100, 1) : null;

  let bookedCost: number | null = null;
  let deadheadCost: number | null = null;
  let estimated = false;

  if (input.costs) {
    const c = input.costs;
    bookedCost = round(c.fuel + c.driverPay + c.tolls + c.maintenanceAllocation + c.other, 2);

    if (loadedMiles > 0) {
      const runningRate = (c.fuel + c.driverPay + c.maintenanceAllocation) / loadedMiles;
      deadheadCost = round(runningRate * emptyMiles, 2);
      if (emptyMiles > 0) {
        estimated = true;
        reasons.push(
          `Deadhead costed at $${round(runningRate, 3)}/mi (fuel, driver pay and maintenance per loaded mile) across ${emptyMiles} empty miles`,
        );
      }
    } else {
      insufficient.push('a per-mile basis for deadhead (no loaded miles)');
      reasons.push('No loaded miles, so no per-mile rate exists to cost the deadhead');
    }
  }

  const totalCost =
    bookedCost === null
      ? null
      : deadheadCost === null
        ? bookedCost
        : round(bookedCost + deadheadCost, 2);

  const revenuePerLoadedMile = loadedMiles > 0 ? divide(revenue, loadedMiles) : null;
  const revenuePerTotalMile = totalMiles > 0 ? divide(revenue, totalMiles) : null;
  const costPerTotalMile = totalMiles > 0 ? divide(totalCost, totalMiles) : null;
  const profit = revenue === null || totalCost === null ? null : round(revenue - totalCost, 2);
  const profitPerTotalMile = totalMiles > 0 ? divide(profit, totalMiles) : null;
  const marginPct =
    profit === null || revenue === null || revenue === 0
      ? null
      : round((profit / revenue) * 100, 1);

  if (revenuePerTotalMile !== null && revenuePerLoadedMile !== null && emptyMiles > 0) {
    reasons.push(
      `Revenue per mile falls from $${round(revenuePerLoadedMile, 2)} loaded to $${round(revenuePerTotalMile, 2)} once ${emptyMiles} empty miles are counted`,
    );
  }
  if (revenue === null) reasons.push('Revenue is not recorded, so profit cannot be stated');
  if (input.costs === null)
    reasons.push('No cost breakdown on this load, so cost per mile is unknown');

  return {
    revenue,
    loadedMiles,
    emptyMiles,
    totalMiles,
    deadheadPct,
    bookedCost,
    deadheadCost,
    totalCost,
    revenuePerLoadedMile: revenuePerLoadedMile === null ? null : round(revenuePerLoadedMile, 2),
    revenuePerTotalMile: revenuePerTotalMile === null ? null : round(revenuePerTotalMile, 2),
    costPerTotalMile: costPerTotalMile === null ? null : round(costPerTotalMile, 2),
    profit,
    profitPerTotalMile: profitPerTotalMile === null ? null : round(profitPerTotalMile, 2),
    marginPct,
    estimated,
    reasons,
    insufficient,
  };
}

/** Loads under this margin are surfaced by the attention queue as a financial exception. */
export const DEFAULT_TARGET_MARGIN_PCT = 15;

/** Deadhead above this share of total miles is treated as an exception worth looking at. */
export const DEFAULT_HIGH_DEADHEAD_PCT = 15;
