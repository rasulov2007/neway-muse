-- Accident & Claims v2, phase P1 (docs/accidents/IMPLEMENTATION-PLAN.md §5, owner decisions §10).
-- ADDITIVE ONLY: new nullable columns (or NOT NULL with a constant default), new tables, new indexes.
-- No DROP, no RENAME, no type change, no change to an existing value. Nothing is backfilled here:
-- the stage remap, five-state facts and claims split are cutover backfills that run only with the owner.
-- Everything new is read and written only by the accidents_v2 endpoints (ACCIDENTS_V2, default off).

-- ---------------------------------------------------------------------------------------- 1. safety_accidents
-- v2 intake facts (five-state, NULL = not reported yet), incident zone, provenance, severity, investigation
-- status, determination who/when, summary override, "no claim" decision, legal hold and closing details.
-- The legacy counts (injuries, injuries_treated_away, fatalities) stay NOT NULL DEFAULT 0 and untouched;
-- v2 keeps its own nullable counts so an unknown is never stored as 0.
ALTER TABLE "safety_accidents"
  ADD COLUMN IF NOT EXISTS "occurred_tz" text,
  ADD COLUMN IF NOT EXISTS "time_provenance" text CHECK ("time_provenance" IN ('verified','driver','preliminary')),
  ADD COLUMN IF NOT EXISTS "submitted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "legacy_stage" text,
  ADD COLUMN IF NOT EXISTS "legacy_fault" text,
  ADD COLUMN IF NOT EXISTS "legacy_preventability" text,
  ADD COLUMN IF NOT EXISTS "location_road" text,
  ADD COLUMN IF NOT EXISTS "location_detail" text,
  ADD COLUMN IF NOT EXISTS "latitude" numeric(9,6),
  ADD COLUMN IF NOT EXISTS "longitude" numeric(9,6),
  ADD COLUMN IF NOT EXISTS "public_road" text CHECK ("public_road" IN ('yes','no','unknown','na')),
  ADD COLUMN IF NOT EXISTS "location_provenance" text CHECK ("location_provenance" IN ('verified','driver','preliminary')),
  ADD COLUMN IF NOT EXISTS "accident_type" text,
  ADD COLUMN IF NOT EXISTS "description_provenance" text CHECK ("description_provenance" IN ('verified','driver','preliminary')),
  ADD COLUMN IF NOT EXISTS "severity" text CHECK ("severity" IN ('minor','moderate','serious','critical')),
  ADD COLUMN IF NOT EXISTS "severity_manual_reason" text,
  ADD COLUMN IF NOT EXISTS "severity_manual_by" text,
  ADD COLUMN IF NOT EXISTS "severity_manual_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "assignment_source" text,
  ADD COLUMN IF NOT EXISTS "injuries_status" text CHECK ("injuries_status" IN ('yes','no','unknown','na')),
  ADD COLUMN IF NOT EXISTS "injuries_provenance" text CHECK ("injuries_provenance" IN ('verified','driver','preliminary')),
  ADD COLUMN IF NOT EXISTS "our_driver_injured" text CHECK ("our_driver_injured" IN ('yes','no','unknown','na')),
  ADD COLUMN IF NOT EXISTS "treated_away_count" integer CHECK ("treated_away_count" >= 0),
  ADD COLUMN IF NOT EXISTS "fatalities_count" integer CHECK ("fatalities_count" >= 0),
  ADD COLUMN IF NOT EXISTS "tow_away" text CHECK ("tow_away" IN ('yes','no','unknown','na')),
  ADD COLUMN IF NOT EXISTS "tow_provenance" text CHECK ("tow_provenance" IN ('verified','driver','preliminary')),
  ADD COLUMN IF NOT EXISTS "citation_status" text CHECK ("citation_status" IN ('yes','no','unknown','na')),
  ADD COLUMN IF NOT EXISTS "hazmat_released" text CHECK ("hazmat_released" IN ('yes','no','unknown','na')),
  ADD COLUMN IF NOT EXISTS "excluded_occurrence" text CHECK ("excluded_occurrence" IN ('boarding_alighting','loading_unloading')),
  ADD COLUMN IF NOT EXISTS "police_responded" text CHECK ("police_responded" IN ('yes','no','unknown','na')),
  ADD COLUMN IF NOT EXISTS "police_department" text,
  ADD COLUMN IF NOT EXISTS "weather" text,
  ADD COLUMN IF NOT EXISTS "road_surface" text,
  ADD COLUMN IF NOT EXISTS "light_condition" text,
  ADD COLUMN IF NOT EXISTS "cargo_status" text CHECK ("cargo_status" IN ('na','unknown','no_damage','damaged','loss')),
  ADD COLUMN IF NOT EXISTS "cargo_plan" text CHECK ("cargo_plan" IN ('none_needed','transload','repower','delivered_as_is','rejected','salvage')),
  ADD COLUMN IF NOT EXISTS "cargo_notes" text,
  ADD COLUMN IF NOT EXISTS "cargo_delivery_impact" text,
  ADD COLUMN IF NOT EXISTS "broker_notified" text CHECK ("broker_notified" IN ('yes','no','unknown','na')),
  ADD COLUMN IF NOT EXISTS "initial_estimate_cents" bigint CHECK ("initial_estimate_cents" >= 0),
  ADD COLUMN IF NOT EXISTS "immediate_actions" jsonb,
  ADD COLUMN IF NOT EXISTS "investigation_status" text DEFAULT 'not_started' NOT NULL
    CHECK ("investigation_status" IN ('not_started','in_progress','in_review','complete')),
  ADD COLUMN IF NOT EXISTS "investigation_owner_id" text,
  ADD COLUMN IF NOT EXISTS "investigation_conclusion" text,
  ADD COLUMN IF NOT EXISTS "investigation_submitted_by" text,
  ADD COLUMN IF NOT EXISTS "investigation_submitted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "investigation_approved_by" text,
  ADD COLUMN IF NOT EXISTS "investigation_completed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "fault_basis" text,
  ADD COLUMN IF NOT EXISTS "fault_by" text,
  ADD COLUMN IF NOT EXISTS "fault_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "preventability_by" text,
  ADD COLUMN IF NOT EXISTS "preventability_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "cpdp_status" text
    CHECK ("cpdp_status" IN ('not_applicable','not_eligible','eligible_not_submitted','submitted','not_preventable','preventable','undecided')),
  ADD COLUMN IF NOT EXISTS "cpdp_rdr" text,
  ADD COLUMN IF NOT EXISTS "cpdp_basis" text,
  ADD COLUMN IF NOT EXISTS "cpdp_by" text,
  ADD COLUMN IF NOT EXISTS "cpdp_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "summary_override_text" text,
  ADD COLUMN IF NOT EXISTS "summary_override_by" text,
  ADD COLUMN IF NOT EXISTS "summary_override_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "summary_facts_hash" text,
  ADD COLUMN IF NOT EXISTS "claim_decision_text" text,
  ADD COLUMN IF NOT EXISTS "claim_decision_by" text,
  ADD COLUMN IF NOT EXISTS "claim_decision_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "legal_hold_since" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "legal_hold_by" text,
  ADD COLUMN IF NOT EXISTS "legal_hold_reason" text,
  ADD COLUMN IF NOT EXISTS "close_outcome" text,
  ADD COLUMN IF NOT EXISTS "close_prevention" text,
  ADD COLUMN IF NOT EXISTS "close_override_reason" text,
  ADD COLUMN IF NOT EXISTS "close_override_by" text,
  ADD COLUMN IF NOT EXISTS "close_skipped_blockers" jsonb,
  ADD COLUMN IF NOT EXISTS "migrated_defaults_pending" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "idempotency_key" text;
