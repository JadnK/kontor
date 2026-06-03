import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { Customer, Invoice, InvoiceItem } from "../db/schema.js";
import { getSettings, resolveProfile, type Settings } from "./settings.js";
import { formatMoney } from "./calc.js";
import { formatDate } from "./http.js";

export interface CustomerSnapshot {
  number: string;
  type: "COMPANY" | "PERSON";
  company: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  street: string | null;
  zip: string | null;
  city: string | null;
  country: string;
  vatId: string | null;
  leitwegId: string | null;
}

export interface InvoiceDoc {
  invoice: Invoice;
  items: InvoiceItem[];
  customer: CustomerSnapshot;
  company: Settings["company"];
  invoiceSettings: Settings["invoice"];
  original?: { number: string | null; issueDate: string | null } | null;
  /** Pflichthinweis bei 0 % USt bzw. Kleinunternehmer, sonst null */
  exemption: ExemptionInfo | null;
}

export interface ExemptionInfo {
  code: string;
  text: string;
  /** Steuerkategorie für die E-Rechnung */
  category: "E" | "AE" | "K" | "G" | "Z";
}

/**
 * Welcher Pflichthinweis gehört auf die Rechnung?
 * Kleinunternehmer → § 19-Text. Sonst: sobald eine Position 0 % hat, der gewählte (oder Standard-)Befreiungsgrund.
 */
export function resolveExemption(
  inv: Pick<Invoice, "smallBusiness" | "taxExemption" | "taxExemptionText">,
  items: { taxRate: number }[],
  st: Settings["invoice"],
): ExemptionInfo | null {
  if (inv.smallBusiness) {
    // alter Standardtext → neuer Wortlaut (inhaltlich gleich)
    const old = "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).";
    const text = inv.taxExemptionText && inv.taxExemptionText.trim() !== old ? inv.taxExemptionText : st.smallBusinessText;
    return { code: "SMALL_BUSINESS", text, category: "E" };
  }
  if (!items.some((i) => i.taxRate === 0)) return null;
  const list = st.taxExemptions?.length ? st.taxExemptions : [];
  const ex = list.find((e) => e.code === (inv.taxExemption ?? st.defaultExemption)) ?? list[0];
  if (!ex) return { code: "EXEMPT", text: inv.taxExemptionText ?? "Umsatzsteuerfreie Leistung.", category: "E" };
  return { code: ex.code, text: inv.taxExemptionText ?? ex.text, category: ex.category };
}

export function snapshotCustomer(c: Customer): CustomerSnapshot {
  return {
    number: c.number,
    type: c.type,
    company: c.company,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    street: c.street,
    zip: c.zip,
    city: c.city,
    country: c.country,
    vatId: c.vatId,
    leitwegId: c.leitwegId,
  };
}

export function customerDisplayName(c: Pick<CustomerSnapshot, "type" | "company" | "firstName" | "lastName">): string {
  const person = [c.firstName, c.lastName].filter(Boolean).join(" ");
  if (c.type === "COMPANY") return c.company || person || "Kunde";
  return person || c.company || "Kunde";
}

/** Anrede für Mails: Ansprechpartner wenn vorhanden, sonst Firmenname */
export function customerGreetingName(c: Pick<CustomerSnapshot, "type" | "company" | "firstName" | "lastName">): string {
  const person = [c.firstName, c.lastName].filter(Boolean).join(" ");
  return person || c.company || "";
}

export async function loadInvoiceDoc(id: string): Promise<InvoiceDoc | null> {
  const invoice = (await db.select().from(schema.invoices).where(eq(schema.invoices.id, id)))[0];
  if (!invoice) return null;
  const items = await db
    .select()
    .from(schema.invoiceItems)
    .where(eq(schema.invoiceItems.invoiceId, id))
    .orderBy(asc(schema.invoiceItems.position));
  const settings = await getSettings();
  let customer = invoice.customerSnapshot as CustomerSnapshot | null;
  if (!customer) {
    const c = (await db.select().from(schema.customers).where(eq(schema.customers.id, invoice.customerId)))[0];
    customer = snapshotCustomer(c);
  }
  let original: InvoiceDoc["original"] = null;
  if (invoice.cancelsId) {
    const o = (
      await db
        .select({ number: schema.invoices.number, issueDate: schema.invoices.issueDate })
        .from(schema.invoices)
        .where(and(eq(schema.invoices.id, invoice.cancelsId)))
    )[0];
    original = o ?? null;
  }
  // ältere Snapshots kennen noch keine Befreiungsgründe → mit aktuellen Einstellungen ergänzen
  const prof = resolveProfile(settings, invoice.profileId);
  const invoiceSettings = { ...prof.invoice, ...((invoice.invoiceSnapshot as Partial<Settings["invoice"]> | null) ?? {}) };
  return {
    invoice,
    items,
    customer,
    company: (invoice.companySnapshot as Settings["company"] | null) ?? prof.company,
    invoiceSettings,
    original,
    exemption: resolveExemption(invoice, items, invoiceSettings),
  };
}

export function invoiceVars(doc: InvoiceDoc, companyName: string): Record<string, string> {
  const cur = doc.invoiceSettings.currency;
  const inv = doc.invoice;
  return {
    customerName: customerGreetingName(doc.customer),
    customerNumber: doc.customer.number,
    companyName,
    invoiceNumber: inv.number ?? "Entwurf",
    originalNumber: doc.original?.number ?? "",
    total: formatMoney(inv.totalGross, cur),
    open: formatMoney(inv.totalGross - inv.paidTotal, cur),
    paid: formatMoney(inv.paidTotal, cur),
    issueDate: formatDate(inv.issueDate),
    dueDate: formatDate(inv.dueDate),
  };
}

export function invoiceFileBase(doc: InvoiceDoc): string {
  const n = (doc.invoice.number ?? "Entwurf").replace(/[^\w.-]+/g, "_");
  return doc.invoice.kind === "CANCELLATION" ? `Stornorechnung_${n}` : `Rechnung_${n}`;
}
