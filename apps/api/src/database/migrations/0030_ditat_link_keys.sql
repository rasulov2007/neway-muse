-- Where a record came from, so an import recognises its own work on the next run.
--
-- `source` names the system ('ditat', 'samsara'), `external_id` is that system's key for the row.
-- Both are nullable: a record somebody typed here has neither, and that is not a defect.
-- The unique index is partial so any number of native rows can carry NULL while one imported row
-- owns one key.
ALTER TABLE "trailers" ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE "trailers" ADD COLUMN IF NOT EXISTS "external_id" text;
ALTER TABLE "trucks" ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE "trucks" ADD COLUMN IF NOT EXISTS "external_id" text;
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "external_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS "trailers_source_key"
  ON "trailers" ("company_id", "source", "external_id") WHERE "external_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "trucks_source_key"
  ON "trucks" ("company_id", "source", "external_id") WHERE "external_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "drivers_source_key"
  ON "drivers" ("company_id", "source", "external_id") WHERE "external_id" IS NOT NULL;
