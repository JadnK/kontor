import { z } from "zod";
import { eq, sql as dsql } from "drizzle-orm";
import { db, schema, type Tx } from "../db/index.js";
import { decrypt, encrypt } from "./crypto.js";

export const companySchema = z.object({
  name: z.string().default(""),
  owner: z.string().default(""),
  /** Zusatzzeile, z. B. "c/o MDC#1156" bei gemieteter Geschäftsadresse – Name bleibt der echte */
  addressAddition: z.string().default(""),
  street: z.string().default(""),
  zip: z.string().default(""),
  city: z.string().default(""),
  country: z.string().default("DE"),
  email: z.string().default(""),
  phone: z.string().default(""),
  website: z.string().default(""),
  taxNumber: z.string().default(""),
  vatId: z.string().default(""),
  registerCourt: z.string().default(""),
  registerNumber: z.string().default(""),
  bankName: z.string().default(""),
  iban: z.string().default(""),
  bic: z.string().default(""),
  /** data:image/png;base64,... (max. ~300 KB) */
  logo: z.string().max(400_000).default(""),
});

/**
 * Gründe für 0 % Umsatzsteuer. category = Steuerkategorie der E-Rechnung (UNTDID 5305):
 * E steuerbefreit, AE Reverse Charge, K innergemeinschaftlich, G Ausfuhr, Z Nullsatz.
 */
export const exemptionSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  text: z.string().min(1),
  category: z.enum(["E", "AE", "K", "G", "Z"]),
});
export type Exemption = z.infer<typeof exemptionSchema>;

export const DEFAULT_EXEMPTIONS: Exemption[] = [
  {
    code: "EXEMPT",
    label: "Steuerfreie Leistung (§ 4 UStG)",
    text: "Umsatzsteuerfreie Leistung gemäß § 4 Nr. 14 UStG.",
    category: "E",
  },
  {
    code: "REVERSE_CHARGE",
    label: "Reverse Charge Inland (§ 13b UStG)",
    text: "Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.",
    category: "AE",
  },
  {
    code: "EU_SERVICE",
    label: "Leistung an Unternehmen in der EU (§ 3a UStG)",
    text: "Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge). Im Inland nicht steuerbare Leistung gemäß § 3a Abs. 2 UStG.",
    category: "AE",
  },
  {
    code: "INTRA_EU",
    label: "Innergemeinschaftliche Lieferung (§ 4 Nr. 1b UStG)",
    text: "Steuerfreie innergemeinschaftliche Lieferung gemäß § 4 Nr. 1b i. V. m. § 6a UStG.",
    category: "K",
  },
  {
    code: "EXPORT",
    label: "Ausfuhrlieferung Drittland (§ 4 Nr. 1a UStG)",
    text: "Steuerfreie Ausfuhrlieferung gemäß § 4 Nr. 1a i. V. m. § 6 UStG.",
    category: "G",
  },
  {
    code: "ZERO_RATE",
    label: "Nullsteuersatz Photovoltaik (§ 12 Abs. 3 UStG)",
    text: "Umsatzsteuersatz 0 % gemäß § 12 Abs. 3 UStG.",
    category: "Z",
  },
];

