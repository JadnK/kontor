export type Role = "ADMIN" | "USER";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  active?: boolean;
}

export interface Customer {
  id: string;
  number: string;
  type: "COMPANY" | "PERSON";
  company: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  street: string | null;
  zip: string | null;
  city: string | null;
  country: string;
  vatId: string | null;
  leitwegId: string | null;
  hourlyRate?: number | null;
  profileId?: string | null;
  notes: string | null;
  archived: boolean;
  revenue?: number;
  open?: number;
}

export interface Product {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  unit: string;
  priceNet: number;
  taxRate: number;
  active: boolean;
}

export interface Discount {
  id: string;
  name: string;
  code: string | null;
  type: "PERCENT" | "FIXED";
  value: number;
  scope: "ALL" | "CUSTOMER" | "PRODUCT";
  customerId: string | null;
  productId: string | null;
  minOrderNet: number | null;
  validFrom: string | null;
  validTo: string | null;
  active: boolean;
  notifiedAt: string | null;
  customerName?: string | null;
  productName?: string | null;
}

export type InvoiceStatus = "DRAFT" | "ISSUED" | "PAID" | "CANCELLED";

export interface InvoiceListRow {
  id: string;
  number: string | null;
  kind: "INVOICE" | "CANCELLATION";
  status: InvoiceStatus;
  issueDate: string | null;
  dueDate: string | null;
  subject: string | null;
  totalGross: number;
  paidTotal: number;
  sentAt: string | null;
  reminderCount: number;
  customerId: string;
  customerName: string;
  overdue: boolean;
}

export interface InvoiceItem {
  id?: string;
  productId: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unitPriceNet: number;
  taxRate: number;
  discountBps: number;
  lineNet?: number;
}

export interface Income {
  id: string;
  date: string;
  amount: number;
  method: string;
  category: string;
  description: string | null;
  invoiceId: string | null;
  customerId: string | null;
  invoiceNumber?: string | null;
  customerName?: string | null;
}

export interface MailLog {
  id: string;
  kind: string;
  to: string;
  subject: string;
  status: "SENT" | "FAILED";
  error: string | null;
  createdAt: string;
}

export interface InvoiceFull {
  id: string;
  profileId?: string | null;
  number: string | null;
  kind: "INVOICE" | "CANCELLATION";
  status: InvoiceStatus;
  customerId: string;
  issueDate: string | null;
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  dueDate: string | null;
  subject: string | null;
  introText: string | null;
  footerText: string | null;
  notes: string | null;
  smallBusiness: boolean;
  discountId: string | null;
  discountSnapshot: { name: string; type: "PERCENT" | "FIXED"; value: number; code: string | null } | null;
  subtotalNet: number;
  discountTotal: number;
  totalNet: number;
  taxTotal: number;
  totalGross: number;
  taxBreakdown: { rate: number; net: number; tax: number }[] | null;
  paidTotal: number;
  sentAt: string | null;
  reminderCount: number;
  lastReminderAt: string | null;
  items: InvoiceItem[];
  customer: Pick<Customer, "number" | "type" | "company" | "firstName" | "lastName" | "email" | "street" | "zip" | "city" | "country" | "vatId" | "leitwegId">;
  original: { id: string; number: string | null; issueDate: string | null } | null;
  cancelledBy: { id: string; number: string | null } | null;
  payments: Income[];
  mails: MailLog[];
  xrechnungIssues: string[];
  taxExemption: string | null;
  exemption: { code: string; text: string; category: string } | null;
  dunnings: DunningRow[];
  nextDunning: DunningInfo | null;
  dunningLevel: number;
  quoteId: string | null;
  recurringId: string | null;
}

