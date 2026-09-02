/**
 * Angebote: Entwurf → Senden (Nummer, Link) → Kunde nimmt online an oder lehnt ab → Rechnung daraus.
 * Der Kunde erreicht das Angebot über /q/<token> ohne Anmeldung.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, ilike, or, sql as dsql, type SQL } from "drizzle-orm";
import { db, schema, type Tx } from "../db/index.js";
import type { Discount, Invoice, InvoiceItem, Quote } from "../db/schema.js";
import { config } from "../config.js";
import { calculate, formatMoney } from "../lib/calc.js";
import { randomToken } from "../lib/crypto.js";
import { HttpError, addDays, badRequest, currentUser, formatDate, isoDate, notFound, optStr, parse, today } from "../lib/http.js";
import { getSettings, nextNumber, resolveProfile } from "../lib/settings.js";
import { customerDisplayName, customerGreetingName, resolveExemption, snapshotCustomer, type CustomerSnapshot, type InvoiceDoc } from "../lib/invoice-service.js";
import { mailReady, render, sendMail } from "../lib/mail.js";
import { renderInvoicePdf } from "../lib/pdf.js";
import { discountApplies, itemInput, writeDraft } from "./invoices.js";

const dateOpt = isoDate.nullish().or(z.literal("")).transform((v) => v || null);

const quoteInput = z.object({
  customerId: z.string().min(1, "Kunde fehlt"),
  issueDate: dateOpt,
  validUntil: dateOpt,
  serviceDateFrom: dateOpt,
  serviceDateTo: dateOpt,
  subject: optStr,
  introText: optStr,
  footerText: optStr,
  notes: optStr,
  discountId: optStr,
  /** undefined = Standard des Kunden, null/"" = Hauptfirma */
  profileId: z.string().trim().nullish(),
  taxExemption: optStr,
  items: z.array(itemInput).min(1, "Mindestens eine Position"),
});

export function publicBase(req?: FastifyRequest): string {
  return config.publicUrl || (req ? `${req.protocol}://${req.host}` : "");
}

const acceptUrl = (q: Pick<Quote, "publicToken">, base: string) => (q.publicToken && base ? `${base}/q/${q.publicToken}` : null);

/** Angebot in die Form einer Rechnung bringen, damit PDF und Berechnung wiederverwendet werden */
function asInvoice(q: Quote): Invoice {
  return {
    id: q.id,
    number: q.number,
    kind: "INVOICE",
    status: q.status === "DRAFT" ? "DRAFT" : "ISSUED",
    customerId: q.customerId,
    customerSnapshot: q.customerSnapshot,
    companySnapshot: q.companySnapshot,
    invoiceSnapshot: q.invoiceSnapshot,
    issueDate: q.issueDate,
    serviceDateFrom: q.serviceDateFrom,
    serviceDateTo: q.serviceDateTo,
    dueDate: null,
    subject: q.subject,
    introText: q.introText,
    footerText: q.footerText,
    notes: q.notes,
    smallBusiness: q.smallBusiness,
    taxExemption: q.taxExemption,
    taxExemptionText: q.taxExemptionText,
    discountId: q.discountId,
    discountSnapshot: q.discountSnapshot,
    subtotalNet: q.subtotalNet,
    discountTotal: q.discountTotal,
    totalNet: q.totalNet,
    taxTotal: q.taxTotal,
    totalGross: q.totalGross,
    taxBreakdown: q.taxBreakdown,
    paidTotal: 0,
    sentAt: q.sentAt,
    reminderCount: 0,
    lastReminderAt: null,
    cancelsId: null,
    dunningLevel: 0,
    quoteId: null,
    recurringId: null,
    publicToken: null,
    profileId: q.profileId,
    createdById: q.createdById,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  };
}

