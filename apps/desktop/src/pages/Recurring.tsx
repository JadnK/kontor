import { Fragment, useState } from "react";
import { useAction, useApi, useLoad, useNav, useToast } from "../lib/store";
import { date, dateTime, money } from "../lib/format";
import type { Recurring as RecurringRow } from "../lib/types";
import { Button, Confirm, Empty, ErrorBox, Loading, PageHeader, StatusBadge } from "../components/ui";
import { Icon } from "../components/Icon";
import { INTERVALS } from "./InvoiceEditor";

export function Recurring() {
  const api = useApi();
  const toast = useToast();
  const { go } = useNav();
  const { busy, run } = useAction();
  const { data, error, loading, reload } = useLoad(() => api.get<RecurringRow[]>("/api/recurring"), []);
  const [open, setOpen] = useState<string | null>(null);
  const [runNow, setRunNow] = useState<RecurringRow | null>(null);
  const [del, setDel] = useState<RecurringRow | null>(null);
  const detail = useLoad(() => (open ? api.get<RecurringRow>(`/api/recurring/${open}`) : Promise.resolve(null)), [open]);

  const monthly = (data ?? [])
    .filter((r) => r.active)
    .reduce((a, r) => a + (r.totalGross ?? 0) / ({ MONTHLY: 1, QUARTERLY: 3, HALFYEARLY: 6, YEARLY: 12 } as const)[r.interval], 0);

  return (
    <>
      <PageHeader
        title="Abo-Rechnungen"
        sub="Hosting, Wartung, Domains: Kontor schreibt die Rechnung am Stichtag selbst und verschickt sie."
        actions={<Button variant="primary" onClick={() => go({ name: "recurring-edit" })}>Neues Abo</Button>}
      />
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <Empty title="Noch keine Abo-Rechnungen">
          <p className="muted">Lege wiederkehrende Leistungen einmal an – Kontor erstellt die Rechnungen dann monatlich, vierteljährlich oder jährlich.</p>
          <Button onClick={() => go({ name: "recurring-edit" })}>Erstes Abo anlegen</Button>
        </Empty>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Abo</th>
                <th>Kunde</th>
                <th>Rhythmus</th>
                <th>Nächste Rechnung</th>
                <th>Status</th>
                <th className="num">Betrag</th>
                <th className="w-act" />
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <Fragment key={r.id}>
                  <tr className={open === r.id ? "row-open" : ""}>
                    <td>
                      <button className="link strong" onClick={() => setOpen(open === r.id ? null : r.id)}>{r.name}</button>
                      <div className="sub">{r.runCount ? `${r.runCount} Rechnungen bisher` : "noch keine Rechnung"}{r.autoIssue ? "" : " · nur Entwürfe"}</div>
                    </td>
                    <td>{r.customerName}</td>
                    <td>{INTERVALS.find((i) => i.value === r.interval)?.label}</td>
                    <td className="nowrap">
                      {r.active ? date(r.nextDate) : <span className="muted">–</span>}
                      {r.active ? <div className="sub">für {r.nextPeriod}</div> : null}
                    </td>
                    <td>
                      {r.lastError ? (
                        <span className="badge badge-danger" title={r.lastError}>Problem</span>
                      ) : r.active ? (
                        <span className="badge badge-paid">Aktiv</span>
                      ) : (
                        <span className="badge badge-muted">{r.endDate && r.nextDate > r.endDate ? "Beendet" : "Pausiert"}</span>
                      )}
                    </td>
                    <td className="num">{money(r.totalGross ?? 0)}</td>
                    <td className="row-actions">
                      <Button variant="ghost" className="btn-sm" onClick={() => setRunNow(r)} disabled={!!r.endDate && r.nextDate > r.endDate}>Jetzt erstellen</Button>
                      <Button variant="ghost" className="btn-sm" onClick={() => go({ name: "recurring-edit", id: r.id })}>Bearbeiten</Button>
                      <Button
                        variant="ghost"
                        className="btn-sm"
                        busy={busy === `t${r.id}`}
                        onClick={() => run(`t${r.id}`, async () => { await api.patch(`/api/recurring/${r.id}`, { active: !r.active }); reload(); }, r.active ? "Pausiert" : "Wieder aktiv")}
                      >
                        {r.active ? "Pausieren" : "Fortsetzen"}
                      </Button>
                      <button className="icon-btn" aria-label="Abo löschen" title="Abo löschen" onClick={() => setDel(r)}>×</button>
                    </td>
                  </tr>
                  {open === r.id ? (
                    <tr className="row-detail">
                      <td colSpan={7}>
                        {r.lastError ? <div className="hint hint-danger"><span>Letzter Lauf: {r.lastError}</span></div> : null}
                        {detail.loading ? <Loading /> : detail.data?.invoices?.length ? (
                          <table className="table compact clickable">
                            <tbody>
                              {detail.data.invoices.map((i) => (
                                <tr key={i.id} onClick={() => go({ name: "invoice", id: i.id })}>
                                  <td className="nowrap">{i.number ?? <span className="muted">Entwurf</span>}</td>
                                  <td>{date(i.issueDate)}</td>
                                  <td className="muted">{i.serviceDateFrom ? `${date(i.serviceDateFrom)} – ${date(i.serviceDateTo)}` : ""}</td>
                                  <td><StatusBadge status={i.status} /></td>
                                  <td className="num">{money(i.totalGross)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <p className="muted">Noch keine Rechnungen aus diesem Abo.{r.lastRunAt ? ` Letzter Lauf ${dateTime(r.lastRunAt)}.` : ""}</p>
                        )}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
          <p className="footnote">
            <Icon name="repeat" className="inline-icon" /> Wiederkehrender Umsatz aus aktiven Abos: etwa {money(Math.round(monthly))} im Monat, {money(Math.round(monthly * 12))} im Jahr.
          </p>
        </>
      )}

      {runNow ? (
        <Confirm
          title="Rechnung jetzt erstellen?"
          text={
            <p>
              Für <strong>{runNow.name}</strong> wird die Rechnung für {runNow.nextPeriod} sofort erstellt{runNow.autoIssue ? " und an den Kunden gesendet" : " (als Entwurf)"}. Der nächste
              Termin rückt danach eine Periode weiter.
            </p>
          }
          confirmLabel="Erstellen"
          busy={busy === "run"}
          onCancel={() => setRunNow(null)}
          onConfirm={() =>
            run("run", async () => {
              const r = await api.post<{ invoiceId: string; warning: string | null }>(`/api/recurring/${runNow.id}/run`);
              if (r.warning) toast.error(r.warning);
              else toast.ok("Rechnung erstellt");
              setRunNow(null);
              go({ name: "invoice", id: r.invoiceId });
            })
          }
        />
      ) : null}
      {del ? (
        <Confirm
          title="Abo löschen?"
          text="Bereits erstellte Rechnungen bleiben erhalten. Es werden nur keine neuen mehr geschrieben."
          confirmLabel="Löschen"
          danger
          busy={busy === "del"}
          onCancel={() => setDel(null)}
          onConfirm={() => run("del", async () => { await api.del(`/api/recurring/${del.id}`); setDel(null); reload(); }, "Abo gelöscht")}
        />
      ) : null}
    </>
  );
}
