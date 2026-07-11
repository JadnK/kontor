CREATE TYPE "public"."bank_tx_status" AS ENUM('UNMATCHED', 'SUGGESTED', 'MATCHED', 'IGNORED');--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"source" text NOT NULL,
	"booking_date" date NOT NULL,
	"value_date" date,
	"amount" integer NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"counterparty_name" text,
	"counterparty_iban" text,
	"purpose" text,
	"reference" text,
	"status" "bank_tx_status" DEFAULT 'UNMATCHED' NOT NULL,
	"invoice_id" text,
	"match_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transactions_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
ALTER TABLE "incomes" ADD COLUMN "bank_transaction_id" text;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_tx_status_idx" ON "bank_transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bank_tx_date_idx" ON "bank_transactions" USING btree ("booking_date");--> statement-breakpoint
ALTER TABLE "incomes" ADD CONSTRAINT "incomes_bank_transaction_id_bank_transactions_id_fk" FOREIGN KEY ("bank_transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE set null ON UPDATE no action;