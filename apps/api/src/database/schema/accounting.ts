import { bigint, boolean, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { companies } from './roster';

/**
 * Accounting (migration 0035). Every table: company_id, a version every write checks and bumps,
 * a source_key that makes a retried event land once, and `record` — the whole document the
 * screens read, so the shared rules run on the server unchanged. See the migration for the why.
 */

const company = () =>
  text('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'restrict' });

export const acctSettings = pgTable('acct_settings', {
  companyId: text('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'restrict' }),
  version: integer('version').notNull().default(1),
  record: jsonb('record').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
});

export const acctLedgerPeriods = pgTable(
  'acct_ledger_periods',
  {
    id: text('id').notNull(),
    companyId: company(),
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    status: text('status').notNull().default('open'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: text('closed_by'),
    record: jsonb('record').notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.id] })],
);

export const acctJournalEntries = pgTable(
  'acct_journal_entries',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    onDate: date('on_date').notNull(),
    source: text('source').notNull(),
    sourceKey: text('source_key').notNull(),
    memo: text('memo').notNull().default(''),
    reversalOf: text('reversal_of'),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
    postedBy: text('posted_by').notNull().default(''),
    record: jsonb('record').notNull(),
  },
  (t) => [uniqueIndex('acct_journal_source_key').on(t.companyId, t.sourceKey), index('acct_journal_company_date_idx').on(t.companyId, t.onDate)],
);

export const acctInvoices = pgTable(
  'acct_invoices',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    invoiceNumber: text('invoice_number').notNull(),
    family: text('family').notNull(),
    revision: integer('revision').notNull().default(1),
    isCurrent: boolean('is_current').notNull().default(true),
    loadId: text('load_id'),
    billToType: text('bill_to_type').notNull(),
    billToId: text('bill_to_id').notNull(),
    status: text('status').notNull(),
    issuedOn: date('issued_on'),
    dueOn: date('due_on'),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
    balanceCents: bigint('balance_cents', { mode: 'number' }).notNull().default(0),
    sourceKey: text('source_key').notNull(),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('acct_invoices_number_key').on(t.companyId, t.invoiceNumber),
    uniqueIndex('acct_invoices_source_key').on(t.companyId, t.sourceKey),
    index('acct_invoices_company_status_idx').on(t.companyId, t.status),
    index('acct_invoices_company_load_idx').on(t.companyId, t.loadId),
  ],
);

export const acctPayments = pgTable(
  'acct_payments',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    direction: text('direction').notNull(),
    partyType: text('party_type').notNull(),
    partyId: text('party_id').notNull(),
    receivedOn: date('received_on').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    sourceKey: text('source_key').notNull(),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('acct_payments_source_key').on(t.companyId, t.sourceKey), index('acct_payments_company_date_idx').on(t.companyId, t.receivedOn)],
);

export const acctBills = pgTable(
  'acct_bills',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    billNumber: text('bill_number').notNull(),
    vendorId: text('vendor_id').notNull(),
    status: text('status').notNull(),
    dueOn: date('due_on').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    balanceCents: bigint('balance_cents', { mode: 'number' }).notNull(),
    source: text('source').notNull(),
    sourceKey: text('source_key').notNull(),
    truckId: text('truck_id'),
    loadId: text('load_id'),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Accident & Claims v2 (0071): the case (or claim) a bill is a cost of, and its category on the case ledger. */
    accidentId: text('accident_id'),
    claimId: text('claim_id'),
    accidentCostCategory: text('accident_cost_category'),
  },
  (t) => [
    uniqueIndex('acct_bills_number_key').on(t.companyId, t.billNumber),
    uniqueIndex('acct_bills_source_key').on(t.companyId, t.sourceKey),
    index('acct_bills_company_status_idx').on(t.companyId, t.status),
  ],
);

export const acctExpenses = pgTable(
  'acct_expenses',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    onDate: date('on_date').notNull(),
    category: text('category').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    truckId: text('truck_id'),
    driverId: text('driver_id'),
    loadId: text('load_id'),
    vendorId: text('vendor_id'),
    source: text('source').notNull(),
    sourceKey: text('source_key').notNull(),
    burden: text('burden').notNull().default('company_borne'),
    status: text('status').notNull(),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('acct_expenses_source_key').on(t.companyId, t.sourceKey),
    index('acct_expenses_company_date_idx').on(t.companyId, t.onDate),
    index('acct_expenses_company_driver_idx').on(t.companyId, t.driverId),
    index('acct_expenses_company_truck_idx').on(t.companyId, t.truckId),
  ],
);

export const acctDriverProfiles = pgTable(
  'acct_driver_profiles',
  {
    driverId: text('driver_id').notNull(),
    companyId: company(),
    contractType: text('contract_type').notNull().default('CD'),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.driverId] })],
);

export const acctDriverTransactions = pgTable(
  'acct_driver_transactions',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    driverId: text('driver_id').notNull(),
    kind: text('kind').notNull(),
    onDate: date('on_date').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    recoveredCents: bigint('recovered_cents', { mode: 'number' }).notNull().default(0),
    state: text('state').notNull(),
    source: text('source').notNull(),
    sourceKey: text('source_key').notNull(),
    truckId: text('truck_id'),
    loadId: text('load_id'),
    settlementId: text('settlement_id'),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('acct_driver_tx_source_key').on(t.companyId, t.sourceKey), index('acct_driver_tx_driver_idx').on(t.companyId, t.driverId, t.onDate)],
);