export async function loadQuote(where: SQL) {
  const quote = (await db.select().from(schema.quotes).where(where))[0];
  if (!quote) return null;
  const qItems = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quote.id)).orderBy(asc(schema.quoteItems.position));
  const settings = await getSettings();
  let customer = quote.customerSnapshot as CustomerSnapshot | null;
  if (!customer) {
    const c = (await db.select().from(schema.customers).where(eq(schema.customers.id, quote.customerId)))[0];
    customer = snapshotCustomer(c);
  }
  const items: InvoiceItem[] = qItems.map(({ quoteId, ...i }) => ({ ...i, invoiceId: quoteId }));
  const prof = resolveProfile(settings, quote.profileId);
  const invoiceSettings = { ...prof.invoice, ...((quote.invoiceSnapshot as Partial<typeof settings.invoice> | null) ?? {}) };
  const inv = asInvoice(quote);
  const doc: InvoiceDoc = {
    invoice: inv,
    items,
    customer,
    company: (quote.companySnapshot as typeof settings.company | null) ?? prof.company,
    invoiceSettings,
    original: null,
    exemption: resolveExemption(inv, items, invoiceSettings),
  };
  return { quote, items: qItems, doc, settings };
}

const isExpired = (q: Pick<Quote, "status" | "validUntil">) => q.status === "SENT" && !!q.validUntil && q.validUntil < today();

async function writeQuote(tx: Tx, input: z.infer<typeof quoteInput>, existingId: string | null, userId: string) {
  const s = await getSettings();
  const customer = (await tx.select().from(schema.customers).where(eq(schema.customers.id, input.customerId)))[0];
  if (!customer) throw badRequest("Kunde existiert nicht");
  let discount: Discount | null = null;
  if (input.discountId) {
    discount = (await tx.select().from(schema.discounts).where(eq(schema.discounts.id, input.discountId)))[0] ?? null;
    if (!discount) throw badRequest("Rabatt existiert nicht");
    const why = discountApplies(discount, customer.id, input.issueDate ?? today());
    if (why) throw badRequest(why);
  }
  const profileId = input.profileId !== undefined ? input.profileId || null : (customer.profileId ?? null);
  if (profileId && !s.profiles.list.some((p) => p.id === profileId)) throw badRequest("Unbekanntes Firmenprofil");
  const smallBusiness = resolveProfile(s, profileId).invoice.smallBusiness;
  const items = input.items.map((i) => ({ ...i, taxRate: smallBusiness ? 0 : i.taxRate }));
  const r = calculate(
    items,
    discount ? { type: discount.type, value: discount.value, scope: discount.scope, productId: discount.productId, minOrderNet: discount.minOrderNet } : null,
    smallBusiness,
  );
  const hasZero = !smallBusiness && items.some((i) => i.taxRate === 0);
  if (hasZero && input.taxExemption && !s.invoice.taxExemptions.some((e) => e.code === input.taxExemption)) throw badRequest("Unbekannter Grund für 0 % USt");
  const values = {
    customerId: customer.id,
    profileId: profileId ?? null,
    issueDate: input.issueDate,
    validUntil: input.validUntil,
    serviceDateFrom: input.serviceDateFrom,
    serviceDateTo: input.serviceDateTo,
    subject: input.subject,
    introText: input.introText,
    footerText: input.footerText,
    notes: input.notes,
    discountId: discount?.id ?? null,
    smallBusiness,
    taxExemption: hasZero ? (input.taxExemption ?? s.invoice.defaultExemption) : null,
    taxExemptionText: null,
    subtotalNet: r.subtotalNet,
    discountTotal: r.discountTotal,
    totalNet: r.totalNet,
    taxTotal: r.taxTotal,
    totalGross: r.totalGross,
    taxBreakdown: r.taxBreakdown,
  };
  let id = existingId;
  if (id) {
    await tx.update(schema.quotes).set(values).where(eq(schema.quotes.id, id));
    await tx.delete(schema.quoteItems).where(eq(schema.quoteItems.quoteId, id));
  } else {
    id = (await tx.insert(schema.quotes).values({ ...values, createdById: userId }).returning({ id: schema.quotes.id }))[0].id;
  }
  await tx.insert(schema.quoteItems).values(items.map((it, idx) => ({ ...it, quoteId: id!, position: idx + 1, lineNet: r.lines[idx] })));
  return id;
}

async function getQuote(id: string) {
  const q = (await db.select().from(schema.quotes).where(eq(schema.quotes.id, id)))[0];
  if (!q) throw notFound("Angebot");
  return q;
}

