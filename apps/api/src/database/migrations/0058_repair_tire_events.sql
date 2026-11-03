-- Tire positions (owner brief, 2026-10-13): which wheel positions a tire repair touched. One row
-- per position and event; a record can touch many ("REPLACE 8 DRIVE TIRES"). Read from the
-- record's description by rules (source 'parsed') or tagged by a person (source 'manual', which
-- replaces the parsed rows). Rows are voided, never deleted. Additive: one new table.
CREATE TABLE IF NOT EXISTS "repair_tire_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
	"record_kind" text NOT NULL,
	"record_id" text NOT NULL,
	"unit_id" text DEFAULT '' NOT NULL,
	"unit_kind" text,
	"position_id" text NOT NULL,
	"event_type" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"allocated_cost_cents" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"confidence" numeric(3, 2) DEFAULT 1 NOT NULL,
	"note" text,
	"parsed_from" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text
);
CREATE INDEX IF NOT EXISTS "repair_tire_events_record_idx" ON "repair_tire_events" ("company_id", "record_kind", "record_id");
