import type { DateRange, ReportingFacts } from '../reporting/facts';
import { revenueOf, roundMoney, sum } from '../reporting/engines';
import { addDays } from '../reporting/period/date-utils';

function inRange(date: string, range: DateRange): boolean {
  return date >= range.from && date <= range.to;
}

function weekOverlaps(weekStart: string, range: DateRange): boolean {
  return weekStart <= range.to && addDays(weekStart, 6) >= range.from;
}

/**
 * Restricts facts loaded for a wider span to `range` in memory, so an 8-week trend needs one
 * data-source call. The ledger total of a slice is derived from its own revenue lines and is not a
 * reconciliation input; reconciliation always runs on facts loaded for the exact period.
 */
export function sliceFacts(facts: ReportingFacts, range: DateRange): ReportingFacts {
  const revenue = facts.revenue.filter((line) => inRange(line.deliveredOn, range));
  return {
    companyId: facts.companyId,
    range: { from: range.from, to: range.to },
    revenue,
    expenses: facts.expenses.filter((line) => inRange(line.date, range)),
    fuel: facts.fuel.filter((row) => inRange(row.date, range)),
    mileage: facts.mileage.filter((row) => inRange(row.date, range)),
    trucks: facts.trucks,
    drivers: facts.drivers,
    dispatchWeeks: facts.dispatchWeeks.filter((week) => weekOverlaps(week.weekStart, range)),
    expenseCoverage: facts.expenseCoverage.filter((week) => weekOverlaps(week.weekStart, range)),
    revenueLedgerTotal: roundMoney(sum(revenue.map(revenueOf))),
  };
}
