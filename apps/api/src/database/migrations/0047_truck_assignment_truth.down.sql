-- Reverts 0047 completely.
-- Data lost: every pickup/drop photo link (the stored_files rows and their bytes stay), the
-- returned-items lists and drop notes written at unassign, who ended / last edited each
-- assignment by name, and the "approximate start" flag on backfilled rows (the backfilled rows
-- themselves stay as ordinary assignment rows; void them by hand if the backfill must go too).
DROP TABLE IF EXISTS "truck_assignment_photos";
DROP INDEX IF EXISTS "truck_driver_assignments_open_truck_key";
DROP INDEX IF EXISTS "truck_driver_assignments_open_driver_key";
ALTER TABLE "truck_driver_assignments" DROP COLUMN IF EXISTS "updated_by_name";
ALTER TABLE "truck_driver_assignments" DROP COLUMN IF EXISTS "updated_by";
ALTER TABLE "truck_driver_assignments" DROP COLUMN IF EXISTS "ended_at";
ALTER TABLE "truck_driver_assignments" DROP COLUMN IF EXISTS "ended_by_name";
ALTER TABLE "truck_driver_assignments" DROP COLUMN IF EXISTS "drop_note";
ALTER TABLE "truck_driver_assignments" DROP COLUMN IF EXISTS "returned_equipment";
ALTER TABLE "truck_driver_assignments" DROP COLUMN IF EXISTS "source";
ALTER TABLE "truck_driver_assignments" DROP COLUMN IF EXISTS "assigned_on_approximate";
