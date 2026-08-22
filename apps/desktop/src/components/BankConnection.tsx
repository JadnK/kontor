import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useApi, useLoad, useNav, useSession, useToast } from "../lib/store";
import { addDaysIso, date, dateTime, todayIso } from "../lib/format";
import { openExternal } from "../lib/native";
import type { BankInfo, BankSyncStatus } from "../lib/types";
import { Button, Confirm, Field, Modal, SelectField, TextField } from "./ui";
import { Icon } from "./Icon";

const COUNTRIES = [
  { value: "DE", label: "Deutschland" },
  { value: "AT", label: "Österreich" },
  { value: "NL", label: "Niederlande" },
  { value: "FR", label: "Frankreich" },
  { value: "ES", label: "Spanien" },
  { value: "IT", label: "Italien" },
  { value: "BE", label: "Belgien" },
  { value: "LU", label: "Luxemburg" },
];

type Psu = "personal" | "business";

function resultText(r: BankSyncStatus["lastResult"]) {
  if (!r) return "";
  if (!r.imported) return "keine neuen Zahlungseingänge";
  const p = [`${r.imported} neue Zahlungseingänge`];
  if (r.matched) p.push(`${r.matched} gebucht`);
  if (r.suggested) p.push(`${r.suggested} Vorschläge`);
  if (r.alreadyBooked) p.push(`${r.alreadyBooked} doppelt`);
  return p.join(", ");
}