export const acctRecurringDeductions = pgTable(
  'acct_recurring_deductions',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    driverId: text('driver_id').notNull(),
    category: text('category').notNull(),
    cadence: text('cadence').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on'),
    status: text('status').notNull().default('active'),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('acct_recurring_driver_idx').on(t.companyId, t.driverId)],
);

export const acctVendorArrangements = pgTable(
  'acct_vendor_arrangements',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    vendorId: text('vendor_id').notNull(),
    truckId: text('truck_id').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    percentBps: integer('percent_bps'),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('acct_vendor_arr_truck_idx').on(t.companyId, t.truckId)],
);

export const acctSettlementBatches = pgTable(
  'acct_settlement_batches',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    kind: text('kind').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    cutoffAt: timestamp('cutoff_at', { withTimezone: true }).notNull(),
    payDate: date('pay_date').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('acct_batches_period_key').on(t.companyId, t.kind, t.periodStart)],
);

export const acctSettlements = pgTable(
  'acct_settlements',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    batchId: text('batch_id'),
    kind: text('kind').notNull(),
    partyType: text('party_type').notNull(),
    partyId: text('party_id').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    status: text('status').notNull(),
    netCents: bigint('net_cents', { mode: 'number' }).notNull().default(0),
    payableCents: bigint('payable_cents', { mode: 'number' }).notNull().default(0),
    carryCents: bigint('carry_cents', { mode: 'number' }).notNull().default(0),
    sourceKey: text('source_key').notNull(),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('acct_settlements_source_key').on(t.companyId, t.sourceKey),
    index('acct_settlements_party_idx').on(t.companyId, t.partyType, t.partyId),
    index('acct_settlements_batch_idx').on(t.batchId),
  ],
);

export const acctPayeeProfiles = pgTable(
  'acct_payee_profiles',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    partyType: text('party_type').notNull(),
    partyId: text('party_id').notNull(),
    legalName: text('legal_name').notNull(),
    accountType: text('account_type'),
    accountLast4: text('account_last4'),
    /** Routing and account numbers, sealed by the credential vault. Never returned. */
    sealed: jsonb('sealed'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedBy: text('verified_by'),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('acct_payee_party_key').on(t.companyId, t.partyType, t.partyId)],
);

export const acctPaymentBatches = pgTable('acct_payment_batches', {
  id: text('id').primaryKey(),
  companyId: company(),
  kind: text('kind').notNull(),
  status: text('status').notNull(),
  version: integer('version').notNull().default(1),
  record: jsonb('record').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const acctPayrollPeriods = pgTable(
  'acct_payroll_periods',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    kind: text('kind').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    payDate: date('pay_date').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('acct_payroll_period_key').on(t.companyId, t.kind, t.periodStart)],
);

export const acctStaffPayPlans = pgTable(
  'acct_staff_pay_plans',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    employeeId: text('employee_id').notNull(),
    kind: text('kind').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('acct_staff_plans_employee_idx').on(t.companyId, t.employeeId)],
);

export const acctImportRecords = pgTable(
  'acct_import_records',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    provider: text('provider').notNull(),
    sourceKey: text('source_key').notNull(),
    occurredOn: date('occurred_on').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    state: text('state').notNull(),
    truckId: text('truck_id'),
    driverId: text('driver_id'),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('acct_imports_source_key').on(t.companyId, t.provider, t.sourceKey), index('acct_imports_state_idx').on(t.companyId, t.state)],
);

export const acctDeliveries = pgTable(
  'acct_deliveries',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    documentType: text('document_type').notNull(),
    documentId: text('document_id').notNull(),
    channel: text('channel').notNull(),
    recipient: text('recipient'),
    status: text('status').notNull(),
    record: jsonb('record').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('acct_deliveries_doc_idx').on(t.companyId, t.documentType, t.documentId)],
);

export const acctBillingExceptions = pgTable(
  'acct_billing_exceptions',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    loadId: text('load_id').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('acct_billing_exc_load_idx').on(t.companyId, t.loadId, t.status)],
);

/**
 * One row per completed load: the invoice candidate it produced and the earning candidates for
 * each driver on it, or the error that stopped it. Created by migration 0036.
 *
 * Reads and writes go through the generic record store like the other `acct_*` tables. It is
 * declared here so the table the application depends on is visible in the schema — a table that
 * exists only in SQL cannot be checked against the reset lists or the migrations.
 */
export const acctCompletions = pgTable(
  'acct_completions',
  {
    id: text('id').primaryKey(),
    companyId: company(),
    loadId: text('load_id').notNull(),
    loadNumber: text('load_number').notNull(),
    loadStatus: text('load_status').notNull(),
    state: text('state').notNull(),
    sourceKey: text('source_key').notNull(),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('acct_completions_load_key').on(t.companyId, t.loadId),
    uniqueIndex('acct_completions_source_key').on(t.companyId, t.sourceKey),
    index('acct_completions_state_idx').on(t.companyId, t.state),
  ],
);
