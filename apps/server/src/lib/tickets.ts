/**
 * Ticket-Postfach: ruft ein eigenes Mailkonto per IMAP ab und macht aus passenden Mails Tickets.
 * - Antworten auf bestehende Tickets (Betreff mit [T-2026-0001] oder In-Reply-To/References) werden angehängt.
 * - Neue Mails laufen durch den Filter (ticket-filter.ts); Werbung & Co. landen unter "Aussortiert".
 * - Das Postfach wird nicht verändert (keine Gelesen-Markierung, kein Verschieben). Fortschritt über die IMAP-UID.
 */
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { and, eq, inArray, lt, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { getSettings, getState, nextNumber, setState, type Settings } from "./settings.js";
import { classify, isAutoReply, stripQuoted } from "./ticket-filter.js";
import { mailReady, render, sendMail } from "./mail.js";

type TicketSettings = Settings["tickets"];
export interface OutAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

const MAX_ATTACHMENT = 10 * 1024 * 1024;
const MAX_RAW = 15 * 1024 * 1024;

export function ticketsReady(t: TicketSettings): boolean {
  return t.enabled && !!t.imapHost && !!t.imapUser && !!t.imapPassword;
}

const insecureTls = () => process.env.KONTOR_INSECURE_TLS === "1";

function imapClient(t: TicketSettings) {
  const client = new ImapFlow({
    host: t.imapHost,
    port: t.imapPort,
    secure: t.imapSecure,
    auth: { user: t.imapUser, pass: t.imapPassword },
    logger: false,
    socketTimeout: 60_000,
    tls: { rejectUnauthorized: !insecureTls() },
  });
  // Ohne Listener würde ein Verbindungsabbruch den ganzen Server beenden
  client.on("error", () => {});
  return client;
}

function smtpTransport(t: TicketSettings) {
  return nodemailer.createTransport({
    host: t.smtpHost || t.imapHost,
    port: t.smtpPort,
    secure: t.smtpSecure,
    auth: { user: t.smtpUser || t.imapUser, pass: t.smtpPassword || t.imapPassword },
    connectionTimeout: 15_000,
    tls: { rejectUnauthorized: !insecureTls() },
  });
}

const errText = (e: unknown) => (e instanceof Error ? (e as Error & { responseText?: string }).responseText || e.message : String(e));

export async function verifyTicketMailbox(): Promise<{ imap: string; smtp: string; messages?: number }> {
  const t = (await getSettings()).tickets;
  if (!t.imapHost || !t.imapUser) throw new Error("IMAP-Server und Benutzer eintragen");
  let imap = "ok";
  let messages: number | undefined;
  const client = imapClient(t);
  try {
    await client.connect();
    const st = await client.status(t.folder || "INBOX", { messages: true });
    messages = st.messages;
    await client.logout();
  } catch (e) {
    imap = errText(e);
  }
  let smtp = "ok";
  try {
    await smtpTransport(t).verify();
  } catch (e) {
    smtp = errText(e);
  }
  return { imap, smtp, messages };
}

// ---------- Verarbeitung einer Mail ----------

function facts(p: ParsedMail) {
  const from = p.from?.value?.[0];
  return {
    fromEmail: (from?.address ?? "").toLowerCase(),
    fromName: from?.name || null,
    subject: (p.subject ?? "").trim(),
    text: (p.text ?? "").trim(),
    html: typeof p.html === "string" ? p.html : null,
    headers: p.headers as Map<string, unknown>,
    attachmentCount: p.attachments.filter((a) => !(a.contentDisposition === "inline" && a.cid)).length,
  };
}

function refsOf(p: ParsedMail): string[] {
  const r = p.references ? (Array.isArray(p.references) ? p.references : [p.references]) : [];
  return [...(p.inReplyTo ? [p.inReplyTo] : []), ...r].filter(Boolean);
}

async function findCustomerByEmail(email: string) {
  const rows = await db
    .select()
    .from(schema.customers)
    .where(dsql`lower(${schema.customers.email}) = ${email.toLowerCase()}`)
    .limit(1);
  return rows[0] ?? null;
}

/** Freemail-Domains zählen nie als Firmen-Domain */
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "gmx.de", "gmx.net", "gmx.at", "gmx.ch", "web.de", "t-online.de", "outlook.com", "outlook.de", "hotmail.com", "hotmail.de",
  "live.com", "live.de", "yahoo.com", "yahoo.de", "icloud.com", "me.com", "aol.com", "freenet.de", "posteo.de", "mailbox.org", "proton.me", "protonmail.com", "online.de", "arcor.de",
]);

