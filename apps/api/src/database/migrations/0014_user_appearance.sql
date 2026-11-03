-- Each worker's Light / Dark / System choice for the product's look (design/porcelain/SPEC.md §9).
-- Additive: existing accounts follow their computer's setting until they choose.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "appearance" text DEFAULT 'system' NOT NULL;