export const invoiceSettingsSchema = z.object({
  numberFormat: z.string().default("RE-{YYYY}-{NNNN}"),
  cancellationNumberFormat: z.string().default("ST-{YYYY}-{NNNN}"),
  customerNumberFormat: z.string().default("K-{NNNN}"),
  currency: z.string().default("EUR"),
  paymentDays: z.number().int().min(0).max(365).default(14),
  defaultTaxRate: z.number().min(0).max(100).default(19),
  taxRates: z.array(z.number().min(0).max(100)).default([19, 7, 0]),
  /** Kleinunternehmerregelung § 19 UStG */
  smallBusiness: z.boolean().default(false),
  smallBusinessText: z
    .string()
    .default("Steuerbefreiung für Kleinunternehmer gemäß § 19 UStG.")
    // alter Standardtext → neuer Standardtext
    .transform((t) => (t.trim() === "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung)." ? "Steuerbefreiung für Kleinunternehmer gemäß § 19 UStG." : t)),
  /** Pflichthinweise für Positionen mit 0 % USt, wenn nicht Kleinunternehmer (§ 14 Abs. 4 Nr. 8 UStG) */
  taxExemptions: z.array(exemptionSchema).min(1).default(DEFAULT_EXEMPTIONS),
  defaultExemption: z.string().default("EXEMPT"),
  /** Hinweis bei steuerfreien Leistungen / Reverse Charge usw. – frei editierbar */
  legalNotes: z.array(z.string()).default([]),
  introText: z.string().default("Vielen Dank für Ihren Auftrag. Wir berechnen Ihnen folgende Leistungen:"),
  paymentText: z
    .string()
    .default("Bitte überweisen Sie den Betrag von {total} bis zum {dueDate} unter Angabe der Rechnungsnummer {invoiceNumber}."),
  closingText: z.string().default("Mit freundlichen Grüßen"),
  showServiceDate: z.boolean().default(true),
  /** E-Rechnung: XRechnung (CII) als Anhang mitsenden */
  attachXRechnung: z.boolean().default(false),
  /** Rechnungs-PDF als ZUGFeRD (PDF/A-3 mit eingebetteten Rechnungsdaten) */
  zugferd: z.boolean().default(true),
  /** Gestaltung des PDFs */
  design: z.enum(["classic", "modern", "minimal"]).default("classic"),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#1f3a5f"),
  /** QR-Code für die Überweisung (GiroCode/EPC) auf der Rechnung */
  showGiroCode: z.boolean().default(true),
});

/** Mahnstufen nach der Zahlungserinnerung */
export const dunningStepSchema = z.object({
  label: z.string().trim().min(1),
  /** Tage nach der vorherigen Erinnerung/Mahnung */
  days: z.number().int().min(1).max(90),
  /** Mahngebühr in Cent */
  fee: z.number().int().min(0).max(100_000),
  /** Verzugszinsen nach § 288 BGB berechnen */
  interest: z.boolean(),
});

/** Angebote */
export const quoteSettingsSchema = z.object({
  numberFormat: z.string().default("AN-{YYYY}-{NNNN}"),
  validDays: z.number().int().min(1).max(365).default(30),
  introText: z.string().default("Vielen Dank für Ihre Anfrage. Gerne bieten wir Ihnen folgende Leistungen an:"),
  footerText: z.string().default("Dieses Angebot ist gültig bis zum {validUntil}. Sie können es bequem online annehmen."),
  /** Mail an die Firmenadresse, wenn ein Kunde annimmt oder ablehnt */
  notifyOnAnswer: z.boolean().default(true),
  /** Bei Annahme automatisch einen Rechnungsentwurf anlegen */
  draftOnAccept: z.boolean().default(false),
});

export const mailSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default(""),
  port: z.number().int().min(1).max(65535).default(587),
  /** true = SMTPS (465), false = STARTTLS */
  secure: z.boolean().default(false),
  user: z.string().default(""),
  password: z.string().default(""),
  fromName: z.string().default(""),
  fromAddress: z.string().default(""),
  replyTo: z.string().default(""),
  bcc: z.string().default(""),
});

export const automationSchema = z.object({
  sendInvoiceOnIssue: z.boolean().default(true),
  sendPaymentConfirmation: z.boolean().default(true),
  sendReminders: z.boolean().default(true),
  reminderAfterDays: z.number().int().min(1).max(90).default(7),
  reminderRepeatDays: z.number().int().min(1).max(90).default(7),
  maxReminders: z.number().int().min(0).max(5).default(1),
  /** Nach den Zahlungserinnerungen automatisch Mahnungen verschicken (sonst nur per Knopf) */
  dunningAuto: z.boolean().default(false),
  dunningSteps: z.array(dunningStepSchema).max(4).default([
    { label: "1. Mahnung", days: 14, fee: 500, interest: true },
    { label: "2. Mahnung", days: 14, fee: 1000, interest: true },
  ]),
  /** Basiszinssatz nach § 247 BGB in % (Bundesbank, halbjährlich) */
  baseRate: z.number().min(-5).max(20).default(1.52),
  /** 40 € Verzugspauschale nach § 288 Abs. 5 BGB bei Firmenkunden */
  b2bFlatFee: z.boolean().default(true),
  /** Zahlungsfrist in der Mahnung (Tage) */
  dunningPayDays: z.number().int().min(1).max(60).default(10),
  sendDiscountNotice: z.boolean().default(true),
  sendWelcome: z.boolean().default(false),
});

