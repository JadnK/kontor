import { and, eq, gt, isNotNull, lt, sql as dsql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db, schema } from "../db/index.js";
import { formatDiscount, formatMoney } from "./calc.js";
import { addDays, formatDate, today } from "./http.js";
import { customerGreetingName, invoiceFileBase, invoiceVars, loadInvoiceDoc, snapshotCustomer } from "./invoice-service.js";
import { render, sendMail, mailReady, type MailAttachment } from "./mail.js";
import { renderInvoicePdf } from "./pdf.js";
import { getSettings } from "./settings.js";
import { renderXRechnung } from "./xrechnung.js";
import { runAutoDunning } from "./dunning.js";
import { remindDeadlines } from "./contracts.js";
import { runRecurring } from "./recurring.js";
import { linkVars, pdfPayUrl, withPayHint } from "./portal.js";

type Kind = "invoice" | "reminder" | "cancellation";

export interface SendResult {
  ok: boolean;
  skipped?: string;
  error?: string;
}

/** Rechnung (oder Storno/Erinnerung) mit PDF und optional XRechnung an den Kunden schicken */
export async function sendInvoiceMail(invoiceId: string, kind: Kind, overrideTo?: string): Promise<SendResult> {
  const s = await getSettings();
  if (!mailReady(s)) return { ok: false, skipped: "E-Mail-Versand ist nicht eingerichtet" };
  const doc = await loadInvoiceDoc(invoiceId);
  if (!doc) return { ok: false, error: "Rechnung nicht gefunden" };
  const to = overrideTo || doc.customer.email;
  if (!to) return { ok: false, skipped: "Kunde hat keine E-Mail-Adresse" };

  const companyName = doc.company.name || s.company.name || s.mail.fromName;
  const tpl = s.templates[kind];
  const vars = { ...invoiceVars(doc, companyName), ...(await linkVars(doc, s, tpl.subject + tpl.body)) };
  const base = invoiceFileBase(doc);
  const payUrl = kind === "cancellation" ? null : await pdfPayUrl(doc, s);
  const attachments: MailAttachment[] = [
    { filename: `${base}.pdf`, content: await renderInvoicePdf(doc, { payUrl }), contentType: "application/pdf" },
  ];
  if (doc.invoiceSettings.attachXRechnung) {
    attachments.push({ filename: `${base}.xml`, content: Buffer.from(renderXRechnung(doc), "utf8"), contentType: "application/xml" });
  }
  const res = await sendMail({
    kind,
    to,
    subject: render(tpl.subject, vars),
    text: kind === "cancellation" ? render(tpl.body, vars) : withPayHint(render(tpl.body, vars), tpl.body, vars, s),
    attachments,
    invoiceId,
    customerId: doc.invoice.customerId,
  });
  if (res.ok && kind === "invoice") {
    await db.update(schema.invoices).set({ sentAt: new Date() }).where(eq(schema.invoices.id, invoiceId));
  }
  if (res.ok && kind === "reminder") {
    await db
      .update(schema.invoices)
      .set({ reminderCount: dsql`${schema.invoices.reminderCount} + 1`, lastReminderAt: new Date() })
      .where(eq(schema.invoices.id, invoiceId));
  }
  return res;
}

export async function onInvoiceIssued(invoiceId: string, log: FastifyBaseLogger) {
  const s = await getSettings();
  if (!s.automation.sendInvoiceOnIssue) return;
  const r = await sendInvoiceMail(invoiceId, "invoice");
  if (r.error) log.warn({ invoiceId, err: r.error }, "Rechnungsmail fehlgeschlagen");
}

export async function onInvoiceCancelled(cancellationId: string, log: FastifyBaseLogger) {
  const s = await getSettings();
  if (!s.automation.sendInvoiceOnIssue) return;
  const r = await sendInvoiceMail(cancellationId, "cancellation");
  if (r.error) log.warn({ cancellationId, err: r.error }, "Stornomail fehlgeschlagen");
}

/** Zahlungsbestätigung. Gibt true zurück, wenn eine Mail verschickt wurde. */
export async function onPayment(invoiceId: string, amount: number, log: FastifyBaseLogger): Promise<boolean> {
  const s = await getSettings();
  if (!s.automation.sendPaymentConfirmation || !mailReady(s)) return false;
  const doc = await loadInvoiceDoc(invoiceId);
  if (!doc?.customer.email) return false;
  // Rest offen → Teilzahlungs-Vorlage mit Restbetrag, sonst normale Bestätigung
  const partial = doc.invoice.totalGross - doc.invoice.paidTotal > 0;
  const tpl = partial ? s.templates.partialPayment : s.templates.payment;
  const vars = { ...invoiceVars(doc, doc.company.name || s.company.name), ...(await linkVars(doc, s, tpl.body)), amount: formatMoney(amount, doc.invoiceSettings.currency) };
  const r = await sendMail({
    kind: "payment",
    to: doc.customer.email,
    subject: render(tpl.subject, vars),
    text: partial ? withPayHint(render(tpl.body, vars), tpl.body, vars, s) : render(tpl.body, vars),
    invoiceId,
    customerId: doc.invoice.customerId,
  });
  if (r.error) log.warn({ invoiceId, err: r.error }, "Zahlungsbestätigung fehlgeschlagen");
  return r.ok;
}

