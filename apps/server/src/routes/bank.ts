/**
 * Zahlungsabgleich: Kontoauszug importieren, Zahlungseingänge automatisch Rechnungen zuordnen.
 *
 * Zuordnung (in dieser Reihenfolge):
 *  1. Rechnungsnummer steht im Verwendungszweck (auch mit Leerzeichen/ohne Bindestriche, mit oder ohne Präfix)
 *     → Betrag ≤ offen: automatisch buchen. Mehrere Nummern und Summe passt: alle buchen.
 *  2. Keine Nummer, aber genau eine offene Rechnung mit exakt diesem Betrag (bevorzugt mit passendem Namen)
 *     → nur Vorschlag, Bestätigung per Klick.
 *  Alles andere bleibt offen zur manuellen Zuordnung.
 */
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, gt, inArray, lt, sql as dsql } from "drizzle-orm";
import { db, schema, type Tx } from "../db/index.js";
import type { BankTransaction } from "../db/schema.js";
import { badRequest, currentUser, notFound, optStr, parse } from "../lib/http.js";
import { ParseError, parseStatement, txHashes } from "../lib/bank-parse.js";
import { getSettings } from "../lib/settings.js";
import { onPayment } from "../lib/automation.js";
import { isStripePayout } from "../lib/portal.js";
import { formatMoney } from "../lib/calc.js";
import { claimsByInvoice } from "../lib/dunning.js";
import { autoBookDebits, bookDebit, learnSupplier } from "../lib/expenses.js";
import { recalcPaid } from "./invoices.js";

export interface OpenInvoice {
  id: string;
  number: string;
  customerId: string;
  open: number;
  /** Gesamtforderung der letzten Mahnung (offen + Gebühren + Zinsen), falls gemahnt */
  claim?: number | null;
  names: string[];
}

interface Allocation {
  invoice: OpenInvoice;
  amount: number;
}

/** Zusätzliche Einnahme ohne Rechnungsbezug, z. B. bezahlte Mahngebühren */
interface Extra {
  customerId: string;
  amount: number;
  description: string;
}

export type Decision =
  | { kind: "book"; allocations: Allocation[]; note: string; extras?: Extra[] }
  | { kind: "suggest"; invoiceId: string; note: string }
  | { kind: "none" };

const REOPENED = "Von Hand wieder geöffnet";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Muster, das "RE-2026-0001" auch als "RE 2026 0001", "RE20260001" oder "2026-0001" findet */
export function numberPatterns(number: string): RegExp[] {
  const chunks = number.toUpperCase().match(/[A-Z]+|\d+/g) ?? [];
  if (!chunks.length) return [];
  const sep = "[\\s\\-_/.:#]*";
  const wrap = (parts: string[]) => new RegExp(`(?<![A-Z0-9])${parts.map(escapeRe).join(sep)}(?![0-9])`, "i");
  const out = [wrap(chunks)];
  const numeric = chunks.filter((c) => /^\d+$/.test(c));
  // ohne Buchstaben-Präfix nur, wenn genug Ziffern übrig bleiben (Fehltreffer vermeiden)
  if (numeric.length && numeric.join("").length >= 6 && numeric.length !== chunks.length) out.push(wrap(numeric));
  return out;
}

const STOP = new Set(["GMBH", "MBH", "UND", "KG", "OHG", "UG", "AG", "GBR", "HAFTUNGSBESCHRAENKT", "FIRMA", "HERR", "FRAU"]);

async function loadOpenInvoices(): Promise<OpenInvoice[]> {
  const rows = await db
    .select({
      id: schema.invoices.id,
      number: schema.invoices.number,
      customerId: schema.invoices.customerId,
      total: schema.invoices.totalGross,
      paid: schema.invoices.paidTotal,
      company: schema.customers.company,
      firstName: schema.customers.firstName,
      lastName: schema.customers.lastName,
    })
    .from(schema.invoices)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.invoices.customerId))
    .where(and(eq(schema.invoices.status, "ISSUED"), eq(schema.invoices.kind, "INVOICE")));
  const claims = await claimsByInvoice();
  return rows
    .filter((r) => r.number && r.total - r.paid > 0)
    .map((r) => ({
      claim: claims.get(r.id) ?? null,
      id: r.id,
      number: r.number!,
      customerId: r.customerId,
      open: r.total - r.paid,
      names: [r.company, r.lastName, r.firstName]
        .filter(Boolean)
        .flatMap((n) => n!.toUpperCase().split(/[^A-ZÄÖÜ0-9]+/))
        .filter((t) => t.length >= 3 && !STOP.has(t)),
    }));
}

