-- Truck ↔ driver assignments become the single source of truth (owner, 2026-10-08).
--
-- Additive only: new nullable / defaulted columns, one new table, two partial unique indexes. No
-- existing row is changed by this file. The approximate-start backfill for trucks that have a
-- driver pointer but no open row is a separate, re-runnable script
-- (dist/scripts/backfill-truck-assignments.js, dry run first, --confirm to write).
--
-- The partial unique indexes would fail to build if any company already had two open rows for
-- one truck or one driver. Checked before shipping: production has open rows only for trk_005
-- (one row), and the local database has none duplicated. If the CREATE INDEX fails anywhere, close
-- the extra open rows by hand (ended_on + end_reason, never delete) and run the migration again.

ALTER TABLE "truck_driver_assignments" ADD COLUMN IF NOT EXISTS "assigned_on_approximate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "truck_driver_assignments" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'truck_page' NOT NULL;--> statement-breakpoint
ALTER TABLE "truck_driver_assignments" ADD COLUMN IF NOT EXISTS "returned_equipment" jsonb;--> statement-breakpoint
ALTER TABLE "truck_driver_assignments" ADD COLUMN IF NOT EXISTS "drop_note" text;--> statement-breakpoint
ALTER TABLE "truck_driver_assignments" ADD COLUMN IF NOT EXISTS "ended_by_name" text;--> statement-breakpoint
ALTER TABLE "truck_driver_assignments" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "truck_driver_assignments" ADD COLUMN IF NOT EXISTS "updated_by" text;--> statement-breakpoint
ALTER TABLE "truck_driver_assignments" ADD COLUMN IF NOT EXISTS "updated_by_name" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "truck_driver_assignments_open_truck_key" ON "truck_driver_assignments" USING btree ("company_id","truck_id") WHERE "ended_on" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "truck_driver_assignments_open_driver_key" ON "truck_driver_assignments" USING btree ("company_id","driver_id") WHERE "ended_on" IS NULL;--> statement-breakpoint
-- Pickup and drop photos, one row per photo. The bytes are a stored_files row; a photo taken off
-- an assignment is voided (voided_at, by, reason), never deleted.
CREATE TABLE IF NOT EXISTS "truck_assignment_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"stage" text NOT NULL,
	"file_id" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_by_name" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "truck_assignment_photos_stage_check" CHECK ("stage" IN ('pickup', 'drop'))
);
--> statement-breakpoint
ALTER TABLE "truck_assignment_photos" ADD CONSTRAINT "truck_assignment_photos_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_assignment_photos" ADD CONSTRAINT "truck_assignment_photos_assignment_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."truck_driver_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "truck_assignment_photos_assignment_idx" ON "truck_assignment_photos" USING btree ("company_id","assignment_id");