export async function sendDiscountNotice(discountId: string): Promise<SendResult> {
  const s = await getSettings();
  if (!mailReady(s)) return { ok: false, skipped: "E-Mail-Versand ist nicht eingerichtet" };
  const d = (await db.select().from(schema.discounts).where(eq(schema.discounts.id, discountId)))[0];
  if (!d || d.scope !== "CUSTOMER" || !d.customerId) return { ok: false, skipped: "Rabatt ist keinem Kunden zugeordnet" };
  const c = (await db.select().from(schema.customers).where(eq(schema.customers.id, d.customerId)))[0];
  if (!c?.email) return { ok: false, skipped: "Kunde hat keine E-Mail-Adresse" };
  const vars = {
    customerName: customerGreetingName(snapshotCustomer(c)),
    customerNumber: c.number,
    companyName: s.company.name,
    discountName: d.name,
    discountValue: formatDiscount(d, s.invoice.currency),
    discountCode: d.code ?? "",
    discountCodeLine: d.code ? `\nIhr Rabattcode: ${d.code}` : "",
    discountValidLine: d.validTo ? `\nGültig bis ${formatDate(d.validTo)}.` : "",
  };
  const r = await sendMail({
    kind: "discount",
    to: c.email,
    subject: render(s.templates.discount.subject, vars),
    text: render(s.templates.discount.body, vars),
    customerId: c.id,
  });
  if (r.ok) await db.update(schema.discounts).set({ notifiedAt: new Date() }).where(eq(schema.discounts.id, d.id));
  return r;
}

export async function onDiscountCreated(discountId: string, log: FastifyBaseLogger) {
  const s = await getSettings();
  if (!s.automation.sendDiscountNotice) return;
  const r = await sendDiscountNotice(discountId);
  if (r.error) log.warn({ discountId, err: r.error }, "Rabatt-Mail fehlgeschlagen");
}

export async function onCustomerCreated(customerId: string, log: FastifyBaseLogger) {
  const s = await getSettings();
  if (!s.automation.sendWelcome || !mailReady(s)) return;
  const c = (await db.select().from(schema.customers).where(eq(schema.customers.id, customerId)))[0];
  if (!c?.email) return;
  const vars = { customerName: customerGreetingName(snapshotCustomer(c)), customerNumber: c.number, companyName: s.company.name };
  const r = await sendMail({
    kind: "welcome",
    to: c.email,
    subject: render(s.templates.welcome.subject, vars),
    text: render(s.templates.welcome.body, vars),
    customerId: c.id,
  });
  if (r.error) log.warn({ customerId, err: r.error }, "Willkommensmail fehlgeschlagen");
}

/** Überfällige Rechnungen erinnern. Läuft periodisch. */
export async function runReminders(log: FastifyBaseLogger): Promise<number> {
  const s = await getSettings();
  const a = s.automation;
  if (!a.sendReminders || a.maxReminders === 0 || !mailReady(s)) return 0;
  const dueBefore = addDays(today(), -a.reminderAfterDays);
  const repeatBefore = new Date(Date.now() - a.reminderRepeatDays * 86_400_000);

  const candidates = await db
    .select({ id: schema.invoices.id, last: schema.invoices.lastReminderAt })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.status, "ISSUED"),
        eq(schema.invoices.kind, "INVOICE"),
        isNotNull(schema.invoices.dueDate),
        lt(schema.invoices.dueDate, dueBefore),
        lt(schema.invoices.reminderCount, a.maxReminders),
        gt(schema.invoices.totalGross, schema.invoices.paidTotal),
      ),
    );
  let sent = 0;
  for (const c of candidates) {
    if (c.last && c.last > repeatBefore) continue;
    const r = await sendInvoiceMail(c.id, "reminder");
    if (r.ok) sent++;
    else if (r.error) log.warn({ invoiceId: c.id, err: r.error }, "Zahlungserinnerung fehlgeschlagen");
  }
  if (sent) log.info({ sent }, "Zahlungserinnerungen versendet");
  return sent;
}

export function startScheduler(log: FastifyBaseLogger, minutes: number) {
  const tick = async () => {
    await runRecurring(log).catch((e) => log.error(e, "Abo-Rechnungen fehlgeschlagen"));
    await runReminders(log).catch((e) => log.error(e, "Erinnerungslauf fehlgeschlagen"));
    await runAutoDunning(log).catch((e) => log.error(e, "Mahnlauf fehlgeschlagen"));
    await remindDeadlines(log).catch((e) => log.error(e, "Vertragserinnerung fehlgeschlagen"));
  };
  setTimeout(tick, 30_000);
  return setInterval(tick, Math.max(5, minutes) * 60_000);
}
