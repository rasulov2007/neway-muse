/**
 * The accounting data boundary.
 *
 * Server-shaped like the Safety boundary: page, pageSize, search, sort, filters in, `ListResult`
 * out, so the Postgres layer replaces this file and nothing above it changes.
 *
 * The writes here are the ones that matter. Every one of them posts through the shared rules and
 * refuses rather than corrupts: a payment cannot overpay an invoice, a bill cannot be paid twice, a
 * settlement cannot be edited once finalised, and nothing can post into a closed period.
 */
import {
  buildEntry,
  canPost,
  checkApplication,
  needsApproval,
  postBillPaid,
  postExpense,
  postInvoiceIssued,
  postInvoiceVoid,
  postPaymentReceived,
  postPayrollFinalized,
  postPayrollPaid,
  postSettlementFinalized,
  postSettlementPaid,
  billTransitions,
  payrollTransitions,
  settlementTransitions,
  type BillStatus,
  type BuildEntryResult,
  type JournalEntry,
  type PayrollStatus,
  type SettlementStatus,
} from '@neway/shared';
import { demoData } from './data';
import {
  appendFleetAudit,
  cloneValue,
  fleetRespond,
  nowIsoString,
  type SimulateOptions,
} from './internals';
import type { ListResult } from './api';
import type {
  Bill,
  Expense,
  InvoiceLine,
  PayrollPeriod,
  Payment,
  Payslip,
  Settlement,
  Vendor,
} from './accounting-types';
import type { Invoice, IsoDate } from './types';

// ---------------------------------------------------------------------------------------------
// Query plumbing
// ---------------------------------------------------------------------------------------------

export interface AccountingQuery extends SimulateOptions {
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  sortDir?: 'asc' | 'desc';
  ids?: string[];
  from?: IsoDate;
  to?: IsoDate;
}

const MAX_PAGE = 200;

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function matches(haystack: Array<string | null | undefined>, needle: string): boolean {
  const q = normalize(needle);
  if (!q) return true;
  return haystack.some((v) => v !== null && v !== undefined && normalize(v).includes(q));
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

function paginate<T>(rows: T[], query: AccountingQuery): ListResult<T> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.max(1, Math.min(MAX_PAGE, query.pageSize ?? 25));
  const start = (page - 1) * pageSize;
  return {
    data: cloneValue(rows.slice(start, start + pageSize)),
    total: rows.length,
    page,
    pageSize,
  };
}

