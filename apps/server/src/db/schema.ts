import {
  pgTable,
  pgEnum,
  text,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
  doublePrecision,
  primaryKey,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";

const id = () => text("id").primaryKey().$defaultFn(() => randomUUID());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const roleEnum = pgEnum("role", ["ADMIN", "USER"]);
export const customerTypeEnum = pgEnum("customer_type", ["COMPANY", "PERSON"]);
export const discountTypeEnum = pgEnum("discount_type", ["PERCENT", "FIXED"]);
export const discountScopeEnum = pgEnum("discount_scope", ["ALL", "CUSTOMER", "PRODUCT"]);
export const invoiceStatusEnum = pgEnum("invoice_status", ["DRAFT", "ISSUED", "PAID", "CANCELLED"]);
export const invoiceKindEnum = pgEnum("invoice_kind", ["INVOICE", "CANCELLATION"]);

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").notNull().default("USER"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const sessions = pgTable("sessions", {
  id: id(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const invites = pgTable("invites", {
  id: id(),
  tokenHash: text("token_hash").notNull().unique(),
  email: text("email").notNull(),
  role: roleEnum("role").notNull().default("USER"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

export const numberSequences = pgTable(
  "number_sequences",
  {
    key: text("key").notNull(),
    year: integer("year").notNull(),
    value: integer("value").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.year] })],
);

export const customers = pgTable(
  "customers",
  {
    id: id(),
    number: text("number").notNull().unique(),
    type: customerTypeEnum("type").notNull().default("COMPANY"),
    company: text("company"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    street: text("street"),
    zip: text("zip"),
    city: text("city"),
    country: text("country").notNull().default("DE"),
    vatId: text("vat_id"),
    leitwegId: text("leitweg_id"),
    /** Stundensatz netto in Cent, überschreibt den Standard */
    hourlyRate: integer("hourly_rate"),
    /** Geheimer Link zum Kundenportal (null = noch keiner erzeugt) */
    portalToken: text("portal_token").unique(),
    /** Standard-Firmenprofil für Rechnungen an diesen Kunden (null = Hauptfirma) */
    profileId: text("profile_id"),
    notes: text("notes"),
    archived: boolean("archived").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("customers_archived_idx").on(t.archived)],
);

export const products = pgTable("products", {
  id: id(),
  sku: text("sku").unique(),
  name: text("name").notNull(),
  description: text("description"),
  unit: text("unit").notNull().default("Stk"),
  priceNet: integer("price_net").notNull(),
  taxRate: doublePrecision("tax_rate").notNull().default(19),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const discounts = pgTable("discounts", {
  id: id(),
  name: text("name").notNull(),
  code: text("code").unique(),
  type: discountTypeEnum("type").notNull(),
  /** PERCENT: Basispunkte (1000 = 10 %), FIXED: Cent */
  value: integer("value").notNull(),
  scope: discountScopeEnum("scope").notNull().default("ALL"),
  customerId: text("customer_id").references(() => customers.id, { onDelete: "cascade" }),
  productId: text("product_id").references(() => products.id, { onDelete: "cascade" }),
  minOrderNet: integer("min_order_net"),
  validFrom: date("valid_from"),
  validTo: date("valid_to"),
  active: boolean("active").notNull().default(true),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    number: text("number").unique(),
    kind: invoiceKindEnum("kind").notNull().default("INVOICE"),
    status: invoiceStatusEnum("status").notNull().default("DRAFT"),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    customerSnapshot: jsonb("customer_snapshot"),
    companySnapshot: jsonb("company_snapshot"),
    invoiceSnapshot: jsonb("invoice_snapshot"),
    issueDate: date("issue_date"),
    serviceDateFrom: date("service_date_from"),
    serviceDateTo: date("service_date_to"),
    dueDate: date("due_date"),
    subject: text("subject"),
    introText: text("intro_text"),
    footerText: text("footer_text"),
    notes: text("notes"),
    smallBusiness: boolean("small_business").notNull().default(false),
    /** Grund für 0 % USt (Code aus den Einstellungen) und der gedruckte Pflichthinweis */
    taxExemption: text("tax_exemption"),
    taxExemptionText: text("tax_exemption_text"),
    discountId: text("discount_id").references(() => discounts.id, { onDelete: "set null" }),
    discountSnapshot: jsonb("discount_snapshot"),
    subtotalNet: integer("subtotal_net").notNull().default(0),
    discountTotal: integer("discount_total").notNull().default(0),
    totalNet: integer("total_net").notNull().default(0),
    taxTotal: integer("tax_total").notNull().default(0),
    totalGross: integer("total_gross").notNull().default(0),
    taxBreakdown: jsonb("tax_breakdown"),
    paidTotal: integer("paid_total").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    reminderCount: integer("reminder_count").notNull().default(0),
    lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
    cancelsId: text("cancels_id"),
    /** 0 = keine Mahnung, 1 = erste Mahnstufe … */
    dunningLevel: integer("dunning_level").notNull().default(0),
    /** Herkunft: Angebot bzw. Abo-Vorlage */
    quoteId: text("quote_id"),
    recurringId: text("recurring_id"),
    /** Geheimer Link zur Online-Zahlung */
    publicToken: text("public_token").unique(),
    /** Firmenprofil (Absender), null = Hauptfirma */
    profileId: text("profile_id"),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("invoices_status_idx").on(t.status),
    index("invoices_customer_idx").on(t.customerId),
    uniqueIndex("invoices_cancels_idx").on(t.cancelsId),
  ],
);

export const invoiceItems = pgTable("invoice_items", {
  id: id(),
  invoiceId: text("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  quantity: doublePrecision("quantity").notNull(),
  unit: text("unit").notNull().default("Stk"),
  unitPriceNet: integer("unit_price_net").notNull(),
  taxRate: doublePrecision("tax_rate").notNull(),
  discountBps: integer("discount_bps").notNull().default(0),
  lineNet: integer("line_net").notNull(),
});

/** Verschickte Mahnungen mit den berechneten Nebenforderungen */
export const dunnings = pgTable(
  "dunnings",
  {
    id: id(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    level: integer("level").notNull(),
    label: text("label").notNull(),
    /** offener Rechnungsbetrag zum Zeitpunkt der Mahnung */
    open: integer("open").notNull(),
    /** Mahngebühren kumuliert über alle Stufen */
    fees: integer("fees").notNull().default(0),
    interest: integer("interest").notNull().default(0),
    interestRate: doublePrecision("interest_rate"),
    interestDays: integer("interest_days"),
    flatFee: integer("flat_fee").notNull().default(0),
    claim: integer("claim").notNull(),
    payUntil: date("pay_until").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("dunnings_invoice_idx").on(t.invoiceId)],
);

// ---------- Angebote ----------
export const quoteStatusEnum = pgEnum("quote_status", ["DRAFT", "SENT", "ACCEPTED", "DECLINED", "INVOICED"]);

export const quotes = pgTable(
  "quotes",
  {
    id: id(),
    number: text("number").unique(),
    status: quoteStatusEnum("status").notNull().default("DRAFT"),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    customerSnapshot: jsonb("customer_snapshot"),
    companySnapshot: jsonb("company_snapshot"),
    invoiceSnapshot: jsonb("invoice_snapshot"),
    issueDate: date("issue_date"),
    validUntil: date("valid_until"),
    serviceDateFrom: date("service_date_from"),
    serviceDateTo: date("service_date_to"),
    subject: text("subject"),
    introText: text("intro_text"),
    footerText: text("footer_text"),
    notes: text("notes"),
    smallBusiness: boolean("small_business").notNull().default(false),
    taxExemption: text("tax_exemption"),
    taxExemptionText: text("tax_exemption_text"),
    discountId: text("discount_id").references(() => discounts.id, { onDelete: "set null" }),
    discountSnapshot: jsonb("discount_snapshot"),
    subtotalNet: integer("subtotal_net").notNull().default(0),
    discountTotal: integer("discount_total").notNull().default(0),
    totalNet: integer("total_net").notNull().default(0),
    taxTotal: integer("tax_total").notNull().default(0),
    totalGross: integer("total_gross").notNull().default(0),
    taxBreakdown: jsonb("tax_breakdown"),
    /** Geheimer Link für Ansicht und Annahme durch den Kunden */
    publicToken: text("public_token").unique(),
    profileId: text("profile_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    answeredBy: text("answered_by"),
    answerNote: text("answer_note"),
    invoiceId: text("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("quotes_status_idx").on(t.status), index("quotes_customer_idx").on(t.customerId)],
);

export const quoteItems = pgTable("quote_items", {
  id: id(),
  quoteId: text("quote_id")
    .notNull()
    .references(() => quotes.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  quantity: doublePrecision("quantity").notNull(),
  unit: text("unit").notNull().default("Stk"),
  unitPriceNet: integer("unit_price_net").notNull(),
  taxRate: doublePrecision("tax_rate").notNull(),
  discountBps: integer("discount_bps").notNull().default(0),
  lineNet: integer("line_net").notNull(),
});

// ---------- Wiederkehrende Rechnungen ----------
export const recurringIntervalEnum = pgEnum("recurring_interval", ["MONTHLY", "QUARTERLY", "HALFYEARLY", "YEARLY"]);

export const recurringInvoices = pgTable("recurring_invoices", {
  id: id(),
  name: text("name").notNull(),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  active: boolean("active").notNull().default(true),
  interval: recurringIntervalEnum("interval").notNull().default("MONTHLY"),
  /** Nächste Rechnung an diesem Tag */
  nextDate: date("next_date").notNull(),
  /** Gewünschter Tag im Monat (31 = immer Monatsletzter), damit kurze Monate nicht verschieben */
  anchorDay: integer("anchor_day").notNull().default(1),
  endDate: date("end_date"),
  /** true: ausstellen und versenden, false: nur Entwurf anlegen */
  autoIssue: boolean("auto_issue").notNull().default(true),
  /** Leistungszeitraum = abgerechneter Zeitraum */
  servicePeriod: boolean("service_period").notNull().default(true),
  subject: text("subject"),
  introText: text("intro_text"),
  notes: text("notes"),
  discountId: text("discount_id").references(() => discounts.id, { onDelete: "set null" }),
  taxExemption: text("tax_exemption"),
  items: jsonb("items").notNull(),
  runCount: integer("run_count").notNull().default(0),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastInvoiceId: text("last_invoice_id"),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const bankTxStatusEnum = pgEnum("bank_tx_status", ["UNMATCHED", "SUGGESTED", "MATCHED", "IGNORED"]);

/** Zahlungseingänge aus importierten Kontoauszügen (CAMT.053, MT940, CSV) */
export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: id(),
    /** Prüfsumme gegen doppelten Import */
    hash: text("hash").notNull().unique(),
    source: text("source").notNull(),
    bookingDate: date("booking_date").notNull(),
    valueDate: date("value_date"),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull().default("EUR"),
    counterpartyName: text("counterparty_name"),
    counterpartyIban: text("counterparty_iban"),
    purpose: text("purpose"),
    reference: text("reference"),
    status: bankTxStatusEnum("status").notNull().default("UNMATCHED"),
    /** Vorgeschlagene bzw. zugeordnete Rechnung */
    invoiceId: text("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    matchNote: text("match_note"),
    /** Zahlungsbestätigung für diese Buchung bereits verschickt (auch nach Aufheben/Neu-Zuordnen nicht erneut) */
    confirmationSentAt: timestamp("confirmation_sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("bank_tx_status_idx").on(t.status), index("bank_tx_date_idx").on(t.bookingDate)],
);

export const incomes = pgTable(
  "incomes",
  {
    id: id(),
    date: date("date").notNull(),
    amount: integer("amount").notNull(),
    method: text("method").notNull().default("Überweisung"),
    category: text("category").notNull().default("Rechnung"),
    description: text("description"),
    /** USt-Satz bei Einnahmen ohne Rechnung (bei Rechnungen wird anteilig aus der Rechnung gerechnet) */
    taxRate: doublePrecision("tax_rate"),
    invoiceId: text("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    bankTransactionId: text("bank_transaction_id").references(() => bankTransactions.id, { onDelete: "set null" }),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("incomes_date_idx").on(t.date)],
);

export const mailLogs = pgTable(
  "mail_logs",
  {
    id: id(),
    kind: text("kind").notNull(),
    to: text("to").notNull(),
    subject: text("subject").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    invoiceId: text("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("mail_logs_created_idx").on(t.createdAt)],
);

// ---------- Tickets ----------
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const ticketStatusEnum = pgEnum("ticket_status", ["OPEN", "PENDING", "CLOSED"]);
export const ticketPriorityEnum = pgEnum("ticket_priority", ["LOW", "NORMAL", "HIGH", "URGENT"]);

export const tickets = pgTable(
  "tickets",
  {
    id: id(),
    number: text("number").notNull().unique(),
    subject: text("subject").notNull(),
    status: ticketStatusEnum("status").notNull().default("OPEN"),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    contactEmail: text("contact_email").notNull(),
    contactName: text("contact_name"),
    assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
    priority: ticketPriorityEnum("priority").notNull().default("NORMAL"),
    category: text("category"),
    projectId: text("project_id"),
    unread: boolean("unread").notNull().default(true),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("tickets_status_idx").on(t.status), index("tickets_last_idx").on(t.lastMessageAt)],
);

export const ticketMessages = pgTable(
  "ticket_messages",
  {
    id: id(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    /** IN = vom Kunden, OUT = Antwort, NOTE = interne Notiz */
    direction: text("direction").notNull(),
    fromEmail: text("from_email"),
    fromName: text("from_name"),
    toEmail: text("to_email"),
    subject: text("subject"),
    body: text("body").notNull().default(""),
    messageId: text("message_id").unique(),
    inReplyTo: text("in_reply_to"),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("ticket_messages_ticket_idx").on(t.ticketId)],
);

export const ticketAttachments = pgTable("ticket_attachments", {
  id: id(),
  messageId: text("message_id")
    .notNull()
    .references(() => ticketMessages.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull().default("application/octet-stream"),
  size: integer("size").notNull(),
  data: bytea("data").notNull(),
});

/** Mails aus dem Ticket-Postfach, die der Filter aussortiert hat (Werbung, Newsletter, Spam, Abwesenheitsnotizen) */
export const inboxFiltered = pgTable(
  "inbox_filtered",
  {
    id: id(),
    messageId: text("message_id").notNull().unique(),
    fromEmail: text("from_email").notNull(),
    fromName: text("from_name"),
    subject: text("subject"),
    snippet: text("snippet"),
    reason: text("reason").notNull(),
    score: integer("score").notNull().default(0),
    status: text("status").notNull().default("FILTERED"),
    ticketId: text("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    raw: bytea("raw"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("inbox_filtered_status_idx").on(t.status)],
);

// ---------- Projekte, Zeiterfassung, Material ----------
export const projects = pgTable(
  "projects",
  {
    id: id(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Stundensatz netto in Cent, überschreibt Kunde und Standard */
    hourlyRate: integer("hourly_rate"),
    /** Budget in Minuten (optional) */
    budgetMinutes: integer("budget_minutes"),
    archived: boolean("archived").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("projects_customer_idx").on(t.customerId)],
);

export const timeEntries = pgTable(
  "time_entries",
  {
    id: id(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    ticketId: text("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    date: date("date").notNull(),
    /** Laufende Stoppuhr: startedAt gesetzt, minutes = 0, running = true */
    startedAt: timestamp("started_at", { withTimezone: true }),
    running: boolean("running").notNull().default(false),
    minutes: integer("minutes").notNull().default(0),
    description: text("description").notNull().default(""),
    billable: boolean("billable").notNull().default(true),
    /** fester Satz für diesen Eintrag (Cent/Std.), sonst Projekt → Kunde → Standard */
    hourlyRate: integer("hourly_rate"),
    invoiceId: text("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("time_customer_idx").on(t.customerId),
    index("time_ticket_idx").on(t.ticketId),
    index("time_date_idx").on(t.date),
    index("time_invoice_idx").on(t.invoiceId),
  ],
);

/** Abrechenbares Material / Pauschalen zu Kunde, Projekt oder Ticket */
export const charges = pgTable(
  "charges",
  {
    id: id(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    ticketId: text("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
    date: date("date").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    quantity: doublePrecision("quantity").notNull().default(1),
    unit: text("unit").notNull().default("Stk"),
    unitPriceNet: integer("unit_price_net").notNull(),
    taxRate: doublePrecision("tax_rate").notNull(),
    invoiceId: text("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("charges_customer_idx").on(t.customerId), index("charges_ticket_idx").on(t.ticketId)],
);

// ---------- Ausgaben ----------
export const expenses = pgTable(
  "expenses",
  {
    id: id(),
    date: date("date").notNull(),
    supplier: text("supplier").notNull(),
    description: text("description"),
    category: text("category").notNull(),
    /** Bruttobetrag in Cent */
    amountGross: integer("amount_gross").notNull(),
    taxRate: doublePrecision("tax_rate").notNull().default(19),
    /** Vorsteuer in Cent (bei Kleinunternehmern nicht abziehbar, wird trotzdem festgehalten) */
    taxAmount: integer("tax_amount").notNull().default(0),
    paymentMethod: text("payment_method").notNull().default("Überweisung"),
    invoiceNumber: text("invoice_number"),
    bankTransactionId: text("bank_transaction_id").references(() => bankTransactions.id, { onDelete: "set null" }),
    receipt: bytea("receipt"),
    receiptName: text("receipt_name"),
    receiptType: text("receipt_type"),
    notes: text("notes"),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("expenses_date_idx").on(t.date), index("expenses_category_idx").on(t.category)],
);

export const contractStatusEnum = pgEnum("contract_status", ["DRAFT", "ACTIVE", "CANCELLED", "ENDED"]);
export const noticeUnitEnum = pgEnum("notice_unit", ["DAYS", "WEEKS", "MONTHS"]);

/** Verträge mit Kunden (Wartung, Hosting, Betreuung …) – Grundlage für wiederkehrende Einnahmen */
export const contracts = pgTable(
  "contracts",
  {
    id: id(),
    number: text("number").notNull().unique(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    /** Ansprechpartner beim Kunden */
    contactPerson: text("contact_person"),
    status: contractStatusEnum("status").notNull().default("ACTIVE"),
    startDate: date("start_date").notNull(),
    /** Vertragsende (gesetzt bei befristeten oder gekündigten Verträgen) */
    endDate: date("end_date"),
    /** Mindestlaufzeit in Monaten (0 = keine) */
    minTermMonths: integer("min_term_months").notNull().default(0),
    /** Automatische Verlängerung nach Ablauf um X Monate (0 = danach jederzeit mit Frist kündbar) */
    renewalMonths: integer("renewal_months").notNull().default(0),
    noticeValue: integer("notice_value").notNull().default(1),
    noticeUnit: noticeUnitEnum("notice_unit").notNull().default("MONTHS"),
    interval: recurringIntervalEnum("interval").notNull().default("MONTHLY"),
    items: jsonb("items").notNull(),
    signedAt: date("signed_at"),
    cancelledAt: date("cancelled_at"),
    /** "CUSTOMER" oder "US" */
    cancelledBy: text("cancelled_by"),
    cancelReason: text("cancel_reason"),
    /** Verknüpfte Abo-Rechnung (automatische Abrechnung) */
    recurringId: text("recurring_id").references(() => recurringInvoices.id, { onDelete: "set null" }),
    document: bytea("document"),
    documentName: text("document_name"),
    documentType: text("document_type"),
    notes: text("notes"),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("contracts_customer_idx").on(t.customerId), index("contracts_status_idx").on(t.status)],
);

/** Online-Zahlungen (Stripe Checkout) */
export const onlinePayments = pgTable(
  "online_payments",
  {
    id: id(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("stripe"),
    sessionId: text("session_id").notNull().unique(),
    amount: integer("amount").notNull(),
    /** OPEN → PAID (oder EXPIRED) */
    status: text("status").notNull().default("OPEN"),
    method: text("method"),
    incomeId: text("income_id").references(() => incomes.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (t) => [index("online_payments_invoice_idx").on(t.invoiceId)],
);

export type User = typeof users.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Discount = typeof discounts.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type Income = typeof incomes.$inferSelect;
export type BankTransaction = typeof bankTransactions.$inferSelect;
export type Quote = typeof quotes.$inferSelect;
export type QuoteItem = typeof quoteItems.$inferSelect;
export type RecurringInvoice = typeof recurringInvoices.$inferSelect;
export type Dunning = typeof dunnings.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type TimeEntry = typeof timeEntries.$inferSelect;
export type Charge = typeof charges.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type OnlinePayment = typeof onlinePayments.$inferSelect;
export type Contract = typeof contracts.$inferSelect;
