import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";
import { getSettings, type Settings } from "./settings.js";
import { today } from "./http.js";
import type { InvoiceDoc } from "./invoice-service.js";

export const newToken = () => randomBytes(24).toString("base64url");

// ---------- Tokens ----------
export async function ensurePortalToken(customerId: string, renew = false): Promise<string> {
  if (!renew) {
    const c = (await db.select({ t: schema.customers.portalToken }).from(schema.customers).where(eq(schema.customers.id, customerId)))[0];
    if (c?.t) return c.t;
  }
  const t = newToken();
  await db.update(schema.customers).set({ portalToken: t }).where(eq(schema.customers.id, customerId));
  return t;
}

export async function ensureInvoiceToken(invoiceId: string): Promise<string> {
  const t = newToken();
  await db.update(schema.invoices).set({ publicToken: t }).where(and(eq(schema.invoices.id, invoiceId), isNull(schema.invoices.publicToken)));
  const r = (await db.select({ t: schema.invoices.publicToken }).from(schema.invoices).where(eq(schema.invoices.id, invoiceId)))[0];
  return r?.t ?? t;
}

/** Online bezahlen möglich? (Stripe eingerichtet oder PayPal.me) */
export function paymentsReady(s: Settings) {
  return (s.payments.stripeEnabled && !!s.payments.stripeSecretKey) || !!s.payments.paypalMe;
}

/** Zahlungslink zu einer offenen, ausgestellten Rechnung (sonst null) */
export async function payUrlFor(doc: Pick<InvoiceDoc, "invoice">, s?: Settings): Promise<string | null> {
  const st = s ?? (await getSettings());
  const inv = doc.invoice;
  if (!paymentsReady(st) || !config.publicUrl) return null;
  if (inv.kind !== "INVOICE" || inv.status !== "ISSUED" || inv.totalGross - inv.paidTotal <= 0) return null;
  const token = inv.publicToken ?? (await ensureInvoiceToken(inv.id));
  return `${config.publicUrl}/pay/${token}`;
}

/** Zahlungslink für das PDF, wenn eingeschaltet */
export async function pdfPayUrl(doc: Pick<InvoiceDoc, "invoice">, s?: Settings): Promise<string | null> {
  const st = s ?? (await getSettings());
  return st.payments.linkOnPdf ? payUrlFor(doc, st) : null;
}

/**
 * Zusätzliche Platzhalter für Mails: {payLink} {payHint} {portalLink}.
 * Der Portal-Link wird nur erzeugt, wenn die Vorlage ihn wirklich verwendet.
 */
export async function linkVars(doc: Pick<InvoiceDoc, "invoice">, s?: Settings, template = ""): Promise<Record<string, string>> {
  const st = s ?? (await getSettings());
  const pay = await payUrlFor(doc, st);
  let portal = "";
  if (template.includes("{portalLink}") && st.portal.enabled && config.publicUrl) portal = `${config.publicUrl}/p/${await ensurePortalToken(doc.invoice.customerId)}`;
  return { payLink: pay ?? "", payHint: pay ? `Sie können auch bequem online bezahlen:\n${pay}` : "", portalLink: portal };
}

/** Zahlungshinweis an den Mailtext hängen, wenn die Vorlage keinen eigenen Platzhalter hat */
export function withPayHint(text: string, template: string, vars: Record<string, string>, s: Settings) {
  if (!s.payments.linkInMails || !vars.payHint || /\{pay(Link|Hint)\}/.test(template)) return text;
  // vor die Grußformel setzen, falls erkennbar
  const m = /\n\n(Mit freundlichen Grüßen|Viele Grüße|Beste Grüße|Freundliche Grüße)/.exec(text);
  return m ? `${text.slice(0, m.index)}\n\n${vars.payHint}${text.slice(m.index)}` : `${text}\n\n${vars.payHint}`;
}

// ---------- Rate-Limit für öffentliche Formulare ----------
const hits = new Map<string, number[]>();
export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) {
    hits.set(key, list);
    return true;
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return false;
}

// ---------- Stripe ----------
const stripeBase = () => (process.env.STRIPE_API_URL || "https://api.stripe.com").replace(/\/+$/, "");

function form(obj: Record<string, string | number | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== "") p.append(k, String(v));
  return p;
}

