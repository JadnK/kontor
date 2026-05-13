import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

const key = createHash("sha256").update(`kontor:enc:${config.appSecret}`).digest();

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(`${config.appSecret}:${token}`).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** AES-256-GCM, Ausgabe: enc:v1:<iv>.<tag>.<data> (base64url) */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `enc:v1:${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}

export function decrypt(value: string): string {
  if (!value.startsWith("enc:v1:")) return value;
  const [iv, tag, data] = value.slice(7).split(".");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

/** Stabile Kennung der Instanz – Clients merken sie sich, um Server-Verwechslungen zu erkennen. */
export function instanceId(): string {
  return createHash("sha256").update(`kontor:instance:${config.appSecret}`).digest("hex").slice(0, 16);
}
