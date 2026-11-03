-- Hand-run rollback of 0073 (local/staging only; drops every recorded trailer model).
ALTER TABLE "trailers" DROP COLUMN IF EXISTS "model";
