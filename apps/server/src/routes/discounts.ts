import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { HttpError, badRequest, currentUser, isoDate, notFound, optStr, parse, today } from "../lib/http.js";
import { onDiscountCreated, sendDiscountNotice } from "../lib/automation.js";

const discountInput = z
  .object({
    name: z.string().trim().min(1, "Name fehlt"),
    code: optStr.transform((v) => (v ? v.toUpperCase() : null)),
    type: z.enum(["PERCENT", "FIXED"]),
    value: z.number().int().positive("Wert muss größer 0 sein"),
    scope: z.enum(["ALL", "CUSTOMER", "PRODUCT"]).default("ALL"),
    customerId: optStr,
    productId: optStr,
    minOrderNet: z.number().int().nonnegative().nullish(),
    validFrom: isoDate.nullish().or(z.literal("")).transform((v) => v || null),
    validTo: isoDate.nullish().or(z.literal("")).transform((v) => v || null),
    active: z.boolean().default(true),
    notify: z.boolean().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.type === "PERCENT" && d.value > 10000) ctx.addIssue({ code: "custom", path: ["value"], message: "Maximal 100 %" });
    if (d.scope === "CUSTOMER" && !d.customerId) ctx.addIssue({ code: "custom", path: ["customerId"], message: "Kunde wählen" });
    if (d.scope === "PRODUCT" && !d.productId) ctx.addIssue({ code: "custom", path: ["productId"], message: "Produkt wählen" });
    if (d.validFrom && d.validTo && d.validFrom > d.validTo) ctx.addIssue({ code: "custom", path: ["validTo"], message: "Ende liegt vor Beginn" });
  });

function clean(d: z.infer<typeof discountInput>) {
  const { notify: _n, ...rest } = d;
  return {
    ...rest,
    customerId: d.scope === "CUSTOMER" ? d.customerId : null,
    productId: d.scope === "PRODUCT" ? d.productId : null,
  };
}

function uniqueCode(e: unknown): never {
  if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "23505") {
    throw new HttpError(409, "Rabattcode ist bereits vergeben", "duplicate_code");
  }
  throw e;
}

export async function discountRoutes(app: FastifyInstance) {
  app.get("/api/discounts", async (req) => {
    currentUser(req);
    const rows = await db
      .select({
        d: schema.discounts,
        customerName: schema.customers.company,
        customerFirst: schema.customers.firstName,
        customerLast: schema.customers.lastName,
        productName: schema.products.name,
      })
      .from(schema.discounts)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.discounts.customerId))
      .leftJoin(schema.products, eq(schema.products.id, schema.discounts.productId))
      .orderBy(desc(schema.discounts.createdAt));
    return rows.map((r) => ({
      ...r.d,
      customerName: r.customerName || [r.customerFirst, r.customerLast].filter(Boolean).join(" ") || null,
      productName: r.productName,
    }));
  });

  /** Rabatte, die für einen Kunden heute anwendbar sind */
  app.get<{ Querystring: { customerId?: string; code?: string } }>("/api/discounts/applicable", async (req) => {
    currentUser(req);
    const t = today();
    const scopeCond = req.query.customerId
      ? or(eq(schema.discounts.scope, "ALL"), eq(schema.discounts.scope, "PRODUCT"), eq(schema.discounts.customerId, req.query.customerId))
      : or(eq(schema.discounts.scope, "ALL"), eq(schema.discounts.scope, "PRODUCT"));
    return db
      .select()
      .from(schema.discounts)
      .where(
        and(
          eq(schema.discounts.active, true),
          or(isNull(schema.discounts.validFrom), lte(schema.discounts.validFrom, t)),
          or(isNull(schema.discounts.validTo), gte(schema.discounts.validTo, t)),
          req.query.code ? eq(schema.discounts.code, req.query.code.toUpperCase()) : scopeCond,
        ),
      );
  });

  app.post("/api/discounts", async (req) => {
    currentUser(req);
    const body = parse(discountInput, req.body);
    let d;
    try {
      d = (await db.insert(schema.discounts).values(clean(body)).returning())[0];
    } catch (e) {
      uniqueCode(e);
    }
    if (d.scope === "CUSTOMER" && body.notify !== false) void onDiscountCreated(d.id, req.log);
    return d;
  });

  app.put<{ Params: { id: string } }>("/api/discounts/:id", async (req) => {
    currentUser(req);
    const body = parse(discountInput, req.body);
    try {
      const [d] = await db.update(schema.discounts).set(clean(body)).where(eq(schema.discounts.id, req.params.id)).returning();
      if (!d) throw notFound("Rabatt");
      return d;
    } catch (e) {
      uniqueCode(e);
    }
  });

  app.post<{ Params: { id: string } }>("/api/discounts/:id/notify", async (req) => {
    currentUser(req);
    const r = await sendDiscountNotice(req.params.id);
    if (!r.ok) throw badRequest(r.error ?? r.skipped ?? "Versand nicht möglich");
    return r;
  });

  app.delete<{ Params: { id: string } }>("/api/discounts/:id", async (req) => {
    currentUser(req);
    await db.delete(schema.discounts).where(eq(schema.discounts.id, req.params.id));
    return { ok: true };
  });
}
