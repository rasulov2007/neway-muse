-- Rolls back 0043. Children before parents. Audit lines written about these records stay in
-- "audit_logs"; HR leads created from referrals stay in "hiring_leads" (they are HR's records).
-- Receipt bytes under storage driver-relations/ are left on disk for an operator to remove.
-- The "Driver Relations" department rows are removed only where no employee is in them.
DROP TABLE IF EXISTS "driver_relation_outbox";
DROP TABLE IF EXISTS "driver_care_submissions";
DROP TABLE IF EXISTS "driver_relation_attachments";
DROP TRIGGER IF EXISTS "driver_relation_activities_no_rewrite" ON "driver_relation_activities";
DROP TABLE IF EXISTS "driver_relation_activities";
DROP FUNCTION IF EXISTS "driver_relation_activities_append_only"();
DROP TABLE IF EXISTS "driver_relation_requests";
DROP TABLE IF EXISTS "driver_care_links";
DELETE FROM "departments" d
WHERE d."code" = 'driver_relations' AND d."id" = 'dep_driver_relations_' || d."company_id"
  AND NOT EXISTS (SELECT 1 FROM "employees" e WHERE e."company_id" = d."company_id" AND e."department" = 'driver_relations');
