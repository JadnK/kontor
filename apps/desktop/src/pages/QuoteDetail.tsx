import { useState } from "react";
import { useAction, useApi, useLoad, useNav, useSession, useToast } from "../lib/store";
import { customerName, date, dateTime, money, num, percentFromBps } from "../lib/format";
import { saveAndOpen, saveFile } from "../lib/native";
import type { MailResult, QuoteFull } from "../lib/types";
import { Button, Confirm, ErrorBox, Loading, Modal, PageHeader, Section, TextArea, TextField, Toggle } from "../components/ui";
import { Icon } from "../components/Icon";
import { QuoteBadge } from "./Quotes";

export function QuoteDetail({ id }: { id: string }) {
  const api = useApi();
  const toast = useToast();
  const { go, back } = useNav();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const { data: q, error, loading, reload } = useLoad(() => api.get<QuoteFull>(`/api/quotes/${id}`), [id]);
  const [dialog, setDialog] = useState<null | "send" | "accept" | "decline" | "delete">(null);

  if (loading && !q) return <Loading />;
  if (error || !q) return <ErrorBox error={error ?? "Nicht gefunden"} onRetry={reload} />;

  const isDraft = q.status === "DRAFT";
  const mailReady = settings.mail.enabled && !!settings.mail.host;
  const pdf = (openAfter: boolean) =>
    run("pdf", async () => {
      const f = await api.download(`/api/quotes/${id}/pdf`);
      const path = openAfter ? await saveAndOpen(f.blob, f.filename) : await saveFile(f.blob, f.filename);
      if (path && !openAfter) toast.ok(`Gespeichert: ${path}`);
    });
  const toInvoice = () =>
    run("inv", async () => {
      const r = await api.post<{ invoiceId: string }>(`/api/quotes/${id}/invoice`);
      go({ name: "invoice-edit", id: r.invoiceId });
    }, "Rechnungsentwurf aus dem Angebot erstellt");

  return (
    <>
      <PageHeader
        title={
          <span className="title-with-badge">
            {q.number ? `Angebot ${q.number}` : "Angebotsentwurf"} <QuoteBadge status={q.status} expired={q.expired} />
          </span>
        }
        sub={
          <button className="link" onClick={() => go({ name: "customer", id: q.customerId })}>
            {customerName(q.customer)} ({q.customer.number})
          </button>
        }
        actions={
          <>
            <Button variant="ghost" onClick={back}>Zurück</Button>
            <Button busy={busy === "pdf"} onClick={() => pdf(true)}>PDF öffnen</Button>
            {isDraft ? (
              <>
                <Button onClick={() => go({ name: "quote-edit", id })}>Bearbeiten</Button>
                <Button variant="primary" onClick={() => setDialog("send")}>Angebot senden</Button>
              </>
            ) : null}
            {q.status === "SENT" ? <Button onClick={() => setDialog("accept")}>Als angenommen markieren</Button> : null}
            {q.status === "ACCEPTED" || (q.status === "SENT" && !q.expired) ? (
              <Button variant="primary" busy={busy === "inv"} onClick={toInvoice}>In Rechnung umwandeln</Button>
            ) : null}
            {q.invoice ? <Button variant="primary" onClick={() => go({ name: "invoice", id: q.invoice!.id })}>Rechnung {q.invoice.number ?? "(Entwurf)"} öffnen</Button> : null}
          </>
        }
      />

      {q.status === "ACCEPTED" || q.status === "DECLINED" ? (
        <div className={`hint ${q.status === "ACCEPTED" ? "hint-info" : "hint-danger"}`}>
          <span>
            {q.status === "ACCEPTED" ? "Angenommen" : "Abgelehnt"} von <strong>{q.answeredBy}</strong> am {dateTime(q.answeredAt)}
            {q.answerNote ? <> – „{q.answerNote}“</> : null}
          </span>
        </div>
      ) : null}
      {q.expired ? (
        <div className="hint hint-danger">
          <span>Das Angebot ist am {date(q.validUntil)} abgelaufen. Der Kunde kann es nicht mehr online annehmen.</span>
          <Button variant="ghost" onClick={() => run("dup", async () => {
            const r = await api.post<{ id: string }>(`/api/quotes/${id}/duplicate`);
            go({ name: "quote-edit", id: r.id });
          }, "Kopie als neuer Entwurf angelegt")}>Neu auflegen</Button>
        </div>
      ) : null}
      {q.publicUrl && q.status === "SENT" && !q.expired ? (
        <div className="link-box">
          <Icon name="link" />
          <div>
            <strong>Link zur Online-Annahme</strong>
            <span className="mono">{q.publicUrl}</span>
          </div>
          <Button onClick={() => { void navigator.clipboard.writeText(q.publicUrl!); toast.ok("Link kopiert"); }}>Kopieren</Button>
        </div>
      ) : null}
      {q.exemption ? (
        <div className="exemption-note">
          <small>Hinweis zur Umsatzsteuer</small>
          {q.exemption.text}
        </div>
      ) : null}

      <div className="detail-grid">
        <div className="detail-main">
          {q.subject ? <p className="lead">{q.subject}</p> : null}
          <table className="table">
            <thead>
              <tr>
                <th className="w-pos">Pos.</th>
                <th>Bezeichnung</th>
                <th className="num">Menge</th>
                {!q.smallBusiness ? <th className="num">USt.</th> : null}
                <th className="num">Einzelpreis</th>
                <th className="num">Gesamt</th>
              </tr>
            </thead>
            <tbody>
              {q.items.map((it, i) => (
                <tr key={it.id ?? i}>
                  <td className="muted">{i + 1}</td>
                  <td>
                    <strong>{it.name}</strong>
                    {it.description ? <div className="sub">{it.description}</div> : null}
                    {it.discountBps ? <div className="sub">abzgl. {percentFromBps(it.discountBps)} % Rabatt</div> : null}
                  </td>
                  <td className="num nowrap">{num(it.quantity)} {it.unit}</td>
                  {!q.smallBusiness ? <td className="num">{num(it.taxRate)} %</td> : null}
                  <td className="num">{money(it.unitPriceNet)}</td>
                  <td className="num">{money(it.lineNet)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="totals-row">
            <div />
            <dl className="totals">
              {q.discountTotal ? <div><dt>Rabatt</dt><dd>- {money(Math.abs(q.discountTotal))}</dd></div> : null}
              {!q.smallBusiness ? (
                <>
                  <div><dt>Netto</dt><dd>{money(q.totalNet)}</dd></div>
                  {(q.taxBreakdown ?? []).map((t) => <div key={t.rate}><dt>USt. {num(t.rate)} %</dt><dd>{money(t.tax)}</dd></div>)}
                </>
              ) : null}
              <div className="grand"><dt>Angebotssumme</dt><dd>{money(q.totalGross)}</dd></div>
            </dl>
          </div>
          <Section title="E-Mail-Verlauf">
            {q.mails.length === 0 ? (
              <p className="muted">{isDraft ? "Entwürfe werden nicht verschickt." : "Keine E-Mail zu diesem Angebot."}</p>
            ) : (
              <table className="table compact">
                <tbody>
                  {q.mails.map((m) => (
                    <tr key={m.id}>
                      <td className="nowrap muted">{dateTime(m.createdAt)}</td>
                      <td>{m.subject}</td>
                      <td>{m.to}</td>
                      <td>{m.status === "SENT" ? <span className="badge badge-paid">Gesendet</span> : <span className="badge badge-danger" title={m.error ?? ""}>Fehler</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </div>
        <aside className="detail-side">
          <dl className="facts">
            <div><dt>Angebotsdatum</dt><dd>{date(q.issueDate) || "beim Senden"}</dd></div>
            <div><dt>Gültig bis</dt><dd className={q.expired ? "text-danger" : ""}>{date(q.validUntil) || `${settings.quotes.validDays} Tage nach Versand`}</dd></div>
            {q.serviceDateFrom ? <div><dt>Leistung</dt><dd>{date(q.serviceDateFrom)}{q.serviceDateTo ? ` – ${date(q.serviceDateTo)}` : ""}</dd></div> : null}
            {q.sentAt ? <div><dt>Gesendet</dt><dd>{dateTime(q.sentAt)}</dd></div> : null}
            {q.viewedAt ? <div><dt>Vom Kunden geöffnet</dt><dd>{dateTime(q.viewedAt)}</dd></div> : null}
          </dl>
          <div className="side-actions">
            <Button variant="ghost" busy={busy === "pdf"} onClick={() => pdf(false)}>PDF speichern</Button>
            {q.status === "SENT" && mailReady ? <Button variant="ghost" onClick={() => setDialog("send")}>Erneut senden</Button> : null}
            {q.status === "SENT" ? <Button variant="ghost" onClick={() => setDialog("decline")}>Als abgelehnt markieren</Button> : null}
            {q.status === "ACCEPTED" || q.status === "DECLINED" ? (
              <Button variant="ghost" busy={busy === "reopen"} onClick={() => run("reopen", async () => { await api.post(`/api/quotes/${id}/status`, { status: "SENT" }); reload(); }, "Wieder offen")}>
                Antwort zurücksetzen
              </Button>
            ) : null}
            <Button variant="ghost" busy={busy === "dup"} onClick={() => run("dup", async () => {
              const r = await api.post<{ id: string }>(`/api/quotes/${id}/duplicate`);
              go({ name: "quote-edit", id: r.id });
            }, "Kopie als Entwurf angelegt")}>Als Vorlage kopieren</Button>
            {isDraft ? <Button variant="ghost" className="danger-text" onClick={() => setDialog("delete")}>Entwurf löschen</Button> : null}
          </div>
        </aside>
      </div>

      {dialog === "send" ? <SendQuoteDialog quote={q} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} /> : null}
      {dialog === "accept" || dialog === "decline" ? (
        <AnswerDialog quoteId={id} accept={dialog === "accept"} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />
      ) : null}
      {dialog === "delete" ? (
        <Confirm
          title="Entwurf löschen?"
          text="Der Angebotsentwurf wird endgültig gelöscht."
          confirmLabel="Löschen"
          danger
          busy={busy === "del"}
          onCancel={() => setDialog(null)}
          onConfirm={() => run("del", async () => { await api.del(`/api/quotes/${id}`); go({ name: "quotes" }); }, "Entwurf gelöscht")}
        />
      ) : null}
    </>
  );
}

function SendQuoteDialog({ quote, onClose, onDone }: { quote: QuoteFull; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const toast = useToast();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const canMail = settings.mail.enabled && !!settings.mail.host;
  const [send, setSend] = useState(canMail && !!quote.customer.email);
  const [to, setTo] = useState(quote.customer.email ?? "");
  const first = quote.status === "DRAFT";
  return (
    <Modal
      title={first ? "Angebot senden" : "Angebot erneut senden"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            busy={busy === "send"}
            onClick={() => run("send", async () => {
              const r = await api.post<{ mail: MailResult | null }>(`/api/quotes/${quote.id}/send`, { send, to: send && to ? to : undefined });
              if (r.mail && !r.mail.ok) toast.error(`Festgeschrieben, aber nicht gesendet: ${r.mail.error ?? r.mail.skipped}`);
              else toast.ok(send ? "Angebot gesendet" : "Angebot festgeschrieben");
              onDone();
            })}
          >
            {send ? "Senden" : "Nur festschreiben"}
          </Button>
        </>
      }
    >
      {first ? <p>Das Angebot bekommt eine Nummer, ist {settings.quotes.validDays} Tage gültig (falls kein Datum gesetzt) und kann danach nicht mehr geändert werden.</p> : null}
      <Toggle label="Per E-Mail mit Link zur Online-Annahme senden" checked={send} onChange={setSend} hint={canMail ? undefined : "E-Mail-Versand ist nicht eingerichtet"} />
      {send ? <TextField label="Empfänger" type="email" value={to} onChange={setTo} /> : <p className="muted small">Den Link zur Annahme findest du danach hier im Angebot, z. B. zum Versand per Messenger.</p>}
    </Modal>
  );
}

function AnswerDialog({ quoteId, accept, onClose, onDone }: { quoteId: string; accept: boolean; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [note, setNote] = useState("");
  return (
    <Modal
      title={accept ? "Als angenommen markieren" : "Als abgelehnt markieren"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button variant={accept ? "primary" : "danger"} busy={busy === "a"} onClick={() => run("a", async () => {
            await api.post(`/api/quotes/${quoteId}/status`, { status: accept ? "ACCEPTED" : "DECLINED", note: note || undefined });
            onDone();
          }, accept ? "Als angenommen markiert" : "Als abgelehnt markiert")}>
            {accept ? "Angenommen" : "Abgelehnt"}
          </Button>
        </>
      }
    >
      <p className="muted">Zum Beispiel, wenn der Kunde telefonisch oder per Mail zugesagt hat.</p>
      <TextArea label="Notiz (optional)" value={note} onChange={setNote} rows={2} />
    </Modal>
  );
}
