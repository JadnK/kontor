import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, ilike, or } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { HttpError, currentUser, notFound, optStr, parse } from "../lib/http.js";

const productInput = z.object({
  sku: optStr,
  name: z.string().trim().min(1, "Bezeichnung fehlt"),
  description: optStr,
  unit: z.string().trim().min(1).default("Stk"),
  priceNet: z.number().int(),
  taxRate: z.number().min(0).max(100).default(19),
  active: z.boolean().default(true),
});

function uniqueSku(e: unknown): never {
  if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "23505") {
    throw new HttpError(409, "Artikelnummer ist bereits vergeben", "duplicate_sku");
  }
  throw e;
}

export async function productRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string; all?: string } }>("/api/products", async (req) => {
    currentUser(req);
    const q = req.query.q?.trim();
    return db
      .select()
      .from(schema.products)
      .where(
        and(
          req.query.all === "true" ? undefined : eq(schema.products.active, true),
          q ? or(ilike(schema.products.name, `%${q}%`), ilike(schema.products.sku, `%${q}%`)) : undefined,
        ),
      )
      .orderBy(schema.products.name);
  });

  app.post("/api/products", async (req) => {
    currentUser(req);
    const body = parse(productInput, req.body);
    try {
      return (await db.insert(schema.products).values(body).returning())[0];
    } catch (e) {
      uniqueSku(e);
    }
  });

  app.put<{ Params: { id: string } }>("/api/products/:id", async (req) => {
    currentUser(req);
    const body = parse(productInput, req.body);
    try {
      const [p] = await db.update(schema.products).set(body).where(eq(schema.products.id, req.params.id)).returning();
      if (!p) throw notFound("Produkt");
      return p;
    } catch (e) {
      uniqueSku(e);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/products/:id", async (req) => {
    currentUser(req);
    const used = (await db.select({ id: schema.invoiceItems.id }).from(schema.invoiceItems).where(eq(schema.invoiceItems.productId, req.params.id)).limit(1))[0];
    if (used) {
      await db.update(schema.products).set({ active: false }).where(eq(schema.products.id, req.params.id));
      return { deactivated: true };
    }
    await db.delete(schema.products).where(eq(schema.products.id, req.params.id));
    return { deleted: true };
  });
}
