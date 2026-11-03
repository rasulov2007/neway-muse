import { MAX_PAGE_SIZE } from './internals';
import type {
  AccountingSettings,
  DispatcherCommissionBreakdown,
  CompletionRecord,
  BillingQueue,
  BillingVerdict,
  DriverProfileRecord,
  DriverTx,
  JournalEntry,
  LedgerPeriod,
  ManualChargeInput,
  ProfileVersion,
  RecordFundingInput,
  RecurringDeduction,
  RecurringDeductionInput,
  ReimbursementBlock,
  ReimbursementTotals,
  CreateReimbursementInput,
  ReviseInvoiceInput,
  AddChargeAfterInvoicingInput,
  SettingsProblem,
  StatementComputation,
  UpdateDriverProfileInput,
  VendorStatementComputation,
} from '@neway/shared';
import { apiGet, apiPost, apiPut } from '@/lib/api-client';
import type { ListResult } from './api';
import type { Bill, Expense, InvoiceLine, Payment, PayrollPeriod, Payslip, Settlement, Vendor } from './accounting-types';
import type { Invoice, IsoDate } from './types';

/**
 * Accounting, from the server (owner brief 2026-09-27).
 *
 * Every read and write here goes to `/accounting/*`; nothing is kept in the browser beyond the
 * query cache. The list functions keep the names and shapes the pages were built on, so a page
 * that read the workspace yesterday reads the server today without knowing.
 */

// ------------------------------------------------------------------ server shapes

