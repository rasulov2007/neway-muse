DROP INDEX IF EXISTS "drivers_source_key";
DROP INDEX IF EXISTS "trucks_source_key";
DROP INDEX IF EXISTS "trailers_source_key";
ALTER TABLE "drivers" DROP COLUMN IF EXISTS "external_id";
ALTER TABLE "drivers" DROP COLUMN IF EXISTS "source";
ALTER TABLE "trucks" DROP COLUMN IF EXISTS "external_id";
ALTER TABLE "trucks" DROP COLUMN IF EXISTS "source";
ALTER TABLE "trailers" DROP COLUMN IF EXISTS "external_id";
ALTER TABLE "trailers" DROP COLUMN IF EXISTS "source";