function quoteVars(q: Quote, doc: InvoiceDoc, companyName: string, base: string) {
  return {
    customerName: customerGreetingName(doc.customer),
    customerNumber: doc.customer.number,
    companyName,
    quoteNumber: q.number ?? "Entwurf",
    total: formatMoney(q.totalGross, doc.invoiceSettings.currency),
    issueDate: formatDate(q.issueDate),
    validUntil: formatDate(q.validUntil),
    acceptLink: acceptUrl(q, base) ?? "",
  };
}

const pdfName = (q: Pick<Quote, "number">) => `Angebot_${(q.number ?? "Entwurf").replace(/[^\w.-]+/g, "_")}.pdf`;

async function sendQuoteMail(quoteId: string, base: string, overrideTo?: string): Promise<{ ok: boolean; error?: string; skipped?: string }> {
  const loaded = await loadQuote(eq(schema.quotes.id, quoteId));
  if (!loaded) throw notFound("Angebot");
  const { quote, doc, settings: s } = loaded;
  if (!mailReady(s)) return { ok: false, skipped: "E-Mail-Versand ist nicht eingerichtet" };
  const to = overrideTo || doc.customer.email;
  if (!to) return { ok: false, skipped: "Kunde hat keine E-Mail-Adresse" };
  const vars = quoteVars(quote, doc, s.company.name, base);
  const r = await sendMail({
    kind: "quote",
    to,
    subject: render(s.templates.quote.subject, vars),
    text: render(s.templates.quote.body, vars),
    attachments: [
      {
        filename: pdfName(quote),
        content: await renderInvoicePdf(doc, { quote: { validUntil: quote.validUntil, acceptUrl: acceptUrl(quote, base) } }),
        contentType: "application/pdf",
      },
    ],
    customerId: quote.customerId,
  });
  if (r.ok) await db.update(schema.quotes).set({ sentAt: new Date() }).where(eq(schema.quotes.id, quoteId));
  return r;
}

/** Angebot in einen Rechnungsentwurf übernehmen */
async function quoteToInvoice(quoteId: string, userId: string | null) {
  const loaded = await loadQuote(eq(schema.quotes.id, quoteId));
  if (!loaded) throw notFound("Angebot");
  const { quote, items } = loaded;
  if (quote.invoiceId) return quote.invoiceId;
  if (quote.status === "DRAFT") throw badRequest("Bitte das Angebot zuerst senden oder als angenommen markieren");
  if (quote.status === "DECLINED") throw badRequest("Das Angebot wurde abgelehnt");
  return db.transaction(async (tx) => {
    const invId = await writeDraft(
      tx,
      {
        customerId: quote.customerId,
        profileId: quote.profileId,
        issueDate: null,
        serviceDateFrom: quote.serviceDateFrom,
        serviceDateTo: quote.serviceDateTo,
        dueDate: null,
        subject: quote.subject ?? (quote.number ? `Gemäß Angebot ${quote.number}` : null),
        introText: null,
        footerText: null,
        notes: quote.number ? `Grundlage: Angebot ${quote.number} vom ${formatDate(quote.issueDate)}.` : null,
        discountId: quote.discountId,
        taxExemption: quote.taxExemption,
        items: items.map((i) => ({
          productId: i.productId,
          name: i.name,
          description: i.description,
          quantity: i.quantity,
          unit: i.unit,
          unitPriceNet: i.unitPriceNet,
          taxRate: i.taxRate,
          discountBps: i.discountBps,
        })),
      },
      null,
      userId,
      { quoteId: quote.id },
    );
    await tx.update(schema.quotes).set({ status: "INVOICED", invoiceId: invId }).where(eq(schema.quotes.id, quote.id));
    return invId;
  });
}

