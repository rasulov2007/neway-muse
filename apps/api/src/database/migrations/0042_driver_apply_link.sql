-- The public driver application link. A link (`/apply/<slug>`) resolves to one company on the
-- server; each submission is stored as an application beside the lead it created or joined, with
-- its answers, attribution and the consent wording as the driver saw it. Leads gain the time of
-- their latest online application; nothing about an existing lead's stage changes.
-- Additive only: two new tables and one nullable column. No existing row is rewritten.
CREATE TABLE IF NOT EXISTS "hiring_apply_links" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"short_name" text,
	"source" text DEFAULT 'social' NOT NULL,
	"campaign_id" text,
	"logo_url" text,
	"consent_text" text NOT NULL,
	"privacy_policy_url" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hiring_apply_links_short_name_len" CHECK ("short_name" IS NULL OR char_length("short_name") <= 12)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hiring_lead_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"apply_link_id" text NOT NULL,
	"submission_key" text NOT NULL,
	"outcome" text NOT NULL,
	"source" text NOT NULL,
	"campaign_id" text,
	"answers" jsonb NOT NULL,
	"attribution" jsonb NOT NULL,
	"consent_text" text NOT NULL,
	"privacy_policy_url" text NOT NULL,
	"consented_at" timestamp with time zone NOT NULL,
	"phone_key" text NOT NULL,
	"ip_hash" text,
	"user_agent" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hiring_leads" ADD COLUMN IF NOT EXISTS "last_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_apply_links" ADD CONSTRAINT "hiring_apply_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_apply_links" ADD CONSTRAINT "hiring_apply_links_campaign_id_hiring_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."hiring_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_lead_applications" ADD CONSTRAINT "hiring_lead_applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_lead_applications" ADD CONSTRAINT "hiring_lead_applications_lead_id_hiring_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."hiring_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_lead_applications" ADD CONSTRAINT "hiring_lead_applications_apply_link_id_hiring_apply_links_id_fk" FOREIGN KEY ("apply_link_id") REFERENCES "public"."hiring_apply_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_lead_applications" ADD CONSTRAINT "hiring_lead_applications_campaign_id_hiring_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."hiring_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_apply_links_slug_key" ON "hiring_apply_links" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_apply_links_company_idx" ON "hiring_apply_links" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_lead_applications_submission_key" ON "hiring_lead_applications" USING btree ("company_id","submission_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_lead_applications_lead_idx" ON "hiring_lead_applications" USING btree ("company_id","lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_lead_applications_link_idx" ON "hiring_lead_applications" USING btree ("apply_link_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_lead_applications_ip_idx" ON "hiring_lead_applications" USING btree ("ip_hash","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_lead_applications_phone_idx" ON "hiring_lead_applications" USING btree ("company_id","phone_key","received_at");
