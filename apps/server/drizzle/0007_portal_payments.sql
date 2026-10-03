CREATE TABLE "online_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"session_id" text NOT NULL,
	"amount" integer NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"method" text,
	"income_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "online_payments_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "portal_token" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "public_token" text;--> statement-breakpoint
ALTER TABLE "online_payments" ADD CONSTRAINT "online_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_payments" ADD CONSTRAINT "online_payments_income_id_incomes_id_fk" FOREIGN KEY ("income_id") REFERENCES "public"."incomes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "online_payments_invoice_idx" ON "online_payments" USING btree ("invoice_id");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_portal_token_unique" UNIQUE("portal_token");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_public_token_unique" UNIQUE("public_token");