export interface ServerInvoice extends Invoice {
  family: string;
  revision: number;
  isCurrent: boolean;
  /** Printed on the invoice and in the RTS package. */
  invoiceNote?: string | null;
  /** Accounting only; never printed or sent. */
  internalNotes?: Array<{ id: string; text: string; by: string; at: string; edits: Array<{ text: string; by: string; at: string }> }>;
  draftRevisionId?: string | null;
  revisionOf?: { invoiceId: string; invoiceNumber: string; originalInvoiceNumber: string; reason: string; previousTotal: number; adjustment: number; revisedOn: string | null } | null;
  priorSubmission?: { invoiceNumber: string; status: string; reference: string | null; at: string | null; fundedGross: number } | null;
  creditBalance?: number;
  issuedPdf?: { fileId: string; sha256: string; at: string } | null;
  rtsBatch?: { batchId: string; batchNumber: string } | null;
  /** On a supplemental invoice (INV-10004-S1): the original it adds charges to. */
  supplementOf?: { invoiceId: string; invoiceNumber: string; family: string; sequence: number; reason: string; requestKey: string } | null;
  supersedesId: string | null;
  lines: Array<InvoiceLine & { loadChargeId?: string | null }>;
  documentPackage: Array<{ id: string; type: string; fileHash: string | null; fileName: string }>;
  rc: { loadReference: string | null; rcReference: string | null; state: string } | null;
  submission: { provider: string; status: 'prepared' | 'submitted' | 'accepted' | 'rejected'; reference: string | null; at: string | null; issues: string[]; by: string | null } | null;
  factoring: { billViaFactoring: boolean; fundedGross: number; feeCents: number; reserveCents: number; fundingIds: string[] };
  revisions: Array<{ revision: number; invoiceId: string; invoiceNumber: string; at: string; by: string; reason: string; delta: number; total: number }>;
  history: Array<{ at: string; by: string; action: string; detail: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface ServerBill extends Bill {
  sourceKey: string;
  attachments: Array<{ fileId: string; fileName: string }>;
  disputes: Array<{ at: string; by: string; reason: string; resolvedAt: string | null }>;
}

export interface ServerExpense extends Expense {
  sourceKey: string;
  accountingDate: string;
  currency: string;
  provider: string | null;
  payer: 'company' | 'driver' | 'vendor';
  burden: 'company_borne' | 'recoverable_driver' | 'recoverable_vendor';
  chargeRecipientId: string | null;
  allocations: Array<{ partyType: 'driver' | 'vendor' | 'truck' | 'load'; partyId: string; amount: number }>;
  driverTransactionId: string | null;
  receiptFileId: string | null;
}

export interface Statement {
  id: string;
  settlementNumber: string;
  batchId: string;
  kind: 'cd' | 'lo_oo' | 'vt';
  partyType: 'driver' | 'vendor';
  partyId: string;
  partyName: string;
  truckId: string | null;
  unitNumber: string | null;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  /** When the pay period opens (Monday noon Eastern); absent on statements made before 2026-10-21. */
  startsAt?: string | null;
  cutoffAt: string;
  payDate: IsoDate;
  status: 'draft' | 'review' | 'approved' | 'paid' | 'reversed';
  netCents: number;
  payableCents: number;
  carryCents: number;
  computation: StatementComputation | null;
  vendor: VendorStatementComputation | null;
  snapshot: { profileEffectiveFrom: string | null; payeeVersion: number | null; documents: string[] } | null;
  loadIds: string[];
  /** Loads taken off this draft ("Not on this statement"), each with its reason; Put back returns one. */
  removedLoads?: Array<{ loadId: string; loadNumber: string; reason: string; by: string; at: string }>;
  /** Loads a person put here (put back, carried from the week before, paid as late, moved by a pay date). */
  addedLoads?: Array<{ loadId: string; loadNumber: string; how: 'put_back' | 'carried' | 'late' | 'pay_date'; by: string; at: string }>;
  exceptions: string[];
  approvedAt: string | null;
  approvedBy: string | null;
  paidAt: string | null;
  paymentId: string | null;
  paidCents: number | null;
  notes: string | null;
  versions: Array<{ version: number; at: string; by: string; netCents: number; payableCents: number }>;
  createdAt: string;
  updatedAt: string;
}

export interface SettlementBatch {
  id: string;
  kind: 'cd' | 'lo_oo' | 'vt';
  periodStart: IsoDate;
  periodEnd: IsoDate;
  startsAt?: string | null;
  cutoffAt: string;
  payDate: IsoDate;
  timezone: string;
  cutoffBasis: string;
  status: 'open' | 'review' | 'approved' | 'closed';
  generatedAt: string;
  generatedBy: string;
  statementIds: string[];
  lateLoads: Array<{ loadId: string; loadNumber: string; completedAt: string; driverId: string | null }>;
  totals: { count: number; signedNetCents: number; payableCents: number; carryCents: number };
  closedAt: string | null;
  notes: string | null;
}

export interface BillingQueueRow {
  load: {
    id: string;
    loadNumber: string;
    status: string;
    brokerReference: string | null;
    customerName: string;
    brokerName: string | null;
    rate: number;
    driverName: string | null;
    truckUnit: string | null;
    deliveredAt: string | null;
    documents: Array<{ id: string; type: string; status: string; review?: string; fileName?: string; fileUrl?: string | null; mimeType?: string | null; extractedReference?: string | null; extractionConfidence?: string | null }>;
    charges: Array<{ id: string; type: string; description: string; amount: number; billable: boolean; status?: string }>;
    openFlags?: number;
  };
  verdict: BillingVerdict;
  /** The invoice to act on: the load's own, or - once that has gone to RTS - a supplemental one still to issue or send. */
  invoice: ServerInvoice | null;
  /** When `invoice` is a supplemental invoice: the load's original invoice, already with RTS. */
  parentInvoice?: ServerInvoice | null;
  /** Every supplemental invoice of the load (charges billed after the original was sent). */
  supplements?: ServerInvoice[];
}

export interface BillingQueueResponse {
  rows: BillingQueueRow[];
  counts: Record<BillingQueue, number>;
  totals: Record<BillingQueue, number>;
}

export interface DriverAccount {
  driverId: string;
  name: string | null;
  profile: { driverId: string; version: number; record: DriverProfileRecord; current: ProfileVersion | null; defaulted: boolean };
  debt: { openingCents: number | null; newChargesCents: number; recoveredCents: number; closingCents: number | null; open: DriverTx[] };
  /** Always present: the balance exists whether or not collection is switched on. */
  escrow: { openingCents: number | null; depositsCents: number; refundsCents: number; offsetsCents: number; balanceCents: number | null; movementsCents: number; openingReconciled: boolean; targetCents: number; nextDeductionCents: number; collectionEnabled: boolean };
  /** The percentage as the account reads it, with both readings when the roster figure is ambiguous. */
  rate: { percent: number; ambiguous: boolean; asPercent: string; asMultiplier: string; confirmed: boolean; confirmedBy: string | null; basis: string } | null;
  pendingDeductionsCents: number;
  currentPayableCents: number;
  approvedUnpaidCents: number;
  draftNetCents: number;
  draftCount: number;
  /** Earned on completed loads, not yet on an approved statement; null when any candidate cannot be calculated. */
  earnedUnsettledCents: number | null;
  earnedBlockers: string[];
  earnings: Array<{ loadId: string; loadNumber: string; loadStatus: string; completedAt: string | null; grossCents: number; linehaulCents: number; cents: number | null; planKind: string | null; planRate: number | null; planEffectiveFrom: string | null; rateConfirmed: boolean; blockers: string[]; settlementId: string | null; settlementStatus: string | null; invoiceQueue: string | null; invoiceStatus: string | null; pipelineState: 'processed' | 'error'; pipelineError: string | null }>;
  paidToDateCents: number;
  companyCosts: DriverTx[];
  transactions: DriverTx[];
  recurring: RecurringDeduction[];
  statements: Array<Pick<Statement, 'id' | 'status' | 'netCents' | 'payableCents' | 'periodStart' | 'periodEnd' | 'paidAt' | 'settlementNumber'>>;
  history: Array<{ id: string; at: string; byName: string; body: string }>;
}

export interface SettingConfirmation {
  at: string;
  by: string;
  note: string;
}

export interface AccountingSettingsResponse {
  /** Setting key to who confirmed it, when, and why. Absent means nobody has decided it. */
  confirmations?: Record<string, SettingConfirmation>;
  /** Every save, newest first. */
  history?: Array<{ at: string; by: string; changed: string[] }>;
  version: number;
  settings: AccountingSettings;
  problems: SettingsProblem[];
  dispatcherPeriodAnchor: string | null;
  timezone: { value: string; source: string; note: string };
  integrations: Record<'rts' | 'relay' | 'bestpass' | 'efs' | 'breakthrough_fuel' | 'quickbooks' | 'adp' | 'email', { state: IntegrationState; detail: string }>;
}

export type IntegrationState = 'csv_import' | 'export' | 'sandbox' | 'live' | 'not_configured';

export type CompletionRow = CompletionRecord;

export interface LegacyEscrowReport {
  dryRun: boolean;
  found: number;
  imported: number;
  alreadyImported: number;
  skipped: Array<{ id: string; reason: string }>;
  movements: Array<{ legacyId: string; driverId: string; kind: string; amountCents: number; date: string; recordedBy: string; state: 'new' | 'already' }>;
}

export interface PayeeProfile {
  id: string;
  partyType: 'driver' | 'vendor';
  partyId: string;
  legalName: string;
  payeeIdentity: string | null;
  accountType: 'checking' | 'savings' | null;
  accountLast4: string | null;
  routingLast4: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  bankVersion: number;
  history: Array<{ at: string; by: string; action: string; detail: string }>;
  updatedAt: string;
}

export interface PaymentBatch {
  id: string;
  kind: 'driver' | 'vendor' | 'staff';
  status: string;
  provider: string;
  lines: Array<{ statementId: string; partyType: string; partyId: string; partyName: string; amountCents: number; payeeId: string | null; payeeBankVersion: number | null; accountLast4: string | null; problems: string[] }>;
  totalCents: number;
  externalId: string | null;
  errors: string[];
  approvedAt: string | null;
  exportedAt: string | null;
  createdAt: string;
}

export interface ImportLine {
  id: string;
  provider: string;
  sourceKey: string;
  occurredOn: IsoDate;
  amountCents: number;
  state: 'matched' | 'unmatched' | 'ignored';
  cardOrUnit: string | null;
  unitNumber: string | null;
  driverName: string | null;
  truckId: string | null;
  driverId: string | null;
  description: string;
  kind: string;
  driverChargeIndicator: boolean;
  expenseId: string | null;
  problems: string[];
  importedAt: string;
}

export interface StaffPayPlan {
  id: string;
  employeeId: string;
  kind: 'salary' | 'dispatcher_commission';
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  currency: string;
  salaryCents: number | null;
  frequency: string;
  sharedCreditRule: string | null;
  /** Recorded as the owner states them; the commission formula stays the dispatch policy's. */
  commissionBase?: 'gross' | 'linehaul' | 'net_revenue' | null;
  commissionRatePercent?: number | null;
}

export interface StaffMember {
  id: string;
  name: string;
  position: string;
  department: string;
  status: string;
  plans: StaffPayPlan[];
}

export interface ServerPayrollPeriod {
  id: string;
  periodNumber: string;
  kind: 'dispatcher' | 'salary';
  periodStart: IsoDate;
  periodEnd: IsoDate;
  payDate: IsoDate;
  status: 'draft' | 'review' | 'finalized' | 'paid' | 'closed';
  lines: Array<{ employeeId: string; employeeName: string; role: string; plan: StaffPayPlan | null; commissionCents: number | null; commissionSource?: 'computed' | 'manual' | null; commissionReason?: string | null; commissionDetail?: DispatcherCommissionBreakdown | null; bonusCents: number; advanceCents: number; adjustments: Array<{ description: string; cents: number; reason: string; approvedBy: string }>; baseCents: number; grossCents: number; netCents: number; exceptions: string[] }>;
  grossCents: number;
  netCents: number;
  blocked: number;
  finalizedAt: string | null;
  paidAt: string | null;
  closedAt: string | null;
}

// ------------------------------------------------------------------ paging in memory

export interface AccountingQuery {
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  sortDir?: 'asc' | 'desc';
  ids?: string[];
  from?: IsoDate;
  to?: IsoDate;
}

function page<T extends { id: string }>(rows: T[], query: AccountingQuery, searchable: (r: T) => Array<string | null | undefined>): ListResult<T> {
  let out = rows;
  if (query.ids?.length) out = out.filter((r) => query.ids!.includes(r.id));
  if (query.search?.trim()) {
    const q = query.search.trim().toLowerCase();
    out = out.filter((r) => searchable(r).some((v) => v && v.toLowerCase().includes(q)));
  }
  if (query.sort) {
    const key = query.sort as keyof T;
    out = [...out].sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? ''), 'en', { numeric: true }));
    if (query.sortDir === 'desc') out.reverse();
  }
  const p = Math.max(1, query.page ?? 1);
  const size = Math.max(1, Math.min(MAX_PAGE_SIZE, query.pageSize ?? 25));
  return { data: out.slice((p - 1) * size, p * size), total: out.length, page: p, pageSize: size };
}

// ------------------------------------------------------------------ reads

export function fetchInvoices(): Promise<ServerInvoice[]> {
  return apiGet<ServerInvoice[]>('/accounting/invoices');
}

export async function listInvoicesFromServer(query: AccountingQuery & { billToId?: string; agingBucket?: string } = {}): Promise<ListResult<Invoice>> {
  const rows = (await apiGet<ServerInvoice[]>('/accounting/receivables')).filter((i) => (!query.billToId || i.billToId === query.billToId) && (!query.agingBucket || i.agingBucket === query.agingBucket));
  return page(rows, query, (i) => [i.invoiceNumber, i.loadNumber, i.billToName, i.rc?.loadReference ?? '', i.rc?.rcReference ?? '']);
}