export const bankSchema = z.object({
  /** Eindeutige Treffer (Rechnungsnummer im Verwendungszweck) sofort buchen statt nur vorschlagen */
  autoBook: z.boolean().default(true),
  /** Automatischer Kontoabruf über Enable Banking (PSD2) */
  syncEnabled: z.boolean().default(false),
  ebAppId: z.string().trim().default(""),
  /** Private Key (PEM) der Enable-Banking-Anwendung – verschlüsselt gespeichert */
  ebPrivateKey: z.string().default(""),
  /** PSD2: ohne Anwesenheit des Kontoinhabers meist max. 4 Abrufe pro Tag */
  syncMinutes: z.number().int().min(60).max(1440).default(360),
  /** So viele Tage vor Ablauf der Bankfreigabe eine Erinnerung an die Firmen-Mailadresse schicken (0 = aus) */
  renewReminderDays: z.number().int().min(0).max(60).default(7),
});

const tpl = z.object({ subject: z.string(), body: z.string() });
export const templatesSchema = z.object({
  invoice: tpl.default({
    subject: "Rechnung {invoiceNumber} von {companyName}",
    body:
      "Guten Tag {customerName},\n\nanbei erhalten Sie die Rechnung {invoiceNumber} über {total}.\nBitte begleichen Sie den Betrag bis zum {dueDate}.\n\nMit freundlichen Grüßen\n{companyName}",
  }),
  payment: tpl.default({
    subject: "Zahlungseingang zu Rechnung {invoiceNumber}",
    body:
      "Guten Tag {customerName},\n\nwir haben Ihre Zahlung über {amount} zur Rechnung {invoiceNumber} erhalten. Vielen Dank!\n\nMit freundlichen Grüßen\n{companyName}",
  }),
  /** Zahlung deckt die Rechnung nicht vollständig */
  partialPayment: tpl.default({
    subject: "Teilzahlung zu Rechnung {invoiceNumber} erhalten",
    body:
      "Guten Tag {customerName},\n\nwir haben Ihre Zahlung über {amount} zur Rechnung {invoiceNumber} erhalten. Vielen Dank!\n\nDie Rechnung über {total} ist damit noch nicht vollständig beglichen. Bisher eingegangen: {paid}, offen sind noch {open}.\nBitte überweisen Sie den Restbetrag unter Angabe der Rechnungsnummer {invoiceNumber}.\n\nSollte sich Ihre Zahlung mit dieser Nachricht überschnitten haben, betrachten Sie diese bitte als gegenstandslos.\n\nMit freundlichen Grüßen\n{companyName}",
  }),
  reminder: tpl.default({
    subject: "Zahlungserinnerung: Rechnung {invoiceNumber}",
    body:
      "Guten Tag {customerName},\n\nsicher ist es Ihrer Aufmerksamkeit entgangen: Die Rechnung {invoiceNumber} vom {issueDate} über {open} war am {dueDate} fällig.\nWir bitten um Ausgleich innerhalb der nächsten 7 Tage. Die Rechnung finden Sie erneut im Anhang.\n\nSollte sich Ihre Zahlung mit dieser Nachricht überschnitten haben, betrachten Sie diese bitte als gegenstandslos.\n\nMit freundlichen Grüßen\n{companyName}",
  }),
  cancellation: tpl.default({
    subject: "Stornorechnung {invoiceNumber}",
    body:
      "Guten Tag {customerName},\n\nanbei erhalten Sie die Stornorechnung {invoiceNumber} zur Rechnung {originalNumber}.\n\nMit freundlichen Grüßen\n{companyName}",
  }),
  discount: tpl.default({
    subject: "Ein Rabatt für Sie: {discountName}",
    body:
      "Guten Tag {customerName},\n\nab sofort erhalten Sie {discountValue} Rabatt ({discountName}).{discountCodeLine}{discountValidLine}\n\nMit freundlichen Grüßen\n{companyName}",
  }),
  portal: tpl.default({
    subject: "Ihr Kundenbereich bei {companyName}",
    body:
      "Guten Tag {customerName},\n\nunter diesem persönlichen Link finden Sie jederzeit Ihre Rechnungen, Angebote und Anfragen bei uns:\n{portalLink}\n\nDer Link ist nur für Sie bestimmt – bitte geben Sie ihn nicht weiter.\n\nMit freundlichen Grüßen\n{companyName}",
  }),
  quote: tpl.default({
    subject: "Angebot {quoteNumber} von {companyName}",
    body:
      "Guten Tag {customerName},\n\nanbei erhalten Sie unser Angebot {quoteNumber} über {total}. Es ist gültig bis zum {validUntil}.\n\nSie können das Angebot hier ansehen und mit einem Klick annehmen:\n{acceptLink}\n\nBei Fragen melden Sie sich gerne.\n\nMit freundlichen Grüßen\n{companyName}",
  }),
  dunning: tpl.default({
    subject: "{dunningLabel}: Rechnung {invoiceNumber}",
    body:
      "Guten Tag {customerName},\n\nleider konnten wir zur Rechnung {invoiceNumber} vom {issueDate} (fällig am {dueDate}) noch keinen vollständigen Zahlungseingang feststellen.\n\nOffener Rechnungsbetrag: {open}\n{feeLines}\nGesamtforderung: {claim}\n\nBitte überweisen Sie den Betrag bis zum {payUntil}. Die {dunningLabel} und die Rechnung finden Sie im Anhang.\n\nSollte sich Ihre Zahlung mit diesem Schreiben überschnitten haben, betrachten Sie es bitte als gegenstandslos.\n\nMit freundlichen Grüßen\n{companyName}",
  }),
  welcome: tpl.default({
    subject: "Willkommen bei {companyName}",
    body:
      "Guten Tag {customerName},\n\nvielen Dank für Ihr Vertrauen. Ihre Kundennummer lautet {customerNumber}.\n\nMit freundlichen Grüßen\n{companyName}",
  }),
});

