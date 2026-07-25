/**
 * Datensicherung als JSON: Export und Import.
 *
 * Import-Modi:
 *  - merge:   fehlende Datensätze ergänzen, vorhandene (gleiche ID oder Nummer) bleiben unverändert
 *  - replace: alle Geschäftsdaten löschen und den Stand der Sicherung herstellen
 * Benutzerkonten werden nie importiert; Verweise auf unbekannte Benutzer werden geleert.
 * Passwörter (SMTP, Ticket-Postfach) sind im Export nicht enthalten und bleiben beim Import unverändert.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql as dsql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db, schema, type Tx } from "../db/index.js";
import { badRequest, requireAdmin, today } from "../lib/http.js";
import { getPublicSettings, putSection, sections, type SectionKey } from "../lib/settings.js";

const FORMAT = "kontor-export";
const VERSION = 3;

/** Tabellen in Einfüge-Reihenfolge (Fremdschlüssel beachten) */
const TABLES = [
  ["customers", schema.customers],
  ["products", schema.products],
  ["discounts", schema.discounts],
  ["recurringInvoices", schema.recurringInvoices],
  ["invoices", schema.invoices],
  ["invoiceItems", schema.invoiceItems],
  ["quotes", schema.quotes],
  ["quoteItems", schema.quoteItems],
  ["dunnings", schema.dunnings],
  ["bankTransactions", schema.bankTransactions],
  ["incomes", schema.incomes],
  ["onlinePayments", schema.onlinePayments],
  ["expenses", schema.expenses],
  ["tickets", schema.tickets],
  ["ticketMessages", schema.ticketMessages],
  ["ticketAttachments", schema.ticketAttachments],
  ["projects", schema.projects],
  ["timeEntries", schema.timeEntries],
  ["charges", schema.charges],
  ["contracts", schema.contracts],
] as const;

/** Binärspalten werden im Export als base64 abgelegt */
const BINARY = new Set(["receipt", "document", "data"]);

type TableKey = (typeof TABLES)[number][0];

/** Spalten, die als Zeitstempel (Date) eingefügt werden müssen */
const TIMESTAMPS = new Set([
  "createdAt",
  "updatedAt",
  "sentAt",
  "lastReminderAt",
  "notifiedAt",
  "lastMessageAt",
  "receivedAt",
  "expiresAt",
  "usedAt",
  "lastUsedAt",
  "confirmationSentAt",
]);
/** Verweise auf Benutzerkonten – auf dem Zielserver evtl. nicht vorhanden */
const USER_REFS = ["createdById", "assigneeId", "authorId", "userId"];
/** Importierte Einstellungsbereiche (ohne Geheimnisse) */
const SECTIONS = Object.keys(sections) as SectionKey[];
const SECRET_FIELDS = [
  "password",
  "imapPassword",
  "smtpPassword",
  "ebPrivateKey",
  "stripeSecretKey",
  "stripeWebhookSecret",
  "hasPassword",
  "hasImapPassword",
  "hasSmtpPassword",
  "hasEbPrivateKey",
  "hasStripeSecretKey",
  "hasStripeWebhookSecret",
];

function prepare(row: Record<string, unknown>, users: Set<string>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (BINARY.has(k) && typeof v === "string") out[k] = Buffer.from(v, "base64");
    else if ((TIMESTAMPS.has(k) || k.endsWith("At")) && typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) out[k] = new Date(v);
    else if (USER_REFS.includes(k)) out[k] = typeof v === "string" && users.has(v) ? v : null;
    else out[k] = v;
  }
  return out;
}

async function insertChunks(tx: Tx, table: PgTable, rows: Record<string, unknown>[]) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    // onConflictDoNothing ohne Ziel greift bei jedem Unique-Konflikt (ID, Nummer, Hash …)
    const r = await tx
      .insert(table)
      .values(chunk as never)
      .onConflictDoNothing()
      .returning();
    inserted += r.length;
  }
  return inserted;
}

const rowArray = z.array(z.record(z.unknown())).default([]);
const importSchema = z.object({
  mode: z.enum(["merge", "replace"]),
  importSettings: z.boolean().default(true),
  data: z
    .object({
      format: z.string().optional(),
      version: z.number().optional(),
      exportedAt: z.string().optional(),
      settings: z.record(z.unknown()).optional(),
      numberSequences: z.array(z.object({ key: z.string(), year: z.number(), value: z.number() })).default([]),
      customers: rowArray,
      products: rowArray,
      discounts: rowArray,
      invoices: rowArray,
      invoiceItems: rowArray,
      bankTransactions: rowArray,
      incomes: rowArray,
      tickets: rowArray,
      ticketMessages: rowArray,
    })
    .passthrough(),
});

