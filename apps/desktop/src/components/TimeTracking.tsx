import { useEffect, useMemo, useState } from "react";
import { useAction, useApi, useLoad, useNav, useSession, useToast } from "../lib/store";
import { customerName, date, money, num, todayIso } from "../lib/format";
import type { Charge, Customer, Product, Project, TimeEntry } from "../lib/types";
import { Button, Field, Modal, MoneyField, NumberField, SelectField, TextArea, TextField, Toggle } from "./ui";
import { Icon } from "./Icon";

/** Alle Stellen mit Zeitbezug hören auf dieses Ereignis, damit Stoppuhr und Listen synchron bleiben */
export const TIME_EVENT = "kontor:time";
export const notifyTime = () => window.dispatchEvent(new Event(TIME_EVENT));
export function useTimeEvents(cb: () => void) {
  useEffect(() => {
    window.addEventListener(TIME_EVENT, cb);
    return () => window.removeEventListener(TIME_EVENT, cb);
  }, [cb]);
}

export function fmtDuration(min: number) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** "1:30", "90", "1,5" oder "1.5" → Minuten */
export function parseDuration(s: string): number | null {
  const t = s.trim().replace(/\s*(std|h|min|m)\.?$/i, "");
  if (!t) return null;
  if (/^\d{1,2}:\d{1,2}$/.test(t)) {
    const [h, m] = t.split(":").map(Number);
    return m < 60 ? h * 60 + m : null;
  }
  if (/^\d+[.,]\d+$/.test(t)) return Math.round(Number(t.replace(",", ".")) * 60);
  if (/^\d+$/.test(t)) return Number(t);
  return null;
}

