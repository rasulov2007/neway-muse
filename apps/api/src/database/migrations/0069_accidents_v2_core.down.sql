-- Hand-run rollback of 0069 (local/staging only; never with v2 data that must be kept).
ALTER TABLE "safety_case_documents" DROP COLUMN IF EXISTS "restricted", DROP COLUMN IF EXISTS "description", DROP COLUMN IF EXISTS "category";
DROP INDEX IF EXISTS "safety_reviews_accident_idx";
ALTER TABLE "safety_reviews" DROP COLUMN IF EXISTS "restricted", DROP COLUMN IF EXISTS "assignee_name", DROP COLUMN IF EXISTS "assignee_id",
  DROP COLUMN IF EXISTS "due_at", DROP COLUMN IF EXISTS "action_kind", DROP COLUMN IF EXISTS "accident_id";
ALTER TABLE "drug_alcohol_tests" DROP COLUMN IF EXISTS "decision_at", DROP COLUMN IF EXISTS "decision_by", DROP COLUMN IF EXISTS "post_accident_decision";
DROP TABLE IF EXISTS "safety_settings";
DROP TABLE IF EXISTS "downtime_periods";
DROP TRIGGER IF EXISTS "safety_timeline_events_no_change" ON "safety_timeline_events";
DROP TABLE IF EXISTS "safety_timeline_events";
DROP FUNCTION IF EXISTS "safety_timeline_events_append_only"();
DROP TABLE IF EXISTS "safety_task_updates";
DROP TABLE IF EXISTS "safety_tasks";
DROP TABLE IF EXISTS "accident_restricted";
DROP TABLE IF EXISTS "accident_units";
DROP INDEX IF EXISTS "safety_accidents_company_truck_idx";
DROP INDEX IF EXISTS "safety_accidents_company_occurred_idx";
DROP INDEX IF EXISTS "safety_accidents_idempotency_key";
ALTER TABLE "safety_accidents"
  DROP COLUMN IF EXISTS "idempotency_key", DROP COLUMN IF EXISTS "migrated_defaults_pending", DROP COLUMN IF EXISTS "close_skipped_blockers",
  DROP COLUMN IF EXISTS "close_override_by", DROP COLUMN IF EXISTS "close_override_reason", DROP COLUMN IF EXISTS "close_prevention",
  DROP COLUMN IF EXISTS "close_outcome", DROP COLUMN IF EXISTS "legal_hold_reason", DROP COLUMN IF EXISTS "legal_hold_by",
  DROP COLUMN IF EXISTS "legal_hold_since", DROP COLUMN IF EXISTS "claim_decision_at", DROP COLUMN IF EXISTS "claim_decision_by",
  DROP COLUMN IF EXISTS "claim_decision_text", DROP COLUMN IF EXISTS "summary_facts_hash", DROP COLUMN IF EXISTS "summary_override_at",
  DROP COLUMN IF EXISTS "summary_override_by", DROP COLUMN IF EXISTS "summary_override_text", DROP COLUMN IF EXISTS "cpdp_at",
  DROP COLUMN IF EXISTS "cpdp_by", DROP COLUMN IF EXISTS "cpdp_basis", DROP COLUMN IF EXISTS "cpdp_rdr", DROP COLUMN IF EXISTS "cpdp_status",
  DROP COLUMN IF EXISTS "preventability_at", DROP COLUMN IF EXISTS "preventability_by", DROP COLUMN IF EXISTS "fault_at",
  DROP COLUMN IF EXISTS "fault_by", DROP COLUMN IF EXISTS "fault_basis", DROP COLUMN IF EXISTS "investigation_completed_at",
  DROP COLUMN IF EXISTS "investigation_approved_by", DROP COLUMN IF EXISTS "investigation_submitted_at",
  DROP COLUMN IF EXISTS "investigation_submitted_by", DROP COLUMN IF EXISTS "investigation_conclusion",
  DROP COLUMN IF EXISTS "investigation_owner_id", DROP COLUMN IF EXISTS "investigation_status", DROP COLUMN IF EXISTS "immediate_actions",
  DROP COLUMN IF EXISTS "initial_estimate_cents", DROP COLUMN IF EXISTS "broker_notified", DROP COLUMN IF EXISTS "cargo_delivery_impact",
  DROP COLUMN IF EXISTS "cargo_notes", DROP COLUMN IF EXISTS "cargo_plan", DROP COLUMN IF EXISTS "cargo_status",
  DROP COLUMN IF EXISTS "light_condition", DROP COLUMN IF EXISTS "road_surface", DROP COLUMN IF EXISTS "weather",
  DROP COLUMN IF EXISTS "police_department", DROP COLUMN IF EXISTS "police_responded", DROP COLUMN IF EXISTS "excluded_occurrence",
  DROP COLUMN IF EXISTS "hazmat_released", DROP COLUMN IF EXISTS "citation_status", DROP COLUMN IF EXISTS "tow_provenance",
  DROP COLUMN IF EXISTS "tow_away", DROP COLUMN IF EXISTS "fatalities_count", DROP COLUMN IF EXISTS "treated_away_count",
  DROP COLUMN IF EXISTS "our_driver_injured", DROP COLUMN IF EXISTS "injuries_provenance", DROP COLUMN IF EXISTS "injuries_status",
  DROP COLUMN IF EXISTS "assignment_source", DROP COLUMN IF EXISTS "severity_manual_at", DROP COLUMN IF EXISTS "severity_manual_by",
  DROP COLUMN IF EXISTS "severity_manual_reason", DROP COLUMN IF EXISTS "severity", DROP COLUMN IF EXISTS "description_provenance",
  DROP COLUMN IF EXISTS "accident_type", DROP COLUMN IF EXISTS "location_provenance", DROP COLUMN IF EXISTS "public_road",
  DROP COLUMN IF EXISTS "longitude", DROP COLUMN IF EXISTS "latitude", DROP COLUMN IF EXISTS "location_detail",
  DROP COLUMN IF EXISTS "location_road", DROP COLUMN IF EXISTS "legacy_preventability", DROP COLUMN IF EXISTS "legacy_fault",
  DROP COLUMN IF EXISTS "legacy_stage", DROP COLUMN IF EXISTS "submitted_at", DROP COLUMN IF EXISTS "time_provenance",
  DROP COLUMN IF EXISTS "occurred_tz";
