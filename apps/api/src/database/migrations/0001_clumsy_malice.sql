CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"actor_id" text,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_label" text NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "compensation_history" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"pay_type" text NOT NULL,
	"pay_rate" numeric(12, 2) NOT NULL,
	"effective_from" date NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"employee_number" text NOT NULL,
	"first_name" text NOT NULL,
	"middle_name" text,
	"last_name" text NOT NULL,
	"preferred_name" text,
	"work_email" text NOT NULL,
	"personal_email" text,
	"phone" text NOT NULL,
	"secondary_phone" text,
	"department" text NOT NULL,
	"position" text NOT NULL,
	"manager_employee_id" text,
	"location" text,
	"hire_date" date NOT NULL,
	"termination_date" date,
	"status" text NOT NULL,
	"employment_type" text NOT NULL,
	"pay_type" text,
	"pay_rate" numeric(12, 2),
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"user_id" text,
	"emergency_contact" jsonb,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "position_history" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"position" text NOT NULL,
	"department" text NOT NULL,
	"manager_employee_id" text,
	"location" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "employee_id" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_history" ADD CONSTRAINT "compensation_history_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_history" ADD CONSTRAINT "compensation_history_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_history" ADD CONSTRAINT "position_history_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_history" ADD CONSTRAINT "position_history_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("company_id","entity_type","entity_id","at");--> statement-breakpoint
CREATE INDEX "compensation_history_employee_idx" ON "compensation_history" USING btree ("employee_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_company_number_key" ON "employees" USING btree ("company_id","employee_number");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_company_work_email_key" ON "employees" USING btree ("company_id",lower("work_email"));--> statement-breakpoint
CREATE INDEX "employees_company_status_idx" ON "employees" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "employees_company_department_idx" ON "employees" USING btree ("company_id","department");--> statement-breakpoint
CREATE INDEX "employees_company_manager_idx" ON "employees" USING btree ("company_id","manager_employee_id");--> statement-breakpoint
CREATE INDEX "position_history_employee_idx" ON "position_history" USING btree ("employee_id","effective_from");--> statement-breakpoint
CREATE INDEX "drivers_company_employee_idx" ON "drivers" USING btree ("company_id","employee_id");