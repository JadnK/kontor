import { useEffect, useState } from "react";
import { useApi, useLoad, useNav } from "../lib/store";
import { date, money } from "../lib/format";
import type { InvoiceListRow } from "../lib/types";
import { Button, Empty, ErrorBox, Loading, PageHeader, Search, StatusBadge, Tabs } from "../components/ui";

type Filter = "ALL" | "DRAFT" | "ISSUED" | "OVERDUE" | "PAID" | "CANCELLED";

export function Invoices({ initialStatus }: { initialStatus?: string }) {
  const api = useApi();
  const { go } = useNav();
  const [status, setStatus] = useState<Filter>((initialStatus as Filter) ?? "ALL");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error, loading, reload } = useLoad(
    () => api.get<InvoiceListRow[]>(`/api/invoices?status=${status === "ALL" ? "" : status}&q=${encodeURIComponent(debounced)}`),
    [status, debounced],
  );
  const sumOpen = (data ?? []).filter((r) => r.status === "ISSUED" && r.kind === "INVOICE").reduce((a, r) => a + r.totalGross - r.paidTotal, 0);

  return (
    <>
      <PageHeader title="Rechnungen" actions={<Button variant="primary" onClick={() => go({ name: "invoice-edit" })}>Neue Rechnung</Button>} />
      <div className="toolbar">
        <Search value={q} onChange={setQ} placeholder="Nummer, Betreff oder Kunde" />
        <Tabs
          value={status}
          onChange={setStatus}
          tabs={[
            { value: "ALL", label: "Alle" },
            { value: "DRAFT", label: "Entwürfe" },
            { value: "ISSUED", label: "Offen" },
            { value: "OVERDUE", label: "Überfällig" },
            { value: "PAID", label: "Bezahlt" },
            { value: "CANCELLED", label: "Storniert" },
          ]}
        />
      </div>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <Empty title={debounced || status !== "ALL" ? "Keine passenden Rechnungen" : "Noch keine Rechnungen"}>
          {!debounced && status === "ALL" ? <Button onClick={() => go({ name: "invoice-edit" })}>Erste Rechnung schreiben</Button> : null}
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
                <th>Fällig</th>
                <th>Status</th>
                <th className="num">Betrag</th>
                <th className="num">Offen</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} onClick={() => go({ name: "invoice", id: r.id })}>
                  <td className="nowrap">{r.number ?? <span className="muted">Entwurf</span>}</td>
                  <td>{r.customerName}</td>
                  <td className="muted ellipsis">{r.subject}</td>
                  <td className="nowrap">{date(r.issueDate)}</td>
                  <td className={`nowrap ${r.overdue ? "text-danger" : ""}`}>{r.kind === "INVOICE" ? date(r.dueDate) : ""}</td>
                  <td>
                    <StatusBadge status={r.status} overdue={r.overdue} kind={r.kind} />
                    {r.reminderCount ? <span className="sub-inline">{r.reminderCount}× erinnert</span> : null}
                  </td>
                  <td className="num">{money(r.totalGross)}</td>
                  <td className="num">{r.status === "ISSUED" && r.kind === "INVOICE" ? money(r.totalGross - r.paidTotal) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {sumOpen > 0 ? <p className="footnote">Offen in dieser Ansicht: {money(sumOpen)}</p> : null}
        </>
      )}
    </>
  );
}
