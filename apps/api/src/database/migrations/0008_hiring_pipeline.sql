CREATE TABLE "hiring_orientations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"hiring_case_id" text NOT NULL,
	"start_date" date NOT NULL,
	"days" integer NOT NULL,
	"per_day_pay" numeric(10, 2),
	"attendance" text DEFAULT 'scheduled' NOT NULL,
	"road_test" jsonb,
	"road_test_document_id" text,
	"completed_on" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hiring_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"hiring_case_id" text NOT NULL,
	"travel_mode" text NOT NULL,
	"carrier" text,
	"booking_reference" text,
	"depart_at" timestamp with time zone NOT NULL,
	"arrive_at" timestamp with time zone,
	"travel_cost" numeric(12, 2),
	"lodging_nights" integer DEFAULT 0 NOT NULL,
	"lodging_cost" numeric(12, 2),
	"booked_by_id" text,
	"booked_by_name" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "hiring_case_id" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "driver_type" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "pay_plan_kind" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "pay_plan_rate" numeric(8, 4);--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "sign_on_bonus" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "referral_bonus" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "referring_driver_id" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "orientation_date" date;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN "offer_id" text;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN "employee_id" text;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN "hired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN "first_dispatch_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_orientations" ADD CONSTRAINT "hiring_orientations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_orientations" ADD CONSTRAINT "hiring_orientations_hiring_case_id_hiring_cases_id_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_tickets" ADD CONSTRAINT "hiring_tickets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_tickets" ADD CONSTRAINT "hiring_tickets_hiring_case_id_hiring_cases_id_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hiring_orientations_case_key" ON "hiring_orientations" USING btree ("hiring_case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hiring_tickets_case_key" ON "hiring_tickets" USING btree ("hiring_case_id");--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD CONSTRAINT "hiring_cases_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;