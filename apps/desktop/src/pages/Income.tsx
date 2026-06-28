import { useMemo, useState } from "react";
import { useAction, useApi, useLoad, useNav } from "../lib/store";
import { customerName, date, money, moneyInput, todayIso } from "../lib/format";
import { saveFile } from "../lib/native";
import type { Customer, Income as IncomeRow } from "../lib/types";
import { Button, Confirm, Empty, ErrorBox, Loading, Modal, MoneyField, PageHeader, SelectField, TextField } from "../components/ui";

const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const CATEGORIES = ["Rechnung", "Barverkauf", "Anzahlung", "Provision", "Erstattung", "Sonstiges"];

export function Income() {
  const api = useApi();
  const { go } = useNav();
  const { busy, run } = useAction();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [month, setMonth] = useState<number | "all">("all");
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<IncomeRow | null>(null);

  const range = month === "all"
    ? { from: `${year}-01-01`, to: `${year}-12-31` }
    : {
        from: `${year}-${String(month + 1).padStart(2, "0")}-01`,
        to: `${year}-${String(month + 1).padStart(2, "0")}-${String(new Date(year, month + 1, 0).getDate()).padStart(2, "0")}`,
      };
  const list = useLoad(() => api.get<IncomeRow[]>(`/api/income?from=${range.from}&to=${range.to}`), [year, month]);
  const summary = useLoad(() => api.get<{ byMonth: number[]; total: number; categories: { category: string; total: number }[] }>(`/api/income/summary?year=${year}`), [year]);
  const total = useMemo(() => (list.data ?? []).reduce((a, r) => a + r.amount, 0), [list.data]);
  const max = Math.max(1, ...(summary.data?.byMonth ?? [0]));

  const exportCsv = () =>
    run("csv", async () => {
      const rows = list.data ?? [];
      const esc = (s: string | null | undefined) => `"${(s ?? "").replace(/"/g, '""')}"`;
      const lines = [
        ["Datum", "Betrag", "Kategorie", "Zahlungsart", "Kunde", "Rechnung", "Beschreibung"].join(";"),
        ...rows.map((r) => [date(r.date), moneyInput(r.amount), esc(r.category), esc(r.method), esc(r.customerName), esc(r.invoiceNumber), esc(r.description)].join(";")),
      ];
      const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const name = month === "all" ? `Einnahmen_${year}.csv` : `Einnahmen_${year}-${String(month + 1).padStart(2, "0")}.csv`;
      await saveFile(blob, name);
    });

  return (
    <>
      <PageHeader
        title="Einnahmen"
        sub="Zahlungen zu Rechnungen werden automatisch gebucht. Weitere Einnahmen trägst du hier ein."
        actions={
          <>
            <Button busy={busy === "csv"} onClick={exportCsv} disabled={!list.data?.length}>CSV exportieren</Button>
            <Button variant="primary" onClick={() => setAdding(true)}>Einnahme erfassen</Button>
          </>
        }
      />
      <div className="toolbar">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Jahr">
          {Array.from({ length: 6 }, (_, i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={month} onChange={(e) => setMonth(e.target.value === "all" ? "all" : Number(e.target.value))} aria-label="Monat">
          <option value="all">Ganzes Jahr</option>
          {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
        </select>
        <span className="toolbar-sum">Summe: <strong>{money(total)}</strong></span>
      </div>

      {summary.data ? (
        <div className="month-strip" role="img" aria-label="Einnahmen je Monat">
          {summary.data.byMonth.map((v, i) => (
            <button key={i} className={`month-cell ${month === i ? "active" : ""}`} onClick={() => setMonth(month === i ? "all" : i)} title={`${MONTHS[i]}: ${money(v)}`}>
              <span className="month-bar" style={{ height: `${(v / max) * 100}%` }} />
              <span className="month-name">{MONTHS[i].slice(0, 3)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : list.loading && !list.data ? (
        <Loading />
      ) : !list.data?.length ? (
        <Empty title="Keine Einnahmen in diesem Zeitraum" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Datum</th>
              <th>Beschreibung</th>
              <th>Kunde</th>
              <th>Kategorie</th>
              <th>Zahlungsart</th>
              <th className="num">Betrag</th>
              <th className="w-act" />
            </tr>
          </thead>
          <tbody>
            {list.data.map((r) => (
              <tr key={r.id}>
                <td className="nowrap">{date(r.date)}</td>
                <td>
                  {r.description}
                  {r.invoiceId ? (
                    <div className="sub">
                      <button className="link" onClick={() => go({ name: "invoice", id: r.invoiceId! })}>Rechnung {r.invoiceNumber}</button>
                    </div>
                  ) : null}
                </td>
                <td>{r.customerName ?? <span className="muted">–</span>}</td>
                <td>{r.category}</td>
                <td className="muted">{r.method}</td>
                <td className={`num ${r.amount < 0 ? "text-danger" : ""}`}>{money(r.amount)}</td>
                <td className="row-actions">
                  <button className="icon-btn" aria-label="Einnahme löschen" title="Löschen" onClick={() => setDeleting(r)}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {summary.data?.categories.length ? (
        <p className="footnote">
          {year} nach Kategorie: {summary.data.categories.map((c) => `${c.category} ${money(c.total)}`).join(", ")}
        </p>
      ) : null}

      {adding ? <IncomeForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); list.reload(); summary.reload(); }} /> : null}
      {deleting ? (
        <Confirm
          title="Einnahme löschen?"
          text={deleting.invoiceId ? "Die Zahlung gehört zu einer Rechnung. Die Rechnung wird danach wieder als offen geführt." : "Die Einnahme wird gelöscht."}
          confirmLabel="Löschen"
          danger
          busy={busy === "del"}
          onCancel={() => setDeleting(null)}
          onConfirm={() => run("del", async () => {
            await api.del(`/api/income/${deleting.id}`);
            setDeleting(null);
            list.reload();
            summary.reload();
          }, "Einnahme gelöscht")}
        />
      ) : null}
    </>
  );
}

function IncomeForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const { busy, run } = useAction();
  const customers = useLoad(() => api.get<Customer[]>("/api/customers"), []);
  const [f, setF] = useState({ date: todayIso(), amount: null as number | null, category: "Sonstiges", method: "Bar", description: "", customerId: "" });
  return (
    <Modal
      title="Einnahme erfassen"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" busy={busy === "save"} onClick={() => run("save", async () => {
            await api.post("/api/income", { ...f, amount: f.amount ?? 0, customerId: f.customerId || null });
            onSaved();
          }, "Einnahme erfasst")}>Einnahme erfassen</Button>
        </>
      }
    >
      <div className="grid-2">
        <TextField label="Datum" type="date" value={f.date} onChange={(v) => setF({ ...f, date: v })} />
        <MoneyField label="Betrag (brutto)" value={f.amount} onChange={(v) => setF({ ...f, amount: v })} />
        <SelectField label="Kategorie" value={f.category} onChange={(v) => setF({ ...f, category: v })} options={CATEGORIES.map((c) => ({ value: c, label: c }))} />
        <SelectField label="Zahlungsart" value={f.method} onChange={(v) => setF({ ...f, method: v })} options={["Bar", "Überweisung", "EC-Karte", "Kreditkarte", "PayPal"].map((c) => ({ value: c, label: c }))} />
        <SelectField
          label="Kunde"
          value={f.customerId}
          onChange={(v) => setF({ ...f, customerId: v })}
          span={2}
          options={[{ value: "", label: "Ohne Kunde" }, ...(customers.data ?? []).map((c) => ({ value: c.id, label: `${customerName(c)} (${c.number})` }))]}
        />
        <TextField label="Beschreibung" value={f.description} onChange={(v) => setF({ ...f, description: v })} span={2} />
      </div>
    </Modal>
  );
}