export async function quoteRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string; q?: string; customerId?: string } }>("/api/quotes", async (req) => {
    currentUser(req);
    const { status, q, customerId } = req.query;
    const conds: (SQL | undefined)[] = [];
    if (status === "EXPIRED") conds.push(eq(schema.quotes.status, "SENT"), dsql`${schema.quotes.validUntil} < ${today()}`);
    else if (status === "OPEN") conds.push(eq(schema.quotes.status, "SENT"), dsql`(${schema.quotes.validUntil} is null or ${schema.quotes.validUntil} >= ${today()})`);
    else if (status && ["DRAFT", "SENT", "ACCEPTED", "DECLINED", "INVOICED"].includes(status)) conds.push(eq(schema.quotes.status, status as "DRAFT"));
    if (customerId) conds.push(eq(schema.quotes.customerId, customerId));
    if (q?.trim()) {
      const p = `%${q.trim()}%`;
      conds.push(or(ilike(schema.quotes.number, p), ilike(schema.quotes.subject, p), ilike(schema.customers.company, p), ilike(schema.customers.lastName, p)));
    }
    const rows = await db
      .select({
        q: {
          id: schema.quotes.id,
          number: schema.quotes.number,
          status: schema.quotes.status,
          issueDate: schema.quotes.issueDate,
          validUntil: schema.quotes.validUntil,
          subject: schema.quotes.subject,
          totalGross: schema.quotes.totalGross,
          sentAt: schema.quotes.sentAt,
          viewedAt: schema.quotes.viewedAt,
          answeredAt: schema.quotes.answeredAt,
          invoiceId: schema.quotes.invoiceId,
          createdAt: schema.quotes.createdAt,
        },
        customerId: schema.customers.id,
        company: schema.customers.company,
        firstName: schema.customers.firstName,
        lastName: schema.customers.lastName,
        ctype: schema.customers.type,
      })
      .from(schema.quotes)
      .innerJoin(schema.customers, eq(schema.customers.id, schema.quotes.customerId))
      .where(and(...conds))
      .orderBy(desc(schema.quotes.createdAt))
      .limit(500);
    return rows.map((r) => ({
      ...r.q,
      customerId: r.customerId,
      customerName: (r.ctype === "COMPANY" ? r.company : null) || [r.firstName, r.lastName].filter(Boolean).join(" ") || r.company || "",
      expired: isExpired(r.q),
    }));
  });

  app.get<{ Params: { id: string } }>("/api/quotes/:id", async (req) => {
    currentUser(req);
    const loaded = await loadQuote(eq(schema.quotes.id, req.params.id));
    if (!loaded) throw notFound("Angebot");
    const { quote, items, doc } = loaded;
    const invoice = quote.invoiceId
      ? ((await db.select({ id: schema.invoices.id, number: schema.invoices.number, status: schema.invoices.status }).from(schema.invoices).where(eq(schema.invoices.id, quote.invoiceId)))[0] ?? null)
      : null;
    const mails = quote.number
      ? await db
          .select()
          .from(schema.mailLogs)
          .where(and(eq(schema.mailLogs.kind, "quote"), eq(schema.mailLogs.customerId, quote.customerId), ilike(schema.mailLogs.subject, `%${quote.number}%`)))
          .orderBy(desc(schema.mailLogs.createdAt))
      : [];
    const { publicToken: _t, ...rest } = quote;
    return {
      ...rest,
      items,
      customer: doc.customer,
      exemption: doc.exemption,
      expired: isExpired(quote),
      publicUrl: acceptUrl(quote, publicBase(req)),
      invoice,
      mails,
    };
  });

  app.post("/api/quotes", async (req) => {
    const me = currentUser(req);
    const body = parse(quoteInput, req.body);
    return { id: await db.transaction((tx) => writeQuote(tx, body, null, me.id)) };
  });

  app.put<{ Params: { id: string } }>("/api/quotes/:id", async (req) => {
    const me = currentUser(req);
    const body = parse(quoteInput, req.body);
    const q = await getQuote(req.params.id);
    if (q.status !== "DRAFT") throw new HttpError(409, "Versendete Angebote können nicht mehr geändert werden – als Kopie neu anlegen", "not_draft");
    await db.transaction((tx) => writeQuote(tx, body, q.id, me.id));
    return { id: q.id };
  });

  app.delete<{ Params: { id: string } }>("/api/quotes/:id", async (req) => {
    currentUser(req);
    const q = await getQuote(req.params.id);
    if (q.status !== "DRAFT") throw badRequest("Nur Entwürfe können gelöscht werden");
    await db.delete(schema.quotes).where(eq(schema.quotes.id, q.id));
    return { ok: true };
  });

  /** Entwurf festschreiben (Nummer, Gültigkeit, Link) und optional mailen; bei versendeten Angeboten erneut senden */
  app.post<{ Params: { id: string } }>("/api/quotes/:id/send", async (req) => {
    currentUser(req);
    const { send, to } = parse(z.object({ send: z.boolean().default(true), to: z.string().email().optional() }), req.body);
    const s = await getSettings();
    if (!s.company.name) throw badRequest("Bitte zuerst in den Einstellungen die Firmendaten hinterlegen");
    const q = await getQuote(req.params.id);
    if (q.status === "DECLINED" || q.status === "INVOICED") throw badRequest("Dieses Angebot ist abgeschlossen");
    const base = publicBase(req);
    if (q.status === "DRAFT") {
      await db.transaction(async (tx) => {
        const customer = (await tx.select().from(schema.customers).where(eq(schema.customers.id, q.customerId)))[0];
        const issueDate = q.issueDate ?? today();
        const validUntil = q.validUntil ?? addDays(issueDate, s.quotes.validDays);
        const items = await tx.select({ taxRate: schema.quoteItems.taxRate }).from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, q.id));
        const exemption = resolveExemption(q, items, s.invoice);
        const number = await nextNumber(tx, "quote", s.quotes.numberFormat, new Date(`${issueDate}T12:00:00`));
        const discount = q.discountId ? (await tx.select().from(schema.discounts).where(eq(schema.discounts.id, q.discountId)))[0] : null;
        const footer = render(q.footerText ?? s.quotes.footerText, { validUntil: formatDate(validUntil), quoteNumber: number });
        await tx
          .update(schema.quotes)
          .set({
            number,
            status: "SENT",
            issueDate,
            validUntil,
            publicToken: randomToken(24),
            taxExemption: exemption?.code ?? null,
            taxExemptionText: exemption?.text ?? null,
            customerSnapshot: snapshotCustomer(customer),
            companySnapshot: resolveProfile(s, q.profileId).company,
            invoiceSnapshot: resolveProfile(s, q.profileId).invoice,
            discountSnapshot: discount ? { name: discount.name, type: discount.type, value: discount.value, code: discount.code } : null,
            introText: q.introText ?? s.quotes.introText,
            footerText: footer,
          })
          .where(eq(schema.quotes.id, q.id));
      });
    }
    const mail = send ? await sendQuoteMail(q.id, base, to) : null;
    if (send && mail && !mail.ok && q.status !== "DRAFT") throw badRequest(mail.error ?? mail.skipped ?? "Versand fehlgeschlagen");
    return { id: q.id, mail, publicUrl: acceptUrl(await getQuote(q.id), base) };
  });

  /** Status von Hand setzen (z. B. telefonisch angenommen) */
  app.post<{ Params: { id: string } }>("/api/quotes/:id/status", async (req) => {
    const me = currentUser(req);
    const { status, note } = parse(z.object({ status: z.enum(["SENT", "ACCEPTED", "DECLINED"]), note: optStr }), req.body);
    const q = await getQuote(req.params.id);
    if (q.status === "DRAFT" || q.status === "INVOICED") throw badRequest("Status kann hier nicht geändert werden");
    await db
      .update(schema.quotes)
      .set({
        status,
        answeredAt: status === "SENT" ? null : new Date(),
        answeredBy: status === "SENT" ? null : `${me.name} (von Hand)`,
        answerNote: status === "SENT" ? null : (note ?? null),
      })
      .where(eq(schema.quotes.id, q.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/quotes/:id/invoice", async (req) => {
    const me = currentUser(req);
    return { invoiceId: await quoteToInvoice(req.params.id, me.id) };
  });

  app.post<{ Params: { id: string } }>("/api/quotes/:id/duplicate", async (req) => {
    const me = currentUser(req);
    const loaded = await loadQuote(eq(schema.quotes.id, req.params.id));
    if (!loaded) throw notFound("Angebot");
    const { quote, items } = loaded;
    const id = await db.transaction((tx) =>
      writeQuote(
        tx,
        {
          customerId: quote.customerId,
          profileId: quote.profileId,
          issueDate: null,
          validUntil: null,
          serviceDateFrom: null,
          serviceDateTo: null,
          subject: quote.subject,
          introText: quote.introText,
          footerText: null,
          notes: quote.notes,
          discountId: null,
          taxExemption: quote.smallBusiness ? null : quote.taxExemption,
          items: items.map((i) => ({
            productId: i.productId,
            name: i.name,
            description: i.description,
            quantity: i.quantity,
            unit: i.unit,
            unitPriceNet: i.unitPriceNet,
            taxRate: i.taxRate,
            discountBps: i.discountBps,
          })),
        },
        null,
        me.id,
      ),
    );
    return { id };
  });

  app.get<{ Params: { id: string } }>("/api/quotes/:id/pdf", async (req, reply) => {
    currentUser(req);
    const loaded = await loadQuote(eq(schema.quotes.id, req.params.id));
    if (!loaded) throw notFound("Angebot");
    const { quote, doc } = loaded;
    const pdf = await renderInvoicePdf(doc, { quote: { validUntil: quote.validUntil, acceptUrl: acceptUrl(quote, publicBase(req)) } });
    return reply.header("Content-Type", "application/pdf").header("Content-Disposition", `attachment; filename="${pdfName(quote)}"`).send(pdf);
  });

  // ---------- Öffentliche Kundenansicht ----------
  const byToken = async (token: string) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    return loadQuote(eq(schema.quotes.publicToken, token));
  };

  app.get<{ Params: { token: string } }>("/q/:token", async (req, reply) => {
    reply.type("text/html; charset=utf-8").header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex");
    const loaded = await byToken(req.params.token);
    if (!loaded) return reply.status(404).send(publicPage("Angebot nicht gefunden", `<h1>Angebot nicht gefunden</h1><p>Dieser Link ist ungültig oder das Angebot wurde zurückgezogen.</p>`, "#b3261e"));
    if (!loaded.quote.viewedAt) await db.update(schema.quotes).set({ viewedAt: new Date() }).where(eq(schema.quotes.id, loaded.quote.id));
    return quotePage(loaded, req.params.token);
  });

  app.get<{ Params: { token: string } }>("/q/:token/pdf", async (req, reply) => {
    const loaded = await byToken(req.params.token);
    if (!loaded) throw notFound("Angebot");
    const { quote, doc } = loaded;
    const pdf = await renderInvoicePdf(doc, { quote: { validUntil: quote.validUntil, acceptUrl: null } });
    return reply.header("Content-Type", "application/pdf").header("Content-Disposition", `inline; filename="${pdfName(quote)}"`).send(pdf);
  });

  app.post<{ Params: { token: string } }>("/q/:token/answer", async (req) => {
    const body = parse(
      z.object({ accept: z.boolean(), name: z.string().trim().min(2, "Bitte Ihren Namen angeben").max(120), note: z.string().trim().max(2000).optional() }),
      req.body,
    );
    const loaded = await byToken(req.params.token);
    if (!loaded) throw notFound("Angebot");
    const { quote, doc, settings: s } = loaded;
    if (quote.status !== "SENT") throw badRequest(quote.status === "DECLINED" ? "Das Angebot wurde bereits abgelehnt" : "Das Angebot wurde bereits angenommen");
    if (isExpired(quote)) throw badRequest(`Das Angebot ist am ${formatDate(quote.validUntil)} abgelaufen. Bitte fordern Sie ein neues an.`);
    await db
      .update(schema.quotes)
      .set({ status: body.accept ? "ACCEPTED" : "DECLINED", answeredAt: new Date(), answeredBy: body.name, answerNote: body.note || null })
      .where(and(eq(schema.quotes.id, quote.id), eq(schema.quotes.status, "SENT")));
    let invoiceId: string | null = null;
    if (body.accept && s.quotes.draftOnAccept) invoiceId = await quoteToInvoice(quote.id, null).catch(() => null);
    if (s.quotes.notifyOnAnswer && s.company.email && mailReady(s)) {
      const who = customerDisplayName(doc.customer);
      void sendMail({
        kind: "quote",
        to: s.company.email,
        subject: `Angebot ${quote.number} ${body.accept ? "angenommen" : "abgelehnt"} – ${who}`,
        text: [
          `${who} hat das Angebot ${quote.number} über ${formatMoney(quote.totalGross, doc.invoiceSettings.currency)} ${body.accept ? "angenommen" : "abgelehnt"}.`,
          "",
          `Name: ${body.name}`,
          body.note ? `Nachricht: ${body.note}` : "",
          invoiceId ? "Ein Rechnungsentwurf wurde automatisch angelegt." : "",
        ]
          .filter((l, i) => i === 1 || l !== "")
          .join("\n"),
        customerId: quote.customerId,
      });
    }
    return { ok: true, status: body.accept ? "ACCEPTED" : "DECLINED" };
  });
}

