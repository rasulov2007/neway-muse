-- Rolls back 0041. Children before parents. The audit lines written about these records stay in
-- "audit_logs"; the files they pointed at stay in "stored_files".
DROP TABLE IF EXISTS "safety_case_documents";
DROP TABLE IF EXISTS "drug_alcohol_tests";
DROP TABLE IF EXISTS "safety_reviews";
DROP TABLE IF EXISTS "safety_violations";
DROP TABLE IF EXISTS "safety_roadside_inspections";
DROP TABLE IF EXISTS "safety_accounting_entries";
DROP TABLE IF EXISTS "safety_claim_payments";
DROP TABLE IF EXISTS "safety_claims";
DROP TABLE IF EXISTS "safety_accidents";
DROP TABLE IF EXISTS "safety_counters";
