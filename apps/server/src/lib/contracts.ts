/**
 * Vertragslogik: Laufzeiten, Kündigungsfristen, monatlicher Wert und Prognose.
 * Alle Datumswerte sind ISO-Strings (YYYY-MM-DD), gerechnet wird in UTC.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db, schema } from "../db/index.js";
import type { Contract } from "../db/schema.js";
import { formatMoney } from "./calc.js";
import { formatDate, today } from "./http.js";
import { getSettings, getState, setState } from "./settings.js";
import { mailReady, sendMail } from "./mail.js";

export interface ContractItem {
  name: string;
  description?: string | null;
  quantity: number;
  unit: string;
  unitPriceNet: number;
  taxRate: number;
  discountBps?: number;
  productId?: string | null;
}

const MONTHS: Record<Contract["interval"], number> = { MONTHLY: 1, QUARTERLY: 3, HALFYEARLY: 6, YEARLY: 12 };

const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);

/** Monate addieren; der Tag bleibt erhalten, kurze Monate werden auf den Monatsletzten gekürzt */
export function addMonthsIso(iso: string, months: number): string {
  const d = toDate(iso);
  const day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return toIso(t);
}

export function addDaysIso(iso: string, days: number): string {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

/** Netto je Abrechnungsintervall */
export function netPerInterval(items: ContractItem[]): number {
  return items.reduce((a, i) => {
    const line = Math.round(i.quantity * i.unitPriceNet);
    return a + line - Math.round((line * (i.discountBps ?? 0)) / 10000);
  }, 0);
}

export function grossPerInterval(items: ContractItem[], smallBusiness: boolean): number {
  return items.reduce((a, i) => {
    const line = Math.round(i.quantity * i.unitPriceNet);
    const net = line - Math.round((line * (i.discountBps ?? 0)) / 10000);
    return a + (smallBusiness ? net : net + Math.round((net * i.taxRate) / 100));
  }, 0);
}

/** Monatlicher Netto-Wert (z. B. 120 €/Quartal → 40 €/Monat) */
export function monthlyNet(c: Pick<Contract, "items" | "interval">): number {
  return Math.round(netPerInterval(c.items as ContractItem[]) / MONTHS[c.interval]);
}

/** Kündigungsfrist vor einem Stichtag zurückrechnen */
function minusNotice(iso: string, c: Pick<Contract, "noticeValue" | "noticeUnit">) {
  // z. B. 3 Monate zum 31.12. → Zugang spätestens 30.09.
  if (c.noticeUnit === "MONTHS") return addDaysIso(addMonthsIso(addDaysIso(iso, 1), -c.noticeValue), -1);
  return addDaysIso(iso, -(c.noticeValue * (c.noticeUnit === "WEEKS" ? 7 : 1)));
}

/**
 * Laufzeitenden ab Vertragsbeginn: erst Mindestlaufzeit, danach je Verlängerung.
 * Ohne Mindestlaufzeit und Verlängerung gibt es keine festen Enden (jederzeit mit Frist kündbar).
 */
function termEnds(c: Pick<Contract, "startDate" | "minTermMonths" | "renewalMonths">, after: string, max = 400): string[] {
  const out: string[] = [];
  if (c.minTermMonths <= 0 && c.renewalMonths <= 0) return out;
  let months = c.minTermMonths > 0 ? c.minTermMonths : c.renewalMonths;
  for (let i = 0; i < max; i++) {
    const end = addDaysIso(addMonthsIso(c.startDate, months), -1);
    if (end >= after) out.push(end);
    if (out.length >= 3) break;
    if (c.minTermMonths > 0 && c.renewalMonths <= 0 && months >= c.minTermMonths) {
      // nach der Mindestlaufzeit monatlich kündbar
      months += 1;
    } else months += c.renewalMonths > 0 ? c.renewalMonths : 1;
  }
  return out;
}

/**
 * Frühestmögliches Vertragsende, wenn heute (bzw. am Tag des Zugangs) gekündigt wird,
 * und der letzte Tag, an dem die Kündigung zugehen muss.
 */
export function earliestEnd(c: Contract, noticeDate = today()): { end: string; deadline: string } {
  if (c.endDate) return { end: c.endDate, deadline: minusNotice(c.endDate, c) };
  const ends = termEnds(c, noticeDate);
  for (const e of ends) {
    const dl = minusNotice(e, c);
    if (dl >= noticeDate) return { end: e, deadline: dl };
  }
  // jederzeit kündbar: Frist ab Zugang, Ende zum Monatsletzten bei Monatsfristen
  let end: string;
  if (c.noticeUnit === "MONTHS") {
    const raw = addMonthsIso(noticeDate, c.noticeValue);
    const d = toDate(raw);
    end = toIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
  } else end = addDaysIso(noticeDate, c.noticeValue * (c.noticeUnit === "WEEKS" ? 7 : 1));
  return { end, deadline: noticeDate };
}

/** Effektiver Status (abgelaufene Verträge gelten als beendet) */
export function effectiveStatus(c: Pick<Contract, "status" | "endDate">, on = today()): Contract["status"] {
  if (c.status === "DRAFT") return "DRAFT";
  if (c.endDate && c.endDate < on) return "ENDED";
  return c.status;
}

/** Läuft der Vertrag (zumindest teilweise) im Monat? */
function activeInMonth(c: Contract, monthStart: string, monthEnd: string) {
  if (c.status === "DRAFT") return false;
  return c.startDate <= monthEnd && (!c.endDate || c.endDate >= monthStart);
}

export function describe(c: Contract, on = today()) {
  const status = effectiveStatus(c, on);
  const items = c.items as ContractItem[];
  const running = status === "ACTIVE";
  const ee = running ? earliestEnd(c, on) : null;
  const minTermEnd = c.minTermMonths > 0 ? addDaysIso(addMonthsIso(c.startDate, c.minTermMonths), -1) : null;
  return {
    status,
    netPerInterval: netPerInterval(items),
    monthlyNet: monthlyNet(c),
    minTermEnd,
    /** Bei Kündigung heute endet der Vertrag am … */
    earliestEnd: ee?.end ?? c.endDate,
    /** Kündigung muss spätestens am … zugehen (für das frühestmögliche Ende) */
    noticeDeadline: ee?.deadline ?? null,
  };
}

/** Kennzahlen und Prognose für die Übersicht */
export function summarize(list: Contract[], on = today()) {
  const active = list.filter((c) => effectiveStatus(c, on) === "ACTIVE" || effectiveStatus(c, on) === "CANCELLED");
  const mrr = active.reduce((a, c) => a + monthlyNet(c), 0);
  // Prognose der nächsten 12 Monate (berücksichtigt Beginn und Ende)
  const first = toDate(`${on.slice(0, 7)}-01`);
  const forecast = Array.from({ length: 12 }, (_, i) => {
    const ms = toIso(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1)));
    const me = toIso(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i + 1, 0)));
    const sum = list.filter((c) => activeInMonth(c, ms, me)).reduce((a, c) => a + monthlyNet(c), 0);
    return { month: ms.slice(0, 7), net: sum };
  });
  const byCustomer = new Map<string, number>();
  for (const c of active) byCustomer.set(c.customerId, (byCustomer.get(c.customerId) ?? 0) + monthlyNet(c));
  return {
    mrr,
    arr: mrr * 12,
    activeCount: list.filter((c) => effectiveStatus(c, on) === "ACTIVE").length,
    cancelledCount: list.filter((c) => effectiveStatus(c, on) === "CANCELLED").length,
    customers: byCustomer.size,
    forecast,
    byCustomer,
  };
}

