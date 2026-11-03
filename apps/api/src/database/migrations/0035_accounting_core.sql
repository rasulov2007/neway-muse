-- Accounting leaves the browser workspace and becomes tables (owner brief 2026-09-27).
--
-- Every table carries company_id, a version that every write checks and bumps, a source_key
-- that makes a retried event land once, and `record` — the whole document as the screens read
-- it, so the pure rules in @neway/shared run unchanged on the server. The columns beside it are
-- what the server filters, joins and enforces on. Additive: nothing existing is altered.
-- `0035_accounting_core.down.sql` removes it; posted finance data is never down-migrated blindly.

-- Company-level accounting settings (RTS fee, holiday fees, cutoff, escrow defaults …). A
-- value that nobody has confirmed is null and the screens say "Needs configuration".
CREATE TABLE IF NOT EXISTS "acct_settings" (
  "company_id" text PRIMARY KEY REFERENCES "companies"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" text
);

CREATE TABLE IF NOT EXISTS "acct_ledger_periods" (
  "id" text NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "year" integer NOT NULL,
  "month" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "closed_at" timestamptz,
  "closed_by" text,
  "record" jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY ("company_id", "id")
);

CREATE TABLE IF NOT EXISTS "acct_journal_entries" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "on_date" date NOT NULL,
  "source" text NOT NULL,
  "source_key" text NOT NULL,
  "memo" text NOT NULL DEFAULT '',
  "reversal_of" text,
  "posted_at" timestamptz NOT NULL DEFAULT now(),
  "posted_by" text NOT NULL DEFAULT '',
  "record" jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "acct_journal_source_key" ON "acct_journal_entries" ("company_id", "source_key");
CREATE INDEX IF NOT EXISTS "acct_journal_company_date_idx" ON "acct_journal_entries" ("company_id", "on_date");

CREATE TABLE IF NOT EXISTS "acct_invoices" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "invoice_number" text NOT NULL,
  -- The family an invoice and its revisions share: INV-10452, INV-10452-R2 … one receivable.
  "family" text NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "is_current" boolean NOT NULL DEFAULT true,
  "load_id" text,
  "bill_to_type" text NOT NULL,
  "bill_to_id" text NOT NULL,
  "status" text NOT NULL,
  "issued_on" date,
  "due_on" date,
  "total_cents" bigint NOT NULL DEFAULT 0,
  "balance_cents" bigint NOT NULL DEFAULT 0,
  "source_key" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "acct_invoices_number_key" ON "acct_invoices" ("company_id", "invoice_number");
CREATE UNIQUE INDEX IF NOT EXISTS "acct_invoices_source_key" ON "acct_invoices" ("company_id", "source_key");
CREATE INDEX IF NOT EXISTS "acct_invoices_company_status_idx" ON "acct_invoices" ("company_id", "status");
CREATE INDEX IF NOT EXISTS "acct_invoices_company_load_idx" ON "acct_invoices" ("company_id", "load_id");

CREATE TABLE IF NOT EXISTS "acct_payments" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "direction" text NOT NULL,
  "party_type" text NOT NULL,
  "party_id" text NOT NULL,
  "received_on" date NOT NULL,
  "amount_cents" bigint NOT NULL,
  "source_key" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "acct_payments_source_key" ON "acct_payments" ("company_id", "source_key");
CREATE INDEX IF NOT EXISTS "acct_payments_company_date_idx" ON "acct_payments" ("company_id", "received_on");

CREATE TABLE IF NOT EXISTS "acct_bills" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "bill_number" text NOT NULL,
  "vendor_id" text NOT NULL,
  "status" text NOT NULL,
  "due_on" date NOT NULL,
  "amount_cents" bigint NOT NULL,
  "balance_cents" bigint NOT NULL,
  "source" text NOT NULL,
  "source_key" text NOT NULL,
  "truck_id" text,
  "load_id" text,
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "acct_bills_number_key" ON "acct_bills" ("company_id", "bill_number");
CREATE UNIQUE INDEX IF NOT EXISTS "acct_bills_source_key" ON "acct_bills" ("company_id", "source_key");
CREATE INDEX IF NOT EXISTS "acct_bills_company_status_idx" ON "acct_bills" ("company_id", "status");

CREATE TABLE IF NOT EXISTS "acct_expenses" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "on_date" date NOT NULL,
  "category" text NOT NULL,
  "amount_cents" bigint NOT NULL,
  "truck_id" text,
  "driver_id" text,
  "load_id" text,
  "vendor_id" text,
  "source" text NOT NULL,
  "source_key" text NOT NULL,
  -- company_borne | recoverable_driver | recoverable_vendor: who finally bears it (§6).
  "burden" text NOT NULL DEFAULT 'company_borne',
  "status" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "acct_expenses_source_key" ON "acct_expenses" ("company_id", "source_key");
CREATE INDEX IF NOT EXISTS "acct_expenses_company_date_idx" ON "acct_expenses" ("company_id", "on_date");
CREATE INDEX IF NOT EXISTS "acct_expenses_company_driver_idx" ON "acct_expenses" ("company_id", "driver_id");
CREATE INDEX IF NOT EXISTS "acct_expenses_company_truck_idx" ON "acct_expenses" ("company_id", "truck_id");

-- A driver's financial profile (§6, §7): contract type, the deduction switches with their
-- effective dates, the escrow plan, loaded and empty pay plans. History is kept in the record.
CREATE TABLE IF NOT EXISTS "acct_driver_profiles" (
  "driver_id" text NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "contract_type" text NOT NULL DEFAULT 'CD',
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("company_id", "driver_id")
);

