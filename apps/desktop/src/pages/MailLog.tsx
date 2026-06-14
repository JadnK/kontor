import { useState } from "react";
import { useApi, useLoad } from "../lib/store";
import { dateTime } from "../lib/format";
import type { MailLog as Row } from "../lib/types";
import { Empty, ErrorBox, Loading, PageHeader, Tabs } from "../components/ui";

const KIND: Record<string, string> = {
  invoice: "Rechnung",
  reminder: "Zahlungserinnerung",
  payment: "Zahlungsbestätigung",
  cancellation: "Stornorechnung",
  discount: "Rabatt",
  welcome: "Willkommen",
  test: "Testnachricht",
  bank: "Bankfreigabe",
  dunning: "Mahnung",
  quote: "Angebot",
  recurring: "Abo-Rechnung",
  ticket: "Ticket",
  portal: "Kundenportal",
};

export function MailLog() {
  const api = useApi();
  const [status, setStatus] = useState<"" | "FAILED">("");
  const { data, error, loading, reload } = useLoad(() => api.get<Row[]>(`/api/mail-log${status ? `?status=${status}` : ""}`), [status]);
  return (
    <>
      <PageHeader title="E-Mail-Protokoll" sub="Alle E-Mails, die Kontor an Kunden verschickt hat – automatisch oder von Hand." />
      <div className="toolbar">
        <Tabs value={status} onChange={setStatus} tabs={[{ value: "", label: "Alle" }, { value: "FAILED", label: "Fehlgeschlagen" }]} />
      </div>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <Empty title={status ? "Keine fehlgeschlagenen E-Mails" : "Noch keine E-Mails verschickt"} />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Zeitpunkt</th>
              <th>Art</th>
              <th>Empfänger</th>
              <th>Betreff</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.map((m) => (
              <tr key={m.id}>
                <td className="nowrap muted">{dateTime(m.createdAt)}</td>
                <td>{KIND[m.kind] ?? m.kind}</td>
                <td>{m.to}</td>
                <td className="ellipsis">{m.subject}</td>
                <td>
                  {m.status === "SENT" ? <span className="badge badge-paid">Gesendet</span> : <span className="badge badge-danger">Fehler</span>}
                  {m.error ? <div className="sub text-danger">{m.error}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
