/**
 * Projekte, Zeiterfassung (Stoppuhr und manuell), Material/Pauschalen und deren Abrechnung als Rechnung.
 * Stundensatz: Eintrag → Projekt → Kunde → Standard aus den Einstellungen.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, isNull, isNotNull, lte, sql as dsql, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { Charge, Project, TimeEntry } from "../db/schema.js";
import { HttpError, badRequest, currentUser, formatDate, isoDate, notFound, optStr, parse, today } from "../lib/http.js";
import { getSettings, type Settings } from "../lib/settings.js";
import { writeDraft } from "./invoices.js";

const optInt = z.number().int().min(0).nullish().transform((v) => v ?? null);

// ---------- Rundung & Sätze ----------
export function roundMinutes(min: number, t: Settings["time"]): number {
  if (t.rounding === "none" || min <= 0) return Math.max(0, min);
  const step = t.roundingMinutes;
  return t.rounding === "up" ? Math.ceil(min / step) * step : Math.max(step, Math.round(min / step) * step);
}

const hours = (min: number) => Math.round((min / 60) * 100) / 100;
const fmtH = (min: number) => `${hours(min).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Std.`;

async function ratesFor(customerIds: string[], projectIds: string[]) {
  const [cs, ps] = await Promise.all([
    customerIds.length ? db.select({ id: schema.customers.id, rate: schema.customers.hourlyRate }).from(schema.customers).where(inArray(schema.customers.id, customerIds)) : [],
    projectIds.length ? db.select({ id: schema.projects.id, rate: schema.projects.hourlyRate }).from(schema.projects).where(inArray(schema.projects.id, projectIds)) : [],
  ]);
  return { customer: new Map(cs.map((c) => [c.id, c.rate])), project: new Map(ps.map((p) => [p.id, p.rate])) };
}

function rateOf(e: Pick<TimeEntry, "hourlyRate" | "projectId" | "customerId">, r: Awaited<ReturnType<typeof ratesFor>>, def: number) {
  return e.hourlyRate ?? (e.projectId ? r.project.get(e.projectId) : null) ?? r.customer.get(e.customerId) ?? def;
}

const checkOpen = (row: { invoiceId: string | null }) => {
  if (row.invoiceId) throw new HttpError(409, "Bereits abgerechnet – zuerst die Rechnung löschen bzw. die Abrechnung aufheben", "billed");
};

// ---------- Eingaben ----------
const projectInput = z.object({
  customerId: z.string().min(1, "Kunde fehlt"),
  name: z.string().trim().min(1, "Name fehlt"),
  hourlyRate: optInt,
  budgetMinutes: optInt,
  archived: z.boolean().default(false),
});

const timeInput = z.object({
  customerId: z.string().min(1, "Kunde fehlt"),
  projectId: optStr,
  ticketId: optStr,
  date: isoDate,
  minutes: z.number().int().min(1, "Dauer fehlt").max(24 * 60),
  description: z.string().trim().max(2000).default(""),
  billable: z.boolean().default(true),
  hourlyRate: optInt,
});

const chargeInput = z.object({
  customerId: z.string().min(1, "Kunde fehlt"),
  projectId: optStr,
  ticketId: optStr,
  productId: optStr,
  date: isoDate,
  name: z.string().trim().min(1, "Bezeichnung fehlt"),
  description: optStr,
  quantity: z.number().refine((n) => n !== 0, "Menge darf nicht 0 sein"),
  unit: z.string().trim().min(1).default("Stk"),
  unitPriceNet: z.number().int(),
  taxRate: z.number().min(0).max(100),
});

/** Kunde/Projekt/Ticket passen zusammen? Ticket bringt Kunde mit, falls nötig. */
async function checkRefs(b: { customerId: string; projectId: string | null; ticketId: string | null }) {
  const c = (await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.id, b.customerId)))[0];
  if (!c) throw badRequest("Kunde existiert nicht");
  if (b.projectId) {
    const p = (await db.select().from(schema.projects).where(eq(schema.projects.id, b.projectId)))[0];
    if (!p || p.customerId !== b.customerId) throw badRequest("Projekt gehört nicht zu diesem Kunden");
  }
  if (b.ticketId) {
    const t = (await db.select({ customerId: schema.tickets.customerId }).from(schema.tickets).where(eq(schema.tickets.id, b.ticketId)))[0];
    if (!t) throw badRequest("Ticket existiert nicht");
    if (t.customerId && t.customerId !== b.customerId) throw badRequest("Ticket gehört zu einem anderen Kunden");
    if (!t.customerId) await db.update(schema.tickets).set({ customerId: b.customerId }).where(eq(schema.tickets.id, b.ticketId));
  }
}