/** Erinnerung an bald ablaufende Kündigungsfristen (einmal je Vertrag und Frist) */
export async function remindDeadlines(log: FastifyBaseLogger) {
  const s = await getSettings();
  if (!s.contracts.remindByMail || !s.contracts.remindDays || !mailReady(s) || !s.company.email) return 0;
  const on = today();
  const limit = addDaysIso(on, s.contracts.remindDays);
  const rows = await db.select().from(schema.contracts).where(inArray(schema.contracts.status, ["ACTIVE"]));
  const sent = await getState<Record<string, string>>("contracts:reminded", {});
  const due = rows
    .map((c) => ({ c, d: describe(c, on) }))
    .filter(({ c, d }) => d.status === "ACTIVE" && !c.endDate && d.noticeDeadline && d.noticeDeadline <= limit && sent[c.id] !== d.noticeDeadline);
  if (!due.length) return 0;
  const customers = await db
    .select({ id: schema.customers.id, company: schema.customers.company, firstName: schema.customers.firstName, lastName: schema.customers.lastName })
    .from(schema.customers)
    .where(inArray(schema.customers.id, [...new Set(due.map((x) => x.c.customerId))]));
  const name = (id: string) => {
    const c = customers.find((x) => x.id === id);
    return c ? c.company || [c.firstName, c.lastName].filter(Boolean).join(" ") : "";
  };
  const lines = due.map(
    ({ c, d }) => `- ${c.number} ${c.title} (${name(c.customerId)}): Kündigung bis ${formatDate(d.noticeDeadline)} für Ende ${formatDate(d.earliestEnd)}, ${formatMoney(d.monthlyNet, s.invoice.currency)}/Monat`,
  );
  const r = await sendMail({
    kind: "contract",
    to: s.company.email,
    subject: due.length === 1 ? `Kündigungsfrist läuft ab: ${due[0].c.title}` : `${due.length} Kündigungsfristen laufen bald ab`,
    text: `Bei diesen Verträgen endet bald die Kündigungsfrist. Ohne Kündigung verlängern sie sich automatisch.\n\n${lines.join("\n")}\n\nKontor`,
  });
  if (r.ok) {
    for (const { c, d } of due) sent[c.id] = d.noticeDeadline!;
    await setState("contracts:reminded", sent);
  } else log.warn({ err: r.error }, "Vertragserinnerung fehlgeschlagen");
  return due.length;
}

/** Abo-Rechnung an den Vertrag angleichen (Positionen, Intervall, Ende) */
export async function syncRecurring(c: Contract) {
  if (!c.recurringId) return;
  const st = effectiveStatus(c);
  await db
    .update(schema.recurringInvoices)
    .set({
      name: `${c.number} ${c.title}`,
      interval: c.interval,
      items: c.items,
      endDate: c.endDate,
      active: st === "ACTIVE" || st === "CANCELLED",
      updatedAt: new Date(),
    })
    .where(and(eq(schema.recurringInvoices.id, c.recurringId)));
}
