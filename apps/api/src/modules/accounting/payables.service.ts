import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { billTransitions, canPost, needsApproval, postBill, postBillPaid, postExpense, reimbursableCents, type BillStatus, type ReimbursementBlock } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { truckDriverAssignments, trucks, vendors, workOrders } from '../../database/schema';
import { AuditService } from '../people/audit.service';
import { StateService } from '../state/state.service';
import { newId, unprocessable } from '../dispatch-board/ops.helpers';
import { DriverAccountsService } from './driver-accounts.service';
import { LedgerService } from './ledger.service';
import { AccountingStore } from './store.service';

/**
 * Expenses, Accounts Payable and the imports that feed them (§6).
 *
 * One economic transaction is one record: a repair order becomes one bill (source key
 * `work_order:<id>`), a Relay fuel line one expense (`relay:<id>`) and - when the driver's
 * switches say so - one driver charge that links back to it. Paying the bill or recovering the
 * charge never creates a second expense.
 */

export interface VendorRecord {
  id: string;
  name: string;
  kind: string;
  city: string;
  state: string;
  paymentTermsDays: number;
  status: 'active' | 'inactive';
  defaultCategory: string;
  contactName: string | null;
  contactEmail: string | null;
  source: 'table' | 'workspace';
}

export interface BillRecord {
  id: string;
  sourceKey: string;
  billNumber: string;
  vendorInvoiceNumber: string | null;
  vendorId: string;
  vendorName: string;
  issuedOn: string;
  dueOn: string;
  paymentTermsDays: number;
  amount: number;
  paid: number;
  balance: number;
  status: BillStatus;
  categoryCode: string;
  source: 'repair_order' | 'fuel' | 'tolls' | 'lease' | 'manual' | 'fleet_expense';
  sourceId: string | null;
  truckId: string | null;
  unitNumber: string | null;
  trailerId: string | null;
  loadId: string | null;
  loadNumber: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  approvalReason: string | null;
  scheduledFor: string | null;
  notes: string | null;
  attachments: Array<{ fileId: string; fileName: string }>;
  disputes: Array<{ at: string; by: string; reason: string; resolvedAt: string | null }>;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseRecord {
  id: string;
  sourceKey: string;
  expenseNumber: string;
  onDate: string;
  /** The accounting date, when it differs from the occurrence. */
  accountingDate: string;
  categoryCode: string;
  description: string;
  amount: number;
  currency: string;
  provider: string | null;
  truckId: string | null;
  unitNumber: string | null;
  trailerId: string | null;
  driverId: string | null;
  driverName: string | null;
  loadId: string | null;
  loadNumber: string | null;
  vendorId: string | null;
  vendorName: string | null;
  source: 'manual' | 'fuel' | 'maintenance' | 'tolls' | 'payroll' | 'settlement' | 'allocation' | 'import' | 'recruiting';
  sourceId: string | null;
  billId: string | null;
  paymentMethod: string | null;
  payer: 'company' | 'driver' | 'vendor';
  /** Who finally bears it: the company, or recoverable from a driver / vendor. */
  burden: 'company_borne' | 'recoverable_driver' | 'recoverable_vendor';
  chargeRecipientId: string | null;
  /** Explicit shares of one source transaction; their total never exceeds the amount. */
  allocations: Array<{ partyType: 'driver' | 'vendor' | 'truck' | 'load'; partyId: string; amount: number }>;
  driverTransactionId: string | null;
  receiptFileId: string | null;
  /**
   * Set when a driver funded some or all of this cost out of their own pocket.
   *
   * A reimbursement is this same expense seen from the driver's side; it is not a record of its
   * own, so the receipt, the load, the truck and the single posting are shared and nothing is
   * ever expensed twice.
   */
  reimbursement: ReimbursementBlock | null;
  accountCode: string;
  status: 'draft' | 'posted' | 'void';
  postedAt: string | null;
  notes: string | null;
  /** A voided expense is kept with its reversing journal entry beside it; nothing is deleted. */
  voidedAt?: string | null;
  voidedBy?: string | null;
  voidReason?: string | null;
  reversalEntryId?: string | null;
}

export interface ImportRecord {
  id: string;
  provider: 'relay' | 'bestpass' | 'efs' | 'csv';
  sourceKey: string;
  occurredOn: string;
  amountCents: number;
  state: 'matched' | 'unmatched' | 'ignored';
  cardOrUnit: string | null;
  truckId: string | null;
  unitNumber: string | null;
  driverId: string | null;
  driverName: string | null;
  description: string;
  kind: 'fuel' | 'tolls' | 'advance' | 'other';
  /** EFS "driver charge" flag on the line: proposes a recoverable draft, never debits silently. */
  driverChargeIndicator: boolean;
  expenseId: string | null;
  driverTransactionId: string | null;
  raw: Record<string, string>;
  problems: string[];
  importedAt: string;
  importedBy: string;
}

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

const PROVIDER_KIND: Record<ImportRecord['provider'], ImportRecord['kind']> = { relay: 'fuel', bestpass: 'tolls', efs: 'advance', csv: 'other' };

@Injectable()
export class PayablesService {
  constructor(
    private readonly store: AccountingStore,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly state: StateService,
    private readonly driverAccounts: DriverAccountsService,
  ) {}

