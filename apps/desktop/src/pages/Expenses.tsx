import { useEffect, useRef, useState } from "react";
import { useAction, useApi, useLoad, useSession, useToast } from "../lib/store";
import { date, money, num, todayIso } from "../lib/format";
import { saveAndOpen } from "../lib/native";
import type { Expense } from "../lib/types";
import { Button, Confirm, Empty, ErrorBox, Field, Loading, Modal, MoneyField, PageHeader, Search, SelectField, TextArea, TextField } from "../components/ui";
import { Icon } from "../components/Icon";
import { fileToBase64 } from "./Bank";

export function Expenses() {
  const api = useApi();
  const toast = useToast();
  const { busy, run } = useAction();
  const { settings } = useSession();
  const year0 = todayIso().slice(0, 4);
  const [year, setYear] = useState(year0);
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const qs = new URLSearchParams({ from: `${year}-01-01`, to: `${year}-12-31`, ...(category ? { category } : {}), ...(debounced ? { q: debounced } : {}) });
  const { data, error, loading, reload } = useLoad(() => api.get<Expense[]>(`/api/expenses?${qs}`), [qs.toString()]);
  const [edit, setEdit] = useState<Expense | "new" | null>(null);
  const [del, setDel] = useState<Expense | null>(null);
  const [drop, setDrop] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const small = settings.invoice.smallBusiness;
  const years = Array.from({ length: 5 }, (_, i) => String(Number(year0) - i));

  const sum = (data ?? []).reduce((a, e) => a + e.amountGross, 0);
  const vst = (data ?? []).reduce((a, e) => a + e.taxAmount, 0);
  const noReceipt = (data ?? []).filter((e) => !e.hasReceipt).length;

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) { setDrop(f); setEdit("new"); }
      }}
      className={drag ? "drop-target active" : "drop-target"}
    >
      <PageHeader
        title="Ausgaben"
        sub="Belege hierher ziehen oder von Hand erfassen. Abbuchungen aus dem Kontoauszug landen automatisch hier, sobald du sie einmal einer Kategorie zugeordnet hast."
        actions={<Button variant="primary" onClick={() => { setDrop(null); setEdit("new"); }}>Ausgabe erfassen</Button>}
      />
      <div className="toolbar">
        <Search value={q} onChange={setQ} placeholder="Lieferant, Text oder Belegnummer" />
        <select value={year} onChange={(e) => setYear(e.target.value)} aria-label="Jahr">{years.map((y) => <option key={y}>{y}</option>)}</select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Kategorie">
          <option value="">Alle Kategorien</option>
          {settings.expenses.categories.map((c) => <option key={c.name}>{c.name}</option>)}
        </select>
      </div>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <Empty title="Keine Ausgaben"><p className="muted">Zieh eine Rechnung (PDF oder Foto) in dieses Fenster, um sie zu erfassen.</p></Empty>
      ) : (
        <>
          <div className="kpis compact">
            <div><span>Summe brutto</span><strong>{money(sum)}</strong></div>
            {!small ? <div><span>Vorsteuer</span><strong>{money(vst)}</strong></div> : null}
            <div><span>Ohne Beleg</span><strong className={noReceipt ? "text-warn" : ""}>{noReceipt}</strong></div>
          </div>
          <table className="table clickable">
            <thead>
              <tr><th>Datum</th><th>Lieferant</th><th>Kategorie</th><th>Beleg</th><th className="num">{small ? "" : "VSt."}</th><th className="num">Brutto</th></tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id} onClick={() => { setDrop(null); setEdit(e); }}>
                  <td className="nowrap">{date(e.date)}</td>
                  <td>{e.supplier}{e.description ? <div className="sub ellipsis">{e.description}</div> : null}</td>
                  <td>{e.category}{e.bankTransactionId ? <span className="sub-inline">aus Konto</span> : null}</td>
                  <td>
                    {e.hasReceipt ? (
                      <button
                        className="link"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          void run(`r${e.id}`, async () => {
                            const f = await api.download(`/api/expenses/${e.id}/receipt`);
                            await saveAndOpen(f.blob, f.filename);
                          });
                        }}
                      >
                        <Icon name="paperclip" className="inline-icon" />{busy === `r${e.id}` ? "…" : "öffnen"}
                      </button>
                    ) : <span className="muted">fehlt</span>}
                  </td>
                  <td className="num muted">{small ? "" : money(e.taxAmount)}</td>
                  <td className="num strong">{money(e.amountGross)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {edit ? (
        <ExpenseDialog
          expense={edit === "new" ? null : edit}
          file={drop}
          onClose={() => setEdit(null)}
          onSaved={() => { setEdit(null); reload(); }}
          onDelete={edit !== "new" ? () => { setDel(edit); setEdit(null); } : undefined}
        />
      ) : null}
      {del ? (
        <Confirm
          title="Ausgabe löschen?"
          text={del.bankTransactionId ? "Die Abbuchung erscheint danach wieder im Zahlungsabgleich unter „Ausgaben“." : "Die Ausgabe und ihr Beleg werden gelöscht."}
          confirmLabel="Löschen"
          danger
          busy={busy === "del"}
          onCancel={() => setDel(null)}
          onConfirm={() => run("del", async () => { await api.del(`/api/expenses/${del.id}`); setDel(null); reload(); toast.ok("Gelöscht"); })}
        />
      ) : null}
    </div>
  );
}

