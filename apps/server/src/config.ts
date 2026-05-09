import { randomBytes } from "node:crypto";

/** Leere Werte (z. B. `${VAR:-}` aus docker-compose) gelten als nicht gesetzt. */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function required(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Umgebungsvariable ${name} fehlt`);
  return v;
}

const appSecret = env("APP_SECRET") ?? "";
if (appSecret.length < 32) {
  throw new Error("APP_SECRET muss mindestens 32 Zeichen lang sein (z. B. `openssl rand -hex 32`).");
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  appSecret,
  host: env("HOST") ?? "0.0.0.0",
  port: Number(env("PORT") ?? 8080),
  /** Öffentliche Adresse, unter der Clients den Server erreichen. Landet im Einladungscode. */
  publicUrl: (env("PUBLIC_URL") ?? "").replace(/\/+$/, ""),
  /** Einmal-Token für die Ersteinrichtung. Wird generiert und geloggt, wenn nicht gesetzt. */
  setupToken: env("SETUP_TOKEN") ?? randomBytes(12).toString("hex"),
  instanceName: env("INSTANCE_NAME") ?? "",
  sessionDays: Number(env("SESSION_DAYS") ?? 30),
  automationIntervalMinutes: Number(env("AUTOMATION_INTERVAL_MINUTES") ?? 60),
  logLevel: env("LOG_LEVEL") ?? "info",
};

export const SERVER_VERSION = "1.0.0";
export const API_VERSION = 1;
