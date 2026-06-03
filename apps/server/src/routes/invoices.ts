import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, ilike, or, sql as dsql, type SQL } from "drizzle-orm";
import { db, schema, type Tx } from "../db/index.js";
import type { Discount } from "../db/schema.js";
import { calculate, type CalcDiscount } from "../lib/calc.js";
import { HttpError, addDays, badRequest, currentUser, isoDate, notFound, optStr, parse, today } from "../lib/http.js";
import { getSettings, nextNumber, resolveProfile } from "../lib/settings.js";
import { invoiceFileBase, invoiceVars, loadInvoiceDoc, resolveExemption, snapshotCustomer } from "../lib/invoice-service.js";
import { render } from "../lib/mail.js";
import { renderInvoicePdf } from "../lib/pdf.js";
import { renderXRechnung, xrechnungIssues } from "../lib/xrechnung.js";
import { onInvoiceCancelled, onPayment, sendInvoiceMail } from "../lib/automation.js";
import { pdfPayUrl } from "../lib/portal.js";
import { createDunning, dunningPdf, previewDunning } from "../lib/dunning.js";

export const itemInput = z.object({
  productId: optStr,
  name: z.string().trim().min(1, "Positionsbezeichnung fehlt"),
  description: optStr,
  quantity: z.number().refine((n) => n !== 0, "Menge darf nicht 0 sein"),
  unit: z.string().trim().min(1).default("Stk"),
  unitPriceNet: z.number().int(),
  taxRate: z.number().min(0).max(100),
  discountBps: z.number().int().min(0).max(10000).default(0),
});

const dateOpt = isoDate.nullish().or(z.literal("")).transform((v) => v || null);

const invoiceInput = z.object({
  customerId: z.string().min(1, "Kunde fehlt"),
  issueDate: dateOpt,
  serviceDateFrom: dateOpt,
  serviceDateTo: dateOpt,
  dueDate: dateOpt,
  subject: optStr,
  introText: optStr,
  footerText: optStr,
  notes: optStr,
  discountId: optStr,
  /** undefined = Standard des Kunden, null/"" = Hauptfirma */
  profileId: z.string().trim().nullish(),
  /** Grund für 0 % USt (Code aus Einstellungen → Rechnungen) */
  taxExemption: optStr,
  items: z.array(itemInput).min(1, "Mindestens eine Position"),
});

const paymentInput = z.object({
  date: isoDate,
  amount: z.number().int().positive("Betrag muss größer 0 sein"),
  method: z.string().trim().min(1).default("Überweisung"),
  description: optStr,
  sendConfirmation: z.boolean().default(true),
});

export function discountApplies(d: Discount, customerId: string, onDate: string): string | null {
  if (!d.active) return "Rabatt ist deaktiviert";
  if (d.validFrom && d.validFrom > onDate) return "Rabatt ist noch nicht gültig";
  if (d.validTo && d.validTo < onDate) return "Rabatt ist abgelaufen";
  if (d.scope === "CUSTOMER" && d.customerId !== customerId) return "Rabatt gilt für einen anderen Kunden";
  return null;
}

function toCalcDiscount(d: Discount | null): CalcDiscount | null {
  return d ? { type: d.type, value: d.value, scope: d.scope, productId: d.productId, minOrderNet: d.minOrderNet } : null;
}

export type InvoiceInput = z.infer<typeof invoiceInput>;

