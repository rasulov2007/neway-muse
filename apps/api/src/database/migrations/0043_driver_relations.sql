-- Driver Relations (owner brief, 2026-10-06). Every request a driver sends from the public
-- NORTHWIND FREIGHT Driver Care page lands in one canonical record per conversation, with an
-- append-only activity log, the public submissions behind it, the Driver Care links that decide
-- the company, and an outbox for notifications sent after commit (Telegram, disabled by default).
-- Receipts on reimbursements get a sixth table (bytes in private document storage). Complaint &
-- Feedback and confidential call requests are flagged "confidential" on the row.
-- Plus one department, "Driver Relations", for every company already on file (new companies get
-- theirs when they are created). Additive only: six new tables, one trigger, one department row
-- per company. No existing row is rewritten.
CREATE TABLE IF NOT EXISTS "driver_care_links" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "driver_relation_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"request_number" text NOT NULL,
	"topic" text NOT NULL,
	"source" text NOT NULL,
	"care_link_id" text,
	"driver_id" text,
	"truck_id" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"submitted_name" text NOT NULL,
	"truck_snapshot" text,
	"contact_phone" text,
	"phone_key" text,
	"description" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"needs_contact" boolean DEFAULT true NOT NULL,
	"confidential" boolean DEFAULT false NOT NULL,
	"assigned_user_id" text,
	"assigned_user_name" text,
	"assigned_team" text DEFAULT 'driver_relations' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_driver_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"contacted_at" timestamp with time zone,
	"contacted_by" text,
	"contacted_by_name" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolved_by_name" text,
	"hr_lead_id" text,
	"accounting_expense_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_relation_requests_topic_check" CHECK ("topic" IN ('referral','complaint_feedback','reimbursement','pay_statement','compliance','management_call')),
	CONSTRAINT "driver_relation_requests_status_check" CHECK ("status" IN ('new','contacted','resolved')),
	CONSTRAINT "driver_relation_requests_resolved_contacted" CHECK ("status" <> 'resolved' OR ("needs_contact" = false AND "contacted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "driver_relation_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"request_id" text NOT NULL,
	"type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"method" text,
	"note" text,
	"corrects_activity_id" text,
	"detail" jsonb,
	"request_version" integer NOT NULL,
	"event_key" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_relation_activities_contact_note" CHECK ("type" NOT IN ('contacted','attempt','resolved') OR length(btrim(coalesce("note", ''))) > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "driver_care_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"care_link_id" text NOT NULL,
	"submission_key" text NOT NULL,
	"request_id" text NOT NULL,
	"outcome" text NOT NULL,
	"topic" text NOT NULL,
	"phone_key" text,
	"ip_hash" text,
	"user_agent" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "driver_relation_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"request_id" text NOT NULL,
	"activity_id" text,
	"original_file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_relation_attachments_type_check" CHECK ("content_type" IN ('image/jpeg','image/png','image/heic','application/pdf'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "driver_relation_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"request_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"adapter" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"external_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "driver_care_links" ADD CONSTRAINT "driver_care_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_relation_requests" ADD CONSTRAINT "driver_relation_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_relation_requests" ADD CONSTRAINT "driver_relation_requests_care_link_id_driver_care_links_id_fk" FOREIGN KEY ("care_link_id") REFERENCES "public"."driver_care_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_relation_activities" ADD CONSTRAINT "driver_relation_activities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_relation_activities" ADD CONSTRAINT "driver_relation_activities_request_id_driver_relation_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."driver_relation_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_care_submissions" ADD CONSTRAINT "driver_care_submissions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_care_submissions" ADD CONSTRAINT "driver_care_submissions_care_link_id_driver_care_links_id_fk" FOREIGN KEY ("care_link_id") REFERENCES "public"."driver_care_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_care_submissions" ADD CONSTRAINT "driver_care_submissions_request_id_driver_relation_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."driver_relation_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_relation_attachments" ADD CONSTRAINT "driver_relation_attachments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_relation_attachments" ADD CONSTRAINT "driver_relation_attachments_request_id_driver_relation_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."driver_relation_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_relation_outbox" ADD CONSTRAINT "driver_relation_outbox_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_relation_outbox" ADD CONSTRAINT "driver_relation_outbox_request_id_driver_relation_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."driver_relation_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_care_links_slug_key" ON "driver_care_links" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_care_links_company_idx" ON "driver_care_links" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_relation_requests_number_key" ON "driver_relation_requests" USING btree ("company_id","request_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_relation_requests_idem_key" ON "driver_relation_requests" USING btree ("company_id","idempotency_key") WHERE "idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_relation_requests_alert_idx" ON "driver_relation_requests" USING btree ("company_id","needs_contact","topic");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_relation_requests_status_idx" ON "driver_relation_requests" USING btree ("company_id","status","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_relation_requests_confidential_idx" ON "driver_relation_requests" USING btree ("company_id","confidential");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_relation_attachments_request_idx" ON "driver_relation_attachments" USING btree ("company_id","request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_relation_requests_phone_idx" ON "driver_relation_requests" USING btree ("company_id","phone_key","topic");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_relation_activities_request_idx" ON "driver_relation_activities" USING btree ("company_id","request_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_relation_activities_event_key" ON "driver_relation_activities" USING btree ("company_id","event_key") WHERE "event_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_care_submissions_key" ON "driver_care_submissions" USING btree ("company_id","submission_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_care_submissions_ip_idx" ON "driver_care_submissions" USING btree ("ip_hash","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_care_submissions_phone_idx" ON "driver_care_submissions" USING btree ("company_id","phone_key","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_relation_outbox_event_key" ON "driver_relation_outbox" USING btree ("adapter","event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_relation_outbox_due_idx" ON "driver_relation_outbox" USING btree ("status","retry_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_relation_outbox_request_idx" ON "driver_relation_outbox" USING btree ("company_id","request_id");--> statement-breakpoint
-- The activity log is evidence: what a driver said and when they were reached. It is never
-- rewritten; a correction is a new entry that points at the old one.
CREATE OR REPLACE FUNCTION "driver_relation_activities_append_only"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'driver_relation_activities is append-only; add a correction instead';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "driver_relation_activities_no_rewrite" ON "driver_relation_activities";--> statement-breakpoint
CREATE TRIGGER "driver_relation_activities_no_rewrite" BEFORE UPDATE OR DELETE ON "driver_relation_activities" FOR EACH ROW EXECUTE FUNCTION "driver_relation_activities_append_only"();--> statement-breakpoint
-- One "Driver Relations" department per company, through the existing departments table. Tenant
-- by tenant: never a global row. A company that already has the code, or a department by that
-- name, keeps what it has.
INSERT INTO "departments" ("id", "company_id", "code", "name", "description", "status", "is_system")
SELECT 'dep_driver_relations_' || c."id", c."id", 'driver_relations', 'Driver Relations',
	'Every request drivers send from the NORTHWIND FREIGHT Driver Care page.', 'active', true
FROM "companies" c
ON CONFLICT DO NOTHING;
