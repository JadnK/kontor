ALTER TABLE "customers" ADD COLUMN "profile_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "profile_id" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "profile_id" text;