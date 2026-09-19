/**
 * Auswertungen nach Ist-Versteuerung (Zahlungseingang/-ausgang):
 * Einnahmen-Überschuss-Rechnung, Umsatzsteuer-Vorschau, Kleinunternehmer-Grenzen, Journal- und DATEV-Export.
 * Hinweis: Hilfe für die Steuerberatung, ersetzt keine Buchhaltung.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { badRequest, currentUser, today } from "../lib/http.js";
import { getSettings, type Settings } from "../lib/settings.js";

/** § 19 UStG ab 2025: Vorjahr höchstens 25.000 €, laufendes Jahr höchstens 100.000 € (netto) */
export const KU_LIMIT_PREV = 2_500_000;
export const KU_LIMIT_CURRENT = 10_000_000;

interface Line {
  date: string;
  kind: "income" | "expense";
  gross: number;
  net: number;
  tax: number;
  rate: number;
  category: string;
  text: string;
  ref: string | null;
  method: string;
  /** abziehbarer Anteil (Bewirtung 70 %) */
  deductible: number;
}

const r2 = (n: number) => Math.round(n);

/** Einnahmen und Ausgaben im Zeitraum als einheitliche Zeilen (Steuer anteilig aus der Rechnung) */
async function lines(from: string, to: string, s: Settings): Promise<Line[]> {
  const [inc, exp] = await Promise.all([
    db
      .select({ i: schema.incomes, inv: { number: schema.invoices.number, totalGross: schema.invoices.totalGross, taxBreakdown: schema.invoices.taxBreakdown, smallBusiness: schema.invoices.smallBusiness } })
      .from(schema.incomes)
      .leftJoin(schema.invoices, eq(schema.invoices.id, schema.incomes.invoiceId))
      .where(and(gte(schema.incomes.date, from), lte(schema.incomes.date, to)))
      .orderBy(asc(schema.incomes.date)),
    db
      .select({
        date: schema.expenses.date,
        supplier: schema.expenses.supplier,
        description: schema.expenses.description,
        category: schema.expenses.category,
        amountGross: schema.expenses.amountGross,
        taxRate: schema.expenses.taxRate,
        taxAmount: schema.expenses.taxAmount,
        paymentMethod: schema.expenses.paymentMethod,
        invoiceNumber: schema.expenses.invoiceNumber,
      })
      .from(schema.expenses)
      .where(and(gte(schema.expenses.date, from), lte(schema.expenses.date, to)))
      .orderBy(asc(schema.expenses.date)),
  ]);
  const out: Line[] = [];
  for (const { i, inv } of inc) {
    const base = { date: i.date, kind: "income" as const, category: i.category, text: i.description ?? "", ref: inv?.number ?? null, method: i.method, deductible: 100 };
    const breakdown = (inv?.taxBreakdown as { rate: number; net: number; tax: number }[] | null) ?? null;
    if (inv && breakdown?.length && inv.totalGross) {
      // Zahlung anteilig auf die Steuersätze der Rechnung verteilen
      let rest = i.amount;
      breakdown.forEach((b, idx) => {
        const share = idx === breakdown.length - 1 ? rest : r2((i.amount * (b.net + b.tax)) / inv.totalGross);
        rest -= share;
        const tax = b.rate ? r2(share - share / (1 + b.rate / 100)) : 0;
        out.push({ ...base, gross: share, net: share - tax, tax, rate: b.rate });
      });
    } else {
      const rate = inv ? 0 : (i.taxRate ?? (s.invoice.smallBusiness ? 0 : i.category === "Mahngebühren" ? 0 : s.invoice.defaultTaxRate));
      const tax = rate ? r2(i.amount - i.amount / (1 + rate / 100)) : 0;
      out.push({ ...base, gross: i.amount, net: i.amount - tax, tax, rate });
    }
  }
  const ded = new Map(s.expenses.categories.map((c) => [c.name, c.deductible]));
  for (const e of exp) {
    out.push({
      date: e.date,
      kind: "expense",
      gross: e.amountGross,
      net: e.amountGross - e.taxAmount,
      tax: e.taxAmount,
      rate: e.taxRate,
      category: e.category,
      text: [e.supplier, e.description].filter(Boolean).join(" – "),
      ref: e.invoiceNumber,
      method: e.paymentMethod,
      deductible: ded.get(e.category) ?? 100,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function range(q: { from?: string; to?: string; year?: string }) {
  const y = q.year && /^\d{4}$/.test(q.year) ? q.year : today().slice(0, 4);
  const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : `${y}-01-01`;
  const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : `${y}-12-31`;
  if (from > to) throw badRequest("Zeitraum ungültig");
  return { from, to };
}

/** Umsatz für die Kleinunternehmergrenze (Netto-Einnahmen, ohne Mahngebühren) */
async function revenue(year: number, s: Settings) {
  const l = await lines(`${year}-01-01`, `${year}-12-31`, s);
  return l.filter((x) => x.kind === "income" && x.category !== "Mahngebühren").reduce((a, x) => a + x.net, 0);
}

export async function reportRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { from?: string; to?: string; year?: string } }>("/api/reports/summary", async (req) => {
    currentUser(req);
    const s = await getSettings();
    const { from, to } = range(req.query);
    const small = s.invoice.smallBusiness;
    const l = await lines(from, to, s);
    const inc = l.filter((x) => x.kind === "income");
    const exp = l.filter((x) => x.kind === "expense");
    const sum = (xs: Line[], f: (x: Line) => number) => xs.reduce((a, x) => a + f(x), 0);

    const incomeGross = sum(inc, (x) => x.gross);
    const incomeNet = sum(inc, (x) => x.net);
    const vatCollected = small ? 0 : sum(inc, (x) => x.tax);
    // Kleinunternehmer: keine Vorsteuer, Ausgaben zählen brutto
    const expenseDeductible = sum(exp, (x) => r2(((small ? x.gross : x.net) * x.deductible) / 100));
    const inputTax = small ? 0 : sum(exp, (x) => x.tax);
    const profit = (small ? incomeGross : incomeNet) - expenseDeductible;

    // je Monat
    const months = new Map<string, { month: string; income: number; expenses: number; vat: number; inputTax: number }>();
    for (const x of l) {
      const m = x.date.slice(0, 7);
      if (!months.has(m)) months.set(m, { month: m, income: 0, expenses: 0, vat: 0, inputTax: 0 });
      const row = months.get(m)!;
      if (x.kind === "income") {
        row.income += small ? x.gross : x.net;
        row.vat += small ? 0 : x.tax;
      } else {
        row.expenses += r2(((small ? x.gross : x.net) * x.deductible) / 100);
        row.inputTax += small ? 0 : x.tax;
      }
    }
    // Umsatzsteuer je Quartal (Voranmeldung)
    const quarters = [1, 2, 3, 4].map((q) => {
      const ms = [...months.values()].filter((m) => Math.ceil(Number(m.month.slice(5, 7)) / 3) === q);
      const vat = ms.reduce((a, m) => a + m.vat, 0);
      const it = ms.reduce((a, m) => a + m.inputTax, 0);
      return { quarter: q, vat, inputTax: it, payable: vat - it };
    });
    const byRate = new Map<number, { rate: number; net: number; tax: number }>();
    for (const x of inc) {
      if (!byRate.has(x.rate)) byRate.set(x.rate, { rate: x.rate, net: 0, tax: 0 });
      byRate.get(x.rate)!.net += x.net;
      byRate.get(x.rate)!.tax += x.tax;
    }
    const byCategory = new Map<string, { category: string; gross: number; net: number; tax: number; deductible: number; count: number }>();
    for (const x of exp) {
      if (!byCategory.has(x.category)) byCategory.set(x.category, { category: x.category, gross: 0, net: 0, tax: 0, deductible: 0, count: 0 });
      const c = byCategory.get(x.category)!;
      c.gross += x.gross;
      c.net += x.net;
      c.tax += x.tax;
      c.deductible += r2(((small ? x.gross : x.net) * x.deductible) / 100);
      c.count++;
    }
    const incomeByCategory = new Map<string, number>();
    for (const x of inc) incomeByCategory.set(x.category, (incomeByCategory.get(x.category) ?? 0) + (small ? x.gross : x.net));

    // Kleinunternehmergrenzen (immer fürs aktuelle Kalenderjahr)
    const year = Number(today().slice(0, 4));
    const [prev, cur] = await Promise.all([revenue(year - 1, s), revenue(year, s)]);
    const dayOfYear = Math.max(1, Math.round((Date.now() - Date.UTC(year, 0, 1)) / 86_400_000));
    const projected = Math.round((cur / dayOfYear) * 365);

    const openReceivables = (
      await db.select({ total: schema.invoices.totalGross, paid: schema.invoices.paidTotal }).from(schema.invoices).where(and(eq(schema.invoices.status, "ISSUED"), eq(schema.invoices.kind, "INVOICE")))
    ).reduce((a, r) => a + r.total - r.paid, 0);

    return {
      from,
      to,
      smallBusiness: small,
      incomeGross,
      incomeNet,
      vatCollected,
      expensesGross: sum(exp, (x) => x.gross),
      expensesDeductible: expenseDeductible,
      inputTax,
      vatPayable: vatCollected - inputTax,
      profit,
      openReceivables,
      months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
      quarters,
      incomeByRate: [...byRate.values()].sort((a, b) => b.rate - a.rate),
      incomeByCategory: [...incomeByCategory].map(([category, amount]) => ({ category, amount })),
      expensesByCategory: [...byCategory.values()].sort((a, b) => b.gross - a.gross),
      smallBusinessCheck: {
        year,
        previousYear: prev,
        currentYear: cur,
        projected,
        limitPrevious: KU_LIMIT_PREV,
        limitCurrent: KU_LIMIT_CURRENT,
        /** darf die Regelung (weiter) genutzt werden? */
        eligible: prev <= KU_LIMIT_PREV && cur <= KU_LIMIT_CURRENT,
        nextYearEligible: cur <= KU_LIMIT_PREV,
      },
      counts: { incomes: inc.length, expenses: exp.length },
    };
  });

  /** Journal aller Einnahmen und Ausgaben als CSV (Excel, Semikolon) */
  app.get<{ Querystring: { from?: string; to?: string; year?: string } }>("/api/reports/journal.csv", async (req, reply) => {
    currentUser(req);
    const s = await getSettings();
    const { from, to } = range(req.query);
    const l = await lines(from, to, s);
    const money = (c: number) => (c / 100).toFixed(2).replace(".", ",");
    const esc = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows = [
      ["Datum", "Art", "Kategorie", "Text", "Beleg", "Zahlungsart", "Brutto", "Netto", "USt/VSt", "Satz %"].join(";"),
      ...l.map((x) =>
        [
          x.date.split("-").reverse().join("."),
          x.kind === "income" ? "Einnahme" : "Ausgabe",
          esc(x.category),
          esc(x.text),
          esc(x.ref ?? ""),
          esc(x.method),
          money(x.kind === "income" ? x.gross : -x.gross),
          money(x.kind === "income" ? x.net : -x.net),
          money(x.kind === "income" ? x.tax : -x.tax),
          String(x.rate).replace(".", ","),
        ].join(";"),
      ),
    ];
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="Journal_${from}_${to}.csv"`)
      .send(`﻿${rows.join("\r\n")}\r\n`);
  });

  /** DATEV-Buchungsstapel (EXTF 7.0) für die Steuerberatung */
  app.get<{ Querystring: { from?: string; to?: string; year?: string } }>("/api/reports/datev", async (req, reply) => {
    currentUser(req);
    const s = await getSettings();
    const { from, to } = range(req.query);
    const d = s.datev;
    if (!d.consultantNumber || !d.clientNumber) throw badRequest("Für den DATEV-Export Berater- und Mandantennummer unter Einstellungen → Auswertung & DATEV eintragen");
    const skr04 = d.chart === "SKR04";
    const acc = {
      bank: d.bankAccount || (skr04 ? "1800" : "1200"),
      cash: skr04 ? "1600" : "1000",
      r19: d.revenue19 || (skr04 ? "4400" : "8400"),
      r7: d.revenue7 || (skr04 ? "4300" : "8300"),
      r0: d.revenue0 || (skr04 ? "4100" : "8100"),
      small: d.revenueSmall || (skr04 ? "4185" : "8195"),
    };
    const cat = new Map(s.expenses.categories.map((c) => [c.name, (skr04 ? c.skr04 : c.skr03) || (skr04 ? "6300" : "4900")]));
    const small = s.invoice.smallBusiness;
    const l = await lines(from, to, s);
    const money = (c: number) => (Math.abs(c) / 100).toFixed(2).replace(".", ",");
    const txt = (v: string, n = 60) => `"${v.replace(/"/g, "'").replace(/[\r\n]+/g, " ").slice(0, n)}"`;
    const ddmm = (iso: string) => `${iso.slice(8, 10)}${iso.slice(5, 7)}`;
    const now = new Date();
    const stamp = `${now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}000`;
    const header = [
      '"EXTF"', "700", "21", '"Buchungsstapel"', "13", stamp, "", '"RE"', '"Kontor"', '""', d.consultantNumber, d.clientNumber,
      `${from.slice(0, 4)}0101`, String(d.accountLength), from.replace(/-/g, ""), to.replace(/-/g, ""), '"Kontor Export"', '""', "1", "0", "0", '"EUR"',
      "", '""', "", "", `"${skr04 ? "04" : "03"}"`, "", "", '""', '""',
    ].join(";");
    const cols = [
      "Umsatz (ohne Soll/Haben-Kz)", "Soll/Haben-Kennzeichen", "WKZ Umsatz", "Kurs", "Basis-Umsatz", "WKZ Basis-Umsatz", "Konto",
      "Gegenkonto (ohne BU-Schlüssel)", "BU-Schlüssel", "Belegdatum", "Belegfeld 1", "Belegfeld 2", "Skonto", "Buchungstext",
    ].join(";");
    const rows: string[] = [];
    for (const x of l) {
      if (!x.gross) continue;
      const money2 = money(x.gross);
      const sh = x.gross >= 0 ? '"S"' : '"H"';
      const money_ = x.method === "Bar" ? acc.cash : acc.bank;
      if (x.kind === "income") {
        const rev = small ? acc.small : x.rate >= 19 ? acc.r19 : x.rate >= 7 ? acc.r7 : acc.r0;
        // Geldkonto an Erlöskonto (Automatikkonten, daher ohne BU-Schlüssel)
        rows.push([money2, sh, '"EUR"', "", "", "", money_, rev, '""', ddmm(x.date), txt(x.ref ?? "", 36), '""', "", txt(x.text || x.category)].join(";"));
      } else {
        const bu = small ? "" : x.rate >= 19 ? "9" : x.rate >= 7 ? "8" : "";
        rows.push([money2, sh, '"EUR"', "", "", "", cat.get(x.category) ?? acc.r0, money_, `"${bu}"`, ddmm(x.date), txt(x.ref ?? "", 36), '""', "", txt(x.text || x.category)].join(";"));
      }
    }
    const content = [header, cols, ...rows].join("\r\n") + "\r\n";
    return reply
      .header("Content-Type", "text/csv; charset=windows-1252")
      .header("Content-Disposition", `attachment; filename="EXTF_Buchungsstapel_${from}_${to}.csv"`)
      .send(cp1252(content));
  });
}

/** DATEV erwartet ANSI (Windows-1252) */
const CP1252: Record<string, number> = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "–": 0x96, "—": 0x97 };
function cp1252(s: string): Buffer {
  const out = Buffer.alloc(s.length);
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out[n++] = c < 0x80 || (c >= 0xa0 && c <= 0xff) ? c : (CP1252[ch] ?? 0x3f);
  }
  return out.subarray(0, n);
}