export async function getInvoiceFromServer(idOrNumber: string): Promise<ServerInvoice | null> {
  try {
    return await apiGet<ServerInvoice>(`/accounting/invoices/${encodeURIComponent(idOrNumber)}`);
  } catch {
    return null;
  }
}

export async function listInvoiceLines(query: AccountingQuery & { invoiceId?: string } = {}): Promise<ListResult<InvoiceLine>> {
  const invoices = await fetchInvoices();
  const lines = invoices.flatMap((i) => i.lines).filter((l) => !query.invoiceId || l.invoiceId === query.invoiceId);
  return page(lines, query, (l) => [l.description, l.chargeType]);
}

export async function listPayments(query: AccountingQuery & { direction?: 'in' | 'out'; partyId?: string } = {}): Promise<ListResult<Payment>> {
  const rows = (await apiGet<Payment[]>('/accounting/payments')).filter((p) => (!query.direction || p.direction === query.direction) && (!query.partyId || p.partyId === query.partyId));
  return page(rows, query, (p) => [p.reference, p.partyName, p.method]);
}

export async function listBills(query: AccountingQuery & { vendorId?: string; status?: string; categoryCode?: string } = {}): Promise<ListResult<Bill>> {
  const rows = (await apiGet<ServerBill[]>('/accounting/bills')).filter((b) => (!query.vendorId || b.vendorId === query.vendorId) && (!query.status || b.status === query.status) && (!query.categoryCode || b.categoryCode === query.categoryCode));
  return page(rows, query, (b) => [b.billNumber, b.vendorInvoiceNumber, b.vendorName, b.unitNumber, b.notes]);
}

export async function listExpenses(query: AccountingQuery & { categoryCode?: string; truckId?: string; driverId?: string; loadId?: string; vendorId?: string } = {}): Promise<ListResult<Expense>> {
  const rows = (await apiGet<ServerExpense[]>('/accounting/expenses')).filter(
    (e) => (!query.categoryCode || e.categoryCode === query.categoryCode) && (!query.truckId || e.truckId === query.truckId) && (!query.driverId || e.driverId === query.driverId) && (!query.loadId || e.loadId === query.loadId) && (!query.vendorId || e.vendorId === query.vendorId) && (!query.from || e.onDate >= query.from) && (!query.to || e.onDate <= query.to),
  );
  return page(rows, query, (e) => [e.expenseNumber, e.description, e.vendorName, e.unitNumber, e.driverName, e.loadNumber]);
}

export async function listVendors(query: AccountingQuery = {}): Promise<ListResult<Vendor>> {
  const rows = await apiGet<Vendor[]>('/accounting/vendors');
  return page(rows, query, (v) => [v.name, v.kind, v.city, v.state]);
}

/** Statements as the older pages read them: one row per driver statement. */
export function statementToSettlement(s: Statement): Settlement {
  const c = s.computation;
  const status: Settlement['status'] = s.status === 'approved' ? 'finalized' : s.status === 'review' ? 'pending_review' : s.status === 'paid' ? 'paid' : s.status === 'reversed' ? 'reversed' : 'draft';
  return {
    id: s.id,
    settlementNumber: s.settlementNumber,
    driverId: s.partyId,
    driverName: s.partyName,
    truckId: s.truckId,
    unitNumber: s.unitNumber,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    status,
    payPlanKind: '',
    payPlanRate: 0,
    gross: (c?.grossCents ?? s.vendor?.totalEarningsCents ?? 0) / 100,
    deductions: (c?.deductionsCents ?? s.vendor?.totalDeductionsCents ?? 0) / 100,
    escrow: (c?.escrowCents ?? 0) / 100,
    adjustments: 0,
    net: s.netCents / 100,
    loadCount: c?.loadCount ?? s.loadIds.length,
    totalMiles: c?.totalMiles ?? 0,
    lines: [
      ...(c?.earnings ?? []).map((e, i) => ({ id: `${s.id}_e${i}`, settlementId: s.id, kind: (e.kind === 'reimbursement' ? 'reimbursement' : e.kind === 'accessorial' ? 'accessorial' : 'load_pay') as Settlement['lines'][number]['kind'], loadId: e.loadId, loadNumber: e.loadNumber, description: e.description, amount: e.cents / 100, basis: e.basis })),
      ...(c?.deductions ?? []).map((d, i) => ({ id: `${s.id}_d${i}`, settlementId: s.id, kind: (d.kind === 'escrow' ? 'escrow' : d.kind === 'advance' ? 'advance' : 'deduction') as Settlement['lines'][number]['kind'], loadId: null, loadNumber: null, description: d.description, amount: -d.cents / 100, basis: d.basis })),
    ],
    excluded: c?.excluded ?? [],
    shortfall: s.carryCents > 0 ? s.carryCents / 100 : null,
    finalizedAt: s.approvedAt,
    finalizedBy: s.approvedBy,
    paidAt: s.paidAt,
    paymentId: s.paymentId,
    notes: s.notes,
  };
}

export function fetchStatements(where?: { batchId?: string; partyId?: string; kind?: string }): Promise<Statement[]> {
  const q = new URLSearchParams();
  if (where?.batchId) q.set('batchId', where.batchId);
  if (where?.partyId) q.set('partyId', where.partyId);
  if (where?.kind) q.set('kind', where.kind);
  const qs = q.toString();
  return apiGet<Statement[]>(`/accounting/settlements${qs ? `?${qs}` : ''}`);
}

export async function listSettlements(query: AccountingQuery & { driverId?: string; status?: string } = {}): Promise<ListResult<Settlement>> {
  const rows = (await fetchStatements(query.driverId ? { partyId: query.driverId } : undefined)).map(statementToSettlement).filter((s) => !query.status || s.status === query.status);
  return page(rows, query, (s) => [s.settlementNumber, s.driverName, s.unitNumber]);
}

export function fetchStatement(id: string): Promise<Statement> {
  return apiGet<Statement>(`/accounting/settlements/${encodeURIComponent(id)}`);
}

export function fetchBatches(): Promise<SettlementBatch[]> {
  return apiGet<SettlementBatch[]>('/accounting/settlements/batches');
}

export async function listPayrollPeriods(query: AccountingQuery = {}): Promise<ListResult<PayrollPeriod>> {
  const rows = (await apiGet<ServerPayrollPeriod[]>('/accounting/payroll/periods')).map(
    (p): PayrollPeriod => ({ id: p.id, periodNumber: p.periodNumber, periodStart: p.periodStart, periodEnd: p.periodEnd, payDate: p.payDate, status: p.status === 'draft' ? 'open' : p.status, gross: p.grossCents / 100, taxWithheld: 0, deductions: (p.grossCents - p.netCents) / 100, net: p.netCents / 100, workerCount: p.lines.length, finalizedAt: p.finalizedAt, finalizedBy: null, paidAt: p.paidAt, closedAt: p.closedAt }),
  );
  return page(rows, query, (p) => [p.periodNumber]);
}

export function fetchPayrollPeriods(): Promise<ServerPayrollPeriod[]> {
  return apiGet<ServerPayrollPeriod[]>('/accounting/payroll/periods');
}

export async function listPayslips(query: AccountingQuery & { payrollPeriodId?: string; employeeId?: string } = {}): Promise<ListResult<Payslip>> {
  const periods = await fetchPayrollPeriods();
  const rows = periods.flatMap((p) =>
    p.lines.map(
      (l): Payslip => ({ id: `${p.id}_${l.employeeId}`, payrollPeriodId: p.id, employeeId: l.employeeId, employeeName: l.employeeName, title: l.role, workerType: 'employee', hourly: false, hours: null, basePay: l.baseCents / 100, bonuses: l.bonusCents / 100, taxWithheld: null, deductions: l.advanceCents / 100, gross: l.grossCents / 100, netPay: l.netCents / 100, locked: p.status !== 'draft' && p.status !== 'review', notes: l.exceptions.join(' ') || null }),
    ),
  );
  return page(rows.filter((r) => (!query.payrollPeriodId || r.payrollPeriodId === query.payrollPeriodId) && (!query.employeeId || r.employeeId === query.employeeId)), query, (p) => [p.employeeName, p.title]);
}

