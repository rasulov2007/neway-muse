-- Trailer model (owner, 2026-10-22): the Add trailer form asks for the model the way Add truck does.
-- ADDITIVE ONLY: one new nullable column. No default, no backfill, no value changed; every existing
-- trailer reads as "model not set".
ALTER TABLE "trailers" ADD COLUMN IF NOT EXISTS "model" text;
