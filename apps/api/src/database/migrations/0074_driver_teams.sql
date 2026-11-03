-- Team or Solo (owner, 2026-10-25). Additive only: one row per driver per pairing, both sides of
-- a pair sharing pair_id, so the pairing is symmetric and each driver's history reads on its own.
-- started_on is the first day as a team, ended_on the first day solo again (US Eastern dates).
-- Rows are never deleted: unpairing sets ended_on, ended_by, ended_at and end_reason.
CREATE TABLE IF NOT EXISTS "driver_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
	"pair_id" text NOT NULL,
	"driver_id" text NOT NULL REFERENCES "drivers"("id") ON DELETE RESTRICT,
	"partner_id" text NOT NULL REFERENCES "drivers"("id") ON DELETE RESTRICT,
	"started_on" date NOT NULL,
	"ended_on" date,
	"note" text,
	"started_by" text DEFAULT '' NOT NULL,
	"ended_by" text,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_teams_not_self" CHECK ("driver_id" <> "partner_id"),
	CONSTRAINT "driver_teams_dates" CHECK ("ended_on" IS NULL OR "ended_on" >= "started_on")
);
--> statement-breakpoint
-- A driver has at most one team in force: the database refuses a second open row.
CREATE UNIQUE INDEX IF NOT EXISTS "driver_teams_open_key" ON "driver_teams" ("company_id", "driver_id") WHERE "ended_on" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_teams_driver_idx" ON "driver_teams" ("company_id", "driver_id", "started_on");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_teams_pair_idx" ON "driver_teams" ("company_id", "pair_id");
