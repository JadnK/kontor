/**
 * Kontoauszüge einlesen: CAMT.053/.052/.054 (XML), MT940 und CSV der gängigen deutschen Banken.
 * Ergebnis ist eine einheitliche Liste von Buchungen; Beträge in Cent (Eingang positiv).
 */
import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";

export interface ParsedTx {
  bookingDate: string;
  valueDate: string | null;
  amount: number;
  currency: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  purpose: string | null;
  reference: string | null;
}

export interface ParseResult {
  format: "CAMT" | "MT940" | "CSV";
  transactions: ParsedTx[];
}

export class ParseError extends Error {}

// ---------- Hilfen ----------
/* eslint-disable @typescript-eslint/no-explicit-any */
const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "object") return String((v as Record<string, unknown>)["#text"] ?? "");
  return String(v);
};
const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? t : null;
};
const iban = (s: string | null | undefined): string | null => {
  const t = (s ?? "").replace(/\s+/g, "").toUpperCase();
  return /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(t) ? t : null;
};

/** "1.234,56" | "1234.56" | "-12,5" | "1 234,56 €" → Cent */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/[€\s ]|EUR/g, "").trim();
  if (!s) return null;
  let sign = 1;
  if (s.startsWith("-") || s.startsWith("−")) {
    sign = -1;
    s = s.slice(1);
  } else if (s.endsWith("-")) {
    sign = -1;
    s = s.slice(0, -1);
  } else if (s.startsWith("+")) s = s.slice(1);
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  else if (lastComma >= 0 && lastDot > lastComma) s = s.replace(/,/g, "");
  else if (lastDot >= 0 && s.split(".").length > 2) s = s.replace(/\./g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return sign * Math.round(Number(s) * 100);
}

/** "31.12.2026" | "31.12.26" | "2026-12-31" | "20261231" → "2026-12-31" */
export function parseDate(raw: string): string | null {
  const s = raw.trim().slice(0, 10);
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/** Dateiinhalt dekodieren: UTF-8, sonst Windows-1252 (viele Sparkassen-CSV) */
export function decode(buf: Buffer): string {
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    s = new TextDecoder("windows-1252").decode(buf);
  }
  return s.replace(/^﻿/, "");
}

// ---------- CAMT ----------
function parseCamt(xml: string): ParsedTx[] {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", removeNSPrefix: true, parseTagValue: false, trimValues: true });
  const doc = p.parse(xml)?.Document;
  if (!doc) throw new ParseError("XML enthält kein CAMT-Dokument");
  const root = doc.BkToCstmrStmt ?? doc.BkToCstmrAcctRpt ?? doc.BkToCstmrDbtCdtNtfctn;
  if (!root) throw new ParseError("Unbekanntes CAMT-Format (erwartet camt.052, camt.053 oder camt.054)");
  const statements = [...arr(root.Stmt), ...arr(root.Rpt), ...arr(root.Ntfctn)] as any[];
  const out: ParsedTx[] = [];

  for (const st of statements) {
    for (const e of arr(st.Ntry) as any[]) {
      // nur gebuchte Umsätze (camt.052 enthält auch vorgemerkte)
      const sts = text(e.Sts?.Cd ?? e.Sts);
      if (sts && sts !== "BOOK") continue;
      const sign = text(e.CdtDbtInd) === "DBIT" ? -1 : 1;
      const reversal = text(e.RvslInd) === "true" ? -1 : 1;
      const entryAmt = parseAmount(text(e.Amt)) ?? 0;
      const ccy = (e.Amt && typeof e.Amt === "object" ? e.Amt["@Ccy"] : null) ?? "EUR";
      const valueDate = parseDate(text(e.ValDt?.Dt ?? e.ValDt?.DtTm));
      const bookingDate = parseDate(text(e.BookgDt?.Dt ?? e.BookgDt?.DtTm)) ?? valueDate;
      if (!bookingDate) continue;

      const details = (arr(e.NtryDtls) as any[]).flatMap((d) => arr(d.TxDtls)) as any[];
      const split = details.length > 1 && details.every((d) => d.AmtDtls?.TxAmt?.Amt ?? d.Amt);

      const mk = (d: any, amount: number): ParsedTx => {
        const parties = d?.RltdPties ?? {};
        // Bei Eingang interessiert der Zahler, bei Ausgang der Empfänger
        const party = sign > 0 ? (parties.Dbtr ?? parties.UltmtDbtr) : (parties.Cdtr ?? parties.UltmtCdtr);
        const acct = sign > 0 ? parties.DbtrAcct : parties.CdtrAcct;
        const ustrd = arr(d?.RmtInf?.Ustrd).map(text).join(" ");
        const strd = (arr(d?.RmtInf?.Strd) as any[]).map((s) => text(s?.CdtrRefInf?.Ref)).join(" ");
        const e2e = clean(text(d?.Refs?.EndToEndId));
        return {
          bookingDate,
          valueDate,
          amount: reversal * sign * Math.abs(amount),
          currency: String(ccy),
          counterpartyName: clean(text(party?.Nm ?? party?.Pty?.Nm)),
          counterpartyIban: iban(text(acct?.Id?.IBAN)),
          purpose: clean([ustrd, strd].filter(Boolean).join(" ") || text(e.AddtlNtryInf)),
          reference: e2e && e2e !== "NOTPROVIDED" ? e2e : null,
        };
      };

      if (split) {
        for (const d of details) out.push(mk(d, parseAmount(text(d.AmtDtls?.TxAmt?.Amt ?? d.Amt)) ?? 0));
      } else {
        out.push(mk(details[0], entryAmt));
      }
    }
  }
  return out;
}

