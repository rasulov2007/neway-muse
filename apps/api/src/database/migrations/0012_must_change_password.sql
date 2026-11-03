-- A temporary password is a password that must not survive first use.
-- Additive: existing accounts keep their credential and are unaffected (false).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_change_password" boolean DEFAULT false NOT NULL;
