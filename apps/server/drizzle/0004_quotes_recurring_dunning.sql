CREATE TYPE "public"."quote_status" AS ENUM('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'INVOICED');--> statement-breakpoint
CREATE TYPE "public"."recurring_interval" AS ENUM('MONTHLY', 'QUARTERLY', 'HALFYEARLY', 'YEARLY');--> statement-breakpoint
CREATE TABLE "dunnings" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"level" integer NOT NULL,
	"label" text NOT NULL,
	"open" integer NOT NULL,
	"fees" integer DEFAULT 0 NOT NULL,
	"interest" integer DEFAULT 0 NOT NULL,
	"interest_rate" double precision,
	"interest_days" integer,
	"flat_fee" integer DEFAULT 0 NOT NULL,
	"claim" integer NOT NULL,
	"pay_until" date NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_items" (
	"id" text PRIMARY KEY NOT NULL,
	"quote_id" text NOT NULL,
	"position" integer NOT NULL,
	"product_id" text,
	"name" text NOT NULL,
	"description" text,
	"quantity" double precision NOT NULL,
	"unit" text DEFAULT 'Stk' NOT NULL,
	"unit_price_net" integer NOT NULL,
	"tax_rate" double precision NOT NULL,
	"discount_bps" integer DEFAULT 0 NOT NULL,
	"line_net" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text,
	"status" "quote_status" DEFAULT 'DRAFT' NOT NULL,
	"customer_id" text NOT NULL,
	"customer_snapshot" jsonb,
	"company_snapshot" jsonb,
	"invoice_snapshot" jsonb,
	"issue_date" date,
	"valid_until" date,
	"service_date_from" date,
	"service_date_to" date,
	"subject" text,
	"intro_text" text,
	"footer_text" text,
	"notes" text,
	"small_business" boolean DEFAULT false NOT NULL,
	"tax_exemption" text,
	"tax_exemption_text" text,
	"discount_id" text,
	"discount_snapshot" jsonb,
	"subtotal_net" integer DEFAULT 0 NOT NULL,
	"discount_total" integer DEFAULT 0 NOT NULL,
	"total_net" integer DEFAULT 0 NOT NULL,
	"tax_total" integer DEFAULT 0 NOT NULL,
	"total_gross" integer DEFAULT 0 NOT NULL,
	"tax_breakdown" jsonb,
	"public_token" text,
	"sent_at" timestamp with time zone,
	"viewed_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"answered_by" text,
	"answer_note" text,
	"invoice_id" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_number_unique" UNIQUE("number"),
	CONSTRAINT "quotes_public_token_unique" UNIQUE("public_token")
);
--> statement-breakpoint
CREATE TABLE "recurring_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"customer_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"interval" "recurring_interval" DEFAULT 'MONTHLY' NOT NULL,
	"next_date" date NOT NULL,
	"end_date" date,
	"auto_issue" boolean DEFAULT true NOT NULL,
	"service_period" boolean DEFAULT true NOT NULL,
	"subject" text,
	"intro_text" text,
	"notes" text,
	"discount_id" text,
	"tax_exemption" text,
	"items" jsonb NOT NULL,
	"run_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_invoice_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "dunning_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "quote_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "recurring_id" text;--> statement-breakpoint
ALTER TABLE "dunnings" ADD CONSTRAINT "dunnings_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_discount_id_discounts_id_fk" FOREIGN KEY ("discount_id") REFERENCES "public"."discounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_discount_id_discounts_id_fk" FOREIGN KEY ("discount_id") REFERENCES "public"."discounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dunnings_invoice_idx" ON "dunnings" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "quotes_status_idx" ON "quotes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "quotes_customer_idx" ON "quotes" USING btree ("customer_id");