// ---------- MT940 ----------
function parseMt940(src: string): ParsedTx[] {
  const lines = src.replace(/\r/g, "").split("\n");
  const fields: { tag: string; value: string }[] = [];
  for (const line of lines) {
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
    if (m) fields.push({ tag: m[1], value: m[2] });
    else if (fields.length && line.trim() && line.trim() !== "-") fields[fields.length - 1].value += "\n" + line;
  }
  const out: ParsedTx[] = [];
  let ccy = "EUR";
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.tag === "60F" || f.tag === "60M") ccy = f.value.slice(7, 10) || ccy;
    if (f.tag !== "61") continue;
    const m = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?([\d,]+)/.exec(f.value.replace(/\n/g, ""));
    if (!m) continue;
    const valueDate = parseDate(`20${m[1]}`);
    let bookingDate = valueDate;
    if (m[2] && valueDate) {
      let y = Number(valueDate.slice(0, 4));
      const mm = m[2].slice(0, 2);
      if (mm === "12" && valueDate.slice(5, 7) === "01") y -= 1;
      if (mm === "01" && valueDate.slice(5, 7) === "12") y += 1;
      bookingDate = `${y}-${mm}-${m[2].slice(2, 4)}`;
    }
    const credit = m[3] === "C" || m[3] === "RD";
    const amount = Math.abs(parseAmount(m[5]) ?? 0) * (credit ? 1 : -1);
    let name: string | null = null;
    let acct: string | null = null;
    let purpose: string | null = null;
    let reference: string | null = null;
    const next = fields[i + 1];
    if (next?.tag === "86") {
      const raw = next.value.replace(/\n/g, "");
      if (/\?\d{2}/.test(raw)) {
        const sub: Record<string, string> = {};
        for (const part of raw.split("?").slice(1)) {
          const k = part.slice(0, 2);
          sub[k] = (sub[k] ?? "") + part.slice(2);
        }
        name = clean([sub["32"], sub["33"]].filter(Boolean).join(""));
        acct = iban(sub["31"]);
        const p = ["20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "60", "61", "62", "63"].map((k) => sub[k] ?? "").join("");
        const tags = "(?:EREF|KREF|MREF|CRED|DEBT|ABWA|ABWE|IBAN|BIC|SVWZ)\\+";
        const svwz = new RegExp(`SVWZ\\+(.*?)(?=${tags}|$)`).exec(p);
        const eref = new RegExp(`EREF\\+(.*?)(?=${tags}|$)`).exec(p);
        purpose = clean(svwz ? svwz[1] : p);
        reference = eref && eref[1].trim() !== "NOTPROVIDED" ? clean(eref[1]) : null;
      } else {
        purpose = clean(raw);
      }
    }
    if (bookingDate) out.push({ bookingDate, valueDate, amount, currency: ccy, counterpartyName: name, counterpartyIban: acct, purpose, reference });
  }
  return out;
}

