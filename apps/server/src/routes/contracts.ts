import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, ilike, or, sql as dsql, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { Contract } from "../db/schema.js";
import { badRequest, currentUser, isoDate, notFound, optStr, parse, today } from "../lib/http.js";
import { getSettings, nextNumber } from "../lib/settings.js";
import { addDaysIso, describe, earliestEnd, grossPerInterval, summarize, syncRecurring, type ContractItem } from "../lib/contracts.js";
import { itemInput } from "./invoices.js";

const dateOpt = isoDate.nullish().or(z.literal("")).transform((v) => v || null);

const contractInput = z
  .object({
    customerId: z.string().min(1, "Kunde fehlt"),
    title: z.string().trim().min(1, "Bezeichnung fehlt").max(200),
    description: optStr,
    contactPerson: optStr,
    status: z.enum(["DRAFT", "ACTIVE"]).default("ACTIVE"),
    startDate: isoDate,
    endDate: dateOpt,
    minTermMonths: z.number().int().min(0).max(120).default(0),
    renewalMonths: z.number().int().min(0).max(120).default(0),
    noticeValue: z.number().int().min(0).max(36).default(1),
    noticeUnit: z.enum(["DAYS", "WEEKS", "MONTHS"]).default("MONTHS"),
    interval: z.enum(["MONTHLY", "QUARTERLY", "HALFYEARLY", "YEARLY"]).default("MONTHLY"),
    items: z.array(itemInput).min(1, "Mindestens eine Position"),
    signedAt: dateOpt,
    notes: optStr,
  })
  .superRefine((d, ctx) => {
    if (d.endDate && d.endDate < d.startDate) ctx.addIssue({ code: "custom", path: ["endDate"], message: "Ende liegt vor Beginn" });
  });

const billingInput = z.object({
  enabled: z.boolean().default(false),
  firstDate: isoDate.optional(),
  autoIssue: z.boolean().default(true),
});

const customerName = dsql<string>`coalesce(nullif(${schema.customers.company}, ''), trim(coalesce(${schema.customers.firstName}, '') || ' ' || coalesce(${schema.customers.lastName}, '')))`;

function view(c: Contract, extra: Record<string, unknown> = {}) {
  const { document, ...rest } = c;
  return { ...rest, hasDocument: !!document, ...describe(c), ...extra };
}

async function createRecurring(c: Contract, firstDate: string, autoIssue: boolean) {
  const day = Number(firstDate.slice(8, 10));
  const lastOfMonth = new Date(Date.UTC(Number(firstDate.slice(0, 4)), Number(firstDate.slice(5, 7)), 0)).getUTCDate();
  const [r] = await db
    .insert(schema.recurringInvoices)
    .values({
      name: `${c.number} ${c.title}`,
      customerId: c.customerId,
      interval: c.interval,
      nextDate: firstDate,
      anchorDay: day === lastOfMonth ? 31 : day,
      endDate: c.endDate,
      autoIssue,
      servicePeriod: true,
      subject: `${c.title} – {period}`,
      introText: `gemäß Vertrag ${c.number} berechnen wir Ihnen für den Zeitraum {periodStart} bis {periodEnd}:`,
      items: c.items,
      active: c.status === "ACTIVE",
    })
    .returning({ id: schema.recurringInvoices.id });
  await db.update(schema.contracts).set({ recurringId: r.id }).where(eq(schema.contracts.id, c.id));
  return r.id;
}

async function load(id: string) {
  const c = (await db.select().from(schema.contracts).where(eq(schema.contracts.id, id)))[0];
  if (!c) throw notFound("Vertrag");
  return c;
}

