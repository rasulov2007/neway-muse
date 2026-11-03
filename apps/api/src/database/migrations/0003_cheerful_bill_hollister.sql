CREATE TABLE "saved_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"report_key" text NOT NULL,
	"config" jsonb NOT NULL,
	"owner_user_id" text,
	"owner_name" text NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_reports_company_name_key" ON "saved_reports" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "saved_reports_company_report_idx" ON "saved_reports" USING btree ("company_id","report_key");