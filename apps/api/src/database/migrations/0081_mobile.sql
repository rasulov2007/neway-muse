-- 0081: NeWay mobile (Driver + Office) foundation (owner brief, 2026-10-27; docs/mobile/PLAN.md §C).
-- Additive only: new tables and nullable columns. Nothing existing is rewritten, dropped or backfilled.
-- M1 implements memberships.driver_id, auth_sessions.client, mobile_devices, mobile_idempotency and
-- the PTI correction columns; the other tables are created now so later phases need no migration.

-- The driver login link: the roster driver this membership signs in as. One login per driver per company.
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "driver_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memberships_company_driver_key" ON "memberships" ("company_id", "driver_id") WHERE driver_id IS NOT NULL;
--> statement-breakpoint
-- web (12 h) or mobile (30 days); null = web, as every session before this.
ALTER TABLE "auth_sessions" ADD COLUMN IF NOT EXISTS "client" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mobile_devices" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "membership_id" text NOT NULL REFERENCES "memberships"("id") ON DELETE RESTRICT,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "session_id" text,
  "expo_token" text NOT NULL,
  "platform" text NOT NULL,
  "app_version" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_reason" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mobile_devices_live_token_key" ON "mobile_devices" ("membership_id", "expo_token") WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mobile_devices_user_idx" ON "mobile_devices" ("company_id", "user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mobile_idempotency" (
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "membership_id" text NOT NULL REFERENCES "memberships"("id") ON DELETE RESTRICT,
  "key" text NOT NULL,
  "route" text NOT NULL,
  "status_code" integer DEFAULT 200 NOT NULL,
  "response" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mobile_idempotency_key" ON "mobile_idempotency" ("company_id", "membership_id", "key");
--> statement-breakpoint
-- Push sends, one row per device per notification: what was attempted and what Expo answered.
CREATE TABLE IF NOT EXISTS "mobile_push_log" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "notification_id" text NOT NULL,
  "device_id" text NOT NULL,
  "status" text NOT NULL,
  "error" text,
  "ticket_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mobile_push_log_notification_idx" ON "mobile_push_log" ("company_id", "notification_id");
--> statement-breakpoint
-- Messages (M4): load / case / request / direct / department conversations.
CREATE TABLE IF NOT EXISTS "conversations" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL,
  "subject_type" text,
  "subject_id" text,
  "department" text,
  "title" text NOT NULL DEFAULT '',
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_subject_idx" ON "conversations" ("company_id", "subject_type", "subject_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation_participants" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "conversation_id" text NOT NULL REFERENCES "conversations"("id") ON DELETE RESTRICT,
  "user_id" text,
  "driver_id" text,
  "role" text NOT NULL DEFAULT 'member',
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_read_at" timestamp with time zone,
  "left_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_participants_conversation_idx" ON "conversation_participants" ("conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_participants_user_idx" ON "conversation_participants" ("company_id", "user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "conversation_id" text NOT NULL REFERENCES "conversations"("id") ON DELETE RESTRICT,
  "sender_user_id" text,
  "sender_driver_id" text,
  "body" text NOT NULL DEFAULT '',
  "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "idempotency_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "voided_at" timestamp with time zone,
  "voided_by" text,
  "void_reason" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conversation_idx" ON "messages" ("conversation_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_idempotency_key" ON "messages" ("company_id", "conversation_id", "idempotency_key") WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint
-- Breakdowns / road issues a driver reports (M3).
CREATE TABLE IF NOT EXISTS "fleet_breakdowns" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "number" text NOT NULL,
  "driver_id" text,
  "truck_id" text,
  "trailer_id" text,
  "load_id" text,
  "category" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "location" jsonb,
  "status" text NOT NULL DEFAULT 'received',
  "assigned_user_id" text,
  "assigned_user_name" text,
  "vendor_id" text,
  "work_order_id" text,
  "estimate_cents" bigint,
  "files" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "history" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "source" text NOT NULL DEFAULT 'driver_app',
  "idempotency_key" text,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "closed_at" timestamp with time zone,
  "voided_at" timestamp with time zone,
  "voided_by" text,
  "void_reason" text,
  "version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fleet_breakdowns_number_key" ON "fleet_breakdowns" ("company_id", "number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fleet_breakdowns_status_idx" ON "fleet_breakdowns" ("company_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fleet_breakdowns_driver_idx" ON "fleet_breakdowns" ("company_id", "driver_id");
--> statement-breakpoint
-- Vacation requests from the driver (M3): the existing row gains a request life before it starts.
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "request_status" text;
--> statement-breakpoint
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "requested_by_driver" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "decided_by" text;
--> statement-breakpoint
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "decided_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "decided_reason" text;
--> statement-breakpoint
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "truck_parked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "truck_parked_by" text;
--> statement-breakpoint
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "truck_parked_note" text;
--> statement-breakpoint
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "keys_handed_at" timestamp with time zone;
--> statement-breakpoint
-- PTI from the driver app: Safety may ask for a correction; the driver resubmits (history in source).
ALTER TABLE "pti_inspections" ADD COLUMN IF NOT EXISTS "correction_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "pti_inspections" ADD COLUMN IF NOT EXISTS "correction_requested_by" text;
--> statement-breakpoint
ALTER TABLE "pti_inspections" ADD COLUMN IF NOT EXISTS "correction_reason" text;
--> statement-breakpoint
ALTER TABLE "pti_inspections" ADD COLUMN IF NOT EXISTS "driver_submission_count" integer DEFAULT 0 NOT NULL;
