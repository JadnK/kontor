import { useState } from "react";
import { useAction, useApi, useLoad, useSession } from "../lib/store";
import { customerName, date, money, percentFromBps, todayIso } from "../lib/format";
import type { Customer, Discount, Product } from "../lib/types";
import { Button, Confirm, Empty, ErrorBox, Loading, Modal, MoneyField, NumberField, PageHeader, SelectField, TextField, Toggle } from "../components/ui";

export function discountLabel(d: Pick<Discount, "type" | "value">): string {
  return d.type === "PERCENT" ? `${percentFromBps(d.value)} %` : money(d.value);
}

function scopeLabel(d: Discount): string {
  if (d.scope === "CUSTOMER") return d.customerName ? `Kunde: ${d.customerName}` : "Einzelner Kunde";
  if (d.scope === "PRODUCT") return d.productName ? `Produkt: ${d.productName}` : "Einzelnes Produkt";
  return "Alle Kunden";
}

function state(d: Discount): { label: string; cls: string } {
  const t = todayIso();
  if (!d.active) return { label: "Inaktiv", cls: "badge-muted" };
  if (d.validTo && d.validTo < t) return { label: "Abgelaufen", cls: "badge-muted" };
  if (d.validFrom && d.validFrom > t) return { label: "Geplant", cls: "badge-draft" };
  return { label: "Aktiv", cls: "badge-paid" };
}

