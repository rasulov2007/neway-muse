/**
 * The financial state of the company for a period.
 *
 * Read from the **ledger**, not from the operational records. That is the whole point of posting:
 * revenue is what was credited to 4xxx, cost is what was debited to 5xxx/6xxx, and a figure on this
 * page can always be traced to the entries behind it. Summing invoices and expenses separately
 * would give a second set of books that agrees with the first only by luck.
 *
 * Honesty rules:
 *  - A period with no postings reports `null`, not `0`. "We earned nothing" and "nothing has been
 *    posted yet" are different statements and the difference matters most at month end.
 *  - A comparison needs both periods to have postings. Growth from nothing is not a percentage.
 *  - Cost per mile needs miles. Without them it is null and says what it needs.
 */

import type { DateRange } from '../dashboard/period.js';
import { NORMAL_BALANCE, accountFor, type JournalEntry } from './ledger.js';
import { fromCents } from './posting.js';

export type { DateRange };

export const PERIOD_PRESETS = ['today', 'week', 'month', 'quarter', 'year', 'custom'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

const MS_PER_DAY = 86_400_000;

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The range a preset covers, ending today. */
export function rangeFor(preset: PeriodPreset, today: string, custom?: DateRange): DateRange {
  if (preset === 'custom' && custom) return custom;
  const end = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  const date = new Date(end);

  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'week': {
      // Weeks run Monday to today, which is how a carrier's operating week runs.
      const day = date.getUTCDay();
      const back = day === 0 ? 6 : day - 1;
      return { from: iso(end - back * MS_PER_DAY), to: today };
    }
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'quarter': {
      const month = date.getUTCMonth();
      const startMonth = month - (month % 3);
      return {
        from: `${date.getUTCFullYear()}-${String(startMonth + 1).padStart(2, '0')}-01`,
        to: today,
      };
    }
    case 'year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    default:
      return { from: today, to: today };
  }
}

/** The equivalent range immediately before this one, for a like-for-like comparison. */
export function previousRange(range: DateRange): DateRange {
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  const span = to - from + MS_PER_DAY;
  return { from: iso(from - span), to: iso(from - MS_PER_DAY) };
}

export function inRange(onDate: string, range: DateRange): boolean {
  const day = onDate.slice(0, 10);
  return day >= range.from && day <= range.to;
}

// ---------------------------------------------------------------------------------------------
// Period figures
// ---------------------------------------------------------------------------------------------

export interface PeriodFigures {
  /** Null when nothing posted to that group in the period. */
  revenue: number | null;
  directCost: number | null;
  operatingCost: number | null;
  grossProfit: number | null;
  operatingProfit: number | null;
  grossMarginPct: number | null;
  operatingMarginPct: number | null;
  cashIn: number | null;
  cashOut: number | null;
  /** Entries the figures rest on, so the reader knows how much evidence there is. */
  entryCount: number;
}

/** Net movement on a group of accounts, in the direction the group naturally runs. */
function movement(
  entries: readonly JournalEntry[],
  range: DateRange,
  prefix: string,
): { amount: number; touched: boolean } {
  let cents = 0;
  let touched = false;
  for (const entry of entries) {
    if (!inRange(entry.onDate, range)) continue;
    for (const line of entry.lines) {
      if (!line.accountCode.startsWith(prefix)) continue;
      const account = accountFor(line.accountCode);
      if (!account) continue;
      touched = true;
      cents +=
        NORMAL_BALANCE[account.type] === 'debit'
          ? line.debit - line.credit
          : line.credit - line.debit;
    }
  }
  return { amount: fromCents(cents), touched };
}

