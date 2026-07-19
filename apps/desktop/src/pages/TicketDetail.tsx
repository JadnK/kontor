import { useRef, useState } from "react";
import { useAction, useApi, useLoad, useNav, useSession, useToast } from "../lib/store";
import { customerName, date, dateTime, money } from "../lib/format";
import { saveFile } from "../lib/native";
import type { Charge, Customer, TicketFull, TicketPriority, TicketStatus, TimeEntry } from "../lib/types";
import { Button, Confirm, ErrorBox, Loading, PageHeader } from "../components/ui";
import { Icon } from "../components/Icon";
import { TICKET_PRIORITY, TICKET_STATUS } from "./Tickets";
import { ChargeDialog, StartTimerDialog, TimeEntryDialog, fmtDuration, notifyTime, useTimeEvents } from "../components/TimeTracking";
import { fileToBase64 } from "./Bank";

function size(n: number) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function TicketDetail({ id }: { id: string }) {
  const api = useApi();
  const toast = useToast();
  const { go, back } = useNav();
  const { user, settings } = useSession();
  const { busy, run } = useAction();
  const { data: t, error, loading, reload } = useLoad(() => api.get<TicketFull>(`/api/tickets/${id}`), [id]);
  const customers = useLoad(() => api.get<Customer[]>("/api/customers"), []);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [timeDlg, setTimeDlg] = useState<null | "start" | "new" | TimeEntry>(null);
  const [chargeDlg, setChargeDlg] = useState<null | "new" | Charge>(null);
  useTimeEvents(reload);

  if (loading && !t) return <Loading />;
  if (error || !t) return <ErrorBox error={error ?? "Nicht gefunden"} onRetry={reload} />;

  const patch = (
    body: Partial<{ status: TicketStatus; assigneeId: string | null; customerId: string | null; priority: TicketPriority; category: string | null; projectId: string | null }>,
    msg?: string,
  ) =>
    run(
      "patch",
      async () => {
        await api.patch(`/api/tickets/${t.id}`, body);
        reload();
      },
      msg,
    );

  const send = (status: TicketStatus) =>
    run(`send-${status}`, async () => {
      if (mode === "note") {
        await api.post(`/api/tickets/${t.id}/notes`, { body: text });
        toast.ok("Notiz gespeichert");
      } else {
        const attachments = await Promise.all(files.map(async (f) => ({ filename: f.name, contentType: f.type || undefined, data: await fileToBase64(f) })));
        await api.post(`/api/tickets/${t.id}/reply`, { body: text, status, attachments });
        toast.ok(status === "CLOSED" ? "Antwort gesendet, Ticket erledigt" : `Antwort an ${t.contactEmail} gesendet`);
      }
      setText("");
      setFiles([]);
      reload();
    });

  const download = (attId: string) =>
    run(`f${attId}`, async () => {
      const f = await api.download(`/api/tickets/attachments/${attId}`);
      await saveFile(f.blob, decodeURIComponent(f.filename));
    });

  return (
    <>
      <PageHeader
        title={
          <span className="title-with-badge">
            {t.subject} <span className={`badge ${TICKET_STATUS[t.status].cls}`}>{TICKET_STATUS[t.status].label}</span>
          </span>
        }
        sub={
          <>
            {t.number}, {t.contactName ? `${t.contactName} <${t.contactEmail}>` : t.contactEmail}
          </>
        }
        actions={
          <>
            <Button variant="ghost" onClick={back}>
              Zurück
            </Button>
            {t.status !== "CLOSED" ? (
              <Button busy={busy === "patch"} onClick={() => patch({ status: "CLOSED" }, "Ticket erledigt")}>
                <Icon name="check" /> Erledigt
              </Button>
            ) : (
              <Button busy={busy === "patch"} onClick={() => patch({ status: "OPEN" }, "Ticket wieder geöffnet")}>
                Wieder öffnen
              </Button>
            )}
          </>
        }
      />

      <div className="detail-grid">
        <div className="detail-main">
          <div className="thread">
            {t.messages.map((m) => (
              <article key={m.id} className={`msg msg-${m.direction.toLowerCase()}`}>
                <header className="msg-head">
                  <span>
                    <span className="who">
                      {m.direction === "IN"
                        ? (m.fromName ?? m.fromEmail)
                        : m.direction === "NOTE"
                          ? `Notiz von ${m.authorName ?? "unbekannt"}`
                          : (m.authorName ?? "Automatische Eingangsbestätigung")}
                    </span>
                    {m.direction === "OUT" ? <span className="muted"> an {m.toEmail}</span> : null}
                    {m.direction === "IN" && m.fromName ? <span className="muted"> {m.fromEmail}</span> : null}
                  </span>
                  <span className="when">{dateTime(m.createdAt)}</span>
                </header>
                <div className="msg-body">{m.body || <span className="muted">(kein Text)</span>}</div>
                {m.attachments.length ? (
                  <div className="msg-files">
                    {m.attachments.map((a) => (
                      <button key={a.id} className="file-chip" onClick={() => download(a.id)} title="Speichern">
                        <Icon name="paperclip" />
                        {a.filename} <span className="muted">{size(a.size)}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </div>

          <div className="composer">
            <div className="composer-tabs" role="group" aria-label="Art der Nachricht">
              <button aria-pressed={mode === "reply"} onClick={() => setMode("reply")}>
                Antworten
              </button>
              <button aria-pressed={mode === "note"} onClick={() => setMode("note")}>
                Interne Notiz
              </button>
            </div>
            <textarea
              aria-label={mode === "reply" ? "Antwort" : "Notiz"}
              placeholder={mode === "reply" ? `Antwort an ${t.contactName ?? t.contactEmail} … (Signatur wird angehängt)` : "Nur für dein Team sichtbar"}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && text.trim()) void send(mode === "note" ? "OPEN" : "PENDING");
              }}
            />
            {files.length ? (
              <div className="msg-files" style={{ paddingTop: 10 }}>
                {files.map((f, i) => (
                  <span key={i} className="chip">
                    {f.name}
                    <button aria-label={`${f.name} entfernen`} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="composer-foot">
              {mode === "reply" ? (
                <>
                  <input ref={fileRef} type="file" multiple hidden onChange={(e) => setFiles((x) => [...x, ...Array.from(e.target.files ?? [])])} />
                  <Button variant="ghost" className="push-left" onClick={() => fileRef.current?.click()}>
                    <Icon name="paperclip" /> Anhang
                  </Button>
                  <Button disabled={!text.trim()} busy={busy === "send-CLOSED"} onClick={() => send("CLOSED")}>
                    Senden und erledigt
                  </Button>
                  <Button variant="primary" disabled={!text.trim()} busy={busy === "send-PENDING"} onClick={() => send("PENDING")}>
                    <Icon name="send" /> Senden
                  </Button>
                </>
              ) : (
                <Button variant="primary" disabled={!text.trim()} busy={busy === "send-OPEN"} onClick={() => send("OPEN")}>
                  <Icon name="note" /> Notiz speichern
                </Button>
              )}
            </div>
          </div>

          <TicketWork
            t={t}
            onStart={() => setTimeDlg("start")}
            onAddTime={() => setTimeDlg("new")}
            onEditTime={(e) => setTimeDlg(e)}
            onAddCharge={() => setChargeDlg("new")}
            onEditCharge={(c) => setChargeDlg(c)}
            billing={busy === "bill"}
            onBill={() =>
              run("bill", async () => {
                const r = await api.post<{ invoiceId: string }>(`/api/tickets/${t.id}/invoice`);
                toast.ok("Rechnungsentwurf erstellt");
                go({ name: "invoice", id: r.invoiceId });
              })
            }
          />
        </div>

        <aside className="detail-side">
          <dl className="facts">
            <div>
              <dt>Status</dt>
              <dd>
                <select aria-label="Status" value={t.status} onChange={(e) => patch({ status: e.target.value as TicketStatus })}>
                  {(Object.keys(TICKET_STATUS) as TicketStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {TICKET_STATUS[s].label}
                    </option>
                  ))}
                </select>
              </dd>
            </div>
            <div>
              <dt>Priorität</dt>
              <dd>
                <select aria-label="Priorität" value={t.priority} onChange={(e) => patch({ priority: e.target.value as TicketPriority })}>
                  {(Object.keys(TICKET_PRIORITY) as TicketPriority[]).map((p) => (
                    <option key={p} value={p}>{TICKET_PRIORITY[p].label}</option>
                  ))}
                </select>
              </dd>
            </div>
            {settings.tickets.categories.length || t.category ? (
              <div>
                <dt>Kategorie</dt>
                <dd>
                  <select aria-label="Kategorie" value={t.category ?? ""} onChange={(e) => patch({ category: e.target.value || null })}>
                    <option value="">Keine</option>
                    {[...new Set([...settings.tickets.categories, ...(t.category ? [t.category] : [])])].map((c) => <option key={c}>{c}</option>)}
                  </select>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Zuständig</dt>
              <dd>
                <select aria-label="Zuständig" value={t.assigneeId ?? ""} onChange={(e) => patch({ assigneeId: e.target.value || null })}>
                  <option value="">Niemand</option>
                  {t.users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                      {u.id === user.id ? " (du)" : ""}
                    </option>
                  ))}
                </select>
              </dd>
            </div>
            <div>
              <dt>Kunde</dt>
              <dd>
                <select aria-label="Kunde" value={t.customerId ?? ""} onChange={(e) => patch({ customerId: e.target.value || null }, "Kunde zugeordnet")}>
                  <option value="">Nicht zugeordnet</option>
                  {(customers.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {customerName(c)}
                    </option>
                  ))}
                </select>
              </dd>
            </div>
            {t.customerId && t.projects.length ? (
              <div>
                <dt>Projekt</dt>
                <dd>
                  <select aria-label="Projekt" value={t.projectId ?? ""} onChange={(e) => patch({ projectId: e.target.value || null })}>
                    <option value="">Kein Projekt</option>
                    {t.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Eröffnet</dt>
              <dd>{dateTime(t.createdAt)}</dd>
            </div>
          </dl>
          {t.customer ? (
            <div className="card-plain">
              <h3>{customerName(t.customer)}</h3>
              <p className="muted">
                {t.customer.number}
                {t.customer.phone ? (
                  <>
                    <br />
                    {t.customer.phone}
                  </>
                ) : null}
              </p>
              <div className="stack">
                <Button variant="ghost" onClick={() => go({ name: "customer", id: t.customer!.id })}>
                  Kunde öffnen
                </Button>
                <Button variant="ghost" onClick={() => go({ name: "invoice-edit", customerId: t.customer!.id })}>
                  Rechnung schreiben
                </Button>
              </div>
            </div>
          ) : (
            <p className="muted small">Der Absender ist noch keinem Kunden zugeordnet. Wähle oben einen Kunden oder lege ihn neu an.</p>
          )}
          {user.role === "ADMIN" ? (
            <Button variant="ghost" className="danger-text" onClick={() => setConfirmDelete(true)}>
              Ticket löschen
            </Button>
          ) : null}
        </aside>
      </div>

      {timeDlg === "start" ? (
        <StartTimerDialog
          preset={{ customerId: t.customerId, projectId: t.projectId, ticketId: t.id, ticketLabel: t.number, description: `${t.number}: ${t.subject}` }}
          onClose={() => setTimeDlg(null)}
          onStarted={() => {
            setTimeDlg(null);
            notifyTime();
          }}
        />
      ) : timeDlg ? (
        <TimeEntryDialog
          entry={timeDlg === "new" ? null : timeDlg}
          preset={{ customerId: t.customerId, projectId: t.projectId, ticketId: t.id, ticketLabel: t.number }}
          onClose={() => setTimeDlg(null)}
          onSaved={() => {
            setTimeDlg(null);
            notifyTime();
          }}
        />
      ) : null}
      {chargeDlg && t.customerId ? (
        <ChargeDialog
          charge={chargeDlg === "new" ? null : chargeDlg}
          preset={{ customerId: t.customerId, projectId: t.projectId, ticketId: t.id }}
          onClose={() => setChargeDlg(null)}
          onSaved={() => {
            setChargeDlg(null);
            reload();
          }}
        />
      ) : null}
      {confirmDelete ? (
        <Confirm
          title="Ticket löschen?"
          text="Das Ticket mit allen Nachrichten und Anhängen wird endgültig gelöscht. Die Mails im Postfach bleiben erhalten."
          confirmLabel="Löschen"
          danger
          busy={busy === "del"}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() =>
            run(
              "del",
              async () => {
                await api.del(`/api/tickets/${t.id}`);
                go({ name: "tickets" });
              },
              "Ticket gelöscht",
            )
          }
        />
      ) : null}
    </>
  );
}

function TicketWork({
  t,
  onStart,
  onAddTime,
  onEditTime,
  onAddCharge,
  onEditCharge,
  onBill,
  billing,
}: {
  t: TicketFull;
  onStart: () => void;
  onAddTime: () => void;
  onEditTime: (e: TimeEntry) => void;
  onAddCharge: () => void;
  onEditCharge: (c: Charge) => void;
  onBill: () => void;
  billing: boolean;
}) {
  const { go } = useNav();
  const openTime = t.time.filter((e) => !e.invoiceId && e.billable && !e.running);
  const openCharges = t.charges.filter((c) => !c.invoiceId);
  const running = t.time.some((e) => e.running);
  const totalMin = t.time.reduce((a, e) => a + e.minutes, 0);
  const canBill = !!t.customerId && (openTime.length > 0 || openCharges.length > 0) && !running;
  return (
    <section className="ticket-work">
      <header className="ticket-work-head">
        <h3>
          Zeit &amp; Material
          {totalMin ? <span className="muted"> · {fmtDuration(totalMin)} gesamt</span> : null}
        </h3>
        <div className="row-actions">
          <Button variant="ghost" className="btn-sm" disabled={!t.customerId || running} onClick={onStart} title={t.customerId ? undefined : "Erst einen Kunden zuordnen"}>
            <Icon name="play" /> Stoppuhr
          </Button>
          <Button variant="ghost" className="btn-sm" disabled={!t.customerId} onClick={onAddTime}>
            Zeit nachtragen
          </Button>
          <Button variant="ghost" className="btn-sm" disabled={!t.customerId} onClick={onAddCharge}>
            Material/Pauschale
          </Button>
          <Button variant="primary" className="btn-sm" disabled={!canBill} busy={billing} onClick={onBill} title={running ? "Erst die Stoppuhr anhalten" : undefined}>
            <Icon name="invoice" /> Abrechnen
          </Button>
        </div>
      </header>
      {!t.customerId ? (
        <p className="muted small">Ordne dem Ticket einen Kunden zu, dann kannst du Zeit und Material erfassen und als Rechnung stellen.</p>
      ) : t.time.length === 0 && t.charges.length === 0 ? (
        <p className="muted small">Noch nichts erfasst. „Abrechnen“ erstellt aus allen offenen Zeiten und Positionen einen Rechnungsentwurf.</p>
      ) : (
        <table className="table compact">
          <tbody>
            {t.time.map((e) => (
              <tr key={e.id} className={e.invoiceId ? "row-off" : ""} onClick={() => !e.invoiceId && onEditTime(e)} style={{ cursor: e.invoiceId ? "default" : "pointer" }}>
                <td className="nowrap muted">{date(e.date)}</td>
                <td>
                  <Icon name="clock" /> {e.description || <span className="muted">ohne Beschreibung</span>}
                  {e.userName ? <span className="muted"> · {e.userName}</span> : null}
                </td>
                <td className="num nowrap">{e.running ? <span className="badge badge-warn">läuft</span> : fmtDuration(e.minutes)}</td>
                <td className="nowrap">
                  {e.invoiceId ? (
                    <button className="link" onClick={(ev) => { ev.stopPropagation(); go({ name: "invoice", id: e.invoiceId! }); }}>{e.invoiceNumber ?? "Entwurf"}</button>
                  ) : !e.billable ? (
                    <span className="muted small">nicht berechnen</span>
                  ) : (
                    <span className="muted small">offen</span>
                  )}
                </td>
              </tr>
            ))}
            {t.charges.map((c) => (
              <tr key={c.id} className={c.invoiceId ? "row-off" : ""} onClick={() => !c.invoiceId && onEditCharge(c)} style={{ cursor: c.invoiceId ? "default" : "pointer" }}>
                <td className="nowrap muted">{date(c.date)}</td>
                <td>
                  <Icon name="box" /> {c.quantity} {c.unit} {c.name}
                </td>
                <td className="num nowrap">{money(c.amount)}</td>
                <td className="nowrap">
                  {c.invoiceId ? (
                    <button className="link" onClick={(ev) => { ev.stopPropagation(); go({ name: "invoice", id: c.invoiceId! }); }}>{c.invoiceNumber ?? "Entwurf"}</button>
                  ) : (
                    <span className="muted small">offen</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