async function stripe<T>(key: string, method: "GET" | "POST", path: string, body?: URLSearchParams): Promise<T> {
  const r = await fetch(`${stripeBase()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) throw new Error(j.error?.message ? `Stripe: ${j.error.message}` : `Stripe antwortet mit ${r.status}`);
  return j;
}

export interface StripeSession {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  amount_total: number | null;
  currency: string;
  client_reference_id: string | null;
  metadata?: Record<string, string>;
  payment_method_types?: string[];
}

/** Stripe-Schlüssel prüfen (Kontostand abrufen) */
export async function checkStripe(key: string) {
  const b = await stripe<{ livemode: boolean }>(key, "GET", "/v1/balance");
  return { livemode: b.livemode };
}

export async function createCheckout(
  s: Settings,
  inv: { id: string; number: string | null; totalGross: number; paidTotal: number; publicToken: string },
  customerEmail: string | null,
  currency: string,
  companyName: string,
): Promise<string> {
  const open = inv.totalGross - inv.paidTotal;
  if (open <= 0) throw new Error("Die Rechnung ist bereits bezahlt");
  const base = `${config.publicUrl}/pay/${inv.publicToken}`;
  const sess = await stripe<StripeSession>(
    s.payments.stripeSecretKey,
    "POST",
    "/v1/checkout/sessions",
    form({
      mode: "payment",
      "line_items[0][quantity]": 1,
      "line_items[0][price_data][currency]": currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": open,
      "line_items[0][price_data][product_data][name]": `Rechnung ${inv.number ?? ""}`.trim(),
      "line_items[0][price_data][product_data][description]": companyName || undefined,
      client_reference_id: inv.id,
      "metadata[invoiceId]": inv.id,
      "metadata[invoiceNumber]": inv.number ?? "",
      "payment_intent_data[description]": `Rechnung ${inv.number ?? ""} – ${companyName}`.slice(0, 200),
      customer_email: customerEmail ?? undefined,
      locale: "de",
      success_url: `${base}?session={CHECKOUT_SESSION_ID}`,
      cancel_url: base,
    }),
  );
  if (!sess.url) throw new Error("Stripe hat keine Bezahlseite geliefert");
  await db.insert(schema.onlinePayments).values({ invoiceId: inv.id, sessionId: sess.id, amount: open }).onConflictDoNothing();
  return sess.url;
}

export async function fetchSession(s: Settings, id: string) {
  return stripe<StripeSession>(s.payments.stripeSecretKey, "GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`);
}

/** Webhook-Signatur prüfen (Stripe-Signature: t=…,v1=…) */
export function verifyStripeSignature(raw: Buffer, header: string | undefined, secret: string, toleranceSec = 300): boolean {
  if (!header || !secret) return false;
  const parts = new Map(header.split(",").map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)] as const));
  const t = Number(parts.get("t"));
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${raw.toString("utf8")}`).digest();
  return header
    .split(",")
    .filter((x) => x.startsWith("v1="))
    .some((x) => {
      const sig = Buffer.from(x.slice(3), "hex");
      return sig.length === expected.length && timingSafeEqual(sig, expected);
    });
}

/**
 * Bezahlte Checkout-Session buchen. Idempotent: jede Session wird genau einmal gebucht,
 * egal ob über Webhook oder Rückkehr des Kunden auf die Zahlungsseite.
 */
export async function bookSession(sess: StripeSession, log: FastifyBaseLogger): Promise<"booked" | "already" | "unpaid" | "unknown"> {
  if (sess.payment_status !== "paid" || !sess.amount_total) return "unpaid";
  const invoiceId = sess.metadata?.invoiceId || sess.client_reference_id;
  if (!invoiceId) return "unknown";
  const amount = sess.amount_total;
  const { recalcPaid } = await import("../routes/invoices.js");
  const { onPayment } = await import("./automation.js");
  let wasOpen = false;
  const result = await db.transaction(async (tx) => {
    const inv = (await tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)))[0];
    if (!inv) return "unknown" as const;
    // Session anlegen, falls sie noch fehlt, dann atomar beanspruchen
    await tx.insert(schema.onlinePayments).values({ invoiceId, sessionId: sess.id, amount }).onConflictDoNothing();
    const claimed = await tx
      .update(schema.onlinePayments)
      .set({ status: "PAID", paidAt: new Date(), method: sess.payment_method_types?.[0] ?? null })
      .where(and(eq(schema.onlinePayments.sessionId, sess.id), eq(schema.onlinePayments.status, "OPEN")))
      .returning({ id: schema.onlinePayments.id });
    if (!claimed.length) return "already" as const;
    wasOpen = inv.status === "ISSUED" && inv.totalGross - inv.paidTotal > 0;
    const [income] = await tx
      .insert(schema.incomes)
      .values({
        date: today(),
        amount,
        method: "Online (Stripe)",
        category: "Rechnung",
        description: `Online-Zahlung zu ${inv.number}`,
        invoiceId: inv.id,
        customerId: inv.customerId,
      })
      .returning();
    await tx.update(schema.onlinePayments).set({ incomeId: income.id }).where(eq(schema.onlinePayments.id, claimed[0].id));
    await recalcPaid(tx, inv.id);
    return "booked" as const;
  });
  if (result === "booked") {
    log.info({ invoiceId, amount }, "Online-Zahlung gebucht");
    if (wasOpen) void onPayment(invoiceId, amount, log);
  }
  return result;
}

/** Stripe-Auszahlung im Kontoauszug? */
export function isStripePayout(name: string | null, purpose: string | null) {
  return /\bstripe\b/i.test(`${name ?? ""} ${purpose ?? ""}`);
}
