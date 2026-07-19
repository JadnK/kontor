import { useEffect, useState } from "react";
import { useAction, useApi, useLoad, useNav, useSession, useToast } from "../lib/store";
import { customerName, dateTime } from "../lib/format";
import type { Customer, FilteredMail, TicketRow, TicketStatus, TicketPriority } from "../lib/types";
import { Button, Empty, ErrorBox, Loading, Modal, PageHeader, Search, SelectField, Tabs, TextArea, TextField, Toggle } from "../components/ui";
import { Icon } from "../components/Icon";

type View = "OPEN" | "PENDING" | "CLOSED" | "ALL" | "FILTERED";

interface Stats {
  open: { n: number; unread: number };
  pending: { n: number };
  closed: { n: number };
  filtered: number;
  lastPoll: { at: string; error: string | null } | null;
  enabled: boolean;
  address: string;
}

export const TICKET_STATUS: Record<TicketStatus, { label: string; cls: string }> = {
  OPEN: { label: "Offen", cls: "badge-warn" },
  PENDING: { label: "Wartet auf Kunde", cls: "badge-muted" },
  CLOSED: { label: "Erledigt", cls: "badge-ok" },
};

export const TICKET_PRIORITY: Record<TicketPriority, { label: string; cls: string }> = {
  LOW: { label: "Niedrig", cls: "badge-muted" },
  NORMAL: { label: "Normal", cls: "badge-muted" },
  HIGH: { label: "Hoch", cls: "badge-warn" },
  URGENT: { label: "Dringend", cls: "badge-danger" },
};

