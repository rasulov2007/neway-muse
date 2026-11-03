import type { ReportingFacts } from '../facts';
import { revenueOf } from './financial-calculator';
import { roundMoney, sum } from './money';
import { computeOpsNet } from './ops-net-calculator';
import type { DataQualityCheck, FinancialResult, WeekCoverage } from './types';

/** Formats a dollar amount for check detail text. */
function money(value: number): string {
  return `$${roundMoney(value).toFixed(2)}`;
}

/** Revenue reconciliation: dashboard gross vs the independent ledger total, to the cent. */
export function checkRevenueReconciliation(
  facts: ReportingFacts,
  financials: FinancialResult,
): DataQualityCheck {
  const ledger = roundMoney(facts.revenueLedgerTotal);
  const dashboard = financials.gross;
  const difference = roundMoney(dashboard - ledger);
  const data = { dashboardGross: dashboard, ledgerTotal: ledger, difference };
  if (difference === 0) {
    return {
      key: 'revenue_reconciliation',
      status: 'ok',
      title: 'Revenue reconciles',
      detail: `Dashboard gross ${money(dashboard)} equals the revenue ledger.`,
      amount: difference,
      data,
    };
  }
  return {
    key: 'revenue_reconciliation',
    status: 'error',
    title: 'Revenue does not reconcile',
    detail: `Dashboard gross ${money(dashboard)} differs from ledger ${money(ledger)} by ${money(difference)}.`,
    amount: difference,
    data,
  };
}

/** Expense completeness: weeks in the window without any recorded expense data. */
export function checkExpenseCompleteness(
  weeks: readonly WeekCoverage[],
  financials: FinancialResult,
): DataQualityCheck {
  const missing = weeks.filter((week) => !week.hasExpenseData).map((week) => week.weekStart);
  if (weeks.length === 0 && !financials.hasExpenseData) {
    return {
      key: 'expense_completeness',
      status: 'warning',
      title: 'No expense data in period',
      detail: 'No accounting expenses were recorded for this period; cost is unknown.',
      count: 0,
      data: { missingWeeks: [] },
    };
  }
  if (missing.length === 0) {
    return {
      key: 'expense_completeness',
      status: 'ok',
      title: 'Expense data complete',
      detail: `All ${weeks.length} week(s) have expense data.`,
      count: 0,
      data: { missingWeeks: [] },
    };
  }
  return {
    key: 'expense_completeness',
    status: 'warning',
    title: 'Weeks without expense data',
    detail: `${missing.length} of ${weeks.length} week(s) have no expense data: ${missing.join(', ')}.`,
    count: missing.length,
    data: { missingWeeks: missing },
  };
}

/** Unknown driver pay types: unclassified drivers and the gross sitting in the unknown bucket. */
export function checkUnknownPayTypes(facts: ReportingFacts): DataQualityCheck {
  const { unknown } = computeOpsNet(facts);
  const flagged = unknown.driverCount > 0 || unknown.gross > 0;
  return {
    key: 'unknown_pay_types',
    status: flagged ? 'warning' : 'ok',
    title: flagged ? 'Unclassified driver pay types' : 'All driver pay types classified',
    detail: flagged
      ? `${unknown.driverCount} driver(s) without a pay type; ${money(unknown.gross)} gross is unclassified.`
      : 'Every driver has a recognized pay type.',
    count: unknown.driverCount,
    amount: unknown.gross,
    data: { drivers: unknown.drivers },
  };
}

/** Missing truck assignments: revenue lines with no truck. */
export function checkMissingTruckAssignments(facts: ReportingFacts): DataQualityCheck {
  const lines = facts.revenue.filter((line) => line.truckId === null);
  const gross = roundMoney(sum(lines.map(revenueOf)));
  return {
    key: 'missing_truck_assignments',
    status: lines.length > 0 ? 'warning' : 'ok',
    title: lines.length > 0 ? 'Loads without a truck' : 'All loads have a truck',
    detail:
      lines.length > 0
        ? `${lines.length} delivered load(s) worth ${money(gross)} have no truck assigned.`
        : 'Every delivered load is assigned to a truck.',
    count: lines.length,
    amount: gross,
    data: { loadIds: lines.map((line) => line.loadId) },
  };
}

/** Missing driver assignments: revenue lines with no driver. */
export function checkMissingDriverAssignments(facts: ReportingFacts): DataQualityCheck {
  const lines = facts.revenue.filter((line) => line.driverId === null);
  const gross = roundMoney(sum(lines.map(revenueOf)));
  return {
    key: 'missing_driver_assignments',
    status: lines.length > 0 ? 'warning' : 'ok',
    title: lines.length > 0 ? 'Loads without a driver' : 'All loads have a driver',
    detail:
      lines.length > 0
        ? `${lines.length} delivered load(s) worth ${money(gross)} have no driver assigned.`
        : 'Every delivered load is assigned to a driver.',
    count: lines.length,
    amount: gross,
    data: { loadIds: lines.map((line) => line.loadId) },
  };
}

/** Missing fuel data: the period has mileage but no fuel transactions at all. */
export function checkMissingFuelData(
  facts: ReportingFacts,
  financials: FinancialResult,
): DataQualityCheck {
  const miles = financials.totalMiles ?? 0;
  const flagged = miles > 0 && facts.fuel.length === 0;
  return {
    key: 'missing_fuel_data',
    status: flagged ? 'warning' : 'ok',
    title: flagged ? 'No fuel data for driven miles' : 'Fuel data present',
    detail: flagged
      ? `${miles} miles were driven but no fuel transactions were recorded.`
      : facts.fuel.length > 0
        ? `${facts.fuel.length} fuel transaction(s) recorded.`
        : 'No miles driven in the period.',
    count: facts.fuel.length,
    data: { totalMiles: financials.totalMiles },
  };
}

/** Runs every data-quality check for the period (docs/DASHBOARD.md §9). */
export function computeDataQuality(
  facts: ReportingFacts,
  financials: FinancialResult,
  weeks: readonly WeekCoverage[],
): DataQualityCheck[] {
  return [
    checkRevenueReconciliation(facts, financials),
    checkExpenseCompleteness(weeks, financials),
    checkUnknownPayTypes(facts),
    checkMissingTruckAssignments(facts),
    checkMissingDriverAssignments(facts),
    checkMissingFuelData(facts, financials),
  ];
}
