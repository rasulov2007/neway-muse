CREATE TABLE "hiring_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"channel" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date,
	"spend" numeric(12, 2) DEFAULT '0' NOT NULL,
	"owner_employee_id" text,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hiring_cost_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"hiring_case_id" text,
	"lead_id" text,
	"campaign_id" text,
	"type" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"incurred_on" date NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"note" text,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hiring_campaigns" ADD CONSTRAINT "hiring_campaigns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_campaigns" ADD CONSTRAINT "hiring_campaigns_owner_employee_id_employees_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD CONSTRAINT "hiring_cost_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD CONSTRAINT "hiring_cost_entries_hiring_case_id_hiring_cases_id_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD CONSTRAINT "hiring_cost_entries_lead_id_hiring_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."hiring_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD CONSTRAINT "hiring_cost_entries_campaign_id_hiring_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."hiring_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hiring_campaigns_company_idx" ON "hiring_campaigns" USING btree ("company_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "hiring_cost_entries_source_ref_key" ON "hiring_cost_entries" USING btree ("source_ref") WHERE "hiring_cost_entries"."source_ref" is not null;--> statement-breakpoint
CREATE INDEX "hiring_cost_entries_case_idx" ON "hiring_cost_entries" USING btree ("hiring_case_id");--> statement-breakpoint
CREATE INDEX "hiring_cost_entries_lead_idx" ON "hiring_cost_entries" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "hiring_cost_entries_campaign_idx" ON "hiring_cost_entries" USING btree ("campaign_id");