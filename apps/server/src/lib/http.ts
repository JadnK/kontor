import type { FastifyRequest } from "fastify";
import { z, ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export const notFound = (what = "Eintrag") => new HttpError(404, `${what} nicht gefunden`, "not_found");
export const badRequest = (msg: string, code = "bad_request") => new HttpError(400, msg, code);

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "USER";
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new HttpError(401, "Nicht angemeldet", "unauthorized");
  return req.user;
}

export function requireAdmin(req: FastifyRequest): AuthUser {
  const u = currentUser(req);
  if (u.role !== "ADMIN") throw new HttpError(403, "Nur für Administratoren", "forbidden");
  return u;
}

export function parse<T extends z.ZodTypeAny>(s: T, data: unknown): z.infer<T> {
  return s.parse(data ?? {});
}

export function formatZodError(e: ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "Eingabe"}: ${i.message}`).join("; ");
}

/** Leere Strings aus Formularen als null speichern */
export const optStr = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null));

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum im Format JJJJ-MM-TT");

export function today(): string {
  return toIsoDate(new Date());
}

export function toIsoDate(d: Date): string {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return toIsoDate(d);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}