// ---------- HTML für Kunden ----------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function publicPage(title: string, body: string, accent = "#1f3a5f") {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f4f2;--card:#fff;--fg:#1c1c1a;--mut:#66665f;--line:#e2e2dd;--acc:${accent};--ok:#1f7a4d;--bad:#b3261e;--lnk:var(--acc)}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1d1d1b;--fg:#ececE7;--mut:#a2a29b;--line:#2e2e2b;--ok:#4fb383;--bad:#e38a78;--lnk:color-mix(in srgb,var(--acc) 40%,#fff)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px}
main{max-width:760px;margin:0 auto;background:var(--card);border-radius:10px;padding:28px clamp(16px,4vw,36px);border-top:4px solid var(--acc)}
h1{font-size:22px;margin:0 0 4px}.mut{color:var(--mut)}.row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.tw{overflow-x:auto}table{width:100%;border-collapse:collapse;margin:18px 0}th,td{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);font-weight:600}td.n,th.n{text-align:right;white-space:nowrap}
.tot td{border:0;padding:3px 6px}.grand td{font-weight:700;font-size:17px;border-top:2px solid var(--acc);padding-top:8px}
.desc{color:var(--mut);font-size:13px;white-space:pre-line}.note{background:var(--bg);border-radius:6px;padding:10px 12px;margin:14px 0;font-size:14px}
form{margin-top:22px;border-top:1px solid var(--line);padding-top:18px}label{display:block;font-size:13px;font-weight:600;margin:10px 0 4px}
input,textarea,select{width:100%;font:inherit;padding:9px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
.btns{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}button{font:inherit;font-weight:600;border-radius:6px;padding:10px 18px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.ok{background:var(--acc);border-color:var(--acc);color:#fff}button:disabled{opacity:.6}a{color:var(--lnk)}
.state{padding:12px 14px;border-radius:6px;margin:16px 0;font-weight:600}.state.ok{background:color-mix(in srgb,var(--ok) 14%,transparent);color:var(--ok)}
.state.bad{background:color-mix(in srgb,var(--bad) 12%,transparent);color:var(--bad)}.err{color:var(--bad);margin-top:8px;font-size:14px}
</style></head><body><main>${body}</main></body></html>`;
}

function quotePage(loaded: NonNullable<Awaited<ReturnType<typeof loadQuote>>>, token: string) {
  const { quote, items, doc } = loaded;
  const cur = doc.invoiceSettings.currency;
  const m = (c: number) => esc(formatMoney(c, cur));
  const company = doc.company;
  const rows = items
    .map(
      (i) => `<tr><td><strong>${esc(i.name)}</strong>${i.description ? `<div class="desc">${esc(i.description)}</div>` : ""}</td>
<td class="n">${i.quantity.toLocaleString("de-DE")} ${esc(i.unit)}</td><td class="n">${m(i.unitPriceNet)}</td><td class="n">${m(i.lineNet)}</td></tr>`,
    )
    .join("");
  const taxes = ((quote.taxBreakdown as { rate: number; tax: number }[] | null) ?? [])
    .map((t) => `<tr><td colspan="3">zzgl. ${t.rate.toLocaleString("de-DE")} % USt.</td><td class="n">${m(t.tax)}</td></tr>`)
    .join("");
  const totals = `<table class="tot">${quote.discountTotal ? `<tr><td colspan="3">Rabatt</td><td class="n">- ${m(Math.abs(quote.discountTotal))}</td></tr>` : ""}
${quote.smallBusiness ? "" : `<tr><td colspan="3">Summe netto</td><td class="n">${m(quote.totalNet)}</td></tr>${taxes}`}
<tr class="grand"><td colspan="3">Angebotssumme</td><td class="n">${m(quote.totalGross)}</td></tr></table>`;
  let action: string;
  if (quote.status === "ACCEPTED" || quote.status === "INVOICED")
    action = `<div class="state ok">Sie haben dieses Angebot am ${esc(formatDate(quote.answeredAt?.toISOString().slice(0, 10) ?? null))} angenommen. Vielen Dank für Ihren Auftrag!</div>`;
  else if (quote.status === "DECLINED") action = `<div class="state bad">Dieses Angebot wurde abgelehnt.</div>`;
  else if (isExpired(quote)) action = `<div class="state bad">Dieses Angebot ist am ${esc(formatDate(quote.validUntil))} abgelaufen. Bitte fordern Sie bei uns ein neues an.</div>`;
  else
    action = `<form id="f" onsubmit="return false">
<label for="name">Ihr Name</label><input id="name" autocomplete="name" required maxlength="120">
<label for="note">Nachricht (optional)</label><textarea id="note" rows="3" maxlength="2000"></textarea>
<div class="btns"><button class="ok" type="button" data-a="1">Angebot verbindlich annehmen</button><button type="button" data-a="0">Ablehnen</button></div>
<div id="err" class="err" role="alert"></div></form>
<script>
document.querySelectorAll("button[data-a]").forEach(function(b){b.addEventListener("click",async function(){
var accept=b.dataset.a==="1",name=document.getElementById("name").value.trim(),err=document.getElementById("err");err.textContent="";
if(name.length<2){err.textContent="Bitte geben Sie Ihren Namen an.";return}
if(!accept&&!confirm("Angebot wirklich ablehnen?"))return;
document.querySelectorAll("button").forEach(function(x){x.disabled=true});
try{var r=await fetch(location.pathname.replace(/\\/$/,"")+"/answer",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accept:accept,name:name,note:document.getElementById("note").value})});
var j=await r.json();if(!r.ok)throw new Error(j.error||"Fehler");location.reload()}catch(e){err.textContent=e.message;document.querySelectorAll("button").forEach(function(x){x.disabled=false})}})});
</script>`;
  const body = `<div class="row"><div><h1>Angebot ${esc(quote.number ?? "")}</h1>