export async function listJournal(query: AccountingQuery & { source?: string; accountCode?: string } = {}): Promise<ListResult<JournalEntry>> {
  const { journal } = await apiGet<{ journal: JournalEntry[]; periods: LedgerPeriod[] }>('/accounting/ledger');
  const rows = journal.filter((e) => (!query.source || e.source === query.source) && (!query.accountCode || e.lines.some((l) => l.accountCode === query.accountCode)) && (!query.from || e.onDate >= query.from) && (!query.to || e.onDate <= query.to));
  return page(rows, query, (e) => [e.memo, e.sourceKey, e.reference?.label]);
}

export async function listLedgerPeriods(): Promise<LedgerPeriod[]> {
  return (await apiGet<{ journal: JournalEntry[]; periods: LedgerPeriod[] }>('/accounting/ledger')).periods;
}

/** Recurring deductions took over from the workspace's deduction plans; nothing lists the old ones. */
export async function listDeductionPlans(): Promise<ListResult<never>> {
  return { data: [], total: 0, page: 1, pageSize: 25 };
}

export function fetchSettings(): Promise<AccountingSettingsResponse> {
  return apiGet<AccountingSettingsResponse>('/accounting/settings');
}

export function saveSettings(input: { expectedVersion: number; settings: Partial<AccountingSettings>; dispatcherPeriodAnchor?: string | null; confirmations?: Record<string, string> }) {
  return apiPut<{ version: number; settings: AccountingSettings; problems: SettingsProblem[] }>('/accounting/settings', input);
}

export function fetchBillingQueue(): Promise<BillingQueueResponse> {
  return apiGet<BillingQueueResponse>('/accounting/billing/queue');
}

export interface BackfillReport { dryRun: boolean; scanned: number; missing: string[]; stale: string[]; errors: Array<{ loadId: string; loadNumber: string; error: string }>; totals: { grossCents: number; earnedCents: number; blocked: number }; created: number; updated: number }

export function fetchCompletions(): Promise<CompletionRow[]> {
  return apiGet<CompletionRow[]>('/accounting/completions');
}

export function fetchCompletionBackfill(): Promise<BackfillReport> {
  return apiGet('/accounting/completions/backfill');
}

export function runCompletionBackfill(): Promise<BackfillReport> {
  return apiPost('/accounting/completions/backfill', {});
}

export function retryCompletion(loadId: string): Promise<CompletionRow> {
  return apiPost(`/accounting/completions/${encodeURIComponent(loadId)}/retry`, {});
}

export function fetchLegacyEscrow(): Promise<LegacyEscrowReport> {
  return apiGet('/accounting/legacy/escrow');
}

export function importLegacyEscrow(): Promise<LegacyEscrowReport> {
  return apiPost('/accounting/legacy/escrow/import', {});
}

export function retryDelivery(id: string): Promise<{ id: string; status: string; reason: string | null }> {
  return apiPost(`/accounting/deliveries/${encodeURIComponent(id)}/retry`, {});
}

export function fetchProfitability(range: { from: string; to: string }): Promise<ProfitabilityReport> {
  return apiGet(`/accounting/profitability?from=${range.from}&to=${range.to}`);
}

export interface ProfitabilityReport {
  range: { from: string; to: string };
  loads: Array<{ loadId: string; loadNumber: string; truckId: string | null; unitNumber: string | null; drivers: string[]; grossCents: number; invoicedCents: number; driverPayCents: number | null; postedCostsCents: number; marginCents: number | null; missing: string[] }>;
  trucks: Array<{ truckId: string; unitNumber: string | null; loads: number; grossCents: number; invoicedCents: number; driverPayCents: number; payMissing: number; loadCostsCents: number; truckCostsCents: number; marginCents: number | null }>;
  unallocatedCostsCents: number;
  unallocatedCount: number;
  reconciliation: { operationalGrossCents: number; invoicedRevenueCents: number; unbilledCents: number; note: string };
}

export function fetchDriverAccount(driverId: string): Promise<DriverAccount> {
  return apiGet<DriverAccount>(`/accounting/drivers/${encodeURIComponent(driverId)}/account`);
}

export function fetchPayees(): Promise<PayeeProfile[]> {
  return apiGet<PayeeProfile[]>('/accounting/payees');
}

export function fetchPaymentBatches(): Promise<PaymentBatch[]> {
  return apiGet<PaymentBatch[]>('/accounting/payment-batches');
}

export function fetchImports(state?: string): Promise<ImportLine[]> {
  return apiGet<ImportLine[]>(`/accounting/imports${state ? `?state=${state}` : ''}`);
}

export interface WorkOrderBillCandidate { workOrderId: string; number: string; unitNumber: string; vendorId: string | null; vendorName: string | null; completedAt: string | null; total: number; amountSource: 'invoice' | 'work_order' | 'none'; hasBill: boolean; billId: string | null; billNumber: string | null; billStatus: string | null; expensePosted: boolean; documentCount: number; problems: string[]; reviewReason: string | null }

export interface SettlementPreview {
  kind: 'cd' | 'lo_oo' | 'vt';
  period: { start: string; end: string; startsAt?: string; cutoffAt: string; payDate: string; timezone?: string };
  /** "Mon Oct 12, 12:00 PM – Mon Oct 19, 12:00 PM ET": the real window. */
  periodLabel?: string;
  timezone: string;
  cutoffBasis: string | null;
  previewBasis: string;
  setup: Array<{ key: string; label: string; detail: string }>;
  canGenerate: boolean;
  existingBatch: { id: string; status: string; statements: number } | null;
  lateLoads: number;
  loadsInWeek: number;
  drivers: Array<{ driverId: string; driverNumber: string; name: string; unitNumber: string | null; contractType: string; loads: Array<{ loadId: string; loadNumber: string; grossCents: number; cents: number | null; blockers: string[] }>; grossCents: number; earnedCents: number | null; blockers: string[]; statementStatus: string | null }>;
}

export function fetchSettlementPreview(kind: 'cd' | 'lo_oo' | 'vt', weekOf: string): Promise<SettlementPreview> {
  return apiGet(`/accounting/settlements/preview?kind=${kind}&weekOf=${weekOf}`);
}

export interface DriverReviewRow {
  driverId: string; driverNumber: string; name: string; contractType: string;
  plan: { kind: string; rate: number; basis: string } | null;
  rate: { percent: number; ambiguous: boolean; asPercent: string; asMultiplier: string } | null;
  rateConfirmed: boolean; profileSaved: boolean;
  issues: Array<{ kind: 'rate_ambiguous' | 'basis_unconfirmed' | 'plan_unreviewed' | 'opening_debt' | 'opening_escrow' | 'no_payee' | 'no_email'; label: string; detail: string }>;
  completedLoads: number; earnedPreviewCents: number | null; blockedLoads: number;
}

export function fetchRecurringAll(): Promise<Array<RecurringDeduction & { driverName: string | null }>> {
  return apiGet('/accounting/recurring');
}

export function fetchDriverReview(): Promise<DriverReviewRow[]> {
  return apiGet('/accounting/drivers/review');
}

export interface ImportResult { dryRun: boolean; imported: number; duplicates: number; matched: number; unmatched: number; errors: number; records: ImportLine[]; totalCents: number }

export function previewImportCsv(provider: 'relay' | 'bestpass' | 'efs' | 'csv', csv: string): Promise<ImportResult> {
  return apiPost('/accounting/imports/csv/preview', { provider, csv });
}

export function fetchWorkOrderBillCandidates(): Promise<WorkOrderBillCandidate[]> {
  return apiGet('/accounting/bills/work-order-candidates');
}

