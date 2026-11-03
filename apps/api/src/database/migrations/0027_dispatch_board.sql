-- The dispatch boards' typed layer (owner's brief, 2026-09-22): what a person typed over what
-- the loads say, one row per driver, day and column; the tints; and the edit log behind the
-- history popup and undo. Additive; nothing existing changes.
CREATE TABLE IF NOT EXISTS "dispatch_board_cells" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "driver_id" text NOT NULL,
  "day" date NOT NULL,
  "column" text NOT NULL,
  "value" text,
  "formula" text,
  "set_by" text NOT NULL,
  "set_by_name" text NOT NULL DEFAULT '',
  "set_at" timestamp with time zone NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS "dispatch_board_cells_key" ON "dispatch_board_cells" ("company_id", "driver_id", "day", "column");
CREATE INDEX IF NOT EXISTS "dispatch_board_cells_day_idx" ON "dispatch_board_cells" ("company_id", "day");

CREATE TABLE IF NOT EXISTS "dispatch_board_fills" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "driver_id" text NOT NULL,
  "day" date NOT NULL,
  "column" text NOT NULL,
  "tint" integer NOT NULL,
  "set_by" text NOT NULL,
  "set_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "dispatch_board_fills_key" ON "dispatch_board_fills" ("company_id", "driver_id", "day", "column");

CREATE TABLE IF NOT EXISTS "dispatch_board_edits" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "driver_id" text NOT NULL,
  "day" date NOT NULL,
  "column" text NOT NULL,
  "old_value" text,
  "new_value" text,
  "by" text NOT NULL,
  "by_name" text NOT NULL DEFAULT '',
  "at" timestamp with time zone NOT NULL DEFAULT now(),
  "source" text NOT NULL DEFAULT 'user'
);
CREATE INDEX IF NOT EXISTS "dispatch_board_edits_driver_idx" ON "dispatch_board_edits" ("company_id", "driver_id", "at");
