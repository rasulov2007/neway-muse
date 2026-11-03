ALTER TABLE "onboarding_items" ADD COLUMN "blocking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "onboarding_items" ADD COLUMN "owner_role" text;--> statement-breakpoint
ALTER TABLE "onboarding_items" ADD COLUMN "requirement_code" text;--> statement-breakpoint
ALTER TABLE "onboarding_template_items" ADD COLUMN "blocking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "onboarding_template_items" ADD COLUMN "owner_role" text;--> statement-breakpoint
ALTER TABLE "onboarding_template_items" ADD COLUMN "requirement_code" text;--> statement-breakpoint
ALTER TABLE "onboarding_templates" ADD COLUMN "driver_type" text;