/** Kunde über Absenderadresse, optional auch über die Firmen-Domain (Kollegen des Kunden) */
export async function findCustomerFor(email: string, t: TicketSettings) {
  const exact = await findCustomerByEmail(email);
  if (exact || !t.allowCustomerDomain) return exact;
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain || FREEMAIL.has(domain)) return null;
  const rows = await db
    .select()
    .from(schema.customers)
    .where(and(dsql`lower(split_part(${schema.customers.email}, '@', 2)) = ${domain}`, eq(schema.customers.archived, false)))
    .limit(2);
  // nur eindeutige Zuordnung
  return rows.length === 1 ? rows[0] : null;
}

async function findTicketFor(p: ParsedMail, numberFormat: string) {
  // 1) Ticketnummer im Betreff, z. B. "Re: [T-2026-0001] …"
  const prefix = (numberFormat.split("{")[0] || "T-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\[#?(${prefix}[0-9A-Z-]+)\\]`, "i").exec(p.subject ?? "");
  if (m) {
    const t = (await db.select().from(schema.tickets).where(dsql`upper(${schema.tickets.number}) = ${m[1].toUpperCase()}`))[0];
    if (t) return t;
  }
  // 2) Verkettung über In-Reply-To / References
  const refs = refsOf(p);
  if (refs.length) {
    const msg = (
      await db.select({ ticketId: schema.ticketMessages.ticketId }).from(schema.ticketMessages).where(inArray(schema.ticketMessages.messageId, refs)).limit(1)
    )[0];
    if (msg) return (await db.select().from(schema.tickets).where(eq(schema.tickets.id, msg.ticketId)))[0] ?? null;
  }
  return null;
}

async function storeAttachments(messageRowId: string, p: ParsedMail, t?: TicketSettings) {
  // eingebettete Bilder (Signatur-Logos) weglassen
  const all = p.attachments.filter((a) => !(a.contentDisposition === "inline" && a.cid));
  await storeFiles(
    messageRowId,
    all.map((a) => ({ filename: a.filename || "anhang", contentType: a.contentType || "application/octet-stream", data: a.content })),
    t,
  );
}

async function storeFiles(messageRowId: string, all: { filename: string; contentType: string; data: Buffer }[], t?: TicketSettings) {
  const limit = t ? Math.min(MAX_ATTACHMENT * 5, t.maxAttachmentMb * 1024 * 1024) : MAX_ATTACHMENT;
  const allowed = !t || t.allowAttachments;
  const atts = allowed ? all.filter((a) => a.data.length <= limit) : [];
  const skipped = all.filter((a) => !atts.includes(a));
  if (skipped.length) {
    const note = `\n\n[Nicht übernommene Anhänge${allowed ? ` (größer als ${t?.maxAttachmentMb} MB)` : " (Anhänge sind ausgeschaltet)"}: ${skipped.map((a) => a.filename).join(", ")}]`;
    await db.update(schema.ticketMessages).set({ body: dsql`${schema.ticketMessages.body} || ${note}` }).where(eq(schema.ticketMessages.id, messageRowId));
  }
  if (!atts.length) return;
  await db.insert(schema.ticketAttachments).values(
    atts.map((a) => ({ messageId: messageRowId, filename: a.filename, contentType: a.contentType, size: a.data.length, data: a.data })),
  );
}

export type ProcessResult = "created" | "appended" | "filtered" | "duplicate";

/** Kategorie aus dem Betreff: "[Fehler] …" oder "Fehler: …" (Groß/klein egal) */
export function categoryFromSubject(subject: string, categories: string[]): string | null {
  const m = /^\s*(?:\[([^\]]{1,40})\]|([^:]{1,40}):)/.exec(subject);
  const tag = (m?.[1] ?? m?.[2] ?? "").trim().toLowerCase();
  if (!tag) return null;
  return categories.find((c) => c.toLowerCase() === tag) ?? null;
}