export function ago(iso: string) {
  const d = new Date(iso);
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function Tickets({ initialView }: { initialView?: string }) {
  const api = useApi();
  const toast = useToast();
  const { go } = useNav();
  const { user, settings } = useSession();
  const { busy, run } = useAction();
  const [view, setView] = useState<View>((initialView as View) ?? "OPEN");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [creating, setCreating] = useState(false);
  const [prio, setPrio] = useState("");
  const [cat, setCat] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const stats = useLoad(() => api.get<Stats>("/api/tickets/stats"), []);
  const list = useLoad(
    () => (view === "FILTERED" ? Promise.resolve([] as TicketRow[]) : api.get<TicketRow[]>(`/api/tickets?status=${view}&q=${encodeURIComponent(debounced)}${prio ? `&priority=${prio}` : ""}${cat ? `&category=${encodeURIComponent(cat)}` : ""}`)),
    [view, debounced, prio, cat],
  );
  const filtered = useLoad(() => (view === "FILTERED" ? api.get<FilteredMail[]>("/api/tickets-filtered") : Promise.resolve([] as FilteredMail[])), [view]);
  const reload = () => {
    stats.reload();
    list.reload();
    filtered.reload();
  };

  // Neue Mails kommen im Hintergrund: Liste jede Minute auffrischen
  useEffect(() => {
    const t = setInterval(() => {
      stats.reload();
      if (view !== "FILTERED") list.reload();
    }, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const poll = () =>
    run("poll", async () => {
      const r = await api.post<{ created: number; appended: number; filtered: number; error: string | null }>("/api/tickets/poll");
      if (r.error) throw new Error(r.error);
      toast.ok(r.created || r.appended || r.filtered ? `${r.created} neue Tickets, ${r.appended} Antworten, ${r.filtered} aussortiert` : "Keine neuen Mails");
      reload();
    });

  const s = stats.data;
  return (
    <>
      <PageHeader
        title="Tickets"
        sub={
          s?.enabled ? (
            <>
              Anfragen an <strong>{s.address}</strong>. Werbung, Newsletter und Abwesenheitsnotizen werden aussortiert.
              {s.lastPoll ? ` Zuletzt abgerufen ${ago(s.lastPoll.at)}.` : ""}
            </>
          ) : undefined
        }
        actions={
          <>
            {s?.enabled ? (
              <Button busy={busy === "poll"} onClick={poll}>
                <Icon name="refresh" /> Postfach abrufen
              </Button>
            ) : null}
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Ticket anlegen
            </Button>
          </>
        }
      />

      {s && !s.enabled ? (
        <div className="hint hint-info">
          <span>Das Ticket-Postfach ist noch nicht eingerichtet. Trage ein eigenes Postfach ein (z. B. ticket@deinefirma.de), dann werden Kundenanfragen automatisch zu Tickets.</span>
          {user.role === "ADMIN" ? (
            <Button variant="ghost" onClick={() => go({ name: "settings", tab: "tickets" })}>
              Postfach einrichten
            </Button>
          ) : null}
        </div>
      ) : null}
      {s?.lastPoll?.error ? (
        <div className="hint hint-danger">
          <span>Letzter Abruf fehlgeschlagen: {s.lastPoll.error}</span>
          {user.role === "ADMIN" ? (
            <Button variant="ghost" onClick={() => go({ name: "settings", tab: "tickets" })}>
              Zugangsdaten prüfen
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="toolbar">
        {view !== "FILTERED" ? <Search value={q} onChange={setQ} placeholder="Nummer, Betreff oder Absender" /> : null}
        {view !== "FILTERED" ? (
          <select value={prio} onChange={(e) => setPrio(e.target.value)} aria-label="Priorität">
            <option value="">Alle Prioritäten</option>
            {(Object.keys(TICKET_PRIORITY) as TicketPriority[]).map((p) => <option key={p} value={p}>{TICKET_PRIORITY[p].label}</option>)}
          </select>
        ) : null}
        {view !== "FILTERED" && settings.tickets.categories.length ? (
          <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Kategorie">
            <option value="">Alle Kategorien</option>
            {settings.tickets.categories.map((c) => <option key={c}>{c}</option>)}
          </select>
        ) : null}
        <Tabs
          value={view}
          onChange={setView}
          tabs={[
            { value: "OPEN", label: "Offen", count: s?.open.n },
            { value: "PENDING", label: "Wartet auf Kunde", count: s?.pending.n },
            { value: "CLOSED", label: "Erledigt" },
            { value: "ALL", label: "Alle" },
            { value: "FILTERED", label: "Aussortiert", count: s?.filtered },
          ]}
        />
      </div>

      {view === "FILTERED" ? (
        <FilteredList data={filtered.data} loading={filtered.loading} error={filtered.error} onChange={reload} />
      ) : list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : list.loading && !list.data ? (
        <Loading />
      ) : !list.data?.length ? (
        <Empty title={debounced ? "Keine Treffer" : view === "OPEN" ? "Keine offenen Tickets" : "Keine Tickets"}>
          {view === "OPEN" && !debounced ? <p className="muted">Neue Anfragen aus dem Ticket-Postfach erscheinen hier automatisch.</p> : null}
        </Empty>
      ) : (
        <ul className="ticket-list">
          {list.data.map((t) => (
            <li key={t.id}>
              <button className={`ticket-row ${t.unread ? "unread" : ""}`} onClick={() => go({ name: "ticket", id: t.id })}>
                <span className="unread-dot" aria-label={t.unread ? "ungelesen" : undefined} />
                <div style={{ minWidth: 0 }}>
                  <div className="ticket-subject">{t.subject}</div>
                  <div className="ticket-meta">
                    <span>{t.number}</span>
                    {t.category ? <span>{t.category}</span> : null}
                    <span>{t.customerName ?? t.contactName ?? t.contactEmail}</span>
                    {t.assigneeName ? <span>Zuständig: {t.assigneeName}</span> : null}
                    <span>{t.messageCount} Nachrichten</span>
                  </div>
                </div>
                <div className="ticket-side">
                  {t.priority === "HIGH" || t.priority === "URGENT" ? <span className={`badge ${TICKET_PRIORITY[t.priority].cls}`}>{TICKET_PRIORITY[t.priority].label}</span> : null}
                  <span className={`badge ${TICKET_STATUS[t.status].cls}`}>{TICKET_STATUS[t.status].label}</span>
                  <span title={dateTime(t.lastMessageAt)}>{ago(t.lastMessageAt)}</span>
                </div>
                {t.snippet ? (
                  <div className="ticket-snippet">
                    {t.lastDirection === "OUT" ? "Deine Antwort: " : ""}
                    {t.snippet}
                  </div>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <NewTicket
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            go({ name: "ticket", id });
          }}
        />
      ) : null}
    </>
  );
}

function FilteredList({ data, loading, error, onChange }: { data: FilteredMail[] | null; loading: boolean; error: string | null; onChange: () => void }) {
  const api = useApi();
  const { go } = useNav();
  const { busy, run } = useAction();
  if (error) return <ErrorBox error={error} />;
  if (loading && !data) return <Loading />;
  if (!data?.length) {
    return (
      <Empty title="Nichts aussortiert">
        <p className="muted">Hier landen Newsletter, Werbung, Spam und Abwesenheitsnotizen aus dem Ticket-Postfach. Du kannst sie jederzeit doch als Ticket übernehmen.</p>
      </Empty>
    );
  }
  return (
    <>
      <div className="toolbar">
        <span className="muted">Übernehmen macht daraus ein Ticket. „Domain sperren“ sortiert den Absender künftig immer aus.</span>
        <Button
          variant="ghost"
          className="danger-text"
          busy={busy === "clear"}
          onClick={() =>
            run(
              "clear",
              async () => {
                await api.post("/api/tickets-filtered/clear");
                onChange();
              },
              "Liste geleert",
            )
          }
        >
          Alle löschen
        </Button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Eingang</th>
            <th>Absender</th>
            <th>Betreff</th>
            <th>Grund</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.map((f) => (
            <tr key={f.id}>
              <td className="nowrap muted">{dateTime(f.receivedAt)}</td>
              <td>
                {f.fromName ?? f.fromEmail}
                {f.fromName ? <div className="sub">{f.fromEmail}</div> : null}
              </td>
              <td className="tx-purpose">
                {f.subject ?? <span className="muted">(ohne Betreff)</span>}
                {f.snippet ? <div className="sub">{f.snippet.slice(0, 140)}</div> : null}
              </td>
              <td>
                <span className="reason-chip">{f.reason}</span>
              </td>
              <td className="row-actions">
                <div className="stack" style={{ alignItems: "flex-end" }}>
                  <Button
                    className="btn-sm"
                    busy={busy === `a${f.id}`}
                    onClick={() =>
                      run(
                        `a${f.id}`,
                        async () => {
                          const r = await api.post<{ ticketId: string }>(`/api/tickets-filtered/${f.id}/accept`, { allowSender: false });
                          go({ name: "ticket", id: r.ticketId });
                        },
                        "Als Ticket übernommen",
                      )
                    }
                  >
                    Übernehmen
                  </Button>
                  <div className="suggest">
                    <Button
                      variant="ghost"
                      className="btn-sm"
                      title="Übernehmen und diesen Absender künftig immer zulassen"
                      onClick={() =>
                        run(
                          `aa${f.id}`,
                          async () => {
                            await api.post(`/api/tickets-filtered/${f.id}/accept`, { allowSender: true });
                            onChange();
                          },
                          "Übernommen, Absender wird künftig immer zugelassen",
                        )
                      }
                    >
                      Immer zulassen
                    </Button>
                    <Button
                      variant="ghost"
                      className="btn-sm danger-text"
                      title={`Alle Mails von @${f.fromEmail.split("@")[1]} künftig aussortieren`}
                      onClick={() =>
                        run(
                          `b${f.id}`,
                          async () => {
                            await api.post(`/api/tickets-filtered/${f.id}/block`, { domain: true });
                            onChange();
                          },
                          "Absender-Domain gesperrt",
                        )
                      }
                    >
                      Domain sperren
                    </Button>
                    <button
                      className="icon-btn"
                      aria-label="Löschen"
                      title="Löschen"
                      onClick={() =>
                        run(`d${f.id}`, async () => {
                          await api.del(`/api/tickets-filtered/${f.id}`);
                          onChange();
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function NewTicket({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const api = useApi();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const customers = useLoad(() => api.get<Customer[]>("/api/customers"), []);
  const [customerId, setCustomerId] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [send, setSend] = useState(false);
  const [priority, setPriority] = useState<TicketPriority>(settings.tickets.defaultPriority);
  const [category, setCategory] = useState("");
  const canSend = settings.tickets.enabled || !!settings.tickets.imapHost;
  return (
    <Modal
      title="Ticket anlegen"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            busy={busy === "save"}
            onClick={() =>
              run(
                "save",
                async () => {
                  const r = await api.post<{ id: string }>("/api/tickets", { customerId: customerId || null, email: email || undefined, subject, body, sendToCustomer: send, priority, category: category || undefined });
                  onCreated(r.id);
                },
                send ? "Ticket angelegt und gesendet" : "Ticket angelegt",
              )
            }
          >
            {send ? "Anlegen und senden" : "Ticket anlegen"}
          </Button>
        </>
      }
    >
      <p className="muted">Für Anfragen per Telefon oder vor Ort. Ohne Versand wird der Text als interne Notiz gespeichert.</p>
      <div className="grid-2">
        <SelectField
          label="Kunde"
          value={customerId}
          onChange={(v) => {
            setCustomerId(v);
            const c = customers.data?.find((x) => x.id === v);
            if (c?.email) setEmail(c.email);
          }}
          options={[{ value: "", label: "Kein Kunde / unbekannt" }, ...(customers.data ?? []).map((c) => ({ value: c.id, label: `${customerName(c)} (${c.number})` }))]}
        />
        <TextField label="E-Mail des Kontakts" type="email" value={email} onChange={setEmail} />
        <TextField label="Betreff" value={subject} onChange={setSubject} span={2} autoFocus />
        <SelectField label="Priorität" value={priority} onChange={setPriority} options={(Object.keys(TICKET_PRIORITY) as TicketPriority[]).map((p) => ({ value: p, label: TICKET_PRIORITY[p].label }))} />
        <SelectField label="Kategorie" value={category} onChange={setCategory} options={[{ value: "", label: "Keine" }, ...settings.tickets.categories.map((c) => ({ value: c, label: c }))]} />
        <TextArea label={send ? "Nachricht an den Kunden" : "Notiz"} value={body} onChange={setBody} rows={6} span={2} />
        <div className="span-2">
          <Toggle
            label="Als E-Mail an den Kunden senden"
            checked={send}
            onChange={setSend}
            hint={canSend ? "Geht über das Ticket-Postfach raus, Antworten landen automatisch im Ticket." : "Erst das Ticket-Postfach in den Einstellungen einrichten."}
          />
        </div>
      </div>
    </Modal>
  );
}
