/**
 * Wiederkehrende Rechnungen (Hosting, Wartung, Domains …).
 * Am Stichtag wird aus der Vorlage eine Rechnung erzeugt – als Entwurf oder direkt ausgestellt und versendet.
 * Platzhalter in Betreff, Positionen und Texten: {month} {monthName} {year} {quarter} {period} {periodStart} {periodEnd}
 */
import { and, eq, lte } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { RecurringInvoice } from "../db/schema.js";
import { addDays, formatDate, today } from "./http.js";
import { render } from "./mail.js";
import { issueInvoice, writeDraft, type InvoiceInput } from "../routes/invoices.js";

export const INTERVAL_MONTHS: Record<RecurringInvoice["interval"], number> = { MONTHLY: 1, QUARTERLY: 3, HALFYEARLY: 6, YEARLY: 12 };
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

/** Monate addieren, Tag auf den Wunschtag (anchor) bzw. Monatsende begrenzen */
export function addMonths(iso: string, months: number, anchorDay: number): string {
  const [y, m] = iso.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const d = Math.min(anchorDay, last);
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function periodOf(r: Pick<RecurringInvoice, "interval" | "anchorDay">, start: string) {
  const end = addDays(addMonths(start, INTERVAL_MONTHS[r.interval], r.anchorDay), -1);
  const [y, m] = start.split("-").map(Number);
  return {
    start,
    end,
    vars: {
      month: String(m).padStart(2, "0"),
      monthName: MONTHS[m - 1],
      year: String(y),
      quarter: `Q${Math.floor((m - 1) / 3) + 1}`,
      periodStart: formatDate(start),
      periodEnd: formatDate(end),
      period: `${formatDate(start)} – ${formatDate(end)}`,
    },
  };
}

interface TemplateItem {
  productId?: string | null;
  name: string;
  description?: string | null;
  quantity: number;
  unit: string;
  unitPriceNet: number;
  taxRate: number;
  discountBps?: number;
}

const fill = (t: string | null | undefined, vars: Record<string, string>) => (t ? render(t, vars) : null);

/** Eine Rechnung für den Zeitraum ab `start` erzeugen. Gibt die Rechnungs-ID zurück. */
export async function createFromTemplate(r: RecurringInvoice, start: string) {
  const p = periodOf(r, start);
  const items = (r.items as TemplateItem[]).map((i) => ({
    productId: i.productId ?? null,
    name: render(i.name, p.vars),
    description: fill(i.description, p.vars),
    quantity: i.quantity,
    unit: i.unit,
    unitPriceNet: i.unitPriceNet,
    taxRate: i.taxRate,
    discountBps: i.discountBps ?? 0,
  }));
  const input: InvoiceInput = {
    customerId: r.customerId,
    issueDate: null,
    serviceDateFrom: r.servicePeriod ? p.start : null,
    serviceDateTo: r.servicePeriod ? p.end : null,
    dueDate: null,
    subject: fill(r.subject, p.vars),
    introText: fill(r.introText, p.vars),
    footerText: null,
    notes: fill(r.notes, p.vars),
    discountId: r.discountId,
    taxExemption: r.taxExemption,
    items,
  };
  return db.transaction((tx) => writeDraft(tx, input, null, null, { recurringId: r.id }));
}

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

/** Fällige Vorlagen abarbeiten (verpasste Zeiträume werden nachgeholt, max. 24 je Lauf) */
export async function runRecurring(log: Log, onlyId?: string) {
  const t = today();
  const due = await db
    .select()
    .from(schema.recurringInvoices)
    .where(onlyId ? eq(schema.recurringInvoices.id, onlyId) : and(eq(schema.recurringInvoices.active, true), lte(schema.recurringInvoices.nextDate, t)));
  const created: string[] = [];
  for (const tpl of due) {
    let r = tpl;
    let guard = 0;
    // manuell ausgelöst: genau ein Zeitraum, sonst alle fälligen
    while ((onlyId ? guard === 0 : r.nextDate <= t) && guard < 24) {
      guard++;
      if (r.endDate && r.nextDate > r.endDate) break;
      let invoiceId: string | null = null;
      let error: string | null = null;
      try {
        invoiceId = await createFromTemplate(r, r.nextDate);
        created.push(invoiceId);
        if (r.autoIssue) {
          const res = await issueInvoice(invoiceId, true);
          if (res.mail && !res.mail.ok && res.mail.error) error = `Rechnung ausgestellt, Mail fehlgeschlagen: ${res.mail.error}`;
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      if (!invoiceId) {
        await db.update(schema.recurringInvoices).set({ lastError: error }).where(eq(schema.recurringInvoices.id, r.id));
        log.warn({ recurringId: r.id, err: error }, "Abo-Rechnung fehlgeschlagen");
        break;
      }
      // Zeitraum gilt als abgerechnet, auch wenn das Ausstellen scheiterte (Entwurf liegt dann vor)
      const next = addMonths(r.nextDate, INTERVAL_MONTHS[r.interval], r.anchorDay);
      const ended = !!r.endDate && next > r.endDate;
      [r] = await db
        .update(schema.recurringInvoices)
        .set({
          nextDate: next,
          runCount: r.runCount + 1,
          lastRunAt: new Date(),
          lastInvoiceId: invoiceId,
          lastError: error,
          active: ended ? false : r.active,
        })
        .where(eq(schema.recurringInvoices.id, r.id))
        .returning();
      if (error) log.warn({ recurringId: r.id, err: error }, "Abo-Rechnung mit Problem");
    }
  }
  if (created.length) log.info({ count: created.length }, "Abo-Rechnungen erzeugt");
  return created;
}