// ---------- Listen mit Namen ----------
async function listEntries(where: SQL | undefined, limit = 2000) {
  const s = await getSettings();
  const rows = await db
    .select({
      e: schema.timeEntries,
      customerName: dsql<string>`coalesce(nullif(${schema.customers.company}, ''), trim(coalesce(${schema.customers.firstName}, '') || ' ' || coalesce(${schema.customers.lastName}, '')))`,
      projectName: schema.projects.name,
      ticketNumber: schema.tickets.number,
      ticketSubject: schema.tickets.subject,
      userName: schema.users.name,
      invoiceNumber: schema.invoices.number,
    })
    .from(schema.timeEntries)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.timeEntries.customerId))
    .leftJoin(schema.projects, eq(schema.projects.id, schema.timeEntries.projectId))
    .leftJoin(schema.tickets, eq(schema.tickets.id, schema.timeEntries.ticketId))
    .leftJoin(schema.users, eq(schema.users.id, schema.timeEntries.userId))
    .leftJoin(schema.invoices, eq(schema.invoices.id, schema.timeEntries.invoiceId))
    .where(where)
    .orderBy(desc(schema.timeEntries.date), desc(schema.timeEntries.createdAt))
    .limit(limit);
  const rates = await ratesFor([...new Set(rows.map((r) => r.e.customerId))], [...new Set(rows.map((r) => r.e.projectId).filter(Boolean) as string[])]);
  return rows.map(({ e, ...x }) => {
    const minutes = e.running && e.startedAt ? Math.max(1, Math.ceil((Date.now() - e.startedAt.getTime()) / 60000)) : e.minutes;
    const rate = rateOf(e, rates, s.time.defaultHourlyRate);
    const billedMinutes = roundMinutes(minutes, s.time);
    return { ...e, ...x, minutes, billedMinutes, rate, amount: e.billable ? Math.round((billedMinutes * rate) / 60) : 0 };
  });
}

async function listCharges(where: SQL | undefined) {
  return db
    .select({
      c: schema.charges,
      customerName: dsql<string>`coalesce(nullif(${schema.customers.company}, ''), trim(coalesce(${schema.customers.firstName}, '') || ' ' || coalesce(${schema.customers.lastName}, '')))`,
      ticketNumber: schema.tickets.number,
      projectName: schema.projects.name,
      invoiceNumber: schema.invoices.number,
    })
    .from(schema.charges)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.charges.customerId))
    .leftJoin(schema.tickets, eq(schema.tickets.id, schema.charges.ticketId))
    .leftJoin(schema.projects, eq(schema.projects.id, schema.charges.projectId))
    .leftJoin(schema.invoices, eq(schema.invoices.id, schema.charges.invoiceId))
    .where(where)
    .orderBy(desc(schema.charges.date), desc(schema.charges.createdAt))
    .then((rows) => rows.map(({ c, ...x }) => ({ ...c, ...x, amount: Math.round(c.quantity * c.unitPriceNet) })));
}

// ---------- Abrechnung ----------
interface BillLine {
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unitPriceNet: number;
  taxRate: number;
  productId: string | null;
}

