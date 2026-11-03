/**
 * What a single unit earned and what it cost to run it.
 *
 * Every load is restated through `computeLoadEconomics` first, so the deadhead the unit actually
 * turned is priced before it is rolled up. A truck that runs 200 empty miles to every load is not
 * allowed to look identical to one that runs 20.
 *
 * Honesty rules:
 *  - A load whose revenue or miles are missing contributes nothing and is counted in
 *    `coverage.priced`, so the caller can say "based on 8 of 11 loads" rather than implying all 11.
 *  - Zero priced loads yields nulls throughout, never zeros.
 *  - Cancelled loads never contribute money. They are counted separately because a unit sitting
 *    through cancellations is a real operational fact.
 */

import { computeLoadEconomics, type LoadCostLines } from '../operations/economics.js';

export interface UnitLoad {
  id: string;
  status: string;
  revenue: number | null;
  loadedMiles: number | null;
  emptyMiles: number | null;
  costs: LoadCostLines | null;
}

export interface UnitEconomics {
  revenue: number | null;
  cost: number | null;
  profit: number | null;
  marginPct: number | null;
  totalMiles: number | null;
  revenuePerMile: number | null;
  profitPerMile: number | null;
  deadheadPct: number | null;
  /** True when any figure leans on an estimated deadhead cost. */
  estimated: boolean;
  coverage: {
    /** Loads considered, cancellations excluded. */
    loads: number;
    /** Of those, how many carried enough detail to price. */
    priced: number;
    cancelled: number;
  };
}

const CANCELLED = new Set(['cancelled', 'canceled', 'void']);

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function summarizeUnitEconomics(loads: UnitLoad[]): UnitEconomics {
  const cancelled = loads.filter((l) => CANCELLED.has(l.status.toLowerCase()));
  const billable = loads.filter((l) => !CANCELLED.has(l.status.toLowerCase()));

  let revenue = 0;
  let cost = 0;
  let miles = 0;
  let emptyMiles = 0;
  let priced = 0;
  let estimated = false;

  for (const load of billable) {
    const economics = computeLoadEconomics({
      revenue: load.revenue,
      loadedMiles: load.loadedMiles,
      emptyMiles: load.emptyMiles,
      costs: load.costs,
    });
    if (
      economics.revenue === null ||
      economics.totalCost === null ||
      economics.totalMiles === null
    ) {
      continue;
    }
    revenue += economics.revenue;
    cost += economics.totalCost;
    miles += economics.totalMiles;
    emptyMiles += economics.emptyMiles ?? 0;
    priced += 1;
    if (economics.estimated) estimated = true;
  }

  const coverage = { loads: billable.length, priced, cancelled: cancelled.length };

  if (priced === 0) {
    return {
      revenue: null,
      cost: null,
      profit: null,
      marginPct: null,
      totalMiles: null,
      revenuePerMile: null,
      profitPerMile: null,
      deadheadPct: null,
      estimated: false,
      coverage,
    };
  }

  const profit = revenue - cost;
  return {
    revenue: round(revenue, 2),
    cost: round(cost, 2),
    profit: round(profit, 2),
    marginPct: revenue > 0 ? round((profit / revenue) * 100, 1) : null,
    totalMiles: Math.round(miles),
    revenuePerMile: miles > 0 ? round(revenue / miles, 2) : null,
    profitPerMile: miles > 0 ? round(profit / miles, 2) : null,
    deadheadPct: miles > 0 ? round((emptyMiles / miles) * 100, 1) : null,
    estimated,
    coverage,
  };
}