export function decide(
  tx: Pick<BankTransaction, "amount" | "purpose" | "reference" | "counterpartyName">,
  open: OpenInvoice[],
  autoBook: boolean,
): Decision {
  if (tx.amount <= 0) return { kind: "none" };
  const hay = `${tx.purpose ?? ""} ${tx.reference ?? ""}`.toUpperCase();

  const hits = open.filter((inv) => numberPatterns(inv.number).some((re) => re.test(hay)));
  if (hits.length === 1) {
    const inv = hits[0];
    // Gemahnt und genau die Gesamtforderung (oder dazwischen) überwiesen → Rest als Mahngebühren/Zinsen buchen
    if (tx.amount > inv.open && inv.claim && tx.amount <= inv.claim) {
      const extra = tx.amount - inv.open;
      const note = `Rechnungsnummer im Verwendungszweck, inkl. ${formatMoney(extra)} Mahngebühren/Zinsen`;
      return autoBook
        ? { kind: "book", allocations: [{ invoice: inv, amount: inv.open }], note, extras: [{ customerId: inv.customerId, amount: extra, description: `Mahngebühren/Verzugszinsen zu ${inv.number}` }] }
        : { kind: "suggest", invoiceId: inv.id, note };
    }
    if (tx.amount <= inv.open) {
      const note =
        tx.amount < inv.open ? `Rechnungsnummer im Verwendungszweck, Teilzahlung (offen waren ${formatMoney(inv.open)})` : "Rechnungsnummer im Verwendungszweck";
      return autoBook ? { kind: "book", allocations: [{ invoice: inv, amount: tx.amount }], note } : { kind: "suggest", invoiceId: inv.id, note };
    }
    return { kind: "suggest", invoiceId: inv.id, note: `Rechnungsnummer gefunden, Betrag höher als offen (${formatMoney(inv.open)})` };
  }
  if (hits.length > 1) {
    const sum = hits.reduce((a, i) => a + i.open, 0);
    const list = hits.map((h) => h.number).join(", ");
    if (sum === tx.amount) {
      const note = `Sammelzahlung für ${list}`;
      return autoBook
        ? { kind: "book", allocations: hits.map((h) => ({ invoice: h, amount: h.open })), note }
        : { kind: "suggest", invoiceId: hits[0].id, note };
    }
    return { kind: "suggest", invoiceId: hits[0].id, note: `Mehrere Rechnungsnummern genannt (${list}), Summe passt nicht` };
  }

  const sameAmount = open.filter((i) => i.open === tx.amount);
  if (!sameAmount.length) return { kind: "none" };
  const payer = (tx.counterpartyName ?? "").toUpperCase();
  const byName = sameAmount.filter((i) => i.names.some((n) => payer.includes(n)));
  if (byName.length === 1) return { kind: "suggest", invoiceId: byName[0].id, note: "Betrag und Name des Zahlers passen" };
  if (sameAmount.length === 1) return { kind: "suggest", invoiceId: sameAmount[0].id, note: "Betrag passt, keine Rechnungsnummer angegeben" };
  return { kind: "none" };
}

/**
 * Zahlung buchen: Einnahme(n) anlegen, Rechnung(en) neu berechnen, Buchung als zugeordnet markieren.
 * Gibt false zurück, wenn die Buchung inzwischen schon von einem parallelen Abgleich zugeordnet wurde.
 */
