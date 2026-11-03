import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  FLEET_EXPENSE_ACCOUNTING_CATEGORY,
  FLEET_EXPENSE_CATEGORY_LABEL,
  FLEET_EXPENSE_REIMBURSEMENT_CATEGORY,
  FleetExpenseRecoveryActionSchema,
  INVESTIGATION_OVERDUE_DAYS,
  ResolveInvestigationSchema,
  SaveFleetExpenseSchema,
  expenseFigures,
  expenseOutcome,
  validateFleetExpense,
  type DriverTx,
  type FleetExpenseAccountingLink,
  type FleetExpenseCategory,
  type FleetExpenseChargeTo,
  type FleetExpenseDashboard,
  type FleetExpenseDetail,
  type FleetExpenseFileView,
  type FleetExpenseList,
  type FleetExpenseListQuery,
  type FleetExpensePayer,
  type FleetExpenseRecovery,
  type FleetExpenseRow,
  type FleetExpenseTotals,
  type FleetPaymentMethod,
  type FleetPaymentStatus,
  type FleetRecoveryStatus,
  type EfsStatus,
  type InvestigationItem,
  type InvestigationList,
  type InvestigationQuery,
  type SaveFleetExpense,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { auditLogs, drivers, fleetExpenseFiles, fleetExpenses, storedFiles, trucks, vendors, workOrders } from '../../database/schema';
import { acctBills, acctDriverTransactions, acctExpenses } from '../../database/schema/accounting';
import { encrypt } from '../admin/credential-vault';
import type { BillRecord, ExpenseRecord } from '../accounting/payables.service';
import { PayablesService } from '../accounting/payables.service';
import { DriverAccountsService } from '../accounting/driver-accounts.service';
import { ReimbursementsService } from '../accounting/reimbursements.service';
import { SettlementsService, type StatementRecord } from '../accounting/settlements.service';
import { companyToday, conflict, forbidden, newId, notFound, unprocessable } from '../dispatch-board/ops.helpers';
import { AuditService } from '../people/audit.service';
import { localDateOf } from '../reporting/period/date-utils';

type ExpenseRowDb = typeof fleetExpenses.$inferSelect;
type FileRowDb = typeof fleetExpenseFiles.$inferSelect;

/** Fleet reads: whoever may see maintenance money or the books. */
export const FLEET_EXPENSE_VIEW = ['maintenance_costs.view', 'accounting.view'] as const;
/** Fleet records the operational expense; Accounting may too. */
export const FLEET_EXPENSE_EDIT = ['maintenance.edit', 'accounting.edit'] as const;

interface Links {
  bills: Map<string, BillRecord>;
  payments: Map<string, ExpenseRecord>;
  txByExpense: Map<string, DriverTx>;
  txByWorkOrder: Map<string, DriverTx>;
  billByWorkOrder: Map<string, BillRecord>;
  /** Driver id → draft statements, recomputed: what a draft would take now. */
  drafts: StatementRecord[];
}

function dollars(cents: number): number {
  return Math.round(cents) / 100;
}

