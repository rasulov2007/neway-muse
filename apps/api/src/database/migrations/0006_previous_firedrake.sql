CREATE TABLE "hiring_leads" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"lead_number" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"cdl_class" text,
	"state" text,
	"years_experience" numeric(4, 1),
	"source" text NOT NULL,
	"campaign_id" text,
	"recruiter_employee_id" text,
	"notes" text,
	"status" text DEFAULT 'new' NOT NULL,
	"prequalification" jsonb,
	"prequal_result" jsonb,
	"applicant_id" text,
	"hiring_case_id" text,
	"dead_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"contacted_at" timestamp with time zone,
	"prequalified_at" timestamp with time zone,
	"converted_at" timestamp with time zone,
	"dead_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hiring_leads" ADD CONSTRAINT "hiring_leads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_leads" ADD CONSTRAINT "hiring_leads_recruiter_employee_id_employees_id_fk" FOREIGN KEY ("recruiter_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_leads" ADD CONSTRAINT "hiring_leads_applicant_id_applicants_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."applicants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_leads" ADD CONSTRAINT "hiring_leads_hiring_case_id_hiring_cases_id_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hiring_leads_number_key" ON "hiring_leads" USING btree ("company_id","lead_number");--> statement-breakpoint
CREATE INDEX "hiring_leads_status_idx" ON "hiring_leads" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "hiring_leads_phone_idx" ON "hiring_leads" USING btree ("company_id","phone");