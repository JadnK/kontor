import type { FastifyInstance, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { and, count, eq, gt, isNull, ne } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";
import { hashToken, randomToken, safeEqual } from "../lib/crypto.js";
import { HttpError, badRequest, currentUser, notFound, parse, requireAdmin, type AuthUser } from "../lib/http.js";
import { getSettings, putSection } from "../lib/settings.js";

const password = z.string().min(10, "Passwort muss mindestens 10 Zeichen haben").max(200);
const email = z.string().trim().toLowerCase().email("Ungültige E-Mail-Adresse");

function publicBase(req: FastifyRequest): string {
  if (config.publicUrl) return config.publicUrl;
  return `${req.protocol}://${req.host}`;
}

export function encodeInviteCode(url: string, token: string, company: string): string {
  const payload = Buffer.from(JSON.stringify({ u: url, t: token, n: company }), "utf8").toString("base64url");
  return `KONTOR1.${payload}`;
}

async function createSession(userId: string, ua?: string) {
  const token = randomToken();
  await db.insert(schema.sessions).values({
    tokenHash: hashToken(token),
    userId,
    userAgent: ua?.slice(0, 200) ?? null,
    expiresAt: new Date(Date.now() + config.sessionDays * 86_400_000),
  });
  return token;
}

/** Bearer-Token prüfen, gleitende Ablaufzeit. Setzt req.user. */
export async function authenticate(req: FastifyRequest): Promise<AuthUser | null> {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  const tokenHash = hashToken(h.slice(7).trim());
  const row = (
    await db
      .select({ s: schema.sessions, u: schema.users })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(and(eq(schema.sessions.tokenHash, tokenHash), gt(schema.sessions.expiresAt, new Date())))
  )[0];
  if (!row || !row.u.active) return null;
  // höchstens einmal pro Stunde verlängern
  if (Date.now() - row.s.lastUsedAt.getTime() > 3_600_000) {
    await db
      .update(schema.sessions)
      .set({ lastUsedAt: new Date(), expiresAt: new Date(Date.now() + config.sessionDays * 86_400_000) })
      .where(eq(schema.sessions.id, row.s.id));
  }
  return { id: row.u.id, email: row.u.email, name: row.u.name, role: row.u.role };
}

async function userCount() {
  return (await db.select({ n: count() }).from(schema.users))[0].n;
}

// einfacher Schutz gegen Passwort-Raten: 10 Fehlversuche / 15 min je IP+Mail
const attempts = new Map<string, { n: number; until: number }>();
function checkRate(key: string) {
  const a = attempts.get(key);
  if (a && a.until > Date.now() && a.n >= 10) throw new HttpError(429, "Zu viele Fehlversuche. Bitte später erneut versuchen.");
}
function fail(key: string) {
  const a = attempts.get(key);
  const until = Date.now() + 15 * 60_000;
  attempts.set(key, { n: a && a.until > Date.now() ? a.n + 1 : 1, until });
}

export async function authRoutes(app: FastifyInstance) {
  // ---------- Ersteinrichtung ----------
  app.get("/api/setup/status", async () => ({ needsSetup: (await userCount()) === 0 }));

  app.post("/api/setup", async (req) => {
    const body = parse(
      z.object({
        setupToken: z.string().trim().min(1, "Einrichtungs-Token fehlt"),
        companyName: z.string().trim().min(1),
        name: z.string().trim().min(1),
        email,
        password,
      }),
      req.body,
    );
    if ((await userCount()) > 0) throw new HttpError(409, "Server ist bereits eingerichtet", "already_setup");
    if (!config.setupToken || !safeEqual(body.setupToken, config.setupToken))throw new HttpError(403, "Einrichtungs-Token ist falsch", "bad_setup_token");
    const [user] = await db
      .insert(schema.users)
      .values({ email: body.email, name: body.name, role: "ADMIN", passwordHash: await bcrypt.hash(body.password, 12) })
      .returning();
    const settings = await getSettings();
    await putSection("company", { ...settings.company, name: body.companyName });
    const token = await createSession(user.id, req.headers["user-agent"]);
    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  // ---------- Login ----------
  app.post("/api/auth/login", async (req) => {
    const body = parse(z.object({ email, password: z.string().min(1) }), req.body);
    const key = `${req.ip}:${body.email}`;
    checkRate(key);
    const user = (await db.select().from(schema.users).where(eq(schema.users.email, body.email)))[0];
    const ok = user && user.active && (await bcrypt.compare(body.password, user.passwordHash));
    if (!ok) {
      fail(key);
      throw new HttpError(401, "E-Mail oder Passwort falsch", "invalid_credentials");
    }
    attempts.delete(key);
    const token = await createSession(user.id, req.headers["user-agent"]);
    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  app.post("/api/auth/logout", async (req) => {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(h.slice(7).trim())));
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => currentUser(req));

  app.post("/api/auth/password", async (req) => {
    const me = currentUser(req);
    const body = parse(z.object({ current: z.string(), next: password }), req.body);
    const user = (await db.select().from(schema.users).where(eq(schema.users.id, me.id)))[0];
    if (!(await bcrypt.compare(body.current, user.passwordHash))) throw badRequest("Aktuelles Passwort ist falsch");
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash(body.next, 12) }).where(eq(schema.users.id, me.id));
    return { ok: true };
  });

  // ---------- Einladungen ----------
  app.post("/api/invites", async (req) => {
    requireAdmin(req);
    const body = parse(z.object({ email, role: z.enum(["ADMIN", "USER"]).default("USER"), days: z.number().int().min(1).max(30).default(7) }), req.body);
    const exists = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, body.email)))[0];
    if (exists) throw badRequest("Für diese E-Mail gibt es bereits einen Benutzer");
    const token = randomToken(24);
    const expiresAt = new Date(Date.now() + body.days * 86_400_000);
    await db.insert(schema.invites).values({ tokenHash: hashToken(token), email: body.email, role: body.role, expiresAt });
    const s = await getSettings();
    return { code: encodeInviteCode(publicBase(req), token, s.company.name), expiresAt };
  });

  app.get("/api/invites", async (req) => {
    requireAdmin(req);
    return db
      .select({ id: schema.invites.id, email: schema.invites.email, role: schema.invites.role, expiresAt: schema.invites.expiresAt, usedAt: schema.invites.usedAt })
      .from(schema.invites)
      .where(and(isNull(schema.invites.usedAt), gt(schema.invites.expiresAt, new Date())));
  });

  app.delete<{ Params: { id: string } }>("/api/invites/:id", async (req) => {
    requireAdmin(req);
    await db.delete(schema.invites).where(eq(schema.invites.id, req.params.id));
    return { ok: true };
  });

  const findInvite = async (token: string) => {
    const inv = (
      await db
        .select()
        .from(schema.invites)
        .where(and(eq(schema.invites.tokenHash, hashToken(token)), isNull(schema.invites.usedAt), gt(schema.invites.expiresAt, new Date())))
    )[0];
    if (!inv) throw new HttpError(404, "Einladung ungültig oder abgelaufen", "invite_invalid");
    return inv;
  };

  app.post("/api/invites/inspect", async (req) => {
    const { token } = parse(z.object({ token: z.string() }), req.body);
    const inv = await findInvite(token);
    return { email: inv.email, role: inv.role, expiresAt: inv.expiresAt };
  });

  app.post("/api/invites/accept", async (req) => {
    const body = parse(z.object({ token: z.string(), name: z.string().trim().min(1), password }), req.body);
    const inv = await findInvite(body.token);
    const user = await db.transaction(async (tx) => {
      await tx.update(schema.invites).set({ usedAt: new Date() }).where(eq(schema.invites.id, inv.id));
      const [u] = await tx
        .insert(schema.users)
        .values({ email: inv.email, name: body.name, role: inv.role, passwordHash: await bcrypt.hash(body.password, 12) })
        .returning();
      return u;
    });
    const token = await createSession(user.id, req.headers["user-agent"]);
    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  // ---------- Benutzerverwaltung ----------
  app.get("/api/users", async (req) => {
    requireAdmin(req);
    return db
      .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, role: schema.users.role, active: schema.users.active, createdAt: schema.users.createdAt })
      .from(schema.users)
      .orderBy(schema.users.name);
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", async (req) => {
    const me = requireAdmin(req);
    const body = parse(z.object({ name: z.string().trim().min(1).optional(), role: z.enum(["ADMIN", "USER"]).optional(), active: z.boolean().optional() }), req.body);
    if (req.params.id === me.id && (body.role === "USER" || body.active === false)) throw badRequest("Eigene Admin-Rechte können nicht entzogen werden");
    if (body.role === "USER" || body.active === false) {
      const admins = (
        await db
          .select({ n: count() })
          .from(schema.users)
          .where(and(eq(schema.users.role, "ADMIN"), eq(schema.users.active, true), ne(schema.users.id, req.params.id)))
      )[0].n;
      if (admins === 0) throw badRequest("Es muss mindestens ein aktiver Administrator bleiben");
    }
    const [u] = await db.update(schema.users).set(body).where(eq(schema.users.id, req.params.id)).returning();
    if (!u) throw notFound("Benutzer");
    if (body.active === false) await db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id));
    return { id: u.id, email: u.email, name: u.name, role: u.role, active: u.active };
  });
}
