CREATE TABLE "applicants" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"applicant_number" text NOT NULL,
	"job_opening_id" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"position" text NOT NULL,
	"department" text NOT NULL,
	"location" text,
	"source" text,
	"stage" text NOT NULL,
	"closed_reason" text,
	"assigned_recruiter_employee_id" text,
	"driver_type" text,
	"applied_on" date NOT NULL,
	"hired_employee_id" text,
	"hired_on" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"entry_date" date NOT NULL,
	"check_in_at" timestamp with time zone,
	"check_out_at" timestamp with time zone,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"exception" text,
	"exception_resolved_at" timestamp with time zone,
	"exception_note" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"approved_by_employee_id" text,
	"approved_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"applicant_id" text NOT NULL,
	"kind" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"interviewer_employee_id" text,
	"location" text,
	"status" text NOT NULL,
	"score" integer,
	"recommendation" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_openings" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"job_number" text NOT NULL,
	"title" text NOT NULL,
	"department" text NOT NULL,
	"location" text,
	"employment_type" text NOT NULL,
	"hiring_manager_employee_id" text,
	"open_date" date NOT NULL,
	"target_hire_date" date,
	"positions_count" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"offer_number" text NOT NULL,
	"applicant_id" text NOT NULL,
	"position" text NOT NULL,
	"department" text NOT NULL,
	"employment_type" text NOT NULL,
	"pay_type" text,
	"pay_rate" numeric(12, 2),
	"start_date" date NOT NULL,
	"expires_on" date,
	"status" text NOT NULL,
	"notes" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_checklists" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"template_id" text,
	"owner_employee_id" text,
	"start_date" date NOT NULL,
	"due_date" date,
	"status" text NOT NULL,
	"completed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_items" (
	"id" text PRIMARY KEY NOT NULL,
	"checklist_id" text NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"owner_employee_id" text,
	"due_date" date,
	"status" text NOT NULL,
	"completed_by_employee_id" text,
	"completed_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "onboarding_template_items" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"due_offset_days" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"position" text,
	"department" text,
	"employment_type" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performance_action_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"owner_employee_id" text,
	"issue" text NOT NULL,
	"expected_outcome" text NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"start_date" date NOT NULL,
	"due_date" date NOT NULL,
	"review_date" date,
	"status" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performance_cycles" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"reviews_due_on" date,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performance_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"author_employee_id" text,
	"author_name" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"goal_id" text,
	"visibility" text DEFAULT 'manager_only' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performance_goals" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"cycle_id" text,
	"title" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"measure" text NOT NULL,
	"target_value" numeric(14, 2),
	"current_value" numeric(14, 2),
	"unit" text,
	"start_date" date NOT NULL,
	"due_date" date NOT NULL,
	"status" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performance_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"reviewer_employee_id" text,
	"cycle_id" text,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"rating" integer,
	"summary" text,
	"strengths" text,
	"development_areas" text,
	"manager_feedback" text,
	"employee_comments" text,
	"status" text NOT NULL,
	"submitted_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pto_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"accrual_hours_per_period" numeric(8, 2) DEFAULT '0' NOT NULL,
	"period" text DEFAULT 'monthly' NOT NULL,
	"max_balance_hours" numeric(8, 2),
	"carryover_hours" numeric(8, 2),
	"allows_negative_balance" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pto_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"request_number" text NOT NULL,
	"employee_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"hours" numeric(8, 2) NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"notes" text,
	"approver_employee_id" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pto_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"kind" text NOT NULL,
	"hours" numeric(8, 2) NOT NULL,
	"effective_on" date NOT NULL,
	"request_id" text,
	"reason" text,
	"actor_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applicants" ADD CONSTRAINT "applicants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applicants" ADD CONSTRAINT "applicants_job_opening_id_job_openings_id_fk" FOREIGN KEY ("job_opening_id") REFERENCES "public"."job_openings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applicants" ADD CONSTRAINT "applicants_assigned_recruiter_employee_id_employees_id_fk" FOREIGN KEY ("assigned_recruiter_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applicants" ADD CONSTRAINT "applicants_hired_employee_id_employees_id_fk" FOREIGN KEY ("hired_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_entries" ADD CONSTRAINT "attendance_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_entries" ADD CONSTRAINT "attendance_entries_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_entries" ADD CONSTRAINT "attendance_entries_approved_by_employee_id_employees_id_fk" FOREIGN KEY ("approved_by_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_applicant_id_applicants_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."applicants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_interviewer_employee_id_employees_id_fk" FOREIGN KEY ("interviewer_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_hiring_manager_employee_id_employees_id_fk" FOREIGN KEY ("hiring_manager_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_applicant_id_applicants_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."applicants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_checklists" ADD CONSTRAINT "onboarding_checklists_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_checklists" ADD CONSTRAINT "onboarding_checklists_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_checklists" ADD CONSTRAINT "onboarding_checklists_template_id_onboarding_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."onboarding_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_checklists" ADD CONSTRAINT "onboarding_checklists_owner_employee_id_employees_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_items" ADD CONSTRAINT "onboarding_items_checklist_id_onboarding_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."onboarding_checklists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_items" ADD CONSTRAINT "onboarding_items_owner_employee_id_employees_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_items" ADD CONSTRAINT "onboarding_items_completed_by_employee_id_employees_id_fk" FOREIGN KEY ("completed_by_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_template_items" ADD CONSTRAINT "onboarding_template_items_template_id_onboarding_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."onboarding_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_templates" ADD CONSTRAINT "onboarding_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_action_plans" ADD CONSTRAINT "performance_action_plans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_action_plans" ADD CONSTRAINT "performance_action_plans_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_action_plans" ADD CONSTRAINT "performance_action_plans_owner_employee_id_employees_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_cycles" ADD CONSTRAINT "performance_cycles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_feedback" ADD CONSTRAINT "performance_feedback_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_feedback" ADD CONSTRAINT "performance_feedback_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_feedback" ADD CONSTRAINT "performance_feedback_author_employee_id_employees_id_fk" FOREIGN KEY ("author_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_feedback" ADD CONSTRAINT "performance_feedback_goal_id_performance_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."performance_goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_goals" ADD CONSTRAINT "performance_goals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_goals" ADD CONSTRAINT "performance_goals_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_goals" ADD CONSTRAINT "performance_goals_cycle_id_performance_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."performance_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_reviewer_employee_id_employees_id_fk" FOREIGN KEY ("reviewer_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_cycle_id_performance_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."performance_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pto_policies" ADD CONSTRAINT "pto_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pto_requests" ADD CONSTRAINT "pto_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pto_requests" ADD CONSTRAINT "pto_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pto_requests" ADD CONSTRAINT "pto_requests_policy_id_pto_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."pto_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pto_requests" ADD CONSTRAINT "pto_requests_approver_employee_id_employees_id_fk" FOREIGN KEY ("approver_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pto_transactions" ADD CONSTRAINT "pto_transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pto_transactions" ADD CONSTRAINT "pto_transactions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pto_transactions" ADD CONSTRAINT "pto_transactions_policy_id_pto_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."pto_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pto_transactions" ADD CONSTRAINT "pto_transactions_request_id_pto_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."pto_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "applicants_company_number_key" ON "applicants" USING btree ("company_id","applicant_number");--> statement-breakpoint
CREATE UNIQUE INDEX "applicants_company_email_key" ON "applicants" USING btree ("company_id",lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "applicants_hired_employee_key" ON "applicants" USING btree ("hired_employee_id") WHERE "applicants"."hired_employee_id" is not null;--> statement-breakpoint
CREATE INDEX "applicants_company_stage_idx" ON "applicants" USING btree ("company_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_employee_date_key" ON "attendance_entries" USING btree ("employee_id","entry_date");--> statement-breakpoint
CREATE INDEX "attendance_company_date_idx" ON "attendance_entries" USING btree ("company_id","entry_date");--> statement-breakpoint
CREATE INDEX "attendance_company_exception_idx" ON "attendance_entries" USING btree ("company_id","exception");--> statement-breakpoint
CREATE INDEX "interviews_applicant_idx" ON "interviews" USING btree ("applicant_id","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_openings_company_number_key" ON "job_openings" USING btree ("company_id","job_number");--> statement-breakpoint
CREATE INDEX "job_openings_company_status_idx" ON "job_openings" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_company_number_key" ON "offers" USING btree ("company_id","offer_number");--> statement-breakpoint
CREATE INDEX "offers_applicant_idx" ON "offers" USING btree ("applicant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_checklists_employee_open_key" ON "onboarding_checklists" USING btree ("employee_id") WHERE "onboarding_checklists"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "onboarding_checklists_company_status_idx" ON "onboarding_checklists" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "onboarding_items_checklist_idx" ON "onboarding_items" USING btree ("checklist_id","sort_order");--> statement-breakpoint
CREATE INDEX "onboarding_template_items_template_idx" ON "onboarding_template_items" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "onboarding_templates_company_idx" ON "onboarding_templates" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "performance_action_plans_employee_idx" ON "performance_action_plans" USING btree ("employee_id","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "performance_cycles_company_name_key" ON "performance_cycles" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "performance_feedback_employee_idx" ON "performance_feedback" USING btree ("employee_id","at");--> statement-breakpoint
CREATE INDEX "performance_goals_employee_idx" ON "performance_goals" USING btree ("employee_id","due_date");--> statement-breakpoint
CREATE INDEX "performance_goals_company_status_idx" ON "performance_goals" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "performance_reviews_employee_idx" ON "performance_reviews" USING btree ("employee_id","period_end");--> statement-breakpoint
CREATE INDEX "performance_reviews_company_status_idx" ON "performance_reviews" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pto_policies_company_name_key" ON "pto_policies" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "pto_requests_company_number_key" ON "pto_requests" USING btree ("company_id","request_number");--> statement-breakpoint
CREATE INDEX "pto_requests_employee_idx" ON "pto_requests" USING btree ("employee_id","starts_on");--> statement-breakpoint
CREATE INDEX "pto_requests_company_status_idx" ON "pto_requests" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "pto_transactions_employee_idx" ON "pto_transactions" USING btree ("employee_id","policy_id","effective_on");--> statement-breakpoint
CREATE UNIQUE INDEX "pto_transactions_request_usage_key" ON "pto_transactions" USING btree ("request_id") WHERE "pto_transactions"."kind" = 'usage' and "pto_transactions"."request_id" is not null;