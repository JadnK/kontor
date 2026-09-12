import { Fragment, useCallback, useMemo, useState } from "react";
import { useAction, useApi, useLoad, useNav, useSession } from "../lib/store";
import { addDaysIso, customerName, date, money, todayIso } from "../lib/format";
import type { BillingOpen, Customer, Project, TimeEntry } from "../lib/types";
import { Button, Confirm, Empty, ErrorBox, Field, Loading, Modal, MoneyField, PageHeader, Tabs, TextField, Toggle } from "../components/ui";
import { BillingDialog, StartTimerDialog, TimeEntryDialog, fmtDuration, notifyTime, parseDuration, useTimeEvents } from "../components/TimeTracking";
import { Icon } from "../components/Icon";

type View = "entries" | "billing" | "projects";
type Range = "week" | "month" | "lastMonth" | "year" | "all";

function rangeOf(r: Range): { from?: string; to?: string } {
  const t = todayIso();
  const d = new Date(`${t}T12:00:00`);
  if (r === "week") return { from: addDaysIso(t, -((d.getDay() + 6) % 7)), to: t };
  if (r === "month") return { from: `${t.slice(0, 7)}-01`, to: t };
  if (r === "lastMonth") {
    const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const last = new Date(d.getFullYear(), d.getMonth(), 0);
    const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
    return { from: iso(first), to: iso(last) };
  }
  if (r === "year") return { from: `${t.slice(0, 4)}-01-01`, to: t };
  return {};
}

export function TimePage() {
  const [view, setView] = useState<View>("entries");
  const [start, setStart] = useState(false);
  const [add, setAdd] = useState(false);
  return (
    <>
      <PageHeader
        title="Zeiterfassung"
        sub="Arbeitszeit per Stoppuhr oder nachträglich erfassen, Material dazu, und alles mit einem Klick abrechnen."
        actions={
          <>
            <Button onClick={() => setAdd(true)}>Zeit nachtragen</Button>
            <Button variant="primary" onClick={() => setStart(true)}><Icon name="play" /> Stoppuhr starten</Button>
          </>
        }
      />
      <div className="toolbar">
        <Tabs
          value={view}
          onChange={setView}
          tabs={[
            { value: "entries", label: "Zeiten" },
            { value: "billing", label: "Abrechnen" },
            { value: "projects", label: "Projekte" },
          ]}
        />
      </div>
      {view === "entries" ? <Entries /> : view === "billing" ? <Billing /> : <Projects />}
      {start ? <StartTimerDialog onClose={() => setStart(false)} onStarted={() => { setStart(false); notifyTime(); }} /> : null}
      {add ? <TimeEntryDialog onClose={() => setAdd(false)} onSaved={() => setAdd(false)} /> : null}
    </>
  );
}