export interface NewTicket {
  fromEmail: string;
  fromName: string | null;
  subject: string;
  text: string;
  received?: Date;
  messageId: string;
  inReplyTo?: string | null;
  /** schon bekannter Kunde (Portal); sonst Zuordnung über die Adresse */
  customerId?: string | null;
  category?: string | null;
  priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  /** Herkunft, steht als Hinweis unter der Nachricht */
  via?: string;
  files?: { filename: string; contentType: string; data: Buffer }[];
}

/** Ticket anlegen (Mail, Portal, Webformular) – ohne Filter */
export async function createTicket(n: NewTicket, t: TicketSettings, log: FastifyBaseLogger, sendAutoReply = true, related?: string) {
  const customerId = n.customerId !== undefined ? n.customerId : ((await findCustomerFor(n.fromEmail, t))?.id ?? null);
  const assignee = await validAssignee(t.autoAssignUserId);
  const received = n.received ?? new Date();
  const notes = [related ? `[Antwort auf das geschlossene Ticket ${related}]` : "", n.via ? `[Eingegangen über ${n.via}]` : ""].filter(Boolean).join("\n");
  const ticket = await db.transaction(async (tx) => {
    const number = await nextNumber(tx, "ticket", t.numberFormat);
    const [row] = await tx
      .insert(schema.tickets)
      .values({
        number,
        subject: n.subject || "(ohne Betreff)",
        customerId,
        contactEmail: n.fromEmail,
        contactName: n.fromName,
        lastMessageAt: received,
        priority: n.priority ?? (/\b(dringend|urgent|notfall)\b/i.test(n.subject) && t.defaultPriority !== "URGENT" ? "HIGH" : t.defaultPriority),
        category: n.category ?? categoryFromSubject(n.subject, t.categories),
        assigneeId: assignee,
      })
      .returning();
    const [msg] = await tx
      .insert(schema.ticketMessages)
      .values({
        ticketId: row.id,
        direction: "IN",
        fromEmail: n.fromEmail,
        fromName: n.fromName,
        toEmail: t.address || null,
        subject: n.subject,
        body: notes ? `${n.text}\n\n${notes}` : n.text,
        messageId: n.messageId,
        inReplyTo: n.inReplyTo ?? null,
        createdAt: received,
      })
      .returning();
    return { ...row, firstMessageId: msg.id };
  });
  if (n.files?.length) await storeFiles(ticket.firstMessageId, n.files, t);
  void notifyTeam(ticket.id, n.text, log);
  if (sendAutoReply && t.autoReply && !/^(no-?reply|do-?not-?reply)/i.test(n.fromEmail)) {
    try {
      await sendAutoReplyMail(ticket.id);
    } catch (e) {
      log.warn({ err: errText(e), ticket: ticket.number }, "Eingangsbestätigung fehlgeschlagen");
    }
  }
  return ticket;
}

/** Ticket aus einer geparsten Mail anlegen (ohne Filter) */
export async function createTicketFromMail(p: ParsedMail, messageId: string, t: TicketSettings, log: FastifyBaseLogger, sendAutoReply = true, related?: string) {
  const f = facts(p);
  const atts = p.attachments.filter((a) => !(a.contentDisposition === "inline" && a.cid));
  return createTicket(
    {
      fromEmail: f.fromEmail,
      fromName: f.fromName,
      subject: f.subject,
      text: f.text,
      received: p.date ?? new Date(),
      messageId,
      inReplyTo: p.inReplyTo ?? null,
      files: atts.map((a) => ({ filename: a.filename || "anhang", contentType: a.contentType || "application/octet-stream", data: a.content })),
    },
    t,
    log,
    sendAutoReply,
    related,
  );
}