async function book(
  tx: BankTransaction,
  allocations: { invoiceId: string; amount: number }[],
  note: string,
  userId: string | null,
  log: FastifyBaseLogger,
  extras: Extra[] = [],
): Promise<boolean> {
  const paid: { id: string; amount: number }[] = [];
  let claimed = false;
  await db.transaction(async (t) => {
    // Atomar beanspruchen: laufen Import, Kontoabruf und "Neu abgleichen" gleichzeitig, bucht nur einer
    const claim = await t
      .update(schema.bankTransactions)
      .set({ status: "MATCHED" })
      .where(and(eq(schema.bankTransactions.id, tx.id), inArray(schema.bankTransactions.status, ["UNMATCHED", "SUGGESTED"])))
      .returning({ id: schema.bankTransactions.id });
    if (!claim.length) return;
    claimed = true;
    for (const a of allocations) {
      const inv = (await t.select().from(schema.invoices).where(eq(schema.invoices.id, a.invoiceId)))[0];
      if (!inv) throw notFound("Rechnung");
      if (inv.kind !== "INVOICE" || (inv.status !== "ISSUED" && inv.status !== "PAID")) throw badRequest(`Rechnung ${inv.number ?? ""} ist nicht offen`);
      const wasPaid = inv.status === "PAID" || inv.totalGross - inv.paidTotal <= 0;
      await t.insert(schema.incomes).values({
        date: tx.bookingDate,
        amount: a.amount,
        method: "Überweisung",
        category: "Rechnung",
        description: `Zahlung zu ${inv.number}${tx.counterpartyName ? ` von ${tx.counterpartyName}` : ""}`,
        invoiceId: inv.id,
        customerId: inv.customerId,
        bankTransactionId: tx.id,
        createdById: userId,
      });
      await recalcPaid(t, inv.id);
      if (!wasPaid) paid.push({ id: inv.id, amount: a.amount });
    }
    for (const e of extras) {
      await t.insert(schema.incomes).values({
        date: tx.bookingDate,
        amount: e.amount,
        method: "Überweisung",
        category: "Mahngebühren",
        description: e.description,
        customerId: e.customerId,
        bankTransactionId: tx.id,
        createdById: userId,
      });
    }
    await t
      .update(schema.bankTransactions)
      .set({ status: "MATCHED", invoiceId: allocations[0]?.invoiceId ?? null, matchNote: note })
      .where(eq(schema.bankTransactions.id, tx.id));
  });
  if (!claimed) return false;
  // Bestätigung pro Bankbuchung nur einmal – auch wenn sie aufgehoben und neu zugeordnet wird
  if (paid.length && !tx.confirmationSentAt) {
    void (async () => {
      let sent = false;
      for (const p of paid) sent = (await onPayment(p.id, p.amount, log)) || sent;
      if (sent) await db.update(schema.bankTransactions).set({ confirmationSentAt: new Date() }).where(eq(schema.bankTransactions.id, tx.id));
    })().catch((e) => log.warn(e, "Zahlungsbestätigung fehlgeschlagen"));
  }
  return true;
}

/**
 * Dieselbe Zahlung schon erfasst? (z. B. erst von Hand in der Rechnung gebucht, oder einmal per
 * CSV und einmal per Kontoabruf eingelesen). Rechnungsnummer im Verwendungszweck + bezahlte Rechnung
 * + Einnahme mit gleichem Betrag innerhalb von 14 Tagen.
 */
async function findExisting(tx: BankTransaction) {
  if (tx.amount <= 0) return null;
  const hay = `${tx.purpose ?? ""} ${tx.reference ?? ""}`.toUpperCase();
  if (!hay.trim()) return null;
  const rows = await db
    .select({ income: schema.incomes, number: schema.invoices.number })
    .from(schema.incomes)
    .innerJoin(schema.invoices, eq(schema.invoices.id, schema.incomes.invoiceId))
    .where(
      and(
        eq(schema.incomes.amount, tx.amount),
        eq(schema.invoices.status, "PAID"),
        dsql`abs(${schema.incomes.date}::date - ${tx.bookingDate}::date) <= 14`,
      ),
    );
  return rows.find((r) => r.number && numberPatterns(r.number).some((re) => re.test(hay))) ?? null;
}