/** Statuszeile + Verwaltung des automatischen Kontoabrufs auf der Seite Zahlungsabgleich */
export function BankConnection({ onSynced }: { onSynced: () => void }) {
  const api = useApi();
  const toast = useToast();
  const { go } = useNav();
  const { user } = useSession();
  const admin = user.role === "ADMIN";
  const { busy, run } = useAction();
  const st = useLoad(() => api.get<BankSyncStatus>("/api/bank/sync"), []);
  const [connect, setConnect] = useState(false);
  const [drop, setDrop] = useState(false);
  const s = st.data;

  if (!s) return null;

  if (!s.configured) {
    if (!admin) return null;
    return (
      <div className="bankconn bankconn-off">
        <Icon name="bank" />
        <div className="bankconn-main">
          <strong>Zahlungen automatisch vom Konto abrufen</strong>
          <span className="muted small">Statt Kontoauszüge hochzuladen, holt Kontor die Umsätze selbst – über Enable Banking (PSD2), z. B. bei N26.</span>
        </div>
        <Button onClick={() => go({ name: "settings", tab: "bank" })}>Einrichten</Button>
      </div>
    );
  }

  const syncNow = () =>
    void run("sync", async () => {
      try {
        const r = await api.post<NonNullable<BankSyncStatus["lastResult"]>>("/api/bank/sync/run");
        toast.ok(`Konto abgerufen: ${resultText(r)}`);
        onSynced();
      } finally {
        st.reload();
      }
    });

  const expired = s.daysLeft != null && s.daysLeft < 0;
  const expiring = !expired && s.daysLeft != null && s.daysLeft <= 14;
  const healthy = s.connected && !expired && !s.lastError;

  return (
    <>
      <div className={`bankconn ${s.connected ? "" : "bankconn-off"}`}>
        <span className={`bankconn-dot ${healthy ? "ok" : s.connected ? "warn" : ""}`} aria-hidden />
        <div className="bankconn-main">
          {s.connected ? (
            <>
              <strong>
                {s.bank?.name} verbunden {!s.enabled ? <span className="badge badge-muted">Automatik aus</span> : null}
              </strong>
              <span className="muted small">
                {s.lastSyncAt ? `Zuletzt abgerufen ${dateTime(s.lastSyncAt)}: ${resultText(s.lastResult)}` : "Noch nicht abgerufen"}
                {s.validUntil ? ` · Freigabe bis ${date(s.validUntil)}` : ""}
                {s.daysLeft != null && s.daysLeft >= 0 ? ` (noch ${s.daysLeft} ${s.daysLeft === 1 ? "Tag" : "Tage"})` : ""}
              </span>
              {s.accounts.length > 1 || (s.accounts.length === 1 && !s.accounts[0].enabled) ? (
                <div className="bankconn-accounts">
                  {s.accounts.map((a) => (
                    <label key={a.uid} className="inline-check">
                      <input
                        type="checkbox"
                        checked={a.enabled}
                        disabled={!admin}
                        onChange={(e) =>
                          void run(`acc${a.uid}`, async () => {
                            await api.patch(`/api/bank/sync/accounts/${encodeURIComponent(a.uid)}`, { enabled: e.target.checked });
                            st.reload();
                          })
                        }
                      />
                      {a.name ?? "Konto"} <span className="mono muted">{a.iban ?? ""}</span>
                    </label>
                  ))}
                </div>
              ) : s.accounts[0] ? (
                <span className="mono muted small">{s.accounts[0].iban}</span>
              ) : null}
            </>
          ) : (
            <>
              <strong>Kein Bankkonto verbunden</strong>
              <span className="muted small">Einmal verbinden, danach ruft Kontor Zahlungseingänge {s.enabled ? "automatisch" : "auf Knopfdruck"} ab.</span>
            </>
          )}
        </div>
        <div className="bankconn-actions">
          {s.connected && !expired ? (
            <Button busy={busy === "sync" || s.running} onClick={syncNow}>
              <Icon name="refresh" /> Jetzt abrufen
            </Button>
          ) : null}
          {admin ? (
            <Button variant={s.connected && !expired && !expiring ? "ghost" : "primary"} onClick={() => setConnect(true)}>
              {s.connected ? "Neu verbinden" : "Bank verbinden"}
            </Button>
          ) : null}
          {admin && s.connected ? (
            <Button variant="ghost" onClick={() => setDrop(true)}>
              Trennen
            </Button>
          ) : null}
        </div>
      </div>

      {expired ? (
        <div className="hint hint-danger">
          <span>Die Bankfreigabe ist abgelaufen. Zahlungseingänge werden erst wieder abgerufen, wenn du neu verbindest.</span>
        </div>
      ) : expiring ? (
        <div className="hint">
          <span>Die Bankfreigabe läuft in {s.daysLeft} Tagen ab. „Neu verbinden“ verlängert sie.</span>
        </div>
      ) : null}
      {s.lastError && !expired ? (
        <div className="hint hint-danger">
          <span>Letzter Abruf fehlgeschlagen: {s.lastError}</span>
        </div>
      ) : null}

      {connect ? (
        <ConnectDialog
          status={s}
          onClose={() => {
            setConnect(false);
            st.reload();
          }}
          onDone={() => {
            setConnect(false);
            st.reload();
            // erster Abruf läuft serverseitig an – kurz danach Liste aktualisieren
            setTimeout(() => {
              st.reload();
              onSynced();
            }, 4000);
          }}
        />
      ) : null}
      {drop ? (
        <Confirm
          title="Bankverbindung trennen?"
          text="Kontor ruft dann keine Umsätze mehr ab, die Freigabe bei der Bank wird beendet. Bereits abgerufene Zahlungen bleiben erhalten."
          confirmLabel="Trennen"
          danger
          busy={busy === "drop"}
          onCancel={() => setDrop(false)}
          onConfirm={() =>
            void run(
              "drop",
              async () => {
                await api.del("/api/bank/sync");
                setDrop(false);
                st.reload();
              },
              "Bankverbindung getrennt",
            )
          }
        />
      ) : null}
    </>
  );
}