export async function writeDraft(
  tx: Tx,
  input: InvoiceInput,
  existingId: string | null,
  userId: string | null,
  origin: { quoteId?: string | null; recurringId?: string | null } = {},
) {
  const s = await getSettings();
  const customer = (await tx.select().from(schema.customers).where(eq(schema.customers.id, input.customerId)))[0];
  if (!customer) throw badRequest("Kunde existiert nicht");
  let discount: Discount | null = null;
  if (input.discountId) {
    discount = (await tx.select().from(schema.discounts).where(eq(schema.discounts.id, input.discountId)))[0] ?? null;
    if (!discount) throw badRequest("Rabatt existiert nicht");
    const why = discountApplies(discount, customer.id, input.issueDate ?? today());
    if (why) throw badRequest(why);
  }
  const profileId = input.profileId !== undefined ? input.profileId || null : (customer.profileId ?? null);
  if (profileId && !s.profiles.list.some((p) => p.id === profileId)) throw badRequest("Unbekanntes Firmenprofil");
  const smallBusiness = resolveProfile(s, profileId).invoice.smallBusiness;
  const items = input.items.map((i) => ({ ...i, taxRate: smallBusiness ? 0 : i.taxRate }));
  const r = calculate(items, toCalcDiscount(discount), smallBusiness);
  const hasZero = !smallBusiness && items.some((i) => i.taxRate === 0);
  if (hasZero && input.taxExemption && !s.invoice.taxExemptions.some((e) => e.code === input.taxExemption)) {
    throw badRequest("Unbekannter Grund für 0 % USt");
  }
  const values = {
    taxExemption: hasZero ? (input.taxExemption ?? s.invoice.defaultExemption) : null,
    taxExemptionText: null,
    customerId: customer.id,
    issueDate: input.issueDate,
    serviceDateFrom: input.serviceDateFrom,
    serviceDateTo: input.serviceDateTo,
    dueDate: input.dueDate,
    subject: input.subject,
    introText: input.introText,
    footerText: input.footerText,
    notes: input.notes,
    discountId: discount?.id ?? null,
    profileId: profileId ?? null,
    smallBusiness,
    subtotalNet: r.subtotalNet,
    discountTotal: r.discountTotal,
    totalNet: r.totalNet,
    taxTotal: r.taxTotal,
    totalGross: r.totalGross,
    taxBreakdown: r.taxBreakdown,
  };
  let id = existingId;
  if (id) {
    await tx.update(schema.invoices).set(values).where(eq(schema.invoices.id, id));
    await tx.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, id));
  } else {
    id = (
      await tx
        .insert(schema.invoices)
        .values({ ...values, createdById: userId, quoteId: origin.quoteId ?? null, recurringId: origin.recurringId ?? null })
        .returning({ id: schema.invoices.id })
    )[0].id;
  }
  await tx.insert(schema.invoiceItems).values(items.map((it, idx) => ({ ...it, invoiceId: id!, position: idx + 1, lineNet: r.lines[idx] })));
  return id;
}

async function getDraft(tx: Tx | typeof db, id: string) {
  const inv = (await tx.select().from(schema.invoices).where(eq(schema.invoices.id, id)))[0];
  if (!inv) throw notFound("Rechnung");
  if (inv.status !== "DRAFT") throw new HttpError(409, "Ausgestellte Rechnungen können nicht mehr geändert werden", "not_draft");
  return inv;
}

async function recalcPaid(tx: Tx, invoiceId: string) {
  const inv = (await tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)))[0];
  if (!inv) return;
  const paid = (
    await tx
      .select({ s: dsql<number>`coalesce(sum(${schema.incomes.amount}), 0)::int` })
      .from(schema.incomes)
      .where(eq(schema.incomes.invoiceId, invoiceId))
  )[0].s;
  let status = inv.status;
  if (inv.status === "ISSUED" && paid >= inv.totalGross) status = "PAID";
  if (inv.status === "PAID" && paid < inv.totalGross) status = "ISSUED";
  await tx.update(schema.invoices).set({ paidTotal: paid, status }).where(eq(schema.invoices.id, invoiceId));
}
export { recalcPaid };

