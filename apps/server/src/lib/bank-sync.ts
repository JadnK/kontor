/**
 * Automatischer Kontoabruf über Enable Banking (PSD2-Kontoinformationsdienst).
 *
 * Ablauf:
 *  1. Admin trägt Application-ID + Private Key aus dem Enable-Banking-Portal ein.
 *  2. "Bank verbinden": POST /auth → Bank-Login im Browser → Rückleitung auf /api/bank/sync/callback
 *     mit ?code=… → POST /sessions liefert session_id + Konten.
 *  3. Der Server ruft regelmäßig GET /accounts/{uid}/transactions ab, übernimmt Gutschriften
 *     in bank_transactions und schickt sie durch denselben Abgleich wie der Datei-Import.
 *  4. Die Bankfreigabe läuft nach max. 180 Tagen ab → Erinnerungsmail vorher, dann neu verbinden.
 */
import { createHash, createSign, randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { db, schema } from "../db/index.js";
import { getSettings, getState, setState, type Settings } from "./settings.js";
import { parseAmount, type ParsedTx } from "./bank-parse.js";
import { runMatching } from "../routes/bank.js";
import { mailReady, sendMail } from "./mail.js";
import { autoBookDebits } from "./expenses.js";
import { addDays, formatDate, today } from "./http.js";

const API = (process.env.EB_API_URL?.trim() || "https://api.enablebanking.com").replace(/\/+$/, "");

export interface SyncAccount {
  uid: string;
  iban: string | null;
  name: string | null;
  currency: string | null;
  enabled: boolean;
}

export interface SyncState {
  sessionId?: string;
  aspsp?: { name: string; country: string };
  psuType?: string;
  validUntil?: string;
  connectedAt?: string;
  accounts?: SyncAccount[];
  /** Erster Abruf ab diesem Datum (JJJJ-MM-TT) */
  syncFrom?: string;
  lastSyncAt?: string;
  lastResult?: { imported: number; matched: number; suggested: number; unmatched: number; fetched: number; alreadyBooked?: number; debits?: number; expensesBooked?: number };
  lastError?: string | null;
  /** validUntil, für das schon eine Erinnerung verschickt wurde */
  reminderSentFor?: string;
  pending?: { state: string; createdAt: string; aspsp: { name: string; country: string }; psuType: string; from: string; redirectUrl: string };
}

export const SYNC_KEY = "bank_sync";
export const loadSync = () => getState<SyncState>(SYNC_KEY, {});
export const saveSync = (s: SyncState) => setState(SYNC_KEY, s);

export class BankSyncError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

// ---------- API-Zugriff ----------

const b64url = (v: Buffer | string) => Buffer.from(v).toString("base64url");

/** Erlaubt auch einzeilige Keys mit "\n" (z. B. aus einer .env kopiert) */
function normalizePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

export function makeJwt(appId: string, privateKeyPem: string, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId }));
  const payload = b64url(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  let sig: Buffer;
  try {
    sig = signer.sign(normalizePem(privateKeyPem));
  } catch {
    throw new BankSyncError("Private Key ist ungültig. Bitte die .pem-Datei aus dem Enable-Banking-Portal hochladen.");
  }
  return `${header}.${payload}.${b64url(sig)}`;
}

function credentials(bank: Settings["bank"]) {
  if (!bank.ebAppId || !bank.ebPrivateKey) throw new BankSyncError("Enable Banking ist nicht eingerichtet (Application-ID und Private Key fehlen)");
  return { appId: bank.ebAppId, key: bank.ebPrivateKey };
}

