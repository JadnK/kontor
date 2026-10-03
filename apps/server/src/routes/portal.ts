/**
 * Öffentliche Kundenseiten:
 *  /p/:token          Kundenportal (Rechnungen, Angebote, Anfragen)
 *  /form/ticket       Anfrage-Formular für die eigene Website (auch als iframe)
 *  /pay/:token        Rechnung online bezahlen (Stripe Checkout, PayPal.me, Überweisung)
 *  /api/payments/stripe/webhook
 * plus die Verwaltungs-Endpunkte für die App.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import QRCode from "qrcode";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";
import { formatMoney } from "../lib/calc.js";
import { HttpError, badRequest, currentUser, formatDate, notFound, parse, requireAdmin } from "../lib/http.js";
import { getSettings } from "../lib/settings.js";
import { customerDisplayName, customerGreetingName, invoiceFileBase, loadInvoiceDoc, snapshotCustomer } from "../lib/invoice-service.js";
import { renderInvoicePdf, epcPayload } from "../lib/pdf.js";
import { mailReady, render, sendMail } from "../lib/mail.js";
import { appendCustomerMessage, createTicket, findCustomerFor } from "../lib/tickets.js";
import {
  bookSession,
  checkStripe,
  createCheckout,
  ensureInvoiceToken,
  ensurePortalToken,
  fetchSession,
  newToken,
  paymentsReady,
  payUrlFor,
  pdfPayUrl,
  rateLimited,
  verifyStripeSignature,
  type StripeSession,
} from "../lib/portal.js";
import { publicPage } from "./quotes.js";

export const WEBHOOK_PATH = "/api/payments/stripe/webhook";
export const PUBLIC_PREFIXES_PORTAL = ["/p/", "/form/", "/pay/"];

const esc = (s: string | null | undefined) => (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const nl2br = (s: string) => esc(s).replace(/\n/g, "<br>");

const EXTRA_CSS = `<style>
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:18px 0 6px;flex-wrap:wrap}.tabs a{padding:8px 12px;text-decoration:none;color:var(--mut);border-bottom:2px solid transparent;font-weight:600}
.tabs a.on{color:var(--fg);border-color:var(--acc)}.badge{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:99px;background:var(--bg);color:var(--mut);white-space:nowrap}
.badge.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}.badge.bad{color:var(--bad);background:color-mix(in srgb,var(--bad) 10%,transparent)}
.badge.warn{color:#9a6a00;background:color-mix(in srgb,#d9a300 16%,transparent)}a.btn{display:inline-block;text-decoration:none;font-weight:600;border-radius:6px;padding:6px 11px;border:1px solid var(--line);color:var(--fg);background:var(--card);font-size:14px;margin:2px 0}
a.btn.pri{background:var(--acc);border-color:var(--acc);color:#fff}.msg{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:10px 0}.msg.out{background:var(--bg)}
.msg .h{display:flex;justify-content:space-between;gap:8px;font-size:13px;color:var(--mut);margin-bottom:6px}.msg .b{white-space:pre-wrap;word-wrap:break-word}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}.pay{display:grid;gap:12px;margin:18px 0}.pay .opt{border:1px solid var(--line);border-radius:8px;padding:14px 16px}
.pay .opt h3{margin:0 0 6px;font-size:15px}.qr{display:flex;gap:16px;align-items:center;flex-wrap:wrap}.qr img{width:140px;height:140px;background:#fff;border-radius:6px;padding:6px}
.mono{font-family:ui-monospace,Consolas,monospace}.empty{color:var(--mut);padding:10px 0}.files{font-size:13px}.state{background:var(--bg)}
@media (max-width:640px){.hm{display:none}td,th{padding:8px 4px}a.btn{padding:6px 9px}}
body.embed{padding:0;background:transparent}body.embed main{border-top:0;border-radius:0;max-width:none;padding:4px}
</style>`;

function page(title: string, body: string, accent: string, opts: { embed?: boolean } = {}) {
  const html = publicPage(title, EXTRA_CSS + body, accent);
  return opts.embed ? html.replace("<body>", '<body class="embed">') : html;
}

function companyFooter(c: Awaited<ReturnType<typeof getSettings>>["company"]) {
  return `<p class="mut" style="font-size:13px;margin-top:26px">${esc(
    [c.name, c.street, [c.zip, c.city].filter(Boolean).join(" "), c.email, c.phone].filter(Boolean).join(" · "),
  )}</p>`;
}

function sendHtml(reply: FastifyReply, html: string, status = 200) {
  return reply
    .status(status)
    .header("Content-Type", "text/html; charset=utf-8")
    .header("Cache-Control", "no-store")
    .header("Referrer-Policy", "no-referrer")
    .send(html);
}

const fileInput = z.object({ name: z.string().trim().min(1).max(200), type: z.string().max(100).optional(), data: z.string().min(1) });
const toFiles = (files: z.infer<typeof fileInput>[] | undefined) =>
  (files ?? []).slice(0, 5).map((f) => ({ filename: f.name, contentType: f.type || "application/octet-stream", data: Buffer.from(f.data, "base64") }));

const clientIp = (req: FastifyRequest) => req.ip || "unknown";

/** Gemeinsames JS für Formulare: sammelt Felder + Dateien (base64) und schickt JSON */
const FORM_JS = `<script>
function b64(f){return new Promise(function(res,rej){var r=new FileReader();r.onload=function(){res(String(r.result).split(",")[1])};r.onerror=rej;r.readAsDataURL(f)})}
async function sendForm(form,url,done){var err=form.querySelector(".err");err.textContent="";var btn=form.querySelector("button[type=submit]");btn.disabled=true;
try{var data={};new FormData(form).forEach(function(v,k){if(typeof v==="string")data[k]=v});var fi=form.querySelector("input[type=file]");
if(fi&&fi.files.length){data.files=[];for(var i=0;i<fi.files.length;i++){var f=fi.files[i];if(f.size>15*1024*1024)throw new Error("Datei "+f.name+" ist zu groß (max. 15 MB)");data.files.push({name:f.name,type:f.type,data:await b64(f)})}}
var r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});var j=await r.json().catch(function(){return{}});
if(!r.ok)throw new Error(j.error||"Senden fehlgeschlagen");done(j)}catch(e){err.textContent=e.message;btn.disabled=false}}
</script>`;

