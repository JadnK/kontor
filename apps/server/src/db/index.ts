import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "../config.js";
import * as schema from "./schema.js";

export const sql = postgres(config.databaseUrl, { max: 10, onnotice: () => {} });
export const db = drizzle(sql, { schema });
export type DB = typeof db;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

export async function runMigrations() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/db -> ../../drizzle  |  src/db -> ../../drizzle
  const folder = path.resolve(here, "../../drizzle");
  await migrate(db, { migrationsFolder: folder });
}

export { schema };
