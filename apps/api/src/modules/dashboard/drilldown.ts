import type { DrilldownColumn, DrilldownMetric, DrilldownRow } from '@neway/shared';
import type { ExpenseLine, ReportingFacts } from '../reporting/facts';
import { revenueOf, roundMoney, sum, type FinancialResult, type FuelResult } from '../reporting/engines';

/** Rows and headline total behind one drill-down metric (docs/DASHBOARD.md §12). */
export interface DrilldownData {
  title: string;
  total: number | null;
  columns: DrilldownColumn[];
  rows: DrilldownRow[];
}

const col = (key: string, label: string, kind: DrilldownColumn['kind']): DrilldownColumn => ({
  key,
  label,
  kind,
});

interface Lookups {
  unit: (truckId: string | null) => string | null;
  driver: (driverId: string | null) => string | null;
}

function lookups(facts: ReportingFacts): Lookups {
  const units = new Map(facts.trucks.map((t) => [t.truckId, t.unitNumber]));
  const drivers = new Map(facts.drivers.map((d) => [d.driverId, d.name]));
  return {
    unit: (truckId) => (truckId === null ? null : (units.get(truckId) ?? truckId)),
    driver: (driverId) => (driverId === null ? null : (drivers.get(driverId) ?? driverId)),
  };
}

const EXPENSE_COLUMNS: DrilldownColumn[] = [
  col('date', 'Date', 'date'),
  col('category', 'Category', 'text'),
  col('description', 'Description', 'text'),
  col('load', 'Load', 'text'),
  col('unit', 'Unit', 'text'),
  col('driver', 'Driver', 'text'),
  col('source', 'Source', 'text'),
  col('reference', 'Source record', 'text'),
  col('status', 'Status', 'status'),
  col('amount', 'Amount', 'money'),
];

function expenseRow(line: ExpenseLine, look: Lookups): DrilldownRow {
  return {
    id: line.id,
    date: line.date,
    category: line.category,
    description: line.description ?? null,
    load: line.loadNumber ?? null,
    unit: look.unit(line.truckId),
    driver: look.driver(line.driverId),
    source: line.source,
    reference: line.reference ?? null,
    // A posted entry is what the books say; anything else is the operational record it came from.
    status: line.isEstimate ? 'Estimate' : line.source === 'ledger' ? 'Posted' : 'Actual',
    amount: line.amount,
  };
}

function breakdownTotal(financials: FinancialResult, categories: readonly string[]): number | null {
  if (financials.cost === null) return null;
  return roundMoney(
    sum(
      financials.costBreakdown
        .filter((entry) => categories.includes(entry.category))
        .map((entry) => entry.amount),
    ),
  );
}

/** Builds the contributing records for `metric`; totals equal the headline numbers. */
export function buildDrilldown(
  metric: DrilldownMetric,
  facts: ReportingFacts,
  financials: FinancialResult,
  fuel: FuelResult,
): DrilldownData {
  const look = lookups(facts);
  switch (metric) {
    case 'gross':
      return {
        title: 'Gross revenue by delivered load',
        total: financials.gross,
        columns: [
          col('loadNumber', 'Load', 'text'),
          col('deliveredOn', 'Delivered', 'date'),
          col('unit', 'Unit', 'text'),
          col('driver', 'Driver', 'text'),
          col('team', 'Team', 'text'),
          col('miles', 'Miles', 'number'),
          col('linehaul', 'Linehaul', 'money'),
        ],
        rows: facts.revenue.map((line) => ({
          id: line.loadId,
          loadNumber: line.loadNumber,
          deliveredOn: line.deliveredOn,
          unit: look.unit(line.truckId),
          driver: look.driver(line.driverId),
          team: line.teamId,
          miles: line.loadedMiles + line.emptyMiles,
          linehaul: revenueOf(line),
        })),
      };
    case 'cost':
      return {
        title: 'Cost by expense line',
        total: financials.cost,
        columns: EXPENSE_COLUMNS,
        rows: financials.hasExpenseData ? facts.expenses.map((line) => expenseRow(line, look)) : [],
      };
    case 'fuel':
      return {
        title: 'Fuel transactions',
        total: fuel.totals.discountedCost,
        columns: [
          col('date', 'Date', 'date'),
          col('unit', 'Unit', 'text'),
          col('driver', 'Driver', 'text'),
          col('state', 'State', 'text'),
          col('stationName', 'Station', 'text'),
          col('gallons', 'Gallons', 'number'),
          col('grossCost', 'Gross cost', 'money'),
          col('discountedCost', 'Discounted cost', 'money'),
        ],
        rows: facts.fuel.map((row) => ({
          id: row.id,
          date: row.date,
          unit: look.unit(row.truckId),
          driver: look.driver(row.driverId),
          state: row.state,
          stationName: row.stationName,
          gallons: row.gallons,
          grossCost: row.grossCost,
          discountedCost: row.discountedCost,
        })),
      };
    case 'maintenance':
      return {
        title: 'Maintenance and repairs',
        total: breakdownTotal(financials, ['maintenance', 'repairs']),
        columns: EXPENSE_COLUMNS,
        rows: financials.hasExpenseData
          ? facts.expenses
              .filter((line) => line.category === 'maintenance' || line.category === 'repairs')
              .map((line) => expenseRow(line, look))
          : [],
      };
    case 'driver_pay':
      return {
        title: 'Driver pay',
        total: breakdownTotal(financials, ['driver_pay']),
        columns: EXPENSE_COLUMNS,
        rows: financials.hasExpenseData
          ? facts.expenses
              .filter((line) => line.category === 'driver_pay')
              .map((line) => expenseRow(line, look))
          : [],
      };
    case 'inactive_loss':
      return {
        title: 'Inactive trucks with cost',
        total: financials.inactiveTruckLoss,
        columns: [
          col('unit', 'Unit', 'text'),
          col('gross', 'Gross', 'money'),
          col('cost', 'Cost', 'money'),
        ],
        rows: financials.inactiveTruckRows.map((row) => ({
          id: row.truckId,
          unit: row.unitNumber,
          gross: row.gross,
          cost: row.cost,
        })),
      };
  }
}
