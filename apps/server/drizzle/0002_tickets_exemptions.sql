CREATE TYPE "public"."ticket_status" AS ENUM('OPEN', 'PENDING', 'CLOSED');--> statement-breakpoint
CREATE TABLE "inbox_filtered" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"from_email" text NOT NULL,
	"from_name" text,
	"subject" text,
	"snippet" text,
	"reason" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'FILTERED' NOT NULL,
	"ticket_id" text,
	"raw" "bytea",
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_filtered_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"direction" text NOT NULL,
	"from_email" text,
	"from_name" text,
	"to_email" text,
	"subject" text,
	"body" text DEFAULT '' NOT NULL,
	"message_id" text,
	"in_reply_to" text,
	"author_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_messages_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"subject" text NOT NULL,
	"status" "ticket_status" DEFAULT 'OPEN' NOT NULL,
	"customer_id" text,
	"contact_email" text NOT NULL,
	"contact_name" text,
	"assignee_id" text,
	"unread" boolean DEFAULT true NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_exemption" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_exemption_text" text;--> statement-breakpoint
ALTER TABLE "inbox_filtered" ADD CONSTRAINT "inbox_filtered_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_message_id_ticket_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ticket_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_filtered_status_idx" ON "inbox_filtered" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ticket_messages_ticket_idx" ON "ticket_messages" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tickets_last_idx" ON "tickets" USING btree ("last_message_at");