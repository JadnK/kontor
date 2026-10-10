import { useEffect, useRef, useState } from "react";
import { useAction, useApi, useLoad, useNav, useSession, useToast } from "../lib/store";
import { customerName, date, money, num, todayIso } from "../lib/format";
import { saveFile } from "../lib/native";
import type { Contract, ContractFull, ContractPreview, ContractStatus, ContractSummary, Customer, InvoiceItem, NoticeUnit, Product, RecurringInterval } from "../lib/types";
import { Button, Confirm, Empty, ErrorBox, Field, Loading, Modal, MoneyInput, NumberInput, PageHeader, Search, Section, SelectField, StatusBadge, Tabs, TextArea, TextField, Toggle } from "../components/ui";
import { Icon } from "../components/Icon";
import { INTERVALS } from "./InvoiceEditor";
import { fileToBase64 } from "./Bank";

const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const INTERVAL_LABEL: Record<RecurringInterval, string> = { MONTHLY: "monatlich", QUARTERLY: "vierteljährlich", HALFYEARLY: "halbjährlich", YEARLY: "jährlich" };
const PER: Record<RecurringInterval, string> = { MONTHLY: "Monat", QUARTERLY: "Quartal", HALFYEARLY: "Halbjahr", YEARLY: "Jahr" };
const UNIT: Record<NoticeUnit, [string, string]> = { DAYS: ["Tag", "Tage"], WEEKS: ["Woche", "Wochen"], MONTHS: ["Monat", "Monate"] };

export const CONTRACT_STATUS: Record<ContractStatus, { label: string; cls: string }> = {
  DRAFT: { label: "Entwurf", cls: "badge-muted" },
  ACTIVE: { label: "Läuft", cls: "badge-ok" },
  CANCELLED: { label: "Gekündigt", cls: "badge-warn" },
  ENDED: { label: "Beendet", cls: "badge-muted" },
};

const notice = (c: Pick<Contract, "noticeValue" | "noticeUnit">) => (c.noticeValue ? `${c.noticeValue} ${UNIT[c.noticeUnit][c.noticeValue === 1 ? 0 : 1]}` : "ohne Frist");
const months = (n: number) => (n === 12 ? "1 Jahr" : n % 12 === 0 ? `${n / 12} Jahre` : n === 1 ? "1 Monat" : `${n} Monate`);

function term(c: Pick<Contract, "minTermMonths" | "renewalMonths" | "endDate" | "status">) {
  if (c.endDate && c.status !== "CANCELLED") return `befristet bis ${date(c.endDate)}`;
  const parts = [];
  if (c.minTermMonths) parts.push(`Mindestlaufzeit ${months(c.minTermMonths)}`);
  if (c.renewalMonths) parts.push(`verlängert sich um je ${months(c.renewalMonths)}`);
  else parts.push(c.minTermMonths ? "danach monatlich kündbar" : "jederzeit kündbar");
  return parts.join(", ");
}

