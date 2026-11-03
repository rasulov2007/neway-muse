/**
 * Posting rules: the one place an operational event becomes an accounting entry.
 *
 * Every rule lives here rather than beside the feature that triggers it, so the debits and credits
 * for the whole business can be read on one page and argued with. A rule scattered into the invoice
 * screen and a second one into the payment screen is how two halves of the same transaction end up
 * disagreeing.
 *
 * Each builder returns a draft; `buildEntry` decides whether it is a valid entry. Nothing here can
 * produce an unbalanced posting, because nothing here posts — it proposes.
 */

import {
  expenseAccountFor,
  REVENUE_ACCOUNT,
  buildEntry,
  type BuildEntryResult,
  type EntryDraft,
} from './ledger.js';

/** Dollars to integer cents. The ledger works in cents so balance checks are exact. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** Integer cents back to dollars, for display only. */
export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

// ---------------------------------------------------------------------------------------------
// Revenue: invoice issued
// ---------------------------------------------------------------------------------------------

export interface InvoicePostingInput {
  invoiceId: string;
  invoiceNumber: string;
  issuedOn: string;
  billToName: string;
  /** One line per charge, so revenue lands in the account the charge type belongs to. */
  lines: Array<{ chargeType: string; description: string; amount: number }>;
}

/**
 * Issuing an invoice.
 *
 *   Debit  Accounts receivable   — the customer now owes it
 *   Credit Revenue (by charge)   — the carrier has earned it
 *
 * Revenue is split by charge type rather than lumped, because detention and linehaul are different
 * businesses and a carrier that cannot see them apart cannot price either.
 */
export function postInvoiceIssued(input: InvoicePostingInput): BuildEntryResult {
  const lines: EntryDraft['lines'] = [];
  let total = 0;

  for (const line of input.lines) {
    const cents = toCents(line.amount);
    if (cents === 0) continue;
    total += cents;
    lines.push({
      accountCode: REVENUE_ACCOUNT[line.chargeType] ?? REVENUE_ACCOUNT.other ?? '4500',
      credit: cents,
      memo: line.description,
    });
  }

  if (total === 0) {
    return { ok: false, error: 'An invoice with no billable amount cannot be posted' };
  }

  return buildEntry({
    onDate: input.issuedOn,
    source: 'invoice_issued',
    sourceKey: `invoice_issued:${input.invoiceId}`,
    reference: { type: 'invoice', id: input.invoiceId, label: input.invoiceNumber },
    memo: `${input.invoiceNumber} issued to ${input.billToName}`,
    lines: [{ accountCode: '1200', debit: total, memo: 'Accounts receivable' }, ...lines],
  });
}

// ---------------------------------------------------------------------------------------------
// Cash in: payment received
// ---------------------------------------------------------------------------------------------

export interface PaymentPostingInput {
  paymentId: string;
  reference: string;
  receivedOn: string;
  partyName: string;
  /** Dollars actually applied to invoices. */
  appliedAmount: number;
  /** Dollars received but not yet applied to anything. */
  unappliedAmount: number;
}

/**
 * Receiving a customer payment.
 *
 *   Debit  Cash                  — the money arrived
 *   Credit Accounts receivable   — for the part applied to invoices
 *   Credit Accrued expenses      — for the part not yet applied; it is a liability until it is
 *                                  allocated, because the carrier is holding someone else's money
 *                                  against no specific invoice
 */
export function postPaymentReceived(input: PaymentPostingInput): BuildEntryResult {
  const applied = toCents(input.appliedAmount);
  const unapplied = toCents(input.unappliedAmount);
  const total = applied + unapplied;

  if (total <= 0) return { ok: false, error: 'A payment for zero cannot be posted' };

  const lines: EntryDraft['lines'] = [
    { accountCode: '1110', debit: total, memo: 'Operating account' },
  ];
  if (applied > 0)
    lines.push({ accountCode: '1200', credit: applied, memo: 'Applied to invoices' });
  if (unapplied > 0) {
    lines.push({ accountCode: '2200', credit: unapplied, memo: 'Unapplied cash held' });
  }

  return buildEntry({
    onDate: input.receivedOn,
    source: 'payment_received',
    sourceKey: `payment_received:${input.paymentId}`,
    reference: { type: 'payment', id: input.paymentId, label: input.reference },
    memo: `Payment from ${input.partyName}`,
    lines,
  });
}