function run<T extends object>(
  rows: T[],
  query: AccountingQuery,
  searchable: (row: T) => Array<string | null | undefined>,
  extra: (row: T) => boolean,
): Promise<ListResult<T>> {
  return fleetRespond(
    query,
    () => {
      let result = rows.filter(extra);
      if (query.ids && query.ids.length > 0) {
        const set = new Set(query.ids);
        result = result.filter((row) => set.has((row as { id: string }).id));
      }
      if (query.search) {
        result = result.filter((row) => matches(searchable(row), query.search ?? ''));
      }
      if (query.sort) {
        const key = query.sort as keyof T;
        result = [...result].sort((a, b) => compareValues(a[key], b[key]));
        if (query.sortDir === 'desc') result.reverse();
      }
      return paginate(result, query);
    },
    () => ({
      data: [],
      total: 0,
      page: Math.max(1, query.page ?? 1),
      pageSize: query.pageSize ?? 25,
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export function listVendors(query: AccountingQuery = {}): Promise<ListResult<Vendor>> {
  return run(
    demoData.vendors,
    query,
    (v) => [v.name, v.kind, v.city, v.state],
    () => true,
  );
}

export function listInvoiceLines(
  query: AccountingQuery & { invoiceId?: string } = {},
): Promise<ListResult<InvoiceLine>> {
  return run(
    demoData.invoiceLines,
    query,
    (l) => [l.description, l.chargeType],
    (l) => !query.invoiceId || l.invoiceId === query.invoiceId,
  );
}

export function listPayments(
  query: AccountingQuery & { direction?: 'in' | 'out'; partyId?: string } = {},
): Promise<ListResult<Payment>> {
  return run(
    demoData.payments,
    query,
    (p) => [p.reference, p.partyName, p.method],
    (p) =>
      (!query.direction || p.direction === query.direction) &&
      (!query.partyId || p.partyId === query.partyId),
  );
}

export function listBills(
  query: AccountingQuery & { vendorId?: string; status?: string; categoryCode?: string } = {},
): Promise<ListResult<Bill>> {
  return run(
    demoData.bills,
    query,
    (b) => [b.billNumber, b.vendorInvoiceNumber, b.vendorName, b.unitNumber, b.notes],
    (b) =>
      (!query.vendorId || b.vendorId === query.vendorId) &&
      (!query.status || b.status === query.status) &&
      (!query.categoryCode || b.categoryCode === query.categoryCode),
  );
}

export function listExpenses(
  query: AccountingQuery & {
    categoryCode?: string;
    truckId?: string;
    driverId?: string;
    loadId?: string;
    vendorId?: string;
  } = {},
): Promise<ListResult<Expense>> {
  return run(
    demoData.expenses,
    query,
    (e) => [e.expenseNumber, e.description, e.vendorName, e.unitNumber, e.driverName, e.loadNumber],
    (e) =>
      (!query.categoryCode || e.categoryCode === query.categoryCode) &&
      (!query.truckId || e.truckId === query.truckId) &&
      (!query.driverId || e.driverId === query.driverId) &&
      (!query.loadId || e.loadId === query.loadId) &&
      (!query.vendorId || e.vendorId === query.vendorId) &&
      (!query.from || e.onDate >= query.from) &&
      (!query.to || e.onDate <= query.to),
  );
}

export function listSettlements(
  query: AccountingQuery & { driverId?: string; status?: string } = {},
): Promise<ListResult<Settlement>> {
  return run(
    demoData.settlements,
    query,
    (s) => [s.settlementNumber, s.driverName, s.unitNumber],
    (s) =>
      (!query.driverId || s.driverId === query.driverId) &&
      (!query.status || s.status === query.status),
  );
}

export function listPayrollPeriods(
  query: AccountingQuery = {},
): Promise<ListResult<PayrollPeriod>> {
  return run(
    demoData.payrollPeriods,
    query,
    (p) => [p.periodNumber],
    () => true,
  );
}

export function listPayslips(
  query: AccountingQuery & { payrollPeriodId?: string; employeeId?: string } = {},
): Promise<ListResult<Payslip>> {
  return run(
    demoData.payslips,
    query,
    (p) => [p.employeeName, p.title],
    (p) =>
      (!query.payrollPeriodId || p.payrollPeriodId === query.payrollPeriodId) &&
      (!query.employeeId || p.employeeId === query.employeeId),
  );
}

export function listJournal(
  query: AccountingQuery & { source?: string; accountCode?: string } = {},
): Promise<ListResult<JournalEntry>> {
  return run(
    demoData.journal,
    query,
    (e) => [e.memo, e.sourceKey, e.reference?.label],
    (e) =>
      (!query.source || e.source === query.source) &&
      (!query.accountCode || e.lines.some((l) => l.accountCode === query.accountCode)) &&
      (!query.from || e.onDate >= query.from) &&
      (!query.to || e.onDate <= query.to),
  );
}

export function listLedgerPeriods(options?: SimulateOptions) {
  return fleetRespond(
    options,
    () => cloneValue(demoData.ledgerPeriods),
    () => [],
  );
}

export function listDeductionPlans(query: AccountingQuery & { driverId?: string } = {}) {
  return run(
    demoData.deductionPlans,
    query,
    (p) => [p.description, p.kind],
    (p) => !query.driverId || p.driverId === query.driverId,
  );
}

// ---------------------------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------------------------

function nextJournalId(): string {
  const highest = demoData.journal.reduce((max, e) => {
    const value = Number.parseInt(e.id.replace(/^je_/, ''), 10);
    return Number.isNaN(value) ? max : Math.max(max, value);
  }, 0);
  return `je_${String(highest + 1).padStart(5, '0')}`;
}

export interface PostResult {
  ok: boolean;
  entry: JournalEntry | null;
  blocked?: string;
}

/**
 * Commits a proposed entry to the ledger.
 *
 * Three refusals, in order: the builder must have produced a balanced entry, the period must be
 * open, and the event must not already have posted. The last one is what stops a retried click
 * doubling revenue.
 */
function commit(result: BuildEntryResult, by: string): PostResult {
  if (!result.ok) return { ok: false, entry: null, blocked: result.error };

  const period = canPost(result.entry.onDate, demoData.ledgerPeriods);
  if (!period.allowed)
    return { ok: false, entry: null, blocked: period.reason ?? 'Period is closed' };

  if (demoData.journal.some((e) => e.sourceKey === result.entry.sourceKey)) {
    return {
      ok: false,
      entry: null,
      blocked: 'That event has already been posted; posting it again would double the money',
    };
  }

  const entry: JournalEntry = {
    ...result.entry,
    id: nextJournalId(),
    postedAt: nowIsoString(),
    postedBy: by,
  };
  demoData.journal.unshift(entry);
  return { ok: true, entry: cloneValue(entry) };
}

// ---------------------------------------------------------------------------------------------
// Invoice writes
// ---------------------------------------------------------------------------------------------

export interface IssueInvoiceInput {
  invoiceId: string;
  by?: string;
}

/** Issues a draft invoice: it becomes a receivable and revenue is recognised. */
export function issueInvoice(
  input: IssueInvoiceInput,
  options?: SimulateOptions,
): Promise<{ ok: boolean; invoice: Invoice | null; blocked?: string }> {
  return fleetRespond(
    options,
    () => {
      const invoice = demoData.invoices.find((i) => i.id === input.invoiceId);
      if (!invoice) return { ok: false, invoice: null, blocked: 'That invoice no longer exists' };
      if (invoice.status !== 'draft') {
        return {
          ok: false,
          invoice: cloneValue(invoice),
          blocked: `${invoice.invoiceNumber} has already been issued`,
        };
      }

      const lines = demoData.invoiceLines.filter((l) => l.invoiceId === invoice.id);
      const issuedOn = nowIsoString().slice(0, 10);

      const posted = commit(
        postInvoiceIssued({
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          issuedOn,
          billToName: invoice.billToName,
          lines: lines.map((l) => ({
            chargeType: l.chargeType,
            description: l.description,
            amount: l.amount,
          })),
        }),
        input.by ?? 'Accounting',
      );
      if (!posted.ok) return { ok: false, invoice: cloneValue(invoice), blocked: posted.blocked };

      invoice.status = 'issued';
      invoice.issuedOn = issuedOn;
      invoice.dueOn = new Date(
        Date.parse(`${issuedOn}T00:00:00Z`) + invoice.paymentTermsDays * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);

      appendFleetAudit({
        by: input.by,
        action: 'status_changed',
        entity: { type: 'invoice', id: invoice.id, label: invoice.invoiceNumber },
        subject: 'Invoice',
        before: 'Draft',
        after: 'Issued',
        reason: `Posted to the ledger as ${posted.entry?.id}`,
      });

      return { ok: true, invoice: cloneValue(invoice) };
    },
    () => ({ ok: false, invoice: null, blocked: 'The invoice could not be issued' }),
  );
}

export interface VoidInvoiceInput {
  invoiceId: string;
  reason: string;
  by?: string;
}

/** Voids an invoice with a reversing entry. Never a deletion — books that lose a row cannot be audited. */
export function voidInvoice(
  input: VoidInvoiceInput,
  options?: SimulateOptions,
): Promise<{ ok: boolean; invoice: Invoice | null; blocked?: string }> {
  return fleetRespond(
    options,
    () => {
      const invoice = demoData.invoices.find((i) => i.id === input.invoiceId);
      if (!invoice) return { ok: false, invoice: null, blocked: 'That invoice no longer exists' };
      if (invoice.paid > 0) {
        return {
          ok: false,
          invoice: cloneValue(invoice),
          blocked: `${invoice.invoiceNumber} has ${invoice.paid.toFixed(2)} applied to it. Reverse the payment before voiding it.`,
        };
      }
      if (!input.reason.trim()) {
        return { ok: false, invoice: cloneValue(invoice), blocked: 'A void needs a reason' };
      }

      if (invoice.status !== 'draft') {
        const posted = commit(
          postInvoiceVoid({
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            onDate: nowIsoString().slice(0, 10),
            billToName: invoice.billToName,
            amount: invoice.total,
            reason: input.reason.trim(),
          }),
          input.by ?? 'Accounting',
        );
        if (!posted.ok) return { ok: false, invoice: cloneValue(invoice), blocked: posted.blocked };
      }

      const before = invoice.status;
      invoice.status = 'void';
      invoice.balance = 0;

      appendFleetAudit({
        by: input.by,
        action: 'status_changed',
        entity: { type: 'invoice', id: invoice.id, label: invoice.invoiceNumber },
        subject: 'Invoice',
        before,
        after: 'Void',
        reason: input.reason.trim(),
      });

      return { ok: true, invoice: cloneValue(invoice) };
    },
    () => ({ ok: false, invoice: null, blocked: 'The invoice could not be voided' }),
  );
}

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

export interface RecordPaymentInput {
  partyType: Payment['partyType'];
  partyId: string;
  partyName: string;
  amount: number;
  method: Payment['method'];
  receivedOn: IsoDate;
  reference: string;
  applications: Array<{ invoiceId: string; amount: number }>;
  notes?: string | null;
  by?: string;
}

/**
 * Records a customer payment and applies it.
 *
 * Refuses before it writes anything: over-applying to an invoice, applying more than was received,
 * or naming the same invoice twice all abort the whole payment rather than partially applying it.
 * A half-applied payment is worse than a rejected one, because nobody knows which half.
 */
export function recordPayment(
  input: RecordPaymentInput,
  options?: SimulateOptions,
): Promise<{ ok: boolean; payment: Payment | null; blocked?: string }> {
  return fleetRespond(
    options,
    () => {
      const targets = input.applications
        .map((a) => demoData.invoices.find((i) => i.id === a.invoiceId))
        .filter((i): i is Invoice => i !== undefined)
        .map((i) => ({ invoiceId: i.id, invoiceNumber: i.invoiceNumber, balance: i.balance }));

      const check = checkApplication(input.amount, input.applications, targets);
      if (!check.ok) {
        return { ok: false, payment: null, blocked: check.errors.join('. ') };
      }

      const highest = demoData.payments.reduce((max, p) => {
        const value = Number.parseInt(p.id.replace(/^pay_/, ''), 10);
        return Number.isNaN(value) ? max : Math.max(max, value);
      }, 0);
      const paymentId = `pay_${String(highest + 1).padStart(4, '0')}`;

      const posted = commit(
        postPaymentReceived({
          paymentId,
          reference: input.reference,
          receivedOn: input.receivedOn,
          partyName: input.partyName,
          appliedAmount: check.applied,
          unappliedAmount: check.unapplied,
        }),
        input.by ?? 'Accounting',
      );
      if (!posted.ok) return { ok: false, payment: null, blocked: posted.blocked };

      const at = nowIsoString();
      const payment: Payment = {
        id: paymentId,
        direction: 'in',
        partyType: input.partyType,
        partyId: input.partyId,
        partyName: input.partyName,
        amount: input.amount,
        method: input.method,
        receivedOn: input.receivedOn,
        reference: input.reference.trim(),
        unappliedAmount: check.unapplied,
        applications: input.applications.map((a, index) => ({
          id: `pap_${paymentId}_${index + 1}`,
          paymentId,
          invoiceId: a.invoiceId,
          billId: null,
          amount: a.amount,
          appliedAt: at,
        })),
        notes: input.notes?.trim() ? input.notes.trim() : null,
        createdAt: at,
        createdBy: input.by ?? 'Accounting',
      };
      demoData.payments.unshift(payment);

      for (const application of payment.applications) {
        const invoice = demoData.invoices.find((i) => i.id === application.invoiceId);
        if (!invoice) continue;
        invoice.paid = Math.round((invoice.paid + application.amount) * 100) / 100;
        invoice.balance = Math.round((invoice.total - invoice.paid) * 100) / 100;
        invoice.status = invoice.balance <= 0 ? 'paid' : 'partially_paid';
        if (invoice.balance <= 0) invoice.paidOn = input.receivedOn;

        appendFleetAudit({
          by: input.by,
          action: 'status_changed',
          entity: { type: 'invoice', id: invoice.id, label: invoice.invoiceNumber },
          subject: 'Payment applied',
          before: null,
          after: `$${application.amount.toFixed(2)}`,
          reason: `${payment.reference} from ${payment.partyName}`,
        });
      }

      return { ok: true, payment: cloneValue(payment) };
    },
    () => ({ ok: false, payment: null, blocked: 'The payment could not be recorded' }),
  );
}

// ---------------------------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------------------------

export interface UpdateBillInput {
  billId: string;
  status?: BillStatus;
  scheduledFor?: IsoDate | null;
  reason?: string | null;
  by?: string;
}

export function updateBill(
  input: UpdateBillInput,
  options?: SimulateOptions,
): Promise<{ ok: boolean; bill: Bill | null; blocked?: string }> {
  return fleetRespond(
    options,
    () => {
      const bill = demoData.bills.find((b) => b.id === input.billId);
      if (!bill) return { ok: false, bill: null, blocked: 'That bill no longer exists' };

      if (input.status && input.status !== bill.status) {
        if (!billTransitions(bill.status).includes(input.status)) {
          return {
            ok: false,
            bill: cloneValue(bill),
            blocked: `A ${bill.status.replace(/_/g, ' ')} bill cannot move straight to ${input.status.replace(/_/g, ' ')}`,
          };
        }
        const before = bill.status;
        bill.status = input.status;
        if (input.status === 'open' && before === 'pending_approval') {
          bill.approvedAt = nowIsoString();
          bill.approvedBy = input.by ?? 'Accounting';
        }

        appendFleetAudit({
          by: input.by,
          action: 'status_changed',
          entity: { type: 'invoice', id: bill.id, label: bill.billNumber },
          subject: 'Bill status',
          before,
          after: input.status,
          reason: input.reason ?? `${bill.billNumber} moved to ${input.status.replace(/_/g, ' ')}`,
        });
      }

      if (input.scheduledFor !== undefined) bill.scheduledFor = input.scheduledFor;
      return { ok: true, bill: cloneValue(bill) };
    },
    () => ({ ok: false, bill: null, blocked: 'The bill could not be updated' }),
  );
}

export interface PayBillInput {
  billId: string;
  amount: number;
  method: Payment['method'];
  paidOn: IsoDate;
  reference: string;
  by?: string;
}

export function payBill(
  input: PayBillInput,
  options?: SimulateOptions,
): Promise<{ ok: boolean; bill: Bill | null; blocked?: string }> {
  return fleetRespond(
    options,
    () => {
      const bill = demoData.bills.find((b) => b.id === input.billId);
      if (!bill) return { ok: false, bill: null, blocked: 'That bill no longer exists' };
      if (bill.status === 'pending_approval') {
        return {
          ok: false,
          bill: cloneValue(bill),
          blocked: `${bill.billNumber} has not been approved yet`,
        };
      }
      if (input.amount <= 0) {
        return {
          ok: false,
          bill: cloneValue(bill),
          blocked: 'A payment must be for a positive amount',
        };
      }
      if (Math.round(input.amount * 100) > Math.round(bill.balance * 100)) {
        return {
          ok: false,
          bill: cloneValue(bill),
          blocked: `${bill.billNumber} has a balance of $${bill.balance.toFixed(2)}; paying $${input.amount.toFixed(2)} would overpay it`,
        };
      }

      const highest = demoData.payments.reduce((max, p) => {
        const value = Number.parseInt(p.id.replace(/^pay_/, ''), 10);
        return Number.isNaN(value) ? max : Math.max(max, value);
      }, 0);
      const paymentId = `pay_${String(highest + 1).padStart(4, '0')}`;

      const posted = commit(
        postBillPaid({
          paymentId,
          reference: input.reference,
          paidOn: input.paidOn,
          vendorName: bill.vendorName,
          amount: input.amount,
        }),
        input.by ?? 'Accounting',
      );
      if (!posted.ok) return { ok: false, bill: cloneValue(bill), blocked: posted.blocked };

      const at = nowIsoString();
      demoData.payments.unshift({
        id: paymentId,
        direction: 'out',
        partyType: 'vendor',
        partyId: bill.vendorId,
        partyName: bill.vendorName,
        amount: input.amount,
        method: input.method,
        receivedOn: input.paidOn,
        reference: input.reference.trim(),
        unappliedAmount: 0,
        applications: [
          {
            id: `pap_${paymentId}_1`,
            paymentId,
            invoiceId: null,
            billId: bill.id,
            amount: input.amount,
            appliedAt: at,
          },
        ],
        notes: null,
        createdAt: at,
        createdBy: input.by ?? 'Accounting',
      });

      bill.paid = Math.round((bill.paid + input.amount) * 100) / 100;
      bill.balance = Math.round((bill.amount - bill.paid) * 100) / 100;
      bill.status = bill.balance <= 0 ? 'paid' : 'partially_paid';

      appendFleetAudit({
        by: input.by,
        action: 'status_changed',
        entity: { type: 'invoice', id: bill.id, label: bill.billNumber },
        subject: 'Bill payment',
        before: null,
        after: `$${input.amount.toFixed(2)}`,
        reason: `${input.reference} to ${bill.vendorName}`,
      });

      return { ok: true, bill: cloneValue(bill) };
    },
    () => ({ ok: false, bill: null, blocked: 'The payment could not be recorded' }),
  );
}

export interface CreateBillInput {
  vendorId: string;
  vendorInvoiceNumber: string | null;
  issuedOn: IsoDate;
  amount: number;
  categoryCode: string;
  truckId: string | null;
  loadId: string | null;
  notes: string | null;
  by?: string;
}

export function createBill(input: CreateBillInput, options?: SimulateOptions): Promise<Bill> {
  return fleetRespond(
    options,
    () => {
      const vendor = demoData.vendors.find((v) => v.id === input.vendorId);
      if (!vendor) throw new Error('That vendor is not on file');
      if (input.amount <= 0) throw new Error('A bill must be for a positive amount');

      const highest = demoData.bills.reduce((max, b) => {
        const value = Number.parseInt(b.id.replace(/^bil_/, ''), 10);
        return Number.isNaN(value) ? max : Math.max(max, value);
      }, 0);
      const seq = highest + 1;
      const truck = input.truckId ? demoData.trucks.find((t) => t.id === input.truckId) : undefined;
      const load = input.loadId ? demoData.loads.find((l) => l.id === input.loadId) : undefined;
      const approval = needsApproval(
        { amount: input.amount, vendorId: vendor.id },
        new Set(demoData.vendors.map((v) => v.id)),
      );

      const bill: Bill = {
        id: `bil_${String(seq).padStart(4, '0')}`,
        billNumber: `AP-${String(seq).padStart(4, '0')}`,
        vendorInvoiceNumber: input.vendorInvoiceNumber?.trim() || null,
        vendorId: vendor.id,
        vendorName: vendor.name,
        issuedOn: input.issuedOn,
        dueOn: new Date(
          Date.parse(`${input.issuedOn}T00:00:00Z`) + vendor.paymentTermsDays * 86_400_000,
        )
          .toISOString()
          .slice(0, 10),
        paymentTermsDays: vendor.paymentTermsDays,
        amount: input.amount,
        paid: 0,
        balance: input.amount,
        // A bill needing approval opens there rather than as payable, so nothing schedules it early.
        status: approval.required ? 'pending_approval' : 'open',
        categoryCode: input.categoryCode,
        source: 'manual',
        sourceId: null,
        truckId: truck?.id ?? null,
        unitNumber: truck?.unitNumber ?? null,
        trailerId: null,
        loadId: load?.id ?? null,
        loadNumber: load?.loadNumber ?? null,
        approvedAt: approval.required ? null : nowIsoString(),
        approvedBy: approval.required ? null : (input.by ?? 'Accounting'),
        approvalReason: approval.reason,
        scheduledFor: null,
        notes: input.notes?.trim() || null,
        createdAt: nowIsoString(),
      };
      demoData.bills.unshift(bill);

      appendFleetAudit({
        by: input.by,
        action: 'status_changed',
        entity: { type: 'invoice', id: bill.id, label: bill.billNumber },
        subject: 'Bill',
        before: null,
        after: bill.status,
        reason: `${bill.billNumber} from ${vendor.name} for $${input.amount.toFixed(2)}`,
      });

      return cloneValue(bill);
    },
    () => {
      throw new Error('The bill could not be created');
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------------------------

export interface CreateExpenseInput {
  onDate: IsoDate;
  categoryCode: string;
  description: string;
  amount: number;
  truckId: string | null;
  driverId: string | null;
  loadId: string | null;
  vendorId: string | null;
  paymentMethod: Payment['method'] | null;
  paidDirectly: boolean;
  notes: string | null;
  by?: string;
}

export function createExpense(
  input: CreateExpenseInput,
  options?: SimulateOptions,
): Promise<{ ok: boolean; expense: Expense | null; blocked?: string }> {
  return fleetRespond(
    options,
    () => {
      if (input.amount <= 0) {
        return { ok: false, expense: null, blocked: 'An expense must be for a positive amount' };
      }

      const highest = demoData.expenses.reduce((max, e) => {
        const value = Number.parseInt(e.id.replace(/^exp_/, ''), 10);
        return Number.isNaN(value) ? max : Math.max(max, value);
      }, 0);
      const seq = highest + 1;
      const id = `exp_${String(seq).padStart(5, '0')}`;

      const posted = commit(
        postExpense({
          expenseId: id,
          expenseNumber: `EX-${String(seq).padStart(5, '0')}`,
          onDate: input.onDate,
          description: input.description,
          categoryCode: input.categoryCode,
          amount: input.amount,
          paidDirectly: input.paidDirectly,
        }),
        input.by ?? 'Accounting',
      );
      if (!posted.ok) return { ok: false, expense: null, blocked: posted.blocked };

      const truck = input.truckId ? demoData.trucks.find((t) => t.id === input.truckId) : undefined;
      const driver = input.driverId
        ? demoData.drivers.find((d) => d.id === input.driverId)
        : undefined;
      const load = input.loadId ? demoData.loads.find((l) => l.id === input.loadId) : undefined;
      const vendor = input.vendorId
        ? demoData.vendors.find((v) => v.id === input.vendorId)
        : undefined;

      const expense: Expense = {
        id,
        expenseNumber: `EX-${String(seq).padStart(5, '0')}`,
        onDate: input.onDate,
        categoryCode: input.categoryCode,
        description: input.description.trim(),
        amount: input.amount,
        truckId: truck?.id ?? null,
        unitNumber: truck?.unitNumber ?? null,
        trailerId: null,
        driverId: driver?.id ?? null,
        driverName: driver?.name ?? null,
        loadId: load?.id ?? null,
        loadNumber: load?.loadNumber ?? null,
        vendorId: vendor?.id ?? null,
        vendorName: vendor?.name ?? null,
        source: 'manual',
        sourceId: null,
        billId: null,
        paymentMethod: input.paymentMethod,
        accountCode: posted.entry?.lines.find((l) => l.debit > 0)?.accountCode ?? '6900',
        status: 'posted',
        postedAt: nowIsoString(),
        notes: input.notes?.trim() || null,
      };
      demoData.expenses.unshift(expense);

      return { ok: true, expense: cloneValue(expense) };
    },
    () => ({ ok: false, expense: null, blocked: 'The expense could not be recorded' }),
  );
}

// ---------------------------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------------------------

export interface UpdateSettlementInput {
  settlementId: string;
  status: SettlementStatus;
  by?: string;
  reason?: string | null;
}

/**
 * Moves a settlement through its lifecycle, posting where the transition has an accounting meaning.
 *
 * `finalized` recognises the driver-pay cost and the liability; `paid` discharges it. Both post
 * once, keyed on the settlement, so a double click cannot pay a driver twice.
 */
export function updateSettlement(
  input: UpdateSettlementInput,
  options?: SimulateOptions,
): Promise<{ ok: boolean; settlement: Settlement | null; blocked?: string }> {
  return fleetRespond(
    options,
    () => {
      const settlement = demoData.settlements.find((s) => s.id === input.settlementId);
      if (!settlement) return { ok: false, settlement: null, blocked: 'That settlement is gone' };
      if (!settlementTransitions(settlement.status).includes(input.status)) {
        return {
          ok: false,
          settlement: cloneValue(settlement),
          blocked: `A ${settlement.status.replace(/_/g, ' ')} settlement cannot move to ${input.status.replace(/_/g, ' ')}`,
        };
      }

      const onDate = nowIsoString().slice(0, 10);
      if (input.status === 'finalized') {
        const posted = commit(
          postSettlementFinalized({
            settlementId: settlement.id,
            settlementNumber: settlement.settlementNumber,
            onDate,
            driverName: settlement.driverName,
            gross: settlement.gross,
            deductions: settlement.deductions,
            escrow: settlement.escrow,
            net: settlement.net,
          }),
          input.by ?? 'Accounting',
        );
        if (!posted.ok) {
          return { ok: false, settlement: cloneValue(settlement), blocked: posted.blocked };
        }
        settlement.finalizedAt = nowIsoString();
        settlement.finalizedBy = input.by ?? 'Accounting';
      }

      if (input.status === 'paid') {
        const posted = commit(
          postSettlementPaid({
            settlementId: settlement.id,
            settlementNumber: settlement.settlementNumber,
            onDate,
            driverName: settlement.driverName,
            net: settlement.net,
          }),
          input.by ?? 'Accounting',
        );
        if (!posted.ok) {
          return { ok: false, settlement: cloneValue(settlement), blocked: posted.blocked };
        }
        settlement.paidAt = nowIsoString();
      }

      const before = settlement.status;
      settlement.status = input.status;

      appendFleetAudit({
        by: input.by,
        action: 'status_changed',
        entity: { type: 'driver', id: settlement.driverId, label: settlement.driverName },
        subject: 'Settlement',
        before,
        after: input.status,
        reason: input.reason ?? `${settlement.settlementNumber} → ${input.status}`,
      });

      return { ok: true, settlement: cloneValue(settlement) };
    },
    () => ({ ok: false, settlement: null, blocked: 'The settlement could not be updated' }),
  );
}

// ---------------------------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------------------------

export interface UpdatePayrollInput {
  periodId: string;
  status: PayrollStatus;
  by?: string;
}

export function updatePayrollPeriod(
  input: UpdatePayrollInput,
  options?: SimulateOptions,
): Promise<{ ok: boolean; period: PayrollPeriod | null; blocked?: string }> {
  return fleetRespond(
    options,
    () => {
      const period = demoData.payrollPeriods.find((p) => p.id === input.periodId);
      if (!period) return { ok: false, period: null, blocked: 'That payroll period is gone' };
      if (!payrollTransitions(period.status).includes(input.status)) {
        return {
          ok: false,
          period: cloneValue(period),
          blocked: `A ${period.status} period cannot move to ${input.status}`,
        };
      }

      const onDate = nowIsoString().slice(0, 10);
      if (input.status === 'finalized') {
        const posted = commit(
          postPayrollFinalized({
            periodId: period.id,
            periodLabel: `${period.periodStart} – ${period.periodEnd}`,
            onDate,
            gross: period.gross,
            taxWithheld: period.taxWithheld,
            deductions: period.deductions,
            net: period.net,
          }),
          input.by ?? 'Accounting',
        );
        if (!posted.ok) return { ok: false, period: cloneValue(period), blocked: posted.blocked };
        period.finalizedAt = nowIsoString();
        period.finalizedBy = input.by ?? 'Accounting';
        // Finalised payslips lock; from here only an adjustment can change one.
        for (const slip of demoData.payslips) {
          if (slip.payrollPeriodId === period.id) slip.locked = true;
        }
      }

      if (input.status === 'paid') {
        const posted = commit(
          postPayrollPaid({
            periodId: period.id,
            periodLabel: `${period.periodStart} – ${period.periodEnd}`,
            onDate,
            net: period.net,
          }),
          input.by ?? 'Accounting',
        );
        if (!posted.ok) return { ok: false, period: cloneValue(period), blocked: posted.blocked };
        period.paidAt = nowIsoString();
      }

      if (input.status === 'closed') period.closedAt = nowIsoString();

      const before = period.status;
      period.status = input.status;

      appendFleetAudit({
        by: input.by,
        action: 'status_changed',
        entity: { type: 'company', id: period.id, label: period.periodNumber },
        subject: 'Payroll period',
        before,
        after: input.status,
        reason: `${period.periodNumber} → ${input.status}`,
      });

      return { ok: true, period: cloneValue(period) };
    },
    () => ({ ok: false, period: null, blocked: 'The payroll period could not be updated' }),
  );
}

// ---------------------------------------------------------------------------------------------
// Manual journal entry and period close
// ---------------------------------------------------------------------------------------------

export interface JournalEntryInput {
  onDate: IsoDate;
  memo: string;
  lines: Array<{ accountCode: string; debit?: number; credit?: number; memo?: string }>;
  by?: string;
}

/** A manual adjustment. Refused unless it balances, exactly like every other posting. */
export function postJournalEntry(
  input: JournalEntryInput,
  options?: SimulateOptions,
): Promise<PostResult> {
  return fleetRespond(
    options,
    () =>
      commit(
        buildEntry({
          onDate: input.onDate,
          source: 'adjustment',
          sourceKey: `adjustment:${input.onDate}:${input.memo}:${Date.now()}`,
          memo: input.memo.trim(),
          lines: input.lines.map((l) => ({
            accountCode: l.accountCode,
            debit: l.debit === undefined ? undefined : Math.round(l.debit * 100),
            credit: l.credit === undefined ? undefined : Math.round(l.credit * 100),
            memo: l.memo,
          })),
        }),
        input.by ?? 'Accounting',
      ),
    () => ({ ok: false, entry: null, blocked: 'The entry could not be posted' }),
  );
}

export function closeLedgerPeriod(
  input: { periodId: string; by?: string },
  options?: SimulateOptions,
) {
  return fleetRespond(
    options,
    () => {
      const period = demoData.ledgerPeriods.find((p) => p.id === input.periodId);
      if (!period) return { ok: false, blocked: 'That period does not exist' };
      if (period.status === 'closed' || period.status === 'locked') {
        return { ok: false, blocked: `${period.id} is already ${period.status}` };
      }
      period.status = 'closed';
      period.closedAt = nowIsoString();
      period.closedBy = input.by ?? 'Accounting';

      appendFleetAudit({
        by: input.by,
        action: 'status_changed',
        entity: { type: 'company', id: period.id, label: period.id },
        subject: 'Ledger period',
        before: 'Open',
        after: 'Closed',
        reason: `${period.id} closed; postings into it are now refused`,
      });

      return { ok: true, blocked: undefined };
    },
    () => ({ ok: false, blocked: 'The period could not be closed' }),
  );
}