async function portalCustomer(token: string) {
  if (!token || token.length < 20) return null;
  const c = (await db.select().from(schema.customers).where(eq(schema.customers.portalToken, token)))[0];
  return c && !c.archived ? c : null;
}

async function invoiceByToken(token: string) {
  if (!token || token.length < 20) return undefined;
  return (await db.select().from(schema.invoices).where(eq(schema.invoices.publicToken, token)))[0];
}

const INV_STATE: Record<string, { label: string; cls: string }> = {
  ISSUED: { label: "offen", cls: "warn" },
  PAID: { label: "bezahlt", cls: "ok" },
  CANCELLED: { label: "storniert", cls: "" },
};
const QUOTE_STATE: Record<string, { label: string; cls: string }> = {
  SENT: { label: "wartet auf Antwort", cls: "warn" },
  ACCEPTED: { label: "angenommen", cls: "ok" },
  INVOICED: { label: "angenommen", cls: "ok" },
  DECLINED: { label: "abgelehnt", cls: "bad" },
};
const TICKET_STATE: Record<string, { label: string; cls: string }> = {
  OPEN: { label: "in Bearbeitung", cls: "warn" },
  PENDING: { label: "Antwort von uns", cls: "ok" },
  CLOSED: { label: "erledigt", cls: "" },
};

const fmtWhen = (d: Date) => d.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });

