CREATE TABLE "hiring_dot_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"hiring_case_id" text NOT NULL,
	"applicant_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"form" jsonb NOT NULL,
	"ssn_sealed" jsonb,
	"ssn_last4" text,
	"document_id" text,
	"consent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "hiring_dot_applications" ADD CONSTRAINT "hiring_dot_applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_dot_applications" ADD CONSTRAINT "hiring_dot_applications_hiring_case_id_hiring_cases_id_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_dot_applications" ADD CONSTRAINT "hiring_dot_applications_applicant_id_applicants_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."applicants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hiring_dot_applications_case_key" ON "hiring_dot_applications" USING btree ("hiring_case_id");