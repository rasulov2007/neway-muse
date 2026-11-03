-- Hand-run rollback of 0075 (local/staging only; drops every recorded driver date of birth).
ALTER TABLE "drivers" DROP COLUMN IF EXISTS "date_of_birth";