  clock: () => Date = () => new Date();

  // ------------------------------------------------------------ vendors

  /** The vendors table plus the workspace's older vendor list, one list, table first. */
  async vendors(principal: Principal): Promise<VendorRecord[]> {
    const rows = await this.store.db.select().from(vendors).where(eq(vendors.companyId, principal.companyId));
    const fromTable: VendorRecord[] = rows.map((v) => ({ id: v.id, name: v.name, kind: v.kind, city: v.city ?? '', state: v.state ?? '', paymentTermsDays: v.paymentTermsDays ?? 30, status: (v.status as 'active' | 'inactive') ?? 'active', defaultCategory: v.kind === 'fuel' ? 'fuel' : v.kind === 'tolls' ? 'tolls' : 'maintenance', contactName: null, contactEmail: null, source: 'table' }));
    const ws = await this.state.workspace(principal.companyId);
    const legacy = ((ws?.data['vendors'] as VendorRecord[] | undefined) ?? []).filter((v) => !fromTable.some((t) => t.id === v.id)).map((v) => ({ ...v, source: 'workspace' as const }));
    return [...fromTable, ...legacy].sort((a, b) => a.name.localeCompare(b.name));
  }

  // ------------------------------------------------------------ bills

  async bills(principal: Principal): Promise<BillRecord[]> {
    return (await this.store.list<BillRecord>('acct_bills', principal.companyId)).map((r) => r.record);
  }

  private async nextBillNumber(companyId: string): Promise<string> {
    const rows = (await this.store.db.execute(sql`select count(*)::int as n from acct_bills where company_id = ${companyId}`)) as unknown as Array<{ n: number }>;
    return `AP-${String((Number(rows[0]?.n) || 0) + 1).padStart(5, '0')}`;
  }

  async createBill(principal: Principal, input: { vendorId: string; vendorInvoiceNumber: string | null; issuedOn: string; amount: number; categoryCode: string; truckId: string | null; loadId: string | null; notes: string | null; attachments?: Array<{ fileId: string; fileName: string }>; source?: BillRecord['source']; sourceId?: string | null; unitNumber?: string | null }): Promise<{ bill: BillRecord; created: boolean }> {
    const vendor = (await this.vendors(principal)).find((v) => v.id === input.vendorId);
    if (!vendor) throw unprocessable('That vendor is not on file.');
    if (input.amount <= 0) throw unprocessable('A bill must be for a positive amount.');
    const approval = needsApproval({ amount: input.amount, vendorId: vendor.id }, new Set([vendor.id]));
    const now = this.clock().toISOString();
    const id = newId('bil');
    const source = input.source ?? 'manual';
    const bill: BillRecord = {
      id,
      sourceKey: input.sourceId ? `${source}:${input.sourceId}` : `manual:${id}`,
      billNumber: await this.nextBillNumber(principal.companyId),
      vendorInvoiceNumber: input.vendorInvoiceNumber?.trim() || null,
      vendorId: vendor.id,
      vendorName: vendor.name,
      issuedOn: input.issuedOn,
      dueOn: new Date(Date.parse(`${input.issuedOn}T00:00:00Z`) + vendor.paymentTermsDays * 86_400_000).toISOString().slice(0, 10),
      paymentTermsDays: vendor.paymentTermsDays,
      amount: money(input.amount),
      paid: 0,
      balance: money(input.amount),
      status: approval.required ? 'pending_approval' : 'open',
      categoryCode: input.categoryCode,
      source,
      sourceId: input.sourceId ?? null,
      truckId: input.truckId,
      unitNumber: input.unitNumber ?? null,
      trailerId: null,
      loadId: input.loadId,
      loadNumber: null,
      approvedAt: approval.required ? null : now,
      approvedBy: approval.required ? null : (principal.userName ?? principal.userId),
      approvalReason: approval.reason,
      scheduledFor: null,
      notes: input.notes?.trim() || null,
      attachments: input.attachments ?? [],
      disputes: [],
      createdAt: now,
      updatedAt: now,
    };
    const { stored, created } = await this.store.insert('acct_bills', principal.companyId, bill);
    if (!created) return { bill: stored.record, created: false };
    const posted = await this.ledger.commit(principal, postBill({ billId: id, billNumber: bill.billNumber, issuedOn: bill.issuedOn, vendorName: vendor.name, categoryCode: bill.categoryCode, amount: bill.amount }));
    if (!posted.ok) {
      // The bill stands as a document; the posting is retried when the period opens.
      await this.audit.write(principal, { action: 'bill_unposted', entityType: 'bill', entityId: id, entityLabel: bill.billNumber, summary: `${bill.billNumber} recorded but not posted: ${posted.blocked}`, changes: [] });
    }
    await this.audit.write(principal, { action: 'bill_created', entityType: 'bill', entityId: id, entityLabel: bill.billNumber, summary: `${bill.billNumber} from ${vendor.name} for $${bill.amount.toFixed(2)} (${source})`, changes: [] });
    return { bill, created: true };
  }