/** Bereits erfasste Zahlung: von Hand erfasste Einnahme verknüpfen, doppelte Bankbuchung ignorieren */
async function resolveExisting(tx: BankTransaction): Promise<"MATCHED" | "IGNORED" | null> {
  const hit = await findExisting(tx);
  if (!hit) return null;
  const { income, number } = hit;
  if (!income.bankTransactionId) {
    // Zahlung wurde von Hand in der Rechnung erfasst → nur verknüpfen, keine zweite Einnahme, keine Mail
    const done = await db.transaction(async (t) => {
      const claim = await t
        .update(schema.bankTransactions)
        .set({ status: "MATCHED", invoiceId: income.invoiceId, matchNote: `Zahlung zu ${number} war schon von Hand erfasst – verknüpft` })
        .where(and(eq(schema.bankTransactions.id, tx.id), inArray(schema.bankTransactions.status, ["UNMATCHED", "SUGGESTED"])))
        .returning({ id: schema.bankTransactions.id });
      if (!claim.length) return false;
      await t.update(schema.incomes).set({ bankTransactionId: tx.id }).where(eq(schema.incomes.id, income.id));
      return true;
    });
    return done ? "MATCHED" : null;
  }
  if (income.bankTransactionId === tx.id) return null;
  const other = (await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, income.bankTransactionId)))[0];
  await db
    .update(schema.bankTransactions)
    .set({
      status: "IGNORED",
      invoiceId: null,
      matchNote: `Doppelt: Zahlung zu ${number} ist schon gebucht${other ? ` (Buchung vom ${other.bookingDate.split("-").reverse().join(".")}, ${other.source})` : ""}`,
    })
    .where(and(eq(schema.bankTransactions.id, tx.id), inArray(schema.bankTransactions.status, ["UNMATCHED", "SUGGESTED"])));
  return "IGNORED";
}

async function applyDecision(tx: BankTransaction, d: Decision, log: FastifyBaseLogger): Promise<"MATCHED" | "SUGGESTED" | "UNMATCHED" | "SKIPPED"> {
  if (d.kind === "book") {
    const ok = await book(tx, d.allocations.map((a) => ({ invoiceId: a.invoice.id, amount: a.amount })), d.note, null, log, d.extras);
    return ok ? "MATCHED" : "SKIPPED";
  }
  if (d.kind === "suggest") {
    await db.update(schema.bankTransactions).set({ status: "SUGGESTED", invoiceId: d.invoiceId, matchNote: d.note }).where(eq(schema.bankTransactions.id, tx.id));
    return "SUGGESTED";
  }
  if (tx.status === "SUGGESTED") {
    await db.update(schema.bankTransactions).set({ status: "UNMATCHED", invoiceId: null, matchNote: null }).where(eq(schema.bankTransactions.id, tx.id));
  }
  return "UNMATCHED";
}

/** Offene/vorgeschlagene Buchungen (erneut) zuordnen */
export async function runMatching(ids: string[] | null, log: FastifyBaseLogger) {
  const result = { matched: 0, suggested: 0, unmatched: 0, alreadyBooked: 0 };
  if (ids && !ids.length) return result;
  const s = await getSettings();
  const pending = inArray(schema.bankTransactions.status, ["UNMATCHED", "SUGGESTED"]);
  const txs = await db
    .select()
    .from(schema.bankTransactions)
    .where(ids ? and(inArray(schema.bankTransactions.id, ids), pending) : pending)
    .orderBy(schema.bankTransactions.bookingDate);
  const stripeOn = s.payments.stripeEnabled && s.payments.ignorePayouts;
  for (const tx of txs) {
    // Stripe-Auszahlung: die Zahlungen sind schon einzeln als Online-Zahlung gebucht
    if (stripeOn && tx.amount > 0 && tx.matchNote !== REOPENED && isStripePayout(tx.counterpartyName, tx.purpose)) {
      await db
        .update(schema.bankTransactions)
        .set({ status: "IGNORED", invoiceId: null, matchNote: "Stripe-Auszahlung – die Zahlungen sind bereits einzeln als Online-Zahlung gebucht" })
        .where(eq(schema.bankTransactions.id, tx.id));
      result.alreadyBooked++;
      continue;
    }
    // offene Beträge ändern sich mit jeder Buchung → je Buchung neu laden
    const open = await loadOpenInvoices();
    const d = decide(tx, open, s.bank.autoBook);
    if (d.kind !== "book" && tx.matchNote !== REOPENED) {
      // Rechnung schon bezahlt? Dann ist das meist dieselbe Zahlung ein zweites Mal
      const ex = await resolveExisting(tx);
      if (ex === "MATCHED") {
        result.matched++;
        continue;
      }
      if (ex === "IGNORED") {
        result.alreadyBooked++;
        continue;
      }
    }
    const r = await applyDecision(tx, d, log);
    if (r === "SKIPPED") continue;
    if (r === "MATCHED") result.matched++;
    else if (r === "SUGGESTED") result.suggested++;
    else result.unmatched++;
  }
  return result;
}