function ExpenseDialog({ expense, file, onClose, onSaved, onDelete }: { expense: Expense | null; file: File | null; onClose: () => void; onSaved: () => void; onDelete?: () => void }) {
  const api = useApi();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const small = settings.invoice.smallBusiness;
  const [d, setD] = useState({
    date: expense?.date ?? todayIso(),
    supplier: expense?.supplier ?? "",
    description: expense?.description ?? "",
    category: expense?.category ?? settings.expenses.categories[0]?.name ?? "",
    amountGross: expense?.amountGross ?? (null as number | null),
    taxRate: expense?.taxRate ?? 19,
    paymentMethod: expense?.paymentMethod ?? "Überweisung",
    invoiceNumber: expense?.invoiceNumber ?? "",
    notes: expense?.notes ?? "",
  });
  const [receipt, setReceipt] = useState<File | null | "remove">(file);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof typeof d>(k: K) => (v: (typeof d)[K]) => setD((x) => ({ ...x, [k]: v }));
  const fromBank = !!expense?.bankTransactionId;
  const tax = d.amountGross && d.taxRate ? Math.round(d.amountGross - d.amountGross / (1 + d.taxRate / 100)) : 0;
  const learned = useRef(false);
  const suggest = async (supplier: string) => {
    if (expense || learned.current || !supplier.trim()) return;
    try {
      const r = await api.get<{ category: string | null }>(`/api/expenses/suggest?supplier=${encodeURIComponent(supplier)}`);
      if (r.category) {
        learned.current = true;
        setD((x) => ({ ...x, category: r.category! }));
      }
    } catch {
      /* egal */
    }
  };
  return (
    <Modal
      title={expense ? "Ausgabe bearbeiten" : "Ausgabe erfassen"}
      wide
      onClose={onClose}
      footer={
        <>
          {onDelete ? <Button variant="ghost" className="danger-text" onClick={onDelete}>Löschen</Button> : null}
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            disabled={!d.supplier.trim() || !d.amountGross}
            busy={busy === "s"}
            onClick={() => run("s", async () => {
              const body: Record<string, unknown> = { ...d, description: d.description || null, invoiceNumber: d.invoiceNumber || null, notes: d.notes || null, taxRate: d.taxRate };
              if (receipt === "remove") body.receipt = null;
              else if (receipt) body.receipt = { name: receipt.name, type: receipt.type || undefined, data: await fileToBase64(receipt) };
              if (expense) await api.put(`/api/expenses/${expense.id}`, body);
              else await api.post("/api/expenses", body);
              onSaved();
            }, "Gespeichert")}
          >
            Speichern
          </Button>
        </>
      }
    >
      <div className="grid-4">
        <TextField label="Lieferant / Empfänger" value={d.supplier} onChange={(v) => { set("supplier")(v); }} span={2} autoFocus={!expense} />
        <div className="span-2" onBlur={() => void suggest(d.supplier)} />
        <TextField label="Datum" type="date" value={d.date} onChange={(v) => set("date")(v || todayIso())} />
        <TextField label="Belegnummer" value={d.invoiceNumber} onChange={set("invoiceNumber")} placeholder="Rechnungs-Nr. des Lieferanten" />
        <SelectField label="Kategorie" value={d.category} onChange={set("category")} options={settings.expenses.categories.map((c) => ({ value: c.name, label: c.name }))} span={2} />
        <MoneyField label="Betrag brutto" value={d.amountGross} onChange={set("amountGross")} hint={fromBank ? "aus dem Kontoauszug" : undefined} />
        <SelectField
          label="USt.-Satz"
          value={String(d.taxRate)}
          onChange={(v) => set("taxRate")(Number(v))}
          options={[19, 7, 0].map((r) => ({ value: String(r), label: `${r} %` }))}
          hint={small ? "Für die Übersicht – als Kleinunternehmer keine Vorsteuer" : `Vorsteuer ${money(tax)}`}
        />
        <Field label="Bezahlt per" span={2}>
          {(id) => (
            <>
              <input id={id} list="paymethods" value={d.paymentMethod} onChange={(e) => set("paymentMethod")(e.target.value)} />
              <datalist id="paymethods">{["Überweisung", "Lastschrift", "Kreditkarte", "PayPal", "Bar", "EC-Karte"].map((m) => <option key={m} value={m} />)}</datalist>
            </>
          )}
        </Field>
        <Field label="Beleg" span={2}>
          {() => (
            <div className="inline-form">
              <span className="pem-state">
                {receipt === "remove" ? <span className="muted">wird entfernt</span> : receipt ? receipt.name : expense?.hasReceipt ? expense.receiptName : <span className="muted">kein Beleg</span>}
              </span>
              <Button onClick={() => fileRef.current?.click()}>{receipt || expense?.hasReceipt ? "Ersetzen" : "Datei wählen"}</Button>
              {expense?.hasReceipt && receipt !== "remove" ? <Button variant="ghost" onClick={() => setReceipt("remove")}>Entfernen</Button> : null}
              <input ref={fileRef} type="file" hidden accept=".pdf,image/*" onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} />
            </div>
          )}
        </Field>
        <TextField label="Wofür" value={d.description} onChange={set("description")} span={4} placeholder="z. B. Server CX22 Oktober" />
        <TextArea label="Notiz" value={d.notes} onChange={set("notes")} span={4} rows={2} />
      </div>
      {settings.expenses.categories.find((c) => c.name === d.category)?.deductible !== 100 ? (
        <p className="muted small">In dieser Kategorie sind nur {num(settings.expenses.categories.find((c) => c.name === d.category)?.deductible ?? 100)} % als Betriebsausgabe abziehbar.</p>
      ) : null}
    </Modal>
  );
}