export function fetchStaff(): Promise<StaffMember[]> {
  return apiGet<StaffMember[]>('/accounting/payroll/staff');
}

export function fetchArrangements() {
  return apiGet<Array<{ id: string; vendorId: string; truckId: string; effectiveFrom: string; effectiveTo: string | null; percentBps: number | null; note?: string | null; version: number }>>('/accounting/settlements/arrangements');
}

export function fetchDeliveries(documentType?: string, documentId?: string) {
  const q = documentType && documentId ? `?documentType=${documentType}&documentId=${encodeURIComponent(documentId)}` : '';
  return apiGet<Array<{ id: string; documentType: string; documentId: string; channel: string; recipient: string | null; status: string; reason: string | null; at: string; byName: string; label?: string }>>(`/accounting/deliveries${q}`);
}

// ------------------------------------------------------------------ writes

type Outcome<K extends string, T> = { ok: true; blocked?: undefined } & Record<K, T> | { ok: false; blocked: string } & Partial<Record<K, T | null>>;

export function issueInvoice(input: { invoiceId: string }): Promise<Outcome<'invoice', ServerInvoice>> {
  return apiPost(`/accounting/invoices/${encodeURIComponent(input.invoiceId)}/issue`, {});
}

export function voidInvoice(input: { invoiceId: string; reason: string }): Promise<Outcome<'invoice', ServerInvoice>> {
  return apiPost(`/accounting/invoices/${encodeURIComponent(input.invoiceId)}/void`, { reason: input.reason });
}

export function reviseInvoice(invoiceId: string, input: ReviseInvoiceInput): Promise<Outcome<'invoice', ServerInvoice>> {
  return apiPost(`/accounting/invoices/${encodeURIComponent(invoiceId)}/revise`, input);
}

export function markSubmission(invoiceId: string, input: { status: 'submitted' | 'accepted' | 'rejected'; reference?: string; issues?: string[]; evidence?: string }): Promise<Outcome<'invoice', ServerInvoice>> {
  return apiPost(`/accounting/invoices/${encodeURIComponent(invoiceId)}/submission`, input);
}

export function disputeInvoice(invoiceId: string, reason: string): Promise<Outcome<'invoice', ServerInvoice>> {
  return apiPost(`/accounting/invoices/${encodeURIComponent(invoiceId)}/dispute`, { reason });
}

export function createInvoicesFromLoads(loadIds: string[]): Promise<{ created: ServerInvoice[]; skipped: Array<{ loadId: string; reason: string }> }> {
  return apiPost('/accounting/invoices/from-loads', { ids: loadIds });
}

export function recordPayment(input: { partyType: 'customer' | 'broker'; partyId: string; partyName: string; amount: number; method: string; receivedOn: IsoDate; reference: string; applications: Array<{ invoiceId: string; amount: number }>; notes?: string | null }): Promise<Outcome<'payment', Payment>> {
  return apiPost('/accounting/payments', input);
}

export function recordFunding(input: RecordFundingInput): Promise<Outcome<'payment', Payment>> {
  return apiPost('/accounting/fundings', input);
}

export function recordRcReading(loadId: string, input: { documentId: string; rcReference: string; confidence?: 'person' | 'extracted' | 'uncertain' }) {
  return apiPost(`/accounting/billing/loads/${encodeURIComponent(loadId)}/rc-reading`, input);
}

export function resolveBillingException(loadId: string, input: { kind: 'rc_mismatch' | 'rc_unreadable' | 'rc_duplicate' | 'rc_no_reference'; reason: string; rcReference?: string; evidenceFileId?: string }) {
  return apiPost(`/accounting/billing/loads/${encodeURIComponent(loadId)}/resolve`, input);
}

export function allocateAccessorial(loadId: string, input: { chargeId: string; treatment: 'in_percentage_base' | 'paid_separately' | 'excluded'; mode?: 'full' | 'percent' | 'fixed'; value?: number; nature?: 'earning' | 'reimbursement'; recipients: string[] }) {
  return apiPost(`/accounting/billing/loads/${encodeURIComponent(loadId)}/accessorials`, input);
}

export function createBill(input: { vendorId: string; vendorInvoiceNumber: string | null; issuedOn: IsoDate; amount: number; categoryCode: string; truckId: string | null; loadId: string | null; notes: string | null }): Promise<Bill> {
  return apiPost<{ bill: ServerBill; created: boolean }>('/accounting/bills', input).then((r) => r.bill);
}

export function createBillsFromWorkOrders(ids: string[]): Promise<{ created: ServerBill[]; skipped: Array<{ workOrderId: string; reason: string }> }> {
  return apiPost('/accounting/bills/from-work-orders', { ids });
}

export function updateBill(input: { billId: string; status?: string; scheduledFor?: IsoDate | null; reason?: string | null; dispute?: string | null }): Promise<Outcome<'bill', ServerBill>> {
  const { billId, ...rest } = input;
  return apiPost(`/accounting/bills/${encodeURIComponent(billId)}`, rest);
}

export function payBill(input: { billId: string; amount: number; method: string; paidOn: IsoDate; reference: string }): Promise<Outcome<'bill', ServerBill>> {
  const { billId, ...rest } = input;
  return apiPost(`/accounting/bills/${encodeURIComponent(billId)}/pay`, rest);
}

export function createExpense(input: { onDate: IsoDate; accountingDate?: IsoDate; categoryCode: string; description: string; amount: number; truckId: string | null; driverId: string | null; loadId: string | null; vendorId: string | null; paymentMethod: string | null; paidDirectly: boolean; notes: string | null; burden?: ServerExpense['burden']; receiptFileId?: string | null; payer?: ServerExpense['payer'] }): Promise<Outcome<'expense', ServerExpense>> {
  return apiPost('/accounting/expenses', input);
}

export function importCsv(provider: 'relay' | 'bestpass' | 'efs' | 'csv', csv: string): Promise<ImportResult> {
  return apiPost('/accounting/imports/csv', { provider, csv });
}

export function resolveImport(id: string, input: { truckId?: string | null; driverId?: string | null; ignore?: boolean; reason?: string }): Promise<ImportLine> {
  return apiPost(`/accounting/imports/${encodeURIComponent(id)}/resolve`, input);
}

export function postImports(ids: string[]): Promise<{ posted: number; skipped: Array<{ id: string; reason: string }> }> {
  return apiPost('/accounting/imports/post', { ids });
}

export function updateDriverProfile(driverId: string, input: UpdateDriverProfileInput) {
  return apiPut<{ version: number; record: DriverProfileRecord; current: ProfileVersion | null }>(`/accounting/drivers/${encodeURIComponent(driverId)}/profile`, input);
}

export function addManualCharge(driverId: string, input: ManualChargeInput): Promise<DriverTx> {
  return apiPost(`/accounting/drivers/${encodeURIComponent(driverId)}/charges`, input);
}

export function addDriverAccountNote(driverId: string, body: string) {
  return apiPost(`/accounting/drivers/${encodeURIComponent(driverId)}/notes`, { body });
}

export function saveRecurringDeduction(driverId: string, input: RecurringDeductionInput & { id?: string; expectedVersion?: number }): Promise<RecurringDeduction> {
  return apiPost(`/accounting/drivers/${encodeURIComponent(driverId)}/recurring`, input);
}

/** One week of a lease charge: skip (0), another amount, or put back (null) (owner, 2026-10-20). */
export function setLeaseWeek(driverId: string, input: { periodStart: string; code: string; cents: number | null; reason: string }) {
  return apiPost(`/accounting/drivers/${encodeURIComponent(driverId)}/lease-week`, input);
}

/** One manual odometer reading written from a statement, as the server reports it back. */
export interface StatementOdometerReading {
  end: 'start' | 'end';
  readingAt: string;
  odometerMiles: number;
  status: 'ok' | 'conflict' | 'void';
  conflictReason: string | null;
  /** The last good reading it was checked against, and what the person is told (owner, 2026-10-22). */
  conflictWith?: number | null;
  message?: string | null;
}

