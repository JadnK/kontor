import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { badRequest, currentUser, isoDate, notFound, optStr, parse, today } from "../lib/http.js";
import { calculate } from "../lib/calc.js";
import { getSettings } from "../lib/settings.js";
import { periodOf, runRecurring } from "../lib/recurring.js";
import { itemInput } from "./invoices.js";

const recurringInput = z.object({
  name: z.string().trim().min(1, "Name fehlt"),
  customerId: z.string().min(1, "Kunde fehlt"),
  active: z.boolean().default(true),
  interval: z.enum(["MONTHLY", "QUARTERLY", "HALFYEARLY", "YEARLY"]),
  nextDate: isoDate,
  endDate: isoDate.nullish().or(z.literal("")).transform((v) => v || null),
  autoIssue: z.boolean().default(true),
  servicePeriod: z.boolean().default(true),
  subject: optStr,
  introText: optStr,
  notes: optStr,
  discountId: optStr,
  taxExemption: optStr,
  items: z.array(itemInput).min(1, "Mindestens eine Position"),
});

export async function recurringRoutes(app: FastifyInstance) {
  app.get("/api/recurring", async (req) => {
    currentUser(req);
    const s = await getSettings();
    const rows = await db
      .select({ r: schema.recurringInvoices, company: schema.customers.company, firstName: schema.customers.firstName, lastName: schema.customers.lastName, ctype: schema.customers.type })
      .from(schema.recurringInvoices)
      .innerJoin(schema.customers, eq(schema.customers.id, schema.recurringInvoices.customerId))
      .orderBy(desc(schema.recurringInvoices.active), asc(schema.recurringInvoices.nextDate));
    return rows.map(({ r, ...c }) => {
      const t = calculate(r.items as never, null, s.invoice.smallBusiness);
      return {
        ...r,
        customerName: (c.ctype === "COMPANY" ? c.company : null) || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.company || "",
        totalNet: t.totalNet,
        totalGross: t.totalGross,
        nextPeriod: periodOf(r, r.nextDate).vars.period,
      };
    });
  });

  app.get<{ Params: { id: string } }>("/api/recurring/:id", async (req) => {
    currentUser(req);
    const r = (await db.select().from(schema.recurringInvoices).where(eq(schema.recurringInvoices.id, req.params.id)))[0];
    if (!r) throw notFound("Abo-Rechnung");
    const invoices = await db
      .select({
        id: schema.invoices.id,
        number: schema.invoices.number,
        status: schema.invoices.status,
        issueDate: schema.invoices.issueDate,
        totalGross: schema.invoices.totalGross,
        serviceDateFrom: schema.invoices.serviceDateFrom,
        serviceDateTo: schema.invoices.serviceDateTo,
      })
      .from(schema.invoices)
      .where(eq(schema.invoices.recurringId, r.id))
      .orderBy(desc(schema.invoices.createdAt))
      .limit(100);
    return { ...r, invoices, nextPeriod: periodOf(r, r.nextDate).vars.period };
  });

  const values = (b: z.infer<typeof recurringInput>) => {
    if (b.endDate && b.endDate < b.nextDate) throw badRequest("Das Enddatum liegt vor der nächsten Rechnung");
    return { ...b, anchorDay: Number(b.nextDate.slice(8, 10)) };
  };

  app.post("/api/recurring", async (req) => {
    currentUser(req);
    const b = parse(recurringInput, req.body);
    const [row] = await db.insert(schema.recurringInvoices).values(values(b)).returning();
    return row;
  });

  app.put<{ Params: { id: string } }>("/api/recurring/:id", async (req) => {
    currentUser(req);
    const b = parse(recurringInput, req.body);
    const [row] = await db
      .update(schema.recurringInvoices)
      .set({ ...values(b), lastError: null })
      .where(eq(schema.recurringInvoices.id, req.params.id))
      .returning();
    if (!row) throw notFound("Abo-Rechnung");
    return row;
  });

  app.patch<{ Params: { id: string } }>("/api/recurring/:id", async (req) => {
    currentUser(req);
    const { active } = parse(z.object({ active: z.boolean() }), req.body);
    const [row] = await db.update(schema.recurringInvoices).set({ active }).where(eq(schema.recurringInvoices.id, req.params.id)).returning();
    if (!row) throw notFound("Abo-Rechnung");
    return row;
  });

  app.delete<{ Params: { id: string } }>("/api/recurring/:id", async (req) => {
    currentUser(req);
    await db.delete(schema.recurringInvoices).where(eq(schema.recurringInvoices.id, req.params.id));
    return { ok: true };
  });

  /** Rechnung für den nächsten Zeitraum sofort erstellen (statt am Stichtag) */
  app.post<{ Params: { id: string } }>("/api/recurring/:id/run", async (req) => {
    currentUser(req);
    const r = (await db.select().from(schema.recurringInvoices).where(eq(schema.recurringInvoices.id, req.params.id)))[0];
    if (!r) throw notFound("Abo-Rechnung");
    if (r.endDate && r.nextDate > r.endDate) throw badRequest("Die Laufzeit ist beendet");
    const created = await runRecurring(req.log, r.id);
    const after = (await db.select().from(schema.recurringInvoices).where(eq(schema.recurringInvoices.id, r.id)))[0];
    if (!created.length) throw badRequest(after?.lastError ?? "Rechnung konnte nicht erstellt werden");
    return { invoiceId: created[0], warning: after?.lastError ?? null, nextDate: after?.nextDate ?? today() };
  });
}
