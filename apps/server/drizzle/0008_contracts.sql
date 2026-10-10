CREATE TYPE "public"."contract_status" AS ENUM('DRAFT', 'ACTIVE', 'CANCELLED', 'ENDED');--> statement-breakpoint
CREATE TYPE "public"."notice_unit" AS ENUM('DAYS', 'WEEKS', 'MONTHS');--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"customer_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"contact_person" text,
	"status" "contract_status" DEFAULT 'ACTIVE' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"min_term_months" integer DEFAULT 0 NOT NULL,
	"renewal_months" integer DEFAULT 0 NOT NULL,
	"notice_value" integer DEFAULT 1 NOT NULL,
	"notice_unit" "notice_unit" DEFAULT 'MONTHS' NOT NULL,
	"interval" "recurring_interval" DEFAULT 'MONTHLY' NOT NULL,
	"items" jsonb NOT NULL,
	"signed_at" date,
	"cancelled_at" date,
	"cancelled_by" text,
	"cancel_reason" text,
	"recurring_id" text,
	"document" "bytea",
	"document_name" text,
	"document_type" text,
	"notes" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contracts_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_recurring_id_recurring_invoices_id_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."recurring_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contracts_customer_idx" ON "contracts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "contracts_status_idx" ON "contracts" USING btree ("status");