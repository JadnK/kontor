import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { addDays, badRequest, currentUser, isoDate, parse, requireAdmin, today } from "../lib/http.js";
import { getSettings } from "../lib/settings.js";
import {
  BankSyncError,
  completeAuth,
  disconnect,
  listBanks,
  loadSync,
  runSync,
  setAccountEnabled,
  startAuth,
  syncPublic,
} from "../lib/bank-sync.js";

export const CALLBACK_PATH = "/api/bank/sync/callback";

/** Diese Adresse muss im Enable-Banking-Portal als Redirect-URL eingetragen sein */
export function redirectUrl(req: FastifyRequest): string {
  const base = config.publicUrl || `${req.protocol}://${req.host}`;
  return `${base}${CALLBACK_PATH}`;
}

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BankSyncError) throw badRequest(e.message, "bank_sync");
    throw e;
  }
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, text: string, ok: boolean) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} – Kontor</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--fg:#1b1b19;--mut:#6b6b66;--acc:${ok ? "#1f7a4d" : "#b3261e"}}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--fg:#ecece8;--mut:#a3a39d}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{background:var(--card);max-width:440px;padding:28px 32px;border-radius:10px;border-top:4px solid var(--acc)}
h1{font-size:20px;margin:0 0 8px}p{margin:0;color:var(--mut)}
</style></head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`;
}

export async function bankSyncRoutes(app: FastifyInstance) {
  app.get("/api/bank/sync", async (req) => {
    currentUser(req);
    const bank = (await getSettings()).bank;
    return syncPublic(await loadSync(), bank, redirectUrl(req));
  });

  app.get<{ Querystring: { country?: string } }>("/api/bank/sync/banks", async (req) => {
    requireAdmin(req);
    const country = (req.query.country ?? "DE").toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw badRequest("Ländercode ungültig");
    return wrap(() => listBanks(country));
  });

  app.post("/api/bank/sync/connect", async (req) => {
    requireAdmin(req);
    const body = parse(
      z.object({
        bank: z.string().trim().min(1, "Bank wählen"),
        country: z.string().trim().length(2).default("DE"),
        psuType: z.enum(["personal", "business"]).default("personal"),
        from: isoDate.optional(),
      }),
      req.body,
    );
    const from = body.from ?? addDays(today(), -30);
    if (from > today()) throw badRequest("„Abrufen ab“ liegt in der Zukunft");
    return wrap(() =>
      startAuth({ aspsp: { name: body.bank, country: body.country.toUpperCase() }, psuType: body.psuType, from, redirectUrl: redirectUrl(req) }),
    );
  });

  /** Rückleitung von der Bank (im Browser, ohne Kontor-Anmeldung) */
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(CALLBACK_PATH, async (req, reply) => {
    reply.type("text/html; charset=utf-8");
    const { code, state, error, error_description } = req.query;
    if (error || !code || !state) {
      return page("Verbindung abgebrochen", error_description || error || "Die Bank hat keinen Freigabe-Code zurückgegeben. Bitte in Kontor erneut verbinden.", false);
    }
    try {
      const s = await completeAuth(code, state, req.log);
      void runSync(req.log).catch((e) => req.log.warn({ err: e instanceof Error ? e.message : e }, "Erster Kontoabruf fehlgeschlagen"));
      const n = s.accounts?.length ?? 0;
      return page(
        "Bankkonto verbunden",
        `${s.aspsp?.name ?? "Die Bank"} ist mit Kontor verbunden (${n} ${n === 1 ? "Konto" : "Konten"}). Du kannst dieses Fenster schließen – die Umsätze werden jetzt abgerufen.`,
        true,
      );
    } catch (e) {
      req.log.warn({ err: e instanceof Error ? e.message : e }, "Bankverbindung fehlgeschlagen");
      return page("Verbindung fehlgeschlagen", e instanceof Error ? e.message : String(e), false);
    }
  });

  /** Falls die Rückleitung den Server nicht erreicht: Adresse aus dem Browser in die App kopieren */
  app.post("/api/bank/sync/complete", async (req) => {
    requireAdmin(req);
    const { url } = parse(z.object({ url: z.string().trim().min(1, "Adresse einfügen") }), req.body);
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw badRequest("Das ist keine vollständige Adresse");
    }
    if (u.searchParams.get("error")) throw badRequest(`Die Bank meldet: ${u.searchParams.get("error_description") || u.searchParams.get("error")}`);
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state");
    if (!code || !state) throw badRequest("In der Adresse fehlen code und state");
    await wrap(() => completeAuth(code, state, req.log));
    return wrap(() => runSync(req.log));
  });

  app.post("/api/bank/sync/run", async (req) => {
    currentUser(req);
    return wrap(() => runSync(req.log));
  });

  app.patch<{ Params: { uid: string } }>("/api/bank/sync/accounts/:uid", async (req) => {
    requireAdmin(req);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    await wrap(() => setAccountEnabled(req.params.uid, enabled));
    return { ok: true };
  });

  app.delete("/api/bank/sync", async (req) => {
    requireAdmin(req);
    await disconnect();
    return { ok: true };
  });
}
