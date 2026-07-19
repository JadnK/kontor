import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, ilike, inArray, or, sql as dsql, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { badRequest, currentUser, notFound, optStr, parse, requireAdmin } from "../lib/http.js";
import { getSettings, getState, nextNumber, putSection } from "../lib/settings.js";
import { acceptFiltered, autoCloseTickets, pollTicketMailbox, replyToTicket, ticketStats, verifyTicketMailbox, type OutAttachment } from "../lib/tickets.js";

const statusEnum = z.enum(["OPEN", "PENDING", "CLOSED"]);

const attachmentInput = z
  .array(z.object({ filename: z.string().min(1).max(200), contentType: z.string().optional(), data: z.string().min(1) }))
  .max(10)
  .default([]);

function toAttachments(list: z.infer<typeof attachmentInput>): OutAttachment[] {
  const out = list.map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.data, "base64") }));
  if (out.reduce((s, a) => s + a.content.length, 0) > 15 * 1024 * 1024) throw badRequest("Anhänge zusammen max. 15 MB");
  return out;
}

export async function ticketRoutes(app: FastifyInstance) {
  app.get("/api/tickets/stats", async (req) => {
    currentUser(req);
    const [stats, last, s] = await Promise.all([ticketStats(), getState<{ at: string; error: string | null } | null>("tickets_last_poll", null), getSettings()]);
    return { ...stats, lastPoll: last, enabled: s.tickets.enabled, address: s.tickets.address };
  });

  app.get<{ Querystring: { status?: string; q?: string; mine?: string; priority?: string; category?: string } }>("/api/tickets", async (req) => {
    const me = currentUser(req);
    const conds: (SQL | undefined)[] = [];
    const st = req.query.status;
    if (st === "OPEN" || st === "PENDING" || st === "CLOSED") conds.push(eq(schema.tickets.status, st));
    else if (st !== "ALL") conds.push(inArray(schema.tickets.status, ["OPEN", "PENDING"]));
    if (req.query.mine === "true") conds.push(eq(schema.tickets.assigneeId, me.id));
    if (req.query.priority && ["LOW", "NORMAL", "HIGH", "URGENT"].includes(req.query.priority)) conds.push(eq(schema.tickets.priority, req.query.priority as "LOW"));
    if (req.query.category) conds.push(eq(schema.tickets.category, req.query.category));
    const q = req.query.q?.trim();
    if (q) {
      const p = `%${q}%`;
      conds.push(or(ilike(schema.tickets.number, p), ilike(schema.tickets.subject, p), ilike(schema.tickets.contactEmail, p), ilike(schema.tickets.contactName, p)));
    }
    const rows = await db
      .select({
        t: schema.tickets,
        company: schema.customers.company,
        firstName: schema.customers.firstName,
        lastName: schema.customers.lastName,
        assignee: schema.users.name,
        messages: dsql<number>`(select count(*) from ticket_messages m where m.ticket_id = "tickets"."id" and m.direction <> 'NOTE')::int`,
        snippet: dsql<string | null>`(select left(m.body, 160) from ticket_messages m where m.ticket_id = "tickets"."id" and m.direction <> 'NOTE' order by m.created_at desc limit 1)`,
        lastDirection: dsql<string | null>`(select m.direction from ticket_messages m where m.ticket_id = "tickets"."id" and m.direction <> 'NOTE' order by m.created_at desc limit 1)`,
      })
      .from(schema.tickets)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.tickets.customerId))
      .leftJoin(schema.users, eq(schema.users.id, schema.tickets.assigneeId))
      .where(and(...conds))
      .orderBy(dsql`case ${schema.tickets.priority} when 'URGENT' then 0 when 'HIGH' then 1 else 2 end`, desc(schema.tickets.lastMessageAt))
      .limit(500);
    return rows.map((r) => ({
      ...r.t,
      customerName: r.company || [r.firstName, r.lastName].filter(Boolean).join(" ") || null,
      assigneeName: r.assignee,
      messageCount: r.messages,
      snippet: r.snippet,
      lastDirection: r.lastDirection,
    }));
  });

  app.get<{ Params: { id: string } }>("/api/tickets/:id", async (req) => {
    currentUser(req);
    const t = (await db.select().from(schema.tickets).where(eq(schema.tickets.id, req.params.id)))[0];
    if (!t) throw notFound("Ticket");
    const [messages, attachments, customer, users, time, chargeRows, projects] = await Promise.all([
      db
        .select({ m: schema.ticketMessages, author: schema.users.name })
        .from(schema.ticketMessages)
        .leftJoin(schema.users, eq(schema.users.id, schema.ticketMessages.authorId))
        .where(eq(schema.ticketMessages.ticketId, t.id))
        .orderBy(schema.ticketMessages.createdAt),
      db
        .select({
          id: schema.ticketAttachments.id,
          messageId: schema.ticketAttachments.messageId,
          filename: schema.ticketAttachments.filename,
          contentType: schema.ticketAttachments.contentType,
          size: schema.ticketAttachments.size,
        })
        .from(schema.ticketAttachments)
        .innerJoin(schema.ticketMessages, eq(schema.ticketMessages.id, schema.ticketAttachments.messageId))
        .where(eq(schema.ticketMessages.ticketId, t.id)),
      t.customerId ? db.select().from(schema.customers).where(eq(schema.customers.id, t.customerId)) : Promise.resolve([]),
      db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(eq(schema.users.active, true)),
      db
        .select({ e: schema.timeEntries, userName: schema.users.name, invoiceNumber: schema.invoices.number })
        .from(schema.timeEntries)
        .leftJoin(schema.users, eq(schema.users.id, schema.timeEntries.userId))
        .leftJoin(schema.invoices, eq(schema.invoices.id, schema.timeEntries.invoiceId))
        .where(eq(schema.timeEntries.ticketId, t.id))
        .orderBy(desc(schema.timeEntries.date)),
      db
        .select({ c: schema.charges, invoiceNumber: schema.invoices.number })
        .from(schema.charges)
        .leftJoin(schema.invoices, eq(schema.invoices.id, schema.charges.invoiceId))
        .where(eq(schema.charges.ticketId, t.id))
        .orderBy(desc(schema.charges.date)),
      t.customerId
        ? db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).where(and(eq(schema.projects.customerId, t.customerId), eq(schema.projects.archived, false)))
        : Promise.resolve([]),
    ]);
    if (t.unread) await db.update(schema.tickets).set({ unread: false }).where(eq(schema.tickets.id, t.id));
    return {
      ...t,
      unread: false,
      customer: customer[0] ?? null,
      users,
      messages: messages.map((x) => ({ ...x.m, authorName: x.author, attachments: attachments.filter((a) => a.messageId === x.m.id) })),
      time: time.map((x) => ({
        ...x.e,
        minutes: x.e.running && x.e.startedAt ? Math.max(1, Math.ceil((Date.now() - x.e.startedAt.getTime()) / 60000)) : x.e.minutes,
        userName: x.userName,
        invoiceNumber: x.invoiceNumber,
      })),
      charges: chargeRows.map((x) => ({ ...x.c, invoiceNumber: x.invoiceNumber, amount: Math.round(x.c.quantity * x.c.unitPriceNet) })),
      projects,
    };
  });

  /** Ticket von Hand anlegen (z. B. nach einem Anruf) – optional sofort per Mail an den Kunden */
  app.post("/api/tickets", async (req) => {
    const me = currentUser(req);
    const body = parse(
      z.object({
        customerId: optStr,
        email: z.string().trim().email("Gültige E-Mail angeben").optional(),
        name: optStr,
        subject: z.string().trim().min(1, "Betreff fehlt"),
        body: z.string().trim().min(1, "Text fehlt"),
        sendToCustomer: z.boolean().default(false),
        priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
        category: optStr,
      }),
      req.body,
    );
    const customer = body.customerId ? (await db.select().from(schema.customers).where(eq(schema.customers.id, body.customerId)))[0] : null;
    const email = body.email ?? customer?.email;
    if (!email) throw badRequest("E-Mail-Adresse des Kontakts fehlt");
    const s = await getSettings();
    const ticket = await db.transaction(async (tx) => {
      const number = await nextNumber(tx, "ticket", s.tickets.numberFormat);
      const [t] = await tx
        .insert(schema.tickets)
        .values({
          number,
          subject: body.subject,
          customerId: customer?.id ?? null,
          contactEmail: email.toLowerCase(),
          contactName: body.name ?? ([customer?.firstName, customer?.lastName].filter(Boolean).join(" ") || null),
          assigneeId: me.id,
          unread: false,
          priority: body.priority ?? s.tickets.defaultPriority,
          category: body.category,
        })
        .returning();
      if (!body.sendToCustomer) {
        await tx.insert(schema.ticketMessages).values({ ticketId: t.id, direction: "NOTE", body: body.body, authorId: me.id });
      }
      return t;
    });
    if (body.sendToCustomer) {
      try {
        await replyToTicket(ticket.id, body.body, me);
        await db.update(schema.tickets).set({ status: "PENDING" }).where(eq(schema.tickets.id, ticket.id));
      } catch (e) {
        await db.insert(schema.ticketMessages).values({ ticketId: ticket.id, direction: "NOTE", body: body.body, authorId: me.id });
        throw badRequest(`Ticket angelegt, aber Mail fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
      }
    }
    return { id: ticket.id, number: ticket.number };
  });

  app.patch<{ Params: { id: string } }>("/api/tickets/:id", async (req) => {
    currentUser(req);
    const body = parse(
      z.object({
        status: statusEnum.optional(),
        assigneeId: z.string().nullable().optional(),
        customerId: z.string().nullable().optional(),
        subject: z.string().trim().min(1).optional(),
        priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
        category: z.string().trim().nullable().optional(),
        projectId: z.string().nullable().optional(),
      }),
      req.body,
    );
    const [t] = await db.update(schema.tickets).set(body).where(eq(schema.tickets.id, req.params.id)).returning();
    if (!t) throw notFound("Ticket");
    return t;
  });

  app.post<{ Params: { id: string } }>("/api/tickets/:id/reply", { bodyLimit: 25 * 1024 * 1024 }, async (req) => {
    const me = currentUser(req);
    const body = parse(
      z.object({ body: z.string().trim().min(1, "Antworttext fehlt"), status: statusEnum.default("PENDING"), attachments: attachmentInput }),
      req.body,
    );
    const t = (await db.select().from(schema.tickets).where(eq(schema.tickets.id, req.params.id)))[0];
    if (!t) throw notFound("Ticket");
    try {
      await replyToTicket(t.id, body.body, me, toAttachments(body.attachments));
    } catch (e) {
      throw badRequest(`Antwort konnte nicht gesendet werden: ${e instanceof Error ? e.message : e}`);
    }
    await db
      .update(schema.tickets)
      .set({ status: body.status, unread: false, lastMessageAt: new Date(), assigneeId: t.assigneeId ?? me.id })
      .where(eq(schema.tickets.id, t.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/tickets/:id/notes", async (req) => {
    const me = currentUser(req);
    const { body } = parse(z.object({ body: z.string().trim().min(1, "Notiz ist leer") }), req.body);
    const t = (await db.select({ id: schema.tickets.id }).from(schema.tickets).where(eq(schema.tickets.id, req.params.id)))[0];
    if (!t) throw notFound("Ticket");
    await db.insert(schema.ticketMessages).values({ ticketId: t.id, direction: "NOTE", body, authorId: me.id });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/tickets/attachments/:id", async (req, reply) => {
    currentUser(req);
    const a = (await db.select().from(schema.ticketAttachments).where(eq(schema.ticketAttachments.id, req.params.id)))[0];
    if (!a) throw notFound("Anhang");
    return reply
      .header("Content-Type", a.contentType)
      .header("Content-Disposition", `attachment; filename="${encodeURIComponent(a.filename)}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`)
      .send(a.data);
  });

  app.delete<{ Params: { id: string } }>("/api/tickets/:id", async (req) => {
    requireAdmin(req);
    await db.delete(schema.tickets).where(eq(schema.tickets.id, req.params.id));
    return { ok: true };
  });

  // ---------- Aussortierte Mails ----------
  app.get("/api/tickets-filtered", async (req) => {
    currentUser(req);
    return db
      .select({
        id: schema.inboxFiltered.id,
        fromEmail: schema.inboxFiltered.fromEmail,
        fromName: schema.inboxFiltered.fromName,
        subject: schema.inboxFiltered.subject,
        snippet: schema.inboxFiltered.snippet,
        reason: schema.inboxFiltered.reason,
        score: schema.inboxFiltered.score,
        receivedAt: schema.inboxFiltered.receivedAt,
      })
      .from(schema.inboxFiltered)
      .where(eq(schema.inboxFiltered.status, "FILTERED"))
      .orderBy(desc(schema.inboxFiltered.receivedAt))
      .limit(300);
  });

  /** Doch als Ticket übernehmen, optional Absender künftig immer zulassen */
  app.post<{ Params: { id: string } }>("/api/tickets-filtered/:id/accept", async (req) => {
    currentUser(req);
    const { allowSender } = parse(z.object({ allowSender: z.boolean().default(false) }), req.body);
    const row = (await db.select().from(schema.inboxFiltered).where(eq(schema.inboxFiltered.id, req.params.id)))[0];
    if (!row) throw notFound("Mail");
    const ticketId = await acceptFiltered(row.id, req.log);
    if (allowSender) {
      const t = (await getSettings()).tickets;
      if (!t.allowSenders.includes(row.fromEmail)) await putSection("tickets", { allowSenders: [...t.allowSenders, row.fromEmail] });
    }
    return { ticketId };
  });

  /** Absender sperren und alle aussortierten Mails von ihm entfernen */
  app.post<{ Params: { id: string } }>("/api/tickets-filtered/:id/block", async (req) => {
    currentUser(req);
    const { domain } = parse(z.object({ domain: z.boolean().default(false) }), req.body);
    const row = (await db.select().from(schema.inboxFiltered).where(eq(schema.inboxFiltered.id, req.params.id)))[0];
    if (!row) throw notFound("Mail");
    const entry = domain ? `@${row.fromEmail.split("@")[1]}` : row.fromEmail;
    const t = (await getSettings()).tickets;
    if (!t.blockSenders.includes(entry)) await putSection("tickets", { blockSenders: [...t.blockSenders, entry] });
    await db
      .update(schema.inboxFiltered)
      .set({ status: "DELETED", raw: null })
      .where(and(eq(schema.inboxFiltered.status, "FILTERED"), domain ? ilike(schema.inboxFiltered.fromEmail, `%${entry}`) : eq(schema.inboxFiltered.fromEmail, row.fromEmail)));
    return { blocked: entry };
  });

  app.delete<{ Params: { id: string } }>("/api/tickets-filtered/:id", async (req) => {
    currentUser(req);
    await db.update(schema.inboxFiltered).set({ status: "DELETED", raw: null }).where(eq(schema.inboxFiltered.id, req.params.id));
    return { ok: true };
  });

  app.post("/api/tickets-filtered/clear", async (req) => {
    currentUser(req);
    await db.update(schema.inboxFiltered).set({ status: "DELETED", raw: null }).where(eq(schema.inboxFiltered.status, "FILTERED"));
    return { ok: true };
  });

  // ---------- Postfach ----------
  app.post("/api/tickets/poll", async (req) => {
    currentUser(req);
    const r = await pollTicketMailbox(req.log, true);
    const closed = await autoCloseTickets(req.log);
    return { ...r, closed };
  });

  app.post("/api/settings/tickets/verify", async (req) => {
    requireAdmin(req);
    try {
      return await verifyTicketMailbox();
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : String(e));
    }
  });
}
