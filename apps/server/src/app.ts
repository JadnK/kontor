import Fastify from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { config, API_VERSION, SERVER_VERSION } from "./config.js";
import { HttpError, formatZodError } from "./lib/http.js";
import { instanceId } from "./lib/crypto.js";
import { getSettings } from "./lib/settings.js";
import { authRoutes, authenticate } from "./routes/auth.js";
import { customerRoutes } from "./routes/customers.js";
import { productRoutes } from "./routes/products.js";
import { discountRoutes } from "./routes/discounts.js";
import { invoiceRoutes } from "./routes/invoices.js";
import { incomeRoutes } from "./routes/income.js";
import { adminRoutes } from "./routes/admin.js";
import { bankRoutes } from "./routes/bank.js";
import { ticketRoutes } from "./routes/tickets.js";
import { backupRoutes } from "./routes/backup.js";
import { bankSyncRoutes, CALLBACK_PATH } from "./routes/bank-sync.js";
import { quoteRoutes } from "./routes/quotes.js";
import { recurringRoutes } from "./routes/recurring.js";
import { timeRoutes } from "./routes/time.js";
import { expenseRoutes } from "./routes/expenses.js";
import { reportRoutes } from "./routes/reports.js";
import { portalRoutes, PUBLIC_PREFIXES_PORTAL, WEBHOOK_PATH } from "./routes/portal.js";
import { contractRoutes } from "./routes/contracts.js";
import { notifyRoutes } from "./routes/notify.js";

const PUBLIC = new Set([
  "/.well-known/kontor",
  "/api/health",
  "/api/setup/status",
  "/api/setup",
  "/api/auth/login",
  "/api/invites/inspect",
  "/api/invites/accept",
  CALLBACK_PATH,
  WEBHOOK_PATH,
]);

/** Öffentliche Kundenseiten (Angebot annehmen, Kundenportal, Ticket-Formular) */
const PUBLIC_PREFIXES = ["/q/", ...PUBLIC_PREFIXES_PORTAL];
const isPublicPrefix = (p: string) => PUBLIC_PREFIXES.some((x) => p.startsWith(x));

export async function buildApp() {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  // Desktop-Client (Tauri) schickt Bearer-Token, keine Cookies → offenes CORS ist unkritisch
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Kontor-Client"],
    exposedHeaders: ["Content-Disposition"],
    maxAge: 86400,
  });

  // Klassische HTML-Formulare (z. B. eigenes Formular auf der Website)
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.addHook("onRequest", async (req) => {
    if (req.method === "OPTIONS") return;
    const path = req.url.split("?")[0];
    const user = await authenticate(req);
    if (user) req.user = user;
    if (!user && !PUBLIC.has(path) && !isPublicPrefix(path)) throw new HttpError(401, "Nicht angemeldet oder Sitzung abgelaufen", "unauthorized");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: formatZodError(err), code: "validation" });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: err.code });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message ?? "Fehler" });
    req.log.error(err);
    return reply.status(500).send({ error: "Interner Serverfehler", code: "internal" });
  });

  /**
   * Discovery-Endpunkt: Der Client ruft ihn auf, um zu prüfen, ob unter der eingegebenen
   * Adresse wirklich ein Kontor-Server läuft, und merkt sich die instanceId.
   */
  app.get("/.well-known/kontor", async () => {
    const s = await getSettings();
    return {
      product: "kontor",
      apiVersion: API_VERSION,
      serverVersion: SERVER_VERSION,
      instanceId: instanceId(),
      name: config.instanceName || s.company.name || "Kontor",
      apiBase: "/api",
    };
  });

  app.get("/api/health", async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(customerRoutes);
  await app.register(productRoutes);
  await app.register(discountRoutes);
  await app.register(invoiceRoutes);
  await app.register(incomeRoutes);
  await app.register(adminRoutes);
  await app.register(bankRoutes);
  await app.register(ticketRoutes);
  await app.register(backupRoutes);
  await app.register(bankSyncRoutes);
  await app.register(quoteRoutes);
  await app.register(recurringRoutes);
  await app.register(timeRoutes);
  await app.register(expenseRoutes);
  await app.register(reportRoutes);
  await app.register(portalRoutes);
  await app.register(contractRoutes);
  await app.register(notifyRoutes);

  return app;
}
