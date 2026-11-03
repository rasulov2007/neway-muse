-- The weekly walk-around, as rows a person can own.
--
-- A PTI defect used to be three columns on an inspection row in the workspace blob, so it could
-- not be owned, dated, assigned, verified or referenced. These tables give it a life of its own.
-- The blob's ws2-ptirecords is not touched by this file; it stays readable for the screens that
-- have not moved yet, and the backfill that copies it here is a separate, dry-runnable script.

CREATE TABLE IF NOT EXISTS "pti_inspections" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "unit_id" text NOT NULL,
  "unit_number" text NOT NULL DEFAULT '',
  "week_start" date NOT NULL,
  "due_at" date NOT NULL,
  "driver_id" text,
  "driver_name" text,
  "driver_type" text,
  "dispatcher_id" text,
  "dispatcher_name" text,
  -- not_due · awaiting · received · late · missing · exempt_in_shop (derived on read; stored as last computed)
  "receipt_status" text NOT NULL DEFAULT 'awaiting',
  "received_at" timestamp with time zone,
  -- The Telegram pointer: chat title, message link, sender, sent time. Never the video.
  "source" jsonb,
  -- unreviewed · in_review · reviewed
  "review_state" text NOT NULL DEFAULT 'unreviewed',
  "reviewer_id" text,
  "reviewer_name" text,
  "reviewed_at" timestamp with time zone,
  -- no_issues · issues_found; only meaningful once reviewed
  "review_result" text,
  "in_review_by" text,
  "in_review_by_name" text,
  "in_review_since" timestamp with time zone,
  -- [{defectId, seen}] — what the reviewer said about defects already open
  "open_defect_dispositions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "legacy_record_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS "pti_inspections_unit_week_key"
  ON "pti_inspections" ("company_id", "unit_id", "week_start");
CREATE INDEX IF NOT EXISTS "pti_inspections_week_idx"
  ON "pti_inspections" ("company_id", "week_start");
CREATE UNIQUE INDEX IF NOT EXISTS "pti_inspections_legacy_key"
  ON "pti_inspections" ("company_id", "legacy_record_id") WHERE "legacy_record_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "pti_defects" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "defect_number" text NOT NULL,
  "unit_id" text NOT NULL,
  "unit_number" text NOT NULL DEFAULT '',
  "found_on_inspection_id" text REFERENCES "pti_inspections"("id") ON DELETE SET NULL,
  -- A key from the component catalog (ws2-pticomponents[].key). Never free text.
  "component" text NOT NULL,
  "component_name" text NOT NULL DEFAULT '',
  "description" text NOT NULL,
  "quick_pick" text,
  -- monitor · replace_soon · replace_now · oos_risk
  "severity" text NOT NULL,
  -- open · assigned · scheduled · in_repair · fixed_pending_verify · verified · dismissed
  "state" text NOT NULL DEFAULT 'open',
  -- {clipTime, screenshots:[{fileId, fileName, uploadedAt, uploadedBy}]}
  "evidence" jsonb NOT NULL DEFAULT '{"clipTime":null,"screenshots":[]}'::jsonb,
  "owner_id" text,
  "owner_name" text,
  "due_at" timestamp with time zone,
  -- The work order fixing it, by id. The link is this field, never a sentence.
  "work_order_id" text,
  "work_order_number" text,
  -- {fixedAt, fixedVia, verifiedAt, verifiedBy, dismissedReason}
  "resolution" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Set by the backfill on a row whose legacy text could not be trusted; a person clears it.
  "needs_review" boolean NOT NULL DEFAULT false,
  "legacy_record_id" text,
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS "pti_defects_company_number_key"
  ON "pti_defects" ("company_id", "defect_number");
CREATE INDEX IF NOT EXISTS "pti_defects_unit_state_idx"
  ON "pti_defects" ("company_id", "unit_id", "state");
CREATE INDEX IF NOT EXISTS "pti_defects_state_idx"
  ON "pti_defects" ("company_id", "state");
CREATE UNIQUE INDEX IF NOT EXISTS "pti_defects_legacy_key"
  ON "pti_defects" ("company_id", "legacy_record_id") WHERE "legacy_record_id" IS NOT NULL;

-- Append-only. Nothing updates or deletes a row here.
CREATE TABLE IF NOT EXISTS "pti_defect_history" (
  "id" text PRIMARY KEY,
  "defect_id" text NOT NULL REFERENCES "pti_defects"("id") ON DELETE CASCADE,
  "at" timestamp with time zone NOT NULL DEFAULT now(),
  "by_id" text NOT NULL,
  "by_name" text NOT NULL,
  "from_state" text,
  "to_state" text NOT NULL,
  "note" text
);
CREATE INDEX IF NOT EXISTS "pti_defect_history_defect_idx"
  ON "pti_defect_history" ("defect_id", "at");