/** Beim Löschen einer Einnahme: verwaiste Bankbuchung wieder öffnen */
export async function releaseBankTx(t: Tx, bankTransactionId: string | null) {
  if (!bankTransactionId) return;
  const rest = await t.select({ id: schema.incomes.id }).from(schema.incomes).where(eq(schema.incomes.bankTransactionId, bankTransactionId)).limit(1);
  if (!rest.length) {
    await t.update(schema.bankTransactions).set({ status: "UNMATCHED", invoiceId: null, matchNote: null }).where(eq(schema.bankTransactions.id, bankTransactionId));
  }
}

const importInput = z.object({
  filename: z.string().max(255).default("auszug"),
  /** Dateiinhalt base64-kodiert (Kodierung der Bankdatei bleibt erhalten) */
  data: z.string().min(1, "Datei ist leer"),
});

export async function bankRoutes(app: FastifyInstance) {
  app.post("/api/bank/import", { bodyLimit: 25 * 1024 * 1024 }, async (req) => {
    currentUser(req);
    const body = parse(importInput, req.body);
    const buf = Buffer.from(body.data, "base64");
    if (buf.length > 15 * 1024 * 1024) throw badRequest("Datei ist zu groß (max. 15 MB)");
    let parsed;
    try {
      parsed = parseStatement(body.filename, buf);
    } catch (e) {
      if (e instanceof ParseError) throw badRequest(e.message, "parse_error");
      req.log.warn(e, "Kontoauszug nicht lesbar");
      throw badRequest("Datei konnte nicht gelesen werden. Unterstützt: CAMT.053/.052/.054 (XML), MT940, CSV.", "parse_error");
    }
    if (!parsed.transactions.length) throw badRequest("In der Datei wurden keine Buchungen gefunden", "empty");
    const hashes = txHashes(parsed.transactions);
    const all = parsed.transactions.map((t, i) => ({ t, hash: hashes[i] })).filter((x) => x.t.amount !== 0);
    const inserted = all.length
      ? await db
          .insert(schema.bankTransactions)
          .values(all.map(({ t, hash }) => ({ ...t, hash, source: parsed.format })))
          .onConflictDoNothing({ target: schema.bankTransactions.hash })
          .returning({ id: schema.bankTransactions.id, amount: schema.bankTransactions.amount })
      : [];
    const newCredits = inserted.filter((x) => x.amount > 0);
    const newDebits = inserted.filter((x) => x.amount < 0);
    const r = await runMatching(
      newCredits.map((x) => x.id),
      req.log,
    );
    const expensesBooked = await autoBookDebits(
      newDebits.map((x) => x.id),
      req.log,
    );
    return {
      format: parsed.format,
      total: parsed.transactions.length,
      credits: all.filter((x) => x.t.amount > 0).length,
      debits: newDebits.length,
      debitsSkipped: 0,
      imported: newCredits.length,
      duplicates: all.length - inserted.length,
      expensesBooked,
      ...r,
    };
  });

  app.get<{ Querystring: { view?: string } }>("/api/bank/transactions", async (req) => {
    currentUser(req);
    const view = req.query.view ?? "open";
    const statuses: ("UNMATCHED" | "SUGGESTED" | "MATCHED" | "IGNORED")[] =
      view === "matched" ? ["MATCHED"] : view === "ignored" ? ["IGNORED"] : ["UNMATCHED", "SUGGESTED"];
    // Zu prüfen = offene Eingänge, Ausgaben = offene Abbuchungen
    const sign = view === "open" ? gt(schema.bankTransactions.amount, 0) : view === "debits" ? lt(schema.bankTransactions.amount, 0) : undefined;
    const rows = await db
      .select({
        t: schema.bankTransactions,
        invoiceNumber: schema.invoices.number,
        invoiceOpen: dsql<number | null>`(${schema.invoices.totalGross} - ${schema.invoices.paidTotal})::int`,
        company: schema.customers.company,
        firstName: schema.customers.firstName,
        lastName: schema.customers.lastName,
      })
      .from(schema.bankTransactions)
      .leftJoin(schema.invoices, eq(schema.invoices.id, schema.bankTransactions.invoiceId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.invoices.customerId))
      .where(and(inArray(schema.bankTransactions.status, statuses), sign))
      .orderBy(desc(schema.bankTransactions.bookingDate), desc(schema.bankTransactions.createdAt))
      .limit(1000);
    return rows.map((r) => ({
      ...r.t,
      invoiceNumber: r.invoiceNumber,
      invoiceOpen: r.invoiceOpen,
      invoiceCustomer: r.company || [r.firstName, r.lastName].filter(Boolean).join(" ") || null,
    }));
  });

  app.get("/api/bank/summary", async (req) => {
    currentUser(req);
    const rows = await db
      .select({
        status: schema.bankTransactions.status,
        debit: dsql<boolean>`${schema.bankTransactions.amount} < 0`,
        n: dsql<number>`count(*)::int`,
        sum: dsql<number>`coalesce(sum(${schema.bankTransactions.amount}), 0)::int`,
      })
      .from(schema.bankTransactions)
      .groupBy(schema.bankTransactions.status, dsql`2`);
    const get = (s: string, debit = false) => rows.find((r) => r.status === s && r.debit === debit) ?? { n: 0, sum: 0 };
    const both = (s: string) => ({ n: get(s).n + get(s, true).n, sum: get(s).sum + get(s, true).sum });
    const last = (await db.select({ d: dsql<string | null>`max(${schema.bankTransactions.bookingDate})::text` }).from(schema.bankTransactions))[0].d;
    return {
      unmatched: get("UNMATCHED"),
      suggested: get("SUGGESTED"),
      matched: both("MATCHED"),
      ignored: both("IGNORED"),
      debits: { n: get("UNMATCHED", true).n + get("SUGGESTED", true).n, sum: get("UNMATCHED", true).sum + get("SUGGESTED", true).sum },
      lastBookingDate: last,
    };
  });

  const getTx = async (id: string) => {
    const tx = (await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, id)))[0];
    if (!tx) throw notFound("Buchung");
    return tx;
  };

  /** Vorschlag bestätigen oder manuell einer Rechnung zuordnen */
  app.post<{ Params: { id: string } }>("/api/bank/transactions/:id/assign", async (req) => {
    const me = currentUser(req);
    const { invoiceId } = parse(z.object({ invoiceId: z.string().min(1, "Rechnung wählen") }), req.body);
    const tx = await getTx(req.params.id);
    if (tx.status === "MATCHED") throw badRequest("Buchung ist bereits zugeordnet");
    const note = tx.invoiceId === invoiceId && tx.matchNote ? `Bestätigt: ${tx.matchNote}` : "Manuell zugeordnet";
    if (!(await book(tx, [{ invoiceId, amount: tx.amount }], note, me.id, req.log))) throw badRequest("Buchung wurde inzwischen schon zugeordnet");
    return { ok: true };
  });

  /** Abbuchung als Ausgabe buchen (Kategorie wird für den Empfänger gemerkt) */
  app.post<{ Params: { id: string } }>("/api/bank/transactions/:id/expense", async (req) => {
    const me = currentUser(req);
    const b = parse(
      z.object({ category: z.string().min(1, "Kategorie wählen"), taxRate: z.number().min(0).max(100).default(19), supplier: optStr, description: optStr, remember: z.boolean().default(true) }),
      req.body,
    );
    const tx = await getTx(req.params.id);
    let id: string | null;
    try {
      id = await bookDebit(tx, { ...b, userId: me.id });
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : String(e));
    }
    if (!id) throw badRequest("Buchung ist bereits zugeordnet");
    if (b.remember) await learnSupplier(b.supplier ?? tx.counterpartyName ?? "", b.category);
    return { ok: true, expenseId: id };
  });

  /** Zahlung ohne Rechnung als sonstige Einnahme buchen */
  app.post<{ Params: { id: string } }>("/api/bank/transactions/:id/income", async (req) => {
    const me = currentUser(req);
    const body = parse(z.object({ category: z.string().trim().min(1).default("Sonstiges"), description: optStr, customerId: optStr }), req.body);
    const tx = await getTx(req.params.id);
    if (tx.status === "MATCHED") throw badRequest("Buchung ist bereits zugeordnet");
    await db.transaction(async (t) => {
      await t.insert(schema.incomes).values({
        date: tx.bookingDate,
        amount: tx.amount,
        method: "Überweisung",
        category: body.category,
        description: body.description ?? ([tx.counterpartyName, tx.purpose].filter(Boolean).join(" – ").slice(0, 200) || "Zahlungseingang"),
        customerId: body.customerId,
        bankTransactionId: tx.id,
        createdById: me.id,
      });
      await t
        .update(schema.bankTransactions)
        .set({ status: "MATCHED", invoiceId: null, matchNote: `Als Einnahme gebucht (${body.category})` })
        .where(eq(schema.bankTransactions.id, tx.id));
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/bank/transactions/:id/ignore", async (req) => {
    currentUser(req);
    const tx = await getTx(req.params.id);
    if (tx.status === "MATCHED") throw badRequest("Zuordnung zuerst aufheben");
    await db.update(schema.bankTransactions).set({ status: "IGNORED", invoiceId: null, matchNote: null }).where(eq(schema.bankTransactions.id, tx.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/bank/transactions/:id/reopen", async (req) => {
    currentUser(req);
    const tx = await getTx(req.params.id);
    if (tx.status !== "IGNORED") throw badRequest("Nur ignorierte Buchungen können wieder geöffnet werden");
    // Merker, damit die Doppelt-Erkennung die Buchung nicht sofort wieder aussortiert
    await db.update(schema.bankTransactions).set({ status: "UNMATCHED", matchNote: REOPENED }).where(eq(schema.bankTransactions.id, tx.id));
    await runMatching([tx.id], req.log);
    return { ok: true };
  });

  /** Zuordnung aufheben: zugehörige Einnahmen löschen, Rechnungen wieder öffnen */
  app.post<{ Params: { id: string } }>("/api/bank/transactions/:id/unassign", async (req) => {
    currentUser(req);
    const tx = await getTx(req.params.id);
    if (tx.status !== "MATCHED") throw badRequest("Buchung ist nicht zugeordnet");
    await db.transaction(async (t) => {
      const linked = await t.select().from(schema.incomes).where(eq(schema.incomes.bankTransactionId, tx.id));
      await t.delete(schema.incomes).where(eq(schema.incomes.bankTransactionId, tx.id));
      await t.delete(schema.expenses).where(eq(schema.expenses.bankTransactionId, tx.id));
      for (const inc of linked) if (inc.invoiceId) await recalcPaid(t, inc.invoiceId);
      await t.update(schema.bankTransactions).set({ status: "UNMATCHED", invoiceId: null, matchNote: null }).where(eq(schema.bankTransactions.id, tx.id));
    });
    return { ok: true };
  });

  /** Alle offenen Buchungen neu zuordnen (z. B. nachdem neue Rechnungen ausgestellt wurden) */
  app.post("/api/bank/rematch", async (req) => {
    currentUser(req);
    return runMatching(null, req.log);
  });
}
