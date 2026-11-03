import type { ReportingFacts } from '../facts';
import {
  costByTruck,
  fleetTrucks,
  grossByTruck,
  hasExpenseData,
  milesByTruck,
} from './financial-calculator';
import { roundMoney, roundRatio, safeDivide, sum } from './money';
import type { TruckPnlFilter, TruckPnlRow, TruckPnlSort, TruckPnlSummary } from './types';

const DEFAULT_VIEW_LIMIT = 5;

/**
 * Builds one P&L row per company truck, excluding `sold` (docs/DASHBOARD.md §6). Cost and profit
 * are null when the period has no expense data, in which case no inactive-loss rows exist.
 */
export function computeTruckPnl(facts: ReportingFacts): TruckPnlRow[] {
  const expenseKnown = hasExpenseData(facts);
  const gross = grossByTruck(facts);
  const cost = costByTruck(facts);
  const miles = milesByTruck(facts);
  const drivers = new Map(facts.drivers.map((driver) => [driver.driverId, driver]));
  const loadsByTruck = new Map<string, number>();
  for (const line of facts.revenue) {
    if (line.truckId === null) continue;
    loadsByTruck.set(line.truckId, (loadsByTruck.get(line.truckId) ?? 0) + 1);
  }

  return fleetTrucks(facts).map<TruckPnlRow>((truck) => {
    const truckGross = roundMoney(gross.get(truck.truckId) ?? 0);
    const truckCostEntry = cost.get(truck.truckId);
    const truckCost = expenseKnown ? roundMoney(truckCostEntry?.total ?? 0) : null;
    const truckCostEstimated = expenseKnown ? roundMoney(truckCostEntry?.estimated ?? 0) : null;
    const profit = truckCost === null ? null : roundMoney(truckGross - truckCost);
    const milesEntry = miles.get(truck.truckId);
    const truckMiles = milesEntry ? roundRatio(milesEntry.miles) : null;
    const driver = truck.driverId === null ? undefined : drivers.get(truck.driverId);
    const rpmRaw = safeDivide(
      truckGross,
      truckMiles !== null && truckMiles > 0 ? truckMiles : null,
    );
    return {
      truckId: truck.truckId,
      unitNumber: truck.unitNumber,
      status: truck.status,
      driverId: truck.driverId,
      driverName: driver?.name ?? truck.driverName,
      payType: driver?.payType ?? null,
      gross: truckGross,
      miles: truckMiles,
      loads: loadsByTruck.get(truck.truckId) ?? 0,
      cost: truckCost,
      costEstimated: truckCostEstimated,
      profit,
      rpm: rpmRaw === null ? null : roundRatio(rpmRaw),
      inactiveLoss: truckGross === 0 && truckCost !== null && truckCost > 0,
    };
  });
}

/** Applies search, driver type, status, unit, and quick-view filters (server-side). */
export function filterTruckPnl(
  rows: readonly TruckPnlRow[],
  filter: TruckPnlFilter,
): TruckPnlRow[] {
  let result = [...rows];
  const q = filter.q?.trim().toLowerCase();
  if (q) {
    result = result.filter(
      (row) =>
        row.unitNumber.toLowerCase().includes(q) ||
        (row.driverName?.toLowerCase().includes(q) ?? false),
    );
  }
  if (filter.payType !== undefined) {
    const wanted = filter.payType === 'unknown' ? null : filter.payType;
    result = result.filter((row) => row.payType === wanted);
  }
  if (filter.status !== undefined) {
    result = result.filter((row) => row.status === filter.status);
  }
  if (filter.unit !== undefined) {
    const unit = filter.unit.trim().toLowerCase();
    result = result.filter((row) => row.unitNumber.toLowerCase() === unit);
  }
  const limit = Math.max(1, Math.floor(filter.limit ?? DEFAULT_VIEW_LIMIT));
  switch (filter.view) {
    case 'best':
      return sortTruckPnl(
        result.filter((row) => row.profit !== null),
        { field: 'profit', direction: 'desc' },
      ).slice(0, limit);
    case 'worst':
      return sortTruckPnl(
        result.filter((row) => row.profit !== null),
        { field: 'profit', direction: 'asc' },
      ).slice(0, limit);
    case 'inactive':
      return result.filter((row) => row.inactiveLoss);
    case 'unprofitable':
      return result.filter((row) => row.profit !== null && row.profit < 0);
    default:
      return result;
  }
}

/** Sorts rows by one field; nulls always sort last, ties fall back to unit number. */
export function sortTruckPnl(rows: readonly TruckPnlRow[], sort: TruckPnlSort): TruckPnlRow[] {
  const direction = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = a[sort.field];
    const right = b[sort.field];
    if (left === null && right === null) return a.unitNumber.localeCompare(b.unitNumber);
    if (left === null) return 1;
    if (right === null) return -1;
    const cmp =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right));
    return cmp === 0 ? a.unitNumber.localeCompare(b.unitNumber) : cmp * direction;
  });
}

/** Totals over a set of rows; cost/profit/miles are null when no row carries them. */
export function summarizeTruckPnl(rows: readonly TruckPnlRow[]): TruckPnlSummary {
  const costs = rows.map((row) => row.cost).filter((cost): cost is number => cost !== null);
  const miles = rows.map((row) => row.miles).filter((m): m is number => m !== null);
  const gross = roundMoney(sum(rows.map((row) => row.gross)));
  const cost = costs.length === 0 ? null : roundMoney(sum(costs));
  const inactiveRows = rows.filter((row) => row.inactiveLoss);
  return {
    trucks: rows.length,
    gross,
    miles: miles.length === 0 ? null : roundRatio(sum(miles)),
    loads: sum(rows.map((row) => row.loads)),
    cost,
    profit: cost === null ? null : roundMoney(gross - cost),
    inactiveLossTrucks: inactiveRows.length,
    inactiveLoss: cost === null ? null : roundMoney(sum(inactiveRows.map((row) => row.cost ?? 0))),
  };
}