/** Entwurf ausstellen (auch für Abo-Rechnungen und angenommene Angebote) */
export async function issueInvoice(id: string, send: boolean) {
  const s = await getSettings();
  if (!s.company.name) throw badRequest("Bitte zuerst in den Einstellungen die Firmendaten hinterlegen");
  await db.transaction(async (tx) => {
    const inv = await getDraft(tx, id);
    const prof = resolveProfile(s, inv.profileId);
    const customer = (await tx.select().from(schema.customers).where(eq(schema.customers.id, inv.customerId)))[0];
    const discount = inv.discountId ? (await tx.select().from(schema.discounts).where(eq(schema.discounts.id, inv.discountId)))[0] : null;
    const issueDate = inv.issueDate ?? today();
    if (discount) {
      const why = discountApplies(discount, customer.id, issueDate);
      if (why) throw badRequest(why);
    }
    const items = await tx.select({ taxRate: schema.invoiceItems.taxRate }).from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, inv.id));
    const exemption = resolveExemption(inv, items, prof.invoice);
    const number = await nextNumber(tx, prof.numberKey, prof.invoice.numberFormat, new Date(`${issueDate}T12:00:00`));
    await tx
      .update(schema.invoices)
      .set({
        number,
        status: "ISSUED",
        // Pflichthinweis zum Ausstellungszeitpunkt festschreiben
        taxExemption: exemption?.code ?? null,
        taxExemptionText: exemption?.text ?? null,
        issueDate,
        dueDate: inv.dueDate ?? addDays(issueDate, prof.invoice.paymentDays),
        serviceDateFrom: inv.serviceDateFrom ?? issueDate,
        customerSnapshot: snapshotCustomer(customer),
        companySnapshot: prof.company,
        invoiceSnapshot: prof.invoice,
        discountSnapshot: discount ? { name: discount.name, type: discount.type, value: discount.value, code: discount.code } : null,
        footerText: inv.footerText ?? prof.invoice.paymentText,
      })
      .where(eq(schema.invoices.id, inv.id));
  });
  // Platzhalter im Zahlungstext auflösen (braucht die finale Nummer)
  const doc = await loadInvoiceDoc(id);
  if (doc?.invoice.footerText?.includes("{")) {
    await db
      .update(schema.invoices)
      .set({ footerText: render(doc.invoice.footerText, invoiceVars(doc, doc.company.name)) })
      .where(eq(schema.invoices.id, id));
  }
  let mail: { ok: boolean; skipped?: string; error?: string } | null = null;
  if (send && s.automation.sendInvoiceOnIssue) mail = await sendInvoiceMail(id, "invoice");
  return { id, mail };
}

