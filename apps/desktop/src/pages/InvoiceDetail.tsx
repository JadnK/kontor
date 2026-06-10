import { useState } from "react";
import { useAction, useApi, useLoad, useNav, useSession, useToast } from "../lib/store";
import { customerName, date, dateTime, money, num, percentFromBps, todayIso } from "../lib/format";
import { saveAndOpen, saveFile } from "../lib/native";
import type { DunningInfo, InvoiceFull, MailResult } from "../lib/types";
import { Button, Confirm, ErrorBox, Loading, Modal, MoneyField, PageHeader, Section, StatusBadge, TextField, Toggle } from "../components/ui";
import { PayLinkCard } from "../components/PublicLinks";

const MAIL_KIND: Record<string, string> = {
  invoice: "Rechnung",
  reminder: "Zahlungserinnerung",
  payment: "Zahlungsbestätigung",
  cancellation: "Stornorechnung",
  discount: "Rabatt",
  welcome: "Willkommen",
  test: "Test",
  dunning: "Mahnung",
  quote: "Angebot",
};

export function InvoiceDetail({ id }: { id: string }) {
  const api = useApi();
  const toast = useToast();
  const { go, back } = useNav();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const { data: inv, error, loading, reload } = useLoad(() => api.get<InvoiceFull>(`/api/invoices/${id}`), [id]);
  const [dialog, setDialog] = useState<null | "pay" | "cancel" | "delete" | "send" | "remind" | "issue" | "dunning">(null);

  if (loading && !inv) return <Loading />;
  if (error || !inv) return <ErrorBox error={error ?? "Nicht gefunden"} onRetry={reload} />;

  const isDraft = inv.status === "DRAFT";
  const isStorno = inv.kind === "CANCELLATION";
  const open = inv.totalGross - inv.paidTotal;
  const overdue = inv.status === "ISSUED" && !isStorno && !!inv.dueDate && inv.dueDate < todayIso();
  const mailReady = settings.mail.enabled && !!settings.mail.host;

  const download = (kind: "pdf" | "xrechnung", openAfter = false) =>
    run(kind, async () => {
      const f = await api.download(`/api/invoices/${id}/${kind}`);
      const path = openAfter ? await saveAndOpen(f.blob, f.filename) : await saveFile(f.blob, f.filename);
      if (path && !openAfter) toast.ok(`Gespeichert: ${path}`);
    });

  const title = isStorno ? `Stornorechnung ${inv.number}` : inv.number ? `Rechnung ${inv.number}` : "Rechnungsentwurf";

  return (
    <>
      <PageHeader
        title={
          <span className="title-with-badge">
            {title} <StatusBadge status={inv.status} overdue={overdue} kind={inv.kind} />
          </span>
        }
        sub={
          <button className="link" onClick={() => go({ name: "customer", id: inv.customerId })}>
            {customerName(inv.customer)} ({inv.customer.number})
          </button>
        }
        actions={
          <>
            <Button variant="ghost" onClick={back}>Zurück</Button>
            <Button busy={busy === "pdf"} onClick={() => download("pdf", true)}>PDF öffnen</Button>
            {isDraft ? (
              <>
                <Button onClick={() => go({ name: "invoice-edit", id })}>Bearbeiten</Button>
                <Button variant="primary" onClick={() => setDialog("issue")}>Ausstellen</Button>
              </>
            ) : null}
            {inv.status === "ISSUED" && !isStorno ? (
              <Button variant="primary" onClick={() => setDialog("pay")}>Zahlung erfassen</Button>
            ) : null}
          </>
        }
      />

      {inv.cancelledBy ? (
        <div className="hint">
          <span>Diese Rechnung wurde storniert.</span>
          <Button variant="ghost" onClick={() => go({ name: "invoice", id: inv.cancelledBy!.id })}>Stornorechnung {inv.cancelledBy.number} öffnen</Button>
        </div>
      ) : null}
      {inv.original ? (
        <div className="hint">
          <span>Storniert die Rechnung {inv.original.number}.</span>
          <Button variant="ghost" onClick={() => go({ name: "invoice", id: inv.original!.id })}>Original öffnen</Button>
        </div>
      ) : null}
      {inv.quoteId || inv.recurringId ? (
        <div className="hint hint-info">
          <span>{inv.quoteId ? "Erstellt aus einem Angebot." : "Erstellt aus einer Abo-Rechnung."}</span>
          <Button variant="ghost" onClick={() => go(inv.quoteId ? { name: "quote", id: inv.quoteId } : { name: "recurring" })}>
            {inv.quoteId ? "Angebot öffnen" : "Abo-Rechnungen"}
          </Button>
        </div>
      ) : null}
      {inv.exemption ? (
        <div className="exemption-note">
          <small>{isDraft ? "Wird beim Ausstellen auf die Rechnung gedruckt" : "Hinweis zur Umsatzsteuer auf der Rechnung"}</small>
          {inv.exemption.text}
        </div>
      ) : null}
      {!isDraft && settings.invoice.attachXRechnung && inv.xrechnungIssues.length ? (
        <div className="hint hint-warn">
          <span>Für eine gültige E-Rechnung fehlt: {inv.xrechnungIssues.join(", ")}.</span>
        </div>
      ) : null}

      <div className="detail-grid">
        <div className="detail-main">
          {inv.subject ? <p className="lead">{inv.subject}</p> : null}
          <table className="table">
            <thead>
              <tr>
                <th className="w-pos">Pos.</th>
                <th>Bezeichnung</th>
                <th className="num">Menge</th>
                {!inv.smallBusiness ? <th className="num">USt.</th> : null}
                <th className="num">Einzelpreis</th>
                <th className="num">Gesamt</th>
              </tr>
            </thead>
            <tbody>
              {inv.items.map((it, i) => (
                <tr key={it.id ?? i}>
                  <td className="muted">{i + 1}</td>
                  <td>
                    <strong>{it.name}</strong>
                    {it.description ? <div className="sub">{it.description}</div> : null}
                    {it.discountBps ? <div className="sub">abzgl. {percentFromBps(it.discountBps)} % Rabatt</div> : null}
                  </td>
                  <td className="num nowrap">{num(it.quantity)} {it.unit}</td>
                  {!inv.smallBusiness ? <td className="num">{num(it.taxRate)} %</td> : null}
                  <td className="num">{money(it.unitPriceNet)}</td>
                  <td className="num">{money(it.lineNet)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="totals-row">
            <div />
            <dl className="totals">
              {inv.discountTotal ? (
                <>
                  <div><dt>Zwischensumme</dt><dd>{money(inv.subtotalNet)}</dd></div>
                  <div><dt>Rabatt{inv.discountSnapshot ? ` ${inv.discountSnapshot.name}` : ""}</dt><dd>- {money(Math.abs(inv.discountTotal))}</dd></div>
                </>
              ) : null}
              {!inv.smallBusiness ? (
                <>
                  <div><dt>Netto</dt><dd>{money(inv.totalNet)}</dd></div>
                  {(inv.taxBreakdown ?? []).map((t) => (
                    <div key={t.rate}><dt>USt. {num(t.rate)} %</dt><dd>{money(t.tax)}</dd></div>
                  ))}
                </>
              ) : null}
              <div className="grand"><dt>Gesamt</dt><dd>{money(inv.totalGross)}</dd></div>
              {inv.paidTotal > 0 && !isStorno && inv.status !== "CANCELLED" ? (
                <>
                  <div><dt>Bezahlt</dt><dd>{money(inv.paidTotal)}</dd></div>
                  <div className="grand"><dt>Offen</dt><dd>{money(Math.max(0, open))}</dd></div>
                </>
              ) : null}
            </dl>
          </div>

          {!isStorno && !isDraft ? (
            <Section title="Zahlungen">
              {inv.payments.length === 0 ? (
                <p className="muted">Noch keine Zahlung eingegangen.</p>
              ) : (
                <table className="table compact">
                  <tbody>
                    {inv.payments.map((p) => (
                      <tr key={p.id}>
                        <td className="nowrap muted">{date(p.date)}</td>
                        <td>{p.method}</td>
                        <td>{p.description}</td>
                        <td className="num">{money(p.amount)}</td>
                        <td className="row-actions">
                          <button
                            className="icon-btn"
                            aria-label="Zahlung löschen"
                            title="Zahlung löschen"
                            onClick={() => run("delpay", async () => { await api.del(`/api/income/${p.id}`); reload(); }, "Zahlung gelöscht")}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          ) : null}

          {!isStorno && (inv.dunnings.length || inv.nextDunning) ? (
            <Section title="Mahnungen">
              {inv.dunnings.length ? (
                <table className="table compact">
                  <tbody>
                    {inv.dunnings.map((d) => (
                      <tr key={d.id}>
                        <td className="nowrap muted">{date(d.sentAt ?? d.createdAt)}</td>
                        <td><strong>{d.label}</strong>{d.sentAt ? null : <span className="sub-inline">nicht per Mail</span>}</td>
                        <td className="muted">Forderung {money(d.claim)}, zahlbar bis {date(d.payUntil)}</td>
                        <td className="row-actions">
                          <Button variant="ghost" className="btn-sm" busy={busy === `dp${d.id}`} onClick={() => run(`dp${d.id}`, async () => {
                            const f = await api.download(`/api/dunnings/${d.id}/pdf`);
                            await saveAndOpen(f.blob, f.filename);
                          })}>PDF</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              {inv.nextDunning ? (
                <div className="dunning-next">
                  <DunningSummary d={inv.nextDunning} />
                  <Button variant="primary" onClick={() => setDialog("dunning")}>{inv.nextDunning.label} erstellen</Button>
                </div>
              ) : inv.dunnings.length && inv.status === "ISSUED" ? (
                <p className="muted small">Alle eingerichteten Mahnstufen sind ausgeschöpft. Nächster Schritt wäre ein gerichtliches Mahnverfahren (online-mahnantrag.de).</p>
              ) : null}
            </Section>
          ) : null}

          <Section title="E-Mail-Verlauf">
            {inv.mails.length === 0 ? (
              <p className="muted">{isDraft ? "Entwürfe werden nicht verschickt." : "Noch keine E-Mail zu dieser Rechnung."}</p>
            ) : (
              <table className="table compact">
                <tbody>
                  {inv.mails.map((m) => (
                    <tr key={m.id}>
                      <td className="nowrap muted">{dateTime(m.createdAt)}</td>
                      <td>{MAIL_KIND[m.kind] ?? m.kind}</td>
                      <td>{m.to}</td>
                      <td>
                        {m.status === "SENT" ? <span className="badge badge-paid">Gesendet</span> : <span className="badge badge-danger" title={m.error ?? ""}>Fehler</span>}
                        {m.error ? <div className="sub text-danger">{m.error}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </div>

        <aside className="detail-side">
          <dl className="facts">
            <div><dt>Rechnungsdatum</dt><dd>{date(inv.issueDate) || "beim Ausstellen"}</dd></div>
            {!isStorno ? <div><dt>Fällig</dt><dd className={overdue ? "text-danger" : ""}>{date(inv.dueDate) || `${settings.invoice.paymentDays} Tage nach Ausstellung`}</dd></div> : null}
            {inv.serviceDateFrom ? (
              <div>
                <dt>Leistung</dt>
                <dd>{date(inv.serviceDateFrom)}{inv.serviceDateTo && inv.serviceDateTo !== inv.serviceDateFrom ? ` – ${date(inv.serviceDateTo)}` : ""}</dd>
              </div>
            ) : null}
            {inv.sentAt ? <div><dt>Versendet</dt><dd>{dateTime(inv.sentAt)}</dd></div> : null}
            {inv.reminderCount ? <div><dt>Erinnerungen</dt><dd>{inv.reminderCount}</dd></div> : null}
          </dl>
          {!isDraft && !isStorno ? <PayLinkCard invoiceId={inv.id} status={inv.status} /> : null}
          <div className="side-actions">
            <Button variant="ghost" busy={busy === "pdf"} onClick={() => download("pdf")}>PDF speichern</Button>
            {!isDraft ? <Button variant="ghost" busy={busy === "xrechnung"} onClick={() => download("xrechnung")}>E-Rechnung (XML) speichern</Button> : null}
            {!isDraft && mailReady ? <Button variant="ghost" onClick={() => setDialog("send")}>Erneut per E-Mail senden</Button> : null}
            {inv.status === "ISSUED" && !isStorno && mailReady ? <Button variant="ghost" onClick={() => setDialog("remind")}>Zahlungserinnerung senden</Button> : null}
            {!isStorno && !isDraft ? (
              <Button variant="ghost" busy={busy === "dup"} onClick={() => run("dup", async () => {
                const r = await api.post<{ id: string }>(`/api/invoices/${id}/duplicate`);
                go({ name: "invoice-edit", id: r.id });
              }, "Kopie als Entwurf angelegt")}>Als Vorlage kopieren</Button>
            ) : null}
            {(inv.status === "ISSUED" || inv.status === "PAID") && !isStorno ? (
              <Button variant="ghost" className="danger-text" onClick={() => setDialog("cancel")}>Stornieren</Button>
            ) : null}
            {isDraft ? <Button variant="ghost" className="danger-text" onClick={() => setDialog("delete")}>Entwurf löschen</Button> : null}
          </div>
        </aside>
      </div>

      {dialog === "pay" ? <PaymentDialog invoice={inv} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); reload(); }} /> : null}
      {dialog === "issue" ? (
        <Confirm
          title="Rechnung ausstellen?"
          text={
            <p>
              Die Rechnung bekommt eine fortlaufende Nummer und kann danach nicht mehr geändert werden.
              {settings.automation.sendInvoiceOnIssue && mailReady && inv.customer.email ? ` Sie wird an ${inv.customer.email} gesendet.` : ""}
            </p>
          }
          confirmLabel="Ausstellen"
          busy={busy === "issue"}
          onCancel={() => setDialog(null)}
          onConfirm={() =>
            run("issue", async () => {
              const r = await api.post<{ mail: MailResult | null }>(`/api/invoices/${id}/issue`, { send: true });
              if (r.mail?.error) toast.error(`Ausgestellt, aber E-Mail fehlgeschlagen: ${r.mail.error}`);
              else toast.ok(r.mail?.ok ? "Ausgestellt und gesendet" : "Rechnung ausgestellt");
              setDialog(null);
              reload();
            })
          }
        />
      ) : null}
      {dialog === "dunning" && inv.nextDunning ? (
        <DunningDialog invoice={inv} info={inv.nextDunning} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />
      ) : null}
      {dialog === "send" ? <SendDialog invoice={inv} mode="send" onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} /> : null}
      {dialog === "remind" ? <SendDialog invoice={inv} mode="remind" onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} /> : null}
      {dialog === "cancel" ? (
        <CancelDialog invoice={inv} onClose={() => setDialog(null)} onDone={(stornoId) => { setDialog(null); go({ name: "invoice", id: stornoId }); }} />
      ) : null}
      {dialog === "delete" ? (
        <Confirm
          title="Entwurf löschen?"
          text="Der Entwurf wird endgültig gelöscht."
          confirmLabel="Löschen"
          danger
          busy={busy === "del"}
          onCancel={() => setDialog(null)}
          onConfirm={() => run("del", async () => { await api.del(`/api/invoices/${id}`); go({ name: "invoices" }); }, "Entwurf gelöscht")}
        />
      ) : null}
    </>
  );
}

function PaymentDialog({ invoice, onClose, onSaved }: { invoice: InvoiceFull; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const [amount, setAmount] = useState<number | null>(invoice.totalGross - invoice.paidTotal);
  const [day, setDay] = useState(todayIso());
  const [method, setMethod] = useState("Überweisung");
  const [note, setNote] = useState("");
  const canMail = settings.mail.enabled && !!invoice.customer.email;
  const [confirm, setConfirm] = useState(settings.automation.sendPaymentConfirmation && canMail);

  return (
    <Modal
      title="Zahlung erfassen"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            busy={busy === "pay"}
            onClick={() => run("pay", async () => {
              await api.post(`/api/invoices/${invoice.id}/payments`, { date: day, amount: amount ?? 0, method, description: note || undefined, sendConfirmation: confirm });
              onSaved();
            }, "Zahlung erfasst")}
          >
            Zahlung erfassen
          </Button>
        </>
      }
    >
      <div className="grid-2">
        <MoneyField label="Betrag" value={amount} onChange={setAmount} hint={`Offen: ${money(invoice.totalGross - invoice.paidTotal)}`} />
        <TextField label="Zahlungsdatum" type="date" value={day} onChange={setDay} />
        <div className="field">
          <label htmlFor="method">Zahlungsart</label>
          <input id="method" list="methods" value={method} onChange={(e) => setMethod(e.target.value)} />
          <datalist id="methods">
            {["Überweisung", "Bar", "EC-Karte", "Kreditkarte", "PayPal", "Lastschrift"].map((m) => <option key={m} value={m} />)}
          </datalist>
        </div>
        <TextField label="Notiz" value={note} onChange={setNote} placeholder={`Zahlung zu ${invoice.number}`} />
        <div className="span-2">
          <Toggle
            label="Zahlungsbestätigung an den Kunden senden"
            checked={confirm}
            onChange={setConfirm}
            hint={canMail ? invoice.customer.email : "Nicht möglich – E-Mail-Versand aus oder keine Kunden-E-Mail"}
          />
        </div>
      </div>
      <p className="muted small">Die Zahlung wird automatisch als Einnahme gebucht. Ist der Betrag vollständig bezahlt, wechselt die Rechnung auf „Bezahlt“.</p>
    </Modal>
  );
}

function SendDialog({ invoice, mode, onClose, onDone }: { invoice: InvoiceFull; mode: "send" | "remind"; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [to, setTo] = useState(invoice.customer.email ?? "");
  return (
    <Modal
      title={mode === "send" ? "Rechnung per E-Mail senden" : "Zahlungserinnerung senden"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            busy={busy === "send"}
            onClick={() => run("send", async () => {
              if (mode === "send") await api.post(`/api/invoices/${invoice.id}/send`, { to: to || undefined });
              else await api.post(`/api/invoices/${invoice.id}/remind`);
              onDone();
            }, mode === "send" ? "E-Mail gesendet" : "Zahlungserinnerung gesendet")}
          >
            {mode === "send" ? "Senden" : "Erinnerung senden"}
          </Button>
        </>
      }
    >
      {mode === "send" ? (
        <TextField label="Empfänger" type="email" value={to} onChange={setTo} hint="Standard ist die E-Mail des Kunden" />
      ) : (
        <p>
          Die Vorlage „Zahlungserinnerung“ wird mit der Rechnung als PDF an <strong>{invoice.customer.email}</strong> geschickt. Offener Betrag:{" "}
          <strong>{money(invoice.totalGross - invoice.paidTotal)}</strong>.
        </p>
      )}
    </Modal>
  );
}

function CancelDialog({ invoice, onClose, onDone }: { invoice: InvoiceFull; onClose: () => void; onDone: (id: string) => void }) {
  const api = useApi();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const [send, setSend] = useState(settings.mail.enabled && !!invoice.customer.email);
  return (
    <Modal
      title={`Rechnung ${invoice.number} stornieren`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button
            variant="danger"
            busy={busy === "cancel"}
            onClick={() => run("cancel", async () => {
              const r = await api.post<{ id: string }>(`/api/invoices/${invoice.id}/cancel`, { send });
              onDone(r.id);
            }, "Stornorechnung erstellt")}
          >
            Stornieren
          </Button>
        </>
      }
    >
      <p>Es wird eine Stornorechnung mit eigener Nummer und negativen Beträgen erzeugt. Die ursprüngliche Rechnung bleibt erhalten und wird als storniert markiert.</p>
      {invoice.paidTotal > 0 ? (
        <p className="text-warn">Auf diese Rechnung wurden bereits {money(invoice.paidTotal)} gezahlt. Eine Rückzahlung musst du selbst veranlassen.</p>
      ) : null}
      <Toggle label="Stornorechnung an den Kunden senden" checked={send} onChange={setSend} hint={invoice.customer.email ?? "Keine Kunden-E-Mail"} />
    </Modal>
  );
}

function DunningSummary({ d }: { d: DunningInfo }) {
  return (
    <dl className="dunning-sum">
      <div><dt>Offen</dt><dd>{money(d.open)}</dd></div>
      {d.fees ? <div><dt>Mahngebühren</dt><dd>{money(d.fees)}</dd></div> : null}
      {d.interest ? <div><dt>Zinsen {num(d.interestRate ?? 0)} % · {d.interestDays} Tage</dt><dd>{money(d.interest)}</dd></div> : null}
      {d.flatFee ? <div><dt>Verzugspauschale</dt><dd>{money(d.flatFee)}</dd></div> : null}
      <div className="grand"><dt>Forderung</dt><dd>{money(d.claim)}</dd></div>
    </dl>
  );
}

function DunningDialog({ invoice, info, onClose, onDone }: { invoice: InvoiceFull; info: DunningInfo; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const toast = useToast();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const canMail = settings.mail.enabled && !!settings.mail.host && !!invoice.customer.email;
  const [send, setSend] = useState(canMail);
  return (
    <Modal
      title={`${info.label} zu ${invoice.number}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            busy={busy === "d"}
            onClick={() => run("d", async () => {
              const r = await api.post<{ dunning: { id: string } }>(`/api/invoices/${invoice.id}/dunning`, { send });
              if (!send) {
                const f = await api.download(`/api/dunnings/${r.dunning.id}/pdf`);
                await saveAndOpen(f.blob, f.filename);
              }
              toast.ok(send ? `${info.label} gesendet` : `${info.label} erstellt`);
              onDone();
            })}
          >
            {send ? "Mahnung senden" : "Mahnung als PDF erstellen"}
          </Button>
        </>
      }
    >
      <DunningSummary d={info} />
      <p className="muted small">
        Zahlbar bis {date(info.payUntil)}. {info.interest ? `Verzugszinsen: Basiszinssatz ${num(settings.automation.baseRate)} % + ${invoice.customer.type === "COMPANY" ? 9 : 5} Prozentpunkte (§ 288 BGB). ` : ""}
        Mahnung und Rechnung gehen als PDF mit, auf der Mahnung steht ein GiroCode über die Gesamtforderung.
      </p>
      <Toggle label="Per E-Mail senden" checked={send} onChange={setSend} hint={canMail ? invoice.customer.email ?? "" : "Nicht möglich – E-Mail-Versand aus oder keine Kunden-E-Mail. Die Mahnung wird als PDF erstellt (z. B. für den Postversand)."} />
    </Modal>
  );
}
