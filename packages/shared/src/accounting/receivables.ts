/**
 * Who owes the carrier money, how much, and how late.
 *
 * Aging is computed from the **due date**, not the invoice date. An invoice on net-45 terms issued
 * 40 days ago is not 40 days overdue; it is not overdue at all. Aging from the issue date is the
 * most common way a receivables report manufactures a crisis that does not exist, and the most
 * common way a real one gets buried under it.
 *
 * Honesty rules:
 *  - A customer with no settled invoices has `averageDaysToPay: null`, never 0. Zero would read as
 *    "pays immediately", which is the opposite of "we have no idea".
 *  - Nothing here scores a customer. It reports what they owe and how they have actually paid.
 */

export const AGING_BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const AGING_LABEL: Record<AgingBucket, string> = {
  current: 'Current',
  '1-30': '1–30 days',
  '31-60': '31–60 days',
  '61-90': '61–90 days',
  '90+': '90+ days',
};

const MS_PER_DAY = 86_400_000;

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / MS_PER_DAY);
}

/** Days past due, from the due date. Negative while the invoice is still in terms. */
export function daysPastDue(dueOn: string | null, today: string): number | null {
  if (!dueOn) return null;
  return daysBetween(dueOn, today);
}

export function bucketFor(dueOn: string | null, today: string): AgingBucket {
  const late = daysPastDue(dueOn, today);
  if (late === null || late <= 0) return 'current';
  if (late <= 30) return '1-30';
  if (late <= 60) return '31-60';
  if (late <= 90) return '61-90';
  return '90+';
}

export interface AgeableInvoice {
  id: string;
  billToId: string;
  billToName: string;
  dueOn: string | null;
  issuedOn: string | null;
  total: number;
  paid: number;
  balance: number;
  /** Statuses that take an invoice out of receivables entirely. */
  status: string;
  paidOn: string | null;
}

/** Statuses whose balance is no longer a receivable. */
const NOT_RECEIVABLE = new Set(['draft', 'void', 'cancelled', 'paid']);

export interface AgingTotals {
  current: number;
  '1-30': number;
  '31-60': number;
  '61-90': number;
  '90+': number;
  total: number;
  /** Everything past its due date, i.e. total less current. */
  overdue: number;
}

