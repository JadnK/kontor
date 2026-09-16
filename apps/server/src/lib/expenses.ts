/**
 * Ausgaben: von Hand mit Beleg oder direkt aus Abbuchungen des Kontoauszugs/Kontoabrufs.
 * Kontor merkt sich, welcher Empfänger zu welcher Kategorie gehört, und bucht bekannte Abbuchungen automatisch.
 */
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db, schema } from "../db/index.js";
import type { BankTransaction } from "../db/schema.js";
import { getSettings, putSection } from "./settings.js";

/** "Hetzner Online GmbH" → "hetzner online" */
export function supplierKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(gmbh|ag|kg|ug|ohg|gbr|e\.?\s?k\.?|mbh|co|inc|ltd|llc|sarl|bv|s\.?a\.?|se|haftungsbeschränkt)\b/g, " ")
    .replace(/[^a-z0-9äöüß]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
}

export function taxOf(gross: number, rate: number) {
  return rate > 0 ? Math.round(gross - gross / (1 + rate / 100)) : 0;
}

export async function learnSupplier(supplier: string, category: string) {
  const key = supplierKey(supplier);
  if (!key) return;
  const s = await getSettings();
  if (s.expenses.supplierCategories[key] === category) return;
  await putSection("expenses", { ...s.expenses, supplierCategories: { ...s.expenses.supplierCategories, [key]: category } });
}

export async function guessCategory(supplier: string): Promise<string | null> {
  const s = await getSettings();
  return s.expenses.supplierCategories[supplierKey(supplier)] ?? null;
}

/** Steuersatz der letzten Ausgabe beim selben Empfänger (sonst Standard) */
async function lastTaxRate(supplier: string) {
  const key = supplierKey(supplier);
  const rows = await db.select({ supplier: schema.expenses.supplier, taxRate: schema.expenses.taxRate }).from(schema.expenses).orderBy(desc(schema.expenses.date)).limit(500);
  return rows.find((r) => supplierKey(r.supplier) === key)?.taxRate ?? null;
}

const supplierOf = (tx: BankTransaction) => tx.counterpartyName || tx.purpose?.slice(0, 60) || "Unbekannt";

/** Abbuchung als Ausgabe buchen (atomar: nur wenn noch offen) */
export async function bookDebit(
  tx: BankTransaction,
  opts: { category: string; taxRate: number; supplier?: string | null; description?: string | null; userId: string | null; note?: string },
) {
  if (tx.amount >= 0) throw new Error("Nur Abbuchungen können als Ausgabe gebucht werden");
  const s = await getSettings();
  if (!s.expenses.categories.some((c) => c.name === opts.category)) throw new Error("Unbekannte Kategorie");
  const gross = Math.abs(tx.amount);
  const supplier = opts.supplier?.trim() || supplierOf(tx);
  return db.transaction(async (t) => {
    const claim = await t
      .update(schema.bankTransactions)
      .set({ status: "MATCHED", matchNote: opts.note ?? `Als Ausgabe gebucht (${opts.category})` })
      .where(and(eq(schema.bankTransactions.id, tx.id), inArray(schema.bankTransactions.status, ["UNMATCHED", "SUGGESTED"])))
      .returning({ id: schema.bankTransactions.id });
    if (!claim.length) return null;
    const [row] = await t
      .insert(schema.expenses)
      .values({
        date: tx.bookingDate,
        supplier,
        description: opts.description ?? tx.purpose ?? null,
        category: opts.category,
        amountGross: gross,
        taxRate: opts.taxRate,
        taxAmount: taxOf(gross, opts.taxRate),
        paymentMethod: "Überweisung",
        bankTransactionId: tx.id,
        createdById: opts.userId,
      })
      .returning({ id: schema.expenses.id });
    return row.id;
  });
}

/** Abbuchungen mit bekanntem Empfänger automatisch als Ausgabe buchen */
export async function autoBookDebits(ids: string[], log: FastifyBaseLogger | { info: (o: object, m: string) => void }) {
  if (!ids.length) return 0;
  const s = await getSettings();
  if (!s.expenses.autoBookKnown) return 0;
  const txs = await db
    .select()
    .from(schema.bankTransactions)
    .where(and(inArray(schema.bankTransactions.id, ids), lt(schema.bankTransactions.amount, 0), eq(schema.bankTransactions.status, "UNMATCHED")));
  let booked = 0;
  for (const tx of txs) {
    const sup = supplierOf(tx);
    const cat = await guessCategory(sup);
    if (!cat || !s.expenses.categories.some((c) => c.name === cat)) continue;
    const rate = (await lastTaxRate(sup)) ?? (s.invoice.smallBusiness ? 19 : 19);
    if (await bookDebit(tx, { category: cat, taxRate: rate, userId: null, note: `Automatisch als Ausgabe gebucht (${cat}, bekannter Empfänger)` })) booked++;
  }
  if (booked) log.info({ booked }, "Abbuchungen automatisch als Ausgaben gebucht");
  return booked;
}