function elapsed(startedAt: string | null) {
  if (!startedAt) return "0:00:00";
  const sec = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  return `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

// ---------- Stoppuhr in der Seitenleiste ----------
export function TimerWidget() {
  const api = useApi();
  const toast = useToast();
  const { go } = useNav();
  const [running, setRunning] = useState<TimeEntry | null>(null);
  const [, tick] = useState(0);
  const [start, setStart] = useState(false);
  const load = useMemo(
    () => async () => {
      try {
        setRunning(await api.get<TimeEntry | null>("/api/time/running"));
      } catch {
        /* nicht kritisch */
      }
    },
    [api],
  );
  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);
  useTimeEvents(load);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const stop = async () => {
    try {
      const e = await api.post<TimeEntry>("/api/time/stop");
      toast.ok(`${fmtDuration(e.minutes)} Std. erfasst${e.ticketNumber ? ` für ${e.ticketNumber}` : ""}`);
      setRunning(null);
      notifyTime();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <>
      {running ? (
        <div className="timer running">
          <button className="timer-main" onClick={() => (running.ticketId ? go({ name: "ticket", id: running.ticketId }) : go({ name: "time" }))} title="Zur Zeiterfassung">
            <span className="timer-clock">{elapsed(running.startedAt)}</span>
            <span className="timer-label">{running.ticketNumber ?? running.projectName ?? running.customerName}</span>
          </button>
          <button className="timer-btn" onClick={() => void stop()} aria-label="Stoppuhr anhalten" title="Anhalten">
            <Icon name="stop" />
          </button>
        </div>
      ) : (
        <button className="timer idle" onClick={() => setStart(true)}>
          <Icon name="clock" />
          Stoppuhr starten
        </button>
      )}
      {start ? <StartTimerDialog onClose={() => setStart(false)} onStarted={() => { setStart(false); notifyTime(); }} /> : null}
    </>
  );
}

// ---------- Kunden/Projekt-Auswahl ----------
function useCustomersProjects(customerId: string) {
  const api = useApi();
  const customers = useLoad(() => api.get<Customer[]>("/api/customers"), []);
  const projects = useLoad(() => (customerId ? api.get<Project[]>(`/api/projects?customerId=${customerId}`) : Promise.resolve([] as Project[])), [customerId]);
  return { customers: customers.data ?? [], projects: projects.data ?? [] };
}

function CustomerProject({
  customerId,
  projectId,
  onCustomer,
  onProject,
  lockCustomer,
}: {
  customerId: string;
  projectId: string | null;
  onCustomer: (id: string) => void;
  onProject: (id: string | null) => void;
  lockCustomer?: boolean;
}) {
  const { customers, projects } = useCustomersProjects(customerId);
  return (
    <>
      <Field label="Kunde" span={2}>
        {(id) => (
          <select id={id} value={customerId} disabled={lockCustomer} onChange={(e) => { onCustomer(e.target.value); onProject(null); }}>
            <option value="">Kunde wählen</option>
            {customers.filter((c) => !c.archived).map((c) => (
              <option key={c.id} value={c.id}>{customerName(c)}</option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Projekt" span={2}>
        {(id) => (
          <select id={id} value={projectId ?? ""} onChange={(e) => onProject(e.target.value || null)} disabled={!customerId}>
            <option value="">Kein Projekt</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
      </Field>
    </>
  );
}

export function StartTimerDialog({
  preset,
  onClose,
  onStarted,
}: {
  preset?: { customerId?: string | null; projectId?: string | null; ticketId?: string | null; description?: string; ticketLabel?: string };
  onClose: () => void;
  onStarted: () => void;
}) {
  const api = useApi();
  const { busy, run } = useAction();
  const [customerId, setCustomerId] = useState(preset?.customerId ?? "");
  const [projectId, setProjectId] = useState<string | null>(preset?.projectId ?? null);
  const [description, setDescription] = useState(preset?.description ?? "");
  return (
    <Modal
      title="Stoppuhr starten"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            disabled={!customerId}
            busy={busy === "s"}
            onClick={() => run("s", async () => {
              await api.post("/api/time/start", { customerId, projectId, ticketId: preset?.ticketId ?? null, description });
              onStarted();
            }, "Stoppuhr läuft")}
          >
            <Icon name="play" /> Starten
          </Button>
        </>
      }
    >
      {preset?.ticketLabel ? <p className="muted">Für {preset.ticketLabel}</p> : null}
      <div className="grid-4">
        <CustomerProject customerId={customerId} projectId={projectId} onCustomer={setCustomerId} onProject={setProjectId} lockCustomer={!!preset?.ticketId && !!preset.customerId} />
        <TextField label="Was machst du?" value={description} onChange={setDescription} span={4} placeholder="z. B. Fehlersuche Kontaktformular" autoFocus />
      </div>
      <p className="muted small">Eine laufende Stoppuhr wird dabei angehalten. Die Uhr läuft auf dem Server weiter, auch wenn du die App schließt.</p>
    </Modal>
  );
}

// ---------- Zeit manuell erfassen / bearbeiten ----------
export function TimeEntryDialog({
  entry,
  preset,
  onClose,
  onSaved,
}: {
  entry?: TimeEntry | null;
  preset?: { customerId?: string | null; projectId?: string | null; ticketId?: string | null; ticketLabel?: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useApi();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const [customerId, setCustomerId] = useState(entry?.customerId ?? preset?.customerId ?? "");
  const [projectId, setProjectId] = useState<string | null>(entry?.projectId ?? preset?.projectId ?? null);
  const [day, setDay] = useState(entry?.date ?? todayIso());
  const [dur, setDur] = useState(entry ? fmtDuration(entry.minutes) : "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [billable, setBillable] = useState(entry?.billable ?? true);
  const [rate, setRate] = useState<number | null>(entry?.hourlyRate ?? null);
  const minutes = parseDuration(dur);
  const ticketId = entry?.ticketId ?? preset?.ticketId ?? null;
  return (
    <Modal
      title={entry ? "Zeit bearbeiten" : "Zeit erfassen"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            disabled={!customerId || (!entry?.running && !minutes)}
            busy={busy === "s"}
            onClick={() => run("s", async () => {
              const body = { customerId, projectId, ticketId, date: day, minutes: entry?.running ? 0 : (minutes ?? 0), description, billable, hourlyRate: rate };
              if (entry) await api.put(`/api/time/${entry.id}`, body);
              else await api.post("/api/time", body);
              notifyTime();
              onSaved();
            }, "Gespeichert")}
          >
            Speichern
          </Button>
        </>
      }
    >
      {entry?.ticketNumber || preset?.ticketLabel ? <p className="muted">Ticket {entry?.ticketNumber ?? preset?.ticketLabel}</p> : null}
      <div className="grid-4">
        <CustomerProject customerId={customerId} projectId={projectId} onCustomer={setCustomerId} onProject={setProjectId} lockCustomer={!!ticketId} />
        <TextField label="Datum" type="date" value={day} onChange={(v) => setDay(v || todayIso())} />
        {entry?.running ? (
          <Field label="Dauer">{() => <span className="field-static">läuft noch</span>}</Field>
        ) : (
          <TextField label="Dauer" value={dur} onChange={setDur} placeholder="1:30" hint={minutes ? `${num(minutes / 60, 2)} Std.` : "z. B. 1:30, 90 oder 1,5"} error={dur && !minutes ? "Format: 1:30, 90 oder 1,5" : null} />
        )}
        <MoneyField label="Eigener Stundensatz" value={rate} onChange={setRate} hint={`Leer = Projekt, Kunde oder ${money(settings.time.defaultHourlyRate)}`} span={2} />
        <TextArea label="Tätigkeit" value={description} onChange={setDescription} span={4} rows={2} />
      </div>
      <Toggle label="Abrechenbar" checked={billable} onChange={setBillable} hint="Nicht abrechenbare Zeiten zählen für Auswertung und Budget, erscheinen aber auf keiner Rechnung." />
    </Modal>
  );
}

// ---------- Material ----------
export function ChargeDialog({
  charge,
  preset,
  onClose,
  onSaved,
}: {
  charge?: Charge | null;
  preset: { customerId: string; projectId?: string | null; ticketId?: string | null };
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useApi();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const products = useLoad(() => api.get<Product[]>("/api/products"), []);
  const [name, setName] = useState(charge?.name ?? "");
  const [description, setDescription] = useState(charge?.description ?? "");
  const [qty, setQty] = useState<number | null>(charge?.quantity ?? 1);
  const [unit, setUnit] = useState(charge?.unit ?? "Stk");
  const [price, setPrice] = useState<number | null>(charge?.unitPriceNet ?? null);
  const [tax, setTax] = useState(charge?.taxRate ?? settings.invoice.defaultTaxRate);
  const [productId, setProductId] = useState<string | null>(charge?.productId ?? null);
  const [day, setDay] = useState(charge?.date ?? todayIso());
  const pick = (id: string) => {
    const p = (products.data ?? []).find((x) => x.id === id);
    if (!p) return;
    setProductId(p.id);
    setName(p.name);
    setDescription(p.description ?? "");
    setUnit(p.unit);
    setPrice(p.priceNet);
    setTax(p.taxRate);
  };
  return (
    <Modal
      title={charge ? "Material bearbeiten" : "Material / Pauschale erfassen"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            disabled={!name.trim() || !qty || price == null}
            busy={busy === "s"}
            onClick={() => run("s", async () => {
              const body = { ...preset, productId, date: day, name, description: description || null, quantity: qty, unit, unitPriceNet: price, taxRate: tax };
              if (charge) await api.put(`/api/charges/${charge.id}`, body);
              else await api.post("/api/charges", body);
              notifyTime();
              onSaved();
            }, "Gespeichert")}
          >
            Speichern
          </Button>
        </>
      }
    >
      <div className="grid-4">
        <Field label="Aus Produkten übernehmen" span={4}>
          {(id) => (
            <select id={id} value="" onChange={(e) => pick(e.target.value)}>
              <option value="">Produkt wählen …</option>
              {(products.data ?? []).filter((p) => p.active).map((p) => (
                <option key={p.id} value={p.id}>{p.name} – {money(p.priceNet)}/{p.unit}</option>
              ))}
            </select>
          )}
        </Field>
        <TextField label="Bezeichnung" value={name} onChange={setName} span={4} />
        <NumberField label="Menge" value={qty} onChange={setQty} />
        <TextField label="Einheit" value={unit} onChange={setUnit} />
        <MoneyField label="Einzelpreis netto" value={price} onChange={setPrice} span={2} />
        {!settings.invoice.smallBusiness ? (
          <SelectField label="USt." value={String(tax)} onChange={(v) => setTax(Number(v))} options={settings.invoice.taxRates.map((r) => ({ value: String(r), label: `${num(r)} %` }))} />
        ) : null}
        <TextField label="Datum" type="date" value={day} onChange={(v) => setDay(v || todayIso())} />
        <TextArea label="Beschreibung" value={description} onChange={setDescription} span={4} rows={2} />
      </div>
    </Modal>
  );
}

// ---------- Abrechnen ----------
export function BillingDialog({ customerId, ticketId, onClose }: { customerId: string; ticketId?: string; onClose: () => void }) {
  const api = useApi();
  const { go } = useNav();
  const { busy, run } = useAction();
  const time = useLoad(() => api.get<TimeEntry[]>(`/api/time?customerId=${customerId}&state=open`), [customerId]);
  const charges = useLoad(() => api.get<Charge[]>(`/api/charges?customerId=${customerId}&state=open`), [customerId]);
  const entries = (time.data ?? []).filter((e) => !e.running && (!ticketId || e.ticketId === ticketId));
  const chargeRows = (charges.data ?? []).filter((c) => !ticketId || c.ticketId === ticketId);
  const [skipT, setSkipT] = useState<Set<string>>(new Set());
  const [skipC, setSkipC] = useState<Set<string>>(new Set());
  const toggle = (set: Set<string>, id: string, upd: (s: Set<string>) => void) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    upd(n);
  };
  const selT = entries.filter((e) => !skipT.has(e.id));
  const selC = chargeRows.filter((c) => !skipC.has(c.id));
  const total = selT.reduce((a, e) => a + (e.amount ?? 0), 0) + selC.reduce((a, c) => a + c.amount, 0);
  const running = (time.data ?? []).some((e) => e.running && (!ticketId || e.ticketId === ticketId));
  return (
    <Modal
      title="Abrechnen"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="modal-total">Netto {money(total)}</span>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            disabled={!selT.length && !selC.length}
            busy={busy === "b"}
            onClick={() => run("b", async () => {
              const r = await api.post<{ invoiceId: string }>("/api/billing/invoice", { customerId, timeEntryIds: selT.map((e) => e.id), chargeIds: selC.map((c) => c.id) });
              notifyTime();
              go({ name: "invoice-edit", id: r.invoiceId });
            }, "Rechnungsentwurf erstellt")}
          >
            Rechnungsentwurf erstellen
          </Button>
        </>
      }
    >
      {running ? <div className="hint"><span>Eine Stoppuhr läuft noch – die laufende Zeit wird erst nach dem Anhalten abrechenbar.</span></div> : null}
      {!entries.length && !chargeRows.length ? (
        <p className="muted">Nichts Offenes zum Abrechnen.</p>
      ) : (
        <table className="table compact bill-table">
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className={skipT.has(e.id) ? "off" : ""}>
                <td className="w-check"><input type="checkbox" checked={!skipT.has(e.id)} onChange={() => toggle(skipT, e.id, setSkipT)} aria-label="Übernehmen" /></td>
                <td className="nowrap muted">{date(e.date)}</td>
                <td>{e.description || <span className="muted">Arbeitszeit</span>}<div className="sub">{[e.ticketNumber, e.projectName, e.userName].filter(Boolean).join(" · ")}</div></td>
                <td className="num nowrap">{fmtDuration(e.billedMinutes ?? e.minutes)} Std.</td>
                <td className="num nowrap muted">{money(e.rate ?? 0)}/Std.</td>
                <td className="num">{money(e.amount ?? 0)}</td>
              </tr>
            ))}
            {chargeRows.map((c) => (
              <tr key={c.id} className={skipC.has(c.id) ? "off" : ""}>
                <td className="w-check"><input type="checkbox" checked={!skipC.has(c.id)} onChange={() => toggle(skipC, c.id, setSkipC)} aria-label="Übernehmen" /></td>
                <td className="nowrap muted">{date(c.date)}</td>
                <td>{c.name}<div className="sub">{[c.ticketNumber, "Material"].filter(Boolean).join(" · ")}</div></td>
                <td className="num nowrap">{num(c.quantity)} {c.unit}</td>
                <td className="num nowrap muted">{money(c.unitPriceNet)}</td>
                <td className="num">{money(c.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">Zeiten werden im eingestellten Takt aufgerundet und je Ticket bzw. Projekt zu einer Position zusammengefasst (Einstellungen → Zeiterfassung). Du kannst den Entwurf danach noch bearbeiten.</p>
    </Modal>
  );
}
