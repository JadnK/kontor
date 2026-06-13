import { remindDeadlines } from "../lib/contracts.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, count, desc, eq, gte, inArray, lte, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { badRequest, currentUser, parse, requireAdmin, today } from "../lib/http.js";
import { getPublicSettings, getSettings, isSection, putSection } from "../lib/settings.js";
import { sendMail, verifyMail } from "../lib/mail.js";
import { runReminders } from "../lib/automation.js";
import { runAutoDunning } from "../lib/dunning.js";
import { ticketStats } from "../lib/tickets.js";

export async function adminRoutes(app: FastifyInstance) {
  // ---------- Einstellungen ----------
  app.get("/api/settings", async (req) => {
    currentUser(req);
    return getPublicSettings();
  });

  app.put<{ Params: { section: string } }>("/api/settings/:section", async (req) => {
    requireAdmin(req);
    const { section } = req.params;
    if (!isSection(section)) throw badRequest("Unbekannter Einstellungsbereich");
    if (section === "profiles") {
      // eigener Nummernkreis darf nicht mit dem der Hauptfirma kollidieren
      const main = (await getSettings()).invoice.numberFormat.trim();
      const list = (req.body as { list?: { numberFormat?: string; label?: string }[] })?.list ?? [];
      const clash = list.find((p) => p.numberFormat?.trim() === main);
      if (clash) throw badRequest(`„${clash.label}“: Die Rechnungsnummer muss sich von der Hauptfirma unterscheiden (oder leer bleiben für den gemeinsamen Nummernkreis)`);
    }
    await putSection(section, req.body);
    return getPublicSettings();
  });

  app.post("/api/settings/mail/verify", async (req) => {
    requireAdmin(req);
    try {
      await verifyMail();
      return { ok: true };
    } catch (e) {
      throw badRequest(`SMTP-Verbindung fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
    }
  });

  app.post("/api/settings/mail/test", async (req) => {
    const me = requireAdmin(req);
    const { to } = parse(z.object({ to: z.string().email().optional() }), req.body);
    const r = await sendMail({
      kind: "test",
      to: to ?? me.email,
      subject: "Kontor – Testnachricht",
      text: "Diese Nachricht bestätigt, dass der E-Mail-Versand aus Kontor funktioniert.",
    });
    if (!r.ok) throw badRequest(r.error ?? "Versand fehlgeschlagen");
    return r;
  });

  app.post("/api/automation/reminders/run", async (req) => {
    requireAdmin(req);
    const sent = await runReminders(req.log);
    const dunnings = await runAutoDunning(req.log);
    const contracts = await remindDeadlines(req.log);
    return { sent, dunnings, contracts };
  });

  // ---------- Mail-Protokoll ----------
  app.get<{ Querystring: { status?: string } }>("/api/mail-log", async (req) => {
    currentUser(req);
    return db
      .select()
      .from(schema.mailLogs)
      .where(req.query.status ? eq(schema.mailLogs.status, req.query.status) : undefined)
      .orderBy(desc(schema.mailLogs.createdAt))
      .limit(300);
  });

  // ---------- Dashboard ----------
  app.get("/api/dashboard", async (req) => {
    currentUser(req);
    const t = today();
    const year = t.slice(0, 4);
    const month = t.slice(0, 7);
    const [open, overdue, ytd, mtd, drafts, customers, recent, failedMails] = await Promise.all([
      db
        .select({ n: count(), sum: dsql<number>`coalesce(sum(${schema.invoices.totalGross} - ${schema.invoices.paidTotal}), 0)::int` })
        .from(schema.invoices)
        .where(and(eq(schema.invoices.status, "ISSUED"), eq(schema.invoices.kind, "INVOICE"))),
      db
        .select({ n: count(), sum: dsql<number>`coalesce(sum(${schema.invoices.totalGross} - ${schema.invoices.paidTotal}), 0)::int` })
        .from(schema.invoices)
        .where(and(eq(schema.invoices.status, "ISSUED"), eq(schema.invoices.kind, "INVOICE"), dsql`${schema.invoices.dueDate} < ${t}`)),
      db
        .select({ sum: dsql<number>`coalesce(sum(${schema.incomes.amount}), 0)::int` })
        .from(schema.incomes)
        .where(and(gte(schema.incomes.date, `${year}-01-01`), lte(schema.incomes.date, t))),
      db
        .select({ sum: dsql<number>`coalesce(sum(${schema.incomes.amount}), 0)::int` })
        .from(schema.incomes)
        .where(and(gte(schema.incomes.date, `${month}-01`), lte(schema.incomes.date, t))),
      db.select({ n: count() }).from(schema.invoices).where(eq(schema.invoices.status, "DRAFT")),
      db.select({ n: count() }).from(schema.customers).where(eq(schema.customers.archived, false)),
      db
        .select({ id: schema.incomes.id, date: schema.incomes.date, amount: schema.incomes.amount, description: schema.incomes.description })
        .from(schema.incomes)
        .orderBy(desc(schema.incomes.date), desc(schema.incomes.createdAt))
        .limit(8),
      db
        .select({ n: count() })
        .from(schema.mailLogs)
        .where(and(eq(schema.mailLogs.status, "FAILED"), gte(schema.mailLogs.createdAt, new Date(Date.now() - 7 * 86_400_000)))),
    ]);
    const due = await db
      .select({
        id: schema.invoices.id,
        number: schema.invoices.number,
        dueDate: schema.invoices.dueDate,
        totalGross: schema.invoices.totalGross,
        paidTotal: schema.invoices.paidTotal,
        reminderCount: schema.invoices.reminderCount,
        company: schema.customers.company,
        firstName: schema.customers.firstName,
        lastName: schema.customers.lastName,
        ctype: schema.customers.type,
      })
      .from(schema.invoices)
      .innerJoin(schema.customers, eq(schema.customers.id, schema.invoices.customerId))
      .where(and(eq(schema.invoices.status, "ISSUED"), eq(schema.invoices.kind, "INVOICE")))
      .orderBy(schema.invoices.dueDate)
      .limit(8);
    const bankPending = (
      await db
        .select({ n: count() })
        .from(schema.bankTransactions)
        .where(and(inArray(schema.bankTransactions.status, ["UNMATCHED", "SUGGESTED"]), dsql`${schema.bankTransactions.amount} > 0`))
    )[0].n;
    const tickets = await ticketStats();
    const quoteRows = await db
      .select({ status: schema.quotes.status, n: count(), sum: dsql<number>`coalesce(sum(${schema.quotes.totalGross}), 0)::int` })
      .from(schema.quotes)
      .where(and(inArray(schema.quotes.status, ["SENT", "ACCEPTED"]), dsql`(${schema.quotes.status} <> 'SENT' or ${schema.quotes.validUntil} is null or ${schema.quotes.validUntil} >= ${t})`))
      .groupBy(schema.quotes.status);
    const qOf = (s: string) => quoteRows.find((r) => r.status === s) ?? { n: 0, sum: 0 };
    const months = await db
      .select({
        m: dsql<string>`to_char(${schema.incomes.date}, 'YYYY-MM')`,
        total: dsql<number>`sum(${schema.incomes.amount})::int`,
      })
      .from(schema.incomes)
      .where(gte(schema.incomes.date, dsql`(date_trunc('month', current_date) - interval '11 months')::date`))
      .groupBy(dsql`1`)
      .orderBy(dsql`1`);
    return {
      open: open[0],
      overdue: overdue[0],
      incomeYear: ytd[0].sum,
      incomeMonth: mtd[0].sum,
      drafts: drafts[0].n,
      customers: customers[0].n,
      recentIncome: recent,
      failedMails: failedMails[0].n,
      months,
      bankPending,
      tickets: { open: tickets.open.n, unread: tickets.open.unread, pending: tickets.pending.n },
      quotes: { open: qOf("SENT").n, openSum: qOf("SENT").sum, accepted: qOf("ACCEPTED").n, acceptedSum: qOf("ACCEPTED").sum },
      dueInvoices: due.map((d) => ({
        id: d.id,
        number: d.number,
        dueDate: d.dueDate,
        open: d.totalGross - d.paidTotal,
        reminderCount: d.reminderCount,
        overdue: !!d.dueDate && d.dueDate < t,
        customerName: (d.ctype === "COMPANY" ? d.company : null) || [d.firstName, d.lastName].filter(Boolean).join(" ") || d.company || "",
      })),
    };
  });

  // Datensicherung (Export/Import): siehe routes/backup.ts
}