export async function invoiceRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string; q?: string; customerId?: string } }>("/api/invoices", async (req) => {
    currentUser(req);
    const { status, q, customerId } = req.query;
    const conds: (SQL | undefined)[] = [];
    if (status === "OVERDUE") {
      conds.push(eq(schema.invoices.status, "ISSUED"), eq(schema.invoices.kind, "INVOICE"), dsql`${schema.invoices.dueDate} < ${today()}`);
    } else if (status && ["DRAFT", "ISSUED", "PAID", "CANCELLED"].includes(status)) {
      conds.push(eq(schema.invoices.status, status as "DRAFT"));
    }
    if (customerId) conds.push(eq(schema.invoices.customerId, customerId));
    if (q?.trim()) {
      const p = `%${q.trim()}%`;
      conds.push(
        or(ilike(schema.invoices.number, p), ilike(schema.invoices.subject, p), ilike(schema.customers.company, p), ilike(schema.customers.lastName, p)),
      );
    }
    const rows = await db
      .select({
        i: {
          id: schema.invoices.id,
          number: schema.invoices.number,
          kind: schema.invoices.kind,
          status: schema.invoices.status,
          issueDate: schema.invoices.issueDate,
          dueDate: schema.invoices.dueDate,
          subject: schema.invoices.subject,
          totalGross: schema.invoices.totalGross,
          paidTotal: schema.invoices.paidTotal,
          sentAt: schema.invoices.sentAt,
          reminderCount: schema.invoices.reminderCount,
          createdAt: schema.invoices.createdAt,
        },
        customerId: schema.customers.id,
        company: schema.customers.company,
        firstName: schema.customers.firstName,
        lastName: schema.customers.lastName,
        ctype: schema.customers.type,
      })
      .from(schema.invoices)
      .innerJoin(schema.customers, eq(schema.customers.id, schema.invoices.customerId))
      .where(and(...conds))
      .orderBy(desc(schema.invoices.createdAt))
      .limit(500);
    const t = today();
    return rows.map((r) => ({
      ...r.i,
      customerId: r.customerId,
      customerName:
        (r.ctype === "COMPANY" ? r.company : null) || [r.firstName, r.lastName].filter(Boolean).join(" ") || r.company || "",
      overdue: r.i.status === "ISSUED" && r.i.kind === "INVOICE" && !!r.i.dueDate && r.i.dueDate < t,
    }));
  });

  app.get<{ Params: { id: string } }>("/api/invoices/:id", async (req) => {
    currentUser(req);
    const doc = await loadInvoiceDoc(req.params.id);
    if (!doc) throw notFound("Rechnung");
    const [payments, mails, cancelledBy, dunningRows] = await Promise.all([
      db.select().from(schema.incomes).where(eq(schema.incomes.invoiceId, doc.invoice.id)).orderBy(asc(schema.incomes.date)),
      db.select().from(schema.mailLogs).where(eq(schema.mailLogs.invoiceId, doc.invoice.id)).orderBy(desc(schema.mailLogs.createdAt)),
      db.select({ id: schema.invoices.id, number: schema.invoices.number }).from(schema.invoices).where(eq(schema.invoices.cancelsId, doc.invoice.id)),
      db.select().from(schema.dunnings).where(eq(schema.dunnings.invoiceId, doc.invoice.id)).orderBy(asc(schema.dunnings.level)),
    ]);
    return {
      ...doc.invoice,
      items: doc.items,
      customer: doc.customer,
      original: doc.original ? { ...doc.original, id: doc.invoice.cancelsId } : null,
      cancelledBy: cancelledBy[0] ?? null,
      payments,
      mails,
      xrechnungIssues: xrechnungIssues(doc),
      exemption: doc.exemption,
      dunnings: dunningRows,
      nextDunning: await previewDunning(doc.invoice).catch(() => null),
    };
  });

  app.post("/api/invoices", async (req) => {
    const me = currentUser(req);
    const body = parse(invoiceInput, req.body);
    const id = await db.transaction((tx) => writeDraft(tx, body, null, me.id));
    return { id };
  });

  app.put<{ Params: { id: string } }>("/api/invoices/:id", async (req) => {
    const me = currentUser(req);
    const body = parse(invoiceInput, req.body);
    await db.transaction(async (tx) => {
      await getDraft(tx, req.params.id);
      await writeDraft(tx, body, req.params.id, me.id);
    });
    return { id: req.params.id };
  });

  app.delete<{ Params: { id: string } }>("/api/invoices/:id", async (req) => {
    currentUser(req);
    await getDraft(db, req.params.id);
    await db.delete(schema.invoices).where(eq(schema.invoices.id, req.params.id));
    return { ok: true };
  });

  /** Entwurf festschreiben: Nummer vergeben, Daten einfrieren, optional automatisch mailen */
  app.post<{ Params: { id: string } }>("/api/invoices/:id/issue", async (req) => {
    currentUser(req);
    const { send } = parse(z.object({ send: z.boolean().default(true) }), req.body);
    return issueInvoice(req.params.id, send);
  });

  app.post<{ Params: { id: string } }>("/api/invoices/:id/send", async (req) => {
    currentUser(req);
    const { to } = parse(z.object({ to: z.string().email().optional() }), req.body);
    const inv = (await db.select().from(schema.invoices).where(eq(schema.invoices.id, req.params.id)))[0];
    if (!inv) throw notFound("Rechnung");
    if (inv.status === "DRAFT") throw badRequest("Entwürfe können nicht versendet werden – bitte zuerst ausstellen");
    const r = await sendInvoiceMail(inv.id, inv.kind === "CANCELLATION" ? "cancellation" : "invoice", to);
    if (!r.ok) throw badRequest(r.error ?? r.skipped ?? "Versand fehlgeschlagen");
    return r;
  });

  app.post<{ Params: { id: string } }>("/api/invoices/:id/remind", async (req) => {
    currentUser(req);
    const inv = (await db.select().from(schema.invoices).where(eq(schema.invoices.id, req.params.id)))[0];
    if (!inv) throw notFound("Rechnung");
    if (inv.status !== "ISSUED" || inv.kind !== "INVOICE") throw badRequest("Nur offene Rechnungen können erinnert werden");
    const r = await sendInvoiceMail(inv.id, "reminder");
    if (!r.ok) throw badRequest(r.error ?? r.skipped ?? "Versand fehlgeschlagen");
    return r;
  });

  /** Storno: erzeugt eine Stornorechnung mit negativen Beträgen, Original wird CANCELLED */
  app.post<{ Params: { id: string } }>("/api/invoices/:id/cancel", async (req) => {
    const me = currentUser(req);
    const { send } = parse(z.object({ send: z.boolean().default(true) }), req.body);
    const s = await getSettings();
    const stornoId = await db.transaction(async (tx) => {
      const inv = (await tx.select().from(schema.invoices).where(eq(schema.invoices.id, req.params.id)))[0];
      if (!inv) throw notFound("Rechnung");
      if (inv.kind !== "INVOICE" || (inv.status !== "ISSUED" && inv.status !== "PAID")) throw badRequest("Nur ausgestellte Rechnungen können storniert werden");
      const items = await tx.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, inv.id)).orderBy(asc(schema.invoiceItems.position));
      const issueDate = today();
      const number = await nextNumber(tx, "cancellation", s.invoice.cancellationNumberFormat);
      const breakdown = ((inv.taxBreakdown as { rate: number; net: number; tax: number }[] | null) ?? []).map((t) => ({
        rate: t.rate,
        net: -t.net,
        tax: -t.tax,
      }));
      const [storno] = await tx
        .insert(schema.invoices)
        .values({
          number,
          kind: "CANCELLATION",
          status: "ISSUED",
          customerId: inv.customerId,
          customerSnapshot: inv.customerSnapshot,
          // Storno kommt vom selben Absender wie die Rechnung
          companySnapshot: inv.companySnapshot ?? s.company,
          invoiceSnapshot: inv.invoiceSnapshot ?? s.invoice,
          profileId: inv.profileId,
          issueDate,
          serviceDateFrom: inv.serviceDateFrom,
          serviceDateTo: inv.serviceDateTo,
          subject: inv.subject,
          smallBusiness: inv.smallBusiness,
          taxExemption: inv.taxExemption,
          taxExemptionText: inv.taxExemptionText,
          discountSnapshot: inv.discountSnapshot,
          subtotalNet: -inv.subtotalNet,
          discountTotal: -inv.discountTotal,
          totalNet: -inv.totalNet,
          taxTotal: -inv.taxTotal,
          totalGross: -inv.totalGross,
          taxBreakdown: breakdown,
          cancelsId: inv.id,
          createdById: me.id,
        })
        .returning();
      await tx.insert(schema.invoiceItems).values(
        items.map((it) => ({
          invoiceId: storno.id,
          position: it.position,
          productId: it.productId,
          name: it.name,
          description: it.description,
          quantity: -it.quantity,
          unit: it.unit,
          unitPriceNet: it.unitPriceNet,
          taxRate: it.taxRate,
          discountBps: it.discountBps,
          lineNet: -it.lineNet,
        })),
      );
      await tx.update(schema.invoices).set({ status: "CANCELLED" }).where(eq(schema.invoices.id, inv.id));
      return storno.id;
    });
    if (send) void onInvoiceCancelled(stornoId, req.log);
    return { id: stornoId };
  });

  app.post<{ Params: { id: string } }>("/api/invoices/:id/duplicate", async (req) => {
    const me = currentUser(req);
    const doc = await loadInvoiceDoc(req.params.id);
    if (!doc) throw notFound("Rechnung");
    if (doc.invoice.kind !== "INVOICE") throw badRequest("Stornorechnungen können nicht dupliziert werden");
    const id = await db.transaction((tx) =>
      writeDraft(
        tx,
        {
          customerId: doc.invoice.customerId,
          profileId: doc.invoice.profileId,
          issueDate: null,
          serviceDateFrom: null,
          serviceDateTo: null,
          dueDate: null,
          subject: doc.invoice.subject,
          introText: doc.invoice.introText,
          footerText: null,
          notes: doc.invoice.notes,
          discountId: null,
          taxExemption: doc.invoice.smallBusiness ? null : doc.invoice.taxExemption,
          items: doc.items.map((i) => ({
            productId: i.productId,
            name: i.name,
            description: i.description,
            quantity: i.quantity,
            unit: i.unit,
            unitPriceNet: i.unitPriceNet,
            taxRate: i.taxRate,
            discountBps: i.discountBps,
          })),
        },
        null,
        me.id,
      ),
    );
    return { id };
  });

  app.post<{ Params: { id: string } }>("/api/invoices/:id/payments", async (req) => {
    const me = currentUser(req);
    const body = parse(paymentInput, req.body);
    let alreadyPaid = false;
    const income = await db.transaction(async (tx) => {
      const inv = (await tx.select().from(schema.invoices).where(eq(schema.invoices.id, req.params.id)))[0];
      if (!inv) throw notFound("Rechnung");
      if (inv.kind !== "INVOICE" || (inv.status !== "ISSUED" && inv.status !== "PAID")) throw badRequest("Zahlungen nur für ausgestellte Rechnungen");
      alreadyPaid = inv.status === "PAID" || inv.totalGross - inv.paidTotal <= 0;
      const [row] = await tx
        .insert(schema.incomes)
        .values({
          date: body.date,
          amount: body.amount,
          method: body.method,
          category: "Rechnung",
          description: body.description ?? `Zahlung zu ${inv.number}`,
          invoiceId: inv.id,
          customerId: inv.customerId,
          createdById: me.id,
        })
        .returning();
      await recalcPaid(tx, inv.id);
      return row;
    });
    // Für eine bereits bezahlte Rechnung keine zweite Bestätigung (Überzahlung/Doppelerfassung)
    if (body.sendConfirmation && !alreadyPaid) void onPayment(req.params.id, body.amount, req.log);
    return income;
  });

  app.get<{ Params: { id: string } }>("/api/invoices/:id/pdf", async (req, reply) => {
    currentUser(req);
    const doc = await loadInvoiceDoc(req.params.id);
    if (!doc) throw notFound("Rechnung");
    const pdf = await renderInvoicePdf(doc, { payUrl: await pdfPayUrl(doc) });
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="${invoiceFileBase(doc)}.pdf"`)
      .send(pdf);
  });

  /** Nächste Mahnstufe erstellen (und per Mail senden oder nur als PDF für den Postversand) */
  app.post<{ Params: { id: string } }>("/api/invoices/:id/dunning", async (req) => {
    currentUser(req);
    const { send } = parse(z.object({ send: z.boolean().default(true) }), req.body);
    return createDunning(req.params.id, send);
  });

  app.get<{ Params: { id: string } }>("/api/dunnings/:id/pdf", async (req, reply) => {
    currentUser(req);
    const r = await dunningPdf(req.params.id);
    if (!r) throw notFound("Mahnung");
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="${r.filename}"`)
      .send(r.pdf);
  });

  app.get<{ Params: { id: string } }>("/api/invoices/:id/xrechnung", async (req, reply) => {
    currentUser(req);
    const doc = await loadInvoiceDoc(req.params.id);
    if (!doc) throw notFound("Rechnung");
    if (doc.invoice.status === "DRAFT") throw badRequest("E-Rechnung erst nach dem Ausstellen verfügbar");
    return reply
      .header("Content-Type", "application/xml; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${invoiceFileBase(doc)}.xml"`)
      .send(renderXRechnung(doc));
  });
}