-- Every movement on a driver's account (§7): fuel, tolls, advances, manual charges,
-- reimbursements, adjustments, escrow deposits/refunds/offsets, debt recoveries, carry-forwards.
CREATE TABLE IF NOT EXISTS "acct_driver_transactions" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "driver_id" text NOT NULL,
  "kind" text NOT NULL,
  "on_date" date NOT NULL,
  "amount_cents" bigint NOT NULL,
  "recovered_cents" bigint NOT NULL DEFAULT 0,
  "state" text NOT NULL,
  "source" text NOT NULL,
  "source_key" text NOT NULL,
  "truck_id" text,
  "load_id" text,
  "settlement_id" text,
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "acct_driver_tx_source_key" ON "acct_driver_transactions" ("company_id", "source_key");
CREATE INDEX IF NOT EXISTS "acct_driver_tx_driver_idx" ON "acct_driver_transactions" ("company_id", "driver_id", "on_date");

CREATE TABLE IF NOT EXISTS "acct_recurring_deductions" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "driver_id" text NOT NULL,
  "category" text NOT NULL,
  "cadence" text NOT NULL,
  "amount_cents" bigint NOT NULL,
  "starts_on" date NOT NULL,
  "ends_on" date,
  "status" text NOT NULL DEFAULT 'active',
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "acct_recurring_driver_idx" ON "acct_recurring_deductions" ("company_id", "driver_id");

-- Truck → vendor, effective-dated, with the vendor's share (§9). Percent in basis points.
CREATE TABLE IF NOT EXISTS "acct_vendor_arrangements" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "vendor_id" text NOT NULL,
  "truck_id" text NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "percent_bps" integer,
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "acct_vendor_arr_truck_idx" ON "acct_vendor_arrangements" ("company_id", "truck_id");

CREATE TABLE IF NOT EXISTS "acct_settlement_batches" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "cutoff_at" timestamptz NOT NULL,
  "pay_date" date NOT NULL,
  "status" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "acct_batches_period_key" ON "acct_settlement_batches" ("company_id", "kind", "period_start");

-- A driver's or a vendor's statement for one period. The record is the snapshot the approval
-- froze: rates, allocations, documents, payee version.
CREATE TABLE IF NOT EXISTS "acct_settlements" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "batch_id" text,
  "kind" text NOT NULL,
  "party_type" text NOT NULL,
  "party_id" text NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "status" text NOT NULL,
  "net_cents" bigint NOT NULL DEFAULT 0,
  "payable_cents" bigint NOT NULL DEFAULT 0,
  "carry_cents" bigint NOT NULL DEFAULT 0,
  "source_key" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "acct_settlements_source_key" ON "acct_settlements" ("company_id", "source_key");
CREATE INDEX IF NOT EXISTS "acct_settlements_party_idx" ON "acct_settlements" ("company_id", "party_type", "party_id");
CREATE INDEX IF NOT EXISTS "acct_settlements_batch_idx" ON "acct_settlements" ("batch_id");

-- Who gets paid and where (§10). Routing and account numbers are sealed with the credential
-- vault; only the last four digits are stored in the clear.
CREATE TABLE IF NOT EXISTS "acct_payee_profiles" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "party_type" text NOT NULL,
  "party_id" text NOT NULL,
  "legal_name" text NOT NULL,
  "account_type" text,
  "account_last4" text,
  "sealed" jsonb,
  "verified_at" timestamptz,
  "verified_by" text,
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "acct_payee_party_key" ON "acct_payee_profiles" ("company_id", "party_type", "party_id");

CREATE TABLE IF NOT EXISTS "acct_payment_batches" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL,
  "status" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "acct_payroll_periods" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "pay_date" date NOT NULL,
  "status" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "acct_payroll_period_key" ON "acct_payroll_periods" ("company_id", "kind", "period_start");

CREATE TABLE IF NOT EXISTS "acct_staff_pay_plans" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "employee_id" text NOT NULL,
  "kind" text NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "acct_staff_plans_employee_idx" ON "acct_staff_pay_plans" ("company_id", "employee_id");

-- Imported source transactions (Relay fuel, BestPass tolls, EFS advances, CSV) before and
-- after matching. source_key is the provider's own id, so a re-import lands once.
CREATE TABLE IF NOT EXISTS "acct_import_records" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "provider" text NOT NULL,
  "source_key" text NOT NULL,
  "occurred_on" date NOT NULL,
  "amount_cents" bigint NOT NULL,
  "state" text NOT NULL,
  "truck_id" text,
  "driver_id" text,
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "acct_imports_source_key" ON "acct_import_records" ("company_id", "provider", "source_key");
CREATE INDEX IF NOT EXISTS "acct_imports_state_idx" ON "acct_import_records" ("company_id", "state");

-- Every statement or invoice handed to somebody: to whom, how, and what happened.
CREATE TABLE IF NOT EXISTS "acct_deliveries" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "document_type" text NOT NULL,
  "document_id" text NOT NULL,
  "channel" text NOT NULL,
  "recipient" text,
  "status" text NOT NULL,
  "record" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "acct_deliveries_doc_idx" ON "acct_deliveries" ("company_id", "document_type", "document_id");

-- Billing exceptions (§4): what blocked a load's invoice, and how somebody resolved it.
CREATE TABLE IF NOT EXISTS "acct_billing_exceptions" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "load_id" text NOT NULL,
  "kind" text NOT NULL,
  "status" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "acct_billing_exc_load_idx" ON "acct_billing_exceptions" ("company_id", "load_id", "status");
