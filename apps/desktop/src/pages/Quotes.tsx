import { useEffect, useState } from "react";
import { useApi, useLoad, useNav } from "../lib/store";
import { date, money } from "../lib/format";
import type { QuoteListRow, QuoteStatus } from "../lib/types";
import { Button, Empty, ErrorBox, Loading, PageHeader, Search, Tabs } from "../components/ui";

type Filter = "ALL" | "DRAFT" | "OPEN" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "INVOICED";

const LABEL: Record<QuoteStatus, [string, string]> = {
  DRAFT: ["Entwurf", "badge-draft"],
  SENT: ["Offen", "badge-issued"],
  ACCEPTED: ["Angenommen", "badge-paid"],
  DECLINED: ["Abgelehnt", "badge-danger"],
  INVOICED: ["Abgerechnet", "badge-muted"],
};

export function QuoteBadge({ status, expired }: { status: QuoteStatus; expired?: boolean }) {
  if (expired) return <span className="badge badge-danger">Abgelaufen</span>;
  const [l, c] = LABEL[status];
  return <span className={`badge ${c}`}>{l}</span>;
}

export function Quotes() {
  const api = useApi();
  const { go } = useNav();
  const [status, setStatus] = useState<Filter>("ALL");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error, loading, reload } = useLoad(
    () => api.get<QuoteListRow[]>(`/api/quotes?status=${status === "ALL" ? "" : status}&q=${encodeURIComponent(debounced)}`),
    [status, debounced],
  );
  const openSum = (data ?? []).filter((r) => r.status === "SENT" && !r.expired).reduce((a, r) => a + r.totalGross, 0);

  return (
    <>
      <PageHeader
        title="Angebote"
        sub="Kunden nehmen Angebote über einen Link online an. Daraus wird mit einem Klick die Rechnung."
        actions={<Button variant="primary" onClick={() => go({ name: "quote-edit" })}>Neues Angebot</Button>}
      />
      <div className="toolbar">
        <Search value={q} onChange={setQ} placeholder="Nummer, Betreff oder Kunde" />
        <Tabs
          value={status}
          onChange={setStatus}
          tabs={[
            { value: "ALL", label: "Alle" },
            { value: "DRAFT", label: "Entwürfe" },
            { value: "OPEN", label: "Offen" },
            { value: "ACCEPTED", label: "Angenommen" },
            { value: "DECLINED", label: "Abgelehnt" },
            { value: "EXPIRED", label: "Abgelaufen" },
            { value: "INVOICED", label: "Abgerechnet" },
          ]}
        />
      </div>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <Empty title={debounced || status !== "ALL" ? "Keine passenden Angebote" : "Noch keine Angebote"}>
          {!debounced && status === "ALL" ? <Button onClick={() => go({ name: "quote-edit" })}>Erstes Angebot schreiben</Button> : null}
        </Empty>
      ) : (
        <>
          <table className="table clickable">
            <thead>
              <tr>
                <th>Nummer</th>
                <th>Kunde</th>
                <th>Betreff</th>
                <th>Datum</th>
                <th>Gültig bis</th>
                <th>Status</th>
                <th className="num">Betrag</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} onClick={() => go({ name: "quote", id: r.id })}>
                  <td className="nowrap">{r.number ?? <span className="muted">Entwurf</span>}</td>
                  <td>{r.customerName}</td>
                  <td className="muted ellipsis">{r.subject}</td>
                  <td className="nowrap">{date(r.issueDate)}</td>
                  <td className={`nowrap ${r.expired ? "text-danger" : ""}`}>{date(r.validUntil)}</td>
                  <td>
                    <QuoteBadge status={r.status} expired={r.expired} />
                    {r.status === "SENT" && r.viewedAt && !r.expired ? <span className="sub-inline">angesehen</span> : null}
                  </td>
                  <td className="num">{money(r.totalGross)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {openSum > 0 ? <p className="footnote">Offene Angebote in dieser Ansicht: {money(openSum)}</p> : null}
        </>
      )}
    </>
  );
}