function toCents(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Fleet Expenses: the manual expenses (parking, truck wash, tolls ...) of `fleet_expenses`, plus
 * completed repair orders projected from `work_orders` so a repair is visible here without being
 * stored or counted twice. Accounting effects go through the existing Payables, Driver account,
 * Reimbursement and Settlement services; this service only keeps the links.
 */
@Injectable()
export class FleetExpensesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly payables: PayablesService,
    private readonly driverAccounts: DriverAccountsService,
    private readonly reimbursements: ReimbursementsService,
    private readonly settlements: SettlementsService,
  ) {}

  clock: () => Date = () => new Date();

  private get db() {
    return this.database.db;
  }

  // ------------------------------------------------------------ permissions

  permissions(principal: Principal) {
    const canView = FLEET_EXPENSE_VIEW.some((p) => hasPermission(principal, p));
    const canEdit = FLEET_EXPENSE_EDIT.some((p) => hasPermission(principal, p));
    const accounting = hasPermission(principal, 'accounting.edit');
    return { canView, canEdit, canPost: accounting, canRecover: accounting };
  }

  private requireEdit(principal: Principal): void {
    if (!this.permissions(principal).canEdit) throw forbidden('Recording fleet expenses needs maintenance.edit or accounting.edit.');
  }

  private requireAccounting(principal: Principal): void {
    if (!hasPermission(principal, 'accounting.edit')) throw forbidden('Only Accounting (accounting.edit) posts expenses and decides deductions.');
  }

  today(principal: Principal): string {
    return companyToday(principal, this.clock());
  }

  /** Month to date, the company dashboard's own default. */
  defaultRange(principal: Principal): { from: string; to: string } {
    const to = this.today(principal);
    return { from: `${to.slice(0, 8)}01`, to };
  }

  // ------------------------------------------------------------ options

  async options(principal: Principal) {
    const range = this.defaultRange(principal);
    const [truckRows, driverRows, vendorRows] = await Promise.all([
      this.db.select({ id: trucks.id, unitNumber: trucks.unitNumber }).from(trucks).where(eq(trucks.companyId, principal.companyId)).orderBy(asc(trucks.unitNumber)),
      this.db.select({ id: drivers.id, first: drivers.firstName, last: drivers.lastName }).from(drivers).where(and(eq(drivers.companyId, principal.companyId), isNull(drivers.archivedAt))),
      this.db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(and(eq(vendors.companyId, principal.companyId), ne(vendors.kind, 'truck_owner'))).orderBy(asc(vendors.name)),
    ]);
    return {
      today: range.to,
      defaultFrom: range.from,
      defaultTo: range.to,
      trucks: truckRows,
      drivers: driverRows.map((d) => ({ id: d.id, name: `${d.first} ${d.last}`.trim() })).sort((a, b) => a.name.localeCompare(b.name)),
      vendors: vendorRows,
      permissions: this.permissions(principal),
    };
  }

  // ------------------------------------------------------------ reading

  private async manualRows(principal: Principal): Promise<ExpenseRowDb[]> {
    return this.db.select().from(fleetExpenses).where(eq(fleetExpenses.companyId, principal.companyId));
  }

  /** Completed truck repair orders: the projection of Maintenance into Expenses. */
  private async repairOrders(principal: Principal) {
    return this.db
      .select({
        id: workOrders.id,
        number: workOrders.number,
        unitId: workOrders.unitId,
        unitNumber: workOrders.unitNumber,
        assetType: workOrders.assetType,
        status: workOrders.status,
        completedAt: workOrders.completedAt,
        total: workOrders.total,
        invoiceTotal: workOrders.invoiceTotal,
        invoiceNumber: workOrders.invoiceNumber,
        invoiceFileIds: workOrders.invoiceFileIds,
        vendorName: workOrders.vendorName,
        workDone: workOrders.workDone,
        title: workOrders.title,
        chargeParty: workOrders.chargeParty,
        paymentTerms: workOrders.paymentTerms,
        chargeDriverId: workOrders.chargeDriverId,
        chargeDriverName: workOrders.chargeDriverName,
      })
      .from(workOrders)
      .where(and(eq(workOrders.companyId, principal.companyId), eq(workOrders.status, 'completed'), isNull(workOrders.voidedAt)));
  }

  private async links(principal: Principal, manual: ExpenseRowDb[], repairIds: string[], withDrafts: boolean): Promise<Links> {
    const billIds = manual.map((m) => m.acctBillId).filter((v): v is string => Boolean(v));
    const paymentIds = manual.flatMap((m) => [m.acctExpenseId, m.reimbursementId]).filter((v): v is string => Boolean(v));
    const [billRows, repairBillRows, paymentRows, txRows] = await Promise.all([
      billIds.length ? this.db.select({ record: acctBills.record }).from(acctBills).where(and(eq(acctBills.companyId, principal.companyId), inArray(acctBills.id, billIds))) : Promise.resolve([]),
      repairIds.length ? this.db.select({ record: acctBills.record }).from(acctBills).where(and(eq(acctBills.companyId, principal.companyId), inArray(acctBills.sourceKey, repairIds.flatMap((id) => [`repair_order:${id}`, `work_order:${id}`])))) : Promise.resolve([]),
      paymentIds.length ? this.db.select({ record: acctExpenses.record }).from(acctExpenses).where(and(eq(acctExpenses.companyId, principal.companyId), inArray(acctExpenses.id, paymentIds))) : Promise.resolve([]),
      this.db
        .select({ record: acctDriverTransactions.record })
        .from(acctDriverTransactions)
        .where(and(eq(acctDriverTransactions.companyId, principal.companyId), sql`(${acctDriverTransactions.sourceKey} like 'fleet_expense:%' or ${acctDriverTransactions.sourceKey} like 'work_order:%')`)),
    ]);
    const bills = new Map<string, BillRecord>();
    for (const r of billRows) bills.set((r.record as BillRecord).id, r.record as BillRecord);
    const billByWorkOrder = new Map<string, BillRecord>();
    for (const r of repairBillRows) {
      const b = r.record as BillRecord;
      if (b.status === 'void') continue;
      if (b.sourceId) billByWorkOrder.set(b.sourceId, b);
    }
    const payments = new Map<string, ExpenseRecord>();
    for (const r of paymentRows) payments.set((r.record as ExpenseRecord).id, r.record as ExpenseRecord);
    const txByExpense = new Map<string, DriverTx>();
    const txByWorkOrder = new Map<string, DriverTx>();
    for (const r of txRows) {
      const t = r.record as DriverTx;
      if (t.sourceKey.startsWith('fleet_expense:')) txByExpense.set(t.sourceKey.slice('fleet_expense:'.length), t);
      else if (t.sourceKey.startsWith('work_order:')) txByWorkOrder.set(t.sourceKey.slice('work_order:'.length), t);
    }
    let drafts: StatementRecord[] = [];
    if (withDrafts) {
      const open = [...txByExpense.values(), ...txByWorkOrder.values()].filter((t) => t.state === 'approved' && t.recoveredCents < t.amountCents);
      const driverIds = [...new Set(open.map((t) => t.driverId))];
      for (const driverId of driverIds) {
        const list = await this.settlements.statements(principal, { partyId: driverId });
        for (const s of list.filter((x) => x.status === 'draft' || x.status === 'review')) {
          try {
            drafts.push(await this.settlements.statement(principal, s.id));
          } catch {
            drafts.push(s);
          }
        }
      }
    }
    drafts = drafts.filter(Boolean);
    return { bills, payments, txByExpense, txByWorkOrder, billByWorkOrder, drafts };
  }

  private inDraft(links: Links, txId: string): { settlementId: string; settlementNumber: string; cents: number } | null {
    for (const s of links.drafts) {
      const r = s.computation?.recoveries.find((x) => x.txId === txId);
      if (r && r.cents > 0) return { settlementId: s.id, settlementNumber: s.settlementNumber, cents: r.cents };
    }
    return null;
  }

  private recoveryStatus(tx: DriverTx | undefined, links: Links, posted: boolean): FleetRecoveryStatus {
    if (!tx) return posted ? 'cancelled' : 'not_posted';
    if (tx.state === 'void') return 'cancelled';
    if (tx.state === 'disputed') return 'disputed';
    if (tx.state === 'paused') return 'paused';
    if (tx.state === 'pending') return 'pending_review';
    if (tx.recoveredCents >= tx.amountCents) return 'deducted';
    if (this.inDraft(links, tx.id)) return 'in_settlement';
    if (tx.recoveredCents > 0) return 'partially_deducted';
    return 'approved';
  }

  private paymentStatus(m: ExpenseRowDb, links: Links): FleetPaymentStatus {
    if (m.status === 'draft') return 'draft';
    if (m.status === 'void') return 'void';
    const outcome = expenseOutcome(m.paidBy as FleetExpensePayer, m.chargeTo as FleetExpenseChargeTo);
    if (outcome === 'external') return 'paid_externally';
    if (outcome === 'reimbursement') {
      const block = m.reimbursementId ? links.payments.get(m.reimbursementId)?.reimbursement : null;
      if (!block) return 'reimbursement_pending';
      if (block.status === 'paid') return 'reimbursed';
      if (block.status === 'rejected') return 'reimbursement_rejected';
      if (block.status === 'approved' || block.status === 'included') return 'reimbursement_approved';
      return 'reimbursement_pending';
    }
    if (m.paid) return 'paid';
    const bill = m.acctBillId ? links.bills.get(m.acctBillId) : null;
    if (bill?.status === 'paid') return 'paid';
    if (bill?.status === 'partially_paid') return 'partially_paid';
    return 'unpaid';
  }

  private accountingState(m: ExpenseRowDb): FleetExpenseDetail['accounting']['state'] {
    if (m.status === 'draft') return 'draft';
    if (m.status === 'void') return 'void';
    const outcome = expenseOutcome(m.paidBy as FleetExpensePayer, m.chargeTo as FleetExpenseChargeTo);
    if (outcome === 'external' || m.amountCents === 0) return 'not_required';
    return m.postedAt ? 'posted' : 'awaiting_posting';
  }

  private manualRow(m: ExpenseRowDb, links: Links, fileCount: number): FleetExpenseRow & { outstandingCents: number; unpaidCents: number } {
    const paidBy = m.paidBy as FleetExpensePayer;
    const chargeTo = m.chargeTo as FleetExpenseChargeTo;
    const outcome = expenseOutcome(paidBy, chargeTo);
    const figures = expenseFigures({ status: m.status as FleetExpenseRow['status'], amountCents: m.amountCents, paidBy, chargeTo, chargeCents: m.chargeCents });
    const tx = links.txByExpense.get(m.id);
    const recoveryStatus: FleetRecoveryStatus = outcome === 'driver_charge' && m.status === 'recorded' ? this.recoveryStatus(tx, links, Boolean(m.postedAt)) : 'none';
    const paymentStatus = this.paymentStatus(m, links);
    const bill = m.acctBillId ? links.bills.get(m.acctBillId) : null;
    let outstandingCents = 0;
    if (outcome === 'driver_charge' && m.status === 'recorded' && recoveryStatus !== 'cancelled') outstandingCents = tx ? tx.amountCents - tx.recoveredCents : figures.driverChargeCents;
    let unpaidCents = 0;
    if (m.status === 'recorded' && (outcome === 'company_cost' || outcome === 'driver_charge') && !m.paid) unpaidCents = bill ? Math.round(bill.balance * 100) : m.amountCents;
    return {
      id: m.id,
      source: 'manual',
      reference: m.reference,
      status: m.status as FleetExpenseRow['status'],
      truckId: m.truckId,
      unitNumber: m.unitNumber,
      category: m.category as FleetExpenseCategory,
      categoryLabel: FLEET_EXPENSE_CATEGORY_LABEL[m.category as FleetExpenseCategory] ?? m.category,
      expenseDate: String(m.expenseDate),
      amountCents: m.amountCents,
      vendorName: m.vendorName,
      placeName: m.placeName,
      city: m.city,
      state: m.state,
      description: m.description,
      paidBy,
      paymentMethod: (m.paymentMethod as FleetPaymentMethod | null) ?? null,
      chargeTo,
      chargeDriverName: m.chargeDriverName,
      chargeCents: m.chargeCents,
      paymentStatus,
      recoveryStatus,
      outcome,
      figures,
      workOrderId: null,
      efsMasked: m.efsCodeLast4 ? `•••• ${m.efsCodeLast4}` : null,
      fileCount,
      version: m.version,
      outstandingCents,
      unpaidCents,
    };
  }

  private repairRow(o: Awaited<ReturnType<FleetExpensesService['repairOrders']>>[number], links: Links, timezone: string): (FleetExpenseRow & { outstandingCents: number; unpaidCents: number }) | null {
    const amount = toCents(o.invoiceTotal ?? o.total);
    if (amount === null || !o.completedAt || o.assetType === 'trailer') return null;
    const chargeTo: FleetExpenseChargeTo = o.chargeParty === 'driver' ? 'driver' : o.chargeParty === 'investigation' ? 'investigation' : o.chargeParty === 'vendor' ? 'owner' : 'company';
    // Vendor pays (owner, 2026-10-28): the truck's vendor paid the shop - the vendor's cost, never the company's.
    const paidBy = chargeTo === 'owner' ? 'owner' : 'company';
    const figures = expenseFigures({ status: 'recorded', amountCents: amount, paidBy, chargeTo, chargeCents: chargeTo === 'driver' ? amount : null });
    const tx = links.txByWorkOrder.get(o.id);
    const bill = links.billByWorkOrder.get(o.id);
    // An Accounting bill decides; without one, the work order's own word (owner, 2026-10-13):
    // Company paid is paid, Pay later is unpaid until a bill for it is paid.
    const paymentStatus: FleetPaymentStatus = bill
      ? bill.status === 'paid' ? 'paid' : bill.status === 'partially_paid' ? 'partially_paid' : 'unpaid'
      : o.paymentTerms === 'company_paid' ? 'paid' : o.paymentTerms === 'pay_later' && amount > 0 ? 'unpaid' : 'not_billed';
    const recoveryStatus: FleetRecoveryStatus = chargeTo === 'driver' ? this.recoveryStatus(tx, links, false) : 'none';
    return {
      id: o.id,
      source: 'work_order',
      reference: o.number,
      status: 'recorded',
      truckId: o.unitId ?? '',
      unitNumber: o.unitNumber ?? '',
      category: 'repair_maintenance',
      categoryLabel: FLEET_EXPENSE_CATEGORY_LABEL.repair_maintenance,
      expenseDate: localDateOf(o.completedAt, timezone),
      amountCents: amount,
      vendorName: o.vendorName,
      placeName: null,
      city: null,
      state: null,
      description: o.workDone?.trim() || o.title || null,
      paidBy,
      paymentMethod: null,
      chargeTo,
      chargeDriverName: o.chargeDriverName,
      chargeCents: chargeTo === 'driver' ? amount : null,
      paymentStatus,
      recoveryStatus,
      outcome: chargeTo === 'driver' ? 'driver_charge' : chargeTo === 'investigation' ? 'investigation' : chargeTo === 'owner' ? 'external' : 'company_cost',
      figures,
      workOrderId: o.id,
      efsMasked: null,
      fileCount: Array.isArray(o.invoiceFileIds) ? (o.invoiceFileIds as unknown[]).length : 0,
      version: 0,
      outstandingCents: chargeTo === 'driver' && recoveryStatus !== 'cancelled' ? (tx ? tx.amountCents - tx.recoveredCents : amount) : 0,
      unpaidCents: bill ? (bill.status !== 'paid' ? Math.round(bill.balance * 100) : 0) : o.paymentTerms === 'pay_later' && chargeTo !== 'owner' ? amount : 0,
    };
  }

  private async fileCounts(principal: Principal): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ expenseId: fleetExpenseFiles.expenseId, n: sql<number>`count(*)::int` })
      .from(fleetExpenseFiles)
      .where(and(eq(fleetExpenseFiles.companyId, principal.companyId), isNull(fleetExpenseFiles.removedAt)))
      .groupBy(fleetExpenseFiles.expenseId);
    return new Map(rows.map((r) => [r.expenseId, Number(r.n)]));
  }

  /** Every row the filters admit, before paging: the one definition list, dashboard and PDF share. */
  async rows(principal: Principal, q: Partial<FleetExpenseListQuery>, withDrafts = true): Promise<Array<FleetExpenseRow & { outstandingCents: number; unpaidCents: number }>> {
    const [manual, repairs, counts] = await Promise.all([this.manualRows(principal), q.source === 'manual' ? Promise.resolve([]) : this.repairOrders(principal), this.fileCounts(principal)]);
    const links = await this.links(principal, manual, repairs.map((r) => r.id), withDrafts);
    const all = [
      ...(q.source === 'work_order' ? [] : manual.map((m) => this.manualRow(m, links, counts.get(m.id) ?? 0))),
      ...repairs.map((r) => this.repairRow(r, links, principal.companyTimezone)).filter((r): r is NonNullable<typeof r> => r !== null),
    ];
    const needle = q.search?.trim().toLowerCase();
    return all.filter((r) => {
      if (r.status === 'draft' && !q.includeDrafts) return false;
      if (r.status === 'void' && !q.includeVoid) return false;
      if (q.from && r.expenseDate < q.from) return false;
      if (q.to && r.expenseDate > q.to) return false;
      if (q.truckId && r.truckId !== q.truckId) return false;
      if (q.category && r.category !== q.category) return false;
      // Repair log › Expenses: what is not maintenance (repairs live in the log itself).
      if (q.nonMaintenance && (r.source === 'work_order' || r.category === 'repair_maintenance')) return false;
      if (q.paidBy && r.paidBy !== q.paidBy) return false;
      if (q.chargeTo && r.chargeTo !== q.chargeTo) return false;
      if (q.paymentStatus && r.paymentStatus !== q.paymentStatus) return false;
      if (q.recoveryStatus && r.recoveryStatus !== q.recoveryStatus) return false;
      if (q.figure === 'company' && r.figures.companyCents <= 0) return false;
      if (q.figure === 'driver_outstanding' && r.outstandingCents <= 0) return false;
      if (q.figure === 'unpaid_bills' && r.unpaidCents <= 0) return false;
      if (q.figure === 'efs_remaining' && !(r.paymentMethod === 'efs' && r.outstandingCents > 0)) return false;
      if (q.figure === 'external' && r.figures.externalCents <= 0) return false;
      if (q.figure === 'investigation' && r.figures.investigationCents <= 0) return false;
      if (needle) {
        const hay = [r.reference, r.unitNumber, r.vendorName, r.placeName, r.city, r.state, r.description, r.categoryLabel, r.chargeDriverName].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }

  totals(rows: Array<FleetExpenseRow & { outstandingCents: number; unpaidCents: number }>): FleetExpenseTotals {
    const counted = rows.filter((r) => r.status === 'recorded');
    const byCat = new Map<FleetExpenseCategory, { cents: number; count: number }>();
    for (const r of counted) {
      const c = byCat.get(r.category) ?? { cents: 0, count: 0 };
      c.cents += r.figures.spendCents;
      c.count += 1;
      byCat.set(r.category, c);
    }
    const sum = (f: (r: (typeof counted)[number]) => number) => counted.reduce((s, r) => s + f(r), 0);
    return {
      spendCents: sum((r) => r.figures.spendCents),
      companyCents: sum((r) => r.figures.companyCents),
      driverChargeCents: sum((r) => r.figures.driverChargeCents),
      driverOutstandingCents: sum((r) => r.outstandingCents),
      externalCents: sum((r) => r.figures.externalCents),
      investigationCents: sum((r) => r.figures.investigationCents),
      unpaidBillsCents: sum((r) => r.unpaidCents),
      efsRemainingCents: sum((r) => (r.paymentMethod === 'efs' ? r.outstandingCents : 0)),
      count: counted.length,
      byCategory: [...byCat.entries()]
        .map(([category, v]) => ({ category, label: FLEET_EXPENSE_CATEGORY_LABEL[category], cents: v.cents, count: v.count }))
        .sort((a, b) => b.cents - a.cents),
    };
  }

  private strip<T extends { outstandingCents: number; unpaidCents: number }>(r: T): Omit<T, 'outstandingCents' | 'unpaidCents'> {
    const { outstandingCents: _o, unpaidCents: _u, ...rest } = r;
    return rest;
  }

  private sort(rows: FleetExpenseRow[], sort: FleetExpenseListQuery['sort']): FleetExpenseRow[] {
    const by: Record<FleetExpenseListQuery['sort'], (a: FleetExpenseRow, b: FleetExpenseRow) => number> = {
      date_desc: (a, b) => b.expenseDate.localeCompare(a.expenseDate) || b.reference.localeCompare(a.reference),
      date_asc: (a, b) => a.expenseDate.localeCompare(b.expenseDate) || a.reference.localeCompare(b.reference),
      amount_desc: (a, b) => b.amountCents - a.amountCents,
      amount_asc: (a, b) => a.amountCents - b.amountCents,
      truck: (a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true }) || b.expenseDate.localeCompare(a.expenseDate),
      category: (a, b) => a.categoryLabel.localeCompare(b.categoryLabel) || b.expenseDate.localeCompare(a.expenseDate),
    };
    return [...rows].sort(by[sort]);
  }

  async list(principal: Principal, q: FleetExpenseListQuery): Promise<FleetExpenseList> {
    const rows = await this.rows(principal, q);
    const sorted = this.sort(rows.map((r) => this.strip(r)), q.sort);
    const start = (q.page - 1) * q.pageSize;
    return { rows: sorted.slice(start, start + q.pageSize), total: sorted.length, page: q.page, pageSize: q.pageSize, totals: this.totals(rows) };
  }

  async dashboard(principal: Principal, q: Partial<FleetExpenseListQuery>): Promise<FleetExpenseDashboard> {
    const range = this.defaultRange(principal);
    const from = q.from ?? range.from;
    const to = q.to ?? range.to;
    const rows = await this.rows(principal, { ...q, from, to });
    const byTruck = new Map<string, { truckId: string; unitNumber: string; cents: number; companyCents: number; count: number }>();
    for (const r of rows.filter((x) => x.status === 'recorded')) {
      if (!r.truckId) continue;
      const t = byTruck.get(r.truckId) ?? { truckId: r.truckId, unitNumber: r.unitNumber, cents: 0, companyCents: 0, count: 0 };
      t.cents += r.figures.spendCents;
      t.companyCents += r.figures.companyCents;
      t.count += 1;
      byTruck.set(r.truckId, t);
    }
    const manual = await this.manualRows(principal);
    const awaiting = manual.filter((m) => this.accountingState(m) === 'awaiting_posting' && String(m.expenseDate) >= from && String(m.expenseDate) <= to);
    return {
      from,
      to,
      totals: this.totals(rows),
      byTruck: [...byTruck.values()].sort((a, b) => b.cents - a.cents),
      recent: this.sort(rows.map((r) => this.strip(r)), 'date_desc').slice(0, 8),
      timing: { awaitingPostingCount: awaiting.length, awaitingPostingCents: awaiting.reduce((s, m) => s + m.amountCents, 0) },
    };
  }

  // ------------------------------------------------------------ investigations

  /** Fleet managers and Safety settle an investigation (owner, 2026-10-13). */
  canResolveInvestigation(principal: Principal): boolean {
    return hasPermission(principal, 'maintenance.edit') || hasPermission(principal, 'compliance.manage');
  }

  /**
   * Repairs and expenses nobody has decided who bears yet: one list for Costs, the unit and the
   * driver. Open repairs are included (an estimate under investigation is still in question);
   * voided ones never are.
   */
  async investigations(principal: Principal, q: InvestigationQuery): Promise<InvestigationList> {
    const now = this.clock();
    const today = this.today(principal);
    const orders = await this.db
      .select({
        id: workOrders.id,
        number: workOrders.number,
        unitId: workOrders.unitId,
        unitNumber: workOrders.unitNumber,
        assetType: workOrders.assetType,
        status: workOrders.status,
        total: workOrders.total,
        invoiceTotal: workOrders.invoiceTotal,
        completedAt: workOrders.completedAt,
        shopInAt: workOrders.shopInAt,
        createdAt: workOrders.createdAt,
        workDone: workOrders.workDone,
        title: workOrders.title,
        chargeDriverId: workOrders.chargeDriverId,
        chargeDriverName: workOrders.chargeDriverName,
      })
      .from(workOrders)
      .where(and(eq(workOrders.companyId, principal.companyId), eq(workOrders.chargeParty, 'investigation'), isNull(workOrders.voidedAt)));
    const expenses = await this.db
      .select()
      .from(fleetExpenses)
      .where(and(eq(fleetExpenses.companyId, principal.companyId), eq(fleetExpenses.chargeTo, 'investigation'), eq(fleetExpenses.status, 'recorded')));
    const age = (since: Date) => Math.max(0, Math.floor((now.getTime() - since.getTime()) / 86_400_000));
    const items: InvestigationItem[] = [];
    for (const o of orders) {
      if (o.status === 'cancelled' || o.status === 'draft') continue;
      const days = age(o.createdAt);
      items.push({
        kind: 'work_order',
        id: o.id,
        reference: o.number,
        unitKind: o.assetType === 'trailer' ? 'trailer' : 'truck',
        unitId: o.unitId,
        unitNumber: o.unitNumber ?? '',
        driverId: o.chargeDriverId,
        driverName: o.chargeDriverName,
        amountCents: toCents(o.invoiceTotal ?? o.total) ?? 0,
        date: localDateOf(o.completedAt ?? o.shopInAt, principal.companyTimezone),
        since: o.createdAt.toISOString(),
        days,
        overdue: days > INVESTIGATION_OVERDUE_DAYS,
        description: o.workDone?.trim() || o.title || null,
        open: o.status !== 'completed',
        version: 0,
      });
    }
    for (const m of expenses) {
      const days = age(m.createdAt);
      items.push({
        kind: 'fleet_expense',
        id: m.id,
        reference: m.reference,
        unitKind: 'truck',
        unitId: m.truckId,
        unitNumber: m.unitNumber,
        driverId: m.chargeDriverId,
        driverName: m.chargeDriverName,
        amountCents: m.chargeCents ?? m.amountCents,
        date: String(m.expenseDate),
        since: m.createdAt.toISOString(),
        days,
        overdue: days > INVESTIGATION_OVERDUE_DAYS,
        description: [FLEET_EXPENSE_CATEGORY_LABEL[m.category as FleetExpenseCategory] ?? m.category, m.description].filter(Boolean).join(' · '),
        open: false,
        version: m.version,
      });
    }
    const shown = items
      .filter((i) => (!q.driverId || i.driverId === q.driverId) && (!q.unitId || i.unitId === q.unitId) && (!q.from || i.date >= q.from) && (!q.to || i.date <= (q.to ?? today)))
      .sort((a, b) => b.days - a.days || b.amountCents - a.amountCents);
    return {
      items: shown,
      totalCents: shown.reduce((s, i) => s + i.amountCents, 0),
      overdueCount: shown.filter((i) => i.overdue).length,
      canResolve: this.canResolveInvestigation(principal),
    };
  }

  /**
   * Settles an expense under investigation: the company bears it, or a driver is charged (the
   * usual driver charge, which Accounting then recovers). A repair is settled through its own
   * Who pays (the work order's charge), so the two keep one history each.
   */
  async resolveInvestigation(principal: Principal, id: string, raw: unknown): Promise<FleetExpenseDetail> {
    if (!this.canResolveInvestigation(principal)) throw forbidden('Settling an investigation needs maintenance.edit or Safety (compliance.manage).');
    const input = ResolveInvestigationSchema.parse({ ...(raw as object), kind: 'fleet_expense', id });
    const before = await this.row(principal, id);
    if (before.chargeTo !== 'investigation') throw conflict(`${before.reference} is not under investigation any more. Reload it.`);
    if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) throw conflict(`${before.reference} was changed by someone else. Reload it and try again.`);
    let set: Partial<typeof fleetExpenses.$inferInsert>;
    if (input.to === 'company') {
      set = { chargeTo: 'company', chargeDriverId: null, chargeDriverName: null, chargeCents: null, chargeReason: null, deductFromSettlement: false };
    } else {
      const driverId = input.driverId ?? before.chargeDriverId;
      if (!driverId) throw this.problems([{ field: 'driverId', message: 'Choose the driver to charge.' }]);
      const name = await this.driverAccounts.driverName(principal, driverId);
      if (!name) throw this.problems([{ field: 'driverId', message: 'That driver is not on this company’s roster.' }]);
      const amount = input.amountCents ?? before.chargeCents ?? before.amountCents;
      if (amount > before.amountCents) throw this.problems([{ field: 'amountCents', message: 'The charge cannot be more than the expense.' }]);
      set = { chargeTo: 'driver', chargeDriverId: driverId, chargeDriverName: name, chargeCents: amount, chargeReason: input.reason, deductFromSettlement: true };
    }
    const updated = await this.db
      .update(fleetExpenses)
      .set({ ...set, version: before.version + 1, updatedAt: this.clock(), updatedBy: principal.userName ?? principal.userId })
      .where(and(eq(fleetExpenses.companyId, principal.companyId), eq(fleetExpenses.id, id), eq(fleetExpenses.version, before.version)))
      .returning({ id: fleetExpenses.id });
    if (updated.length === 0) throw conflict(`${before.reference} was changed by someone else. Reload it and try again.`);
    await this.audit.write(principal, {
      action: 'fleet_expense_investigation_resolved',
      entityType: 'fleet_expense',
      entityId: id,
      entityLabel: before.reference,
      summary: `${before.reference} investigation settled: ${input.to === 'company' ? 'the company bears it' : `charged to ${set.chargeDriverName}`}`,
      changes: [
        { field: 'chargeTo', old: 'investigation', new: input.to },
        { field: 'chargeDriverName', old: before.chargeDriverName ?? null, new: (set.chargeDriverName as string | null) ?? null },
        { field: 'chargeCents', old: before.chargeCents === null ? null : String(before.chargeCents), new: set.chargeCents === null || set.chargeCents === undefined ? null : String(set.chargeCents) },
      ],
      reason: input.reason,
    });
    return this.detail(principal, id);
  }

  // ------------------------------------------------------------ one expense

  private async row(principal: Principal, id: string): Promise<ExpenseRowDb> {
    const [m] = await this.db.select().from(fleetExpenses).where(and(eq(fleetExpenses.companyId, principal.companyId), eq(fleetExpenses.id, id))).limit(1);
    if (!m) throw notFound(`Expense ${id} is not on file.`);
    return m;
  }

  private async liveFiles(principal: Principal, expenseId: string): Promise<FileRowDb[]> {
    return this.db
      .select()
      .from(fleetExpenseFiles)
      .where(and(eq(fleetExpenseFiles.companyId, principal.companyId), eq(fleetExpenseFiles.expenseId, expenseId), isNull(fleetExpenseFiles.removedAt)))
      .orderBy(asc(fleetExpenseFiles.addedAt));
  }

  /** Files Accounting relies on as evidence are kept: removing them is a correction made there. */
  private evidenceIds(m: ExpenseRowDb, links: Links): Map<string, string> {
    const out = new Map<string, string>();
    const bill = m.acctBillId ? links.bills.get(m.acctBillId) : null;
    for (const a of bill?.attachments ?? []) out.set(a.fileId, `vendor bill ${bill?.billNumber}`);
    const pay = m.acctExpenseId ? links.payments.get(m.acctExpenseId) : null;
    if (pay?.receiptFileId) out.set(pay.receiptFileId, `payment ${pay.expenseNumber}`);
    const re = m.reimbursementId ? links.payments.get(m.reimbursementId) : null;
    if (re?.receiptFileId) out.set(re.receiptFileId, `reimbursement ${re.expenseNumber}`);
    const tx = links.txByExpense.get(m.id);
    if (tx?.evidenceFileId) out.set(tx.evidenceFileId, 'the driver charge');
    return out;
  }

  async detail(principal: Principal, id: string): Promise<FleetExpenseDetail> {
    const m = await this.row(principal, id);
    const links = await this.links(principal, [m], [], true);
    const files = await this.liveFiles(principal, id);
    const base = this.strip(this.manualRow(m, links, files.length));
    const evidence = this.evidenceIds(m, links);
    const tx = links.txByExpense.get(m.id);
    const perms = this.permissions(principal);
    const accountingLinks: FleetExpenseAccountingLink[] = [];
    const bill = m.acctBillId ? links.bills.get(m.acctBillId) : null;
    if (bill) accountingLinks.push({ kind: 'bill', id: bill.id, label: `Vendor bill ${bill.billNumber}`, status: bill.status, amountCents: Math.round(bill.amount * 100), at: bill.approvedAt ?? bill.createdAt, by: bill.approvedBy, href: `/accounting/payables?q=${encodeURIComponent(bill.billNumber)}` });
    const pay = m.acctExpenseId ? links.payments.get(m.acctExpenseId) : null;
    if (pay) accountingLinks.push({ kind: 'payment', id: pay.id, label: `Payment ${pay.expenseNumber}`, status: pay.status, amountCents: Math.round(pay.amount * 100), at: pay.postedAt ?? null, by: m.postedBy, href: `/accounting/expenses?q=${encodeURIComponent(pay.expenseNumber)}` });
    const re = m.reimbursementId ? links.payments.get(m.reimbursementId) : null;
    if (re) accountingLinks.push({ kind: 'reimbursement', id: re.id, label: `Reimbursement ${re.expenseNumber}`, status: re.reimbursement?.status ?? re.status, amountCents: re.reimbursement?.driverFundedCents ?? Math.round(re.amount * 100), at: re.reimbursement?.reviewedAt ?? re.postedAt ?? null, by: re.reimbursement?.reviewedBy ?? m.postedBy, href: `/accounting/reimbursements?q=${encodeURIComponent(re.expenseNumber)}` });
    let recovery: FleetExpenseRecovery | null = null;
    if (tx) {
      accountingLinks.push({ kind: 'driver_charge', id: tx.id, label: `Driver charge · ${m.chargeDriverName ?? tx.driverId}`, status: tx.state, amountCents: tx.amountCents, at: tx.approvedAt ?? null, by: tx.approvedBy ?? null, href: `/drivers/${encodeURIComponent(tx.driverId)}` });
      const draft = this.inDraft(links, tx.id);
      const entries = (tx.recoveryLog ?? []).map((l) => ({ settlementId: l.settlementId, settlementNumber: l.settlementNumber, cents: l.cents, at: l.at, status: (l.reversedAt ? 'reversed' : 'posted') as 'reversed' | 'posted', reversedAt: l.reversedAt ?? null, reversedBy: l.reversedBy ?? null, reason: l.reason ?? null }));
      for (const e of entries) accountingLinks.push({ kind: 'settlement', id: e.settlementId, label: `Settlement ${e.settlementNumber ?? e.settlementId}`, status: e.status === 'reversed' ? 'deduction reversed' : 'deducted', amountCents: e.cents, at: e.at, by: null, href: `/accounting/settlements/${encodeURIComponent(e.settlementId)}` });
      if (draft) accountingLinks.push({ kind: 'settlement', id: draft.settlementId, label: `Settlement ${draft.settlementNumber} (draft)`, status: 'previewed, not deducted', amountCents: draft.cents, at: null, by: null, href: `/accounting/settlements/${encodeURIComponent(draft.settlementId)}` });
      recovery = {
        driverTxId: tx.id,
        driverId: tx.driverId,
        driverName: m.chargeDriverName,
        state: tx.state,
        chargeCents: tx.amountCents,
        deductedCents: tx.recoveredCents,
        remainingCents: tx.state === 'void' ? 0 : tx.amountCents - tx.recoveredCents,
        perSettlementCents: tx.installments?.perPeriodCents ?? null,
        inDraft: draft,
        entries,
        approvedBy: tx.approvedBy ?? null,
        approvedAt: tx.approvedAt ?? null,
      };
    }
    const history = await this.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, principal.companyId), eq(auditLogs.entityType, 'fleet_expense'), eq(auditLogs.entityId, id)))
      .orderBy(asc(auditLogs.at));
    const payerDriverName = m.payerDriverId ? await this.driverAccounts.driverName(principal, m.payerDriverId) : null;
    const fileViews: FleetExpenseFileView[] = files.map((f) => {
      const ev = evidence.get(f.fileId);
      return {
        id: f.id,
        fileId: f.fileId,
        fileName: f.fileName,
        contentType: f.contentType,
        kind: f.kind as FleetExpenseFileView['kind'],
        addedAt: iso(f.addedAt) ?? '',
        addedBy: f.addedBy,
        removable: perms.canEdit && m.status !== 'void' && !ev,
        removeBlockedReason: ev ? `Accounting keeps this file as evidence for ${ev}. Correct it in Accounting first.` : m.status === 'void' ? 'The expense is void; its files are kept.' : !perms.canEdit ? 'You cannot change this expense.' : null,
      };
    });
    const state = this.accountingState(m);
    const posted = Boolean(m.postedAt);
    return {
      ...base,
      vendorId: m.vendorId,
      invoiceNumber: m.invoiceNumber,
      notes: m.notes,
      address: m.address,
      postalCode: m.postalCode,
      payerDriverId: m.payerDriverId,
      payerDriverName,
      payerName: m.payerName,
      paid: m.paid,
      paymentReference: m.paymentReference,
      chargeDriverId: m.chargeDriverId,
      chargeReason: m.chargeReason,
      deductFromSettlement: m.deductFromSettlement,
      efs:
        m.paymentMethod === 'efs'
          ? {
              masked: m.efsCodeLast4 ? `•••• ${m.efsCodeLast4}` : null,
              issuedOn: m.efsIssuedOn ? String(m.efsIssuedOn) : null,
              issuedCents: m.efsIssuedCents,
              usedCents: m.efsUsedCents,
              unusedCents: m.efsIssuedCents !== null && m.efsUsedCents !== null ? m.efsIssuedCents - m.efsUsedCents : null,
              status: (m.efsStatus as EfsStatus) ?? 'used',
              receiptFileId: m.efsReceiptFileId,
            }
          : null,
      recovery,
      accounting: { state, links: accountingLinks, postedAt: iso(m.postedAt), postedBy: m.postedBy },
      files: fileViews,
      history: history.map((h) => ({ at: iso(h.at) ?? '', by: h.actorName, action: h.action, summary: h.summary, reason: h.reason })),
      createdAt: iso(m.createdAt) ?? '',
      createdBy: m.createdBy,
      voidedAt: iso(m.voidedAt),
      voidedBy: m.voidedBy,
      voidReason: m.voidReason,
      permissions: {
        canEdit: perms.canEdit && m.status !== 'void',
        canPost: perms.canPost && state === 'awaiting_posting',
        canRecover: perms.canRecover && Boolean(tx) && tx?.state !== 'void',
        canVoid: perms.canEdit && m.status !== 'void' && (!posted || perms.canPost),
      },
    };
  }

  // ------------------------------------------------------------ writing

  private problems(problems: Array<{ field: string; message: string }>): AppError {
    return new AppError({ status: 422, title: 'Unprocessable', detail: problems.map((p) => p.message).join(' '), extensions: { problems } });
  }

  /** Repairs already in Maintenance that a manual Repair/Maintenance entry would duplicate. */
  async duplicates(principal: Principal, q: { truckId?: string; category?: string; amountCents?: number; expenseDate?: string; invoiceNumber?: string | null }) {
    if (q.category !== 'repair_maintenance' || !q.truckId) return { matches: [] };
    const orders = (await this.repairOrders(principal)).filter((o) => o.unitId === q.truckId && o.assetType !== 'trailer');
    const inv = q.invoiceNumber?.trim().toLowerCase();
    const matches = orders
      .map((o) => ({ o, amountCents: toCents(o.invoiceTotal ?? o.total), date: o.completedAt ? localDateOf(o.completedAt, principal.companyTimezone) : null }))
      .filter(({ o, amountCents, date }) => {
        if (inv && o.invoiceNumber && o.invoiceNumber.trim().toLowerCase() === inv) return true;
        if (q.amountCents && amountCents === q.amountCents && date && q.expenseDate) {
          const days = Math.abs(Date.parse(`${date}T00:00:00Z`) - Date.parse(`${q.expenseDate}T00:00:00Z`)) / 86_400_000;
          return days <= 7;
        }
        return false;
      })
      .map(({ o, amountCents, date }) => ({ workOrderId: o.id, roNumber: o.number, amountCents, date, vendorName: o.vendorName }));
    return { matches };
  }

  private async resolve(principal: Principal, input: SaveFleetExpense) {
    // No truck is allowed (owner, 2026-10-23); it is stored as '' because the column is NOT NULL.
    const [found] = input.truckId
      ? await this.db.select({ id: trucks.id, unitNumber: trucks.unitNumber }).from(trucks).where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, input.truckId))).limit(1)
      : [{ id: '', unitNumber: '' }];
    const truck = found;
    if (!truck) throw this.problems([{ field: 'truckId', message: 'That truck is not on this company’s roster.' }]);
    let vendorName = input.vendorName;
    if (input.vendorId) {
      const [v] = await this.db.select({ name: vendors.name }).from(vendors).where(and(eq(vendors.companyId, principal.companyId), eq(vendors.id, input.vendorId))).limit(1);
      if (!v) throw this.problems([{ field: 'vendorId', message: 'That vendor is not on file.' }]);
      vendorName = v.name;
    }
    const driverName = async (id: string | null, field: string) => {
      if (!id) return null;
      const name = await this.driverAccounts.driverName(principal, id);
      if (!name) throw this.problems([{ field, message: 'That driver is not on this company’s roster.' }]);
      return name;
    };
    const payerDriverName = input.paidBy === 'driver' ? await driverName(input.payerDriverId, 'payerDriverId') : null;
    const chargeDriverName = (input.chargeTo === 'driver' || input.chargeTo === 'investigation') && input.charge ? await driverName(input.charge.driverId, 'charge.driverId') : null;
    // External own cost: the payer bears it, and their driver id is kept for the record.
    return { truck, vendorName, payerDriverName, chargeDriverName };
  }

  private values(principal: Principal, input: SaveFleetExpense, r: Awaited<ReturnType<FleetExpensesService['resolve']>>) {
    const efs = input.paymentMethod === 'efs' ? input.efs : null;
    const amountCents = efs && efs.usedCents !== null ? efs.usedCents : input.amountCents;
    const company = input.paidBy === 'company';
    // Under investigation keeps the driver in question (if any) so it shows on that driver.
    const charge = (input.chargeTo === 'driver' || input.chargeTo === 'investigation') && company ? input.charge : null;
    return {
      truckId: r.truck.id,
      unitNumber: r.truck.unitNumber,
      category: input.category,
      expenseDate: input.expenseDate,
      amountCents,
      vendorId: input.vendorId,
      vendorName: r.vendorName?.trim() || null,
      invoiceNumber: input.invoiceNumber,
      description: input.description,
      notes: input.notes,
      placeName: input.location.placeName,
      address: input.location.address,
      city: input.location.city,
      state: input.location.state,
      postalCode: input.location.postalCode,
      paidBy: input.paidBy,
      payerDriverId: input.paidBy === 'driver' ? input.payerDriverId : null,
      payerName: input.paidBy === 'driver' ? r.payerDriverName : input.paidBy === 'owner' ? input.payerName : null,
      paymentMethod: input.paymentMethod,
      paid: company ? input.paid : true,
      paymentReference: input.paymentReference,
      chargeTo: input.chargeTo,
      chargeDriverId: charge?.driverId ?? null,
      chargeDriverName: charge ? r.chargeDriverName : null,
      chargeCents: charge?.amountCents ?? null,
      chargeReason: charge?.reason ?? null,
      deductFromSettlement: input.chargeTo === 'driver' ? (charge?.deductFromSettlement ?? false) : false,
      efsIssuedOn: efs?.issuedOn ?? null,
      efsIssuedCents: efs?.issuedCents ?? null,
      efsUsedCents: efs?.usedCents ?? null,
      efsStatus: efs ? (efs.usedCents === 0 ? (efs.status === 'cancelled' ? 'cancelled' : 'unused') : efs.status) : null,
      efsReceiptFileId: efs?.receiptFileId ?? null,
      notDuplicateOf: input.notDuplicateOf,
      updatedAt: this.clock(),
      updatedBy: principal.userName ?? principal.userId,
    };
  }

  private parse(raw: unknown): SaveFleetExpense {
    const parsed = SaveFleetExpenseSchema.safeParse(raw);
    if (!parsed.success) throw this.problems(parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
    const input = parsed.data;
    // For EFS the amount is what was actually used; issuing a code is not spending.
    if (input.paymentMethod === 'efs' && input.efs?.usedCents !== null && input.efs?.usedCents !== undefined) input.amountCents = input.efs.usedCents;
    const problems = validateFleetExpense(input);
    if (problems.length) throw this.problems(problems);
    return input;
  }

  private async guardDuplicate(principal: Principal, input: SaveFleetExpense): Promise<void> {
    if (input.category !== 'repair_maintenance' || input.status === 'draft') return;
    const { matches } = await this.duplicates(principal, { truckId: input.truckId, category: input.category, amountCents: input.amountCents, expenseDate: input.expenseDate, invoiceNumber: input.invoiceNumber });
    const open = matches.filter((d) => d.workOrderId !== input.notDuplicateOf);
    if (open.length > 0) throw conflict(`This looks like repair ${open.map((d) => d.roNumber).join(', ')}, already in Maintenance. Open it there instead of entering it again, or confirm this is a different cost.`, { duplicates: open });
  }

  private async nextReference(principal: Principal): Promise<string> {
    const rows = (await this.db.execute(sql`select coalesce(max(nullif(regexp_replace(reference, '\\D', '', 'g'), '')::int), 0) + 1 as n from fleet_expenses where company_id = ${principal.companyId}`)) as unknown as Array<{ n: number }>;
    return `EXP-${String(Number(rows[0]?.n) || 1).padStart(5, '0')}`;
  }

  async create(principal: Principal, raw: unknown): Promise<FleetExpenseDetail> {
    this.requireEdit(principal);
    const input = this.parse(raw);
    await this.guardDuplicate(principal, input);
    const id = await this.insert(principal, input);
    return this.detail(principal, id);
  }

  /**
   * A receipt the driver paid with the company card, filed from the driver app (mobile M3): a
   * company expense, never a reimbursement. It lands as a **draft** - nothing is posted to
   * Accounting until Fleet or Accounting checks it and records it - paid by the company, charged to
   * the company, with the receipt attached. The driver was resolved on the server.
   */
  async createDraftFromDriver(
    principal: Principal,
    raw: unknown,
    origin: { driverId: string; driverName: string; receiptFileId: string },
  ): Promise<{ id: string; reference: string; amountCents: number; expenseDate: string; category: string }> {
    const input = this.parse({ ...(raw as object), status: 'draft', paidBy: 'company', chargeTo: 'company', charge: null, payerDriverId: null, payerName: origin.driverName, paymentMethod: 'card', paid: true });
    const id = await this.insert(principal, input);
    const [file] = await this.db.select({ id: storedFiles.id, fileName: storedFiles.fileName, contentType: storedFiles.contentType }).from(storedFiles).where(and(eq(storedFiles.companyId, principal.companyId), eq(storedFiles.id, origin.receiptFileId))).limit(1);
    if (file) {
      await this.db
        .insert(fleetExpenseFiles)
        .values({ id: newId('fxf'), companyId: principal.companyId, expenseId: id, fileId: file.id, fileName: file.fileName, contentType: file.contentType, kind: 'receipt', addedBy: principal.userName ?? principal.userId })
        .onConflictDoNothing();
    }
    const [row] = await this.db.select({ reference: fleetExpenses.reference, amountCents: fleetExpenses.amountCents, expenseDate: fleetExpenses.expenseDate, category: fleetExpenses.category }).from(fleetExpenses).where(and(eq(fleetExpenses.companyId, principal.companyId), eq(fleetExpenses.id, id))).limit(1);
    return { id, reference: row!.reference, amountCents: Number(row!.amountCents), expenseDate: String(row!.expenseDate), category: row!.category };
  }

  private async insert(principal: Principal, input: SaveFleetExpense): Promise<string> {
    const resolved = await this.resolve(principal, input);
    const values = this.values(principal, input, resolved);
    const by = principal.userName ?? principal.userId;
    const id = newId('fex');
    const sealed = input.paymentMethod === 'efs' && input.efs?.code ? input.efs.code.replace(/\s+/g, '') : null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const reference = await this.nextReference(principal);
      try {
        await this.db.insert(fleetExpenses).values({
          id,
          companyId: principal.companyId,
          reference,
          status: input.status,
          ...values,
          efsCodeSealed: sealed ? encrypt(sealed) : null,
          efsCodeLast4: sealed ? sealed.slice(-4) : null,
          createdBy: by,
        });
        await this.audit.write(principal, {
          action: input.status === 'draft' ? 'fleet_expense_drafted' : 'fleet_expense_recorded',
          entityType: 'fleet_expense',
          entityId: id,
          entityLabel: reference,
          summary: `${reference} ${FLEET_EXPENSE_CATEGORY_LABEL[input.category]} $${dollars(values.amountCents).toFixed(2)} ${values.unitNumber ? `on truck ${values.unitNumber}` : 'with no truck'} (${input.status})`,
          changes: [{ field: 'status', old: null, new: input.status }],
        });
        return id;
      } catch (err) {
        if (String((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code) === '23505' && attempt < 4) continue;
        throw err;
      }
    }
    throw conflict('Could not number the expense; try again.');
  }

  async update(principal: Principal, id: string, raw: unknown): Promise<FleetExpenseDetail> {
    this.requireEdit(principal);
    const input = this.parse(raw);
    const before = await this.row(principal, id);
    if (before.status === 'void') throw unprocessable(`${before.reference} is void and cannot change.`);
    if (input.expectedVersion === undefined) throw unprocessable('expectedVersion is required.');
    if (input.expectedVersion !== before.version) throw conflict(`${before.reference} was changed by someone else. Reload it and try again.`);
    if (before.status === 'recorded' && input.status === 'draft') throw unprocessable('A recorded expense cannot go back to draft; void it instead.');
    await this.guardDuplicate(principal, input);
    const resolved = await this.resolve(principal, input);
    const values = this.values(principal, input, resolved);
    if (before.postedAt) {
      // Posted money is corrected in Accounting, not by editing the source after the fact.
      const money: Array<keyof typeof values> = ['truckId', 'category', 'expenseDate', 'amountCents', 'vendorId', 'paidBy', 'payerDriverId', 'paymentMethod', 'paid', 'chargeTo', 'chargeDriverId', 'chargeCents'];
      const changed = money.filter((k) => String(values[k] ?? '') !== String((before as Record<string, unknown>)[k] ?? ''));
      if (changed.length > 0) throw unprocessable(`${before.reference} is posted to Accounting: ${changed.join(', ')} cannot change here. Void it (Accounting reverses its entries) and enter it again, or correct it in Accounting.`);
    }
    const code = input.paymentMethod === 'efs' && input.efs?.code ? input.efs.code.replace(/\s+/g, '') : null;
    const updated = await this.db
      .update(fleetExpenses)
      .set({ ...values, status: input.status, version: before.version + 1, ...(code ? { efsCodeSealed: encrypt(code), efsCodeLast4: code.slice(-4) } : {}) })
      .where(and(eq(fleetExpenses.companyId, principal.companyId), eq(fleetExpenses.id, id), eq(fleetExpenses.version, before.version)))
      .returning({ id: fleetExpenses.id });
    if (updated.length === 0) throw conflict(`${before.reference} was changed by someone else. Reload it and try again.`);
    const changes = (Object.keys(values) as Array<keyof typeof values>)
      .filter((k) => k !== 'updatedAt' && k !== 'updatedBy' && String(values[k] ?? '') !== String((before as Record<string, unknown>)[k] ?? ''))
      .map((k) => ({ field: String(k), old: (before as Record<string, unknown>)[k] === null || (before as Record<string, unknown>)[k] === undefined ? null : String((before as Record<string, unknown>)[k]), new: values[k] === null ? null : String(values[k]) }));
    if (before.status !== input.status) changes.push({ field: 'status', old: before.status, new: input.status });
    await this.audit.write(principal, { action: before.status === 'draft' && input.status === 'recorded' ? 'fleet_expense_recorded' : 'fleet_expense_updated', entityType: 'fleet_expense', entityId: id, entityLabel: before.reference, summary: `${before.reference} ${before.status === 'draft' && input.status === 'recorded' ? 'recorded' : 'changed'}`, changes });
    return this.detail(principal, id);
  }

  /**
   * Posts a recorded expense to Accounting, once. The row is claimed first (posted_at set only if
   * it was empty), so a double click or two people posting at once create one set of records; if
   * Accounting refuses, the claim is released and the reason is returned.
   */
  async post(principal: Principal, id: string): Promise<FleetExpenseDetail> {
    this.requireAccounting(principal);
    const m = await this.row(principal, id);
    const state = this.accountingState(m);
    if (state === 'posted') return this.detail(principal, id);
    if (state === 'draft') throw unprocessable(`${m.reference} is a draft. Save it as an expense first.`);
    if (state === 'void') throw unprocessable(`${m.reference} is void.`);
    if (state === 'not_required') throw unprocessable(m.amountCents === 0 ? `${m.reference} has no actual spend (unused EFS): nothing to post.` : `${m.reference} was paid and borne externally: it is tracked spend only, with no payable and no deduction.`);
    const outcome = expenseOutcome(m.paidBy as FleetExpensePayer, m.chargeTo as FleetExpenseChargeTo);
    if (outcome === 'investigation') throw unprocessable(`${m.reference} is under investigation: decide who bears it (Company or Driver) before it goes to Accounting.`);
    if ((outcome === 'company_cost' || outcome === 'driver_charge') && !m.paid && !m.vendorId) throw unprocessable(`${m.reference} is unpaid: choose the vendor on file so Accounting can create the bill.`);
    const by = principal.userName ?? principal.userId;
    const claimed = await this.db
      .update(fleetExpenses)
      .set({ postedAt: this.clock(), postedBy: by })
      .where(and(eq(fleetExpenses.companyId, principal.companyId), eq(fleetExpenses.id, id), isNull(fleetExpenses.postedAt), eq(fleetExpenses.status, 'recorded')))
      .returning({ id: fleetExpenses.id });
    if (claimed.length === 0) return this.detail(principal, id);
    const files = await this.liveFiles(principal, id);
    const receipt = files.find((f) => f.kind === 'receipt' || f.kind === 'invoice' || f.kind === 'efs_receipt') ?? files[0] ?? null;
    const label = FLEET_EXPENSE_CATEGORY_LABEL[m.category as FleetExpenseCategory] ?? m.category;
    const place = [m.placeName, [m.city, m.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    const description = `${m.reference} · ${label} ${m.unitNumber ? ` · Truck ${m.unitNumber}` : ''}${place ? ` · ${place}` : ''}`.slice(0, 200);
    const set: Partial<typeof fleetExpenses.$inferInsert> = {};
    try {
      if (outcome === 'company_cost' || outcome === 'driver_charge') {
        const categoryCode = FLEET_EXPENSE_ACCOUNTING_CATEGORY[m.category as FleetExpenseCategory] ?? 'other';
        if (m.paid) {
          const res = await this.payables.createExpense(principal, {
            onDate: String(m.expenseDate),
            categoryCode,
            description,
            amount: dollars(m.amountCents),
            truckId: m.truckId || null,
            driverId: outcome === 'driver_charge' ? m.chargeDriverId : null,
            loadId: null,
            vendorId: m.vendorId,
            paymentMethod: m.paymentMethod,
            paidDirectly: true,
            notes: m.notes,
            burden: outcome === 'driver_charge' ? 'recoverable_driver' : 'company_borne',
            provider: m.paymentMethod === 'efs' ? 'efs' : null,
            source: 'manual',
            sourceId: `fleet_expense:${m.id}`,
            receiptFileId: receipt?.fileId ?? null,
            payer: 'company',
          });
          if (!res.ok) throw unprocessable(res.blocked);
          set.acctExpenseId = res.expense.id;
        } else {
          const res = await this.payables.createBill(principal, {
            vendorId: m.vendorId as string,
            vendorInvoiceNumber: m.invoiceNumber,
            issuedOn: String(m.expenseDate),
            amount: dollars(m.amountCents),
            categoryCode,
            truckId: m.truckId || null,
            loadId: null,
            notes: [description, m.notes].filter(Boolean).join('\n'),
            attachments: files.map((f) => ({ fileId: f.fileId, fileName: f.fileName })),
            source: 'fleet_expense',
            sourceId: m.id,
            unitNumber: m.unitNumber || null,
          });
          set.acctBillId = res.bill.id;
        }
        if (outcome === 'driver_charge' && m.chargeDriverId && m.chargeCents) {
          const tx = await this.driverAccounts.chargeFromFleetExpense(principal, {
            expenseId: m.id,
            reference: m.reference,
            driverId: m.chargeDriverId,
            amountCents: Math.min(m.chargeCents, m.amountCents),
            onDate: String(m.expenseDate),
            description,
            reason: m.chargeReason ?? 'Charged to the driver',
            truckId: m.truckId,
            evidenceFileId: receipt?.fileId ?? null,
          });
          set.driverTxId = tx.id;
        }
      } else if (outcome === 'reimbursement') {
        const res = await this.reimbursements.create(principal, {
          payerDriverId: m.payerDriverId,
          truckId: m.truckId || null,
          loadId: null,
          onDate: String(m.expenseDate),
          category: FLEET_EXPENSE_REIMBURSEMENT_CATEGORY[m.category as FleetExpenseCategory] ?? 'other',
          receiptCents: m.amountCents,
          driverFundedCents: m.amountCents,
          description,
          paymentSource: 'driver_personal',
          receiptFileId: receipt?.fileId ?? null,
          missingReceiptReason: receipt ? null : `No receipt attached to fleet expense ${m.reference}`,
          note: m.notes ? m.notes.slice(0, 1000) : null,
        });
        if (!res.ok) throw unprocessable(res.blocked);
        set.reimbursementId = res.expense.id;
      }
    } catch (err) {
      // Nothing was linked: release the claim so the expense can be posted once the reason is fixed.
      if (Object.keys(set).length === 0) await this.db.update(fleetExpenses).set({ postedAt: null, postedBy: null }).where(and(eq(fleetExpenses.companyId, principal.companyId), eq(fleetExpenses.id, id)));
      else await this.db.update(fleetExpenses).set({ ...set, version: sql`${fleetExpenses.version} + 1` }).where(and(eq(fleetExpenses.companyId, principal.companyId), eq(fleetExpenses.id, id)));
      throw err;
    }
    await this.db.update(fleetExpenses).set({ ...set, version: sql`${fleetExpenses.version} + 1` }).where(and(eq(fleetExpenses.companyId, principal.companyId), eq(fleetExpenses.id, id)));
    await this.audit.write(principal, {
      action: 'fleet_expense_posted',
      entityType: 'fleet_expense',
      entityId: id,
      entityLabel: m.reference,
      summary: `${m.reference} posted to Accounting: ${[set.acctBillId ? `bill ${set.acctBillId}` : null, set.acctExpenseId ? `payment ${set.acctExpenseId}` : null, set.driverTxId ? `driver charge ${set.driverTxId}` : null, set.reimbursementId ? `reimbursement ${set.reimbursementId}` : null].filter(Boolean).join(', ')}`,
      changes: Object.entries(set).map(([field, v]) => ({ field, old: null, new: String(v) })),
    });
    return this.detail(principal, id);
  }

  async recovery(principal: Principal, id: string, raw: unknown): Promise<FleetExpenseDetail> {
    this.requireAccounting(principal);
    const action = FleetExpenseRecoveryActionSchema.parse(raw);
    const m = await this.row(principal, id);
    if (!m.driverTxId) throw unprocessable(`${m.reference} has no driver charge in Accounting yet. Post it first.`);
    const tx = await this.driverAccounts.transaction(principal, m.driverTxId);
    let summary: string;
    let reason: string | null = null;
    if (action.action === 'add_to_settlement') {
      await this.driverAccounts.scheduleRecovery(principal, tx.id, action.perSettlementCents, action.reason);
      summary = `${m.reference}: driver charge added to the next settlement${action.perSettlementCents ? ` at $${dollars(action.perSettlementCents).toFixed(2)} per settlement` : ''}`;
      reason = action.reason || null;
    } else if (action.action === 'hold') {
      await this.driverAccounts.setTransactionState(principal, tx.id, 'paused', action.reason);
      summary = `${m.reference}: driver charge on hold`;
      reason = action.reason;
    } else if (action.action === 'cancel') {
      if (tx.recoveredCents > 0) throw unprocessable(`$${dollars(tx.recoveredCents).toFixed(2)} was already deducted. Reverse those deductions first.`);
      await this.driverAccounts.setTransactionState(principal, tx.id, 'void', action.reason);
      summary = `${m.reference}: driver charge cancelled`;
      reason = action.reason;
    } else {
      await this.driverAccounts.reverseRecovery(principal, tx.id, action.settlementId, action.reason);
      summary = `${m.reference}: deduction on settlement ${action.settlementId} reversed, balance restored`;
      reason = action.reason;
    }
    await this.audit.write(principal, { action: `fleet_expense_recovery_${action.action}`, entityType: 'fleet_expense', entityId: id, entityLabel: m.reference, summary, reason, changes: [] });
    return this.detail(principal, id);
  }

  async void(principal: Principal, id: string, reason: string): Promise<FleetExpenseDetail> {
    this.requireEdit(principal);
    const m = await this.row(principal, id);
    if (m.status === 'void') return this.detail(principal, id);
    if (!reason?.trim() || reason.trim().length < 3) throw unprocessable('A void needs a reason.');
    if (m.postedAt && !hasPermission(principal, 'accounting.edit')) throw forbidden(`${m.reference} is posted to Accounting; only Accounting can void it.`);
    // Each Accounting record is undone through its own correction path, before the source is voided.
    if (m.driverTxId) {
      const tx = await this.driverAccounts.transaction(principal, m.driverTxId);
      if (tx.recoveredCents > 0) throw unprocessable(`$${dollars(tx.recoveredCents).toFixed(2)} was already deducted from the driver. Reverse those deductions first.`);
      if (tx.state !== 'void') await this.driverAccounts.setTransactionState(principal, tx.id, 'void', `Fleet expense ${m.reference} voided: ${reason.trim()}`);
    }
    if (m.acctBillId) {
      const bills = await this.db.select({ record: acctBills.record }).from(acctBills).where(and(eq(acctBills.companyId, principal.companyId), eq(acctBills.id, m.acctBillId)));
      const bill = bills[0]?.record as BillRecord | undefined;
      if (bill && bill.paid > 0) throw unprocessable(`Vendor bill ${bill.billNumber} has payments. Credit or refund it in Payables first.`);
      if (bill && bill.status !== 'void') await this.payables.updateBill(principal, bill.id, { status: 'void', reason: `Fleet expense ${m.reference} voided: ${reason.trim()}` });
    }
    if (m.acctExpenseId) {
      const res = await this.payables.voidExpense(principal, m.acctExpenseId, `Fleet expense ${m.reference} voided: ${reason.trim()}`);
      if (!res.ok) throw unprocessable(res.blocked);
    }
    if (m.reimbursementId) {
      const rows = await this.db.select({ record: acctExpenses.record }).from(acctExpenses).where(and(eq(acctExpenses.companyId, principal.companyId), eq(acctExpenses.id, m.reimbursementId)));
      const re = rows[0]?.record as ExpenseRecord | undefined;
      const status = re?.reimbursement?.status;
      if (status && status !== 'pending' && status !== 'rejected') throw unprocessable(`Reimbursement ${re?.expenseNumber} is already ${status}. Correct it in Accounting › Reimbursements.`);
      if (status === 'pending') await this.reimbursements.review(principal, m.reimbursementId, { decision: 'reject', reason: `Fleet expense ${m.reference} voided: ${reason.trim()}` });
    }
    const at = this.clock();
    const by = principal.userName ?? principal.userId;
    await this.db
      .update(fleetExpenses)
      .set({ status: 'void', voidedAt: at, voidedBy: by, voidReason: reason.trim(), version: m.version + 1, updatedAt: at, updatedBy: by })
      .where(and(eq(fleetExpenses.companyId, principal.companyId), eq(fleetExpenses.id, id)));
    await this.audit.write(principal, { action: 'fleet_expense_void', entityType: 'fleet_expense', entityId: id, entityLabel: m.reference, summary: `${m.reference} voided`, reason: reason.trim(), changes: [{ field: 'status', old: m.status, new: 'void' }] });
    return this.detail(principal, id);
  }

  // ------------------------------------------------------------ files

  async addFile(principal: Principal, id: string, input: { fileId: string; kind?: string }): Promise<FleetExpenseDetail> {
    this.requireEdit(principal);
    const m = await this.row(principal, id);
    if (m.status === 'void') throw unprocessable(`${m.reference} is void.`);
    const [file] = await this.db.select({ id: storedFiles.id, fileName: storedFiles.fileName, contentType: storedFiles.contentType }).from(storedFiles).where(and(eq(storedFiles.companyId, principal.companyId), eq(storedFiles.id, input.fileId))).limit(1);
    if (!file) throw notFound('That file is not on file for this company.');
    const kind = ['receipt', 'invoice', 'efs_receipt', 'other'].includes(input.kind ?? '') ? (input.kind as string) : 'receipt';
    const rowId = newId('fxf');
    const inserted = await this.db
      .insert(fleetExpenseFiles)
      .values({ id: rowId, companyId: principal.companyId, expenseId: id, fileId: file.id, fileName: file.fileName, contentType: file.contentType, kind, addedBy: principal.userName ?? principal.userId })
      .onConflictDoNothing()
      .returning({ id: fleetExpenseFiles.id });
    if (inserted.length > 0) {
      if (kind === 'efs_receipt' && !m.efsReceiptFileId) await this.db.update(fleetExpenses).set({ efsReceiptFileId: file.id }).where(eq(fleetExpenses.id, id));
      await this.audit.write(principal, { action: 'fleet_expense_file_added', entityType: 'fleet_expense', entityId: id, entityLabel: m.reference, summary: `${file.fileName} attached (${kind.replace('_', ' ')})`, changes: [{ field: 'file', old: null, new: file.id }] });
    }
    return this.detail(principal, id);
  }

  async removeFile(principal: Principal, id: string, rowId: string, reason: string): Promise<FleetExpenseDetail> {
    this.requireEdit(principal);
    const m = await this.row(principal, id);
    const [f] = await this.db.select().from(fleetExpenseFiles).where(and(eq(fleetExpenseFiles.companyId, principal.companyId), eq(fleetExpenseFiles.expenseId, id), eq(fleetExpenseFiles.id, rowId))).limit(1);
    if (!f) throw notFound('That file is not on this expense.');
    if (f.removedAt) return this.detail(principal, id);
    if (m.status === 'void') throw unprocessable('The expense is void; its files are kept.');
    const links = await this.links(principal, [m], [], false);
    const ev = this.evidenceIds(m, links).get(f.fileId);
    if (ev) throw unprocessable(`Accounting keeps ${f.fileName} as evidence for ${ev}. Correct it in Accounting first.`);
    const by = principal.userName ?? principal.userId;
    await this.db
      .update(fleetExpenseFiles)
      .set({ removedAt: this.clock(), removedBy: by, removeReason: reason?.trim() || null })
      .where(and(eq(fleetExpenseFiles.companyId, principal.companyId), eq(fleetExpenseFiles.id, rowId), isNull(fleetExpenseFiles.removedAt)));
    if (m.efsReceiptFileId === f.fileId) await this.db.update(fleetExpenses).set({ efsReceiptFileId: null }).where(eq(fleetExpenses.id, id));
    await this.audit.write(principal, { action: 'fleet_expense_file_removed', entityType: 'fleet_expense', entityId: id, entityLabel: m.reference, summary: `${f.fileName} removed from the expense (the stored file is kept)`, reason: reason?.trim() || null, changes: [{ field: 'file', old: f.fileId, new: null }] });
    return this.detail(principal, id);
  }
}
