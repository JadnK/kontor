import { config } from "./config.js";
import { runMigrations, sql } from "./db/index.js";
import { buildApp } from "./app.js";
import { startScheduler } from "./lib/automation.js";
import { startTicketPoller } from "./lib/tickets.js";
import { startBankSync } from "./lib/bank-sync.js";
import { count } from "drizzle-orm";
import { db, schema } from "./db/index.js";

async function main() {
  await runMigrations();
  const app = await buildApp();

  const users = (await db.select({ n: count() }).from(schema.users))[0].n;
  if (users === 0) {
    app.log.warn("────────────────────────────────────────────────────────");
    app.log.warn("Kontor ist noch nicht eingerichtet.");
    app.log.warn(`Einrichtungs-Token: ${config.setupToken}`);
    app.log.warn("Token in der Desktop-App bei der Ersteinrichtung eingeben.");
    app.log.warn("────────────────────────────────────────────────────────");
  }

  // Hintergrundaufgaben (Mailabruf, Erinnerungen) dürfen den Server nie beenden
  process.on("unhandledRejection", (e) => app.log.error(e, "Unbehandelter Fehler in Hintergrundaufgabe"));

  const timer = startScheduler(app.log, config.automationIntervalMinutes);
  const ticketTimer = startTicketPoller(app.log);
  const bankTimer = startBankSync(app.log);
  await app.listen({ host: config.host, port: config.port });

  const shutdown = async (sig: string) => {
    app.log.info(`${sig} empfangen, fahre herunter`);
    clearInterval(timer);
    clearInterval(ticketTimer);
    clearInterval(bankTimer);
    await app.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