/**
 * The truck's odometer at the start of the week (the day before it began) and at its end, typed
 * in when the ELD has no readings (owner, 2026-10-21). Saved as manual readings on the truck;
 * the statement comes back recomputed.
 */
export function enterStatementOdometer(id: string, input: { startMiles: number | null; endMiles: number | null; note: string | null }): Promise<{ statement: Statement; readings: StatementOdometerReading[] }> {
  return apiPost(`/accounting/settlements/${encodeURIComponent(id)}/odometer`, input);
}

/** One week of a recurring deduction: skip (0), another amount, or put back (null). */
export function setRecurringWeek(driverId: string, id: string, input: { periodStart: string; cents: number | null; reason: string }): Promise<RecurringDeduction> {
  return apiPost(`/accounting/drivers/${encodeURIComponent(driverId)}/recurring/${encodeURIComponent(id)}/week`, input);
}

/** A recurring deduction's amount from now on. */
export function setRecurringAmount(driverId: string, id: string, input: { amountCents: number; label?: string; reason: string }): Promise<RecurringDeduction> {
  return apiPost(`/accounting/drivers/${encodeURIComponent(driverId)}/recurring/${encodeURIComponent(id)}/amount`, input);
}

/** Stops a recurring deduction for good (administrators); kept on record as cancelled. */
export function stopRecurringDeduction(driverId: string, id: string, reason: string): Promise<RecurringDeduction> {
  return apiPost(`/accounting/drivers/${encodeURIComponent(driverId)}/recurring/${encodeURIComponent(id)}/stop`, { reason });
}

export function setDriverTransactionState(id: string, state: 'approved' | 'disputed' | 'paused' | 'void', reason = ''): Promise<DriverTx> {
  return apiPost(`/accounting/driver-transactions/${encodeURIComponent(id)}/state`, { state, reason });
}

export function generateBatch(input: { kind: 'cd' | 'lo_oo' | 'vt'; weekOf: IsoDate; includeLateLoadIds?: string[] }): Promise<SettlementBatch> {
  return apiPost('/accounting/settlements/generate', input);
}

export function closeBatch(id: string): Promise<SettlementBatch> {
  return apiPost(`/accounting/settlements/batches/${encodeURIComponent(id)}/close`, {});
}

export function approveStatement(id: string): Promise<Outcome<'statement', Statement>> {
  return apiPost(`/accounting/settlements/${encodeURIComponent(id)}/approve`, {});
}

/** Takes a load off a draft statement; it is listed there to be put back, and otherwise goes on the next statement. */
export function removeStatementLoad(id: string, loadId: string, reason: string): Promise<Outcome<'statement', Statement> & { carriedTo?: string | null }> {
  return apiPost(`/accounting/settlements/${encodeURIComponent(id)}/loads/${encodeURIComponent(loadId)}/remove`, { reason });
}

/**
 * Real vs For driver and the REF, corrected on a draft statement (owner, 2026-10-23). Writes the
 * load (version-checked by `expectedUpdatedAt`, audited) and answers with the recomputed statement.
 */
export function setStatementLoadPayFacts(
  id: string,
  loadId: string,
  input: { expectedUpdatedAt: string; driverRate?: number | null; charges?: Array<{ chargeId: string; driverAmount: number | null }>; brokerReference?: string; reason?: string },
): Promise<{ statement: Statement }> {
  return apiPost(`/accounting/settlements/${encodeURIComponent(id)}/loads/${encodeURIComponent(loadId)}/pay-facts`, input);
}

/** Puts a load taken off this statement back on it, in one click. */
export function putBackStatementLoad(id: string, loadId: string): Promise<Outcome<'statement', Statement>> {
  return apiPost(`/accounting/settlements/${encodeURIComponent(id)}/loads/${encodeURIComponent(loadId)}/put-back`, {});
}

/** When a load counts for driver pay, and which statements list it. */
export interface LoadPay {
  loadId: string;
  loadNumber: string;
  status: string;
  updatedAt: string;
  deliveredAt: string | null;
  completedAt: string;
  basis: 'delivered_at' | 'status_updated_at';
  payAt: string;
  source: 'override' | 'completed';
  override: { at: string; reason: string; by: string; byName: string; changedAt: string; previousAt: string | null } | null;
  period: { start: string; end: string; startsAt?: string; cutoffAt: string; payDate: string; timezone: string; label: string } | null;
  timezone: string;
  statements: Array<{ id: string; settlementNumber: string; partyName: string; periodStart: string; status: Statement['status']; onIt: boolean; removed: { reason: string; by: string; at: string } | null }>;
}

export function fetchLoadPay(loadId: string): Promise<LoadPay> {
  return apiGet(`/accounting/loads/${encodeURIComponent(loadId)}/pay`);
}

/** "Counts for pay on": `at` null puts the load back on its delivered time. */
export function setLoadPayDate(loadId: string, input: { at: string | null; reason: string; expectedUpdatedAt: string }): Promise<LoadPay> {
  return apiPost(`/accounting/loads/${encodeURIComponent(loadId)}/pay-date`, input);
}

/** An approved statement opened for editing again; refused once paid. */
export function reopenStatement(id: string, reason: string): Promise<Outcome<'statement', Statement>> {
  return apiPost(`/accounting/settlements/${encodeURIComponent(id)}/reopen`, { reason });
}

export function markStatementPaid(id: string, input: { paidOn: IsoDate; reference: string; method: 'ach' | 'check' | 'wire' | 'cash'; amountCents?: number }): Promise<Outcome<'statement', Statement>> {
  return apiPost(`/accounting/settlements/${encodeURIComponent(id)}/paid`, input);
}

export function setStatementStatus(id: string, status: 'draft' | 'review', note?: string): Promise<Statement> {
  return apiPost(`/accounting/settlements/${encodeURIComponent(id)}/status`, { status, note });
}

/** The older Settlements page's one write, mapped onto the batch workflow. */
export async function updateSettlement(input: { settlementId: string; status: Settlement['status']; reason?: string | null }): Promise<{ ok: boolean; settlement: Settlement | null; blocked?: string }> {
  if (input.status === 'finalized') {
    const r = await approveStatement(input.settlementId);
    return r.ok ? { ok: true, settlement: statementToSettlement(r.statement) } : { ok: false, settlement: null, blocked: r.blocked };
  }
  if (input.status === 'paid') {
    const r = await markStatementPaid(input.settlementId, { paidOn: new Date().toISOString().slice(0, 10), reference: input.reason ?? 'manual', method: 'ach' });
    return r.ok ? { ok: true, settlement: statementToSettlement(r.statement) } : { ok: false, settlement: null, blocked: r.blocked };
  }
  if (input.status === 'draft' || input.status === 'pending_review') {
    const s = await setStatementStatus(input.settlementId, input.status === 'draft' ? 'draft' : 'review', input.reason ?? undefined);
    return { ok: true, settlement: statementToSettlement(s) };
  }
  return { ok: false, settlement: null, blocked: `A statement does not move to ${input.status} by hand.` };
}

export function saveArrangement(input: { id?: string; vendorId: string; truckId: string; effectiveFrom: IsoDate; effectiveTo: IsoDate | null; percentBps: number | null; note?: string }) {
  return apiPost('/accounting/settlements/arrangements', input);
}

export function savePayee(input: { partyType: 'driver' | 'vendor'; partyId: string; legalName: string; payeeIdentity?: string | null; accountType?: 'checking' | 'savings' | null; routingNumber?: string; accountNumber?: string; reason?: string }): Promise<PayeeProfile> {
  return apiPut('/accounting/payees', input);
}

export function verifyPayee(id: string): Promise<PayeeProfile> {
  return apiPost(`/accounting/payees/${encodeURIComponent(id)}/verify`, {});
}