/** Nachricht des Kunden an ein bestehendes Ticket hängen (Portal) */
export async function appendCustomerMessage(ticketId: string, n: Omit<NewTicket, "subject" | "customerId" | "category" | "priority"> & { subject?: string }, t: TicketSettings) {
  const [msg] = await db
    .insert(schema.ticketMessages)
    .values({
      ticketId,
      direction: "IN",
      fromEmail: n.fromEmail,
      fromName: n.fromName,
      toEmail: t.address || null,
      subject: n.subject ?? null,
      body: n.via ? `${n.text}\n\n[Eingegangen über ${n.via}]` : n.text,
      messageId: n.messageId,
      createdAt: n.received ?? new Date(),
    })
    .returning();
  await db
    .update(schema.tickets)
    .set({ status: "OPEN", unread: true, lastMessageAt: n.received ?? new Date(), updatedAt: new Date() })
    .where(eq(schema.tickets.id, ticketId));
  if (n.files?.length) await storeFiles(msg.id, n.files, t);
  return msg;
}

export async function processRawMail(raw: Buffer, log: FastifyBaseLogger): Promise<ProcessResult> {
  const t = (await getSettings()).tickets;
  const p = await simpleParser(raw);
  const messageId = (p.messageId || `<${createHash("sha256").update(raw).digest("hex")}@kontor.local>`).trim();

  const known =
    (await db.select({ id: schema.ticketMessages.id }).from(schema.ticketMessages).where(eq(schema.ticketMessages.messageId, messageId)).limit(1))[0] ??
    (await db.select({ id: schema.inboxFiltered.id }).from(schema.inboxFiltered).where(eq(schema.inboxFiltered.messageId, messageId)).limit(1))[0];
  if (known) return "duplicate";

  const f = facts(p);
  const saveFiltered = async (reason: string, score: number) => {
    await db
      .insert(schema.inboxFiltered)
      .values({
        messageId,
        fromEmail: f.fromEmail || "unbekannt",
        fromName: f.fromName,
        subject: f.subject || null,
        snippet: f.text.replace(/\s+/g, " ").slice(0, 400) || null,
        reason,
        score,
        raw: raw.length <= MAX_RAW ? raw : null,
        receivedAt: p.date ?? new Date(),
      })
      .onConflictDoNothing();
    return "filtered" as const;
  };

  if (!f.fromEmail) return saveFiltered("Kein Absender", 99);

  // Antwort auf ein bestehendes Ticket?
  const existing = await findTicketFor(p, t.numberFormat);
  const closedTooLong =
    existing?.status === "CLOSED" &&
    (!t.reopenOnReply || (t.reopenMaxDays > 0 && Date.now() - existing.updatedAt.getTime() > t.reopenMaxDays * 86_400_000));
  if (existing && closedTooLong) {
    if (isAutoReply(f)) return saveFiltered(`Automatische Antwort zu ${existing.number}`, 99);
    await createTicketFromMail(p, messageId, t, log, true, existing.number);
    return "created";
  }
  if (existing) {
    if (isAutoReply(f)) return saveFiltered(`Automatische Antwort zu ${existing.number}`, 99);
    const [msg] = await db
      .insert(schema.ticketMessages)
      .values({
        ticketId: existing.id,
        direction: "IN",
        fromEmail: f.fromEmail,
        fromName: f.fromName,
        toEmail: t.address || null,
        subject: f.subject,
        body: stripQuoted(f.text),
        messageId,
        inReplyTo: p.inReplyTo ?? null,
        createdAt: p.date ?? new Date(),
      })
      .returning();
    await storeAttachments(msg.id, p, t);
    await db.update(schema.tickets).set({ status: "OPEN", unread: true, lastMessageAt: p.date ?? new Date() }).where(eq(schema.tickets.id, existing.id));
    return "appended";
  }

  const customer = await findCustomerFor(f.fromEmail, t);
  const verdict = classify(f, {
    ownAddress: t.address || t.imapUser,
    knownCustomer: !!customer,
    level: t.filterLevel,
    onlyKnownCustomers: t.onlyKnownCustomers,
    allowSenders: t.allowSenders,
    blockSenders: t.blockSenders,
  });
  if (!verdict.accept) {
    // Nicht-Kunde: auf Wunsch höflich absagen statt still aussortieren
    if (t.onlyKnownCustomers && !customer && t.nonCustomerAction === "reject" && /kein bekannter Kunde/.test(verdict.verdict) && !/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster)/i.test(f.fromEmail)) {
      const sent = await sendRejection(f.fromEmail, f.subject, p.messageId ?? null, t).catch((e) => {
        log.warn({ err: errText(e) }, "Absage an Nicht-Kunden fehlgeschlagen");
        return false;
      });
      return saveFiltered(sent ? "Kein Kunde – Absage gesendet" : verdict.verdict, verdict.score);
    }
    return saveFiltered(verdict.verdict, verdict.score);
  }

  await createTicketFromMail(p, messageId, t, log);
  return "created";
}

