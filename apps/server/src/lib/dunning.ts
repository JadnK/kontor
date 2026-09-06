/**
 * Mahnwesen: nach den Zahlungserinnerungen folgen konfigurierbare Mahnstufen mit
 * Mahngebühr, Verzugszinsen (§ 288 Abs. 1/2 BGB: Basiszins + 5 bzw. + 9 Prozentpunkte)
 * und bei Firmenkunden der Verzugspauschale von 40 € (§ 288 Abs. 5 BGB).
 */
import { desc, eq, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { Invoice } from "../db/schema.js";
import { badRequest, formatDate, addDays, today } from "./http.js";
import { formatMoney } from "./calc.js";
import { invoiceFileBase, invoiceVars, loadInvoiceDoc, type CustomerSnapshot } from "./invoice-service.js";
import { mailReady, render, sendMail } from "./mail.js";
import { renderInvoicePdf, type DunningInfo } from "./pdf.js";
import { getSettings, type Settings } from "./settings.js";

const FLAT_FEE = 4000;

const daysBetween = (from: string, to: string) => Math.max(0, Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000));

/** Firmenkunde → höherer Zinssatz und Pauschale */
function isBusiness(inv: Invoice, fallback: CustomerSnapshot | null) {
  const c = (inv.customerSnapshot as CustomerSnapshot | null) ?? fallback;
  return c?.type === "COMPANY";
}

export async function computeDunning(inv: Invoice, s: Settings, level: number, customer: CustomerSnapshot | null): Promise<DunningInfo> {
  const step = s.automation.dunningSteps[level - 1];
  if (!step) throw badRequest("Keine weitere Mahnstufe eingerichtet (Einstellungen → Automatik)");
  const open = inv.totalGross - inv.paidTotal;
  const prev = (await db.select().from(schema.dunnings).where(eq(schema.dunnings.invoiceId, inv.id)).orderBy(desc(schema.dunnings.level)))[0];
  const business = isBusiness(inv, customer);
  const date = today();
  let interest = 0;
  let interestRate: number | null = null;
  let interestDays: number | null = null;
  if (step.interest && inv.dueDate) {
    interestRate = Math.round((s.automation.baseRate + (business ? 9 : 5)) * 100) / 100;
    interestDays = daysBetween(inv.dueDate, date);
    if (interestRate > 0 && interestDays > 0) interest = Math.round((open * interestRate * interestDays) / 100 / 365);
  }
  const fees = (prev?.fees ?? 0) + step.fee;
  const flatFee = prev?.flatFee ? prev.flatFee : business && s.automation.b2bFlatFee ? FLAT_FEE : 0;
  return {
    label: step.label,
    level,
    date,
    open,
    fees,
    interest,
    interestRate: interest ? interestRate : null,
    interestDays: interest ? interestDays : null,
    flatFee,
    claim: open + fees + interest + flatFee,
    payUntil: addDays(date, s.automation.dunningPayDays),
  };
}

function checkMahnbar(inv: Invoice | undefined): asserts inv is Invoice {
  if (!inv) throw badRequest("Rechnung nicht gefunden");
  if (inv.kind !== "INVOICE" || inv.status !== "ISSUED") throw badRequest("Nur offene Rechnungen können gemahnt werden");
  if (inv.totalGross - inv.paidTotal <= 0) throw badRequest("Die Rechnung ist bereits bezahlt");
  if (inv.dueDate && inv.dueDate >= today()) throw badRequest("Die Rechnung ist noch nicht fällig");
}

/** Vorschau der nächsten Mahnstufe (für die Rechnungsansicht) */
export async function previewDunning(inv: Invoice): Promise<DunningInfo | null> {
  if (inv.kind !== "INVOICE" || inv.status !== "ISSUED" || inv.totalGross - inv.paidTotal <= 0) return null;
  if (!inv.dueDate || inv.dueDate >= today()) return null;
  const s = await getSettings();
  if (inv.dunningLevel >= s.automation.dunningSteps.length) return null;
  return computeDunning(inv, s, inv.dunningLevel + 1, null);
}

function feeLines(d: DunningInfo, cur: string) {
  const l: string[] = [];
  if (d.fees) l.push(`Mahngebühren: ${formatMoney(d.fees, cur)}`);
  if (d.interest) l.push(`Verzugszinsen (${d.interestRate?.toLocaleString("de-DE")} % p. a., ${d.interestDays} Tage): ${formatMoney(d.interest, cur)}`);
  if (d.flatFee) l.push(`Verzugspauschale nach § 288 Abs. 5 BGB: ${formatMoney(d.flatFee, cur)}`);
  return l.join("\n");
}

const fileLabel = (label: string) => label.replace(/[^\wäöüÄÖÜß.-]+/g, "_");