export function preparePaymentBatch(input: { kind: 'driver' | 'vendor'; statementIds: string[] }): Promise<PaymentBatch> {
  return apiPost('/accounting/payment-batches', input);
}

export function approvePaymentBatch(id: string): Promise<PaymentBatch> {
  return apiPost(`/accounting/payment-batches/${encodeURIComponent(id)}/approve`, {});
}

export function markPaymentBatch(id: string, input: { status: 'submitted' | 'accepted' | 'rejected' | 'paid'; externalId?: string; errors?: string[] }): Promise<PaymentBatch> {
  return apiPost(`/accounting/payment-batches/${encodeURIComponent(id)}/mark`, input);
}

export function emailDocuments(input: { documentType: 'statement' | 'invoice'; items: Array<{ documentId: string; recipient: string | null; label: string; amountCents: number }>; resend?: boolean }) {
  return apiPost<{ transportConfigured: boolean; results: Array<{ documentId: string; label: string; recipient: string | null; status: 'pending' | 'blocked' | 'sent'; reason: string | null }> }>('/accounting/deliveries/email', input);
}

// ------------------------------------------------------------ driver statement emails (brief 2026-10-27 §7.4)

/** The last email of a statement; `bounced` = the latest statement email to the driver's address on file bounced. */
export interface StatementEmailState {
  status: string;
  at: string;
  to: string;
  error: string | null;
  bounced: boolean;
}
export type StatementEmailSkip = 'no_email' | 'invalid_email' | 'not_approved' | 'already_sent' | 'not_driver' | 'in_progress';
export interface StatementEmailPreviewItem {
  statementId: string;
  settlementNumber: string;
  driverId: string;
  driverName: string;
  recipient: string | null;
  action: 'send' | 'skip';
  reason: StatementEmailSkip | null;
  last: StatementEmailState | null;
  refused?: string;
}
export interface StatementEmailOutcome {
  statementId: string;
  settlementNumber: string;
  driverId: string;
  driverName: string;
  recipient: string | null;
  status: 'sent' | 'failed' | 'skipped';
  reason: StatementEmailSkip | null;
  error: string | null;
}
export interface StatementEmailSummary {
  batchId: string;
  sent: StatementEmailOutcome[];
  failed: StatementEmailOutcome[];
  skipped_no_email: StatementEmailOutcome[];
  skipped: StatementEmailOutcome[];
}

export function fetchStatementEmailStatus(query: { batchId?: string; ids?: string[] }): Promise<Record<string, StatementEmailState>> {
  const q = query.batchId ? `batchId=${encodeURIComponent(query.batchId)}` : `ids=${(query.ids ?? []).map(encodeURIComponent).join(',')}`;
  return apiGet(`/accounting/settlements/email-status?${q}`);
}

export function fetchStatementEmailPreview(batchId: string, resend = false): Promise<{ batchId: string; running: boolean; ready: boolean; transport: string; items: StatementEmailPreviewItem[] }> {
  return apiGet(`/accounting/settlements/batches/${encodeURIComponent(batchId)}/email${resend ? '?resend=true' : ''}`);
}

/** The recipient is never sent: the server reads it from the statement's own driver record. */
export function sendStatementEmail(statementId: string, resend = false): Promise<StatementEmailOutcome> {
  return apiPost(`/accounting/settlements/${encodeURIComponent(statementId)}/email`, resend ? { resend: true } : {});
}

export function sendStatementsEmail(batchId: string, resend = false): Promise<StatementEmailSummary> {
  return apiPost(`/accounting/settlements/batches/${encodeURIComponent(batchId)}/email`, resend ? { resend: true } : {});
}

export function saveStaffPlan(employeeId: string, input: Omit<StaffPayPlan, 'id' | 'employeeId'> & { commissionPolicyVersion?: string | null; reason?: string }): Promise<StaffPayPlan> {
  return apiPost(`/accounting/payroll/staff/${encodeURIComponent(employeeId)}/plans`, input);
}

export function generatePayrollPeriod(input: { kind: 'dispatcher' | 'salary'; date: IsoDate; anchorMonday?: IsoDate; periodStart?: IsoDate; periodEnd?: IsoDate; payDate?: IsoDate }): Promise<ServerPayrollPeriod> {
  return apiPost('/accounting/payroll/periods/generate', input);
}

export function setPayrollLine(periodId: string, input: { employeeId: string; commissionCents?: number | null; bonusCents?: number; advanceCents?: number; adjustment?: { description: string; cents: number; reason: string } }): Promise<ServerPayrollPeriod> {
  return apiPost(`/accounting/payroll/periods/${encodeURIComponent(periodId)}/lines`, input);
}

export function updatePayrollPeriod(input: { periodId: string; status: 'review' | 'finalized' | 'paid' | 'closed'; paidOn?: IsoDate; reference?: string; acknowledgeExcluded?: string[] }): Promise<{ ok: boolean; period: ServerPayrollPeriod | null; blocked?: string; excluded?: Array<{ employeeId: string; employeeName: string; reason: string }> }> {
  return apiPost(`/accounting/payroll/periods/${encodeURIComponent(input.periodId)}/status`, { status: input.status, paidOn: input.paidOn, reference: input.reference, acknowledgeExcluded: input.acknowledgeExcluded });
}

export function postJournalEntry(input: { onDate: IsoDate; memo: string; lines: Array<{ accountCode: string; debit?: number; credit?: number; memo?: string }> }): Promise<{ ok: boolean; entry: JournalEntry | null; blocked?: string }> {
  return apiPost('/accounting/ledger/entries', input);
}

export function reverseJournalEntry(id: string, reason: string): Promise<{ ok: boolean; entry?: JournalEntry; blocked?: string }> {
  return apiPost(`/accounting/ledger/entries/${encodeURIComponent(id)}/reverse`, { reason });
}

export function closeLedgerPeriod(input: { periodId: string }): Promise<{ ok: boolean; blocked?: string }> {
  return apiPost(`/accounting/ledger/periods/${encodeURIComponent(input.periodId)}/close`, {});
}

export function reopenLedgerPeriod(periodId: string, reason: string): Promise<{ ok: boolean }> {
  return apiPost(`/accounting/ledger/periods/${encodeURIComponent(periodId)}/reopen`, { reason });
}

/** File downloads go straight to the API with the session cookie; the path is what the server exposes. */
export function accountingFileUrl(path: string): string {
  return `/api/v1/accounting/${path.replace(/^\//, '')}`;
}

// ------------------------------------------------------------------ reimbursements

/**
 * A reimbursement is an expense the driver paid for, so it comes back as an expense with a
 * review block on it; there is no separate record to keep in step.
 */
export interface ServerReimbursement extends ServerExpense {
  reimbursement: ReimbursementBlock;
  /** Set when the stored load id no longer resolves in this company. */
  loadUnresolved?: boolean;
}

export function listReimbursements(where?: { status?: string; driverId?: string; truckId?: string; category?: string; from?: IsoDate; to?: IsoDate }): Promise<ServerReimbursement[]> {
  return apiGet('/accounting/reimbursements', where as Record<string, unknown>);
}

export function reimbursementSummary(): Promise<{ byCurrency: Array<{ currency: string; totals: ReimbursementTotals }> }> {
  return apiGet('/accounting/reimbursements/summary');
}

export function getReimbursement(id: string): Promise<ServerReimbursement> {
  return apiGet(`/accounting/reimbursements/${encodeURIComponent(id)}`);
}

export function createReimbursement(input: CreateReimbursementInput): Promise<{ ok: boolean; expense?: ServerReimbursement; blocked?: string; reimbursable?: boolean }> {
  return apiPost('/accounting/reimbursements', input);
}

export function reviewReimbursement(id: string, input: { decision: 'approve' | 'reject'; reason: string | null }): Promise<ServerReimbursement> {
  return apiPost(`/accounting/reimbursements/${encodeURIComponent(id)}/review`, input);
}