/** Ticket-Postfach: eigenes Konto (z. B. ticket@firma.de), wird per IMAP abgerufen */
export const ticketSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  address: z.string().trim().default(""),
  fromName: z.string().default(""),
  imapHost: z.string().trim().default(""),
  imapPort: z.number().int().min(1).max(65535).default(993),
  imapSecure: z.boolean().default(true),
  imapUser: z.string().trim().default(""),
  imapPassword: z.string().default(""),
  folder: z.string().trim().default("INBOX"),
  /** leer = gleiche Zugangsdaten wie IMAP */
  smtpHost: z.string().trim().default(""),
  smtpPort: z.number().int().min(1).max(65535).default(587),
  smtpSecure: z.boolean().default(false),
  smtpUser: z.string().trim().default(""),
  smtpPassword: z.string().default(""),
  pollMinutes: z.number().int().min(1).max(60).default(2),
  /** Ab diesem Zeitpunkt werden Mails berücksichtigt (wird beim Aktivieren gesetzt) */
  since: z.string().nullable().default(null),
  numberFormat: z.string().default("T-{YYYY}-{NNNN}"),
  /** low: nur eindeutige Werbung raus | normal | strict: nur Mails mit erkennbarem Anliegen */
  filterLevel: z.enum(["low", "normal", "strict"]).default("normal"),
  onlyKnownCustomers: z.boolean().default(false),
  allowSenders: z.array(z.string().trim().toLowerCase()).default([]),
  blockSenders: z.array(z.string().trim().toLowerCase()).default([]),
  autoReply: z.boolean().default(true),
  /** Die Ticketnummer [T-…] wird automatisch vorangestellt */
  autoReplySubject: z.string().default("Eingangsbestätigung: {subject}"),
  autoReplyBody: z
    .string()
    .default(
      "Guten Tag {customerName},\n\nvielen Dank für Ihre Nachricht. Wir haben Ihre Anfrage unter der Nummer {ticketNumber} aufgenommen und melden uns schnellstmöglich.\n\nWenn Sie uns noch etwas mitteilen möchten, antworten Sie einfach auf diese E-Mail.\n\nMit freundlichen Grüßen\n{companyName}",
    ),
  signature: z.string().default("Mit freundlichen Grüßen\n{userName}\n{companyName}"),
  // ---------- Wer darf Tickets eröffnen ----------
  /** Bei "nur Kunden": auch Absender mit derselben Domain wie die E-Mail eines Kunden zulassen (Kollegen) */
  allowCustomerDomain: z.boolean().default(true),
  /** Was mit Mails von Nicht-Kunden passiert: still aussortieren oder mit Absage-Mail antworten */
  nonCustomerAction: z.enum(["filter", "reject"]).default("filter"),
  rejectSubject: z.string().default("Ihre Anfrage: {subject}"),
  rejectBody: z
    .string()
    .default(
      "Guten Tag,\n\nvielen Dank für Ihre Nachricht. Über diese Adresse nehmen wir Supportanfragen nur von bestehenden Kunden an.\nFür allgemeine Anfragen schreiben Sie uns bitte an {companyEmail}.\n\nMit freundlichen Grüßen\n{companyName}",
    ),
  // ---------- Bearbeitung ----------
  /** Mail an das Team bei neuen Tickets */
  notifyTeam: z.boolean().default(false),
  /** Empfänger (leer = Firmen-E-Mail) */
  notifyAddress: z.string().trim().default(""),
  /** Neue Tickets automatisch diesem Benutzer zuweisen (leer = niemand) */
  autoAssignUserId: z.string().default(""),
  categories: z.array(z.string().trim().min(1)).default(["Support", "Fehler", "Änderungswunsch", "Rechnung"]),
  defaultPriority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
  /** Tickets im Status "Wartet auf Kunde" nach X Tagen ohne Antwort schließen (0 = aus) */
  autoCloseDays: z.number().int().min(0).max(365).default(0),
  autoCloseNotify: z.boolean().default(true),
  autoCloseBody: z
    .string()
    .default(
      "Guten Tag {customerName},\n\nda wir zu Ihrer Anfrage {ticketNumber} keine Rückmeldung mehr erhalten haben, schließen wir das Ticket. Antworten Sie einfach auf diese E-Mail, falls noch etwas offen ist.\n\nMit freundlichen Grüßen\n{companyName}",
    ),
  /** Antwort auf ein geschlossenes Ticket: wieder öffnen (true) oder neues Ticket anlegen (false) */
  reopenOnReply: z.boolean().default(true),
  /** Neues Ticket statt Wiedereröffnen, wenn das Ticket länger als X Tage geschlossen ist (0 = immer wiedereröffnen) */
  reopenMaxDays: z.number().int().min(0).max(365).default(30),
  allowAttachments: z.boolean().default(true),
  maxAttachmentMb: z.number().int().min(1).max(50).default(15),
  /** Kunden dürfen Tickets über das Kundenportal / Webformular eröffnen */
  portalTickets: z.boolean().default(true),
});

