-- Driver vacations and the reason a driver leaves a dispatcher (owner, 2026-10-16). Additive only:
-- one table for each vacation (started, ended, who), and a reason on each team change so the
-- dispatcher rotation report can say why a driver moved.
CREATE TABLE IF NOT EXISTS "driver_vacations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
	"driver_id" text NOT NULL REFERENCES "drivers"("id") ON DELETE RESTRICT,
	"started_on" date NOT NULL,
	"ended_on" date,
	"note" text,
	"started_by" text DEFAULT '' NOT NULL,
	"ended_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "driver_vacations_driver_idx" ON "driver_vacations" ("company_id", "driver_id", "started_on");
CREATE UNIQUE INDEX IF NOT EXISTS "driver_vacations_open_key" ON "driver_vacations" ("company_id", "driver_id") WHERE "ended_on" IS NULL;
ALTER TABLE "dispatch_roster_assignments" ADD COLUMN IF NOT EXISTS "reason" text;
