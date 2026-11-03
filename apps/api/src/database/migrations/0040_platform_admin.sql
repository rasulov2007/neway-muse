-- Platform administrator and deactivated companies (owner, 2026-10-01). Additive: four nullable or
-- defaulted columns, nothing backfilled, nothing existing changes. `0040_platform_admin.down.sql`
-- takes them back out.
--
-- `users.is_platform_admin` marks the person who may create and look after customer companies from
-- the Companies page. It belongs to the person, not to a membership: it is not access to any one
-- company's work. Nobody holds it until `grant-platform-admin` gives it to someone.
--
-- A deactivated company is hidden, kept and reversible: its people cannot sign in and their open
-- sessions stop answering; every row stays, and reactivating puts it back exactly as it was.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_platform_admin" boolean DEFAULT false NOT NULL;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "deactivated_at" timestamp with time zone;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "deactivated_reason" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "deactivated_by" text;
