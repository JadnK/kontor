import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, gte, lte, sql as dsql, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { currentUser, isoDate, notFound, optStr, parse } from "../lib/http.js";
import { recalcPaid } from "./invoices.js";
import { releaseBankTx } from "./bank.js";

const incomeInput = z.object({
  date: isoDate,
  amount: z.number().int().refine((n) => n !== 0, "Betrag darf nicht 0 sein"),
  method: z.string().trim().min(1).default("Überweisung"),
  category: z.string().trim().min(1).default("Sonstiges"),
  description: optStr,
  customerId: optStr,
  /** USt-Satz der Einnahme (für die Auswertung), leer = Standard bzw. 0 bei Kleinunternehmern */
  taxRate: z.number().min(0).max(100).nullish().transform((v) => v ?? null),
});

export async function incomeRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { from?: string; to?: string; category?: string } }>("/api/income", async (req) => {
    currentUser(req);
    const { from, to, category } = req.query;
    const conds: (SQL | undefined)[] = [
      from ? gte(schema.incomes.date, from) : undefined,
      to ? lte(schema.incomes.date, to) : undefined,
      category ? eq(schema.incomes.category, category) : undefined,
    ];
    const rows = await db
      .select({
        i: schema.incomes,
        invoiceNumber: schema.invoices.number,
        company: schema.customers.company,
        firstName: schema.customers.firstName,
        lastName: schema.customers.lastName,
      })
      .from(schema.incomes)
      .leftJoin(schema.invoices, eq(schema.invoices.id, schema.incomes.invoiceId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.incomes.customerId))
      .where(and(...conds))
      .orderBy(desc(schema.incomes.date), desc(schema.incomes.createdAt))
      .limit(2000);
    return rows.map((r) => ({
      ...r.i,
      invoiceNumber: r.invoiceNumber,
      customerName: r.company || [r.firstName, r.lastName].filter(Boolean).join(" ") || null,
    }));
  });

  app.get<{ Querystring: { year?: string } }>("/api/income/summary", async (req) => {
    currentUser(req);
    const year = Number(req.query.year) || new Date().getFullYear();
    const months = await db
      .select({
        month: dsql<number>`extract(month from ${schema.incomes.date})::int`,
        total: dsql<number>`sum(${schema.incomes.amount})::int`,
      })
      .from(schema.incomes)
      .where(and(gte(schema.incomes.date, `${year}-01-01`), lte(schema.incomes.date, `${year}-12-31`)))
      .groupBy(dsql`1`);
    const categories = await db
      .select({ category: schema.incomes.category, total: dsql<number>`sum(${schema.incomes.amount})::int` })
      .from(schema.incomes)
      .where(and(gte(schema.incomes.date, `${year}-01-01`), lte(schema.incomes.date, `${year}-12-31`)))
      .groupBy(schema.incomes.category);
    const byMonth = Array.from({ length: 12 }, (_, i) => months.find((m) => m.month === i + 1)?.total ?? 0);
    return { year, byMonth, total: byMonth.reduce((a, b) => a + b, 0), categories };
  });

  app.post("/api/income", async (req) => {
    const me = currentUser(req);
    const body = parse(incomeInput, req.body);
    return (await db.insert(schema.incomes).values({ ...body, createdById: me.id }).returning())[0];
  });

  app.delete<{ Params: { id: string } }>("/api/income/:id", async (req) => {
    currentUser(req);
    await db.transaction(async (tx) => {
      const row = (await tx.select().from(schema.incomes).where(eq(schema.incomes.id, req.params.id)))[0];
      if (!row) throw notFound("Einnahme");
      await tx.delete(schema.incomes).where(eq(schema.incomes.id, row.id));
      if (row.invoiceId) await recalcPaid(tx, row.invoiceId);
      await releaseBankTx(tx, row.bankTransactionId);
    });
    return { ok: true };
  });
}