export interface Settings {
  company: {
    name: string;
    owner: string;
    addressAddition: string;
    street: string;
    zip: string;
    city: string;
    country: string;
    email: string;
    phone: string;
    website: string;
    taxNumber: string;
    vatId: string;
    registerCourt: string;
    registerNumber: string;
    bankName: string;
    iban: string;
    bic: string;
    logo: string;
  };
  invoice: {
    numberFormat: string;
    cancellationNumberFormat: string;
    customerNumberFormat: string;
    currency: string;
    paymentDays: number;
    defaultTaxRate: number;
    taxRates: number[];
    smallBusiness: boolean;
    smallBusinessText: string;
    taxExemptions: Exemption[];
    defaultExemption: string;
    legalNotes: string[];
    introText: string;
    paymentText: string;
    closingText: string;
    showServiceDate: boolean;
    attachXRechnung: boolean;
    zugferd: boolean;
    design: "classic" | "modern" | "minimal";
    accentColor: string;
    showGiroCode: boolean;
  };
  mail: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    hasPassword?: boolean;
    fromName: string;
    fromAddress: string;
    replyTo: string;
    bcc: string;
  };
  automation: {
    sendInvoiceOnIssue: boolean;
    sendPaymentConfirmation: boolean;
    sendReminders: boolean;
    reminderAfterDays: number;
    reminderRepeatDays: number;
    maxReminders: number;
    sendDiscountNotice: boolean;
    sendWelcome: boolean;
    dunningAuto: boolean;
    dunningSteps: DunningStep[];
    baseRate: number;
    b2bFlatFee: boolean;
    dunningPayDays: number;
  };
  templates: Record<
    "invoice" | "payment" | "partialPayment" | "reminder" | "dunning" | "cancellation" | "quote" | "discount" | "welcome" | "portal",
    { subject: string; body: string }
  >;
  bank: {
    autoBook: boolean;
    syncEnabled: boolean;
    ebAppId: string;
    ebPrivateKey: string;
    hasEbPrivateKey?: boolean;
    syncMinutes: number;
    renewReminderDays: number;
  };
  tickets: TicketSettings;
  time: {
    defaultHourlyRate: number;
    roundingMinutes: number;
    rounding: "up" | "nearest" | "none";
    grouping: "entry" | "group" | "day";
    unit: string;
    taxRate: number;
  };
  expenses: {
    categories: ExpenseCategory[];
    autoBookKnown: boolean;
    supplierCategories: Record<string, string>;
  };
  datev: {
    consultantNumber: string;
    clientNumber: string;
    chart: "SKR03" | "SKR04";
    accountLength: number;
    bankAccount: string;
    revenue19: string;
    revenue7: string;
    revenue0: string;
    revenueSmall: string;
  };
  profiles: { list: CompanyProfile[] };
  contracts: {
    numberFormat: string;
    remindDays: number;
    remindByMail: boolean;
  };
  portal: {
    enabled: boolean;
    showInvoices: boolean;
    showQuotes: boolean;
    showTickets: boolean;
    introText: string;
  };
  webform: {
    enabled: boolean;
    title: string;
    introText: string;
    successText: string;
    onlyCustomers: boolean;
    nonCustomerText: string;
    askPhone: boolean;
    askCategory: boolean;
    allowFiles: boolean;
    allowedOrigins: string[];
  };
  payments: {
    stripeEnabled: boolean;
    stripeSecretKey: string;
    stripeWebhookSecret: string;
    hasStripeSecretKey?: boolean;
    hasStripeWebhookSecret?: boolean;
    paypalMe: string;
    linkInMails: boolean;
    linkOnPdf: boolean;
    ignorePayouts: boolean;
  };
  quotes: {
    numberFormat: string;
    validDays: number;
    introText: string;
    footerText: string;
    notifyOnAnswer: boolean;
    draftOnAccept: boolean;
  };
}

export interface DunningStep {
  label: string;
  days: number;
  fee: number;
  interest: boolean;
}

export interface DunningInfo {
  label: string;
  level: number;
  date: string;
  open: number;
  fees: number;
  interest: number;
  interestRate: number | null;
  interestDays: number | null;
  flatFee: number;
  claim: number;
  payUntil: string;
}

export interface DunningRow extends DunningInfo {
  id: string;
  sentAt: string | null;
  createdAt: string;
}

export type QuoteStatus = "DRAFT" | "SENT" | "ACCEPTED" | "DECLINED" | "INVOICED";

export interface QuoteListRow {
  id: string;
  number: string | null;
  status: QuoteStatus;
  issueDate: string | null;
  validUntil: string | null;
  subject: string | null;
  totalGross: number;
  sentAt: string | null;
  viewedAt: string | null;
  answeredAt: string | null;
  invoiceId: string | null;
  customerId: string;
  customerName: string;
  expired: boolean;
}

export interface QuoteFull extends Omit<InvoiceFull, "status" | "kind" | "dueDate" | "paidTotal" | "reminderCount" | "lastReminderAt" | "original" | "cancelledBy" | "payments" | "xrechnungIssues" | "dunnings" | "nextDunning" | "dunningLevel" | "quoteId" | "recurringId"> {
  status: QuoteStatus;
  validUntil: string | null;
  viewedAt: string | null;
  answeredAt: string | null;
  answeredBy: string | null;
  answerNote: string | null;
  expired: boolean;
  publicUrl: string | null;
  invoice: { id: string; number: string | null; status: InvoiceStatus } | null;
}

export type RecurringInterval = "MONTHLY" | "QUARTERLY" | "HALFYEARLY" | "YEARLY";