async function validAssignee(userId: string): Promise<string | null> {
  if (!userId) return null;
  const u = (await db.select({ id: schema.users.id, active: schema.users.active }).from(schema.users).where(eq(schema.users.id, userId)))[0];
  return u?.active ? u.id : null;
}

/** Kurze Info an das Team (Firmen-Mailserver), wenn ein neues Ticket eingeht */
async function notifyTeam(ticketId: string, text: string, log: FastifyBaseLogger) {
  try {
    const s = await getSettings();
    const t = s.tickets;
    const to = t.notifyAddress || s.company.email;
    if (!t.notifyTeam || !to || !mailReady(s)) return;
    const ticket = (await db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)))[0];
    if (!ticket) return;
    await sendMail({
      kind: "ticket",
      to,
      subject: `Neues Ticket ${ticket.number}: ${ticket.subject}`,
      text: [`Von: ${ticket.contactName ? `${ticket.contactName} <${ticket.contactEmail}>` : ticket.contactEmail}`, `Priorität: ${PRIORITY_DE[ticket.priority]}`, "", text.slice(0, 1500)].join("\n"),
      customerId: ticket.customerId,
    });
  } catch (e) {
    log.warn({ err: errText(e) }, "Team-Benachrichtigung fehlgeschlagen");
  }
}

export const PRIORITY_DE: Record<"LOW" | "NORMAL" | "HIGH" | "URGENT", string> = { LOW: "niedrig", NORMAL: "normal", HIGH: "hoch", URGENT: "dringend" };

async function sendRejection(to: string, subject: string, inReplyTo: string | null, t: TicketSettings) {
  const s = await getSettings();
  const vars = { subject: subject || "Ihre Nachricht", companyName: s.company.name, companyEmail: s.company.email || t.address };
  const from = t.address || t.smtpUser || t.imapUser;
  await smtpTransport(t).sendMail({
    from: { name: t.fromName || s.company.name || from, address: from },
    to,
    subject: render(t.rejectSubject, vars),
    text: render(t.rejectBody, vars),
    inReplyTo: inReplyTo ?? undefined,
    headers: { "Auto-Submitted": "auto-replied" },
  });
  return true;
}