/** A load a reimbursement can be filed against, as the picker shows it. */
export interface ReimbursementLoadOption {
  id: string;
  loadNumber: string;
  route: string | null;
  deliveredOn: string | null;
  driverId: string | null;
  driverName: string | null;
  coDriverId: string | null;
  coDriverName: string | null;
  truckId: string | null;
  truckUnit: string | null;
  onThisDriver: boolean;
}

export function reimbursementLoadOptions(where: { q?: string; driverId?: string }): Promise<ReimbursementLoadOption[]> {
  return apiGet('/accounting/reimbursements/load-options', where as Record<string, unknown>);
}

/**
 * Accounting's review of one file on a load: Mark reviewed, or Reject with a reason. Runs the
 * load's own write rule on the server, with the version the screen was looking at.
 */
export function reviewBillingDocument(loadId: string, documentId: string, input: { review: 'reviewed' | 'rejected'; reason: string | null; expectedUpdatedAt: string }) {
  return apiPost(`/accounting/billing/loads/${encodeURIComponent(loadId)}/documents/${encodeURIComponent(documentId)}/review`, input);
}

// ------------------------------------------------------------------ RTS export batches

export interface RtsCandidate {
  invoiceId: string;
  invoiceNumber: string;
  loadNumber: string;
  debtor: string;
  issuedOn: string | null;
  status: string;
  totalCents: number;
  documents: Array<{ id: string; type: string; fileName: string; stillCurrent: boolean; hasBytes: boolean }>;
  inBatch: { batchId: string; batchNumber: string; status: string } | null;
  eligibility: { eligible: boolean; reasons: string[]; warnings: string[] };
}

export interface RtsBatch {
  id: string;
  batchNumber: string;
  status: 'prepared' | 'exported' | 'submitted' | 'cancelled';
  lines: Array<{ invoiceId: string; invoiceNumber: string; loadNumber: string; debtor: string; issuedOn: string | null; totalCents: number; documents: Array<{ id: string; type: string; fileName: string }>; warnings: string[] }>;
  count: number;
  totalCents: number;
  createdAt: string;
  createdBy: string;
  exports: Array<{ at: string; by: string; fileName: string; sha256: string; bytes: number }>;
  submission: { reference: string | null; evidence: string | null; evidenceFileId: string | null; submittedOn: string; at: string; by: string } | null;
  cancellation: { reason: string; at: string; by: string } | null;
  history: Array<{ at: string; by: string; action: string; detail: string }>;
  /** FTPS uploads to RTS: the CSV that triggered each, and where it went. */
  ftpSends?: Array<{ at: string; by: string; csvName: string; files: number; host: string; clientNumber: string; sha256: string; test?: boolean }>;
  version?: number;
}

export function fetchRtsCandidates(): Promise<RtsCandidate[]> {
  return apiGet('/accounting/rts/candidates');
}

export function fetchRtsBatches(): Promise<RtsBatch[]> {
  return apiGet('/accounting/rts/batches');
}

export function fetchRtsBatch(id: string): Promise<RtsBatch & { version: number }> {
  return apiGet(`/accounting/rts/batches/${encodeURIComponent(id)}`);
}

export function createRtsBatch(invoiceIds: string[]): Promise<RtsBatch> {
  return apiPost('/accounting/rts/batches', { invoiceIds });
}

export function cancelRtsBatch(id: string, input: { reason: string; expectedVersion: number }): Promise<RtsBatch> {
  return apiPost(`/accounting/rts/batches/${encodeURIComponent(id)}/cancel`, input);
}

/** Three TEST packets and their CSV to the RTS test folder; nothing is recorded but the audit. */
export function sendRtsTestPackets(): Promise<{ uploaded: string[]; csvName: string; csv: string; host: string }> {
  return apiPost('/accounting/rts/test-packets', {});
}

/** Uploads the batch to RTS over FTPS (PDFs, then the CSV) and records it submitted. */
export function sendRtsBatch(id: string, expectedVersion: number): Promise<RtsBatch> {
  return apiPost(`/accounting/rts/batches/${encodeURIComponent(id)}/send`, { expectedVersion });
}

export function recordRtsSubmission(id: string, input: { reference: string | null; evidence: string | null; evidenceFileId: string | null; submittedOn: string; expectedVersion: number }): Promise<RtsBatch> {
  return apiPost(`/accounting/rts/batches/${encodeURIComponent(id)}/submission`, input);
}


// ------------------------------------------------------------------ revisions and notes

export interface RevisionLineInput {
  chargeType: string;
  description: string;
  amount: number;
  supportingDocumentIds?: string[];
  loadChargeId?: string | null;
}

export function fetchInvoiceFamily(id: string): Promise<ServerInvoice[]> {
  return apiGet(`/accounting/invoices/${encodeURIComponent(id)}/family`);
}

export function fetchRevisionOptions(id: string): Promise<{ charges: Array<{ id: string; chargeType: string; description: string; amount: number }>; documents: Array<{ id: string; type: string; fileName: string; title?: string }> }> {
  return apiGet(`/accounting/invoices/${encodeURIComponent(id)}/revision-options`);
}

export function createRevision(id: string, input: { reason: string; lines: RevisionLineInput[]; invoiceNote?: string | null; expectedUpdatedAt: string }): Promise<{ ok: boolean; invoice: ServerInvoice; blocked?: string; existing?: boolean }> {
  return apiPost(`/accounting/invoices/${encodeURIComponent(id)}/revise`, input);
}

export function issueRevision(id: string, expectedUpdatedAt: string): Promise<{ ok: boolean; invoice: ServerInvoice; blocked?: string; alreadyIssued?: boolean }> {
  return apiPost(`/accounting/invoices/${encodeURIComponent(id)}/issue-revision`, { expectedUpdatedAt });
}

// ------------------------------------------------------------------ charges after invoicing

/** Whether an extra charge on this invoice goes on a supplemental invoice, and the ones it already has. */
export interface SupplementsView {
  check: { ok: true; why: string } | { ok: false; reason: string; useRevision: boolean };
  supplements: ServerInvoice[];
}

export function fetchSupplements(id: string): Promise<SupplementsView> {
  return apiGet(`/accounting/invoices/${encodeURIComponent(id)}/supplements`);
}

export interface AddChargeAfterInvoicingResult {
  ok: boolean;
  blocked?: string;
  useRevision?: boolean;
  existing?: boolean;
  issueBlocked?: string | null;
  invoice: ServerInvoice;
  driverPay?: Array<{ chargeId: string; treatment: string }>;
}

/** Bills charges that came after the invoice went to RTS on a supplemental invoice (INV-…-S1). */
export function addChargeAfterInvoicing(id: string, input: AddChargeAfterInvoicingInput): Promise<AddChargeAfterInvoicingResult> {
  return apiPost(`/accounting/invoices/${encodeURIComponent(id)}/supplements`, input);
}

export function discardRevision(id: string, reason: string): Promise<{ ok: boolean; blocked?: string }> {
  return apiPost(`/accounting/invoices/${encodeURIComponent(id)}/discard-revision`, { reason });
}

export function setInvoiceNote(id: string, invoiceNote: string | null, expectedUpdatedAt: string): Promise<{ ok: boolean; blocked?: string }> {
  return apiPost(`/accounting/invoices/${encodeURIComponent(id)}/note`, { invoiceNote, expectedUpdatedAt });
}

export function addInternalNote(id: string, text: string): Promise<{ ok: boolean }> {
  return apiPost(`/accounting/invoices/${encodeURIComponent(id)}/internal-notes`, { text });
}

export function editInternalNote(id: string, noteId: string, text: string): Promise<{ ok: boolean }> {
  return apiPost(`/accounting/invoices/${encodeURIComponent(id)}/internal-notes/${encodeURIComponent(noteId)}`, { text });
}
