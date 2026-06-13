import nodemailer from "nodemailer";
import { db, schema } from "../db/index.js";
import { getSettings, type Settings } from "./settings.js";

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface MailJob {
  kind: "invoice" | "payment" | "reminder" | "cancellation" | "discount" | "welcome" | "test" | "bank" | "dunning" | "quote" | "recurring" | "ticket" | "portal" | "contract";
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
  invoiceId?: string | null;
  customerId?: string | null;
}

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function toHtml(text: string) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1b1b1b">${escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`)
    .join("")}</div>`;
}

export function createTransport(mail: Settings["mail"]) {
  return nodemailer.createTransport({
    host: mail.host,
    port: mail.port,
    secure: mail.secure,
    auth: mail.user ? { user: mail.user, pass: mail.password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
}

export function mailReady(s: Settings): boolean {
  return s.mail.enabled && !!s.mail.host && !!(s.mail.fromAddress || s.mail.user);
}

/** Versendet eine Mail und protokolliert das Ergebnis. Wirft nie. */
export async function sendMail(job: MailJob): Promise<{ ok: boolean; error?: string }> {
  const s = await getSettings();
  let error: string | undefined;
  if (!mailReady(s)) {
    error = "E-Mail-Versand ist nicht eingerichtet";
  } else {
    try {
      const from = s.mail.fromAddress || s.mail.user;
      await createTransport(s.mail).sendMail({
        from: s.mail.fromName ? { name: s.mail.fromName, address: from } : from,
        to: job.to,
        replyTo: s.mail.replyTo || undefined,
        bcc: s.mail.bcc || undefined,
        subject: job.subject,
        text: job.text,
        html: toHtml(job.text),
        attachments: job.attachments,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  await db.insert(schema.mailLogs).values({
    kind: job.kind,
    to: job.to,
    subject: job.subject,
    status: error ? "FAILED" : "SENT",
    error: error ?? null,
    invoiceId: job.invoiceId ?? null,
    customerId: job.customerId ?? null,
  });
  return error ? { ok: false, error } : { ok: true };
}

export async function verifyMail(): Promise<void> {
  const s = await getSettings();
  if (!s.mail.host) throw new Error("Kein SMTP-Server eingetragen");
  await createTransport(s.mail).verify();
}