/** Tickets "Wartet auf Kunde" nach X Tagen ohne Antwort schließen */
export async function autoCloseTickets(log: FastifyBaseLogger) {
  const t = (await getSettings()).tickets;
  if (!t.autoCloseDays) return 0;
  const before = new Date(Date.now() - t.autoCloseDays * 86_400_000);
  const stale = await db.select().from(schema.tickets).where(and(eq(schema.tickets.status, "PENDING"), lt(schema.tickets.lastMessageAt, before)));
  for (const tk of stale) {
    await db.update(schema.tickets).set({ status: "CLOSED" }).where(eq(schema.tickets.id, tk.id));
    await db.insert(schema.ticketMessages).values({ ticketId: tk.id, direction: "NOTE", body: `Automatisch geschlossen nach ${t.autoCloseDays} Tagen ohne Antwort.` });
    if (t.autoCloseNotify && ticketsReady(t)) {
      try {
        const { ticket, vars } = await ticketVars(tk.id);
        await sendTicketMail(tk.id, { subject: replySubject(ticket.number, ticket.subject), body: tidy(render(t.autoCloseBody, vars)), authorId: null });
        // der eigene Versand setzt lastMessageAt nicht zurück; Status bleibt geschlossen
      } catch (e) {
        log.warn({ err: errText(e), ticket: tk.number }, "Abschlussmail fehlgeschlagen");
      }
    }
  }
  if (stale.length) log.info({ closed: stale.length }, "Tickets automatisch geschlossen");
  return stale.length;
}

// ---------- Abruf ----------

let polling = false;

export interface PollResult {
  fetched: number;
  created: number;
  appended: number;
  filtered: number;
  duplicates: number;
  error: string | null;
}

export async function pollTicketMailbox(log: FastifyBaseLogger, force = false): Promise<PollResult> {
  const result: PollResult = { fetched: 0, created: 0, appended: 0, filtered: 0, duplicates: 0, error: null };
  const t = (await getSettings()).tickets;
  if (!ticketsReady(t)) {
    if (force) result.error = "Ticket-Postfach ist nicht eingerichtet oder ausgeschaltet";
    return result;
  }
  if (polling) {
    result.error = "Abruf läuft bereits";
    return result;
  }
  polling = true;
  const client = imapClient(t);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(t.folder || "INBOX");
    try {
      const mb = client.mailbox;
      const validity = mb ? String(mb.uidValidity) : "0";
      const state = await getState<{ uidValidity: string; lastUid: number }>("tickets", { uidValidity: "", lastUid: 0 });
      const lastUid = state.uidValidity === validity ? state.lastUid : 0;
      const since = t.since ? new Date(t.since) : new Date(Date.now() - 86_400_000);
      // SINCE ist tagesgenau → unten zusätzlich mit dem Eingangszeitpunkt vergleichen
      const found = (await client.search({ since, uid: `${lastUid + 1}:*` }, { uid: true })) || [];
      const uids = found.filter((u) => u > lastUid).sort((a, b) => a - b).slice(0, 200);
      let maxUid = lastUid;
      for (const uid of uids) {
        maxUid = Math.max(maxUid, uid);
        const msg = await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
        if (!msg || !msg.source) continue;
        if (msg.internalDate && new Date(msg.internalDate) < since) continue;
        result.fetched++;
        try {
          const r = await processRawMail(msg.source, log);
          if (r === "created") result.created++;
          else if (r === "appended") result.appended++;
          else if (r === "filtered") result.filtered++;
          else result.duplicates++;
        } catch (e) {
          log.error(e, `Ticket-Mail UID ${uid} konnte nicht verarbeitet werden`);
        }
      }
      if (maxUid !== lastUid || state.uidValidity !== validity) await setState("tickets", { uidValidity: validity, lastUid: maxUid });
    } finally {
      lock.release();
    }
    await client.logout();
    await setState("tickets_last_poll", { at: new Date().toISOString(), error: null });
  } catch (e) {
    result.error = errText(e);
    await setState("tickets_last_poll", { at: new Date().toISOString(), error: result.error });
    log.warn({ err: result.error }, "Ticket-Postfach: Abruf fehlgeschlagen");
    try {
      await client.logout();
    } catch {
      /* Verbindung bereits getrennt */
    }
  } finally {
    polling = false;
  }
  if (result.created || result.appended) log.info(result, "Ticket-Postfach abgerufen");
  return result;
}