/** Zeiterfassung und Abrechnung von Arbeitszeit */
export const timeSettingsSchema = z.object({
  /** Standard-Stundensatz netto in Cent */
  defaultHourlyRate: z.number().int().min(0).default(9000),
  /** Abrechnungstakt in Minuten (z. B. 15 = Viertelstunden) */
  roundingMinutes: z.number().int().min(1).max(60).default(15),
  rounding: z.enum(["up", "nearest", "none"]).default("up"),
  /** Positionen auf der Rechnung: je Eintrag, je Ticket/Projekt zusammengefasst oder je Tag */
  grouping: z.enum(["entry", "group", "day"]).default("group"),
  unit: z.string().default("Std."),
  taxRate: z.number().min(0).max(100).default(19),
});

export const expenseCategorySchema = z.object({
  name: z.string().trim().min(1),
  /** Konten für den DATEV-Export */
  skr03: z.string().default(""),
  skr04: z.string().default(""),
  /** Anteil der abziehbaren Kosten in % (Bewirtung 70) */
  deductible: z.number().min(0).max(100).default(100),
});

export const DEFAULT_EXPENSE_CATEGORIES: z.infer<typeof expenseCategorySchema>[] = [
  { name: "Wareneinkauf", skr03: "3400", skr04: "5400", deductible: 100 },
  { name: "Fremdleistungen", skr03: "3100", skr04: "5900", deductible: 100 },
  { name: "Hosting & Server", skr03: "4900", skr04: "6300", deductible: 100 },
  { name: "Software & Lizenzen", skr03: "4964", skr04: "6837", deductible: 100 },
  { name: "Telefon & Internet", skr03: "4920", skr04: "6805", deductible: 100 },
  { name: "Hardware (GWG bis 800 €)", skr03: "4855", skr04: "6260", deductible: 100 },
  { name: "Bürobedarf", skr03: "4930", skr04: "6815", deductible: 100 },
  { name: "Porto", skr03: "4910", skr04: "6800", deductible: 100 },
  { name: "Miete & Raumkosten", skr03: "4210", skr04: "6310", deductible: 100 },
  { name: "Fahrt- & Reisekosten", skr03: "4670", skr04: "6670", deductible: 100 },
  { name: "Werbung", skr03: "4600", skr04: "6600", deductible: 100 },
  { name: "Fortbildung", skr03: "4945", skr04: "6821", deductible: 100 },
  { name: "Versicherungen & Beiträge", skr03: "4360", skr04: "6400", deductible: 100 },
  { name: "Bewirtung", skr03: "4650", skr04: "6640", deductible: 70 },
  { name: "Bankgebühren", skr03: "4970", skr04: "6855", deductible: 100 },
  { name: "Sonstiges", skr03: "4900", skr04: "6300", deductible: 100 },
];