  /** Completed repair orders with an invoice total that have no bill yet (§6): preview, then create. */
  /**
   * Completed repair orders as bill candidates. A completed repair does not prove the vendor is
   * still owed: the candidate says whether a bill already exists (and its status), whether Fleet
   * already posted the cost as an expense, whether the total is the invoice's or an estimate, and
   * distinguishes "no vendor / no amount" from a genuine zero-cost repair (warranty, in-house).
   */
  async workOrderBillCandidates(principal: Principal): Promise<Array<{ workOrderId: string; number: string; unitNumber: string; vendorId: string | null; vendorName: string | null; completedAt: string | null; total: number; amountSource: 'invoice' | 'work_order' | 'none'; hasBill: boolean; billId: string | null; billNumber: string | null; billStatus: string | null; expensePosted: boolean; documentCount: number; problems: string[]; reviewReason: string | null }>> {
    const rows = await this.store.db.select().from(workOrders).where(and(eq(workOrders.companyId, principal.companyId), eq(workOrders.status, 'completed'), isNull(workOrders.voidedAt)));
    const bills = await this.bills(principal);
    const posted = new Set((await this.store.list<ExpenseRecord>('acct_expenses', principal.companyId, sql`source = 'maintenance'`)).map((e) => e.record.sourceId));
    return rows
      .map((w) => {
        const invoiceTotal = w.invoiceTotal === null || w.invoiceTotal === undefined ? null : Number(w.invoiceTotal);
        const woTotal = Number(w.total ?? 0);
        const total = invoiceTotal ?? woTotal;
        const amountSource: 'invoice' | 'work_order' | 'none' = invoiceTotal !== null ? 'invoice' : woTotal > 0 ? 'work_order' : 'none';
        const problems: string[] = [];
        if (!w.vendorId) problems.push('No vendor on the work order');
        // The truck's vendor paid the shop (owner, 2026-10-28): nothing for the company to owe.
        if (w.chargeParty === 'vendor') problems.push('Vendor pays: the truck’s vendor paid this repair');
        if (amountSource === 'none') problems.push('No invoice total on the work order');
        const bill = bills.find((b) => b.sourceKey === `repair_order:${w.id}`) ?? null;
        const expensePosted = posted.has(w.id);
        const reviewReason = bill ? `Bill ${bill.billNumber} exists (${bill.status})` : expensePosted ? 'Cost already posted as an expense by Fleet' : amountSource === 'work_order' ? 'Amount is the work-order estimate, not a vendor invoice' : invoiceTotal === 0 ? 'Zero-cost repair (warranty or in-house): nothing owed' : problems[0] ?? null;
        return { workOrderId: w.id, number: w.number, unitNumber: w.unitNumber, vendorId: w.vendorId ?? null, vendorName: w.vendorName ?? null, completedAt: w.completedAt ? new Date(w.completedAt).toISOString() : null, total, amountSource, hasBill: Boolean(bill), billId: bill?.id ?? null, billNumber: bill?.billNumber ?? null, billStatus: bill?.status ?? null, expensePosted, documentCount: Array.isArray(w.invoiceFileIds) ? (w.invoiceFileIds as unknown[]).length : 0, problems, reviewReason };
      })
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  }

  async createBillsFromWorkOrders(principal: Principal, workOrderIds: string[]): Promise<{ created: BillRecord[]; skipped: Array<{ workOrderId: string; reason: string }> }> {
    const candidates = await this.workOrderBillCandidates(principal);
    const created: BillRecord[] = [];
    const skipped: Array<{ workOrderId: string; reason: string }> = [];
    for (const id of workOrderIds) {
      const c = candidates.find((x) => x.workOrderId === id);
      if (!c) {
        skipped.push({ workOrderId: id, reason: 'Not a completed work order' });
        continue;
      }
      if (c.hasBill) {
        skipped.push({ workOrderId: id, reason: 'Already billed' });
        continue;
      }
      if (c.problems.length > 0) {
        skipped.push({ workOrderId: id, reason: c.problems.join('; ') });
        continue;
      }
      if (c.expensePosted) {
        skipped.push({ workOrderId: id, reason: 'Cost already posted as an expense; a bill would double it' });
        continue;
      }
      if (c.total === 0) {
        skipped.push({ workOrderId: id, reason: 'Zero-cost repair: nothing owed' });
        continue;
      }
      const [truck] = await this.store.db.select({ id: trucks.id }).from(trucks).where(and(eq(trucks.companyId, principal.companyId), eq(trucks.unitNumber, c.unitNumber))).limit(1);
      const out = await this.createBill(principal, { vendorId: c.vendorId!, vendorInvoiceNumber: c.number, issuedOn: (c.completedAt ?? this.clock().toISOString()).slice(0, 10), amount: c.total, categoryCode: 'maintenance', truckId: truck?.id ?? null, unitNumber: c.unitNumber, loadId: null, notes: `Repair order ${c.number}`, source: 'repair_order', sourceId: c.workOrderId });
      if (out.created) created.push(out.bill);
      else skipped.push({ workOrderId: id, reason: `Already ${out.bill.billNumber}` });
    }
    return { created, skipped };
  }