export interface Recurring {
  id: string;
  name: string;
  customerId: string;
  active: boolean;
  interval: RecurringInterval;
  nextDate: string;
  endDate: string | null;
  autoIssue: boolean;
  servicePeriod: boolean;
  subject: string | null;
  introText: string | null;
  notes: string | null;
  discountId: string | null;
  taxExemption: string | null;
  items: InvoiceItem[];
  runCount: number;
  lastRunAt: string | null;
  lastInvoiceId: string | null;
  lastError: string | null;
  nextPeriod: string;
  customerName?: string;
  totalNet?: number;
  totalGross?: number;
  invoices?: { id: string; number: string | null; status: InvoiceStatus; issueDate: string | null; totalGross: number; serviceDateFrom: string | null; serviceDateTo: string | null }[];
}

export interface Exemption {
  code: string;
  label: string;
  text: string;
  category: "E" | "AE" | "K" | "G" | "Z";
}

export interface TicketSettings {
  enabled: boolean;
  address: string;
  fromName: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string;
  imapPassword: string;
  hasImapPassword?: boolean;
  folder: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  hasSmtpPassword?: boolean;
  pollMinutes: number;
  since: string | null;
  numberFormat: string;
  filterLevel: "low" | "normal" | "strict";
  onlyKnownCustomers: boolean;
  allowSenders: string[];
  blockSenders: string[];
  autoReply: boolean;
  autoReplySubject: string;
  autoReplyBody: string;
  signature: string;
  allowCustomerDomain: boolean;
  nonCustomerAction: "filter" | "reject";
  rejectSubject: string;
  rejectBody: string;
  notifyTeam: boolean;
  notifyAddress: string;
  autoAssignUserId: string;
  categories: string[];
  defaultPriority: TicketPriority;
  autoCloseDays: number;
  autoCloseNotify: boolean;
  autoCloseBody: string;
  reopenOnReply: boolean;
  reopenMaxDays: number;
  allowAttachments: boolean;
  maxAttachmentMb: number;
  portalTickets: boolean;
}

export type TicketPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

export type TicketStatus = "OPEN" | "PENDING" | "CLOSED";

export interface TicketRow {
  id: string;
  number: string;
  subject: string;
  status: TicketStatus;
  customerId: string | null;
  customerName: string | null;
  contactEmail: string;
  contactName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  priority: TicketPriority;
  category: string | null;
  projectId: string | null;
  unread: boolean;
  lastMessageAt: string;
  createdAt: string;
  messageCount: number;
  snippet: string | null;
  lastDirection: "IN" | "OUT" | null;
}

export interface TicketAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface TicketMessage {
  id: string;
  direction: "IN" | "OUT" | "NOTE";
  fromEmail: string | null;
  fromName: string | null;
  toEmail: string | null;
  subject: string | null;
  body: string;
  authorName: string | null;
  createdAt: string;
  attachments: TicketAttachment[];
}

export interface TicketFull extends Omit<TicketRow, "customerName" | "assigneeName" | "messageCount" | "snippet" | "lastDirection"> {
  customer: Customer | null;
  users: { id: string; name: string }[];
  messages: TicketMessage[];
  time: TimeEntry[];
  charges: Charge[];
  projects: { id: string; name: string }[];
}

export interface FilteredMail {
  id: string;
  fromEmail: string;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
  reason: string;
  score: number;
  receivedAt: string;
}

export interface BankTx {
  id: string;
  source: string;
  bookingDate: string;
  amount: number;
  currency: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  purpose: string | null;
  reference: string | null;
  status: "UNMATCHED" | "SUGGESTED" | "MATCHED" | "IGNORED";
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceOpen: number | null;
  invoiceCustomer: string | null;
  matchNote: string | null;
}

export interface MailResult {
  ok: boolean;
  skipped?: string;
  error?: string;
}

export interface BankSyncAccount {
  uid: string;
  iban: string | null;
  name: string | null;
  currency: string | null;
  enabled: boolean;
}

export interface BankSyncStatus {
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  bank: { name: string; country: string } | null;
  accounts: BankSyncAccount[];
  validUntil: string | null;
  daysLeft: number | null;
  connectedAt: string | null;
  syncFrom: string | null;
  lastSyncAt: string | null;
  lastResult: { fetched: number; imported: number; matched: number; suggested: number; unmatched: number; alreadyBooked?: number } | null;
  lastError: string | null;
  redirectUrl: string;
  running: boolean;
}

export interface BankInfo {
  name: string;
  country: string;
  logo: string | null;
  psuTypes: string[];
  maxDays: number;
  beta: boolean;
}

export interface ExpenseCategory {
  name: string;
  skr03: string;
  skr04: string;
  deductible: number;
}

export interface Project {
  id: string;
  customerId: string;
  customerName?: string;
  name: string;
  hourlyRate: number | null;
  budgetMinutes: number | null;
  archived: boolean;
  minutes?: number;
}