CREATE UNIQUE INDEX IF NOT EXISTS "safety_accidents_idempotency_key"
  ON "safety_accidents" ("company_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "safety_accidents_company_occurred_idx" ON "safety_accidents" ("company_id", "occurred_at" DESC);
CREATE INDEX IF NOT EXISTS "safety_accidents_company_truck_idx" ON "safety_accidents" ("company_id", "truck_id", "occurred_at" DESC);

-- ---------------------------------------------------------------------------------------- 2. units involved
-- One row per tractor/trailer on a case. condition_at_scene is written at intake / by Safety only; a
-- repair never changes it (SPEC §6.5).
CREATE TABLE IF NOT EXISTS "accident_units" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "accident_id" text NOT NULL REFERENCES "safety_accidents"("id") ON DELETE restrict,
  "unit_kind" text NOT NULL CHECK ("unit_kind" IN ('truck','trailer')),
  "unit_id" text NOT NULL,
  "unit_number" text,
  "condition_at_scene" text DEFAULT 'unknown' NOT NULL CHECK ("condition_at_scene" IN ('drivable','not_drivable','unknown')),
  "status" text DEFAULT 'unknown' NOT NULL
    CHECK ("status" IN ('unknown','operational','at_scene','towed_storage','at_shop','in_repair','returned','total_loss','not_involved')),
  "damage" text,
  "tow_company" text,
  "towed_to" text,
  "storage_rate_cents" bigint CHECK ("storage_rate_cents" >= 0),
  "storage_since" timestamp with time zone,
  "returned_to_service_at" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "accident_units_unit_key" ON "accident_units" ("company_id", "accident_id", "unit_kind", "unit_id");

-- ---------------------------------------------------------------------------------------- 3. restricted details
-- Medical details and legal liability live apart so redaction is structural (SPEC §1.0 rule 8).
CREATE TABLE IF NOT EXISTS "accident_restricted" (
  "accident_id" text PRIMARY KEY NOT NULL REFERENCES "safety_accidents"("id") ON DELETE restrict,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "medical_details" text,
  "legal_liability" text
    CHECK ("legal_liability" IN ('unknown','no_claim_expected','disputed','third_party_liable','shared','company_liable','in_litigation')),
  "legal_basis" text,
  "legal_by" text,
  "legal_at" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ---------------------------------------------------------------------------------------- 4. tasks + requests
-- Tasks on a case (or, from P2, a claim). A request to another department (Dispatch availability,
-- repower/transload, broker notice, Ready after RTS) is a task with request_kind; only the owning
-- department confirms it, and only that confirmation may change their records (SPEC §6.4).
CREATE TABLE IF NOT EXISTS "safety_tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "accident_id" text REFERENCES "safety_accidents"("id") ON DELETE restrict,
  "claim_id" text,
  "work_order_id" text,
  "title" text NOT NULL,
  "dept" text NOT NULL CHECK ("dept" IN ('Safety','Fleet','Dispatch','Claims','Accounting','Management','Driver Relations')),
  "assignee_id" text,
  "assignee_name" text,
  "due_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'open' NOT NULL CHECK ("status" IN ('open','in_progress','blocked','done','cancelled')),
  "priority" text DEFAULT 'normal' NOT NULL CHECK ("priority" IN ('normal','high')),
  "instructions" text,
  "blocked_reason" text,
  "auto_rule" text,
  "prompt_key" text,
  "request_kind" text CHECK ("request_kind" IN ('unit_unavailable','repower_transload','notify_broker','unit_ready','other')),
  "request_payload" jsonb,
  "confirmed_by" text,
  "confirmed_at" timestamp with time zone,
  "is_test" boolean DEFAULT false NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_by" text,
  "completed_at" timestamp with time zone,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "legacy_ref" text,
  "legacy_payload" jsonb,
  CHECK ("accident_id" IS NOT NULL OR "claim_id" IS NOT NULL),
  CHECK (("status" = 'done') = ("completed_at" IS NOT NULL) OR "status" = 'cancelled')
);
CREATE INDEX IF NOT EXISTS "safety_tasks_accident_idx" ON "safety_tasks" ("company_id", "accident_id");
CREATE INDEX IF NOT EXISTS "safety_tasks_claim_idx" ON "safety_tasks" ("company_id", "claim_id");
CREATE INDEX IF NOT EXISTS "safety_tasks_open_idx" ON "safety_tasks" ("company_id", "due_at") WHERE "status" NOT IN ('done','cancelled');
CREATE INDEX IF NOT EXISTS "safety_tasks_assignee_idx" ON "safety_tasks" ("company_id", "assignee_id", "status");

CREATE TABLE IF NOT EXISTS "safety_task_updates" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "task_id" text NOT NULL REFERENCES "safety_tasks"("id") ON DELETE restrict,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "by_id" text,
  "by_name" text NOT NULL,
  "text" text NOT NULL
);
CREATE INDEX IF NOT EXISTS "safety_task_updates_task_idx" ON "safety_task_updates" ("company_id", "task_id", "at");

