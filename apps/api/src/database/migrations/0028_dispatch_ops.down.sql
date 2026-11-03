-- Reverses 0028_dispatch_ops. Only for a rollback decided in writing; the tables hold business
-- records (overrides, salary runs, claims) that should be backed up first.
DROP TABLE IF EXISTS "dispatch_audit";
DROP TABLE IF EXISTS "dispatch_claims";
DROP TABLE IF EXISTS "dispatch_salary_adjustments";
DROP TABLE IF EXISTS "dispatch_salary_runs";
DROP TABLE IF EXISTS "dispatch_allocations";
DROP TABLE IF EXISTS "dispatch_week_flags";
DROP TABLE IF EXISTS "dispatch_week_overrides";
DROP TABLE IF EXISTS "dispatch_policy_versions";
DROP TABLE IF EXISTS "dispatch_roster_assignments";
DROP TABLE IF EXISTS "dispatch_roster";