  async updateBill(principal: Principal, id: string, input: { status?: BillStatus; scheduledFor?: string | null; reason?: string | null; dispute?: string | null }) {
    const stored = await this.store.get<BillRecord>('acct_bills', principal.companyId, id);
    const bill = structuredClone(stored.record);
    if (input.status && input.status !== bill.status) {
      if (!billTransitions(bill.status).includes(input.status)) return { ok: false as const, blocked: `A ${bill.status.replace(/_/g, ' ')} bill cannot move straight to ${input.status.replace(/_/g, ' ')}.`, bill };
      const before = bill.status;
      bill.status = input.status;
      if (input.status === 'open' && before === 'pending_approval') {
        bill.approvedAt = this.clock().toISOString();
        bill.approvedBy = principal.userName ?? principal.userId;
      }
      await this.audit.write(principal, { action: 'bill_status', entityType: 'bill', entityId: id, entityLabel: bill.billNumber, summary: `${bill.billNumber} ${before} → ${input.status}`, reason: input.reason ?? null, changes: [{ field: 'status', old: before, new: input.status }] });
    }
    if (input.scheduledFor !== undefined) bill.scheduledFor = input.scheduledFor;
    if (input.dispute) bill.disputes = [...bill.disputes, { at: this.clock().toISOString(), by: principal.userName ?? principal.userId, reason: input.dispute, resolvedAt: null }];
    bill.updatedAt = this.clock().toISOString();
    await this.store.update('acct_bills', principal.companyId, id, stored.version, bill);
    return { ok: true as const, bill };
  }

  async payBill(principal: Principal, id: string, input: { amount: number; method: string; paidOn: string; reference: string }) {
    const stored = await this.store.get<BillRecord>('acct_bills', principal.companyId, id);
    const bill = structuredClone(stored.record);
    if (bill.status === 'pending_approval') return { ok: false as const, blocked: `${bill.billNumber} has not been approved yet.`, bill };
    if (input.amount <= 0) return { ok: false as const, blocked: 'A payment must be for a positive amount.', bill };
    if (Math.round(input.amount * 100) > Math.round(bill.balance * 100)) return { ok: false as const, blocked: `${bill.billNumber} has a balance of $${bill.balance.toFixed(2)}; paying $${input.amount.toFixed(2)} would overpay it.`, bill };
    const paymentId = newId('pay');
    const posted = await this.ledger.commit(principal, postBillPaid({ paymentId, reference: input.reference, paidOn: input.paidOn, vendorName: bill.vendorName, amount: input.amount }));
    if (!posted.ok) return { ok: false as const, blocked: posted.blocked, bill };
    const at = this.clock().toISOString();
    await this.store.insert('acct_payments', principal.companyId, { id: paymentId, sourceKey: `bill_payment:${bill.id}:${input.reference.trim()}:${input.paidOn}`, direction: 'out', partyType: 'vendor', partyId: bill.vendorId, partyName: bill.vendorName, amount: money(input.amount), method: input.method, receivedOn: input.paidOn, reference: input.reference.trim(), unappliedAmount: 0, applications: [{ id: `pap_${paymentId}_1`, paymentId, invoiceId: null, billId: bill.id, amount: money(input.amount), appliedAt: at }], notes: null, createdAt: at, createdBy: principal.userName ?? principal.userId });
    bill.paid = money(bill.paid + input.amount);
    bill.balance = money(bill.amount - bill.paid);
    bill.status = bill.balance <= 0 ? 'paid' : 'partially_paid';
    bill.updatedAt = at;
    await this.store.update('acct_bills', principal.companyId, id, stored.version, bill);
    await this.audit.write(principal, { action: 'bill_paid', entityType: 'bill', entityId: id, entityLabel: bill.billNumber, summary: `$${input.amount.toFixed(2)} paid on ${bill.billNumber} (${input.reference})`, changes: [] });
    return { ok: true as const, bill };
  }

  // ------------------------------------------------------------ expenses

  async expenses(principal: Principal): Promise<ExpenseRecord[]> {
    return (await this.store.list<ExpenseRecord>('acct_expenses', principal.companyId)).map((r) => r.record);
  }

