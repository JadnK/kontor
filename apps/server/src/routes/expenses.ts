import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, gte, ilike, lte, or, sql as dsql, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { badRequest, currentUser, isoDate, notFound, optStr, parse } from "../lib/http.js";
import { getSettings } from "../lib/settings.js";
import { guessCategory, learnSupplier, taxOf } from "../lib/expenses.js";

const receiptInput = z
  .object({ name: z.string().trim().min(1).max(200), type: z.string().max(100).optional(), data: z.string().min(1) })
  .nullish();

const expenseInput = z.object({
  date: isoDate,
  supplier: z.string().trim().min(1, "Empfänger/Lieferant fehlt").max(200),
  description: optStr,
  category: z.string().min(1, "Kategorie wählen"),
  amountGross: z.number().int().positive("Betrag muss größer 0 sein"),
  taxRate: z.number().min(0).max(100),
  /** leer = aus Brutto und Satz berechnen */
  taxAmount: z.number().int().min(0).nullish(),
  paymentMethod: z.string().trim().min(1).default("Überweisung"),
  invoiceNumber: optStr,
  notes: optStr,
  /** Beleg als base64; null = Beleg entfernen, weglassen = unverändert */
  receipt: receiptInput,
});

const ALLOWED = /^(application\/pdf|image\/(png|jpe?g|webp|heic|gif))$/;
const listCols = {
  id: schema.expenses.id,
  date: schema.expenses.date,
  supplier: schema.expenses.supplier,
  description: schema.expenses.description,
  category: schema.expenses.category,
  amountGross: schema.expenses.amountGross,
  taxRate: schema.expenses.taxRate,
  taxAmount: schema.expenses.taxAmount,
  paymentMethod: schema.expenses.paymentMethod,
  invoiceNumber: schema.expenses.invoiceNumber,
  bankTransactionId: schema.expenses.bankTransactionId,
  receiptName: schema.expenses.receiptName,
  receiptType: schema.expenses.receiptType,
  notes: schema.expenses.notes,
  createdAt: schema.expenses.createdAt,
};

function receiptValues(r: z.infer<typeof receiptInput>) {
  if (r === undefined) return {};
  if (r === null) return { receipt: null, receiptName: null, receiptType: null };
  const buf = Buffer.from(r.data, "base64");
  if (buf.length > 15 * 1024 * 1024) throw badRequest("Beleg ist zu groß (max. 15 MB)");
  const type = r.type || (r.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");
  if (!ALLOWED.test(type)) throw badRequest("Beleg bitte als PDF oder Bild (JPG, PNG)");
  return { receipt: buf, receiptName: r.name, receiptType: type };
}

export async function expenseRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { from?: string; to?: string; category?: string; q?: string } }>("/api/expenses", async (req) => {
    currentUser(req);
    const { from, to, category, q } = req.query;
    const conds: (SQL | undefined)[] = [];
    if (from) conds.push(gte(schema.expenses.date, from));
    if (to) conds.push(lte(schema.expenses.date, to));
    if (category) conds.push(eq(schema.expenses.category, category));
    if (q?.trim()) {
      const p = `%${q.trim()}%`;
      conds.push(or(ilike(schema.expenses.supplier, p), ilike(schema.expenses.description, p), ilike(schema.expenses.invoiceNumber, p)));
    }
    const rows = await db
      .select({ ...listCols, hasReceipt: dsql<boolean>`${schema.expenses.receipt} is not null` })
      .from(schema.expenses)
      .where(and(...conds))
      .orderBy(desc(schema.expenses.date), desc(schema.expenses.createdAt))
      .limit(2000);
    return rows;
  });

  app.get<{ Querystring: { supplier?: string } }>("/api/expenses/suggest", async (req) => {
    currentUser(req);
    return { category: req.query.supplier ? await guessCategory(req.query.supplier) : null };
  });

  app.post("/api/expenses", { bodyLimit: 25 * 1024 * 1024 }, async (req) => {
    const me = currentUser(req);
    const b = parse(expenseInput, req.body);
    const s = await getSettings();
    if (!s.expenses.categories.some((c) => c.name === b.category)) throw badRequest("Unbekannte Kategorie");
    const { receipt, taxAmount, ...rest } = b;
    const [row] = await db
      .insert(schema.expenses)
      .values({ ...rest, taxAmount: taxAmount ?? taxOf(b.amountGross, b.taxRate), ...receiptValues(receipt), createdById: me.id })
      .returning({ id: schema.expenses.id });
    await learnSupplier(b.supplier, b.category);
    return row;
  });

  app.put<{ Params: { id: string } }>("/api/expenses/:id", { bodyLimit: 25 * 1024 * 1024 }, async (req) => {
    currentUser(req);
    const b = parse(expenseInput, req.body);
    const s = await getSettings();
    if (!s.expenses.categories.some((c) => c.name === b.category)) throw badRequest("Unbekannte Kategorie");
    const ex = (await db.select({ id: schema.expenses.id, bankTransactionId: schema.expenses.bankTransactionId, amountGross: schema.expenses.amountGross }).from(schema.expenses).where(eq(schema.expenses.id, req.params.id)))[0];
    if (!ex) throw notFound("Ausgabe");
    if (ex.bankTransactionId && ex.amountGross !== b.amountGross) throw badRequest("Der Betrag kommt aus dem Kontoauszug und kann nicht geändert werden");
    const { receipt, taxAmount, ...rest } = b;
    await db
      .update(schema.expenses)
      .set({ ...rest, taxAmount: taxAmount ?? taxOf(b.amountGross, b.taxRate), ...receiptValues(receipt) })
      .where(eq(schema.expenses.id, ex.id));
    await learnSupplier(b.supplier, b.category);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/expenses/:id", async (req) => {
    currentUser(req);
    const ex = (await db.select({ id: schema.expenses.id, bankTransactionId: schema.expenses.bankTransactionId }).from(schema.expenses).where(eq(schema.expenses.id, req.params.id)))[0];
    if (!ex) throw notFound("Ausgabe");
    await db.transaction(async (t) => {
      await t.delete(schema.expenses).where(eq(schema.expenses.id, ex.id));
      // Abbuchung wieder unter "Ausgaben zu prüfen"
      if (ex.bankTransactionId) {
        await t.update(schema.bankTransactions).set({ status: "UNMATCHED", matchNote: null }).where(eq(schema.bankTransactions.id, ex.bankTransactionId));
      }
    });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/expenses/:id/receipt", async (req, reply) => {
    currentUser(req);
    const r = (await db.select({ receipt: schema.expenses.receipt, name: schema.expenses.receiptName, type: schema.expenses.receiptType }).from(schema.expenses).where(eq(schema.expenses.id, req.params.id)))[0];
    if (!r?.receipt) throw notFound("Beleg");
    return reply
      .header("Content-Type", r.type ?? "application/octet-stream")
      .header("Content-Disposition", `attachment; filename="${encodeURIComponent(r.name ?? "beleg")}"; filename*=UTF-8''${encodeURIComponent(r.name ?? "beleg")}`)
      .send(r.receipt);
  });
}
