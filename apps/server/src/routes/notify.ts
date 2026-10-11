/**
 * Ereignis-Feed für Desktop-Benachrichtigungen: Die App fragt regelmäßig nach allem seit dem letzten Abruf
 * (Zahlungseingänge, neue Tickets, Kundenantworten, Angebotsantworten) und zeigt es als Systemmeldung.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, isNotNull, isNull, ne, or, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { formatMoney } from "../lib/calc.js";
import { badRequest, currentUser } from "../lib/http.js";
import { getSettings } from "../lib/settings.js";

export interface FeedEvent {
  id: string;
  kind: "payment" | "ticket" | "ticketReply" | "quote";
  at: string;
  title: string;
  body: string;
  route: { name: string; id?: string };
}

export async function notifyRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { since?: string } }>("/api/notifications/feed", async (req) => {
    const me = currentUser(req);
    const now = new Date();
    if (!req.query.since) return { now: now.toISOString(), events: [] };
    const since = new Date(req.query.since);
    if (Number.isNaN(since.getTime())) throw badRequest("since ungültig");
    // höchstens 2 Tage zurück, damit nach langer Pause keine Flut kommt
    const from = new Date(Math.max(since.getTime(), now.getTime() - 2 * 86_400_000));
    const s = await getSettings();
    const cur = s.invoice.currency;
    const custName = dsql<string>`coalesce(nullif(${schema.customers.company}, ''), trim(coalesce(${schema.customers.firstName}, '') || ' ' || coalesce(${schema.customers.lastName}, '')))`;
    const events: FeedEvent[] = [];

    // Zahlungen (automatisch gebucht oder von Kollegen erfasst, nicht die eigenen Eingaben)
    const pays = await db
      .select({ i: schema.incomes, number: schema.invoices.number, status: schema.invoices.status, customer: custName })
      .from(schema.incomes)
      .innerJoin(schema.invoices, eq(schema.invoices.id, schema.incomes.invoiceId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.incomes.customerId))
      .where(and(gt(schema.incomes.createdAt, from), isNotNull(schema.incomes.invoiceId), or(isNull(schema.incomes.createdById), ne(schema.incomes.createdById, me.id))))
      .orderBy(desc(schema.incomes.createdAt))
      .limit(20);
    for (const p of pays)
      events.push({
        id: `pay:${p.i.id}`,
        kind: "payment",
        at: p.i.createdAt.toISOString(),
        title: `Zahlung eingegangen: ${formatMoney(p.i.amount, cur)}`,
        body: `${p.customer ?? ""} · ${p.number}${p.status === "PAID" ? " ist jetzt bezahlt" : " teilweise bezahlt"}${p.i.method && p.i.method !== "Überweisung" ? ` (${p.i.method})` : ""}`,
        route: { name: "invoice", id: p.i.invoiceId! },
      });

    // Neue Tickets
    const tickets = await db
      .select({ t: schema.tickets, customer: custName })
      .from(schema.tickets)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.tickets.customerId))
      .where(gt(schema.tickets.createdAt, from))
      .orderBy(desc(schema.tickets.createdAt))
      .limit(20);
    const newIds = new Set(tickets.map((t) => t.t.id));
    for (const { t, customer } of tickets)
      events.push({
        id: `ticket:${t.id}`,
        kind: "ticket",
        at: t.createdAt.toISOString(),
        title: `Neues Ticket${t.priority === "URGENT" || t.priority === "HIGH" ? " (dringend)" : ""}: ${t.subject}`,
        body: `${t.number} · ${customer || t.contactName || t.contactEmail}`,
        route: { name: "ticket", id: t.id },
      });

    // Antworten von Kunden auf bestehende Tickets
    const replies = await db
      .select({ m: schema.ticketMessages, number: schema.tickets.number })
      .from(schema.ticketMessages)
      .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketMessages.ticketId))
      .where(and(gt(schema.ticketMessages.createdAt, from), eq(schema.ticketMessages.direction, "IN")))
      .orderBy(desc(schema.ticketMessages.createdAt))
      .limit(20);
    for (const r of replies) {
      if (newIds.has(r.m.ticketId)) continue;
      events.push({
        id: `reply:${r.m.id}`,
        kind: "ticketReply",
        at: r.m.createdAt.toISOString(),
        title: `Antwort zu ${r.number}`,
        body: `${r.m.fromName ?? r.m.fromEmail}: ${r.m.body.replace(/\s+/g, " ").slice(0, 120)}`,
        route: { name: "ticket", id: r.m.ticketId },
      });
    }

    // Angebote angenommen/abgelehnt
    const quotes = await db
      .select({ q: schema.quotes, customer: custName })
      .from(schema.quotes)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.quotes.customerId))
      .where(and(isNotNull(schema.quotes.answeredAt), gt(schema.quotes.answeredAt, from)))
      .limit(20);
    for (const { q, customer } of quotes)
      events.push({
        id: `quote:${q.id}:${q.status}`,
        kind: "quote",
        at: q.answeredAt!.toISOString(),
        title: q.status === "DECLINED" ? `Angebot abgelehnt: ${q.number}` : `Angebot angenommen: ${q.number}`,
        body: `${customer ?? ""} · ${formatMoney(q.totalGross, cur)}${q.answeredBy ? ` · ${q.answeredBy}` : ""}`,
        route: { name: "quote", id: q.id },
      });

    events.sort((a, b) => a.at.localeCompare(b.at));
    return { now: now.toISOString(), events };
  });
}
