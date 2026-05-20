import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, ilike, or, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { badRequest, currentUser, notFound, optStr, parse } from "../lib/http.js";
import { getSettings, nextNumber } from "../lib/settings.js";
import { onCustomerCreated } from "../lib/automation.js";

const customerInput = z.object({
  type: z.enum(["COMPANY", "PERSON"]).default("COMPANY"),
  company: optStr,
  firstName: optStr,
  lastName: optStr,
  email: z
    .string()
    .trim()
    .email("Ungültige E-Mail-Adresse")
    .or(z.literal(""))
    .nullish()
    .transform((v) => (v ? v.toLowerCase() : null)),
  phone: optStr,
  street: optStr,
  zip: optStr,
  city: optStr,
  country: z.string().trim().length(2).default("DE"),
  vatId: optStr,
  leitwegId: optStr,
  hourlyRate: z.number().int().min(0).nullish().transform((v) => v ?? null),
  profileId: z.string().trim().nullish().transform((v) => v || null),
  notes: optStr,
  archived: z.boolean().optional(),
});

function validate(c: z.infer<typeof customerInput>) {
  if (c.type === "COMPANY" && !c.company) throw badRequest("Firmenname fehlt");
  if (c.type === "PERSON" && !c.lastName && !c.company) throw badRequest("Nachname fehlt");
}

export async function customerRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string; archived?: string } }>("/api/customers", async (req) => {
    currentUser(req);
    const q = req.query.q?.trim();
    const archived = req.query.archived === "true";
    const where = and(
      eq(schema.customers.archived, archived),
      q
        ? or(
            ilike(schema.customers.company, `%${q}%`),
            ilike(schema.customers.firstName, `%${q}%`),
            ilike(schema.customers.lastName, `%${q}%`),
            ilike(schema.customers.email, `%${q}%`),
            ilike(schema.customers.number, `%${q}%`),
            ilike(schema.customers.city, `%${q}%`),
          )
        : undefined,
    );
    const rows = await db
      .select({
        c: schema.customers,
        revenue: dsql<number>`coalesce((select sum(i.amount) from incomes i where i.customer_id = "customers"."id"), 0)::int`,
        open: dsql<number>`coalesce((select sum(v.total_gross - v.paid_total) from invoices v where v.customer_id = "customers"."id" and v.status = 'ISSUED' and v.kind = 'INVOICE'), 0)::int`,
      })
      .from(schema.customers)
      .where(where)
      .orderBy(dsql`coalesce(${schema.customers.company}, ${schema.customers.lastName})`);
    return rows.map((r) => ({ ...r.c, revenue: r.revenue, open: r.open }));
  });

  app.get<{ Params: { id: string } }>("/api/customers/:id", async (req) => {
    currentUser(req);
    const c = (await db.select().from(schema.customers).where(eq(schema.customers.id, req.params.id)))[0];
    if (!c) throw notFound("Kunde");
    const [invoices, incomes, discounts, mails, tickets] = await Promise.all([
      db
        .select({
          id: schema.invoices.id,
          number: schema.invoices.number,
          kind: schema.invoices.kind,
          status: schema.invoices.status,
          issueDate: schema.invoices.issueDate,
          dueDate: schema.invoices.dueDate,
          totalGross: schema.invoices.totalGross,
          paidTotal: schema.invoices.paidTotal,
        })
        .from(schema.invoices)
        .where(eq(schema.invoices.customerId, c.id))
        .orderBy(desc(schema.invoices.createdAt)),
      db.select().from(schema.incomes).where(eq(schema.incomes.customerId, c.id)).orderBy(desc(schema.incomes.date)),
      db.select().from(schema.discounts).where(eq(schema.discounts.customerId, c.id)),
      db.select().from(schema.mailLogs).where(eq(schema.mailLogs.customerId, c.id)).orderBy(desc(schema.mailLogs.createdAt)).limit(50),
      db
        .select({ id: schema.tickets.id, number: schema.tickets.number, subject: schema.tickets.subject, status: schema.tickets.status, lastMessageAt: schema.tickets.lastMessageAt })
        .from(schema.tickets)
        .where(eq(schema.tickets.customerId, c.id))
        .orderBy(desc(schema.tickets.lastMessageAt))
        .limit(50),
    ]);
    return { ...c, invoices, incomes, discounts, mails, tickets };
  });

  app.post("/api/customers", async (req) => {
    currentUser(req);
    const body = parse(customerInput, req.body);
    validate(body);
    const s = await getSettings();
    const customer = await db.transaction(async (tx) => {
      const number = await nextNumber(tx, "customer", s.invoice.customerNumberFormat);
      const [c] = await tx.insert(schema.customers).values({ ...body, number }).returning();
      return c;
    });
    void onCustomerCreated(customer.id, req.log);
    return customer;
  });

  app.put<{ Params: { id: string } }>("/api/customers/:id", async (req) => {
    currentUser(req);
    const body = parse(customerInput, req.body);
    validate(body);
    const [c] = await db.update(schema.customers).set(body).where(eq(schema.customers.id, req.params.id)).returning();
    if (!c) throw notFound("Kunde");
    return c;
  });

  app.delete<{ Params: { id: string } }>("/api/customers/:id", async (req) => {
    currentUser(req);
    const used = (await db.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.customerId, req.params.id)).limit(1))[0];
    if (used) {
      // Kunden mit Rechnungen werden nur archiviert (Aufbewahrungspflicht)
      await db.update(schema.customers).set({ archived: true }).where(eq(schema.customers.id, req.params.id));
      return { archived: true };
    }
    await db.delete(schema.customers).where(eq(schema.customers.id, req.params.id));
    return { deleted: true };
  });
}