function Entries() {
  const api = useApi();
  const { go } = useNav();
  const { busy, run } = useAction();
  const [range, setRange] = useState<Range>("month");
  const [state, setState] = useState<"all" | "open" | "billed">("all");
  const [customerId, setCustomerId] = useState("");
  const customers = useLoad(() => api.get<Customer[]>("/api/customers"), []);
  const r = rangeOf(range);
  const qs = new URLSearchParams({ ...(r.from ? { from: r.from } : {}), ...(r.to ? { to: r.to } : {}), ...(customerId ? { customerId } : {}), ...(state !== "all" ? { state } : {}) });
  const { data, error, loading, reload } = useLoad(() => api.get<TimeEntry[]>(`/api/time?${qs}`), [qs.toString()]);
  useTimeEvents(reload);
  const [edit, setEdit] = useState<TimeEntry | null>(null);
  const [del, setDel] = useState<TimeEntry | null>(null);

  const days = useMemo(() => {
    const m = new Map<string, TimeEntry[]>();
    for (const e of data ?? []) {
      if (!m.has(e.date)) m.set(e.date, []);
      m.get(e.date)!.push(e);
    }
    return [...m.entries()];
  }, [data]);
  const total = (data ?? []).reduce((a, e) => a + e.minutes, 0);
  const billable = (data ?? []).filter((e) => e.billable).reduce((a, e) => a + (e.amount ?? 0), 0);

  return (
    <>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Zeitraum">
          {(
            [
              ["week", "Diese Woche"],
              ["month", "Dieser Monat"],
              ["lastMonth", "Letzter Monat"],
              ["year", "Dieses Jahr"],
              ["all", "Alles"],
            ] as [Range, string][]
          ).map(([v, l]) => (
            <button key={v} aria-pressed={range === v} onClick={() => setRange(v)}>{l}</button>
          ))}
        </div>
        <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-label="Kunde">
          <option value="">Alle Kunden</option>
          {(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{customerName(c)}</option>)}
        </select>
        <select value={state} onChange={(e) => setState(e.target.value as typeof state)} aria-label="Status">
          <option value="all">Offen und abgerechnet</option>
          <option value="open">Nur offen</option>
          <option value="billed">Nur abgerechnet</option>
        </select>
      </div>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <Empty title="Keine Zeiten in diesem Zeitraum"><p className="muted">Starte die Stoppuhr in der Seitenleiste oder trage Zeiten nach.</p></Empty>
      ) : (
        <>
          <div className="kpis compact">
            <div><span>Erfasst</span><strong>{fmtDuration(total)} Std.</strong></div>
            <div><span>Abrechenbar</span><strong>{money(billable)}</strong></div>
          </div>
          <table className="table time-table">
            <tbody>
              {days.map(([d, list]) => (
                <Fragment key={d}>
                  <tr className="group-row">
                    <td colSpan={4}>{new Date(`${d}T12:00:00`).toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" })}</td>
                    <td className="num">{fmtDuration(list.reduce((a, e) => a + e.minutes, 0))}</td>
                    <td colSpan={2} />
                  </tr>
                  {list.map((e) => (
                    <tr key={e.id}>
                      <td>
                        {e.description || <span className="muted">ohne Beschreibung</span>}
                        <div className="sub">
                          {e.ticketNumber ? (
                            <button className="link" onClick={() => go({ name: "ticket", id: e.ticketId! })}>{e.ticketNumber}</button>
                          ) : null}
                          {e.ticketNumber && e.projectName ? " · " : ""}
                          {e.projectName}
                        </div>
                      </td>
                      <td>{e.customerName}</td>
                      <td className="muted">{e.userName}</td>
                      <td>
                        {e.running ? <span className="badge badge-issued">läuft</span> : e.invoiceId ? (
                          <button className="link" onClick={() => go({ name: "invoice", id: e.invoiceId! })}>{e.invoiceNumber ?? "Entwurf"}</button>
                        ) : e.billable ? <span className="badge badge-draft">offen</span> : <span className="badge badge-muted">intern</span>}
                      </td>
                      <td className="num nowrap">{fmtDuration(e.minutes)}</td>
                      <td className="num nowrap">{e.billable ? money(e.amount ?? 0) : ""}</td>
                      <td className="row-actions">
                        {!e.invoiceId ? (
                          <>
                            <button className="icon-btn" aria-label="Bearbeiten" title="Bearbeiten" onClick={() => setEdit(e)}><Icon name="note" /></button>
                            <button className="icon-btn" aria-label="Löschen" title="Löschen" onClick={() => setDel(e)}>×</button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </>
      )}
      {edit ? <TimeEntryDialog entry={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} /> : null}
      {del ? (
        <Confirm
          title="Zeit löschen?"
          text={`${fmtDuration(del.minutes)} Std. vom ${date(del.date)} werden gelöscht.`}
          confirmLabel="Löschen"
          danger
          busy={busy === "d"}
          onCancel={() => setDel(null)}
          onConfirm={() => run("d", async () => { await api.del(`/api/time/${del.id}`); setDel(null); notifyTime(); reload(); }, "Gelöscht")}
        />
      ) : null}
    </>
  );
}

function Billing() {
  const api = useApi();
  const { data, error, loading, reload } = useLoad(() => api.get<BillingOpen[]>("/api/billing/open"), []);
  useTimeEvents(useCallback(() => reload(), [reload]));
  const [bill, setBill] = useState<string | null>(null);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data?.length) return <Empty title="Alles abgerechnet"><p className="muted">Es gibt keine offenen Zeiten oder offenes Material.</p></Empty>;
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>Kunde</th>
            <th className="num">Zeit</th>
            <th className="num">Material</th>
            <th>Offen seit</th>
            <th className="num">Betrag netto</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.map((b) => (
            <tr key={b.customerId}>
              <td className="strong">{b.customerName}</td>
              <td className="num nowrap">{b.entries ? `${fmtDuration(b.minutes)} Std.` : "–"}</td>
              <td className="num">{b.charges ? `${b.charges} Pos.` : "–"}</td>
              <td className="nowrap">{date(b.oldest)}</td>
              <td className="num strong">{money(b.timeAmount + b.chargeAmount)}</td>
              <td className="row-actions"><Button variant="primary" className="btn-sm" onClick={() => setBill(b.customerId)}>Abrechnen</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="footnote">Gesamt offen: {money(data.reduce((a, b) => a + b.timeAmount + b.chargeAmount, 0))} netto</p>
      {bill ? <BillingDialog customerId={bill} onClose={() => { setBill(null); reload(); }} /> : null}
    </>
  );
}

function Projects() {
  const api = useApi();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const [all, setAll] = useState(false);
  const { data, error, loading, reload } = useLoad(() => api.get<Project[]>(`/api/projects${all ? "?all=1" : ""}`), [all]);
  const [edit, setEdit] = useState<Project | "new" | null>(null);
  return (
    <>
      <div className="toolbar">
        <Button onClick={() => setEdit("new")}>Neues Projekt</Button>
        <label className="inline-check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Archivierte zeigen</label>
      </div>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <Empty title="Noch keine Projekte"><p className="muted">Projekte bündeln Zeiten zu einem Auftrag, optional mit eigenem Stundensatz und Budget.</p></Empty>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Projekt</th><th>Kunde</th><th className="num">Stundensatz</th><th>Budget</th><th /></tr>
          </thead>
          <tbody>
            {data.map((p) => {
              const used = p.minutes ?? 0;
              const pct = p.budgetMinutes ? Math.min(100, Math.round((used / p.budgetMinutes) * 100)) : null;
              return (
                <tr key={p.id} className={p.archived ? "muted" : ""}>
                  <td className="strong">{p.name}{p.archived ? <span className="sub-inline">archiviert</span> : null}</td>
                  <td>{p.customerName}</td>
                  <td className="num">{p.hourlyRate != null ? money(p.hourlyRate) : <span className="muted">{money(settings.time.defaultHourlyRate)} (Standard)</span>}</td>
                  <td className="budget-cell">
                    {p.budgetMinutes ? (
                      <>
                        <div className={`budget-bar ${pct! >= 100 ? "over" : pct! >= 80 ? "warn" : ""}`}><span style={{ width: `${pct}%` }} /></div>
                        <span className="sub">{fmtDuration(used)} von {fmtDuration(p.budgetMinutes)} Std.</span>
                      </>
                    ) : (
                      <span className="sub">{fmtDuration(used)} Std. erfasst</span>
                    )}
                  </td>
                  <td className="row-actions">
                    <Button variant="ghost" className="btn-sm" onClick={() => setEdit(p)}>Bearbeiten</Button>
                    {!p.archived ? (
                      <Button variant="ghost" className="btn-sm" busy={busy === p.id} onClick={() => run(p.id, async () => { await api.del(`/api/projects/${p.id}`); reload(); }, "Projekt entfernt")}>Entfernen</Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {edit ? <ProjectDialog project={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} /> : null}
    </>
  );
}

export function ProjectDialog({ project, customerId, onClose, onSaved }: { project: Project | null; customerId?: string; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const { busy, run } = useAction();
  const customers = useLoad(() => api.get<Customer[]>("/api/customers"), []);
  const [c, setC] = useState(project?.customerId ?? customerId ?? "");
  const [name, setName] = useState(project?.name ?? "");
  const [rate, setRate] = useState<number | null>(project?.hourlyRate ?? null);
  const [budget, setBudget] = useState(project?.budgetMinutes ? fmtDuration(project.budgetMinutes) : "");
  const [archived, setArchived] = useState(project?.archived ?? false);
  const budgetMin = budget ? parseDuration(budget) : null;
  return (
    <Modal
      title={project ? "Projekt bearbeiten" : "Neues Projekt"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            disabled={!c || !name.trim()}
            busy={busy === "s"}
            onClick={() => run("s", async () => {
              const body = { customerId: c, name, hourlyRate: rate, budgetMinutes: budgetMin, archived };
              if (project) await api.put(`/api/projects/${project.id}`, body);
              else await api.post("/api/projects", body);
              onSaved();
            }, "Projekt gespeichert")}
          >
            Speichern
          </Button>
        </>
      }
    >
      <div className="grid-4">
        <Field label="Kunde" span={4}>
          {(id) => (
            <select id={id} value={c} onChange={(e) => setC(e.target.value)} disabled={!!project || !!customerId}>
              <option value="">Kunde wählen</option>
              {(customers.data ?? []).map((x) => <option key={x.id} value={x.id}>{customerName(x)}</option>)}
            </select>
          )}
        </Field>
        <TextField label="Name" value={name} onChange={setName} span={4} />
        <MoneyField label="Stundensatz" value={rate} onChange={setRate} hint="Leer = Satz des Kunden bzw. Standard" span={2} />
        <TextField label="Budget (Std.)" value={budget} onChange={setBudget} placeholder="z. B. 40:00" hint="Optional" span={2} error={budget && !budgetMin ? "Format: 40:00 oder 40" : null} />
      </div>
      {project ? <Toggle label="Archiviert" checked={archived} onChange={setArchived} /> : null}
    </Modal>
  );
}