// ===================== Übersicht =====================
export function Contracts() {
  const api = useApi();
  const { go } = useNav();
  const [view, setView] = useState<"RUNNING" | "DRAFT" | "ENDED" | "ALL">("RUNNING");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const summary = useLoad(() => api.get<ContractSummary>("/api/contracts/summary"), []);
  const list = useLoad(() => api.get<Contract[]>(`/api/contracts?status=${view}&q=${encodeURIComponent(debounced)}`), [view, debounced]);
  const s = summary.data;
  const max = Math.max(1, ...(s?.forecast.map((f) => f.net) ?? [0]));

  return (
    <>
      <PageHeader
        title="Verträge"
        sub="Laufende Verträge, monatliche Einnahmen und Kündigungsfristen auf einen Blick. Mit verknüpfter Abo-Rechnung wird automatisch abgerechnet."
        actions={<Button variant="primary" onClick={() => go({ name: "contract-edit" })}><Icon name="plus" /> Vertrag anlegen</Button>}
      />
      {s ? (
        <>
          <div className="figures">
            <div className="figure">
              <span className="figure-label">Monatlich (netto)</span>
              <span className="figure-value">{money(s.mrr)}</span>
              <span className="figure-note">aus laufenden Verträgen</span>
            </div>
            <div className="figure">
              <span className="figure-label">Aufs Jahr gerechnet</span>
              <span className="figure-value">{money(s.arr)}</span>
              <span className="figure-note">netto</span>
            </div>
            <div className="figure">
              <span className="figure-label">Laufende Verträge</span>
              <span className="figure-value">{s.activeCount}</span>
              <span className="figure-note">{s.cancelledCount ? `+ ${s.cancelledCount} gekündigt, laufen noch` : `bei ${s.customers} ${s.customers === 1 ? "Kunde" : "Kunden"}`}</span>
            </div>
            <div className={`figure ${s.deadlines.length ? "figure-alert" : ""}`}>
              <span className="figure-label">Kündigungsfristen bald</span>
              <span className="figure-value">{s.deadlines.length}</span>
              <span className="figure-note">{s.deadlines[0] ? `nächste am ${date(s.deadlines[0].noticeDeadline)}` : "keine in den nächsten Wochen"}</span>
            </div>
          </div>
          <div className="dash-grid" style={{ marginTop: 22 }}>
            <Section title="Einnahmen aus Verträgen, nächste 12 Monate">
              <div className="chart">
                <div className="chart-head">
                  <span>netto je Monat, berücksichtigt Beginn und Vertragsende</span>
                  <strong>{money(max)}</strong>
                </div>
                <div className="bars" role="img" aria-label="Vertragseinnahmen je Monat">
                  {s.forecast.map((f) => (
                    <div className="bar-col" key={f.month} title={`${MONTHS[Number(f.month.slice(5, 7)) - 1]} ${f.month.slice(0, 4)}: ${money(f.net)}`}>
                      <div className="bar-track">
                        <div className="bar" style={{ height: `${(f.net / max) * 100}%` }} />
                      </div>
                      <span>{MONTHS[Number(f.month.slice(5, 7)) - 1]}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Section>
            <Section title="Demnächst">
              {!s.deadlines.length && !s.ending.length ? (
                <p className="muted">Keine Kündigungsfristen oder Vertragsenden in nächster Zeit.</p>
              ) : (
                <ul className="due-list">
                  {s.deadlines.map((d) => (
                    <li key={`d${d.id}`}>
                      <button className="due-row" onClick={() => go({ name: "contract", id: d.id })}>
                        <div>
                          <strong>{d.title}</strong>
                          <div className="sub">{d.customerName} · Kündigung bis {date(d.noticeDeadline)}, sonst Verlängerung über {date(d.earliestEnd)} hinaus</div>
                        </div>
                        <div className="due-amount">{money(d.monthlyNet)}<span className="sub">/Monat</span></div>
                      </button>
                    </li>
                  ))}
                  {s.ending.map((d) => (
                    <li key={`e${d.id}`}>
                      <button className="due-row" onClick={() => go({ name: "contract", id: d.id })}>
                        <div>
                          <strong>{d.title}</strong>
                          <div className="sub text-danger">{d.customerName} · gekündigt, endet am {date(d.endDate)}</div>
                        </div>
                        <div className="due-amount">− {money(d.monthlyNet)}<span className="sub">/Monat</span></div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        </>
      ) : summary.error ? (
        <ErrorBox error={summary.error} onRetry={summary.reload} />
      ) : null}

      <div className="toolbar" style={{ marginTop: 18 }}>
        <Search value={q} onChange={setQ} placeholder="Vertrag, Nummer oder Kunde" />
        <Tabs
          value={view}
          onChange={setView}
          tabs={[
            { value: "RUNNING", label: "Laufend" },
            { value: "DRAFT", label: "Entwürfe" },
            { value: "ENDED", label: "Beendet" },
            { value: "ALL", label: "Alle" },
          ]}
        />
      </div>
      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : list.loading && !list.data ? (
        <Loading />
      ) : !list.data?.length ? (
        <Empty title={debounced ? "Keine Treffer" : view === "RUNNING" ? "Noch keine laufenden Verträge" : "Keine Verträge"}>
          {view === "RUNNING" && !debounced ? <p className="muted">Lege Wartungs-, Hosting- oder Betreuungsverträge an – Laufzeit, Kündigungsfrist und monatlicher Wert werden automatisch berechnet.</p> : null}
        </Empty>
      ) : (
        <table className="table clickable">
          <thead>
            <tr>
              <th>Vertrag</th>
              <th>Kunde</th>
              <th className="num">Betrag</th>
              <th className="num">je Monat</th>
              <th>Laufzeit</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((c) => (
              <tr key={c.id} onClick={() => go({ name: "contract", id: c.id })}>
                <td>
                  <strong>{c.title}</strong>
                  <div className="sub">{c.number} · seit {date(c.startDate)}</div>
                </td>
                <td>{c.customerName}</td>
                <td className="num nowrap">
                  {money(c.netPerInterval)}
                  <div className="sub">{INTERVAL_LABEL[c.interval]}</div>
                </td>
                <td className="num strong nowrap">{money(c.monthlyNet)}</td>
                <td className="small">
                  {c.status === "CANCELLED" ? (
                    <>endet am <strong>{date(c.endDate)}</strong></>
                  ) : c.status === "ACTIVE" && c.noticeDeadline ? (
                    <>
                      kündbar zum {date(c.earliestEnd)}
                      <div className="sub">Frist bis {date(c.noticeDeadline)}</div>
                    </>
                  ) : c.status === "ENDED" ? (
                    <>beendet am {date(c.endDate)}</>
                  ) : (
                    <span className="muted">{term(c)}</span>
                  )}
                </td>
                <td>
                  <span className={`badge ${CONTRACT_STATUS[c.status].cls}`}>{CONTRACT_STATUS[c.status].label}</span>
                  {c.recurringId ? <span className="badge badge-muted" title="Wird automatisch abgerechnet" style={{ marginLeft: 4 }}><Icon name="repeat" /></span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ===================== Editor =====================
interface Draft {
  customerId: string;
  title: string;
  description: string | null;
  contactPerson: string | null;
  status: "DRAFT" | "ACTIVE";
  startDate: string;
  endDate: string | null;
  minTermMonths: number;
  renewalMonths: number;
  noticeValue: number;
  noticeUnit: NoticeUnit;
  interval: RecurringInterval;
  items: InvoiceItem[];
  signedAt: string | null;
  notes: string | null;
}

const PRESETS: { label: string; hint: string; v: Pick<Draft, "minTermMonths" | "renewalMonths" | "noticeValue" | "noticeUnit"> }[] = [
  { label: "Monatlich kündbar", hint: "keine Mindestlaufzeit, 1 Monat Frist", v: { minTermMonths: 0, renewalMonths: 0, noticeValue: 1, noticeUnit: "MONTHS" } },
  { label: "12 Monate, verlängert sich", hint: "um je 12 Monate, 3 Monate Frist", v: { minTermMonths: 12, renewalMonths: 12, noticeValue: 3, noticeUnit: "MONTHS" } },
  { label: "12 Monate, dann monatlich", hint: "danach monatlich kündbar, 1 Monat Frist", v: { minTermMonths: 12, renewalMonths: 0, noticeValue: 1, noticeUnit: "MONTHS" } },
  { label: "24 Monate, verlängert sich", hint: "um je 12 Monate, 3 Monate Frist", v: { minTermMonths: 24, renewalMonths: 12, noticeValue: 3, noticeUnit: "MONTHS" } },
];

export function ContractEditor({ id, customerId }: { id?: string; customerId?: string }) {
  const api = useApi();
  const customers = useLoad(() => api.get<Customer[]>("/api/customers"), []);
  const products = useLoad(() => api.get<Product[]>("/api/products"), []);
  const existing = useLoad(() => (id ? api.get<ContractFull>(`/api/contracts/${id}`) : Promise.resolve(null)), [id]);
  if (customers.loading || products.loading || existing.loading) return <Loading />;
  if (customers.error || existing.error) return <ErrorBox error={customers.error ?? existing.error ?? ""} />;
  return <ContractForm id={id} initial={existing.data ?? null} customerId={customerId} customers={customers.data ?? []} products={products.data ?? []} />;
}

function ContractForm({ id, initial, customerId, customers, products }: { id?: string; initial: ContractFull | null; customerId?: string; customers: Customer[]; products: Product[] }) {
  const api = useApi();
  const toast = useToast();
  const { go, back } = useNav();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const small = settings.invoice.smallBusiness;
  const rates = settings.invoice.taxRates.length ? settings.invoice.taxRates : [19, 7, 0];
  const empty = (): InvoiceItem => ({ productId: null, name: "", description: null, quantity: 1, unit: "Monat", unitPriceNet: 0, taxRate: small ? 0 : settings.invoice.defaultTaxRate, discountBps: 0 });
  const [d, setD] = useState<Draft>(() =>
    initial
      ? {
          customerId: initial.customerId,
          title: initial.title,
          description: initial.description,
          contactPerson: initial.contactPerson,
          status: initial.status === "DRAFT" ? "DRAFT" : "ACTIVE",
          startDate: initial.startDate,
          endDate: initial.endDate,
          minTermMonths: initial.minTermMonths,
          renewalMonths: initial.renewalMonths,
          noticeValue: initial.noticeValue,
          noticeUnit: initial.noticeUnit,
          interval: initial.interval,
          items: initial.items.map(({ id: _i, lineNet: _l, ...rest }) => rest),
          signedAt: initial.signedAt,
          notes: initial.notes,
        }
      : {
          customerId: customerId ?? "",
          title: "",
          description: null,
          contactPerson: null,
          status: "ACTIVE",
          startDate: todayIso().slice(0, 8) + "01",
          endDate: null,
          minTermMonths: 12,
          renewalMonths: 12,
          noticeValue: 3,
          noticeUnit: "MONTHS",
          interval: "MONTHLY",
          items: [empty()],
          signedAt: null,
          notes: null,
        },
  );
  const [billing, setBilling] = useState({ enabled: true, firstDate: todayIso().slice(0, 8) + "01", autoIssue: true });
  const [preview, setPreview] = useState<ContractPreview | null>(null);
  const set = <K extends keyof Draft>(k: K) => (v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const updateItem = (i: number, patch: Partial<InvoiceItem>) => setD((x) => ({ ...x, items: x.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }));
  const cancelled = initial?.status === "CANCELLED" || initial?.status === "ENDED";

  const body = () => ({ ...d, items: d.items.map((i) => ({ ...i, quantity: i.quantity || 0 })) });
  // Fristen live berechnen
  const seq = useRef(0);
  useEffect(() => {
    const valid = d.customerId && d.title.trim() && d.items.every((i) => i.name.trim() && i.quantity);
    if (!valid) return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      api
        .post<ContractPreview>("/api/contracts/preview", body())
        .then((p) => n === seq.current && setPreview(p))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);

  useEffect(() => {
    if (!initial && d.startDate > billing.firstDate) setBilling((b) => ({ ...b, firstDate: d.startDate }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.startDate]);

  const validate = () => {
    if (!d.customerId) return "Bitte einen Kunden wählen";
    if (!d.title.trim()) return "Bitte eine Bezeichnung angeben";
    const bad = d.items.findIndex((i) => !i.name.trim() || !i.quantity);
    if (bad >= 0) return `Position ${bad + 1}: Bezeichnung und Menge angeben`;
    if (d.endDate && d.endDate < d.startDate) return "Das Ende liegt vor dem Beginn";
    return null;
  };

  const save = () => {
    const e = validate();
    if (e) return toast.error(e);
    void run("save", async () => {
      if (id) {
        await api.put(`/api/contracts/${id}`, body());
        go({ name: "contract", id });
      } else {
        const r = await api.post<{ id: string }>("/api/contracts", { contract: body(), billing });
        go({ name: "contract", id: r.id });
      }
    }, id ? "Vertrag gespeichert" : "Vertrag angelegt");
  };

  const net = d.items.reduce((a, i) => {
    const line = Math.round((i.quantity || 0) * i.unitPriceNet);
    return a + line - Math.round((line * (i.discountBps ?? 0)) / 10000);
  }, 0);

  return (
    <>
      <PageHeader
        title={id ? `Vertrag ${initial?.number ?? ""} bearbeiten` : "Neuer Vertrag"}
        actions={
          <>
            <Button variant="ghost" onClick={back}>Abbrechen</Button>
            <Button variant="primary" busy={busy === "save"} onClick={save}>{id ? "Speichern" : "Vertrag anlegen"}</Button>
          </>
        }
      />
      <div className="editor-head">
        <TextField label="Bezeichnung" value={d.title} onChange={set("title")} placeholder="z. B. Wartungsvertrag Webseite" span={2} autoFocus={!id} />
        <div className="field span-2">
          <label htmlFor="ccust">Kunde</label>
          <select id="ccust" value={d.customerId} onChange={(e) => set("customerId")(e.target.value)} disabled={!!id}>
            <option value="">Kunde wählen</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{customerName(c)} ({c.number})</option>
            ))}
          </select>
        </div>
        <TextField label="Ansprechpartner" value={d.contactPerson} onChange={(v) => set("contactPerson")(v || null)} placeholder="optional" />
        <TextField label="Beginn" type="date" value={d.startDate} onChange={(v) => set("startDate")(v || todayIso())} />
        <TextField label="Unterschrieben am" type="date" value={d.signedAt} onChange={(v) => set("signedAt")(v || null)} hint="optional" />
        <SelectField label="Abrechnung" value={d.interval} onChange={set("interval")} options={INTERVALS} />
      </div>

      <Section title="Laufzeit und Kündigung">
        {cancelled ? (
          <p className="muted">Der Vertrag ist gekündigt und endet am {date(initial?.endDate)}. Laufzeit und Frist lassen sich nicht mehr ändern.</p>
        ) : (
          <>
            <div className="preset-row">
              {PRESETS.map((p) => {
                const on = p.v.minTermMonths === d.minTermMonths && p.v.renewalMonths === d.renewalMonths && p.v.noticeValue === d.noticeValue && p.v.noticeUnit === d.noticeUnit;
                return (
                  <button key={p.label} type="button" className={`preset ${on ? "on" : ""}`} onClick={() => setD((x) => ({ ...x, ...p.v, endDate: null }))}>
                    <strong>{p.label}</strong>
                    <span>{p.hint}</span>
                  </button>
                );
              })}
            </div>
            <div className="grid-4">
              <NumberField0 label="Mindestlaufzeit" value={d.minTermMonths} onChange={set("minTermMonths")} suffix="Monate" hint="0 = keine" />
              <NumberField0 label="Verlängert sich um" value={d.renewalMonths} onChange={set("renewalMonths")} suffix="Monate" hint="0 = danach jederzeit kündbar" />
              <div className="field">
                <label>Kündigungsfrist</label>
                <div className="inline-form">
                  <NumberInput ariaLabel="Kündigungsfrist" value={d.noticeValue} onChange={(v) => set("noticeValue")(Math.max(0, Math.round(v ?? 0)))} digits={0} />
                  <select aria-label="Einheit" value={d.noticeUnit} onChange={(e) => set("noticeUnit")(e.target.value as NoticeUnit)}>
                    <option value="DAYS">Tage</option>
                    <option value="WEEKS">Wochen</option>
                    <option value="MONTHS">Monate</option>
                  </select>
                </div>
                <div className="field-hint">zum Laufzeitende</div>
              </div>
              <TextField label="Fest befristet bis" type="date" value={d.endDate} onChange={(v) => set("endDate")(v || null)} hint="nur bei festem Ende" />
            </div>
            {preview ? (
              <div className="contract-preview">
                <Icon name="clock" />
                <span>
                  {term(d as unknown as Contract)}.{" "}
                  {preview.minTermEnd ? <>Mindestlaufzeit bis <strong>{date(preview.minTermEnd)}</strong>. </> : null}
                  {d.status === "ACTIVE" && preview.noticeDeadline && !d.endDate ? (
                    <>Frühestes Ende bei Kündigung heute: <strong>{date(preview.earliestEnd)}</strong> (Frist bis {date(preview.noticeDeadline)}).</>
                  ) : null}
                </span>
              </div>
            ) : null}
          </>
        )}
      </Section>

      <Section
        title="Leistungen"
        aside={
          <div className="inline-actions">
            <select
              className="product-picker"
              value=""
              aria-label="Produkt einfügen"
              onChange={(e) => {
                const p = products.find((x) => x.id === e.target.value);
                if (!p) return;
                const it: InvoiceItem = { productId: p.id, name: p.name, description: p.description, quantity: 1, unit: p.unit, unitPriceNet: p.priceNet, taxRate: p.taxRate, discountBps: 0 };
                setD((x) => ({ ...x, items: x.items.length === 1 && !x.items[0].name ? [it] : [...x.items, it] }));
              }}
            >
              <option value="">Produkt einfügen …</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name} – {money(p.priceNet)}/{p.unit}</option>)}
            </select>
            <Button variant="ghost" onClick={() => setD((x) => ({ ...x, items: [...x.items, empty()] }))}>Freie Position</Button>
          </div>
        }
      >
        <table className="table items">
          <thead>
            <tr>
              <th>Leistung</th>
              <th className="w-qty num">Menge</th>
              <th className="w-unit">Einheit</th>
              <th className="w-price num">Preis netto</th>
              {!small ? <th className="w-tax">USt.</th> : null}
              <th className="w-disc num">Rabatt %</th>
              <th className="w-act" />
            </tr>
          </thead>
          <tbody>
            {d.items.map((it, i) => (
              <tr key={i}>
                <td>
                  <input aria-label="Leistung" value={it.name} onChange={(e) => updateItem(i, { name: e.target.value })} placeholder="z. B. Wartung und Updates {monthName} {year}" />
                  <textarea className="item-desc" rows={1} aria-label="Beschreibung" value={it.description ?? ""} onChange={(e) => updateItem(i, { description: e.target.value || null })} placeholder="Beschreibung (optional)" />
                </td>
                <td><NumberInput ariaLabel="Menge" value={it.quantity} onChange={(v) => updateItem(i, { quantity: v ?? 0 })} /></td>
                <td><input aria-label="Einheit" value={it.unit} onChange={(e) => updateItem(i, { unit: e.target.value })} /></td>
                <td><MoneyInput ariaLabel="Preis" value={it.unitPriceNet} onChange={(v) => updateItem(i, { unitPriceNet: v ?? 0 })} allowNegative /></td>
                {!small ? (
                  <td>
                    <select aria-label="Steuersatz" value={String(it.taxRate)} onChange={(e) => updateItem(i, { taxRate: Number(e.target.value) })}>
                      {[...new Set([...rates, it.taxRate])].map((r) => <option key={r} value={r}>{num(r)} %</option>)}
                    </select>
                  </td>
                ) : null}
                <td>
                  <NumberInput ariaLabel="Rabatt" digits={2} value={it.discountBps ? it.discountBps / 100 : null} onChange={(v) => updateItem(i, { discountBps: Math.min(10000, Math.max(0, Math.round((v ?? 0) * 100))) })} />
                </td>
                <td className="row-actions">
                  <button className="icon-btn" onClick={() => setD((x) => ({ ...x, items: x.items.filter((_, j) => j !== i) }))} disabled={d.items.length === 1} aria-label="Position entfernen">×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="contract-total">
          <span>{money(net)} netto je {PER[d.interval]}</span>
          {d.interval !== "MONTHLY" ? <span className="muted"> = {money(preview?.monthlyNet ?? 0)} im Monat</span> : null}
          {!small && preview ? <span className="muted"> · {money(preview.grossPerInterval)} brutto</span> : null}
        </p>
        <p className="muted small">Platzhalter in den Positionen ({"{month}"}, {"{monthName}"}, {"{year}"}, {"{period}"}) werden auf jeder Rechnung durch den abgerechneten Zeitraum ersetzt.</p>
      </Section>

      <Section title="Sonstiges">
        <TextArea label="Vertragsgegenstand / Beschreibung" value={d.description} onChange={(v) => set("description")(v || null)} rows={3} />
        <TextArea label="Interne Notizen" value={d.notes} onChange={(v) => set("notes")(v || null)} rows={2} />
        {!cancelled ? <Toggle label="Als Entwurf speichern" checked={d.status === "DRAFT"} onChange={(v) => set("status")(v ? "DRAFT" : "ACTIVE")} hint="Entwürfe zählen nicht zu den Einnahmen und werden nicht abgerechnet." /> : null}
      </Section>

      {!id ? (
        <Section title="Abrechnung">
          <Toggle
            label="Automatisch abrechnen (Abo-Rechnung anlegen)"
            checked={billing.enabled}
            onChange={(v) => setBilling((b) => ({ ...b, enabled: v }))}
            hint="Kontor stellt die Rechnungen im gewählten Rhythmus aus. Kündigung und Vertragsende werden übernommen."
          />
          {billing.enabled ? (
            <div className="grid-4">
              <TextField label="Erste Rechnung am" type="date" value={billing.firstDate} onChange={(v) => setBilling((b) => ({ ...b, firstDate: v || todayIso() }))} />
              <div className="span-3" style={{ alignSelf: "end" }}>
                <Toggle label="Automatisch ausstellen und versenden" checked={billing.autoIssue} onChange={(v) => setBilling((b) => ({ ...b, autoIssue: v }))} hint={billing.autoIssue ? undefined : "Es wird nur ein Entwurf angelegt."} />
              </div>
            </div>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}

function NumberField0({ label, value, onChange, suffix, hint }: { label: string; value: number; onChange: (n: number) => void; suffix: string; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      {(fid) => (
        <div className="suffix-input">
          <NumberInput id={fid} value={value} onChange={(v) => onChange(Math.max(0, Math.min(120, Math.round(v ?? 0))))} digits={0} />
          <span>{suffix}</span>
        </div>
      )}
    </Field>
  );
}

// ===================== Detail =====================
export function ContractDetail({ id }: { id: string }) {
  const api = useApi();
  const toast = useToast();
  const { go, back } = useNav();
  const { busy, run } = useAction();
  const { data: c, error, loading, reload } = useLoad(() => api.get<ContractFull>(`/api/contracts/${id}`), [id]);
  const [dialog, setDialog] = useState<null | "cancel" | "revoke" | "delete" | "billing">(null);
  const fileRef = useRef<HTMLInputElement>(null);
  if (loading && !c) return <Loading />;
  if (error || !c) return <ErrorBox error={error ?? "Nicht gefunden"} onRetry={reload} />;

  const upload = (f: File | undefined) => {
    if (!f) return;
    void run("doc", async () => {
      await api.put(`/api/contracts/${id}/document`, { document: { name: f.name, type: f.type || undefined, data: await fileToBase64(f) } });
      reload();
    }, "Dokument gespeichert");
    if (fileRef.current) fileRef.current.value = "";
  };

  const running = c.status === "ACTIVE" || c.status === "CANCELLED";
  return (
    <>
      <PageHeader
        title={
          <span className="title-with-badge">
            {c.title} <span className={`badge ${CONTRACT_STATUS[c.status].cls}`}>{CONTRACT_STATUS[c.status].label}</span>
          </span>
        }
        sub={<>{c.number} · {c.customerName}</>}
        actions={
          <>
            <Button variant="ghost" onClick={back}>Zurück</Button>
            <Button onClick={() => go({ name: "contract-edit", id })}>Bearbeiten</Button>
            {c.status === "ACTIVE" ? <Button onClick={() => setDialog("cancel")}>Kündigung erfassen</Button> : null}
            {c.status === "CANCELLED" ? <Button onClick={() => setDialog("revoke")}>Kündigung zurücknehmen</Button> : null}
          </>
        }
      />
      {c.status === "CANCELLED" ? (
        <div className="hint hint-info">
          <span>
            Gekündigt {c.cancelledBy === "US" ? "von uns" : "vom Kunden"} (eingegangen am {date(c.cancelledAt)}){c.cancelReason ? ` – ${c.cancelReason}` : ""}. Der Vertrag endet am <strong>{date(c.endDate)}</strong>
            {c.recurringId ? ", die Abo-Rechnung stoppt automatisch." : "."}
          </span>
        </div>
      ) : c.status === "ACTIVE" && c.noticeDeadline ? (
        <div className="hint">
          <span>
            Nächste Kündigungsmöglichkeit: zum <strong>{date(c.earliestEnd)}</strong>, Kündigung muss bis <strong>{date(c.noticeDeadline)}</strong> eingehen.
          </span>
        </div>
      ) : null}

      <div className="detail-grid">
        <div className="detail-main">
          <Section title="Leistungen">
            <table className="table compact">
              <thead>
                <tr><th>Leistung</th><th className="num">Menge</th><th className="num">Preis netto</th><th className="num">Gesamt</th></tr>
              </thead>
              <tbody>
                {c.items.map((it, i) => {
                  const line = Math.round(it.quantity * it.unitPriceNet);
                  const disc = Math.round((line * (it.discountBps ?? 0)) / 10000);
                  return (
                    <tr key={i}>
                      <td>
                        <strong>{it.name}</strong>
                        {it.description ? <div className="sub">{it.description}</div> : null}
                        {disc ? <div className="sub">Rabatt {num(it.discountBps / 100)} %: − {money(disc)}</div> : null}
                      </td>
                      <td className="num nowrap">{num(it.quantity)} {it.unit}</td>
                      <td className="num">{money(it.unitPriceNet)}</td>
                      <td className="num strong">{money(line - disc)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>je {PER[c.interval]} netto{c.interval !== "MONTHLY" ? ` (${money(c.monthlyNet)} im Monat)` : ""}</td>
                  <td className="num strong">{money(c.netPerInterval)}</td>
                </tr>
              </tfoot>
            </table>
            {c.description ? <p className="notes" style={{ marginTop: 12 }}>{c.description}</p> : null}
          </Section>

          <Section
            title="Abrechnung"
            aside={c.recurringId ? <Button variant="ghost" className="btn-sm" onClick={() => go({ name: "recurring-edit", id: c.recurringId! })}>Abo-Rechnung öffnen</Button> : null}
          >
            {c.recurring ? (
              <p>
                {c.recurring.active ? (
                  <>Nächste Rechnung am <strong>{date(c.recurring.nextDate)}</strong> ({c.recurring.autoIssue ? "wird automatisch ausgestellt und versendet" : "als Entwurf"}).</>
                ) : (
                  <span className="muted">Die Abo-Rechnung ist pausiert bzw. beendet.</span>
                )}{" "}
                Bisher abgerechnet: <strong>{money(c.billed)}</strong> brutto.
                {c.recurring.lastError ? <span className="text-danger"> Letzter Fehler: {c.recurring.lastError}</span> : null}
              </p>
            ) : running ? (
              <div className="inline-form">
                <span className="muted">Dieser Vertrag wird noch nicht automatisch abgerechnet.</span>
                <Button className="btn-sm" onClick={() => setDialog("billing")}>Abo-Rechnung anlegen</Button>
              </div>
            ) : (
              <p className="muted">Keine Abrechnung.</p>
            )}
            {c.invoices.length ? (
              <table className="table compact clickable" style={{ marginTop: 10 }}>
                <tbody>
                  {c.invoices.map((i) => (
                    <tr key={i.id} onClick={() => go({ name: "invoice", id: i.id })}>
                      <td className="nowrap">{i.number ?? "Entwurf"}</td>
                      <td className="muted nowrap">{date(i.issueDate)}</td>
                      <td><StatusBadge status={i.status} /></td>
                      <td className="num">{money(i.totalGross)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </Section>
        </div>

        <aside className="detail-side">
          <dl className="facts">
            <div><dt>Kunde</dt><dd><button className="link" onClick={() => go({ name: "customer", id: c.customerId })}>{c.customerName}</button></dd></div>
            {c.contactPerson ? <div><dt>Ansprechpartner</dt><dd>{c.contactPerson}</dd></div> : null}
            <div><dt>Monatlich</dt><dd className="strong">{money(c.monthlyNet)}</dd></div>
            <div><dt>Beginn</dt><dd>{date(c.startDate)}</dd></div>
            {c.signedAt ? <div><dt>Unterschrieben</dt><dd>{date(c.signedAt)}</dd></div> : null}
            {c.minTermEnd ? <div><dt>Mindestlaufzeit bis</dt><dd>{date(c.minTermEnd)}</dd></div> : null}
            <div><dt>Laufzeit</dt><dd className="small">{term(c)}</dd></div>
            <div><dt>Kündigungsfrist</dt><dd>{notice(c)}</dd></div>
            {c.endDate ? <div><dt>Ende</dt><dd>{date(c.endDate)}</dd></div> : null}
          </dl>
          <div className="card-plain">
            <h3><Icon name="contract" /> Vertragsdokument</h3>
            {c.hasDocument ? (
              <>
                <p className="small break">{c.documentName}</p>
                <div className="row-actions">
                  <Button
                    variant="ghost"
                    className="btn-sm"
                    busy={busy === "dl"}
                    onClick={() =>
                      run("dl", async () => {
                        const f = await api.download(`/api/contracts/${id}/document`);
                        await saveFile(f.blob, decodeURIComponent(f.filename));
                      })
                    }
                  >
                    Speichern
                  </Button>
                  <Button variant="ghost" className="btn-sm" onClick={() => fileRef.current?.click()}>Ersetzen</Button>
                </div>
              </>
            ) : (
              <>
                <p className="muted small">Unterschriebenen Vertrag als PDF ablegen.</p>
                <Button className="btn-sm" busy={busy === "doc"} onClick={() => fileRef.current?.click()}>Datei hochladen</Button>
              </>
            )}
            <input ref={fileRef} type="file" hidden accept=".pdf,image/*" onChange={(e) => upload(e.target.files?.[0])} />
          </div>
          {c.notes ? <p className="notes">{c.notes}</p> : null}
          <Button variant="ghost" className="danger-text" onClick={() => setDialog("delete")}>Vertrag löschen</Button>
        </aside>
      </div>

      {dialog === "cancel" ? <CancelDialog c={c} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} /> : null}
      {dialog === "billing" ? <BillingDialog c={c} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} /> : null}
      {dialog === "revoke" ? (
        <Confirm
          title="Kündigung zurücknehmen?"
          text="Der Vertrag läuft dann unverändert weiter, das Vertragsende wird entfernt."
          confirmLabel="Zurücknehmen"
          busy={busy === "revoke"}
          onCancel={() => setDialog(null)}
          onConfirm={() => run("revoke", async () => { await api.post(`/api/contracts/${id}/revoke-cancel`); setDialog(null); reload(); }, "Kündigung zurückgenommen")}
        />
      ) : null}
      {dialog === "delete" ? (
        <Confirm
          title="Vertrag löschen?"
          text={`Der Vertrag wird endgültig gelöscht.${c.recurringId ? " Die verknüpfte Abo-Rechnung wird pausiert, bereits erstellte Rechnungen bleiben erhalten." : ""} Für beendete Verträge besser „Kündigung erfassen“ nutzen, damit die Historie erhalten bleibt.`}
          confirmLabel="Löschen"
          danger
          busy={busy === "del"}
          onCancel={() => setDialog(null)}
          onConfirm={() => run("del", async () => { await api.del(`/api/contracts/${id}`); toast.ok("Vertrag gelöscht"); go({ name: "contracts" }); })}
        />
      ) : null}
    </>
  );
}

function CancelDialog({ c, onClose, onDone }: { c: ContractFull; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [receivedAt, setReceivedAt] = useState(todayIso());
  const [by, setBy] = useState<"CUSTOMER" | "US">("CUSTOMER");
  const [custom, setCustom] = useState(false);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  return (
    <Modal
      title="Kündigung erfassen"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            busy={busy === "cancel"}
            onClick={() =>
              run("cancel", async () => {
                await api.post(`/api/contracts/${c.id}/cancel`, { receivedAt, by, endDate: custom ? endDate : null, reason: reason || undefined });
                onDone();
              }, "Kündigung erfasst")
            }
          >
            Kündigung speichern
          </Button>
        </>
      }
    >
      <p className="muted">
        Kontor berechnet das Vertragsende aus Laufzeit und Frist ({notice(c)}). Bei Kündigung heute wäre das der <strong>{date(c.earliestEnd)}</strong>.
      </p>
      <div className="grid-2">
        <SelectField label="Gekündigt von" value={by} onChange={setBy} options={[{ value: "CUSTOMER", label: "Kunde" }, { value: "US", label: "uns" }]} />
        <TextField label="Kündigung eingegangen am" type="date" value={receivedAt} onChange={(v) => setReceivedAt(v || todayIso())} />
      </div>
      <Toggle label="Abweichendes Vertragsende (z. B. Sonderkündigung)" checked={custom} onChange={setCustom} />
      {custom ? <TextField label="Vertragsende" type="date" value={endDate} onChange={(v) => setEndDate(v || null)} /> : null}
      <TextArea label="Grund (optional)" value={reason} onChange={setReason} rows={2} />
    </Modal>
  );
}

function BillingDialog({ c, onClose, onDone }: { c: ContractFull; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [firstDate, setFirstDate] = useState(todayIso() < c.startDate ? c.startDate : todayIso());
  const [autoIssue, setAutoIssue] = useState(true);
  return (
    <Modal
      title="Abo-Rechnung anlegen"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" busy={busy === "b"} onClick={() => run("b", async () => { await api.post(`/api/contracts/${c.id}/billing`, { enabled: true, firstDate, autoIssue }); onDone(); }, "Abo-Rechnung angelegt")}>
            Anlegen
          </Button>
        </>
      }
    >
      <p className="muted">Die Leistungen des Vertrags werden {INTERVAL_LABEL[c.interval]} abgerechnet. Änderungen am Vertrag werden übernommen.</p>
      <TextField label="Erste Rechnung am" type="date" value={firstDate} onChange={(v) => setFirstDate(v || todayIso())} />
      <Toggle label="Automatisch ausstellen und versenden" checked={autoIssue} onChange={setAutoIssue} />
    </Modal>
  );
}

/** Kompakte Liste für die Kundenseite */
export function CustomerContracts({ customerId }: { customerId: string }) {
  const api = useApi();
  const { go } = useNav();
  const { data } = useLoad(() => api.get<Contract[]>(`/api/contracts?customerId=${customerId}&status=ALL`), [customerId]);
  const list = data ?? [];
  const monthly = list.filter((c) => c.status === "ACTIVE" || c.status === "CANCELLED").reduce((a, c) => a + c.monthlyNet, 0);
  return (
    <Section title="Verträge" aside={<Button variant="ghost" className="btn-sm" onClick={() => go({ name: "contract-edit", customerId })}>Vertrag anlegen</Button>}>
      {!list.length ? (
        <p className="muted">Keine Verträge.</p>
      ) : (
        <>
          {monthly ? <p>Laufende Verträge: <strong>{money(monthly)}</strong> netto im Monat.</p> : null}
          <table className="table compact clickable">
            <tbody>
              {list.map((c) => (
                <tr key={c.id} onClick={() => go({ name: "contract", id: c.id })}>
                  <td>
                    <strong>{c.title}</strong>
                    <div className="sub">{c.number} · seit {date(c.startDate)}</div>
                  </td>
                  <td className="num nowrap">{money(c.monthlyNet)}<span className="sub">/Monat</span></td>
                  <td><span className={`badge ${CONTRACT_STATUS[c.status].cls}`}>{CONTRACT_STATUS[c.status].label}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Section>
  );
}
