-- Archived drivers (owner, 2026-10-02). Additive: three nullable columns on "drivers", nothing
-- backfilled, nothing existing changes. `0039_driver_archive.down.sql` takes them back out.
--
-- "Archived" means hidden, kept, reversible, audited. An archived driver keeps their status
-- (onboarding, available ...), every load, document and audit line; the Drivers page and every
-- driver picker leave them out by default and the Drivers page's Archived tab shows and restores
-- them. Restoring clears the three columns; the audit trail keeps who archived and why.
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "archived_reason" text;
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "archived_by" text;