export function Discounts() {
  const api = useApi();
  const [editing, setEditing] = useState<Partial<Discount> | null>(null);
  const { data, error, loading, reload } = useLoad(() => api.get<Discount[]>("/api/discounts"), []);

  return (
    <>
      <PageHeader
        title="Rabatte"
        sub="Rabatte können allen Kunden, einem Kunden oder einem Produkt gelten und werden in der Rechnung ausgewählt."
        actions={<Button variant="primary" onClick={() => setEditing({ type: "PERCENT", scope: "ALL", active: true, value: 1000 })}>Rabatt anlegen</Button>}
      />
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <Empty title="Noch keine Rabatte" />
      ) : (
        <table className="table clickable">
          <thead>
            <tr>
              <th>Name</th>
              <th>Code</th>
              <th>Gilt für</th>
              <th className="num">Wert</th>
              <th>Zeitraum</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => {
              const s = state(d);
              return (
                <tr key={d.id} onClick={() => setEditing(d)}>
                  <td>
                    <strong>{d.name}</strong>
                    {d.minOrderNet ? <div className="sub">ab {money(d.minOrderNet)} netto</div> : null}
                  </td>
                  <td>{d.code ? <span className="code">{d.code}</span> : <span className="muted">–</span>}</td>
                  <td>{scopeLabel(d)}</td>
                  <td className="num">{discountLabel(d)}</td>
                  <td className="muted nowrap">
                    {d.validFrom || d.validTo ? `${d.validFrom ? date(d.validFrom) : "…"} – ${d.validTo ? date(d.validTo) : "…"}` : "unbefristet"}
                  </td>
                  <td><span className={`badge ${s.cls}`}>{s.label}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {editing ? (
        <DiscountForm
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

export function DiscountForm({
  initial,
  onClose,
  onSaved,
  lockCustomer,
}: {
  initial: Partial<Discount>;
  onClose: () => void;
  onSaved: () => void;
  lockCustomer?: boolean;
}) {
  const api = useApi();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const [d, setD] = useState<Partial<Discount>>(initial);
  const [notify, setNotify] = useState(settings.automation.sendDiscountNotice);
  const [confirmDel, setConfirmDel] = useState(false);
  const set = <K extends keyof Discount>(k: K) => (v: Discount[K]) => setD((x) => ({ ...x, [k]: v }));
  const isNew = !initial.id;
  const customers = useLoad(() => (d.scope === "CUSTOMER" && !lockCustomer ? api.get<Customer[]>("/api/customers") : Promise.resolve([] as Customer[])), [d.scope]);
  const products = useLoad(() => (d.scope === "PRODUCT" ? api.get<Product[]>("/api/products") : Promise.resolve([] as Product[])), [d.scope]);
  const mailReady = settings.mail.enabled && !!settings.mail.host;

  const save = () =>
    run("save", async () => {
      const body = { ...d, notify: isNew ? notify : false };
      if (isNew) await api.post("/api/discounts", body);
      else await api.put(`/api/discounts/${initial.id}`, body);
      onSaved();
    }, isNew ? "Rabatt angelegt" : "Rabatt gespeichert");

  return (
    <Modal
      title={isNew ? "Rabatt anlegen" : "Rabatt bearbeiten"}
      onClose={onClose}
      wide
      footer={
        <>
          {!isNew ? <Button variant="ghost" className="danger-text push-left" onClick={() => setConfirmDel(true)}>Löschen</Button> : null}
          {!isNew && d.scope === "CUSTOMER" && mailReady ? (
            <Button variant="ghost" busy={busy === "notify"} onClick={() => run("notify", () => api.post(`/api/discounts/${initial.id}/notify`), "Kunde wurde per E-Mail informiert")}>
              Kunden erneut informieren
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" busy={busy === "save"} onClick={save}>{isNew ? "Rabatt anlegen" : "Speichern"}</Button>
        </>
      }
    >
      <form className="grid-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <TextField label="Name" value={d.name} onChange={set("name")} span={2} autoFocus placeholder="z. B. Stammkundenrabatt" />
        <TextField label="Rabattcode" value={d.code} onChange={(v) => set("code")(v.toUpperCase())} span={2} hint="Optional, wird dem Kunden mitgeteilt" />
        <SelectField
          label="Art"
          value={d.type ?? "PERCENT"}
          onChange={(v) => setD((x) => ({ ...x, type: v, value: v === "PERCENT" ? 1000 : 1000 }))}
          options={[
            { value: "PERCENT", label: "Prozent" },
            { value: "FIXED", label: "Fester Betrag" },
          ]}
        />
        {d.type === "FIXED" ? (
          <MoneyField label="Betrag (netto)" value={d.value ?? null} onChange={(v) => set("value")(v ?? 0)} />
        ) : (
          <NumberField label="Prozent" value={d.value != null ? d.value / 100 : null} onChange={(v) => set("value")(Math.round((v ?? 0) * 100))} suffix="%" />
        )}
        <MoneyField label="Mindestbestellwert" value={d.minOrderNet ?? null} onChange={(v) => set("minOrderNet")(v)} span={2} hint="Netto, optional" />
        <SelectField
          label="Gilt für"
          value={d.scope ?? "ALL"}
          onChange={(v) => set("scope")(v)}
          span={2}
          options={
            lockCustomer
              ? [{ value: "CUSTOMER", label: "Diesen Kunden" }]
              : [
                  { value: "ALL", label: "Alle Kunden" },
                  { value: "CUSTOMER", label: "Einen bestimmten Kunden" },
                  { value: "PRODUCT", label: "Ein bestimmtes Produkt" },
                ]
          }
        />
        {d.scope === "CUSTOMER" && !lockCustomer ? (
          <SelectField
            label="Kunde"
            value={d.customerId ?? ""}
            onChange={(v) => set("customerId")(v || null)}
            span={2}
            options={[{ value: "", label: "Kunde wählen" }, ...(customers.data ?? []).map((c) => ({ value: c.id, label: `${customerName(c)} (${c.number})` }))]}
          />
        ) : d.scope === "PRODUCT" ? (
          <SelectField
            label="Produkt"
            value={d.productId ?? ""}
            onChange={(v) => set("productId")(v || null)}
            span={2}
            options={[{ value: "", label: "Produkt wählen" }, ...(products.data ?? []).map((p) => ({ value: p.id, label: p.name }))]}
          />
        ) : (
          <div className="span-2" />
        )}
        <TextField label="Gültig ab" type="date" value={d.validFrom} onChange={(v) => set("validFrom")(v || null)} span={2} />
        <TextField label="Gültig bis" type="date" value={d.validTo} onChange={(v) => set("validTo")(v || null)} span={2} />
        <div className="span-4 stack">
          <Toggle label="Aktiv" checked={d.active ?? true} onChange={set("active")} />
          {isNew && d.scope === "CUSTOMER" ? (
            <Toggle
              label="Kunden per E-Mail informieren"
              checked={notify && mailReady}
              onChange={setNotify}
              hint={mailReady ? "Verschickt die Vorlage „Rabatt“ an die E-Mail-Adresse des Kunden." : "E-Mail-Versand ist in den Einstellungen nicht eingerichtet."}
            />
          ) : null}
        </div>
        <button type="submit" hidden />
      </form>
      {confirmDel ? (
        <Confirm
          title="Rabatt löschen?"
          text="Bereits ausgestellte Rechnungen behalten den Rabatt."
          confirmLabel="Löschen"
          danger
          busy={busy === "del"}
          onCancel={() => setConfirmDel(false)}
          onConfirm={() => run("del", async () => { await api.del(`/api/discounts/${initial.id}`); onSaved(); }, "Rabatt gelöscht")}
        />
      ) : null}
    </Modal>
  );
}
