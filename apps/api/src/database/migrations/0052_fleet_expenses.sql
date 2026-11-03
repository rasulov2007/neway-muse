-- Fleet Expenses (owner brief, 2026-10-12): what a truck cost the fleet, who paid it and who bears
-- it. One row per manual expense (parking, truck wash, tolls, ...). Repairs are not stored here:
-- a completed work order is projected into the expense views from `work_orders`, never copied.
--
-- Accounting is not duplicated either: the links point at the existing vendor bill, payment,
-- driver charge or reimbursement (`acct_*` rows) created when Accounting posts the expense.
--
-- Additive only: two new tables. Rolling back (0052 .down.sql) drops what this adds.

CREATE TABLE IF NOT EXISTS "fleet_expenses" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
	"reference" text NOT NULL,
	"status" text DEFAULT 'recorded' NOT NULL,
	"truck_id" text NOT NULL,
	"unit_number" text NOT NULL,
	"category" text NOT NULL,
	"expense_date" date NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"vendor_id" text,
	"vendor_name" text,
	"invoice_number" text,
	"description" text,
	"notes" text,
	"place_name" text,
	"address" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"paid_by" text NOT NULL,
	"payer_driver_id" text,
	"payer_name" text,
	"payment_method" text,
	"paid" boolean DEFAULT true NOT NULL,
	"payment_reference" text,
	"charge_to" text NOT NULL,
	"charge_driver_id" text,
	"charge_driver_name" text,
	"charge_cents" integer,
	"charge_reason" text,
	"deduct_from_settlement" boolean DEFAULT false NOT NULL,
	"efs_code_sealed" jsonb,
	"efs_code_last4" text,
	"efs_issued_on" date,
	"efs_issued_cents" integer,
	"efs_used_cents" integer,
	"efs_status" text,
	"efs_receipt_file_id" text,
	"acct_expense_id" text,
	"acct_bill_id" text,
	"driver_tx_id" text,
	"reimbursement_id" text,
	"posted_at" timestamp with time zone,
	"posted_by" text,
	"not_duplicate_of" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "fleet_expenses_company_reference_key" ON "fleet_expenses" ("company_id", "reference");
CREATE INDEX IF NOT EXISTS "fleet_expenses_truck_idx" ON "fleet_expenses" ("company_id", "truck_id", "expense_date");
CREATE INDEX IF NOT EXISTS "fleet_expenses_date_idx" ON "fleet_expenses" ("company_id", "expense_date");
CREATE INDEX IF NOT EXISTS "fleet_expenses_charge_driver_idx" ON "fleet_expenses" ("company_id", "charge_driver_id");

-- Receipts, invoices and EFS receipts on an expense. Removing one unlinks it (who, when, why);
-- the stored file itself is kept, because Accounting may rely on it as evidence.
CREATE TABLE IF NOT EXISTS "fleet_expense_files" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
	"expense_id" text NOT NULL REFERENCES "fleet_expenses"("id") ON DELETE RESTRICT,
	"file_id" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text,
	"kind" text DEFAULT 'receipt' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by" text NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" text,
	"remove_reason" text
);
CREATE INDEX IF NOT EXISTS "fleet_expense_files_expense_idx" ON "fleet_expense_files" ("company_id", "expense_id");
CREATE UNIQUE INDEX IF NOT EXISTS "fleet_expense_files_live_key" ON "fleet_expense_files" ("expense_id", "file_id") WHERE "removed_at" IS NULL;