export async function contractRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string; customerId?: string; q?: string } }>("/api/contracts", async (req) => {
    currentUser(req);
    const conds: (SQL | undefined)[] = [];
    if (req.query.customerId) conds.push(eq(schema.contracts.customerId, req.query.customerId));
    if (req.query.q?.trim()) {
      const p = `%${req.query.q.trim()}%`;
      conds.push(or(ilike(schema.contracts.title, p), ilike(schema.contracts.number, p), ilike(customerName, p)));
    }
    const rows = await db
      .select({ c: schema.contracts, customerName })
      .from(schema.contracts)
      .innerJoin(schema.customers, eq(schema.customers.id, schema.contracts.customerId))
      .where(and(...conds))
      .orderBy(desc(schema.contracts.startDate))
      .limit(1000);
    const st = req.query.status;
    return rows
      .map((r) => view(r.c, { customerName: r.customerName }))
      .filter((c) => !st || st === "ALL" || c.status === st || (st === "RUNNING" && (c.status === "ACTIVE" || c.status === "CANCELLED")));
  });

  app.get("/api/contracts/summary", async (req) => {
    currentUser(req);
    const s = await getSettings();
    const rows = await db
      .select({ c: schema.contracts, customerName })
      .from(schema.contracts)
      .innerJoin(schema.customers, eq(schema.customers.id, schema.contracts.customerId));
    const sum = summarize(rows.map((r) => r.c));
    const on = today();
    const horizon = addDaysIso(on, Math.max(30, s.contracts.remindDays));
    const described = rows.map((r) => ({ r, d: describe(r.c) }));
    const deadlines = described
      .filter(({ r, d }) => d.status === "ACTIVE" && !r.c.endDate && d.noticeDeadline && d.noticeDeadline <= horizon)
      .sort((a, b) => a.d.noticeDeadline!.localeCompare(b.d.noticeDeadline!))
      .map(({ r, d }) => ({ id: r.c.id, number: r.c.number, title: r.c.title, customerName: r.customerName, noticeDeadline: d.noticeDeadline, earliestEnd: d.earliestEnd, monthlyNet: d.monthlyNet }));
    const ending = described
      .filter(({ r, d }) => d.status === "CANCELLED" && r.c.endDate && r.c.endDate <= addDaysIso(on, 90))
      .sort((a, b) => a.r.c.endDate!.localeCompare(b.r.c.endDate!))
      .map(({ r, d }) => ({ id: r.c.id, number: r.c.number, title: r.c.title, customerName: r.customerName, endDate: r.c.endDate, monthlyNet: d.monthlyNet }));
    const top = [...sum.byCustomer.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id, monthly]) => ({ customerId: id, customerName: rows.find((r) => r.c.customerId === id)?.customerName ?? "", monthlyNet: monthly }));
    return { mrr: sum.mrr, arr: sum.arr, activeCount: sum.activeCount, cancelledCount: sum.cancelledCount, customers: sum.customers, forecast: sum.forecast, deadlines, ending, top };
  });

  /** Vorschau für den Editor: Laufzeiten und Fristen eines noch nicht gespeicherten Vertrags */
  app.post("/api/contracts/preview", async (req) => {
    currentUser(req);
    const b = parse(contractInput, req.body);
    const s = await getSettings();
    const fake = {
      ...b,
      id: "preview",
      number: "",
      description: b.description ?? null,
      contactPerson: b.contactPerson ?? null,
      notes: b.notes ?? null,
      signedAt: b.signedAt ?? null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      recurringId: null,
      document: null,
      documentName: null,
      documentType: null,
      createdById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Contract;
    return { ...describe(fake), grossPerInterval: grossPerInterval(b.items as ContractItem[], s.invoice.smallBusiness) };
  });

  app.get<{ Params: { id: string } }>("/api/contracts/:id", async (req) => {
    currentUser(req);
    const c = await load(req.params.id);
    const s = await getSettings();
    const cust = (await db.select().from(schema.customers).where(eq(schema.customers.id, c.customerId)))[0];
    const recurring = c.recurringId ? ((await db.select().from(schema.recurringInvoices).where(eq(schema.recurringInvoices.id, c.recurringId)))[0] ?? null) : null;
    const invoices = c.recurringId
      ? await db
          .select({
            id: schema.invoices.id,
            number: schema.invoices.number,
            status: schema.invoices.status,
            issueDate: schema.invoices.issueDate,
            totalGross: schema.invoices.totalGross,
            paidTotal: schema.invoices.paidTotal,
          })
          .from(schema.invoices)
          .where(eq(schema.invoices.recurringId, c.recurringId))
          .orderBy(desc(schema.invoices.issueDate))
          .limit(60)
      : [];
    return view(c, {
      customer: cust ?? null,
      customerName: cust ? cust.company || [cust.firstName, cust.lastName].filter(Boolean).join(" ") : "",
      recurring: recurring
        ? { id: recurring.id, active: recurring.active, nextDate: recurring.nextDate, autoIssue: recurring.autoIssue, runCount: recurring.runCount, lastError: recurring.lastError }
        : null,
      invoices,
      grossPerInterval: grossPerInterval(c.items as ContractItem[], s.invoice.smallBusiness),
      billed: invoices.filter((i) => i.status !== "CANCELLED" && i.status !== "DRAFT").reduce((a, i) => a + i.totalGross, 0),
    });
  });

  app.post("/api/contracts", async (req) => {
    const me = currentUser(req);
    const body = parse(z.object({ contract: contractInput, billing: billingInput.default({}) }), req.body);
    const s = await getSettings();
    const b = body.contract;
    const created = await db.transaction(async (tx) => {
      const number = await nextNumber(tx, "contract", s.contracts.numberFormat, new Date(`${b.startDate}T12:00:00Z`));
      const [row] = await tx
        .insert(schema.contracts)
        .values({ ...b, number, createdById: me.id })
        .returning();
      return row;
    });
    if (body.billing.enabled) await createRecurring(created, body.billing.firstDate ?? b.startDate, body.billing.autoIssue);
    return { id: created.id, number: created.number };
  });

  app.put<{ Params: { id: string } }>("/api/contracts/:id", async (req) => {
    currentUser(req);
    const c = await load(req.params.id);
    const b = parse(contractInput, req.body);
    // Gekündigte Verträge behalten Status und Ende
    const cancelled = c.status === "CANCELLED" || c.status === "ENDED";
    const [row] = await db
      .update(schema.contracts)
      .set({ ...b, status: cancelled ? c.status : b.status, endDate: cancelled ? c.endDate : b.endDate, updatedAt: new Date() })
      .where(eq(schema.contracts.id, c.id))
      .returning();
    await syncRecurring(row);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/contracts/:id/cancel", async (req) => {
    currentUser(req);
    const c = await load(req.params.id);
    if (c.status === "DRAFT") throw badRequest("Ein Entwurf muss nicht gekündigt werden – einfach löschen");
    const b = parse(z.object({ receivedAt: isoDate, by: z.enum(["CUSTOMER", "US"]), endDate: dateOpt, reason: optStr }), req.body);
    const regular = earliestEnd({ ...c, endDate: null }, b.receivedAt);
    const endDate = b.endDate ?? regular.end;
    if (endDate < c.startDate) throw badRequest("Ende liegt vor Vertragsbeginn");
    const [row] = await db
      .update(schema.contracts)
      .set({ status: "CANCELLED", cancelledAt: b.receivedAt, cancelledBy: b.by, cancelReason: b.reason ?? null, endDate, updatedAt: new Date() })
      .where(eq(schema.contracts.id, c.id))
      .returning();
    await syncRecurring(row);
    return { ok: true, endDate, regularEnd: regular.end };
  });

  app.post<{ Params: { id: string } }>("/api/contracts/:id/revoke-cancel", async (req) => {
    currentUser(req);
    const c = await load(req.params.id);
    if (c.status !== "CANCELLED") throw badRequest("Vertrag ist nicht gekündigt");
    const [row] = await db
      .update(schema.contracts)
      .set({ status: "ACTIVE", cancelledAt: null, cancelledBy: null, cancelReason: null, endDate: null, updatedAt: new Date() })
      .where(eq(schema.contracts.id, c.id))
      .returning();
    await syncRecurring(row);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/contracts/:id/billing", async (req) => {
    currentUser(req);
    const c = await load(req.params.id);
    if (c.recurringId) throw badRequest("Für diesen Vertrag gibt es schon eine Abo-Rechnung");
    const b = parse(billingInput, req.body ?? {});
    const id = await createRecurring(c, b.firstDate ?? today(), b.autoIssue);
    return { recurringId: id };
  });

  app.put<{ Params: { id: string } }>("/api/contracts/:id/document", { bodyLimit: 30 * 1024 * 1024 }, async (req) => {
    currentUser(req);
    const c = await load(req.params.id);
    const b = parse(
      z.object({ document: z.object({ name: z.string().trim().min(1).max(200), type: z.string().max(100).optional(), data: z.string().min(1) }).nullable() }),
      req.body,
    );
    if (!b.document) {
      await db.update(schema.contracts).set({ document: null, documentName: null, documentType: null }).where(eq(schema.contracts.id, c.id));
      return { ok: true };
    }
    const buf = Buffer.from(b.document.data, "base64");
    if (buf.length > 20 * 1024 * 1024) throw badRequest("Datei ist zu groß (max. 20 MB)");
    await db
      .update(schema.contracts)
      .set({ document: buf, documentName: b.document.name, documentType: b.document.type || "application/pdf" })
      .where(eq(schema.contracts.id, c.id));
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/contracts/:id/document", async (req, reply) => {
    currentUser(req);
    const c = await load(req.params.id);
    if (!c.document) throw notFound("Dokument");
    const name = c.documentName ?? "vertrag.pdf";
    return reply
      .header("Content-Type", c.documentType ?? "application/octet-stream")
      .header("Content-Disposition", `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .send(c.document);
  });

  app.delete<{ Params: { id: string } }>("/api/contracts/:id", async (req) => {
    currentUser(req);
    const c = await load(req.params.id);
    await db.transaction(async (tx) => {
      if (c.recurringId) await tx.update(schema.recurringInvoices).set({ active: false }).where(eq(schema.recurringInvoices.id, c.recurringId));
      await tx.delete(schema.contracts).where(eq(schema.contracts.id, c.id));
    });
    return { ok: true };
  });
}