-- ---------------------------------------------------------------------------------------- 5. timeline (event time)
-- Owner decision Q5: the audit trail stays audit_logs; this append-only table adds what audit_logs cannot
-- hold - the time the event happened (event time != logged time), its source department and the
-- restricted flag the timeline masks.
CREATE TABLE IF NOT EXISTS "safety_timeline_events" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "accident_id" text REFERENCES "safety_accidents"("id") ON DELETE restrict,
  "claim_id" text,
  "work_order_id" text,
  "occurred_at" timestamp with time zone NOT NULL,
  "logged_at" timestamp with time zone DEFAULT now() NOT NULL,
  "actor_id" text,
  "actor_name" text NOT NULL,
  "source" text NOT NULL CHECK ("source" IN ('Safety','Fleet','Dispatch','Claims','Accounting','Telematics','Driver','System','Management')),
  "kind" text NOT NULL CHECK ("kind" IN ('milestone','change','note','task','access')),
  "text" text NOT NULL,
  "restricted" boolean DEFAULT false NOT NULL,
  "before" jsonb,
  "after" jsonb
);
CREATE INDEX IF NOT EXISTS "safety_timeline_events_accident_idx" ON "safety_timeline_events" ("company_id", "accident_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "safety_timeline_events_claim_idx" ON "safety_timeline_events" ("company_id", "claim_id", "occurred_at");
-- Entries are never changed. The one DELETE allowed is the whole-workspace reset (scripts/reset-workspace.ts), which
-- sets neway.workspace_reset for its own transaction; nothing in the product can.
CREATE OR REPLACE FUNCTION "safety_timeline_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('neway.workspace_reset', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'safety_timeline_events is append-only (% blocked)', TG_OP;
END
$fn$;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'safety_timeline_events_no_change') THEN
    CREATE TRIGGER "safety_timeline_events_no_change" BEFORE UPDATE OR DELETE ON "safety_timeline_events"
      FOR EACH ROW EXECUTE FUNCTION "safety_timeline_events_append_only"();
  END IF;
