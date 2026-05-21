import { useState } from "react";
import { useAction, useApi, useLoad, useNav } from "../lib/store";
import { customerName, date, dateTime, money } from "../lib/format";
import type { BillingOpen, Customer, Discount, Income, MailLog, Project, TicketStatus } from "../lib/types";
import { BillingDialog, fmtDuration } from "../components/TimeTracking";
import { ProjectDialog } from "./Time";
import { PortalCard } from "../components/PublicLinks";
import { CustomerContracts } from "./Contracts";
import { TICKET_STATUS } from "./Tickets";
import { Button, Confirm, ErrorBox, Loading, PageHeader, Section, StatusBadge } from "../components/ui";
import { CustomerForm } from "./Customers";
import { DiscountForm, discountLabel } from "./Discounts";

interface Detail extends Customer {
  invoices: { id: string; number: string | null; kind: "INVOICE" | "CANCELLATION"; status: "DRAFT" | "ISSUED" | "PAID" | "CANCELLED"; issueDate: string | null; dueDate: string | null; totalGross: number; paidTotal: number }[];
  incomes: Income[];
  discounts: Discount[];
  mails: MailLog[];
  tickets: { id: string; number: string; subject: string; status: TicketStatus; lastMessageAt: string }[];
}

export function CustomerDetail({ id }: { id: string }) {
  const api = useApi();
  const { go, back } = useNav();
  const { busy, run } = useAction();
  const { data, error, loading, reload } = useLoad(() => api.get<Detail>(`/api/customers/${id}`), [id]);
  const [edit, setEdit] = useState(false);
  const [newDiscount, setNewDiscount] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const projects = useLoad(() => api.get<Project[]>(`/api/projects?customerId=${id}&all=1`), [id]);
  const billing = useLoad(() => api.get<BillingOpen[]>("/api/billing/open"), [id]);
  const [projectDlg, setProjectDlg] = useState<Project | "new" | null>(null);
  const [billDlg, setBillDlg] = useState(false);

  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox error={error ?? "Nicht gefunden"} onRetry={reload} />;

  const today = new Date().toISOString().slice(0, 10);
  const open = data.invoices.filter((i) => i.status === "ISSUED" && i.kind === "INVOICE").reduce((a, i) => a + i.totalGross - i.paidTotal, 0);
  const revenue = data.incomes.reduce((a, i) => a + i.amount, 0);

  return (
    <>
      <PageHeader
        title={customerName(data)}
        sub={
          <>
            {data.number}
            {data.archived ? " – archiviert" : ""}
          </>
        }
        actions={
          <>
            <Button variant="ghost" onClick={back}>Zurück</Button>
            <Button onClick={() => setEdit(true)}>Bearbeiten</Button>
            <Button variant="primary" onClick={() => go({ name: "invoice-edit", customerId: data.id })}>
              Rechnung schreiben
            </Button>
          </>
        }
      />

      <div className="detail-grid">
        <div className="detail-main">
          <Section title="Rechnungen">
            {data.invoices.length === 0 ? (
              <p className="muted">Noch keine Rechnungen.</p>
            ) : (
              <table className="table clickable">
                <thead>
                  <tr>
                    <th>Nummer</th>
                    <th>Datum</th>
                    <th>Status</th>
                    <th className="num">Betrag</th>
                  </tr>
                </thead>
                <tbody>
                  {data.invoices.map((i) => (
                    <tr key={i.id} onClick={() => go({ name: "invoice", id: i.id })}>
                      <td>{i.number ?? <span className="muted">Entwurf</span>}</td>
                      <td>{date(i.issueDate)}</td>
                      <td>
                        <StatusBadge status={i.status} kind={i.kind} overdue={i.status === "ISSUED" && i.kind === "INVOICE" && !!i.dueDate && i.dueDate < today} />
                      </td>
                      <td className="num">{money(i.totalGross)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section
            title="Rabatte"
            aside={<Button variant="ghost" onClick={() => setNewDiscount(true)}>Rabatt vergeben</Button>}
          >
            {data.discounts.length === 0 ? (
              <p className="muted">Keine kundenbezogenen Rabatte.</p>
            ) : (
              <table className="table compact">
                <tbody>
                  {data.discounts.map((d) => (
                    <tr key={d.id}>
                      <td><strong>{d.name}</strong>{d.code ? <span className="code">{d.code}</span> : null}</td>
                      <td>{discountLabel(d)}</td>
                      <td className="muted">{d.validTo ? `bis ${date(d.validTo)}` : "unbefristet"}</td>
                      <td className="muted">{d.notifiedAt ? `per Mail mitgeteilt am ${date(d.notifiedAt.slice(0, 10))}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          {(() => {
            const ob = billing.data?.find((b) => b.customerId === data.id);
            const ps = projects.data ?? [];
            return (
              <Section
                title="Zeit & Projekte"
                aside={
                  <div className="row-actions">
                    <Button variant="ghost" className="btn-sm" onClick={() => setProjectDlg("new")}>Projekt anlegen</Button>
                    {ob ? <Button variant="primary" className="btn-sm" onClick={() => setBillDlg(true)}>Abrechnen</Button> : null}
                  </div>
                }
              >
                {ob ? (
                  <p>
                    Noch nicht abgerechnet: <strong>{fmtDuration(ob.minutes)}</strong> ({money(ob.timeAmount)})
                    {ob.charges ? <> und {ob.charges} Positionen ({money(ob.chargeAmount)})</> : null}, ältester Eintrag vom {date(ob.oldest)}.
                  </p>
                ) : (
                  <p className="muted">Keine offenen Zeiten.{data.hourlyRate ? ` Stundensatz: ${money(data.hourlyRate)}.` : ""}</p>
                )}
                {ps.length ? (
                  <table className="table compact clickable">
                    <tbody>
                      {ps.map((p) => (
                        <tr key={p.id} onClick={() => setProjectDlg(p)} className={p.archived ? "row-off" : ""}>
                          <td>{p.name}{p.archived ? <span className="muted"> · archiviert</span> : null}</td>
                          <td className="num nowrap">{fmtDuration(p.minutes ?? 0)}{p.budgetMinutes ? <span className="muted"> / {fmtDuration(p.budgetMinutes)}</span> : null}</td>
                          <td className="num nowrap muted">{p.hourlyRate ? money(p.hourlyRate) + "/Std." : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </Section>
            );
          })()}

          <CustomerContracts customerId={data.id} />

          {data.tickets.length ? (
            <Section title="Tickets">
              <table className="table compact clickable">
                <tbody>
                  {data.tickets.map((t) => (
                    <tr key={t.id} onClick={() => go({ name: "ticket", id: t.id })}>
                      <td className="nowrap muted">{t.number}</td>
                      <td>{t.subject}</td>
                      <td>
                        <span className={`badge ${TICKET_STATUS[t.status].cls}`}>{TICKET_STATUS[t.status].label}</span>
                      </td>
                      <td className="nowrap muted">{dateTime(t.lastMessageAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          ) : null}

          <Section title="Zahlungseingänge">
            {data.incomes.length === 0 ? (
              <p className="muted">Noch keine Zahlungen.</p>
            ) : (
              <table className="table compact">
                <tbody>
                  {data.incomes.map((i) => (
                    <tr key={i.id}>
                      <td className="nowrap muted">{date(i.date)}</td>
                      <td>{i.description}</td>
                      <td className="muted">{i.method}</td>
                      <td className="num">{money(i.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Gesendete E-Mails">
            {data.mails.length === 0 ? (
              <p className="muted">Noch keine E-Mails an diesen Kunden.</p>
            ) : (
              <table className="table compact">
                <tbody>
                  {data.mails.map((m) => (
                    <tr key={m.id}>
                      <td className="nowrap muted">{dateTime(m.createdAt)}</td>
                      <td>{m.subject}</td>
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
            <div><dt>Offen</dt><dd className={open ? "text-warn" : ""}>{money(open)}</dd></div>
            <div><dt>Umsatz gesamt</dt><dd>{money(revenue)}</dd></div>
          </dl>
          <div className="card-plain">
            <h3>Kontakt</h3>
            <p>
              {data.type === "COMPANY" && (data.firstName || data.lastName) ? <>{[data.firstName, data.lastName].filter(Boolean).join(" ")}<br /></> : null}
              {data.street ? <>{data.street}<br /></> : null}
              {[data.zip, data.city].filter(Boolean).join(" ")}
              {data.country !== "DE" ? <><br />{data.country}</> : null}
            </p>
            <p>
              {data.email ? <>{data.email}<br /></> : <span className="text-warn">Keine E-Mail – automatischer Versand nicht möglich<br /></span>}
              {data.phone}
            </p>
            {data.vatId ? <p className="muted">USt-IdNr. {data.vatId}</p> : null}
            {data.leitwegId ? <p className="muted">Leitweg-ID {data.leitwegId}</p> : null}
            {data.notes ? <p className="notes">{data.notes}</p> : null}
          </div>
          {!data.archived ? <PortalCard customerId={data.id} hasEmail={!!data.email} /> : null}
          {data.archived ? (
            <Button
              variant="ghost"
              busy={busy === "restore"}
              onClick={() => run("restore", async () => {
                const { invoices: _i, incomes: _in, discounts: _d, mails: _m, ...c } = data;
                await api.put(`/api/customers/${data.id}`, { ...c, archived: false });
                reload();
              }, "Kunde wiederhergestellt")}
            >
              Aus dem Archiv holen
            </Button>
          ) : (
            <Button variant="ghost" className="danger-text" onClick={() => setConfirmDelete(true)}>
              {data.invoices.length ? "Kunde archivieren" : "Kunde löschen"}
            </Button>
          )}
        </aside>
      </div>

      {edit ? (
        <CustomerForm
          initial={data}
          onClose={() => setEdit(false)}
          onSaved={() => {
            setEdit(false);
            reload();
          }}
        />
      ) : null}
      {newDiscount ? (
        <DiscountForm
          initial={{ scope: "CUSTOMER", customerId: data.id, type: "PERCENT", value: 1000, active: true }}
          lockCustomer
          onClose={() => setNewDiscount(false)}
          onSaved={() => {
            setNewDiscount(false);
            reload();
          }}
        />
      ) : null}
      {projectDlg ? (
        <ProjectDialog
          project={projectDlg === "new" ? null : projectDlg}
          customerId={data.id}
          onClose={() => setProjectDlg(null)}
          onSaved={() => {
            setProjectDlg(null);
            projects.reload();
          }}
        />
      ) : null}
      {billDlg ? (
        <BillingDialog
          customerId={data.id}
          onClose={() => {
            setBillDlg(false);
            billing.reload();
            reload();
          }}
        />
      ) : null}
      {confirmDelete ? (
        <Confirm
          title={data.invoices.length ? "Kunde archivieren?" : "Kunde löschen?"}
          text={
            data.invoices.length
              ? "Der Kunde hat Rechnungen und wird deshalb nur archiviert. Rechnungen bleiben erhalten (Aufbewahrungspflicht)."
              : "Der Kunde wird endgültig gelöscht."
          }
          confirmLabel={data.invoices.length ? "Archivieren" : "Löschen"}
          danger
          busy={busy === "del"}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() =>
            run("del", async () => {
              await api.del(`/api/customers/${data.id}`);
              go({ name: "customers" });
            }, data.invoices.length ? "Kunde archiviert" : "Kunde gelöscht")
          }
        />
      ) : null}
    </>
  );
}