export function startTicketPoller(log: FastifyBaseLogger) {
  let last = 0;
  let lastMaintenance = 0;
  const tick = async () => {
    try {
      const t = (await getSettings()).tickets;
      if (Date.now() - lastMaintenance > 30 * 60_000) {
        lastMaintenance = Date.now();
        await autoCloseTickets(log).catch((e) => log.warn({ err: errText(e) }, "Automatisches Schließen fehlgeschlagen"));
      }
      if (!ticketsReady(t)) return;
      if (Date.now() - last < t.pollMinutes * 60_000 - 5_000) return;
      last = Date.now();
      await pollTicketMailbox(log);
    } catch (e) {
      log.error(e, "Ticket-Abruf fehlgeschlagen");
    }
  };
  setTimeout(tick, 15_000);
  return setInterval(tick, 30_000);
}

// ---------- Ausgehende Mails ----------

function replySubject(number: string, subject: string) {
  const clean = subject
    .replace(/^((re|aw|antw|wg|fwd?):\s*)+/i, "")
    .replace(/\s*\[#?[A-Z]+-[0-9A-Z-]+\]\s*/i, " ")
    .trim();
  return `Re: [${number}] ${clean}`;
}

async function threadHeaders(ticketId: string) {
  const msgs = await db
    .select({ messageId: schema.ticketMessages.messageId })
    .from(schema.ticketMessages)
    .where(and(eq(schema.ticketMessages.ticketId, ticketId), inArray(schema.ticketMessages.direction, ["IN", "OUT"])))
    .orderBy(schema.ticketMessages.createdAt);
  const ids = msgs.map((m) => m.messageId).filter((x): x is string => !!x && !x.endsWith("@kontor.local>"));
  return { inReplyTo: ids[ids.length - 1], references: ids.slice(-10) };
}

async function sendTicketMail(ticketId: string, opts: { subject: string; body: string; authorId: string | null; attachments?: OutAttachment[] }) {
  const s = await getSettings();
  const t = s.tickets;
  if (!t.imapHost && !t.smtpHost) throw new Error("Ticket-Postfach ist nicht eingerichtet");
  const ticket = (await db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)))[0];
  if (!ticket) throw new Error("Ticket nicht gefunden");
  const from = t.address || t.smtpUser || t.imapUser;
  const messageId = `<${randomUUID()}@${from.split("@")[1] || "kontor.local"}>`;
  const { inReplyTo, references } = await threadHeaders(ticketId);
  await smtpTransport(t).sendMail({
    from: { name: t.fromName || s.company.name || from, address: from },
    to: ticket.contactName ? { name: ticket.contactName, address: ticket.contactEmail } : ticket.contactEmail,
    subject: opts.subject,
    text: opts.body,
    messageId,
    inReplyTo,
    references,
    attachments: opts.attachments,
    headers: { "X-Kontor-Ticket": ticket.number, "Auto-Submitted": opts.authorId ? "no" : "auto-replied" },
  });
  const [row] = await db
    .insert(schema.ticketMessages)
    .values({
      ticketId,
      direction: "OUT",
      fromEmail: from,
      fromName: t.fromName || null,
      toEmail: ticket.contactEmail,
      subject: opts.subject,
      body: opts.body,
      messageId,
      inReplyTo: inReplyTo ?? null,
      authorId: opts.authorId,
    })
    .returning();
  if (opts.attachments?.length) {
    await db.insert(schema.ticketAttachments).values(
      opts.attachments.map((a) => ({
        messageId: row.id,
        filename: a.filename,
        contentType: a.contentType ?? "application/octet-stream",
        size: a.content.length,
        data: a.content,
      })),
    );
  }
  return row;
}