END
$do$;

-- ---------------------------------------------------------------------------------------- 6. downtime
-- Out-of-service periods of a unit on a case. At most one open period per unit per case.
CREATE TABLE IF NOT EXISTS "downtime_periods" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "accident_id" text NOT NULL REFERENCES "safety_accidents"("id") ON DELETE restrict,
  "unit_kind" text NOT NULL CHECK ("unit_kind" IN ('truck','trailer')),
  "unit_id" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone,
  "source" text NOT NULL CHECK ("source" IN ('daily_board','work_order','entered')),
  "verified_by" text,
  "verified_at" timestamp with time zone,
  "note" text,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CHECK ("ended_at" IS NULL OR "ended_at" > "started_at")
);
CREATE INDEX IF NOT EXISTS "downtime_periods_accident_idx" ON "downtime_periods" ("company_id", "accident_id");
CREATE INDEX IF NOT EXISTS "downtime_periods_open_idx" ON "downtime_periods" ("company_id", "unit_kind", "unit_id") WHERE "ended_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "downtime_periods_one_open_per_unit"
  ON "downtime_periods" ("company_id", "accident_id", "unit_kind", "unit_id") WHERE "ended_at" IS NULL;

-- ---------------------------------------------------------------------------------------- 7. settings
-- Per-company rule settings (SPEC §12). Empty = the defaults in packages/shared safety-rules/settings.ts.
CREATE TABLE IF NOT EXISTS "safety_settings" (
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "key" text NOT NULL,
  "value" jsonb NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("company_id", "key")
);

-- ---------------------------------------------------------------------------------------- 8. existing tables, extended
-- Post-accident tests stay in drug_alcohol_tests (one per accident and substance). Safety may only escalate
-- to "required" (company policy); there is no "not required" decision - that only comes from the facts.
ALTER TABLE "drug_alcohol_tests"
  ADD COLUMN IF NOT EXISTS "post_accident_decision" text CHECK ("post_accident_decision" IN ('auto','required')),
  ADD COLUMN IF NOT EXISTS "decision_by" text,
  ADD COLUMN IF NOT EXISTS "decision_at" timestamp with time zone;

-- Corrective actions stay safety_reviews rows (owner decision Q3). A v2 action links to its accident by
-- accident_id (many per accident), carries its own kind, due date, assignee and the restricted flag.
ALTER TABLE "safety_reviews"
  ADD COLUMN IF NOT EXISTS "accident_id" text,
  ADD COLUMN IF NOT EXISTS "action_kind" text
    CHECK ("action_kind" IN ('Coaching','Retraining','Ride-along evaluation','Disciplinary review','Equipment fix','Policy / bulletin')),
  ADD COLUMN IF NOT EXISTS "due_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "assignee_id" text,
  ADD COLUMN IF NOT EXISTS "assignee_name" text,
  ADD COLUMN IF NOT EXISTS "restricted" boolean DEFAULT false NOT NULL;
CREATE INDEX IF NOT EXISTS "safety_reviews_accident_idx" ON "safety_reviews" ("company_id", "accident_id") WHERE "accident_id" IS NOT NULL;

-- Evidence category (SPEC §1.4 list), description and the restricted flag on case documents.
ALTER TABLE "safety_case_documents"
  ADD COLUMN IF NOT EXISTS "category" text,
  ADD COLUMN IF NOT EXISTS "description" text,
  ADD COLUMN IF NOT EXISTS "restricted" boolean DEFAULT false NOT NULL;