export const expenseSettingsSchema = z.object({
  categories: z.array(expenseCategorySchema).min(1).default(DEFAULT_EXPENSE_CATEGORIES),
  /** Abbuchungen aus dem Kontoabruf automatisch als Ausgabe buchen, wenn der Empfänger schon einmal zugeordnet wurde */
  autoBookKnown: z.boolean().default(true),
  /** Gelernte Zuordnung Empfänger → Kategorie (wird automatisch gepflegt) */
  supplierCategories: z.record(z.string()).default({}),
});

/** DATEV-Export für die Steuerberatung */
export const datevSettingsSchema = z.object({
  consultantNumber: z.string().trim().regex(/^\d{0,7}$/).default(""),
  clientNumber: z.string().trim().regex(/^\d{0,5}$/).default(""),
  chart: z.enum(["SKR03", "SKR04"]).default("SKR03"),
  accountLength: z.number().int().min(4).max(8).default(4),
  /** Geldkonto (Bank) */
  bankAccount: z.string().default(""),
  revenue19: z.string().default(""),
  revenue7: z.string().default(""),
  revenue0: z.string().default(""),
  revenueSmall: z.string().default(""),
});

export const contractSettingsSchema = z.object({
  numberFormat: z.string().default("V-{YYYY}-{NNNN}"),
  /** So viele Tage vor Ablauf der Kündigungsfrist erinnern (Übersicht + Mail an die Firmenadresse) */
  remindDays: z.number().int().min(0).max(180).default(30),
  remindByMail: z.boolean().default(true),
});

/** Weitere Firmen / Absender (z. B. zweites Gewerbe) mit eigenen Stammdaten und eigenem Nummernkreis */
export const profileSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().trim().min(1, "Name des Profils fehlt").max(80),
  /** Leere Felder übernehmen die Werte der Hauptfirma */
  company: companySchema.partial().default({}),
  accentColor: z.string().default(""),
  /** Eigene Rechnungsnummer, z. B. "B-{YYYY}-{NNNN}" – leer = gemeinsamer Nummernkreis */
  numberFormat: z.string().default(""),
  smallBusiness: z.enum(["inherit", "yes", "no"]).default("inherit"),
});
export const profilesSchema = z.object({
  list: z
    .array(profileSchema)
    .max(20)
    .default([])
    .superRefine((list, ctx) => {
      const ids = new Set<string>();
      const formats = new Set<string>();
      list.forEach((p, i) => {
        if (ids.has(p.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: "Profil doppelt" });
        ids.add(p.id);
        const f = p.numberFormat.trim();
        if (f && formats.has(f)) ctx.addIssue({ code: "custom", path: [i, "numberFormat"], message: `Rechnungsnummer „${f}“ wird schon von einem anderen Profil verwendet` });
        if (f) formats.add(f);
      });
    }),
});