function emptyAging(): AgingTotals {
  return { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0, total: 0, overdue: 0 };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function ageInvoices(invoices: readonly AgeableInvoice[], today: string): AgingTotals {
  const totals = emptyAging();
  for (const invoice of invoices) {
    if (NOT_RECEIVABLE.has(invoice.status) || invoice.balance <= 0) continue;
    const bucket = bucketFor(invoice.dueOn, today);
    totals[bucket] += invoice.balance;
    totals.total += invoice.balance;
    if (bucket !== 'current') totals.overdue += invoice.balance;
  }
  for (const key of Object.keys(totals) as Array<keyof AgingTotals>) {
    totals[key] = round(totals[key]);
  }
  return totals;
}

export interface CustomerReceivable {
  billToId: string;
  billToName: string;
  openInvoices: number;
  aging: AgingTotals;
  /**
   * Mean days from issue to payment across settled invoices. Null when none have settled — the
   * carrier has no evidence of how this customer pays, which is different from paying instantly.
   */
  averageDaysToPay: number | null;
  /** How many settled invoices that average rests on. */
  settledCount: number;
  lastPaymentOn: string | null;
  /** The single oldest unpaid invoice, in days past due. Null when nothing is overdue. */
  oldestOverdueDays: number | null;
}

/**
 * Receivables rolled up per customer.
 *
 * Sorted worst-first by overdue balance, because that is the order a collections call list is
 * actually worked.
 */
export function receivablesByCustomer(
  invoices: readonly AgeableInvoice[],
  today: string,
): CustomerReceivable[] {
  const byParty = new Map<string, AgeableInvoice[]>();
  for (const invoice of invoices) {
    const bucket = byParty.get(invoice.billToId);
    if (bucket) bucket.push(invoice);
    else byParty.set(invoice.billToId, [invoice]);
  }

  const rows: CustomerReceivable[] = [];
  for (const [billToId, all] of byParty) {
    const open = all.filter((i) => !NOT_RECEIVABLE.has(i.status) && i.balance > 0);
    const settled = all.filter((i) => i.paidOn && i.issuedOn);

    const daysToPay = settled.map((i) => daysBetween(i.issuedOn as string, i.paidOn as string));
    const lastPayment = settled
      .map((i) => i.paidOn as string)
      .sort()
      .at(-1);

    const overdueDays = open
      .map((i) => daysPastDue(i.dueOn, today))
      .filter((d): d is number => d !== null && d > 0);

    rows.push({
      billToId,
      billToName: all[0]?.billToName ?? billToId,
      openInvoices: open.length,
      aging: ageInvoices(open, today),
      averageDaysToPay:
        daysToPay.length > 0
          ? Math.round(daysToPay.reduce((sum, d) => sum + d, 0) / daysToPay.length)
          : null,
      settledCount: settled.length,
      lastPaymentOn: lastPayment ?? null,
      oldestOverdueDays: overdueDays.length > 0 ? Math.max(...overdueDays) : null,
    });
  }

  return rows.sort((a, b) => b.aging.overdue - a.aging.overdue || b.aging.total - a.aging.total);
}

// ---------------------------------------------------------------------------------------------
// Payment application
// ---------------------------------------------------------------------------------------------

export interface ApplicationTarget {
  invoiceId: string;
  invoiceNumber: string;
  balance: number;
}

export interface ApplicationLine {
  invoiceId: string;
  amount: number;
}

export interface ApplicationCheck {
  ok: boolean;
  errors: string[];
  /** Received less applied. Held as a liability until it is allocated. */
  unapplied: number;
  applied: number;
}

/**
 * Whether a payment may be applied as proposed.
 *
 * The refusals matter more than the arithmetic: over-applying to an invoice creates a negative
 * balance that looks like a credit the customer does not have, and applying more than was received
 * creates cash the carrier never got. Both are refused rather than clamped, because a clamped
 * amount is a silent disagreement with whatever the operator meant.
 */
export function checkApplication(
  received: number,
  lines: readonly ApplicationLine[],
  targets: readonly ApplicationTarget[],
): ApplicationCheck {
  const errors: string[] = [];
  const byId = new Map(targets.map((t) => [t.invoiceId, t]));
  const seen = new Set<string>();
  let applied = 0;

  for (const line of lines) {
    if (line.amount <= 0) {
      errors.push('An application line must be for a positive amount');
      continue;
    }
    if (seen.has(line.invoiceId)) {
      errors.push(`The same invoice appears twice in this payment`);
      continue;
    }
    seen.add(line.invoiceId);

    const target = byId.get(line.invoiceId);
    if (!target) {
      errors.push(`Invoice ${line.invoiceId} is not open for payment`);
      continue;
    }
    if (round(line.amount) > round(target.balance)) {
      errors.push(
        `${target.invoiceNumber} has a balance of ${target.balance.toFixed(2)}; ${line.amount.toFixed(2)} would overpay it`,
      );
      continue;
    }
    applied += line.amount;
  }

  if (round(applied) > round(received)) {
    errors.push(`Applying ${applied.toFixed(2)} but only ${received.toFixed(2)} was received`);
  }

  return {
    ok: errors.length === 0,
    errors,
    applied: round(applied),
    unapplied: round(Math.max(0, received - applied)),
  };
}

/**
 * Applies a payment oldest-invoice-first.
 *
 * A default, not a rule — the operator can override every line. Oldest-first is what a collections
 * clerk does by hand, because the oldest balance is the one closest to being written off.
 */
export function proposeApplication(
  received: number,
  targets: readonly ApplicationTarget[],
  today: string,
  dueDates: ReadonlyMap<string, string | null>,
): ApplicationLine[] {
  const ordered = [...targets].sort((a, b) => {
    const aLate = daysPastDue(dueDates.get(a.invoiceId) ?? null, today) ?? -9999;
    const bLate = daysPastDue(dueDates.get(b.invoiceId) ?? null, today) ?? -9999;
    return bLate - aLate;
  });

  const lines: ApplicationLine[] = [];
  let remaining = received;
  for (const target of ordered) {
    if (remaining <= 0) break;
    const amount = Math.min(remaining, target.balance);
    if (amount <= 0) continue;
    lines.push({ invoiceId: target.invoiceId, amount: round(amount) });
    remaining = round(remaining - amount);
  }
  return lines;
}
