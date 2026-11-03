ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "test_reason";
ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "test_marked_by";
ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "test_marked_at";
ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "is_test";
ALTER TABLE "driver_relation_requests" DROP COLUMN IF EXISTS "test_reason";
ALTER TABLE "driver_relation_requests" DROP COLUMN IF EXISTS "test_marked_by";
ALTER TABLE "driver_relation_requests" DROP COLUMN IF EXISTS "test_marked_at";
ALTER TABLE "driver_relation_requests" DROP COLUMN IF EXISTS "is_test";