/** Kundenportal: persönlicher Link je Kunde */
export const portalSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  showInvoices: z.boolean().default(true),
  showQuotes: z.boolean().default(true),
  showTickets: z.boolean().default(true),
  /** Text oben im Portal */
  introText: z.string().max(2000).default("Hier finden Sie Ihre Rechnungen, Angebote und Anfragen."),
});

/** Anfrage-Formular für die eigene Website */
export const webformSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  title: z.string().max(120).default("Anfrage senden"),
  introText: z.string().max(2000).default(""),
  successText: z.string().max(2000).default("Vielen Dank! Ihre Anfrage ist bei uns eingegangen. Sie erhalten gleich eine Bestätigung per E-Mail."),
  /** Nur Kunden (E-Mail bzw. Firmen-Domain bekannt) dürfen das Formular nutzen */
  onlyCustomers: z.boolean().default(false),
  nonCustomerText: z
    .string()
    .max(2000)
    .default("Über dieses Formular nehmen wir Anfragen nur von bestehenden Kunden an. Bitte verwenden Sie die E-Mail-Adresse, die bei uns hinterlegt ist."),
  askPhone: z.boolean().default(false),
  askCategory: z.boolean().default(true),
  allowFiles: z.boolean().default(true),
  /** Websites, die das Formular per JavaScript direkt ansprechen dürfen (iframe geht immer) */
  allowedOrigins: z.array(z.string().trim().url()).default([]),
});

/** Online-Zahlung */
export const paymentSettingsSchema = z.object({
  stripeEnabled: z.boolean().default(false),
  stripeSecretKey: z.string().default(""),
  stripeWebhookSecret: z.string().default(""),
  /** PayPal.me-Name (ohne URL) für einen einfachen PayPal-Link, leer = aus */
  paypalMe: z.string().trim().regex(/^[A-Za-z0-9._-]{0,40}$/, "Nur den Namen hinter paypal.me/ eintragen").default(""),
  /** Zahlungslink automatisch in Rechnungs-, Erinnerungs- und Mahn-Mails */
  linkInMails: z.boolean().default(true),
  /** Zahlungslink auf dem Rechnungs-PDF */
  linkOnPdf: z.boolean().default(true),
  /** Stripe-Auszahlungen im Kontoauszug automatisch ignorieren (Zahlungen sind schon einzeln gebucht) */
  ignorePayouts: z.boolean().default(true),
});

export const sections = {
  company: companySchema,
  invoice: invoiceSettingsSchema,
  mail: mailSettingsSchema,
  automation: automationSchema,
  templates: templatesSchema,
  bank: bankSchema,
  tickets: ticketSettingsSchema,
  quotes: quoteSettingsSchema,
  time: timeSettingsSchema,
  expenses: expenseSettingsSchema,
  datev: datevSettingsSchema,
  portal: portalSettingsSchema,
  contracts: contractSettingsSchema,
  profiles: profilesSchema,
  webform: webformSettingsSchema,
  payments: paymentSettingsSchema,
} as const;

export type SectionKey = keyof typeof sections;
export type Settings = { [K in SectionKey]: z.infer<(typeof sections)[K]> };

/** Felder, die verschlüsselt gespeichert und nie an die App ausgeliefert werden */
const SECRETS: Partial<Record<SectionKey, string[]>> = {
  mail: ["password"],
  tickets: ["imapPassword", "smtpPassword"],
  bank: ["ebPrivateKey"],
  payments: ["stripeSecretKey", "stripeWebhookSecret"],
};

export function isSection(k: string): k is SectionKey {
  return k in sections;
}