// ---------------------------------------------------------------------------------------------
// Cost in: vendor bill posted
// ---------------------------------------------------------------------------------------------

export interface BillPostingInput {
  billId: string;
  billNumber: string;
  issuedOn: string;
  vendorName: string;
  /** `expense_categories.code`. */
  categoryCode: string;
  amount: number;
}

/**
 * Posting a vendor bill.
 *
 *   Debit  Expense (by category) — the cost is incurred now
 *   Credit Accounts payable      — and owed until it is paid
 *
 * The cost is recognised when the bill arrives, not when it is paid. Recognising it on payment
 * would let a carrier flatter a month simply by paying late.
 */
export function postBill(input: BillPostingInput): BuildEntryResult {
  const cents = toCents(input.amount);
  if (cents <= 0) return { ok: false, error: 'A bill for zero cannot be posted' };

  return buildEntry({
    onDate: input.issuedOn,
    source: 'bill_posted',
    sourceKey: `bill_posted:${input.billId}`,
    reference: { type: 'bill', id: input.billId, label: input.billNumber },
    memo: `${input.billNumber} from ${input.vendorName}`,
    lines: [
      {
        accountCode: expenseAccountFor(input.categoryCode),
        debit: cents,
        memo: input.categoryCode,
      },
      { accountCode: '2100', credit: cents, memo: 'Accounts payable' },
    ],
  });
}

export interface BillPaymentPostingInput {
  paymentId: string;
  reference: string;
  paidOn: string;
  vendorName: string;
  amount: number;
}

/**
 * Paying a vendor.
 *
 *   Debit  Accounts payable — the debt is discharged
 *   Credit Cash            — the money left
 *
 * No expense here: the cost was recognised when the bill posted. Debiting the expense again would
 * double-count it, which is the single most common way a ledger overstates cost.
 */