function ConnectDialog({ status, onClose, onDone }: { status: BankSyncStatus; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const toast = useToast();
  const { busy, run } = useAction();
  const [country, setCountry] = useState(status.bank?.country ?? "DE");
  const banks = useLoad(() => api.get<BankInfo[]>(`/api/bank/sync/banks?country=${country}`), [country]);
  const [q, setQ] = useState("");
  const [bank, setBank] = useState(status.bank?.name ?? "");
  const [psuType, setPsuType] = useState<Psu>("personal");
  const [from, setFrom] = useState(addDaysIso(todayIso(), -30));
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const started = useRef(0);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (banks.data ?? []).filter((b) => !t || b.name.toLowerCase().includes(t));
  }, [banks.data, q]);
  const selected = banks.data?.find((b) => b.name === bank) ?? null;

  // N26 vorauswählen, sobald die Liste da ist
  useEffect(() => {
    if (!bank && banks.data?.length) {
      const n26 = banks.data.find((b) => /^n26/i.test(b.name));
      if (n26) setBank(n26.name);
    }
  }, [banks.data, bank]);
  useEffect(() => {
    if (selected && !selected.psuTypes.includes(psuType)) setPsuType(selected.psuTypes[0] as Psu);
  }, [selected, psuType]);

  // Während der Bank-Anmeldung Status abfragen, bis die Verbindung steht
  useEffect(() => {
    if (!authUrl) return;
    const t = setInterval(async () => {
      try {
        const s = await api.get<BankSyncStatus>("/api/bank/sync");
        if (s.connected && s.connectedAt && Date.parse(s.connectedAt) >= started.current - 5000) {
          clearInterval(t);
          toast.ok(`${s.bank?.name ?? "Bank"} verbunden – Umsätze werden abgerufen`);
          doneRef.current();
        }
      } catch {
        /* weiter versuchen */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [authUrl, api, toast]);

  const start = () =>
    void run("start", async () => {
      started.current = Date.now();
      const r = await api.post<{ url: string }>("/api/bank/sync/connect", { bank, country, psuType, from });
      setAuthUrl(r.url);
      await openExternal(r.url);
    });

  if (authUrl) {
    return (
      <Modal
        title={`Bei ${bank} anmelden`}
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Abbrechen
            </Button>
            <Button onClick={() => void openExternal(authUrl)}>Anmeldeseite erneut öffnen</Button>
          </>
        }
      >
        <div className="connect-wait">
          <span className="spinner" aria-hidden />
          <div>
            <p>
              Im Browser ist die Anmeldeseite offen. Melde dich bei {bank} an, wähle das Konto und bestätige den Zugriff{/n26/i.test(bank) ? " in der N26-App" : ""}.
            </p>
            <p className="muted small">Sobald im Browser „Bankkonto verbunden“ steht, geht es hier von selbst weiter.</p>
          </div>
        </div>
        <details className="connect-fallback">
          <summary>Browser zeigt am Ende einen Fehler?</summary>
          <p className="muted small">
            Dann erreicht die Rückleitung deinen Server nicht. Kopiere die komplette Adresse aus der Adresszeile des Browsers (enthält <span className="mono">code=</span>) und füge sie hier
            ein:
          </p>
          <div className="inline-form">
            <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="https://…/api/bank/sync/callback?state=…&code=…" aria-label="Adresse aus dem Browser" />
            <Button
              variant="primary"
              busy={busy === "paste"}
              disabled={!pasted.trim()}
              onClick={() =>
                void run("paste", async () => {
                  await api.post("/api/bank/sync/complete", { url: pasted.trim() });
                  toast.ok("Bankkonto verbunden");
                  doneRef.current();
                })
              }
            >
              Übernehmen
            </Button>
          </div>
        </details>
      </Modal>
    );
  }

  return (
    <Modal
      title="Bankkonto verbinden"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" disabled={!selected} busy={busy === "start"} onClick={start}>
            Weiter zur Bank
          </Button>
        </>
      }
    >
      <div className="grid-4">
        <SelectField
          label="Land"
          value={country}
          onChange={(v) => {
            setCountry(v);
            setBank("");
          }}
          options={COUNTRIES}
          span={2}
        />
        <TextField label="Bank suchen" value={q} onChange={setQ} placeholder="z. B. N26, Sparkasse" span={2} />
        <Field label="Bank" span={4} error={banks.error}>
          {(id) => (
            <select id={id} size={7} value={bank} onChange={(e) => setBank(e.target.value)} className="bank-list">
              {banks.loading && !banks.data ? <option disabled>Lädt …</option> : null}
              {filtered.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                  {b.beta ? " (Beta)" : ""}
                </option>
              ))}
            </select>
          )}
        </Field>
        <SelectField<Psu>
          label="Kontoart"
          value={psuType}
          onChange={setPsuType}
          options={(selected?.psuTypes ?? ["personal", "business"]).map((p) => ({ value: p as Psu, label: p === "business" ? "Geschäftskonto" : "Privatkonto" }))}
          span={2}
          hint={selected ? `Freigabe gilt bis zu ${selected.maxDays} Tage` : undefined}
        />
        <TextField label="Umsätze abrufen ab" type="date" value={from} onChange={setFrom} span={2} hint="Banken liefern meist bis zu 90 Tage zurück." />
      </div>
      <p className="muted small">Nach „Weiter zur Bank“ öffnet sich der Browser. Kontor bekommt nur Lesezugriff auf die Umsätze, Überweisungen sind darüber nicht möglich.</p>
    </Modal>
  );
}