export async function getSettings(): Promise<Settings> {
  const rows = await db.select().from(schema.settings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as Record<string, Record<string, unknown>>;
  for (const [k, s] of Object.entries(sections)) {
    const v = (s as z.ZodTypeAny).parse(map.get(k) ?? {}) as Record<string, unknown>;
    for (const f of SECRETS[k as SectionKey] ?? []) {
      if (typeof v[f] === "string" && v[f]) {
        try {
          v[f] = decrypt(v[f] as string);
        } catch {
          v[f] = "";
        }
      }
    }
    out[k] = v;
  }
  return out as unknown as Settings;
}

/** Variante für die API: Passwörter werden nie ausgeliefert, nur ob eins gesetzt ist. */
export async function getPublicSettings() {
  const s = (await getSettings()) as unknown as Record<string, Record<string, unknown>>;
  for (const [k, fields] of Object.entries(SECRETS)) {
    const sec = { ...s[k] };
    for (const f of fields ?? []) {
      sec[`has${f[0].toUpperCase()}${f.slice(1)}`] = !!sec[f];
      sec[f] = "";
    }
    s[k] = sec;
  }
  return s as unknown as Settings;
}

export async function putSection<K extends SectionKey>(key: K, input: unknown): Promise<Settings[K]> {
  const current = (await getSettings())[key] as Record<string, unknown>;
  const inp = { ...((input ?? {}) as Record<string, unknown>) };
  // Leeres Passwortfeld = unverändert lassen
  for (const f of SECRETS[key] ?? []) if (inp[f] === undefined || inp[f] === "") inp[f] = current[f];
  // Ticket-Postfach: beim Einschalten Startzeitpunkt setzen, damit alte Mails nicht zu Tickets werden
  if (key === "tickets" && inp.enabled === true && !current.enabled) inp.since = new Date().toISOString();
  const parsed = sections[key].parse({ ...current, ...inp }) as Record<string, unknown>;
  const stored = { ...parsed };
  for (const f of SECRETS[key] ?? []) stored[f] = parsed[f] ? encrypt(parsed[f] as string) : "";
  await upsert(key, stored);
  return parsed as Settings[K];
}

/** Interner Zustand (nicht über die API änderbar), z. B. letzte abgerufene IMAP-UID */
export async function getState<T>(key: string, fallback: T): Promise<T> {
  const row = (await db.select().from(schema.settings).where(eq(schema.settings.key, `state:${key}`)))[0];
  return (row?.value as T) ?? fallback;
}

export async function setState(key: string, value: unknown) {
  await upsert(`state:${key}`, value);
}

async function upsert(key: string, value: unknown) {
  await db
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

/** Fortlaufende Nummer je Schlüssel und Jahr, atomar. */
export async function nextNumber(tx: Tx | typeof db, key: string, format: string, date = new Date()): Promise<string> {
  const usesYear = /\{YYYY\}|\{YY\}/.test(format);
  const year = usesYear ? date.getFullYear() : 0;
  const rows = await tx
    .insert(schema.numberSequences)
    .values({ key, year, value: 1 })
    .onConflictDoUpdate({
      target: [schema.numberSequences.key, schema.numberSequences.year],
      set: { value: dsql`${schema.numberSequences.value} + 1` },
    })
    .returning({ value: schema.numberSequences.value });
  const n = rows[0].value;
  return format
    .replace("{YYYY}", String(date.getFullYear()))
    .replace("{YY}", String(date.getFullYear()).slice(2))
    .replace("{MM}", String(date.getMonth() + 1).padStart(2, "0"))
    .replace(/\{(N+)\}/, (_, ns: string) => String(n).padStart(ns.length, "0"));
}

export async function deleteSetting(key: string) {
  await db.delete(schema.settings).where(eq(schema.settings.key, key));
}

/** Firmendaten und Rechnungseinstellungen für ein Profil (null/unbekannt = Hauptfirma) */
export function resolveProfile(s: Settings, profileId: string | null | undefined) {
  const p = profileId ? s.profiles.list.find((x) => x.id === profileId) : undefined;
  if (!p) return { profile: null, company: s.company, invoice: s.invoice, numberKey: "invoice" };
  const overrides = Object.fromEntries(Object.entries(p.company).filter(([, v]) => typeof v === "string" && v.trim() !== ""));
  const company = { ...s.company, ...overrides } as Settings["company"];
  const invoice = {
    ...s.invoice,
    accentColor: p.accentColor || s.invoice.accentColor,
    numberFormat: p.numberFormat || s.invoice.numberFormat,
    smallBusiness: p.smallBusiness === "inherit" ? s.invoice.smallBusiness : p.smallBusiness === "yes",
  };
  return { profile: p, company, invoice, numberKey: p.numberFormat ? `invoice:${p.id}` : "invoice" };
}