export function postBillPaid(input: BillPaymentPostingInput): BuildEntryResult {
  const cents = toCents(input.amount);
  if (cents <= 0) return { ok: false, error: 'A payment for zero cannot be posted' };

  return buildEntry({
    onDate: input.paidOn,
    source: 'bill_paid',
    sourceKey: `bill_paid:${input.paymentId}`,
    reference: { type: 'payment', id: input.paymentId, label: input.reference },
    memo: `Paid ${input.vendorName}`,
    lines: [
      { accountCode: '2100', debit: cents, memo: 'Accounts payable' },
      { accountCode: '1110', credit: cents, memo: 'Operating account' },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Cost in: expense paid directly
// ---------------------------------------------------------------------------------------------

export interface ExpensePostingInput {
  expenseId: string;
  expenseNumber: string;
  onDate: string;
  description: string;
  categoryCode: string;
  amount: number;
  /** True when it was paid straight from the bank; false when it sits in AP behind a bill. */
  paidDirectly: boolean;
  /**
   * Cents the driver funded out of their own pocket and is owed back.
   *
   * The company's cost is the same either way - it is the credit side that differs. This part
   * was never paid from the bank and is not owed to a vendor; it is owed to the driver, so it
   * is credited to driver settlements payable and cleared when their statement is paid. That is
   * what keeps the cost recognised exactly once: the statement does not expense it again.
   */
  reimbursableToDriverCents?: number;
}

/**
 * Recording an expense.
 *
 *   Debit  Expense (by category)
 *   Credit Cash, or Accounts payable when a bill covers it
 *
 * A fuel-card purchase and a shop invoice are the same cost with different timing; the credit side
 * is what differs, and it is stated explicitly rather than assumed.
 */
export function postExpense(input: ExpensePostingInput): BuildEntryResult {
  const cents = toCents(input.amount);
  if (cents <= 0) return { ok: false, error: 'An expense for zero cannot be posted' };
  const owedToDriver = Math.min(Math.max(0, Math.round(input.reimbursableToDriverCents ?? 0)), cents);

  return buildEntry({
    onDate: input.onDate,
    source: 'expense_recorded',
    sourceKey: `expense_recorded:${input.expenseId}`,
    reference: { type: 'expense', id: input.expenseId, label: input.expenseNumber },
    memo: input.description,
    lines: [
      {
        accountCode: expenseAccountFor(input.categoryCode),
        debit: cents,
        memo: input.categoryCode,
      },
      ...(owedToDriver > 0
        ? [{ accountCode: '2300', credit: owedToDriver, memo: 'Owed to the driver who paid' }]
        : []),
      ...(cents - owedToDriver > 0
        ? [{
            accountCode: input.paidDirectly ? '1110' : '2100',
            credit: cents - owedToDriver,
            memo: input.paidDirectly ? 'Operating account' : 'Accounts payable',
          }]
        : []),
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Driver settlements
// ---------------------------------------------------------------------------------------------

export interface SettlementPostingInput {
  settlementId: string;
  settlementNumber: string;
  onDate: string;
  driverName: string;
  /** Gross driver earnings before anything is taken off. */
  gross: number;
  /** Deductions other than escrow — insurance, lease, advance repayment. */
  deductions: number;
  /** Escrow withheld: the carrier holds it and owes it back. */
  escrow: number;
  /**
   * Reimbursements paid out on this statement.
   *
   * These are part of the net the driver receives, but they are not driver pay and they were
   * expensed when the receipt was approved - the liability to the driver has been on the books
   * since then. So this part debits nothing and credits nothing here: it is simply carved out
   * of the payable credit, leaving the amount this statement newly owes.
   */
  reimbursements?: number;
  net: number;
}

/**
 * Finalising a driver settlement.
 *
 *   Debit  Driver pay                  — the full gross is the carrier's cost
 *   Credit Driver settlements payable  — the net owed to the driver
 *   Credit Accrued expenses            — deductions recovered by the carrier
 *   Credit Driver escrow held          — escrow is a liability, not income
 *
 * Escrow is the line people get wrong. Money withheld for escrow has not been earned by the
 * carrier; it is the driver's, held on their behalf, and crediting it to income would overstate
 * profit and understate what is owed.
 */
export function postSettlementFinalized(input: SettlementPostingInput): BuildEntryResult {
  const gross = toCents(input.gross);
  const deductions = toCents(input.deductions);
  const escrow = toCents(input.escrow);
  const reimbursements = toCents(input.reimbursements ?? 0);
  const net = toCents(input.net);
  const newlyOwed = net - reimbursements;

  if (gross <= 0)
    return { ok: false, error: 'A settlement with no gross earnings cannot be posted' };
  if (newlyOwed + deductions + escrow !== gross) {
    return {
      ok: false,
      error: `Settlement does not reconcile: net ${net} - reimbursements ${reimbursements} + deductions ${deductions} + escrow ${escrow} ≠ gross ${gross} (cents)`,
    };
  }

  // A week whose deductions outrun the pay owes the driver nothing new; it reduces what is
  // owed, so the payable is debited rather than credited. Zero owes nothing and says nothing.
  const lines: EntryDraft['lines'] = [
    { accountCode: '5200', debit: gross, memo: 'Driver pay' },
    ...(newlyOwed > 0 ? [{ accountCode: '2300', credit: newlyOwed, memo: 'Net owed to the driver' }] : []),
    ...(newlyOwed < 0 ? [{ accountCode: '2300', debit: -newlyOwed, memo: 'Carried against what the driver owes' }] : []),
  ];
  if (deductions > 0) {
    lines.push({ accountCode: '2200', credit: deductions, memo: 'Deductions recovered' });
  }
  if (escrow > 0) {
    lines.push({ accountCode: '1400', credit: escrow, memo: 'Escrow withheld' });
  }

  return buildEntry({
    onDate: input.onDate,
    source: 'settlement_finalized',
    sourceKey: `settlement_finalized:${input.settlementId}`,
    reference: { type: 'settlement', id: input.settlementId, label: input.settlementNumber },
    memo: `${input.settlementNumber} finalised for ${input.driverName}`,
    lines,
  });
}

export function postSettlementPaid(input: {
  settlementId: string;
  settlementNumber: string;
  onDate: string;
  driverName: string;
  net: number;
}): BuildEntryResult {
  const net = toCents(input.net);
  if (net <= 0) return { ok: false, error: 'A settlement payment for zero cannot be posted' };

  return buildEntry({
    onDate: input.onDate,
    source: 'settlement_paid',
    sourceKey: `settlement_paid:${input.settlementId}`,
    reference: { type: 'settlement', id: input.settlementId, label: input.settlementNumber },
    memo: `${input.settlementNumber} paid to ${input.driverName}`,
    lines: [
      { accountCode: '2300', debit: net, memo: 'Driver settlements payable' },
      { accountCode: '1110', credit: net, memo: 'Operating account' },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Staff payroll
// ---------------------------------------------------------------------------------------------

export interface PayrollPostingInput {
  periodId: string;
  periodLabel: string;
  onDate: string;
  /** Gross pay across every payslip in the period. */
  gross: number;
  /** Employee tax withheld — the carrier holds it for the authority. */
  taxWithheld: number;
  /** Other deductions withheld. */
  deductions: number;
  net: number;
}

/**
 * Finalising a staff payroll period.
 *
 *   Debit  Staff payroll        — the gross cost to the carrier
 *   Credit Payroll payable      — net owed to staff
 *   Credit Payroll taxes payable — withheld and owed to the authority
 *   Credit Accrued expenses     — other withholdings
 *
 * Withheld tax is never the carrier's money. It is a liability from the moment it is withheld to
 * the moment it is remitted, and treating it as anything else is how a payroll account quietly
 * runs a deficit.
 */
export function postPayrollFinalized(input: PayrollPostingInput): BuildEntryResult {
  const gross = toCents(input.gross);
  const tax = toCents(input.taxWithheld);
  const deductions = toCents(input.deductions);
  const net = toCents(input.net);

  if (gross <= 0) return { ok: false, error: 'A payroll period with no gross cannot be posted' };
  if (net + tax + deductions !== gross) {
    return {
      ok: false,
      error: `Payroll does not reconcile: net ${net} + tax ${tax} + deductions ${deductions} ≠ gross ${gross} (cents)`,
    };
  }

  const lines: EntryDraft['lines'] = [
    { accountCode: '6400', debit: gross, memo: 'Staff payroll' },
    { accountCode: '2310', credit: net, memo: 'Net owed to staff' },
  ];
  if (tax > 0) lines.push({ accountCode: '2320', credit: tax, memo: 'Tax withheld' });
  if (deductions > 0) {
    lines.push({ accountCode: '2200', credit: deductions, memo: 'Other withholdings' });
  }

  return buildEntry({
    onDate: input.onDate,
    source: 'payroll_finalized',
    sourceKey: `payroll_finalized:${input.periodId}`,
    reference: { type: 'payroll_period', id: input.periodId, label: input.periodLabel },
    memo: `${input.periodLabel} payroll finalised`,
    lines,
  });
}

export function postPayrollPaid(input: {
  periodId: string;
  periodLabel: string;
  onDate: string;
  net: number;
}): BuildEntryResult {
  const net = toCents(input.net);
  if (net <= 0) return { ok: false, error: 'A payroll payment for zero cannot be posted' };

  return buildEntry({
    onDate: input.onDate,
    source: 'payroll_paid',
    sourceKey: `payroll_paid:${input.periodId}`,
    reference: { type: 'payroll_period', id: input.periodId, label: input.periodLabel },
    memo: `${input.periodLabel} payroll paid`,
    lines: [
      { accountCode: '2310', debit: net, memo: 'Payroll payable' },
      { accountCode: '1110', credit: net, memo: 'Operating account' },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Voids and adjustments
// ---------------------------------------------------------------------------------------------

/**
 * Voiding an invoice.
 *
 * A reversing entry, not a deletion. The original stays on the books with its reversal beside it,
 * because a set of books that can lose a transaction cannot be audited.
 */
export function postInvoiceVoid(input: {
  invoiceId: string;
  invoiceNumber: string;
  onDate: string;
  billToName: string;
  amount: number;
  reason: string;
}): BuildEntryResult {
  const cents = toCents(input.amount);
  if (cents <= 0) return { ok: false, error: 'There is nothing to reverse' };

  return buildEntry({
    onDate: input.onDate,
    source: 'invoice_void',
    sourceKey: `invoice_void:${input.invoiceId}`,
    reference: { type: 'invoice', id: input.invoiceId, label: input.invoiceNumber },
    memo: `${input.invoiceNumber} voided — ${input.reason}`,
    lines: [
      { accountCode: '4100', debit: cents, memo: 'Revenue reversed' },
      { accountCode: '1200', credit: cents, memo: 'Accounts receivable reversed' },
    ],
  });
}
