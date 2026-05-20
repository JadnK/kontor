import type { Customer } from "./types";

export function money(cents: number | null | undefined, currency = "EUR"): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format((cents ?? 0) / 100);
}

/** "1.234,5" / "1234.50" / "12" → Cent. null bei ungültiger Eingabe. */
export function parseMoney(input: string): number | null {
  const s = input.replace(/[€\s]/g, "").trim();
  if (!s) return null;
  let norm = s;
  if (s.includes(",")) norm = s.replace(/\./g, "").replace(",", ".");
  const n = Number(norm);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function moneyInput(cents: number | null | undefined): string {
  if (cents == null) return "";
  return (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function parseNumber(input: string): number | null {
  const s = input.trim().replace(/\./g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function num(n: number, digits = 3): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

export function date(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
}

export function todayIso(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function customerName(c: Pick<Customer, "type" | "company" | "firstName" | "lastName"> | null | undefined): string {
  if (!c) return "";
  const person = [c.firstName, c.lastName].filter(Boolean).join(" ");
  if (c.type === "COMPANY") return c.company || person;
  return person || c.company || "";
}

export function percentFromBps(bps: number): string {
  return (bps / 100).toLocaleString("de-DE", { maximumFractionDigits: 2 });
}