/** Zeiten und Material in Rechnungspositionen umwandeln und als Entwurf anlegen */
export async function billToInvoice(opts: { customerId: string; timeEntryIds: string[]; chargeIds: string[]; userId: string | null; subject?: string | null }) {
  const s = await getSettings();
  const t = s.time;
  if (!opts.timeEntryIds.length && !opts.chargeIds.length) throw badRequest("Nichts zum Abrechnen ausgewählt");
  const entries = opts.timeEntryIds.length ? await db.select().from(schema.timeEntries).where(inArray(schema.timeEntries.id, opts.timeEntryIds)) : [];
  const chargeRows = opts.chargeIds.length ? await db.select().from(schema.charges).where(inArray(schema.charges.id, opts.chargeIds)) : [];
  for (const e of entries) {
    if (e.customerId !== opts.customerId) throw badRequest("Zeiten verschiedener Kunden können nicht zusammen abgerechnet werden");
    if (e.running) throw badRequest("Eine Stoppuhr läuft noch – bitte zuerst anhalten");
    if (!e.billable) throw badRequest("Nicht abrechenbare Zeiten können nicht auf die Rechnung");
    checkOpen(e);
  }
  for (const c of chargeRows) {
    if (c.customerId !== opts.customerId) throw badRequest("Material verschiedener Kunden kann nicht zusammen abgerechnet werden");
    checkOpen(c);
  }
  const rates = await ratesFor([opts.customerId], [...new Set(entries.map((e) => e.projectId).filter(Boolean) as string[])]);
  const [ticketRows, projectRows] = await Promise.all([
    db.select({ id: schema.tickets.id, number: schema.tickets.number, subject: schema.tickets.subject }).from(schema.tickets).where(inArray(schema.tickets.id, [...new Set(entries.map((e) => e.ticketId).filter(Boolean) as string[]), "-"])),
    db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).where(inArray(schema.projects.id, [...new Set(entries.map((e) => e.projectId).filter(Boolean) as string[]), "-"])),
  ]);
  const ticketOf = new Map(ticketRows.map((x) => [x.id, x]));
  const projectOf = new Map(projectRows.map((x) => [x.id, x]));
  const label = (e: TimeEntry) =>
    e.ticketId && ticketOf.get(e.ticketId)
      ? `Ticket ${ticketOf.get(e.ticketId)!.number}: ${ticketOf.get(e.ticketId)!.subject}`
      : e.projectId && projectOf.get(e.projectId)
        ? `Projekt ${projectOf.get(e.projectId)!.name}`
        : "Arbeitszeit";

  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.getTime() - b.createdAt.getTime());
  const lines: BillLine[] = [];
  const timeLine = (name: string, items: TimeEntry[], rate: number): BillLine => {
    const minutes = items.reduce((a, e) => a + roundMinutes(e.minutes, t), 0);
    const desc = items.map((e) => `${formatDate(e.date).slice(0, 6)} ${e.description || "Arbeitszeit"} (${fmtH(roundMinutes(e.minutes, t))})`).join("\n");
    return { name, description: desc || null, quantity: hours(minutes), unit: t.unit, unitPriceNet: rate, taxRate: t.taxRate, productId: null };
  };
  if (t.grouping === "entry") {
    for (const e of sorted) {
      const m = roundMinutes(e.minutes, t);
      lines.push({
        name: e.description || label(e),
        description: `${formatDate(e.date)}${e.description ? ` · ${label(e)}` : ""}`,
        quantity: hours(m),
        unit: t.unit,
        unitPriceNet: rateOf(e, rates, t.defaultHourlyRate),
        taxRate: t.taxRate,
        productId: null,
      });
    }
  } else {
    const groups = new Map<string, { name: string; rate: number; items: TimeEntry[] }>();
    for (const e of sorted) {
      const rate = rateOf(e, rates, t.defaultHourlyRate);
      const name = t.grouping === "day" ? `Arbeitszeit ${formatDate(e.date)}` : label(e);
      const key = `${name}|${rate}`;
      if (!groups.has(key)) groups.set(key, { name, rate, items: [] });
      groups.get(key)!.items.push(e);
    }
    for (const g of groups.values()) lines.push(timeLine(g.name, g.items, g.rate));
  }
  for (const c of chargeRows) {
    lines.push({ name: c.name, description: c.description, quantity: c.quantity, unit: c.unit, unitPriceNet: c.unitPriceNet, taxRate: c.taxRate, productId: c.productId });
  }
  const dates = [...entries.map((e) => e.date), ...chargeRows.map((c) => c.date)].sort();
  const invoiceId = await db.transaction(async (tx) => {
    const id = await writeDraft(
      tx,
      {
        customerId: opts.customerId,
        issueDate: null,
        serviceDateFrom: dates[0] ?? null,
        serviceDateTo: dates.length > 1 && dates[dates.length - 1] !== dates[0] ? dates[dates.length - 1] : null,
        dueDate: null,
        subject: opts.subject ?? null,
        introText: null,
        footerText: null,
        notes: null,
        discountId: null,
        taxExemption: null,
        items: lines.map((l) => ({ ...l, discountBps: 0 })),
      },
      null,
      opts.userId,
    );
    // erneut prüfen und sperren – parallel gestartete Abrechnung darf nichts doppelt nehmen
    if (opts.timeEntryIds.length) {
      const upd = await tx
        .update(schema.timeEntries)
        .set({ invoiceId: id })
        .where(and(inArray(schema.timeEntries.id, opts.timeEntryIds), isNull(schema.timeEntries.invoiceId)))
        .returning({ id: schema.timeEntries.id });
      if (upd.length !== opts.timeEntryIds.length) throw badRequest("Ein Teil der Zeiten wurde inzwischen schon abgerechnet");
    }
    if (opts.chargeIds.length) {
      const upd = await tx
        .update(schema.charges)
        .set({ invoiceId: id })
        .where(and(inArray(schema.charges.id, opts.chargeIds), isNull(schema.charges.invoiceId)))
        .returning({ id: schema.charges.id });
      if (upd.length !== opts.chargeIds.length) throw badRequest("Ein Teil des Materials wurde inzwischen schon abgerechnet");
    }
    return id;
  });
  return invoiceId;
}

