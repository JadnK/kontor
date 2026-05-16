/**
 * Server-Verbindungen.
 *
 * Ein Profil = ein Kontor-Server (eine Firma). Der Client kommt auf drei Wegen an die Adresse:
 *  1. Einladungscode vom Admin (KONTOR1.<base64>) – enthält Adresse + Einmal-Token
 *  2. Adresse von Hand eingeben (kontor.firma.de, 192.168.1.20:8080, https://…)
 *  3. Vorinstallierte kontor.json neben der EXE / in %APPDATA% (Firmen-Rollout)
 *
 * Bei jeder Verbindung wird /.well-known/kontor abgefragt. Die dabei gelieferte instanceId
 * wird im Profil gespeichert; meldet die Adresse später eine andere Instanz, schickt der
 * Client sein Token nicht mit und warnt stattdessen.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

export interface Profile {
  id: string;
  name: string;
  url: string;
  instanceId: string | null;
  email: string | null;
  token: string | null;
  preset?: boolean;
}

export interface Discovery {
  product: "kontor";
  apiVersion: number;
  serverVersion: string;
  instanceId: string;
  name: string;
}

export interface Preset {
  servers: { name: string; url: string }[];
  lockServers?: boolean;
}

const KEY = "kontor.profiles.v1";
const ACTIVE = "kontor.activeProfile";

export const CLIENT_API_VERSION = 1;

export function loadProfiles(): Profile[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Profile[];
  } catch {
    return [];
  }
}

export function saveProfiles(p: Profile[]) {
  localStorage.setItem(KEY, JSON.stringify(p));
}

export function upsertProfile(p: Profile): Profile[] {
  const all = loadProfiles();
  const i = all.findIndex((x) => x.id === p.id);
  if (i >= 0) all[i] = p;
  else all.push(p);
  saveProfiles(all);
  return all;
}

export function removeProfile(id: string): Profile[] {
  const all = loadProfiles().filter((p) => p.id !== id);
  saveProfiles(all);
  if (getActiveId() === id) localStorage.removeItem(ACTIVE);
  return all;
}

export function getActiveId(): string | null {
  return localStorage.getItem(ACTIVE);
}

export function setActiveId(id: string | null) {
  if (id) localStorage.setItem(ACTIVE, id);
  else localStorage.removeItem(ACTIVE);
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Eingabe vereinheitlichen. Ohne Schema wird zuerst https versucht. */
export function normalizeUrl(input: string): { url: string; explicitScheme: boolean } {
  let s = input.trim().replace(/\/+$/, "");
  s = s.replace(/\/api$/, "").replace(/\/\.well-known\/kontor$/, "");
  const explicitScheme = /^https?:\/\//i.test(s);
  if (!explicitScheme) s = `https://${s}`;
  return { url: s.replace(/\/+$/, ""), explicitScheme };
}

async function fetchDiscovery(url: string): Promise<Discovery> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${url}/.well-known/kontor`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`Server antwortet mit Status ${r.status}`);
    const j = (await r.json()) as Discovery;
    if (j.product !== "kontor") throw new Error("Unter dieser Adresse läuft kein Kontor-Server");
    if (j.apiVersion !== CLIENT_API_VERSION) {
      throw new Error(`Server-API v${j.apiVersion} passt nicht zu dieser App (v${CLIENT_API_VERSION}). Bitte App oder Server aktualisieren.`);
    }
    return j;
  } finally {
    clearTimeout(t);
  }
}

/** Probiert die Adresse; bei fehlendem Schema erst https, dann http. */
export async function discover(input: string): Promise<{ url: string; info: Discovery; insecure: boolean }> {
  const { url, explicitScheme } = normalizeUrl(input);
  try {
    const info = await fetchDiscovery(url);
    return { url, info, insecure: url.startsWith("http://") };
  } catch (e) {
    if (explicitScheme) throw friendly(e);
    const httpUrl = url.replace(/^https:/, "http:");
    try {
      const info = await fetchDiscovery(httpUrl);
      return { url: httpUrl, info, insecure: true };
    } catch {
      throw friendly(e);
    }
  }
}

function friendly(e: unknown): Error {
  if (e instanceof Error && e.name === "AbortError") return new Error("Zeitüberschreitung – Server nicht erreichbar");
  if (e instanceof TypeError) return new Error("Server nicht erreichbar. Adresse, Netzwerk und Firewall prüfen.");
  return e instanceof Error ? e : new Error(String(e));
}

export interface InviteData {
  url: string;
  token: string;
  company: string;
}

export function decodeInvite(code: string): InviteData {
  const c = code.trim();
  const m = /^KONTOR1\.([A-Za-z0-9_-]+)$/.exec(c);
  if (!m) throw new Error("Das ist kein gültiger Einladungscode");
  const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
  const json = new TextDecoder().decode(Uint8Array.from(atob(b64 + "===".slice((b64.length + 3) % 4)), (ch) => ch.charCodeAt(0)));
  const d = JSON.parse(json) as { u: string; t: string; n?: string };
  if (!d.u || !d.t) throw new Error("Einladungscode ist unvollständig");
  return { url: d.u, token: d.t, company: d.n ?? "" };
}

export async function readPreset(): Promise<Preset | null> {
  if (!isTauri()) return null;
  try {
    const raw = await invoke<string | null>("read_preset");
    if (!raw) return null;
    const p = JSON.parse(raw) as Preset;
    return Array.isArray(p.servers) ? p : null;
  } catch {
    return null;
  }
}

/** Server aus kontor.json als Profile übernehmen (ohne bestehende zu überschreiben). */
export function applyPreset(preset: Preset): Profile[] {
  const all = loadProfiles();
  for (const s of preset.servers) {
    const { url } = normalizeUrl(s.url);
    if (!all.some((p) => p.url === url)) {
      all.push({ id: newId(), name: s.name || url, url, instanceId: null, email: null, token: null, preset: true });
    }
  }
  saveProfiles(all);
  return all;
}