async function ticketVars(ticketId: string) {
  const s = await getSettings();
  const ticket = (await db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)))[0];
  const customer = ticket.customerId ? (await db.select().from(schema.customers).where(eq(schema.customers.id, ticket.customerId)))[0] : null;
  const person = customer ? [customer.firstName, customer.lastName].filter(Boolean).join(" ") : "";
  return {
    ticket,
    vars: {
      ticketNumber: ticket.number,
      subject: ticket.subject,
      customerName: person || ticket.contactName || customer?.company || "",
      companyName: s.company.name,
    },
    settings: s,
  };
}

/** "Guten Tag ," → "Guten Tag," wenn kein Name bekannt ist */
const tidy = (s: string) => s.replace(/ +,/g, ",").replace(/[ \t]+\n/g, "\n");

async function sendAutoReplyMail(ticketId: string) {
  const { ticket, vars, settings } = await ticketVars(ticketId);
  const subject = `[${ticket.number}] ${render(settings.tickets.autoReplySubject, vars)}`;
  await sendTicketMail(ticketId, { subject, body: tidy(render(settings.tickets.autoReplyBody, vars)), authorId: null });
}

export async function replyToTicket(ticketId: string, body: string, user: { id: string; name: string }, attachments?: OutAttachment[]) {
  const { ticket, vars, settings } = await ticketVars(ticketId);
  const sig = render(settings.tickets.signature, { ...vars, userName: user.name }).trim();
  const text = render(body.trim(), vars);
  const full = sig && !text.includes(sig) ? `${text}\n\n${sig}` : text;
  return sendTicketMail(ticketId, { subject: replySubject(ticket.number, ticket.subject), body: tidy(full), authorId: user.id, attachments });
}

/** Aussortierte Mail doch als Ticket übernehmen */
export async function acceptFiltered(id: string, log: FastifyBaseLogger): Promise<string> {
  const row = (await db.select().from(schema.inboxFiltered).where(eq(schema.inboxFiltered.id, id)))[0];
  if (!row) throw new Error("Mail nicht gefunden");
  if (row.status === "CONVERTED" && row.ticketId) return row.ticketId;
  const t = (await getSettings()).tickets;
  let ticketId: string;
  // Message-ID freigeben, damit sie im Ticket verwendet werden kann
  await db.update(schema.inboxFiltered).set({ messageId: `${row.messageId}#übernommen-${row.id}` }).where(eq(schema.inboxFiltered.id, id));
  if (row.raw) {
    const p = await simpleParser(row.raw);
    ticketId = (await createTicketFromMail(p, row.messageId, t, log, false)).id;
  } else {
    const number = await nextNumber(db, "ticket", t.numberFormat);
    const [ticket] = await db
      .insert(schema.tickets)
      .values({ number, subject: row.subject || "(ohne Betreff)", contactEmail: row.fromEmail, contactName: row.fromName, lastMessageAt: row.receivedAt })
      .returning();
    await db.insert(schema.ticketMessages).values({
      ticketId: ticket.id,
      direction: "IN",
      fromEmail: row.fromEmail,
      fromName: row.fromName,
      subject: row.subject,
      body: row.snippet ?? "",
      messageId: row.messageId,
      createdAt: row.receivedAt,
    });
    ticketId = ticket.id;
  }
  await db.update(schema.inboxFiltered).set({ status: "CONVERTED", ticketId, raw: null }).where(eq(schema.inboxFiltered.id, id));
  return ticketId;
}

export async function ticketStats() {
  const rows = await db
    .select({
      status: schema.tickets.status,
      n: dsql<number>`count(*)::int`,
      unread: dsql<number>`(count(*) filter (where ${schema.tickets.unread}))::int`,
    })
    .from(schema.tickets)
    .groupBy(schema.tickets.status);
  const filtered = (await db.select({ n: dsql<number>`count(*)::int` }).from(schema.inboxFiltered).where(eq(schema.inboxFiltered.status, "FILTERED")))[0].n;
  const g = (s: string) => rows.find((r) => r.status === s) ?? { n: 0, unread: 0 };
  return { open: g("OPEN"), pending: g("PENDING"), closed: g("CLOSED"), filtered };
}