async function eb<T>(bank: Settings["bank"], method: string, path: string, body?: unknown): Promise<T> {
  const { appId, key } = credentials(bank);
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${makeJwt(appId, key)}`, ...(body ? { "Content-Type": "application/json" } : {}), Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new BankSyncError(`Enable Banking nicht erreichbar: ${e instanceof Error ? e.message : e}`);
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* kein JSON */
  }
  if (!res.ok) {
    const msg = [json.message, typeof json.detail === "string" ? json.detail : null, json.error].filter(Boolean).join(" – ") || text.slice(0, 200);
    if ((res.status === 401 || res.status === 403 || res.status === 422) && /session|consent|expired|revoked/i.test(msg)) {
      throw new BankSyncError(`Die Bankfreigabe ist abgelaufen oder wurde widerrufen – bitte unter Zahlungsabgleich neu verbinden. (${msg})`, res.status);
    }
    if (res.status === 401) throw new BankSyncError(`Enable Banking lehnt die Anmeldung ab (Application-ID oder Private Key falsch): ${msg}`, 401);
    if (res.status === 429) throw new BankSyncError("Die Bank erlaubt gerade keine weiteren Abrufe (meist max. 4 pro Tag ohne Anmeldung). Später erneut versuchen.", 429);
    throw new BankSyncError(`Enable Banking ${res.status}: ${msg}`, res.status);
  }
  return json as T;
}

// ---------- Banken, Verbinden ----------

interface Aspsp {
  name: string;
  country: string;
  logo?: string;
  psu_types?: string[];
  maximum_consent_validity?: number;
  beta?: boolean;
}

export interface BankInfo {
  name: string;
  country: string;
  logo: string | null;
  psuTypes: string[];
  maxDays: number;
  beta: boolean;
}

export async function listBanks(country: string): Promise<BankInfo[]> {
  const bank = (await getSettings()).bank;
  const r = await eb<{ aspsps: Aspsp[] }>(bank, "GET", `/aspsps?country=${encodeURIComponent(country)}&service=AIS`);
  return (r.aspsps ?? [])
    .map((a) => ({
      name: a.name,
      country: a.country,
      logo: a.logo ?? null,
      psuTypes: a.psu_types?.length ? a.psu_types : ["personal"],
      maxDays: a.maximum_consent_validity ? Math.floor(a.maximum_consent_validity / 86400) : 90,
      beta: !!a.beta,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

export async function startAuth(opts: { aspsp: { name: string; country: string }; psuType: string; from: string; redirectUrl: string }) {
  const bank = (await getSettings()).bank;
  const hit = (await listBanks(opts.aspsp.country)).find((b) => b.name === opts.aspsp.name);
  if (!hit) throw new BankSyncError(`Bank „${opts.aspsp.name}“ wird von Enable Banking nicht angeboten`);
  // Freigabe so lang wie die Bank erlaubt (meist 180 Tage), einen Tag Puffer
  const validUntil = new Date(Date.now() + Math.max(1, hit.maxDays - 1) * 86400_000).toISOString();
  const state = randomBytes(16).toString("hex");
  const r = await eb<{ url: string; authorization_id: string }>(bank, "POST", "/auth", {
    access: { valid_until: validUntil },
    aspsp: opts.aspsp,
    state,
    redirect_url: opts.redirectUrl,
    psu_type: opts.psuType,
    language: "de",
  });
  const s = await loadSync();
  s.pending = { state, createdAt: new Date().toISOString(), aspsp: opts.aspsp, psuType: opts.psuType, from: opts.from, redirectUrl: opts.redirectUrl };
  await saveSync(s);
  return { url: r.url };
}

interface EbAccount {
  uid?: string;
  account_id?: { iban?: string; other?: { identification?: string } };
  name?: string;
  details?: string;
  product?: string;
  currency?: string;
}

/** Rückleitung von der Bank: Code gegen Sitzung tauschen */
export async function completeAuth(code: string, state: string, log: FastifyBaseLogger) {
  const s = await loadSync();
  const p = s.pending;
  if (!p || p.state !== state) throw new BankSyncError("Unbekannte oder bereits verwendete Anmeldung. Bitte in Kontor erneut auf „Bank verbinden“ klicken.");
  if (Date.now() - Date.parse(p.createdAt) > 60 * 60_000) throw new BankSyncError("Die Anmeldung ist abgelaufen (älter als 1 Stunde). Bitte erneut verbinden.");
  const bank = (await getSettings()).bank;
  const r = await eb<{ session_id: string; accounts?: EbAccount[]; access?: { valid_until?: string }; aspsp?: { name: string; country: string } }>(
    bank,
    "POST",
    "/sessions",
    { code },
  );
  const accounts: SyncAccount[] = (r.accounts ?? [])
    .filter((a) => a.uid)
    .map((a) => ({
      uid: a.uid!,
      iban: a.account_id?.iban ?? a.account_id?.other?.identification ?? null,
      name: a.name || a.product || a.details || null,
      currency: a.currency ?? null,
      enabled: true,
    }));
  if (!accounts.length) throw new BankSyncError("Die Bank hat keine Konten freigegeben. Beim Bank-Login mindestens ein Konto auswählen.");
  // alte Sitzung schließen
  if (s.sessionId && s.sessionId !== r.session_id) await eb(bank, "DELETE", `/sessions/${s.sessionId}`).catch(() => undefined);
  const sameBank = s.aspsp?.name === p.aspsp.name;
  const next: SyncState = {
    sessionId: r.session_id,
    aspsp: r.aspsp ?? p.aspsp,
    psuType: p.psuType,
    validUntil: r.access?.valid_until,
    connectedAt: new Date().toISOString(),
    accounts,
    syncFrom: p.from,
    // beim Neu-Verbinden derselben Bank nahtlos weitermachen
    lastSyncAt: sameBank ? s.lastSyncAt : undefined,
    lastResult: s.lastResult,
    lastError: null,
  };
  await saveSync(next);
  log.info({ bank: next.aspsp?.name, accounts: accounts.length }, "Bankkonto verbunden");
  return next;
}

export async function disconnect() {
  const s = await loadSync();
  if (s.sessionId) {
    const bank = (await getSettings()).bank;
    await eb(bank, "DELETE", `/sessions/${s.sessionId}`).catch(() => undefined);
  }
  await saveSync({});
}

export async function setAccountEnabled(uid: string, enabled: boolean) {
  const s = await loadSync();
  const acc = s.accounts?.find((a) => a.uid === uid);
  if (!acc) throw new BankSyncError("Konto nicht gefunden");
  acc.enabled = enabled;
  await saveSync(s);
}

// ---------- Abruf ----------

export interface EbTx {
  entry_reference?: string | null;
  transaction_id?: string | null;
  transaction_amount?: { amount: string; currency: string };
  credit_debit_indicator?: "CRDT" | "DBIT";
  status?: string;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  debtor?: { name?: string | null } | null;
  debtor_account?: { iban?: string | null } | null;
  creditor?: { name?: string | null } | null;
  creditor_account?: { iban?: string | null } | null;
  remittance_information?: string[] | null;
  reference_number?: string | null;
}

const clean = (v: string | null | undefined) => {
  const t = (v ?? "").replace(/\s+/g, " ").trim();
  return t || null;
};

/** Enable-Banking-Buchung → interne Form. Nur gebuchte Umsätze; Abbuchungen negativ. */
export function mapTransaction(t: EbTx): ParsedTx | null {
  if (t.status && t.status !== "BOOK") return null;
  const credit = t.credit_debit_indicator === "CRDT";
  if (!credit && t.credit_debit_indicator !== "DBIT") return null;
  const raw = t.transaction_amount?.amount;
  const cents = raw != null ? parseAmount(String(raw)) : null;
  if (cents == null || cents === 0) return null;
  const date = t.booking_date || t.value_date || t.transaction_date;
  if (!date) return null;
  return {
    bookingDate: date.slice(0, 10),
    valueDate: t.value_date ? t.value_date.slice(0, 10) : null,
    amount: credit ? Math.abs(cents) : -Math.abs(cents),
    currency: t.transaction_amount?.currency ?? "EUR",
    counterpartyName: clean(credit ? t.debtor?.name : t.creditor?.name),
    counterpartyIban: clean(credit ? t.debtor_account?.iban : t.creditor_account?.iban)?.replace(/\s/g, "").toUpperCase() ?? null,
    purpose: clean((t.remittance_information ?? []).join(" ")),
    reference: clean(t.reference_number),
  };
}

/** Stabiler Schlüssel je Buchung: ID der Bank, sonst Inhalt + laufende Nummer am selben Tag */
export function syncHashes(accountKey: string, raws: EbTx[], mapped: ParsedTx[]): string[] {
  const seen = new Map<string, number>();
  return mapped.map((m, i) => {
    const id = raws[i].entry_reference || raws[i].transaction_id;
    if (id) return createHash("sha256").update(`eb|${accountKey}|${id}`).digest("hex");
    const key = [m.bookingDate, m.amount, m.counterpartyIban ?? "", (m.purpose ?? "").toUpperCase()].join("|");
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return createHash("sha256").update(`eb|${accountKey}|${key}|${n}`).digest("hex");
  });
}

let busy = false;
export const syncRunning = () => busy;

export async function runSync(log: FastifyBaseLogger) {
  if (busy) throw new BankSyncError("Abruf läuft bereits");
  busy = true;
  try {
    const s = await loadSync();
    if (!s.sessionId || !s.accounts?.length) throw new BankSyncError("Kein Bankkonto verbunden");
    if (s.validUntil && Date.parse(s.validUntil) < Date.now()) {
      throw new BankSyncError("Die Bankfreigabe ist abgelaufen. Bitte unter Zahlungsabgleich → Bankverbindung neu verbinden.");
    }
    const bank = (await getSettings()).bank;
    // überlappend abrufen, damit spät gebuchte Umsätze nicht fehlen; Dubletten verhindert der Hash
    let from = s.lastSyncAt ? addDays(s.lastSyncAt.slice(0, 10), -5) : (s.syncFrom ?? addDays(today(), -30));
    if (s.syncFrom && from < s.syncFrom) from = s.syncFrom;
    const rows: (ParsedTx & { hash: string })[] = [];
    let fetched = 0;
    for (const acc of s.accounts.filter((a) => a.enabled)) {
      const raws: EbTx[] = [];
      let cont: string | undefined;
      let pages = 0;
      do {
        const q = new URLSearchParams({ date_from: from });
        if (cont) q.set("continuation_key", cont);
        const r = await eb<{ transactions?: EbTx[]; continuation_key?: string | null }>(bank, "GET", `/accounts/${encodeURIComponent(acc.uid)}/transactions?${q}`);
        raws.push(...(r.transactions ?? []));
        cont = r.continuation_key || undefined;
      } while (cont && ++pages < 50);
      fetched += raws.length;
      const pairs = raws.map((r) => [r, mapTransaction(r)] as const).filter((x): x is readonly [EbTx, ParsedTx] => !!x[1]);
      const hashes = syncHashes(
        acc.iban ?? acc.uid,
        pairs.map((p) => p[0]),
        pairs.map((p) => p[1]),
      );
      pairs.forEach(([, m], i) => rows.push({ ...m, hash: hashes[i] }));
    }
    const inserted = rows.length
      ? await db
          .insert(schema.bankTransactions)
          .values(rows.map((r) => ({ ...r, source: "API" })))
          .onConflictDoNothing({ target: schema.bankTransactions.hash })
          .returning({ id: schema.bankTransactions.id, amount: schema.bankTransactions.amount })
      : [];
    const credits = inserted.filter((x) => x.amount > 0);
    const m = await runMatching(
      credits.map((x) => x.id),
      log,
    );
    const debits = inserted.filter((x) => x.amount < 0);
    const expensesBooked = await autoBookDebits(
      debits.map((x) => x.id),
      log,
    );
    const result = { fetched, imported: credits.length, debits: debits.length, expensesBooked, ...m };
    await saveSync({ ...(await loadSync()), lastSyncAt: new Date().toISOString(), lastResult: result, lastError: null });
    if (inserted.length) log.info(result, "Kontoabruf: neue Zahlungseingänge");
    return result;
  } catch (e) {
    await saveSync({ ...(await loadSync()), lastError: e instanceof Error ? e.message : String(e) });
    throw e;
  } finally {
    busy = false;
  }
}

// ---------- Erinnerung vor Ablauf ----------

export async function remindIfExpiring(log: FastifyBaseLogger) {
  const st = await getSettings();
  const s = await loadSync();
  const days = st.bank.renewReminderDays;
  if (!days || !s.validUntil || !s.sessionId || s.reminderSentFor === s.validUntil) return false;
  const left = (Date.parse(s.validUntil) - Date.now()) / 86400_000;
  if (left > days) return false;
  const to = st.company.email;
  if (!to || !mailReady(st)) return false;
  const r = await sendMail({
    kind: "bank",
    to,
    subject: `Kontor: Bankfreigabe für ${s.aspsp?.name ?? "dein Konto"} läuft ab`,
    text: [
      "Hallo,",
      "",
      `die Freigabe für den automatischen Kontoabruf (${s.aspsp?.name ?? "Bank"}) läuft am ${formatDate(s.validUntil.slice(0, 10))} ab.`,
      "Danach werden Zahlungseingänge nicht mehr automatisch abgeglichen.",
      "",
      "Zum Verlängern in Kontor unter Zahlungsabgleich → Bankverbindung auf „Neu verbinden“ klicken und den Zugriff bei der Bank bestätigen.",
    ].join("\n"),
  });
  if (r.ok) {
    await saveSync({ ...(await loadSync()), reminderSentFor: s.validUntil });
    log.info("Erinnerung zur Bankfreigabe verschickt");
  }
  return r.ok;
}

export function startBankSync(log: FastifyBaseLogger) {
  let last = 0;
  const tick = async () => {
    try {
      const bank = (await getSettings()).bank;
      if (!bank.syncEnabled || !bank.ebAppId || !bank.ebPrivateKey) return;
      const s = await loadSync();
      if (!s.sessionId) return;
      await remindIfExpiring(log).catch((e) => log.warn(e, "Erinnerung Bankfreigabe fehlgeschlagen"));
      if (s.validUntil && Date.parse(s.validUntil) < Date.now()) return;
      if (Date.now() - last < bank.syncMinutes * 60_000 - 5_000) return;
      last = Date.now();
      await runSync(log);
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : e }, "Kontoabruf fehlgeschlagen");
    }
  };
  setTimeout(tick, 20_000);
  return setInterval(tick, 60_000);
}

export function syncPublic(s: SyncState, bank: Settings["bank"], redirectUrl: string) {
  const daysLeft = s.validUntil ? Math.floor((Date.parse(s.validUntil) - Date.now()) / 86400_000) : null;
  return {
    configured: !!(bank.ebAppId && bank.ebPrivateKey),
    enabled: bank.syncEnabled,
    connected: !!s.sessionId,
    bank: s.aspsp ?? null,
    accounts: s.accounts ?? [],
    validUntil: s.validUntil ?? null,
    daysLeft,
    connectedAt: s.connectedAt ?? null,
    syncFrom: s.syncFrom ?? null,
    lastSyncAt: s.lastSyncAt ?? null,
    lastResult: s.lastResult ?? null,
    lastError: s.lastError ?? null,
    redirectUrl,
    running: busy,
  };
}
