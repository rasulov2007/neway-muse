-- Accounting & payment details on the driver profile (owner's brief, 2026-09-21): how the driver
-- is paid. One row per driver; account and routing numbers are stored here and only ever served
-- masked (last four) - the product shows "Replace", never "Show".
CREATE TABLE IF NOT EXISTS "driver_payment_details" (
  "driver_id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "payment_method" text NOT NULL,
  "payee_name" text,
  "bank_name" text,
  "account_type" text,
  "routing_number" text,
  "account_number" text,
  "currency" text NOT NULL DEFAULT 'USD',
  "pay_frequency" text NOT NULL DEFAULT 'weekly',
  "authorization_file_id" text,
  "authorization_file_name" text,
  "version" integer NOT NULL DEFAULT 1,
  "updated_by" text NOT NULL DEFAULT '',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "driver_payment_details_company_idx" ON "driver_payment_details" ("company_id");