export interface TimeEntry {
  id: string;
  userId: string | null;
  userName?: string | null;
  customerId: string;
  customerName?: string;
  projectId: string | null;
  projectName?: string | null;
  ticketId: string | null;
  ticketNumber?: string | null;
  ticketSubject?: string | null;
  date: string;
  startedAt: string | null;
  running: boolean;
  minutes: number;
  billedMinutes?: number;
  rate?: number;
  amount?: number;
  description: string;
  billable: boolean;
  hourlyRate: number | null;
  invoiceId: string | null;
  invoiceNumber?: string | null;
}

export interface Charge {
  id: string;
  customerId: string;
  customerName?: string;
  projectId: string | null;
  ticketId: string | null;
  ticketNumber?: string | null;
  productId: string | null;
  date: string;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unitPriceNet: number;
  taxRate: number;
  amount: number;
  invoiceId: string | null;
  invoiceNumber?: string | null;
}

export interface BillingOpen {
  customerId: string;
  customerName: string;
  minutes: number;
  timeAmount: number;
  entries: number;
  charges: number;
  chargeAmount: number;
  oldest: string;
}

export interface Expense {
  id: string;
  date: string;
  supplier: string;
  description: string | null;
  category: string;
  amountGross: number;
  taxRate: number;
  taxAmount: number;
  paymentMethod: string;
  invoiceNumber: string | null;
  bankTransactionId: string | null;
  receiptName: string | null;
  receiptType: string | null;
  hasReceipt: boolean;
  notes: string | null;
}

export interface ReportSummary {
  from: string;
  to: string;
  smallBusiness: boolean;
  incomeGross: number;
  incomeNet: number;
  vatCollected: number;
  expensesGross: number;
  expensesDeductible: number;
  inputTax: number;
  vatPayable: number;
  profit: number;
  openReceivables: number;
  months: { month: string; income: number; expenses: number; vat: number; inputTax: number }[];
  quarters: { quarter: number; vat: number; inputTax: number; payable: number }[];
  incomeByRate: { rate: number; net: number; tax: number }[];
  incomeByCategory: { category: string; amount: number }[];
  expensesByCategory: { category: string; gross: number; net: number; tax: number; deductible: number; count: number }[];
  smallBusinessCheck: { year: number; previousYear: number; currentYear: number; projected: number; limitPrevious: number; limitCurrent: number; eligible: boolean; nextYearEligible: boolean };
  counts: { incomes: number; expenses: number };
}

export interface PayLinkInfo {
  ready: boolean;
  publicUrl: boolean;
  url: string | null;
  payments: { id: string; amount: number; status: "PAID" | "EXPIRED"; method: string | null; createdAt: string; paidAt: string | null }[];
}

export interface PortalInfo {
  enabled: boolean;
  publicUrl: boolean;
  url: string | null;
}

export type ContractStatus = "DRAFT" | "ACTIVE" | "CANCELLED" | "ENDED";
export type NoticeUnit = "DAYS" | "WEEKS" | "MONTHS";

export interface Contract {
  id: string;
  number: string;
  customerId: string;
  customerName?: string;
  title: string;
  description: string | null;
  contactPerson: string | null;
  status: ContractStatus;
  startDate: string;
  endDate: string | null;
  minTermMonths: number;
  renewalMonths: number;
  noticeValue: number;
  noticeUnit: NoticeUnit;
  interval: RecurringInterval;
  items: InvoiceItem[];
  signedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: "CUSTOMER" | "US" | null;
  cancelReason: string | null;
  recurringId: string | null;
  hasDocument: boolean;
  documentName: string | null;
  notes: string | null;
  netPerInterval: number;
  monthlyNet: number;
  minTermEnd: string | null;
  earliestEnd: string | null;
  noticeDeadline: string | null;
}

export interface ContractFull extends Contract {
  customer: Customer | null;
  recurring: { id: string; active: boolean; nextDate: string; autoIssue: boolean; runCount: number; lastError: string | null } | null;
  invoices: { id: string; number: string | null; status: InvoiceStatus; issueDate: string | null; totalGross: number; paidTotal: number }[];
  grossPerInterval: number;
  billed: number;
}

export interface ContractSummary {
  mrr: number;
  arr: number;
  activeCount: number;
  cancelledCount: number;
  customers: number;
  forecast: { month: string; net: number }[];
  deadlines: { id: string; number: string; title: string; customerName: string; noticeDeadline: string; earliestEnd: string; monthlyNet: number }[];
  ending: { id: string; number: string; title: string; customerName: string; endDate: string; monthlyNet: number }[];
  top: { customerId: string; customerName: string; monthlyNet: number }[];
}

export interface ContractPreview {
  status: ContractStatus;
  netPerInterval: number;
  monthlyNet: number;
  minTermEnd: string | null;
  earliestEnd: string | null;
  noticeDeadline: string | null;
  grossPerInterval: number;
}

export interface CompanyProfile {
  id: string;
  label: string;
  company: Partial<Settings["company"]>;
  accentColor: string;
  numberFormat: string;
  smallBusiness: "inherit" | "yes" | "no";
}
