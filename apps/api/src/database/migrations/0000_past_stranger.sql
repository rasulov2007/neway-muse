CREATE TABLE "companies" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"week_start" text DEFAULT 'monday' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"driver_number" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text NOT NULL,
	"driver_type" text NOT NULL,
	"cdl_state" text NOT NULL,
	"cdl_class" text NOT NULL,
	"cdl_endorsements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cdl_expires_on" date NOT NULL,
	"cdl_status" text NOT NULL,
	"medical_card_expires_on" date NOT NULL,
	"medical_card_status" text NOT NULL,
	"hire_date" date NOT NULL,
	"status" text NOT NULL,
	"dispatcher_id" text NOT NULL,
	"dispatcher_name" text NOT NULL,
	"current_truck_id" text,
	"current_trailer_id" text,
	"home_city" text NOT NULL,
	"home_state" text NOT NULL,
	"safety_score" numeric(5, 1) DEFAULT '100' NOT NULL,
	"safety_events_30d" integer DEFAULT 0 NOT NULL,
	"pay_plan_kind" text NOT NULL,
	"pay_plan_rate" numeric(8, 4) NOT NULL,
	"preferred_language" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trucks" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"unit_number" text NOT NULL,
	"vin" text NOT NULL,
	"year" integer NOT NULL,
	"make" text NOT NULL,
	"model" text NOT NULL,
	"plate" text NOT NULL,
	"plate_state" text NOT NULL,
	"color" text NOT NULL,
	"status" text NOT NULL,
	"health" text NOT NULL,
	"ownership" text NOT NULL,
	"odometer" integer NOT NULL,
	"odometer_at" timestamp with time zone NOT NULL,
	"engine_hours" numeric(10, 1) NOT NULL,
	"in_service_date" date NOT NULL,
	"current_driver_id" text,
	"current_trailer_id" text,
	"current_load_id" text,
	"location" jsonb,
	"next_service_odometer" integer NOT NULL,
	"next_service_date" date NOT NULL,
	"next_service_type" text NOT NULL,
	"telematics_provider" text NOT NULL,
	"telematics_status" text NOT NULL,
	"mpg_30d" numeric(5, 2) DEFAULT '0' NOT NULL,
	"mpg_90d" numeric(5, 2) DEFAULT '0' NOT NULL,
	"idle_percent_30d" numeric(5, 2) DEFAULT '0' NOT NULL,
	"idle_percent_90d" numeric(5, 2) DEFAULT '0' NOT NULL,
	"home_terminal" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drivers_company_number_key" ON "drivers" USING btree ("company_id","driver_number");--> statement-breakpoint
CREATE UNIQUE INDEX "drivers_company_email_key" ON "drivers" USING btree ("company_id",lower("email"));--> statement-breakpoint
CREATE INDEX "drivers_company_status_idx" ON "drivers" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "drivers_company_truck_idx" ON "drivers" USING btree ("company_id","current_truck_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trucks_company_unit_number_key" ON "trucks" USING btree ("company_id","unit_number");--> statement-breakpoint
CREATE UNIQUE INDEX "trucks_company_vin_key" ON "trucks" USING btree ("company_id",upper("vin"));--> statement-breakpoint
CREATE INDEX "trucks_company_status_idx" ON "trucks" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "trucks_company_driver_idx" ON "trucks" USING btree ("company_id","current_driver_id");