<div class="mut">${esc(company.name)} für ${esc(customerDisplayName(doc.customer))}</div></div>
<div class="mut" style="text-align:right">Datum ${esc(formatDate(quote.issueDate))}<br>${quote.validUntil ? `gültig bis ${esc(formatDate(quote.validUntil))}` : ""}</div></div>
${quote.subject ? `<p><strong>${esc(quote.subject)}</strong></p>` : ""}${quote.introText ? `<p>${esc(quote.introText)}</p>` : ""}
<div class="tw"><table><thead><tr><th>Leistung</th><th class="n">Menge</th><th class="n">Einzelpreis</th><th class="n">Gesamt</th></tr></thead><tbody>${rows}</tbody></table></div>
${totals}${doc.exemption ? `<div class="note">${esc(doc.exemption.text)}</div>` : ""}${quote.notes ? `<div class="note">${esc(quote.notes)}</div>` : ""}
<p><a href="/q/${esc(token)}/pdf">Angebot als PDF</a></p>${action}
<p class="mut" style="font-size:13px;margin-top:22px">${esc([company.name, company.street, [company.zip, company.city].filter(Boolean).join(" "), company.email, company.phone].filter(Boolean).join(" · "))}</p>`;
  return publicPage(`Angebot ${quote.number ?? ""} – ${company.name}`, body, doc.invoiceSettings.accentColor);
}