  async createExpense(principal: Principal, input: { onDate: string; accountingDate?: string; categoryCode: string; description: string; amount: number; truckId: string | null; driverId: string | null; loadId: string | null; vendorId: string | null; paymentMethod: string | null; paidDirectly: boolean; notes: string | null; burden?: ExpenseRecord['burden']; provider?: string | null; source?: ExpenseRecord['source']; sourceId?: string | null; receiptFileId?: string | null; payer?: ExpenseRecord['payer']; reimbursement?: ReimbursementBlock | null; loadNumber?: string | null }): Promise<{ ok: true; expense: ExpenseRecord; created: boolean } | { ok: false; blocked: string }> {
    if (input.amount <= 0) return { ok: false, blocked: 'An expense must be for a positive amount.' };
    const source = input.source ?? 'manual';
    const id = newId('exp');
    const rows = (await this.store.db.execute(sql`select count(*)::int as n from acct_expenses where company_id = ${principal.companyId}`)) as unknown as Array<{ n: number }>;
    const expenseNumber = `EX-${String((Number(rows[0]?.n) || 0) + 1).padStart(5, '0')}`;
    const sourceKey = input.sourceId ? `${source}:${input.sourceId}` : `manual:${id}`;
    const dup = await this.store.list<ExpenseRecord>('acct_expenses', principal.companyId, sql`source_key = ${sourceKey}`);
    if (dup[0]) return { ok: true, expense: dup[0].record, created: false };
    // The driver-funded part is owed to the driver, not paid from the bank and not owed to a
    // vendor, so it credits the driver payable instead. The cost itself is debited once.
    const owedToDriver = input.reimbursement ? reimbursableCents(input.reimbursement) : 0;
    const posted = await this.ledger.commit(principal, postExpense({ expenseId: id, expenseNumber, onDate: input.accountingDate ?? input.onDate, description: input.description, categoryCode: input.categoryCode, amount: input.amount, paidDirectly: input.paidDirectly, reimbursableToDriverCents: owedToDriver }));
    if (!posted.ok) return { ok: false, blocked: posted.blocked };
    const truck = input.truckId ? (await this.store.db.select({ unitNumber: trucks.unitNumber }).from(trucks).where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, input.truckId))).limit(1))[0] : null;
    const driverName = input.driverId ? await this.driverAccounts.driverName(principal, input.driverId) : null;
    const vendorName = input.vendorId ? ((await this.vendors(principal)).find((v) => v.id === input.vendorId)?.name ?? null) : null;
    const expense: ExpenseRecord = {
      id,
      sourceKey,
      expenseNumber,
      onDate: input.onDate,
      accountingDate: input.accountingDate ?? input.onDate,
      categoryCode: input.categoryCode,
      description: input.description.trim(),
      amount: money(input.amount),
      currency: 'USD',
      provider: input.provider ?? null,
      truckId: input.truckId,
      unitNumber: truck?.unitNumber ?? null,
      trailerId: null,
      driverId: input.driverId,
      driverName,
      loadId: input.loadId,
      loadNumber: input.loadNumber ?? null,
      vendorId: input.vendorId,
      vendorName,
      source,
      sourceId: input.sourceId ?? null,
      billId: null,
      paymentMethod: input.paymentMethod,
      payer: input.payer ?? 'company',
      burden: input.burden ?? 'company_borne',
      chargeRecipientId: input.burden === 'recoverable_driver' ? input.driverId : input.burden === 'recoverable_vendor' ? input.vendorId : null,
      allocations: [],
      driverTransactionId: null,
      receiptFileId: input.receiptFileId ?? null,
      reimbursement: input.reimbursement ?? null,
      accountCode: posted.entry.lines.find((l) => l.debit > 0)?.accountCode ?? '6900',
      status: 'posted',
      postedAt: this.clock().toISOString(),
      notes: input.notes?.trim() || null,
    };
    await this.store.insert('acct_expenses', principal.companyId, expense);
    await this.audit.write(principal, { action: 'expense_recorded', entityType: 'expense', entityId: id, entityLabel: expenseNumber, summary: `${expenseNumber} ${input.categoryCode} $${expense.amount.toFixed(2)} (${expense.burden})`, changes: [] });
    return { ok: true, expense, created: true };
  }

  /**
   * Voids an expense: a reversing journal entry beside the original, the record kept with who,
   * when and why. Retry-safe: voiding a void expense returns it unchanged.
   *
   * Refused, in words, where a reversal alone would leave the books wrong: a bill covers the
   * expense (void or credit the bill), a driver charge or reimbursement hangs off it (settle
   * that first), it has been split into shares, or its month is closed (reopen the month or post
   * an adjustment).
   */
  async voidExpense(principal: Principal, id: string, reason: string): Promise<{ ok: true; expense: ExpenseRecord } | { ok: false; blocked: string }> {
    const stored = await this.store.get<ExpenseRecord>('acct_expenses', principal.companyId, id);
    const e = stored.record;
    if (e.status === 'void') return { ok: true, expense: e };
    if (!reason.trim()) return { ok: false, blocked: 'A void needs a reason.' };
    if (e.billId) return { ok: false, blocked: `${e.expenseNumber} is covered by a bill. Void or credit the bill in Payables instead.` };
    if (e.driverTransactionId) return { ok: false, blocked: `${e.expenseNumber} has a driver charge linked to it. Settle or void that charge first.` };
    if (e.reimbursement) return { ok: false, blocked: `${e.expenseNumber} is owed back to a driver as a reimbursement. Reject it in Reimbursements instead.` };
    if ((e.allocations ?? []).length > 0) return { ok: false, blocked: `${e.expenseNumber} has been split into shares. Remove the shares first.` };
    const accountingDate = e.accountingDate ?? e.onDate;
    const period = canPost(accountingDate, await this.ledger.periods(principal.companyId));
    if (!period.allowed) return { ok: false, blocked: `${e.expenseNumber} is in a closed month (${accountingDate.slice(0, 7)}): ${(period.reason ?? 'the period is closed').replace(/\.+$/, '')}. Reopen the month in Accounting, or post an adjustment there.` };
    let reversalEntryId: string | null = null;
    const [original] = await this.store.list<{ id: string }>('acct_journal_entries', principal.companyId, sql`source_key = ${`expense_recorded:${id}`}`);
    if (original) {
      const reversed = await this.ledger.reverse(principal, original.id, `${e.expenseNumber} voided: ${reason.trim()}`);
      if (reversed.ok) reversalEntryId = reversed.entry.id;
      else {
        // A retry after the reversal landed but before the record was saved: use that reversal.
        const [prior] = await this.store.list<{ id: string }>('acct_journal_entries', principal.companyId, sql`reversal_of = ${original.id}`);
        if (!prior) return { ok: false, blocked: reversed.blocked };
        reversalEntryId = prior.id;
      }
    }
    const at = this.clock().toISOString();
    const by = principal.userName ?? principal.userId;
    const after: ExpenseRecord = { ...e, status: 'void', voidedAt: at, voidedBy: by, voidReason: reason.trim(), reversalEntryId };
    await this.store.update('acct_expenses', principal.companyId, id, stored.version, after);
    await this.audit.write(principal, { action: 'expense_void', entityType: 'expense', entityId: id, entityLabel: e.expenseNumber, summary: `${e.expenseNumber} voided: ${reason.trim()}${reversalEntryId ? ` (reversed by ${reversalEntryId})` : ''}`, reason: reason.trim(), changes: [{ field: 'status', old: e.status, new: 'void' }] });
    return { ok: true, expense: after };
  }

  /** Explicit shares of one expense; the total may not exceed the amount. */
  async allocateExpense(principal: Principal, id: string, allocations: ExpenseRecord['allocations']) {
    const total = allocations.reduce((s, a) => s + a.amount, 0);
    const stored = await this.store.get<ExpenseRecord>('acct_expenses', principal.companyId, id);
    if (Math.round(total * 100) > Math.round(stored.record.amount * 100)) throw unprocessable(`The shares add to $${total.toFixed(2)}, more than the expense's $${stored.record.amount.toFixed(2)}.`);
    const after = { ...stored.record, allocations };
    await this.store.update('acct_expenses', principal.companyId, id, stored.version, after);
    return after;
  }

  // ------------------------------------------------------------ imports (Relay · BestPass · EFS · CSV)

  /**
   * Parses a provider CSV into import records. Column names are matched loosely per provider;
   * a line whose id, date or amount cannot be read is kept as `unmatched` with the problem, never
   * dropped. Real provider APIs are not connected (no credentials on file): CSV is the path.
   */
  parseCsv(provider: ImportRecord['provider'], text: string): Array<Omit<ImportRecord, 'id' | 'state' | 'truckId' | 'driverId' | 'driverName' | 'expenseId' | 'driverTransactionId' | 'importedAt' | 'importedBy' | 'unitNumber'>> {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) return [];
    const split = (line: string) => {
      const out: string[] = [];
      let cur = '';
      let q = false;
      for (const ch of line) {
        if (ch === '"') q = !q;
        else if (ch === ',' && !q) {
          out.push(cur.trim());
          cur = '';
        } else cur += ch;
      }
      out.push(cur.trim());
      return out;
    };
    const header = split(lines[0]!).map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
    const pick = (row: Record<string, string>, ...names: string[]) => names.map((n) => row[n]).find((v) => v !== undefined && v !== '') ?? '';
    return lines.slice(1).map((line, i) => {
      const cells = split(line);
      const raw: Record<string, string> = {};
      header.forEach((h, j) => (raw[h] = cells[j] ?? ''));
      const problems: string[] = [];
      const key = pick(raw, 'transaction_id', 'transactionid', 'id', 'reference', 'ref', 'trans_id', 'toll_id', 'tid') || `${provider}-row-${i + 1}-${line.length}`;
      const dateRaw = pick(raw, 'date', 'transaction_date', 'trans_date', 'posted_date', 'exit_date', 'datetime');
      const parsedDate = dateRaw ? new Date(dateRaw) : null;
      const occurredOn = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString().slice(0, 10) : '';
      if (!occurredOn) problems.push('Date could not be read');
      const amountRaw = pick(raw, 'amount', 'total', 'total_amount', 'net_amount', 'toll_amount', 'gross');
      const amount = Number.parseFloat(amountRaw.replace(/[$,]/g, ''));
      if (!Number.isFinite(amount)) problems.push('Amount could not be read');
      const cardOrUnit = pick(raw, 'unit', 'unit_number', 'truck', 'vehicle', 'transponder', 'card', 'card_number', 'plate') || null;
      const indicator = /driver|drv|advance|cash/i.test(pick(raw, 'type', 'product', 'category', 'description', 'memo'));
      return {
        provider,
        sourceKey: key,
        occurredOn: occurredOn || '1970-01-01',
        amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : 0,
        cardOrUnit,
        description: pick(raw, 'description', 'merchant', 'location', 'plaza', 'product', 'memo') || `${provider} ${key}`,
        kind: provider === 'efs' && !indicator ? 'fuel' : PROVIDER_KIND[provider],
        driverChargeIndicator: provider === 'efs' ? indicator : false,
        raw,
        problems,
      };
    });
  }

  /** The driver on a truck on a date, from the effective-dated assignments; today's driver is never assumed. */
  private async driverOn(companyId: string, truckId: string, day: string): Promise<string | null> {
    const rows = await this.store.db
      .select({ driverId: truckDriverAssignments.driverId })
      .from(truckDriverAssignments)
      .where(and(eq(truckDriverAssignments.companyId, companyId), eq(truckDriverAssignments.truckId, truckId), sql`assigned_on <= ${day}`, sql`(ended_on is null or ended_on >= ${day})`))
      .limit(1);
    return rows[0]?.driverId ?? null;
  }

  async importCsv(principal: Principal, provider: ImportRecord['provider'], text: string, options: { dryRun?: boolean } = {}): Promise<{ dryRun: boolean; imported: number; duplicates: number; matched: number; unmatched: number; errors: number; records: ImportRecord[]; totalCents: number }> {
    const parsed = this.parseCsv(provider, text);
    const known = new Set((await this.store.list<ImportRecord>('acct_import_records', principal.companyId, sql`provider = ${provider}`)).map((r) => r.record.sourceKey));
    const truckRows = await this.store.db.select({ id: trucks.id, unitNumber: trucks.unitNumber }).from(trucks).where(eq(trucks.companyId, principal.companyId));
    const now = this.clock().toISOString();
    let imported = 0;
    let duplicates = 0;
    const records: ImportRecord[] = [];
    for (const p of parsed) {
      const truck = p.cardOrUnit ? truckRows.find((t) => t.unitNumber === p.cardOrUnit || t.unitNumber === p.cardOrUnit!.replace(/^0+/, '')) : undefined;
      const driverId = truck && !p.problems.length ? await this.driverOn(principal.companyId, truck.id, p.occurredOn) : null;
      const problems = [...p.problems];
      if (!truck) problems.push(p.cardOrUnit ? `Unit ${p.cardOrUnit} is not in the fleet` : 'No unit or card on the line');
      else if (!driverId) problems.push(`No driver assigned to unit ${truck.unitNumber} on ${p.occurredOn}`);
      const record: ImportRecord = {
        ...p,
        id: newId('imp'),
        state: problems.length === 0 ? 'matched' : 'unmatched',
        truckId: truck?.id ?? null,
        unitNumber: truck?.unitNumber ?? null,
        driverId,
        driverName: driverId ? await this.driverAccounts.driverName(principal, driverId) : null,
        expenseId: null,
        driverTransactionId: null,
        problems,
        importedAt: now,
        importedBy: principal.userName ?? principal.userId,
      };
      if (options.dryRun) {
        if (known.has(record.sourceKey)) duplicates += 1;
        else {
          imported += 1;
          records.push(record);
        }
        continue;
      }
      const { stored, created } = await this.store.insert('acct_import_records', principal.companyId, record);
      if (!created) {
        duplicates += 1;
        continue;
      }
      imported += 1;
      records.push(stored.record);
    }
    if (!options.dryRun) await this.audit.write(principal, { action: 'import_csv', entityType: 'import', entityId: provider, entityLabel: provider, summary: `${provider}: ${imported} imported, ${duplicates} already on file`, changes: [] });
    return { dryRun: Boolean(options.dryRun), imported, duplicates, matched: records.filter((r) => r.state === 'matched').length, unmatched: records.filter((r) => r.state === 'unmatched').length, errors: records.filter((r) => r.problems.some((x) => /amount|date/i.test(x))).length, records, totalCents: records.reduce((s, r) => s + r.amountCents, 0) };
  }

  async imports(principal: Principal, state?: string): Promise<ImportRecord[]> {
    return (await this.store.list<ImportRecord>('acct_import_records', principal.companyId, state ? sql`state = ${state}` : undefined)).map((r) => r.record);
  }

  /** A person maps an unmatched line to a unit/driver, or ignores it with a reason. */
  async resolveImport(principal: Principal, id: string, input: { truckId?: string | null; driverId?: string | null; ignore?: boolean; reason?: string }) {
    const stored = await this.store.get<ImportRecord>('acct_import_records', principal.companyId, id);
    const rec = structuredClone(stored.record);
    if (input.ignore) {
      rec.state = 'ignored';
      rec.problems = [...rec.problems, `Ignored: ${input.reason ?? ''}`];
    } else {
      if (input.truckId !== undefined) {
        rec.truckId = input.truckId;
        rec.unitNumber = input.truckId ? ((await this.store.db.select({ unitNumber: trucks.unitNumber }).from(trucks).where(eq(trucks.id, input.truckId)).limit(1))[0]?.unitNumber ?? null) : null;
      }
      if (input.driverId !== undefined) {
        rec.driverId = input.driverId;
        rec.driverName = input.driverId ? await this.driverAccounts.driverName(principal, input.driverId) : null;
      }
      rec.state = rec.truckId && rec.driverId ? 'matched' : 'unmatched';
      rec.problems = rec.state === 'matched' ? [] : rec.problems;
    }
    await this.store.update('acct_import_records', principal.companyId, id, stored.version, rec);
    return rec;
  }

  /**
   * Turns matched imports into expenses, and - when the driver's switches say the cost is the
   * driver's - into one driver charge linked to the expense. Idempotent per import line.
   */
  async postImports(principal: Principal, ids: string[]): Promise<{ posted: number; skipped: Array<{ id: string; reason: string }> }> {
    let posted = 0;
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of ids) {
      const stored = await this.store.get<ImportRecord>('acct_import_records', principal.companyId, id);
      const rec = structuredClone(stored.record);
      if (rec.state !== 'matched' || !rec.truckId || !rec.driverId) {
        skipped.push({ id, reason: 'Not matched to a unit and a driver' });
        continue;
      }
      if (rec.expenseId) {
        skipped.push({ id, reason: 'Already posted' });
        continue;
      }
      const profile = await this.driverAccounts.profileOn(principal, rec.driverId, rec.occurredOn);
      const category = rec.kind === 'fuel' ? 'fuel' : rec.kind === 'tolls' ? 'tolls' : 'other';
      const deduct = rec.kind === 'fuel' ? profile?.switches.deductFuel : rec.kind === 'tolls' ? profile?.switches.deductTolls : rec.kind === 'advance' ? profile?.switches.deductApprovedAdvances : false;
      const burden: ExpenseRecord['burden'] = deduct ? 'recoverable_driver' : 'company_borne';
      const out = await this.createExpense(principal, { onDate: rec.occurredOn, categoryCode: category, description: `${rec.provider.toUpperCase()} · ${rec.description}`, amount: rec.amountCents / 100, truckId: rec.truckId, driverId: rec.driverId, loadId: null, vendorId: null, paymentMethod: 'card', paidDirectly: true, notes: null, burden, provider: rec.provider, source: 'import', sourceId: `${rec.provider}:${rec.sourceKey}` });
      if (!out.ok) {
        skipped.push({ id, reason: out.blocked });
        continue;
      }
      rec.expenseId = out.expense.id;
      if (deduct || rec.driverChargeIndicator) {
        // An EFS "driver charge" line on a CD proposes a pending charge for review; a switch-backed
        // charge is approved. Neither is applied to a statement until a settlement takes it.
        const tx = await this.driverAccounts.chargeFromImport(principal, { driverId: rec.driverId, kind: rec.kind === 'advance' ? 'advance' : rec.kind === 'tolls' ? 'tolls' : 'fuel', onDate: rec.occurredOn, amountCents: rec.amountCents, description: `${rec.provider.toUpperCase()} · ${rec.description}`, sourceKey: `import:${rec.provider}:${rec.sourceKey}`, truckId: rec.truckId, state: deduct ? 'approved' : 'pending', companyCost: !deduct && !rec.driverChargeIndicator, expenseId: out.expense.id });
        rec.driverTransactionId = tx.id;
        await this.store.modify<ExpenseRecord>('acct_expenses', principal.companyId, out.expense.id, (e) => ({ ...e, driverTransactionId: tx.id }));
      } else if (profile) {
        // A CD's fuel: the company's cost, shown on the driver's account as such, never owed.
        const tx = await this.driverAccounts.chargeFromImport(principal, { driverId: rec.driverId, kind: rec.kind === 'tolls' ? 'tolls' : 'fuel', onDate: rec.occurredOn, amountCents: rec.amountCents, description: `${rec.provider.toUpperCase()} · ${rec.description}`, sourceKey: `import:${rec.provider}:${rec.sourceKey}`, truckId: rec.truckId, state: 'applied', companyCost: true, expenseId: out.expense.id });
        rec.driverTransactionId = tx.id;
      }
      await this.store.update('acct_import_records', principal.companyId, id, stored.version, rec);
      posted += 1;
    }
    return { posted, skipped };
  }
}
