/**
 * Posted costs against the estimates they replace.
 *
 * A trucking company knows roughly what a week cost before the books say so. A driver has earned
 * pay that has not been settled; a repair order is finished but the bill has not been entered.
 * Those are **estimates**: obligations the company has incurred and will post. Once Accounting
 * posts one, the estimate must disappear and the posting must take its place — exactly once.
 *
 * The rule that makes this safe is that an estimate and its posting share an **obligation key**.
 * The key names the thing that will be paid — this driver, for this period; this repair order;
 * this invoice's factoring fee — not the category it falls under. Suppressing a whole category
 * because one record in it was posted is what hides the other nine drivers' pay.
 *
 * Four cases the key has to survive:
 *
 * - **Partial posting.** One driver's settlement is posted, nine are not. Only that driver's
 *   estimate goes; the other nine remain in the projection.
 * - **Adjustments.** A correcting entry against the same reference adds to the posted amount for
 *   that key. The obligation stays settled and the amount is the net of the entries.
 * - **Reversals.** A reversal posts mirrored lines, so the net for the key returns to zero. The
 *   obligation is then no longer settled and its estimate comes back, which is what the company
 *   still owes.
 * - **A posting in a later period.** The key is settled by the posting's existence, not by its
 *   date. An estimate is therefore dropped as soon as its obligation has been posted anywhere,
 *   so a range covering both periods never carries the estimate and the posting together. The
 *   cost lands in the period it was posted in, and the screen has to say so.
 *
 * Nothing here invents an allocation. A posting that names no load, truck or driver stays
 * unallocated and is reported as such, because spreading overhead across units by guesswork makes
 * a unit look unprofitable for a reason nobody can trace.
 */

/** Cents, so a comparison against zero is exact rather than a float accident. */
const cents = (amount: number): number => Math.round(amount * 100);

/** What kind of obligation a key names. Kept in the key so two kinds can never collide. */
export type ObligationKind = 'driver_pay' | 'staff_payroll' | 'expense' | 'factoring';

/**
 * The identity an estimate and its posting share.
 *
 * `parts` are joined in order and must be derivable from BOTH sides. A driver settlement is keyed
 * on the driver and the period, because that pair is what the operational record and the
 * accounting record both know; the settlement's own id is not, since the estimate predates it.
 */
export function obligationKey(kind: ObligationKind, ...parts: Array<string | null | undefined>): string | null {
  const known = parts.map((p) => (p ?? '').trim());
  if (known.some((p) => p === '')) return null;
  return [kind, ...known].join(':');
}

/**
 * A driver's pay for one settlement period: what a statement settles, posted or not.
 *
 * Keyed on the period END because that is the date both sides carry - the accounting statement
 * and the operational record of what a driver is owed. A key is only useful if the estimate can
 * build the same one as the posting.
 */
export const driverPayKey = (driverId: string | null | undefined, periodEnd: string | null | undefined): string | null =>
  obligationKey('driver_pay', driverId, periodEnd);

/** One staff payroll period. */
export const staffPayrollKey = (periodId: string | null | undefined): string | null =>
  obligationKey('staff_payroll', periodId);

/**
 * One recorded cost: a repair order, a fuel purchase, a bill.
 *
 * `sourceKey` is preferred because it is what the accounting record carries back to the
 * operational record it came from (`work_order:<id>`, `fuel:<txn>`). An expense with no source
 * key is keyed on its own id, which only matches if both sides are the same record.
 */
export const expenseKey = (sourceKeyOrId: string | null | undefined): string | null =>
  obligationKey('expense', sourceKeyOrId);

/** The factoring fee charged on funding one invoice. */
export const factoringKey = (invoiceId: string | null | undefined): string | null =>
  obligationKey('factoring', invoiceId);

/** Anything carrying an obligation key and an amount in dollars. */
export interface Reconcilable {
  obligationKey?: string | null;
  amount: number;
}

/**
 * The obligations the books have actually taken on, from the net posted per key.
 *
 * A key whose postings net to zero is NOT settled: a posting that was reversed leaves the company
 * owing the money again, and the estimate has to come back rather than vanish silently.
 *
 * `postings` carries every posted line for the company, including ones dated outside the period
 * being shown — that is what stops an estimate in one period and its posting in the next from
 * being counted as two costs.
 */
export function settledObligations(postings: readonly Reconcilable[]): Set<string> {
  const net = new Map<string, number>();
  for (const line of postings) {
    if (!line.obligationKey) continue;
    net.set(line.obligationKey, (net.get(line.obligationKey) ?? 0) + cents(line.amount));
  }
  const settled = new Set<string>();
  for (const [key, total] of net) if (total !== 0) settled.add(key);
  return settled;
}

/**
 * The operational lines that survive: everything whose obligation the books have not taken on.
 *
 * A line with no key is always kept. It cannot be matched to a posting, so dropping it would lose
 * a real cost, and keeping it can only double-count if the same cost is posted under a key — which
 * is the case the key exists to catch.
 */
export function withoutSettled<T extends Reconcilable>(operational: readonly T[], settled: ReadonlySet<string>): T[] {
  return operational.filter((line) => !(line.obligationKey && settled.has(line.obligationKey)));
}

/** What a period's cost is made of, so the screen never presents a projection as the books. */
export interface CostMix {
  /** Posted by Accounting: the books' own figure. */
  postedCents: number;
  /** Incurred but not yet posted: what the company still expects to pay for this period. */
  estimatedCents: number;
  /** Of the posted total, what names no truck, driver or load. Overhead, never a unit's cost. */
  unallocatedPostedCents: number;
  /** True when a projection is being shown alongside the books. */
  hasEstimates: boolean;
}

export interface MixableCostLine {
  amount: number;
  isEstimate: boolean;
  source: string;
  truckId?: string | null;
  driverId?: string | null;
  loadNumber?: string | null;
}

/**
 * Splits a period's cost lines into what the books posted and what is still a projection.
 *
 * "Posted" is decided by the source being the ledger, not by `isEstimate`: an operational record
 * can be an exact amount (a finished repair with an invoice) and still not be a posted cost.
 */
export function costMix(lines: readonly MixableCostLine[]): CostMix {
  let posted = 0;
  let estimated = 0;
  let unallocated = 0;
  for (const line of lines) {
    const value = cents(line.amount);
    if (line.source === 'ledger') {
      posted += value;
      if (!line.truckId && !line.driverId && !line.loadNumber) unallocated += value;
    } else {
      estimated += value;
    }
  }
  return {
    postedCents: posted,
    estimatedCents: estimated,
    unallocatedPostedCents: unallocated,
    hasEstimates: estimated !== 0,
  };
}

/**
 * The sentence the dashboard shows when gross and cost do not share a date basis.
 *
 * Gross belongs to the day the freight was delivered. A posted cost belongs to the day Accounting
 * posted it, which is the day the P&L, the period and the trial balance all use. For a load
 * delivered on Sunday and settled the following Friday, the revenue and its driver pay fall in
 * different weeks, and a reader comparing the two needs to be told that rather than discovering it.
 */
export function dateBasisNote(mix: CostMix): string {
  const base =
    'Gross is counted on the day the load was delivered; a posted cost is counted on the day Accounting posted it. A load delivered near the end of a period is often settled in the next one, so the two do not always fall in the same week.';
  if (!mix.hasEstimates) return base;
  return `${base} Costs not yet posted are shown separately as a projection of what this period still owes.`;
}