// ---------- CSV ----------
function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const norm = (h: string) =>
  h
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/\*/g, "")
    .replace(/[^a-z0-9/ ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function findCol(headers: string[], tests: RegExp[], exclude?: RegExp): number {
  for (const t of tests) {
    const i = headers.findIndex((h) => t.test(h) && !(exclude && exclude.test(h)));
    if (i >= 0) return i;
  }
  return -1;
}

function parseCsv(src: string): ParsedTx[] {
  const lines = src.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  const sample = lines.slice(0, 30).join("\n");
  const sep = [";", "\t", ","].map((s) => ({ s, n: sample.split(s).length })).sort((a, b) => b.n - a.n)[0].s;

  // Kopfzeile suchen (manche Banken setzen Kontoinfos davor)
  let hi = -1;
  let headers: string[] = [];
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const h = splitCsvLine(lines[i], sep).map(norm);
    const hasDate = h.some((x) => /buchung|datum|date|valuta|wertstellung/.test(x));
    const hasAmount = h.some((x) => /^(betrag|umsatz|amount)/.test(x));
    if (hasDate && hasAmount) {
      hi = i;
      headers = h;
      break;
    }
  }
  if (hi < 0) throw new ParseError("CSV: Kopfzeile mit Datum und Betrag nicht gefunden");

  const cDate = findCol(headers, [/^buchungstag$/, /^buchungsdatum$/, /^buchung$/, /^datum$/, /booking ?date/, /^date$/, /buchung/], /text|art/);
  const cValue = findCol(headers, [/^valuta/, /^wertstellung/, /value ?date/]);
  const cAmount = findCol(headers, [/^betrag$/, /^betrag /, /^betrag/, /^amount/, /^umsatz$/], /saldo|ursprung|original|fremd/);
  const cPurpose = findCol(headers, [/verwendungszweck/, /purpose|reference|beschreibung|buchungsdetails/]);
  const cName = findCol(
    headers,
    [/zahlungspflichtige/, /^auftraggeber/, /name zahlungsbeteiligter/, /beguenstigter\/zahlungspflichtiger/, /auftraggeber\/empfaenger/, /^zahlungsempfaenger$/, /^name$/, /payer|counterparty|empfaenger/],
    /auftragskonto|iban|kto|konto/,
  );
  const cIban = findCol(headers, [/iban zahlungsbeteiligter/, /^iban$/, /kontonummer\/iban/, /zahlungsempfaengeriban/, /iban/], /auftragskonto/);
  const cRef = findCol(headers, [/endtoend|kundenreferenz|^referenz/]);
  const cSH = findCol(headers, [/^soll\/haben$/, /^s\/h$/, /soll\/haben/]);
  const cCcy = findCol(headers, [/^waehrung$/, /^currency$/]);
  if (cDate < 0 || cAmount < 0) throw new ParseError("CSV: Spalten für Datum oder Betrag nicht erkannt");

  const out: ParsedTx[] = [];
  for (const line of lines.slice(hi + 1)) {
    const c = splitCsvLine(line, sep);
    if (c.length < 2) continue;
    const bookingDate = parseDate(c[cDate] ?? "");
    let amount = parseAmount(c[cAmount] ?? "");
    if (!bookingDate || amount == null) continue;
    if (cSH >= 0 && /^s/i.test(c[cSH] ?? "")) amount = -Math.abs(amount);
    out.push({
      bookingDate,
      valueDate: cValue >= 0 ? parseDate(c[cValue] ?? "") : null,
      amount,
      currency: (cCcy >= 0 && /^[A-Z]{3}$/.test(c[cCcy] ?? "") && c[cCcy]) || "EUR",
      counterpartyName: cName >= 0 ? clean(c[cName]) : null,
      counterpartyIban: cIban >= 0 ? iban(c[cIban]) : null,
      purpose: cPurpose >= 0 ? clean(c[cPurpose]) : null,
      reference: cRef >= 0 ? clean(c[cRef]) : null,
    });
  }
  return out;
}

// ---------- Einstieg ----------
export function parseStatement(filename: string, buf: Buffer): ParseResult {
  const src = decode(buf);
  const head = src.slice(0, 4000);
  if (/^\s*(<\?xml|<Document)/i.test(head)) {
    if (!/BkToCstmr/.test(src.slice(0, 20000))) throw new ParseError("XML-Datei ist kein CAMT-Kontoauszug");
    return { format: "CAMT", transactions: parseCamt(src) };
  }
  if (/(^|\n):20:/.test(head) || /:61:\d{6}/.test(head) || /\.(sta|mt940|940)$/i.test(filename)) {
    return { format: "MT940", transactions: parseMt940(src) };
  }
  return { format: "CSV", transactions: parseCsv(src) };
}

/** Stabile Prüfsumme je Buchung; identische Buchungen in derselben Datei werden durchnummeriert. */
export function txHashes(txs: ParsedTx[]): string[] {
  const seen = new Map<string, number>();
  return txs.map((t) => {
    const key = [t.bookingDate, t.amount, t.currency, t.counterpartyIban ?? "", (t.purpose ?? "").toUpperCase(), t.reference ?? ""].join("|");
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return createHash("sha256").update(`${key}|${n}`).digest("hex");
  });
}
