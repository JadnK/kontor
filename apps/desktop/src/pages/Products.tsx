import { useMemo, useState } from "react";
import { useAction, useApi, useLoad, useSession } from "../lib/store";
import { money, num } from "../lib/format";
import type { Product } from "../lib/types";
import { Button, Confirm, Empty, ErrorBox, Loading, Modal, MoneyField, PageHeader, Search, SelectField, TextArea, TextField, Toggle } from "../components/ui";

const UNITS = ["Stk", "Std", "Pauschal", "Tag", "Monat", "kg", "m", "m²", "l"];

export function Products() {
  const api = useApi();
  const { settings } = useSession();
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Partial<Product> | null>(null);
  const { data, error, loading, reload } = useLoad(() => api.get<Product[]>("/api/products?all=true"), []);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data ?? []).filter(
      (p) => (showInactive || p.active) && (!s || p.name.toLowerCase().includes(s) || (p.sku ?? "").toLowerCase().includes(s)),
    );
  }, [data, q, showInactive]);

  const blank = (): Partial<Product> => ({ unit: "Stk", taxRate: settings.invoice.defaultTaxRate, active: true, priceNet: 0 });

  return (
    <>
      <PageHeader title="Produkte und Leistungen" actions={<Button variant="primary" onClick={() => setEditing(blank())}>Produkt anlegen</Button>} />
      <div className="toolbar">
        <Search value={q} onChange={setQ} placeholder="Bezeichnung oder Artikelnummer" />
        <label className="inline-check">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Inaktive anzeigen
        </label>
      </div>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty title={q ? "Keine Treffer" : "Noch keine Produkte"}>
          {!q ? <p className="muted">Lege wiederkehrende Leistungen an, um sie in Rechnungen mit einem Klick einzufügen.</p> : null}
        </Empty>
      ) : (
        <table className="table clickable">
          <thead>
            <tr>
              <th>Art.-Nr.</th>
              <th>Bezeichnung</th>
              <th>Einheit</th>
              <th className="num">USt.</th>
              <th className="num">Preis netto</th>
              <th className="num">Preis brutto</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} onClick={() => setEditing(p)} className={p.active ? "" : "inactive"}>
                <td className="muted">{p.sku ?? "–"}</td>
                <td>
                  <strong>{p.name}</strong>
                  {p.description ? <div className="sub">{p.description}</div> : null}
                </td>
                <td>{p.unit}</td>
                <td className="num">{num(p.taxRate)} %</td>
                <td className="num">{money(p.priceNet)}</td>
                <td className="num muted">{money(Math.round(p.priceNet * (1 + (settings.invoice.smallBusiness ? 0 : p.taxRate) / 100)))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing ? (
        <ProductForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      ) : null}
    </>
  );
}

function ProductForm({ initial, onClose, onSaved }: { initial: Partial<Product>; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const [p, setP] = useState<Partial<Product>>(initial);
  const [confirmDel, setConfirmDel] = useState(false);
  const set = <K extends keyof Product>(k: K) => (v: Product[K]) => setP((x) => ({ ...x, [k]: v }));
  const isNew = !initial.id;
  const rates = settings.invoice.taxRates.length ? settings.invoice.taxRates : [19, 7, 0];

  const save = () =>
    run("save", async () => {
      const body = { ...p, priceNet: p.priceNet ?? 0 };
      if (isNew) await api.post("/api/products", body);
      else await api.put(`/api/products/${initial.id}`, body);
      onSaved();
    }, isNew ? "Produkt angelegt" : "Produkt gespeichert");

  return (
    <Modal
      title={isNew ? "Produkt anlegen" : "Produkt bearbeiten"}
      onClose={onClose}
      footer={
        <>
          {!isNew ? <Button variant="ghost" className="danger-text push-left" onClick={() => setConfirmDel(true)}>Löschen</Button> : null}
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" busy={busy === "save"} onClick={save}>{isNew ? "Produkt anlegen" : "Speichern"}</Button>
        </>
      }
    >
      <form className="grid-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <TextField label="Bezeichnung" value={p.name} onChange={set("name")} span={2} autoFocus />
        <TextField label="Artikelnummer" value={p.sku} onChange={set("sku")} hint="Optional, muss eindeutig sein" />
        <Field2 label="Einheit">
          <input list="units" value={p.unit ?? ""} onChange={(e) => set("unit")(e.target.value)} />
          <datalist id="units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
        </Field2>
        <MoneyField label="Preis netto" value={p.priceNet ?? null} onChange={(v) => set("priceNet")(v ?? 0)} />
        <SelectField
          label="Umsatzsteuer"
          value={String(p.taxRate ?? 19)}
          onChange={(v) => set("taxRate")(Number(v))}
          options={rates.map((r) => ({ value: String(r), label: `${num(r)} %` }))}
          hint={settings.invoice.smallBusiness ? "Kleinunternehmer: wird auf Rechnungen ignoriert" : undefined}
        />
        <TextArea label="Beschreibung" value={p.description} onChange={set("description")} span={2} hint="Erscheint als zweite Zeile auf der Rechnung" />
        <div className="span-2">
          <Toggle label="Aktiv" checked={p.active ?? true} onChange={set("active")} hint="Inaktive Produkte stehen in neuen Rechnungen nicht zur Auswahl" />
        </div>
        <button type="submit" hidden />
      </form>
      {confirmDel ? (
        <Confirm
          title="Produkt löschen?"
          text="Wurde das Produkt bereits in Rechnungen verwendet, wird es nur deaktiviert."
          confirmLabel="Löschen"
          danger
          busy={busy === "del"}
          onCancel={() => setConfirmDel(false)}
          onConfirm={() => run("del", async () => { await api.del(`/api/products/${initial.id}`); onSaved(); }, "Produkt entfernt")}
        />
      ) : null}
    </Modal>
  );
}

function Field2({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}