/** Nächste Mahnstufe festhalten und optional per Mail versenden */
export async function createDunning(invoiceId: string, send: boolean) {
  const s = await getSettings();
  const inv = (await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)))[0];
  checkMahnbar(inv);
  const level = inv.dunningLevel + 1;
  const doc = await loadInvoiceDoc(invoiceId);
  if (!doc) throw badRequest("Rechnung nicht gefunden");
  const info = await computeDunning(inv, s, level, doc.customer);

  let mail: { ok: boolean; error?: string; skipped?: string } | null = null;
  if (send) {
    if (!mailReady(s)) throw badRequest("E-Mail-Versand ist nicht eingerichtet – Mahnung ohne Versand erstellen und als PDF verschicken");
    if (!doc.customer.email) throw badRequest("Kunde hat keine E-Mail-Adresse – Mahnung ohne Versand erstellen");
    const cur = doc.invoiceSettings.currency;
    const vars = {
      ...invoiceVars(doc, doc.company.name || s.company.name),
      dunningLabel: info.label,
      claim: formatMoney(info.claim, cur),
      feeLines: feeLines(info, cur),
      payUntil: formatDate(info.payUntil),
    };
    const base = invoiceFileBase(doc);
    mail = await sendMail({
      kind: "dunning",
      to: doc.customer.email,
      subject: render(s.templates.dunning.subject, vars),
      text: render(s.templates.dunning.body, vars).replace(/\n{3,}/g, "\n\n"),
      attachments: [
        { filename: `${fileLabel(info.label)}_${base}.pdf`, content: await renderInvoicePdf(doc, { dunning: info }), contentType: "application/pdf" },
        { filename: `${base}.pdf`, content: await renderInvoicePdf(doc), contentType: "application/pdf" },
      ],
      invoiceId,
      customerId: inv.customerId,
    });
    if (!mail.ok) throw badRequest(`Mahnung nicht versendet: ${mail.error ?? mail.skipped}`);
  }
  const [row] = await db
    .insert(schema.dunnings)
    .values({ invoiceId, ...info, sentAt: send ? new Date() : null })
    .returning();
  await db
    .update(schema.invoices)
    .set({ dunningLevel: level, lastReminderAt: new Date(), reminderCount: dsql`${schema.invoices.reminderCount} + 1` })
    .where(eq(schema.invoices.id, invoiceId));
  return { dunning: row, mail };
}

export async function dunningPdf(dunningId: string) {
  const d = (await db.select().from(schema.dunnings).where(eq(schema.dunnings.id, dunningId)))[0];
  if (!d) return null;
  const doc = await loadInvoiceDoc(d.invoiceId);
  if (!doc) return null;
  const info: DunningInfo = {
    label: d.label,
    level: d.level,
    date: (d.sentAt ?? d.createdAt).toISOString().slice(0, 10),
    open: d.open,
    fees: d.fees,
    interest: d.interest,
    interestRate: d.interestRate,
    interestDays: d.interestDays,
    flatFee: d.flatFee,
    claim: d.claim,
    payUntil: d.payUntil,
  };
  // Darstellung mit dem Stand zum Zeitpunkt der Mahnung
  doc.invoice = { ...doc.invoice, paidTotal: doc.invoice.totalGross - d.open };
  return { pdf: await renderInvoicePdf(doc, { dunning: info }), filename: `${fileLabel(d.label)}_${invoiceFileBase(doc)}.pdf` };
}

/** Für den Zahlungsabgleich: Gesamtforderungen der letzten Mahnung je Rechnung */
export async function claimsByInvoice(): Promise<Map<string, number>> {
  const rows = await db
    .select({ invoiceId: schema.dunnings.invoiceId, claim: schema.dunnings.claim, level: schema.dunnings.level })
    .from(schema.dunnings)
    .innerJoin(schema.invoices, eq(schema.invoices.id, schema.dunnings.invoiceId))
    .where(eq(schema.invoices.status, "ISSUED"));
  const m = new Map<string, { claim: number; level: number }>();
  for (const r of rows) if (!m.has(r.invoiceId) || m.get(r.invoiceId)!.level < r.level) m.set(r.invoiceId, r);
  return new Map([...m].map(([k, v]) => [k, v.claim]));
}

/** Automatische Mahnungen (wenn eingeschaltet) */
export async function runAutoDunning(log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }) {
  const s = await getSettings();
  const a = s.automation;
  if (!a.dunningAuto || !a.dunningSteps.length || !mailReady(s)) return 0;
  const candidates = await db
    .select()
    .from(schema.invoices)
    .where(
      dsql`${schema.invoices.status} = 'ISSUED' and ${schema.invoices.kind} = 'INVOICE' and ${schema.invoices.totalGross} > ${schema.invoices.paidTotal}
        and ${schema.invoices.dueDate} < ${today()} and ${schema.invoices.reminderCount} >= ${a.maxReminders}
        and ${schema.invoices.dunningLevel} < ${a.dunningSteps.length}`,
    );
  let sent = 0;
  for (const inv of candidates) {
    const step = a.dunningSteps[inv.dunningLevel];
    const since = inv.lastReminderAt ? inv.lastReminderAt.toISOString().slice(0, 10) : inv.dueDate!;
    if (daysBetween(since, today()) < step.days) continue;
    try {
      await createDunning(inv.id, true);
      sent++;
    } catch (e) {
      log.warn({ invoiceId: inv.id, err: e instanceof Error ? e.message : e }, "Mahnung fehlgeschlagen");
    }
  }
  if (sent) log.info({ sent }, "Mahnungen versendet");
  return sent;
}