export async function portalRoutes(app: FastifyInstance) {
  // ============ Verwaltung (App) ============
  app.get<{ Params: { id: string } }>("/api/customers/:id/portal", async (req) => {
    currentUser(req);
    const s = await getSettings();
    const c = (await db.select({ id: schema.customers.id, t: schema.customers.portalToken }).from(schema.customers).where(eq(schema.customers.id, req.params.id)))[0];
    if (!c) throw notFound("Kunde");
    return { enabled: s.portal.enabled, publicUrl: !!config.publicUrl, url: c.t && config.publicUrl ? `${config.publicUrl}/p/${c.t}` : null };
  });

  app.post<{ Params: { id: string } }>("/api/customers/:id/portal", async (req) => {
    currentUser(req);
    const body = parse(z.object({ renew: z.boolean().default(false) }), req.body ?? {});
    if (!config.publicUrl) throw badRequest("Für das Kundenportal muss PUBLIC_URL auf dem Server gesetzt sein (öffentliche Adresse)");
    const c = (await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.id, req.params.id)))[0];
    if (!c) throw notFound("Kunde");
    const t = await ensurePortalToken(c.id, body.renew);
    return { url: `${config.publicUrl}/p/${t}` };
  });

  app.post<{ Params: { id: string } }>("/api/customers/:id/portal/send", async (req) => {
    currentUser(req);
    const s = await getSettings();
    if (!config.publicUrl) throw badRequest("Für das Kundenportal muss PUBLIC_URL auf dem Server gesetzt sein");
    if (!mailReady(s)) throw badRequest("E-Mail-Versand ist nicht eingerichtet");
    const c = (await db.select().from(schema.customers).where(eq(schema.customers.id, req.params.id)))[0];
    if (!c) throw notFound("Kunde");
    if (!c.email) throw badRequest("Kunde hat keine E-Mail-Adresse");
    const url = `${config.publicUrl}/p/${await ensurePortalToken(c.id)}`;
    const vars = { customerName: customerGreetingName(snapshotCustomer(c)), companyName: s.company.name || s.mail.fromName, portalLink: url, customerNumber: c.number };
    const res = await sendMail({ kind: "portal", to: c.email, subject: render(s.templates.portal.subject, vars), text: render(s.templates.portal.body, vars), customerId: c.id });
    if (!res.ok) throw badRequest(res.error ?? "Versand fehlgeschlagen");
    return { ok: true, url };
  });

  app.get<{ Params: { id: string } }>("/api/invoices/:id/paylink", async (req) => {
    currentUser(req);
    const s = await getSettings();
    const inv = (await db.select().from(schema.invoices).where(eq(schema.invoices.id, req.params.id)))[0];
    if (!inv) throw notFound("Rechnung");
    const payments = await db
      .select({
        id: schema.onlinePayments.id,
        amount: schema.onlinePayments.amount,
        status: schema.onlinePayments.status,
        method: schema.onlinePayments.method,
        createdAt: schema.onlinePayments.createdAt,
        paidAt: schema.onlinePayments.paidAt,
      })
      .from(schema.onlinePayments)
      .where(and(eq(schema.onlinePayments.invoiceId, inv.id), ne(schema.onlinePayments.status, "OPEN")))
      .orderBy(desc(schema.onlinePayments.createdAt));
    return { ready: paymentsReady(s), publicUrl: !!config.publicUrl, url: await payUrlFor({ invoice: inv }, s), payments };
  });

  /** Öffentliche Adressen für Einstellungen (Formular-Einbettung, Stripe-Webhook) */
  app.get("/api/settings/public-links", async (req) => {
    currentUser(req);
    const base = config.publicUrl || `${req.protocol}://${req.host}`;
    return { configured: !!config.publicUrl, base, formUrl: `${base}/form/ticket`, webhookUrl: `${base}${WEBHOOK_PATH}` };
  });

  app.post("/api/settings/payments/verify", async (req) => {
    requireAdmin(req);
    const s = await getSettings();
    if (!s.payments.stripeSecretKey) throw badRequest("Kein Stripe-Schlüssel gespeichert");
    try {
      const r = await checkStripe(s.payments.stripeSecretKey);
      return { ok: true, livemode: r.livemode, webhook: !!s.payments.stripeWebhookSecret, publicUrl: config.publicUrl || null };
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : String(e));
    }
  });

  // ============ Kundenportal ============
  app.get<{ Params: { token: string }; Querystring: { tab?: string; sent?: string } }>("/p/:token", async (req, reply) => {
    const s = await getSettings();
    const accent = s.invoice.accentColor;
    const c = s.portal.enabled ? await portalCustomer(req.params.token) : null;
    if (!c) return sendHtml(reply, page("Link ungültig", `<h1>Link ungültig</h1><p class="mut">Dieser Link ist nicht (mehr) gültig. Bitte fordern Sie bei uns einen neuen an.</p>`, accent), 404);
    const base = `/p/${esc(req.params.token)}`;
    const ticketsOn = s.portal.showTickets && s.tickets.portalTickets;
    const tabs = [s.portal.showInvoices && ["invoices", "Rechnungen"], s.portal.showQuotes && ["quotes", "Angebote"], ticketsOn && ["tickets", "Anfragen"]].filter(Boolean) as [string, string][];
    const tab = tabs.some(([k]) => k === req.query.tab) ? req.query.tab! : (tabs[0]?.[0] ?? "");
    const cur = s.invoice.currency;
    let content = "";
    if (tab === "invoices") {
      const rows = await db
        .select()
        .from(schema.invoices)
        .where(and(eq(schema.invoices.customerId, c.id), inArray(schema.invoices.status, ["ISSUED", "PAID", "CANCELLED"]), eq(schema.invoices.kind, "INVOICE")))
        .orderBy(desc(schema.invoices.issueDate), desc(schema.invoices.number))
        .limit(100);
      const payOn = paymentsReady(s) && !!config.publicUrl;
      const todayIso = new Date().toISOString().slice(0, 10);
      const lines: string[] = [];
      for (const i of rows) {
        const open = i.status === "ISSUED" ? i.totalGross - i.paidTotal : 0;
        const st = INV_STATE[i.status];
        const overdue = i.status === "ISSUED" && !!i.dueDate && i.dueDate < todayIso;
        const pay = payOn && open > 0 ? `${config.publicUrl}/pay/${i.publicToken ?? (await ensureInvoiceToken(i.id))}` : null;
        lines.push(`<tr><td><strong>${esc(i.number)}</strong><br><span class="badge ${overdue ? "bad" : st.cls}">${overdue ? "überfällig" : st.label}</span></td>
<td class="hm">${esc(formatDate(i.issueDate))}</td><td class="hm">${esc(formatDate(i.dueDate))}</td><td class="n hm">${esc(formatMoney(i.totalGross, cur))}</td>
<td class="n">${open > 0 ? `<strong>${esc(formatMoney(open, cur))}</strong>` : "–"}</td>
<td class="n"><a class="btn" href="${base}/invoices/${esc(i.id)}/pdf">PDF</a>${pay ? ` <a class="btn pri" href="${esc(pay)}">Bezahlen</a>` : ""}</td></tr>`);
      }
      const openSum = rows.filter((i) => i.status === "ISSUED").reduce((a, i) => a + i.totalGross - i.paidTotal, 0);
      content = rows.length
        ? `${openSum > 0 ? `<p>Offen: <strong>${esc(formatMoney(openSum, cur))}</strong></p>` : ""}<div class="tw"><table><thead><tr><th>Rechnung</th><th class="hm">Datum</th><th class="hm">Fällig</th><th class="n hm">Betrag</th><th class="n">Offen</th><th></th></tr></thead><tbody>${lines.join("")}</tbody></table></div>`
        : `<p class="empty">Noch keine Rechnungen.</p>`;
    } else if (tab === "quotes") {
      const rows = await db
        .select()
        .from(schema.quotes)
        .where(and(eq(schema.quotes.customerId, c.id), inArray(schema.quotes.status, ["SENT", "ACCEPTED", "DECLINED", "INVOICED"])))
        .orderBy(desc(schema.quotes.issueDate))
        .limit(100);
      content = rows.length
        ? `<div class="tw"><table><thead><tr><th>Angebot</th><th class="hm">Datum</th><th class="hm">Gültig bis</th><th class="n">Summe</th><th></th></tr></thead><tbody>${rows
            .map((q) => {
              const st = QUOTE_STATE[q.status];
              return `<tr><td><strong>${esc(q.number)}</strong>${q.subject ? `<div class="desc">${esc(q.subject)}</div>` : ""}<span class="badge ${st.cls}">${st.label}</span></td>
<td class="hm">${esc(formatDate(q.issueDate))}</td><td class="hm">${esc(formatDate(q.validUntil))}</td><td class="n">${esc(formatMoney(q.totalGross, cur))}</td>
<td class="n">${q.publicToken ? `<a class="btn${q.status === "SENT" ? " pri" : ""}" href="/q/${esc(q.publicToken)}">${q.status === "SENT" ? "Ansehen &amp; annehmen" : "Ansehen"}</a>` : ""}</td></tr>`;
            })
            .join("")}</tbody></table></div>`
        : `<p class="empty">Keine Angebote.</p>`;
    } else if (tab === "tickets") {
      const rows = await db.select().from(schema.tickets).where(eq(schema.tickets.customerId, c.id)).orderBy(desc(schema.tickets.lastMessageAt)).limit(100);
      const list = rows.length
        ? `<div class="tw"><table><thead><tr><th>Anfrage</th><th>Stand</th><th class="hm">Zuletzt</th></tr></thead><tbody>${rows
            .map(
              (t) =>
                `<tr><td><a href="${base}/tickets/${esc(t.id)}"><strong>${esc(t.subject)}</strong></a><div class="desc">${esc(t.number)}</div></td><td><span class="badge ${TICKET_STATE[t.status].cls}">${TICKET_STATE[t.status].label}</span></td><td class="hm">${esc(fmtWhen(t.lastMessageAt))}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<p class="empty">Noch keine Anfragen.</p>`;
      content = `${req.query.sent ? `<div class="state ok">Danke! Ihre Anfrage ist eingegangen.</div>` : ""}${list}
<form onsubmit="event.preventDefault();sendForm(this,location.pathname.replace(/\\/$/,'')+'/tickets',function(){location.href=location.pathname+'?tab=tickets&sent=1'})">
<h2 style="font-size:17px;margin:0">Neue Anfrage</h2>
<label for="subject">Betreff</label><input id="subject" name="subject" required maxlength="200">
${s.tickets.categories.length ? `<label for="category">Thema</label><select id="category" name="category"><option value="">Bitte wählen …</option>${s.tickets.categories.map((x) => `<option>${esc(x)}</option>`).join("")}</select>` : ""}
<label for="text">Ihre Nachricht</label><textarea id="text" name="text" rows="6" required maxlength="20000"></textarea>
${s.tickets.allowAttachments ? `<label for="files">Dateien (optional)</label><input id="files" type="file" multiple class="files">` : ""}
<div class="btns"><button class="ok" type="submit">Anfrage senden</button></div><div class="err" role="alert"></div></form>${FORM_JS}`;
    }
    const nav = tabs.length > 1 ? `<nav class="tabs">${tabs.map(([k, l]) => `<a href="${base}?tab=${k}" class="${k === tab ? "on" : ""}">${l}</a>`).join("")}</nav>` : "";
    const body = `<div class="row"><div><h1>${esc(customerDisplayName(c))}</h1><div class="mut">Kundenbereich bei ${esc(s.company.name)} · Kundennummer ${esc(c.number)}</div></div></div>
${s.portal.introText ? `<p>${nl2br(s.portal.introText)}</p>` : ""}${nav}${content || `<p class="empty">Hier gibt es noch nichts zu sehen.</p>`}${companyFooter(s.company)}`;
    return sendHtml(reply, page(`Kundenbereich – ${s.company.name}`, body, accent));
  });

  app.get<{ Params: { token: string; id: string } }>("/p/:token/invoices/:id/pdf", async (req, reply) => {
    const s = await getSettings();
    const c = s.portal.enabled && s.portal.showInvoices ? await portalCustomer(req.params.token) : null;
    if (!c) throw notFound("Seite");
    const doc = await loadInvoiceDoc(req.params.id);
    if (!doc || doc.invoice.customerId !== c.id || doc.invoice.status === "DRAFT") throw notFound("Rechnung");
    const pdf = await renderInvoicePdf(doc, { payUrl: await pdfPayUrl(doc, s) });
    return reply.header("Content-Type", "application/pdf").header("Content-Disposition", `inline; filename="${invoiceFileBase(doc)}.pdf"`).send(pdf);
  });

  app.get<{ Params: { token: string; id: string } }>("/p/:token/tickets/:id", async (req, reply) => {
    const s = await getSettings();
    const accent = s.invoice.accentColor;
    const c = s.portal.enabled && s.portal.showTickets ? await portalCustomer(req.params.token) : null;
    if (!c) return sendHtml(reply, page("Link ungültig", `<h1>Link ungültig</h1>`, accent), 404);
    const t = (await db.select().from(schema.tickets).where(and(eq(schema.tickets.id, req.params.id), eq(schema.tickets.customerId, c.id))))[0];
    if (!t) return sendHtml(reply, page("Nicht gefunden", `<h1>Anfrage nicht gefunden</h1><p><a href="/p/${esc(req.params.token)}?tab=tickets">Zur Übersicht</a></p>`, accent), 404);
    const msgs = await db
      .select()
      .from(schema.ticketMessages)
      .where(and(eq(schema.ticketMessages.ticketId, t.id), ne(schema.ticketMessages.direction, "NOTE")))
      .orderBy(schema.ticketMessages.createdAt);
    const thread = msgs
      .map(
        (m) => `<div class="msg ${m.direction === "OUT" ? "out" : ""}"><div class="h"><strong>${m.direction === "OUT" ? esc(s.company.name) : "Sie"}</strong><span>${esc(fmtWhen(m.createdAt))}</span></div>
<div class="b">${esc(m.body.replace(/\n*\[Eingegangen über [^\]]+\]\s*$/, ""))}</div></div>`,
      )
      .join("");
    const canReply = s.tickets.portalTickets;
    const body = `<p><a href="/p/${esc(req.params.token)}?tab=tickets">← Alle Anfragen</a></p>
<div class="row"><div><h1>${esc(t.subject)}</h1><div class="mut">${esc(t.number)} · <span class="badge ${TICKET_STATE[t.status].cls}">${TICKET_STATE[t.status].label}</span></div></div></div>
${thread}
${
  canReply
    ? `<form onsubmit="event.preventDefault();sendForm(this,location.pathname+'/reply',function(){location.reload()})">
<label for="text">${t.status === "CLOSED" ? "Noch etwas offen? Schreiben Sie uns – die Anfrage wird wieder geöffnet." : "Antworten"}</label><textarea id="text" name="text" rows="5" required maxlength="20000"></textarea>
${s.tickets.allowAttachments ? `<label for="files">Dateien (optional)</label><input id="files" type="file" multiple class="files">` : ""}
<div class="btns"><button class="ok" type="submit">Senden</button></div><div class="err" role="alert"></div></form>${FORM_JS}`
    : ""
}${companyFooter(s.company)}`;
    return sendHtml(reply, page(`${t.number} – ${s.company.name}`, body, accent));
  });

  const portalTicketInput = z.object({
    subject: z.string().trim().min(2, "Bitte einen Betreff angeben").max(200),
    text: z.string().trim().min(2, "Bitte eine Nachricht schreiben").max(20000),
    category: z.string().trim().max(60).optional(),
    files: z.array(fileInput).max(5).optional(),
  });

  app.post<{ Params: { token: string } }>("/p/:token/tickets", { bodyLimit: 40 * 1024 * 1024 }, async (req) => {
    const s = await getSettings();
    const c = s.portal.enabled && s.portal.showTickets && s.tickets.portalTickets ? await portalCustomer(req.params.token) : null;
    if (!c) throw new HttpError(403, "Anfragen über das Portal sind nicht möglich");
    if (rateLimited(`p:${c.id}`, 10, 60 * 60_000)) throw new HttpError(429, "Zu viele Anfragen – bitte später erneut versuchen");
    const b = parse(portalTicketInput, req.body);
    const ticket = await createTicket(
      {
        fromEmail: (c.email ?? "").toLowerCase() || `kunde-${c.number.toLowerCase()}@portal.invalid`,
        fromName: customerDisplayName(c),
        subject: b.subject,
        text: b.text,
        messageId: `<portal-${newToken()}@kontor.local>`,
        customerId: c.id,
        category: b.category && s.tickets.categories.includes(b.category) ? b.category : undefined,
        via: "Kundenportal",
        files: toFiles(b.files),
      },
      s.tickets,
      req.log,
      !!c.email,
    );
    return { ok: true, number: ticket.number };
  });

  app.post<{ Params: { token: string; id: string } }>("/p/:token/tickets/:id/reply", { bodyLimit: 40 * 1024 * 1024 }, async (req) => {
    const s = await getSettings();
    const c = s.portal.enabled && s.portal.showTickets && s.tickets.portalTickets ? await portalCustomer(req.params.token) : null;
    if (!c) throw new HttpError(403, "Antworten über das Portal sind nicht möglich");
    if (rateLimited(`pr:${c.id}`, 30, 60 * 60_000)) throw new HttpError(429, "Zu viele Nachrichten – bitte später erneut versuchen");
    const t = (await db.select().from(schema.tickets).where(and(eq(schema.tickets.id, req.params.id), eq(schema.tickets.customerId, c.id))))[0];
    if (!t) throw notFound("Anfrage");
    const b = parse(z.object({ text: z.string().trim().min(1, "Bitte eine Nachricht schreiben").max(20000), files: z.array(fileInput).max(5).optional() }), req.body);
    await appendCustomerMessage(
      t.id,
      {
        fromEmail: (c.email ?? t.contactEmail).toLowerCase(),
        fromName: customerDisplayName(c),
        text: b.text,
        messageId: `<portal-${newToken()}@kontor.local>`,
        via: "Kundenportal",
        files: toFiles(b.files),
      },
      s.tickets,
    );
    return { ok: true };
  });

  // ============ Anfrage-Formular für die Website ============
  app.get<{ Querystring: { embed?: string } }>("/form/ticket", async (req, reply) => {
    const s = await getSettings();
    const w = s.webform;
    const accent = s.invoice.accentColor;
    const embed = req.query.embed === "1";
    if (!w.enabled || !s.tickets.portalTickets)
      return sendHtml(
        reply,
        page("Formular nicht verfügbar", `<h1>Formular nicht verfügbar</h1><p class="mut">Bitte schreiben Sie uns eine E-Mail${s.company.email ? ` an <a href="mailto:${esc(s.company.email)}">${esc(s.company.email)}</a>` : ""}.</p>`, accent, { embed }),
        404,
      );
    const body = `<h1>${esc(w.title)}</h1>${w.introText ? `<p class="mut">${nl2br(w.introText)}</p>` : ""}
<div id="ok" class="state ok" hidden></div>
<form id="wf" onsubmit="event.preventDefault();sendForm(this,'/form/ticket',function(j){var o=document.getElementById('ok');o.textContent=j.message;o.hidden=false;document.getElementById('wf').remove();try{parent.postMessage({kontor:'ticket-sent',number:j.number},'*')}catch(e){}})" style="border:0;padding:0;margin:0">
<div class="hp" aria-hidden="true"><label for="website">Website</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
<label for="name">Name</label><input id="name" name="name" autocomplete="name" required maxlength="120">
<label for="email">E-Mail</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="200">
${w.askPhone ? `<label for="phone">Telefon (optional)</label><input id="phone" name="phone" type="tel" autocomplete="tel" maxlength="60">` : ""}
${w.askCategory && s.tickets.categories.length ? `<label for="category">Thema</label><select id="category" name="category"><option value="">Bitte wählen …</option>${s.tickets.categories.map((x) => `<option>${esc(x)}</option>`).join("")}</select>` : ""}
<label for="subject">Betreff</label><input id="subject" name="subject" required maxlength="200">
<label for="text">Nachricht</label><textarea id="text" name="text" rows="6" required maxlength="20000"></textarea>
${w.allowFiles && s.tickets.allowAttachments ? `<label for="files">Dateien (optional)</label><input id="files" type="file" multiple class="files">` : ""}
<div class="btns"><button class="ok" type="submit">Absenden</button></div><div class="err" role="alert"></div>
<p class="mut" style="font-size:12px;margin-top:14px">Ihre Angaben verwenden wir nur zur Bearbeitung Ihrer Anfrage.</p></form>${FORM_JS}
${embed ? `<script>function h(){try{parent.postMessage({kontor:'height',height:document.documentElement.scrollHeight},'*')}catch(e){}}new ResizeObserver(h).observe(document.body);h()</script>` : companyFooter(s.company)}`;
    return sendHtml(reply, page(`${w.title} – ${s.company.name}`, body, accent, { embed }));
  });

  const webformInput = z.object({
    name: z.string().trim().min(2, "Bitte Ihren Namen angeben").max(120),
    email: z.string().trim().toLowerCase().email("Bitte eine gültige E-Mail-Adresse angeben").max(200),
    phone: z.string().trim().max(60).optional(),
    category: z.string().trim().max(60).optional(),
    subject: z.string().trim().min(2, "Bitte einen Betreff angeben").max(200),
    text: z.string().trim().min(5, "Bitte eine Nachricht schreiben").max(20000),
    website: z.string().optional(),
    files: z.array(fileInput).max(5).optional(),
  });

  const originOf = (u: string) => {
    try {
      return new URL(u).origin;
    } catch {
      return "";
    }
  };

  app.post("/form/ticket", { bodyLimit: 40 * 1024 * 1024 }, async (req, reply) => {
    const s = await getSettings();
    const w = s.webform;
    if (!w.enabled || !s.tickets.portalTickets) throw new HttpError(403, "Das Formular ist ausgeschaltet");
    // Fremde Websites nur, wenn freigegeben (das eingebettete iframe hat dieselbe Herkunft wie der Server)
    const origin = req.headers.origin;
    const own = [config.publicUrl, `${req.protocol}://${req.host}`].filter(Boolean).map(originOf);
    if (origin && origin !== "null" && !own.includes(origin) && !w.allowedOrigins.map(originOf).includes(origin)) {
      throw new HttpError(403, "Diese Website darf das Formular nicht verwenden");
    }
    if (rateLimited(`wf:${clientIp(req)}`, 5, 10 * 60_000)) throw new HttpError(429, "Zu viele Anfragen – bitte in ein paar Minuten erneut versuchen");
    const b = parse(webformInput, req.body);
    // Honeypot: Bots füllen das versteckte Feld – so tun, als hätte es geklappt
    if (b.website) return { ok: true, message: w.successText, number: null };
    if (rateLimited(`wfm:${b.email}`, 3, 10 * 60_000)) throw new HttpError(429, "Zu viele Anfragen – bitte in ein paar Minuten erneut versuchen");
    const customer = await findCustomerFor(b.email, s.tickets);
    if (w.onlyCustomers && !customer) return reply.status(403).send({ error: w.nonCustomerText, code: "not_customer" });
    const ticket = await createTicket(
      {
        fromEmail: b.email,
        fromName: b.name,
        subject: b.subject,
        text: b.phone ? `${b.text}\n\nTelefon: ${b.phone}` : b.text,
        messageId: `<form-${newToken()}@kontor.local>`,
        customerId: customer?.id ?? null,
        category: b.category && s.tickets.categories.includes(b.category) ? b.category : undefined,
        via: "Website-Formular",
        files: w.allowFiles ? toFiles(b.files) : [],
      },
      s.tickets,
      req.log,
    );
    return { ok: true, message: w.successText, number: ticket.number };
  });

  // ============ Online bezahlen ============
  app.get<{ Params: { token: string }; Querystring: { session?: string } }>("/pay/:token", async (req, reply) => {
    const s = await getSettings();
    const accent = s.invoice.accentColor;
    const inv = await invoiceByToken(req.params.token);
    if (!inv || inv.status === "DRAFT") return sendHtml(reply, page("Link ungültig", `<h1>Link ungültig</h1><p class="mut">Diese Rechnung wurde nicht gefunden.</p>`, accent), 404);
    let notice = "";
    if (req.query.session && s.payments.stripeSecretKey) {
      try {
        const sess = await fetchSession(s, req.query.session);
        if ((sess.metadata?.invoiceId ?? sess.client_reference_id) === inv.id) {
          const r = await bookSession(sess, req.log);
          notice =
            r === "unpaid"
              ? `<div class="state">Ihre Zahlung wird noch verarbeitet. Sie erhalten eine Bestätigung, sobald sie eingegangen ist.</div>`
              : `<div class="state ok">Vielen Dank – Ihre Zahlung ist eingegangen.</div>`;
        }
      } catch (e) {
        req.log.warn({ err: e instanceof Error ? e.message : String(e) }, "Stripe-Session nicht abrufbar");
      }
    }
    const doc = await loadInvoiceDoc(inv.id);
    if (!doc) throw notFound("Rechnung");
    const fresh = doc.invoice;
    const cur = doc.invoiceSettings.currency;
    const open = fresh.status === "ISSUED" ? fresh.totalGross - fresh.paidTotal : 0;
    const company = doc.company;
    const ref = `${fresh.number}${doc.customer.number ? ` ${doc.customer.number}` : ""}`;
    let options = "";
    if (fresh.status === "CANCELLED") options = `<div class="state bad">Diese Rechnung wurde storniert.</div>`;
    else if (open <= 0) options = notice ? "" : `<div class="state ok">Diese Rechnung ist bezahlt. Vielen Dank!</div>`;
    else {
      const parts: string[] = [];
      if (s.payments.stripeEnabled && s.payments.stripeSecretKey)
        parts.push(`<div class="opt"><h3>Online bezahlen</h3><p class="mut" style="margin:0 0 10px">Karte, Apple Pay, Google Pay und weitere Verfahren – sicher über Stripe.</p>
<button class="ok" id="stripe" type="button">${esc(formatMoney(open, cur))} jetzt bezahlen</button><div class="err" id="serr" role="alert"></div>
<script>document.getElementById("stripe").onclick=async function(){var b=this,e=document.getElementById("serr");b.disabled=true;e.textContent="";
try{var r=await fetch(location.pathname+"/stripe",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});var j=await r.json();if(!r.ok)throw new Error(j.error||"Fehler");location.href=j.url}catch(x){e.textContent=x.message;b.disabled=false}}</script></div>`);
      if (s.payments.paypalMe && cur === "EUR")
        parts.push(`<div class="opt"><h3>PayPal</h3><p class="mut" style="margin:0 0 10px">Bitte geben Sie als Mitteilung die Rechnungsnummer <strong>${esc(fresh.number)}</strong> an.</p>
<a class="btn" href="https://paypal.me/${esc(s.payments.paypalMe)}/${(open / 100).toFixed(2)}EUR" target="_blank" rel="noopener">Mit PayPal bezahlen</a></div>`);
      if (company.iban) {
        const epc = cur === "EUR" ? epcPayload(company, open, ref) : null;
        const qr = epc ? await QRCode.toDataURL(epc, { errorCorrectionLevel: "M", margin: 1, width: 280 }) : null;
        parts.push(`<div class="opt"><h3>Überweisung</h3><div class="qr">${qr ? `<img src="${qr}" alt="GiroCode zum Scannen mit der Banking-App">` : ""}
<div>Empfänger: <strong>${esc(company.name)}</strong><br>IBAN: <span class="mono">${esc(company.iban)}</span>${company.bic ? `<br>BIC: <span class="mono">${esc(company.bic)}</span>` : ""}
<br>Betrag: <strong>${esc(formatMoney(open, cur))}</strong><br>Verwendungszweck: <strong>${esc(ref)}</strong>${qr ? `<div class="mut" style="font-size:13px;margin-top:4px">Code mit der Banking-App scannen – alles ist ausgefüllt.</div>` : ""}</div></div></div>`);
      }
      options = `<div class="pay">${parts.join("")}</div>`;
    }
    const body = `<div class="row"><div><h1>Rechnung ${esc(fresh.number)}</h1><div class="mut">${esc(company.name)} für ${esc(customerDisplayName(doc.customer))}</div></div>
<div class="mut" style="text-align:right">Datum ${esc(formatDate(fresh.issueDate))}${fresh.dueDate ? `<br>fällig am ${esc(formatDate(fresh.dueDate))}` : ""}</div></div>
<table class="tot" style="margin-top:18px"><tr><td>Rechnungsbetrag</td><td class="n">${esc(formatMoney(fresh.totalGross, cur))}</td></tr>
${fresh.paidTotal ? `<tr><td>Bereits bezahlt</td><td class="n">${esc(formatMoney(fresh.paidTotal, cur))}</td></tr>` : ""}
<tr class="grand"><td>Offen</td><td class="n">${esc(formatMoney(Math.max(0, open), cur))}</td></tr></table>
${notice}${options}
<p><a href="/pay/${esc(req.params.token)}/pdf">Rechnung als PDF</a></p>${companyFooter(company)}`;
    return sendHtml(reply, page(`Rechnung ${fresh.number} – ${company.name}`, body, accent));
  });

  app.get<{ Params: { token: string } }>("/pay/:token/pdf", async (req, reply) => {
    const inv = await invoiceByToken(req.params.token);
    const doc = inv ? await loadInvoiceDoc(inv.id) : null;
    if (!doc || doc.invoice.status === "DRAFT") throw notFound("Rechnung");
    const pdf = await renderInvoicePdf(doc);
    return reply.header("Content-Type", "application/pdf").header("Content-Disposition", `inline; filename="${invoiceFileBase(doc)}.pdf"`).send(pdf);
  });

  app.post<{ Params: { token: string } }>("/pay/:token/stripe", async (req) => {
    const s = await getSettings();
    if (!s.payments.stripeEnabled || !s.payments.stripeSecretKey) throw new HttpError(403, "Online-Zahlung ist nicht eingerichtet");
    if (!config.publicUrl) throw badRequest("Server-Adresse (PUBLIC_URL) fehlt");
    if (rateLimited(`pay:${clientIp(req)}`, 20, 10 * 60_000)) throw new HttpError(429, "Zu viele Versuche – bitte kurz warten");
    const inv = await invoiceByToken(req.params.token);
    if (!inv || inv.status !== "ISSUED" || inv.kind !== "INVOICE" || !inv.publicToken) throw badRequest("Diese Rechnung kann nicht online bezahlt werden");
    const doc = await loadInvoiceDoc(inv.id);
    try {
      const url = await createCheckout(s, { ...inv, publicToken: inv.publicToken }, doc?.customer.email ?? null, s.invoice.currency, s.company.name);
      return { url };
    } catch (e) {
      req.log.error({ err: e instanceof Error ? e.message : String(e) }, "Stripe-Checkout fehlgeschlagen");
      throw badRequest(e instanceof Error ? e.message : "Zahlung konnte nicht gestartet werden");
    }
  });

  // Webhook braucht den unveränderten Body für die Signaturprüfung
  await app.register(async (sub) => {
    sub.removeContentTypeParser("application/json");
    sub.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    sub.post(WEBHOOK_PATH, { bodyLimit: 1024 * 1024 }, async (req, reply) => {
      const s = await getSettings();
      const raw = req.body as Buffer;
      if (!s.payments.stripeWebhookSecret || !verifyStripeSignature(raw, req.headers["stripe-signature"] as string | undefined, s.payments.stripeWebhookSecret)) {
        return reply.status(400).send({ error: "Signatur ungültig" });
      }
      const event = JSON.parse(raw.toString("utf8")) as { type: string; data: { object: StripeSession } };
      if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
        const r = await bookSession(event.data.object, req.log);
        return { received: true, result: r };
      }
      if (event.type === "checkout.session.expired") {
        await db
          .update(schema.onlinePayments)
          .set({ status: "EXPIRED" })
          .where(and(eq(schema.onlinePayments.sessionId, event.data.object.id), eq(schema.onlinePayments.status, "OPEN")));
      }
      return { received: true };
    });
  });
}