export async function backupRoutes(app: FastifyInstance) {
  app.get("/api/export", async (req, reply) => {
    requireAdmin(req);
    const data: Record<string, unknown> = {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      settings: await getPublicSettings(),
      numberSequences: await db.select().from(schema.numberSequences),
    };
    for (const [key, table] of TABLES) {
      const rows = (await db.select().from(table as PgTable)) as Record<string, unknown>[];
      data[key] = rows.map((r) => {
        const o: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) o[k] = BINARY.has(k) && Buffer.isBuffer(v) ? v.toString("base64") : v;
        return o;
      });
    }
    return reply.header("Content-Disposition", `attachment; filename="kontor-export-${today()}.json"`).send(data);
  });

  app.post("/api/import", { bodyLimit: 200 * 1024 * 1024 }, async (req) => {
    requireAdmin(req);
    const { mode, importSettings, data } = importSchema.parse(req.body ?? {});
    if (data.format && data.format !== FORMAT) throw badRequest("Das ist keine Kontor-Sicherung");
    if (!data.customers.length && !data.invoices.length && !data.products.length && !data.settings) {
      throw badRequest("Die Datei enthält keine Daten");
    }
    const users = new Set((await db.select({ id: schema.users.id }).from(schema.users)).map((u) => u.id));

    const counts: Record<string, { total: number; imported: number }> = {};
    await db.transaction(async (tx) => {
      if (mode === "replace") {
        // Reihenfolge rückwärts wegen Fremdschlüsseln; Tickets löschen ihre Nachrichten/Anhänge mit
        await tx.execute(
          dsql`TRUNCATE contracts, charges, time_entries, projects, online_payments, expenses, dunnings, ticket_attachments, ticket_messages, tickets, inbox_filtered, mail_logs, incomes, bank_transactions, invoice_items, invoices, quote_items, quotes, recurring_invoices, discounts, products, customers, number_sequences CASCADE`,
        );
      }
      for (const [key, table] of TABLES) {
        const rows = ((data[key as TableKey] as Record<string, unknown>[] | undefined) ?? []).map((r) => prepare(r, users));
        // Storno-Verweise zeigen auf andere Rechnungen: erst ohne, dann nachtragen
        if (key === "invoices") {
          const stripped = rows.map((r) => ({ ...r, cancelsId: null }));
          counts[key] = { total: rows.length, imported: await insertChunks(tx, table as PgTable, stripped) };
          for (const r of rows.filter((r) => r.cancelsId)) {
            await tx.execute(dsql`UPDATE invoices SET cancels_id = ${r.cancelsId as string} WHERE id = ${r.id as string} AND cancels_id IS NULL`);
          }
          continue;
        }
        counts[key] = { total: rows.length, imported: await insertChunks(tx, table as PgTable, rows) };
      }
      // Nummernkreise: nie zurückzählen, damit keine Rechnungsnummer doppelt vergeben wird
      for (const s of data.numberSequences) {
        await tx.execute(
          dsql`INSERT INTO number_sequences (key, year, value) VALUES (${s.key}, ${s.year}, ${s.value})
               ON CONFLICT (key, year) DO UPDATE SET value = GREATEST(number_sequences.value, EXCLUDED.value)`,
        );
      }
    });

    let settingsImported = false;
    if (importSettings && data.settings) {
      for (const section of SECTIONS) {
        const v = data.settings[section];
        if (!v || typeof v !== "object") continue;
        const clean = { ...(v as Record<string, unknown>) };
        for (const f of SECRET_FIELDS) delete clean[f];
        // Ticket-Abruf nicht automatisch scharf schalten (Zugangsdaten fehlen im Export)
        if (section === "tickets") clean.enabled = false;
        try {
          await putSection(section, clean);
          settingsImported = true;
        } catch (e) {
          req.log.warn({ section, err: e instanceof Error ? e.message : e }, "Einstellungsbereich nicht übernommen");
        }
      }
    }
    return { mode, counts, settingsImported, exportedAt: data.exportedAt ?? null };
  });
}
