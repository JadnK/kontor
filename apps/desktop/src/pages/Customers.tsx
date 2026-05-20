import { useEffect, useState } from "react";
import { useAction, useApi, useLoad, useNav, useSession } from "../lib/store";
import { customerName, money } from "../lib/format";
import type { Customer } from "../lib/types";
import { Button, Empty, ErrorBox, Loading, Modal, MoneyField, PageHeader, Search, SelectField, Tabs, TextArea, TextField } from "../components/ui";

export function Customers() {
  const api = useApi();
  const { go } = useNav();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [archived, setArchived] = useState<"active" | "archived">("active");
  const [editing, setEditing] = useState<Partial<Customer> | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error, loading, reload } = useLoad(
    () => api.get<Customer[]>(`/api/customers?q=${encodeURIComponent(debounced)}&archived=${archived === "archived"}`),
    [debounced, archived],
  );

  return (
    <>
      <PageHeader
        title="Kunden"
        actions={
          <Button variant="primary" onClick={() => setEditing({ type: "COMPANY", country: "DE" })}>
            Kunde anlegen
          </Button>
        }
      />
      <div className="toolbar">
        <Search value={q} onChange={setQ} placeholder="Name, Nummer, E-Mail oder Ort" />
        <Tabs value={archived} onChange={setArchived} tabs={[{ value: "active", label: "Aktiv" }, { value: "archived", label: "Archiviert" }]} />
      </div>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <Empty title={debounced ? "Keine Treffer" : archived === "archived" ? "Keine archivierten Kunden" : "Noch keine Kunden"}>
          {!debounced && archived === "active" ? <Button onClick={() => setEditing({ type: "COMPANY", country: "DE" })}>Ersten Kunden anlegen</Button> : null}
        </Empty>
      ) : (
        <table className="table clickable">
          <thead>
            <tr>
              <th>Nr.</th>
              <th>Name</th>
              <th>Ort</th>
              <th>E-Mail</th>
              <th className="num">Offen</th>
              <th className="num">Umsatz</th>
            </tr>
          </thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.id} onClick={() => go({ name: "customer", id: c.id })}>
                <td className="muted nowrap">{c.number}</td>
                <td>
                  <strong>{customerName(c)}</strong>
                  {c.type === "COMPANY" && (c.firstName || c.lastName) ? <div className="sub">{[c.firstName, c.lastName].filter(Boolean).join(" ")}</div> : null}
                </td>
                <td>{[c.zip, c.city].filter(Boolean).join(" ")}</td>
                <td>{c.email ?? <span className="muted">–</span>}</td>
                <td className={`num ${c.open ? "text-warn" : "muted"}`}>{c.open ? money(c.open) : "–"}</td>
                <td className="num">{money(c.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing ? (
        <CustomerForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setEditing(null);
            go({ name: "customer", id: c.id });
          }}
        />
      ) : null}
    </>
  );
}

export function CustomerForm({ initial, onClose, onSaved }: { initial: Partial<Customer>; onClose: () => void; onSaved: (c: Customer) => void }) {
  const api = useApi();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const [c, setC] = useState<Partial<Customer>>(initial);
  const set = <K extends keyof Customer>(k: K) => (v: Customer[K]) => setC((x) => ({ ...x, [k]: v }));
  const isNew = !initial.id;

  const save = () =>
    run(
      "save",
      async () => {
        const saved = isNew ? await api.post<Customer>("/api/customers", c) : await api.put<Customer>(`/api/customers/${initial.id}`, c);
        onSaved(saved);
      },
      isNew ? "Kunde angelegt" : "Kunde gespeichert",
    );

  return (
    <Modal
      title={isNew ? "Kunde anlegen" : "Kunde bearbeiten"}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" busy={busy === "save"} onClick={save}>
            {isNew ? "Kunde anlegen" : "Speichern"}
          </Button>
        </>
      }
    >
      <form
        className="grid-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <SelectField
          label="Art"
          value={c.type ?? "COMPANY"}
          onChange={set("type")}
          options={[
            { value: "COMPANY", label: "Firma" },
            { value: "PERSON", label: "Privatperson" },
          ]}
        />
        {c.type === "COMPANY" ? <TextField label="Firmenname" value={c.company} onChange={set("company")} span={3} autoFocus /> : <div className="span-3" />}
        <TextField label={c.type === "COMPANY" ? "Ansprechpartner Vorname" : "Vorname"} value={c.firstName} onChange={set("firstName")} span={2} />
        <TextField label={c.type === "COMPANY" ? "Ansprechpartner Nachname" : "Nachname"} value={c.lastName} onChange={set("lastName")} span={2} />
        <TextField label="E-Mail" type="email" value={c.email} onChange={set("email")} span={2} hint="Rechnungen und Benachrichtigungen gehen an diese Adresse" />
        <TextField label="Telefon" value={c.phone} onChange={set("phone")} span={2} />
        <TextField label="Straße und Hausnummer" value={c.street} onChange={set("street")} span={4} />
        <TextField label="PLZ" value={c.zip} onChange={set("zip")} />
        <TextField label="Ort" value={c.city} onChange={set("city")} span={2} />
        <TextField label="Land" value={c.country} onChange={(v) => set("country")(v.toUpperCase().slice(0, 2))} hint="ISO-Code, z. B. DE, AT" />
        <TextField label="USt-IdNr." value={c.vatId} onChange={set("vatId")} span={2} />
        <TextField label="Leitweg-ID" value={c.leitwegId} onChange={set("leitwegId")} span={2} hint="Nur für Behörden (E-Rechnung)" />
        {settings.profiles?.list.length ? (
          <SelectField
            label="Rechnungen von"
            value={c.profileId ?? ""}
            onChange={(v) => setC((x) => ({ ...x, profileId: v || null }))}
            options={[{ value: "", label: settings.company.name || "Hauptfirma" }, ...settings.profiles.list.map((p) => ({ value: p.id, label: p.label }))]}
            span={2}
          />
        ) : null}
        <MoneyField label="Stundensatz (netto)" value={c.hourlyRate ?? null} onChange={(v) => setC((x) => ({ ...x, hourlyRate: v }))} span={2} hint="Leer = Standard aus der Zeiterfassung" />
        <TextArea label="Notizen" value={c.notes} onChange={set("notes")} span={4} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
