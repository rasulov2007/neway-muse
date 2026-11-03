-- Hand-run rollback of 0077 (local/staging only; forgets the self-entered personal fields).
ALTER TABLE "memberships" DROP COLUMN IF EXISTS "profile_completed_at";
ALTER TABLE "employees" DROP COLUMN IF EXISTS "shift_time";
ALTER TABLE "employees" DROP COLUMN IF EXISTS "home_address";
ALTER TABLE "employees" DROP COLUMN IF EXISTS "id_number";
ALTER TABLE "employees" DROP COLUMN IF EXISTS "date_of_birth";