function pct(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole === 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

export function periodFigures(entries: readonly JournalEntry[], range: DateRange): PeriodFigures {
  const revenue = movement(entries, range, '4');
  const direct = movement(entries, range, '5');
  const operating = movement(entries, range, '6');
  const cash = movement(entries, range, '111');

  const entryCount = entries.filter((e) => inRange(e.onDate, range)).length;

  const revenueValue = revenue.touched ? revenue.amount : null;
  const directValue = direct.touched ? direct.amount : null;
  const operatingValue = operating.touched ? operating.amount : null;

  const gross =
    revenueValue === null && directValue === null
      ? null
      : Math.round(((revenueValue ?? 0) - (directValue ?? 0)) * 100) / 100;
  const operatingProfit =
    gross === null ? null : Math.round((gross - (operatingValue ?? 0)) * 100) / 100;

  // Cash is split by direction rather than netted: a month that took in $400k and paid out $390k
  // is a different business from one that took in $10k and paid nothing.
  let inCents = 0;
  let outCents = 0;
  let cashTouched = false;
  for (const entry of entries) {
    if (!inRange(entry.onDate, range)) continue;
    for (const line of entry.lines) {
      if (!accountFor(line.accountCode)?.isCash) continue;
      cashTouched = true;
      inCents += line.debit;
      outCents += line.credit;
    }
  }

  return {
    revenue: revenueValue,
    directCost: directValue,
    operatingCost: operatingValue,
    grossProfit: gross,
    operatingProfit,
    grossMarginPct: pct(gross, revenueValue),
    operatingMarginPct: pct(operatingProfit, revenueValue),
    cashIn: cashTouched ? fromCents(inCents) : null,
    cashOut: cashTouched ? fromCents(outCents) : null,
    entryCount: cash.touched || entryCount > 0 ? entryCount : 0,
  };
}

export interface Comparison {
  current: number | null;
  previous: number | null;
  /** Null when either side is missing, or the previous period was zero. */
  changePct: number | null;
  changeAbsolute: number | null;
}

/**
 * This period against the one before it.
 *
 * A change from nothing is not a percentage. When the previous period has no postings the
 * comparison reports the absolute figure and leaves the percentage null, rather than printing an
 * infinity or a misleading 100%.
 */
export function compare(current: number | null, previous: number | null): Comparison {
  if (current === null || previous === null) {
    return {
      current,
      previous,
      changePct: null,
      changeAbsolute:
        current === null || previous === null ? null : Math.round((current - previous) * 100) / 100,
    };
  }
  const absolute = Math.round((current - previous) * 100) / 100;
  return {
    current,
    previous,
    changeAbsolute: absolute,
    changePct: previous === 0 ? null : Math.round((absolute / Math.abs(previous)) * 1000) / 10,
  };
}

// ---------------------------------------------------------------------------------------------
// Cost per mile
// ---------------------------------------------------------------------------------------------

export interface CostPerMile {
  /** Every cost debited in the period, direct and operating. */
  totalCost: number | null;
  directCost: number | null;
  operatingCost: number | null;
  miles: number | null;
  costPerMile: number | null;
  directCostPerMile: number | null;
  revenuePerMile: number | null;
  /** Cost per mile by account, worst first — where the money actually goes. */
  byAccount: Array<{ code: string; name: string; amount: number; perMile: number }>;
  /** Named when the figure could not be produced. */
  unavailable: string | null;
}

/**
 * Cost per mile for a period.
 *
 * Reconciles with the P&L by construction: the costs are the same ledger movements the profit
 * figures use, divided by the miles the fleet actually turned. A CPM built from a separate cost
 * list is a CPM that disagrees with the accounts, and then nobody trusts either.
 */
export function costPerMile(
  entries: readonly JournalEntry[],
  range: DateRange,
  miles: number | null,
): CostPerMile {
  const figures = periodFigures(entries, range);
  const total =
    figures.directCost === null && figures.operatingCost === null
      ? null
      : Math.round(((figures.directCost ?? 0) + (figures.operatingCost ?? 0)) * 100) / 100;

  const byAccountCents = new Map<string, number>();
  for (const entry of entries) {
    if (!inRange(entry.onDate, range)) continue;
    for (const line of entry.lines) {
      const account = accountFor(line.accountCode);
      if (!account || account.type !== 'expense') continue;
      byAccountCents.set(
        line.accountCode,
        (byAccountCents.get(line.accountCode) ?? 0) + line.debit - line.credit,
      );
    }
  }

  const usable = miles !== null && miles > 0;
  const byAccount = [...byAccountCents.entries()]
    .map(([code, cents]) => {
      const account = accountFor(code);
      const amount = fromCents(cents);
      return {
        code,
        name: account?.name ?? code,
        amount,
        perMile: usable ? Math.round((amount / (miles as number)) * 1000) / 1000 : 0,
      };
    })
    .filter((row) => row.amount !== 0)
    .sort((a, b) => b.amount - a.amount);

  return {
    totalCost: total,
    directCost: figures.directCost,
    operatingCost: figures.operatingCost,
    miles: usable ? miles : null,
    costPerMile:
      total === null || !usable ? null : Math.round((total / (miles as number)) * 1000) / 1000,
    directCostPerMile:
      figures.directCost === null || !usable
        ? null
        : Math.round((figures.directCost / (miles as number)) * 1000) / 1000,
    revenuePerMile:
      figures.revenue === null || !usable
        ? null
        : Math.round((figures.revenue / (miles as number)) * 1000) / 1000,
    byAccount,
    unavailable: !usable
      ? 'Cost per mile needs the miles the fleet turned in this period'
      : total === null
        ? 'Nothing has been posted to a cost account in this period'
        : null,
  };
}
