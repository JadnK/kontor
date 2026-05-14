/**
 * Notfall-Werkzeug auf dem Server:
 *   docker compose exec server node dist/cli.js reset-password admin@firma.de
 *   docker compose exec server node dist/cli.js list-users
 */
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db, schema, sql } from "./db/index.js";

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "list-users") {
    const users = await db.select({ email: schema.users.email, name: schema.users.name, role: schema.users.role, active: schema.users.active }).from(schema.users);
    console.table(users);
  } else if (cmd === "reset-password" && arg) {
    const pw = randomBytes(9).toString("base64url");
    const [u] = await db
      .update(schema.users)
      .set({ passwordHash: await bcrypt.hash(pw, 12), active: true })
      .where(eq(schema.users.email, arg.toLowerCase()))
      .returning();
    if (!u) {
      console.error(`Kein Benutzer mit E-Mail ${arg}`);
      process.exitCode = 1;
    } else {
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id));
      console.log(`Neues Passwort für ${u.email}: ${pw}`);
    }
  } else {
    console.log("Befehle: list-users | reset-password <email>");
  }
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