export async function timeRoutes(app: FastifyInstance) {
  // ---------- Projekte ----------
  app.get<{ Querystring: { customerId?: string; all?: string } }>("/api/projects", async (req) => {
    currentUser(req);
    const conds: (SQL | undefined)[] = [];
    if (req.query.customerId) conds.push(eq(schema.projects.customerId, req.query.customerId));
    if (!req.query.all) conds.push(eq(schema.projects.archived, false));
    const rows = await db
      .select({
        p: schema.projects,
        minutes: dsql<number>`coalesce((select sum(${schema.timeEntries.minutes}) from ${schema.timeEntries} where ${schema.timeEntries.projectId} = ${schema.projects.id}), 0)::int`,
        customerName: dsql<string>`coalesce(nullif(${schema.customers.company}, ''), trim(coalesce(${schema.customers.firstName}, '') || ' ' || coalesce(${schema.customers.lastName}, '')))`,
      })
      .from(schema.projects)
      .innerJoin(schema.customers, eq(schema.customers.id, schema.projects.customerId))
      .where(and(...conds))
      .orderBy(asc(schema.projects.name));
    return rows.map((r) => ({ ...r.p, minutes: r.minutes, customerName: r.customerName }));
  });

  app.post("/api/projects", async (req) => {
    currentUser(req);
    const b = parse(projectInput, req.body);
    const [row] = await db.insert(schema.projects).values(b).returning();
    return row;
  });

  app.put<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    currentUser(req);
    const b = parse(projectInput, req.body);
    const [row] = await db.update(schema.projects).set(b).where(eq(schema.projects.id, req.params.id)).returning();
    if (!row) throw notFound("Projekt");
    return row;
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    currentUser(req);
    const used = (await db.select({ n: dsql<number>`count(*)::int` }).from(schema.timeEntries).where(eq(schema.timeEntries.projectId, req.params.id)))[0].n;
    if (used) await db.update(schema.projects).set({ archived: true }).where(eq(schema.projects.id, req.params.id));
    else await db.delete(schema.projects).where(eq(schema.projects.id, req.params.id));
    return { ok: true, archived: used > 0 };
  });

  // ---------- Zeiten ----------
  app.get<{ Querystring: { from?: string; to?: string; customerId?: string; projectId?: string; ticketId?: string; userId?: string; state?: string } }>(
    "/api/time",
    async (req) => {
      currentUser(req);
      const q = req.query;
      const conds: (SQL | undefined)[] = [];
      if (q.from) conds.push(gte(schema.timeEntries.date, q.from));
      if (q.to) conds.push(lte(schema.timeEntries.date, q.to));
      if (q.customerId) conds.push(eq(schema.timeEntries.customerId, q.customerId));
      if (q.projectId) conds.push(eq(schema.timeEntries.projectId, q.projectId));
      if (q.ticketId) conds.push(eq(schema.timeEntries.ticketId, q.ticketId));
      if (q.userId) conds.push(eq(schema.timeEntries.userId, q.userId));
      if (q.state === "open") conds.push(isNull(schema.timeEntries.invoiceId), eq(schema.timeEntries.billable, true));
      if (q.state === "billed") conds.push(isNotNull(schema.timeEntries.invoiceId));
      return listEntries(and(...conds));
    },
  );

  app.get("/api/time/running", async (req) => {
    const me = currentUser(req);
    const r = await listEntries(and(eq(schema.timeEntries.userId, me.id), eq(schema.timeEntries.running, true)), 1);
    return r[0] ?? null;
  });

  async function stopRunning(userId: string) {
    const running = await db.select().from(schema.timeEntries).where(and(eq(schema.timeEntries.userId, userId), eq(schema.timeEntries.running, true)));
    for (const e of running) {
      const minutes = Math.max(1, Math.ceil((Date.now() - (e.startedAt ?? new Date()).getTime()) / 60000));
      await db.update(schema.timeEntries).set({ running: false, minutes: Math.min(minutes, 24 * 60) }).where(eq(schema.timeEntries.id, e.id));
    }
    return running.map((e) => e.id);
  }

  app.post("/api/time/start", async (req) => {
    const me = currentUser(req);
    const b = parse(z.object({ customerId: z.string().min(1, "Kunde wählen"), projectId: optStr, ticketId: optStr, description: z.string().trim().max(2000).default("") }), req.body);
    await checkRefs(b);
    await stopRunning(me.id);
    const [row] = await db
      .insert(schema.timeEntries)
      .values({ ...b, userId: me.id, date: today(), startedAt: new Date(), running: true, minutes: 0 })
      .returning();
    return row;
  });

  app.post("/api/time/stop", async (req) => {
    const me = currentUser(req);
    const ids = await stopRunning(me.id);
    if (!ids.length) throw badRequest("Es läuft keine Stoppuhr");
    return (await listEntries(eq(schema.timeEntries.id, ids[0]), 1))[0];
  });

  app.post("/api/time", async (req) => {
    const me = currentUser(req);
    const b = parse(timeInput, req.body);
    await checkRefs(b);
    const [row] = await db.insert(schema.timeEntries).values({ ...b, userId: me.id }).returning();
    return row;
  });

  app.put<{ Params: { id: string } }>("/api/time/:id", async (req) => {
    currentUser(req);
    const b = parse(timeInput.extend({ minutes: z.number().int().min(0).max(24 * 60) }), req.body);
    const e = (await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.id, req.params.id)))[0];
    if (!e) throw notFound("Zeiteintrag");
    checkOpen(e);
    await checkRefs(b);
    // laufende Uhr: Beschreibung/Zuordnung änderbar, Dauer zählt weiter
    const [row] = await db
      .update(schema.timeEntries)
      .set(e.running ? { ...b, minutes: 0 } : b)
      .where(eq(schema.timeEntries.id, e.id))
      .returning();
    return row;
  });

  app.delete<{ Params: { id: string } }>("/api/time/:id", async (req) => {
    currentUser(req);
    const e = (await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.id, req.params.id)))[0];
    if (!e) throw notFound("Zeiteintrag");
    checkOpen(e);
    await db.delete(schema.timeEntries).where(eq(schema.timeEntries.id, e.id));
    return { ok: true };
  });

  /** Abrechnung aufheben (z. B. nach Storno, um neu abzurechnen) */
  app.post<{ Params: { kind: string; id: string } }>("/api/billing/:kind/:id/unbill", async (req) => {
    currentUser(req);
    const table = req.params.kind === "charge" ? schema.charges : schema.timeEntries;
    const row = (await db.select({ invoiceId: table.invoiceId }).from(table).where(eq(table.id, req.params.id)))[0];
    if (!row) throw notFound("Eintrag");
    if (row.invoiceId) {
      const inv = (await db.select({ status: schema.invoices.status }).from(schema.invoices).where(eq(schema.invoices.id, row.invoiceId)))[0];
      if (inv && inv.status !== "CANCELLED" && inv.status !== "DRAFT") throw badRequest("Die Rechnung ist gültig – erst stornieren, dann neu abrechnen");
    }
    await db.update(table).set({ invoiceId: null }).where(eq(table.id, req.params.id));
    return { ok: true };
  });

  // ---------- Material ----------
  app.get<{ Querystring: { customerId?: string; ticketId?: string; projectId?: string; state?: string } }>("/api/charges", async (req) => {
    currentUser(req);
    const q = req.query;
    const conds: (SQL | undefined)[] = [];
    if (q.customerId) conds.push(eq(schema.charges.customerId, q.customerId));
    if (q.ticketId) conds.push(eq(schema.charges.ticketId, q.ticketId));
    if (q.projectId) conds.push(eq(schema.charges.projectId, q.projectId));
    if (q.state === "open") conds.push(isNull(schema.charges.invoiceId));
    if (q.state === "billed") conds.push(isNotNull(schema.charges.invoiceId));
    return listCharges(and(...conds));
  });

  app.post("/api/charges", async (req) => {
    const me = currentUser(req);
    const b = parse(chargeInput, req.body);
    await checkRefs(b);
    const s = await getSettings();
    const [row] = await db
      .insert(schema.charges)
      .values({ ...b, taxRate: s.invoice.smallBusiness ? 0 : b.taxRate, createdById: me.id })
      .returning();
    return row;
  });

  app.put<{ Params: { id: string } }>("/api/charges/:id", async (req) => {
    currentUser(req);
    const b = parse(chargeInput, req.body);
    const c = (await db.select().from(schema.charges).where(eq(schema.charges.id, req.params.id)))[0];
    if (!c) throw notFound("Material");
    checkOpen(c);
    await checkRefs(b);
    const [row] = await db.update(schema.charges).set(b).where(eq(schema.charges.id, c.id)).returning();
    return row;
  });

  app.delete<{ Params: { id: string } }>("/api/charges/:id", async (req) => {
    currentUser(req);
    const c = (await db.select().from(schema.charges).where(eq(schema.charges.id, req.params.id)))[0];
    if (!c) throw notFound("Material");
    checkOpen(c);
    await db.delete(schema.charges).where(eq(schema.charges.id, c.id));
    return { ok: true };
  });

  // ---------- Abrechnung ----------
  /** Offene (nicht abgerechnete) Zeiten und Material je Kunde */
  app.get("/api/billing/open", async (req) => {
    currentUser(req);
    const [entries, chargeRows] = await Promise.all([
      listEntries(and(isNull(schema.timeEntries.invoiceId), eq(schema.timeEntries.billable, true), eq(schema.timeEntries.running, false))),
      listCharges(isNull(schema.charges.invoiceId)),
    ]);
    const by = new Map<string, { customerId: string; customerName: string; minutes: number; timeAmount: number; entries: number; charges: number; chargeAmount: number; oldest: string }>();
    const get = (id: string, name: string, d: string) => {
      if (!by.has(id)) by.set(id, { customerId: id, customerName: name, minutes: 0, timeAmount: 0, entries: 0, charges: 0, chargeAmount: 0, oldest: d });
      const x = by.get(id)!;
      if (d < x.oldest) x.oldest = d;
      return x;
    };
    for (const e of entries) {
      const x = get(e.customerId, e.customerName, e.date);
      x.minutes += e.billedMinutes;
      x.timeAmount += e.amount;
      x.entries++;
    }
    for (const c of chargeRows) {
      const x = get(c.customerId, c.customerName, c.date);
      x.charges++;
      x.chargeAmount += c.amount;
    }
    return [...by.values()].sort((a, b) => b.timeAmount + b.chargeAmount - (a.timeAmount + a.chargeAmount));
  });

  app.post("/api/billing/invoice", async (req) => {
    const me = currentUser(req);
    const b = parse(
      z.object({
        customerId: z.string().min(1),
        timeEntryIds: z.array(z.string()).default([]),
        chargeIds: z.array(z.string()).default([]),
        subject: optStr,
      }),
      req.body,
    );
    return { invoiceId: await billToInvoice({ ...b, userId: me.id }) };
  });

  /** Alles Offene eines Tickets abrechnen */
  app.post<{ Params: { id: string } }>("/api/tickets/:id/invoice", async (req) => {
    const me = currentUser(req);
    const t = (await db.select().from(schema.tickets).where(eq(schema.tickets.id, req.params.id)))[0];
    if (!t) throw notFound("Ticket");
    if (!t.customerId) throw badRequest("Dem Ticket ist kein Kunde zugeordnet");
    const [entries, chargeRows] = await Promise.all([
      db.select({ id: schema.timeEntries.id, running: schema.timeEntries.running }).from(schema.timeEntries).where(and(eq(schema.timeEntries.ticketId, t.id), isNull(schema.timeEntries.invoiceId), eq(schema.timeEntries.billable, true))),
      db.select({ id: schema.charges.id }).from(schema.charges).where(and(eq(schema.charges.ticketId, t.id), isNull(schema.charges.invoiceId))),
    ]);
    if (entries.some((e) => e.running)) throw badRequest("Für dieses Ticket läuft noch eine Stoppuhr");
    const invoiceId = await billToInvoice({
      customerId: t.customerId,
      timeEntryIds: entries.map((e) => e.id),
      chargeIds: chargeRows.map((c) => c.id),
      userId: me.id,
      subject: `Ticket ${t.number}: ${t.subject}`,
    });
    return { invoiceId };
  });
}

export type { Charge, Project };
