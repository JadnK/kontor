import { useMemo, useState } from "react";
import { useAction, useApi, useLoad, useNav, useSession, useToast } from "../lib/store";
import { addDaysIso, customerName, date, money, num, todayIso } from "../lib/format";
import { calculate } from "../lib/calc";
import type { Customer, Discount, InvoiceFull, InvoiceItem, MailResult, Product, QuoteFull, Recurring, RecurringInterval } from "../lib/types";
import { Button, Confirm, ErrorBox, Loading, MoneyInput, NumberInput, PageHeader, Section, SelectField, TextArea, TextField, Toggle } from "../components/ui";
import { discountLabel } from "./Discounts";

/** Ein Editor für Rechnung, Angebot und Abo-Vorlage – Positionen, Rabatt und Steuer funktionieren überall gleich */
type Mode = "invoice" | "quote" | "recurring";

interface Draft {
  customerId: string;
  issueDate: string | null;
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  /** Rechnung: fällig am, Angebot: gültig bis */
  dueDate: string | null;
  subject: string | null;
  introText: string | null;
  footerText: string | null;
  notes: string | null;
  discountId: string | null;
  taxExemption: string | null;
  /** Absender-Profil (null = Hauptfirma) */
  profileId: string | null;
  items: InvoiceItem[];
  // nur Abo
  name: string;
  interval: RecurringInterval;
  nextDate: string;
  endDate: string | null;
  autoIssue: boolean;
  servicePeriod: boolean;
  active: boolean;
}

export const INTERVALS: { value: RecurringInterval; label: string }[] = [
  { value: "MONTHLY", label: "Monatlich" },
  { value: "QUARTERLY", label: "Vierteljährlich" },
  { value: "HALFYEARLY", label: "Halbjährlich" },
  { value: "YEARLY", label: "Jährlich" },
];

const emptyItem = (taxRate: number): InvoiceItem => ({
  productId: null,
  name: "",
  description: null,
  quantity: 1,
  unit: "Stk",
  unitPriceNet: 0,
  taxRate,
  discountBps: 0,
});

const base = (customerId: string, taxRate: number): Draft => ({
  customerId,
  issueDate: null,
  serviceDateFrom: null,
  serviceDateTo: null,
  dueDate: null,
  subject: null,
  introText: null,
  footerText: null,
  notes: null,
  discountId: null,
  taxExemption: null,
  profileId: null,
  items: [emptyItem(taxRate)],
  name: "",
  interval: "MONTHLY",
  nextDate: todayIso(),
  endDate: null,
  autoIssue: true,
  servicePeriod: true,
  active: true,
});

const copyItems = (items: InvoiceItem[]) => items.map(({ id: _i, lineNet: _l, ...rest }) => ({ ...rest }));

export function InvoiceEditor({ id, customerId }: { id?: string; customerId?: string }) {
  return <EditorLoader mode="invoice" id={id} customerId={customerId} />;
}
export function QuoteEditor({ id, customerId }: { id?: string; customerId?: string }) {
  return <EditorLoader mode="quote" id={id} customerId={customerId} />;
}
export function RecurringEditor({ id, customerId }: { id?: string; customerId?: string }) {
  return <EditorLoader mode="recurring" id={id} customerId={customerId} />;
}

const ENDPOINT: Record<Mode, string> = { invoice: "/api/invoices", quote: "/api/quotes", recurring: "/api/recurring" };

function EditorLoader({ mode, id, customerId }: { mode: Mode; id?: string; customerId?: string }) {
  const api = useApi();
  const { settings } = useSession();
  const existing = useLoad(() => (id ? api.get<InvoiceFull | QuoteFull | Recurring>(`${ENDPOINT[mode]}/${id}`) : Promise.resolve(null)), [id, mode]);
  const customers = useLoad(() => api.get<Customer[]>("/api/customers"), []);
  const products = useLoad(() => api.get<Product[]>("/api/products"), []);

  if (existing.loading || customers.loading || products.loading) return <Loading />;
  const err = existing.error || customers.error || products.error;
  if (err) return <ErrorBox error={err} />;
  const ex = existing.data;
  if (ex && mode !== "recurring" && (ex as InvoiceFull).status !== "DRAFT") {
    return <ErrorBox error={mode === "quote" ? "Versendete Angebote können nicht mehr bearbeitet werden." : "Ausgestellte Rechnungen können nicht mehr bearbeitet werden."} />;
  }

  let initial = base(customerId ?? "", settings.invoice.defaultTaxRate);
  initial.profileId = (customers.data ?? []).find((c) => c.id === customerId)?.profileId ?? null;
  if (ex && mode === "recurring") {
    const r = ex as Recurring;
    initial = {
      ...initial,
      customerId: r.customerId,
      subject: r.subject,
      introText: r.introText,
      notes: r.notes,
      discountId: r.discountId,
      taxExemption: r.taxExemption,
      items: copyItems(r.items),
      name: r.name,
      interval: r.interval,
      nextDate: r.nextDate,
      endDate: r.endDate,
      autoIssue: r.autoIssue,
      servicePeriod: r.servicePeriod,
      active: r.active,
    };
  } else if (ex) {
    const i = ex as InvoiceFull & QuoteFull;
    initial = {
      ...initial,
      customerId: i.customerId,
      issueDate: i.issueDate,
      serviceDateFrom: i.serviceDateFrom,
      serviceDateTo: i.serviceDateTo,
      dueDate: mode === "quote" ? i.validUntil : i.dueDate,
      subject: i.subject,
      introText: i.introText,
      footerText: i.footerText,
      notes: i.notes,
      discountId: i.discountId,
      taxExemption: i.taxExemption,
      profileId: i.profileId ?? null,
      items: copyItems(i.items),
    };
  } else {
    initial.introText = mode === "quote" ? settings.quotes.introText : mode === "invoice" ? settings.invoice.introText : null;
  }
  return <Editor mode={mode} id={id} initial={initial} customers={customers.data ?? []} products={products.data ?? []} />;
}

function Editor({ mode, id, initial, customers, products }: { mode: Mode; id?: string; initial: Draft; customers: Customer[]; products: Product[] }) {
  const api = useApi();
  const toast = useToast();
  const { go, back } = useNav();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const [d, setD] = useState<Draft>(initial);
  const [confirmIssue, setConfirmIssue] = useState(false);
  const set = <K extends keyof Draft>(k: K) => (v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const profiles = settings.profiles?.list ?? [];
  const profile = profiles.find((p) => p.id === d.profileId) ?? null;
  const small = profile && profile.smallBusiness !== "inherit" ? profile.smallBusiness === "yes" : settings.invoice.smallBusiness;
  const rates = settings.invoice.taxRates.length ? settings.invoice.taxRates : [19, 7, 0];
  const customer = customers.find((c) => c.id === d.customerId) ?? null;
  const mailOn = settings.mail.enabled && !!settings.mail.host;

  const discounts = useLoad(
    () => (d.customerId ? api.get<Discount[]>(`/api/discounts/applicable?customerId=${d.customerId}`) : Promise.resolve([] as Discount[])),
    [d.customerId],
  );
  const discount = (discounts.data ?? []).find((x) => x.id === d.discountId) ?? null;

  const totals = useMemo(
    () =>
      calculate(
        d.items.map((i) => ({ ...i, quantity: i.quantity || 0 })),
        discount ? { type: discount.type, value: discount.value, scope: discount.scope, productId: discount.productId, minOrderNet: discount.minOrderNet } : null,
        small,
      ),
    [d.items, discount, small],
  );

  const updateItem = (idx: number, patch: Partial<InvoiceItem>) =>
    setD((x) => ({ ...x, items: x.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) }));
  const removeItem = (idx: number) => setD((x) => ({ ...x, items: x.items.filter((_, i) => i !== idx) }));
  const moveItem = (idx: number, dir: -1 | 1) =>
    setD((x) => {
      const items = [...x.items];
      const j = idx + dir;
      if (j < 0 || j >= items.length) return x;
      [items[idx], items[j]] = [items[j], items[idx]];
      return { ...x, items };
    });
  const addProduct = (pid: string) => {
    const p = products.find((x) => x.id === pid);
    if (!p) return;
    const item: InvoiceItem = { productId: p.id, name: p.name, description: p.description, quantity: 1, unit: p.unit, unitPriceNet: p.priceNet, taxRate: p.taxRate, discountBps: 0 };
    setD((x) => {
      const items = x.items.length === 1 && !x.items[0].name && !x.items[0].unitPriceNet ? [item] : [...x.items, item];
      return { ...x, items };
    });
  };

  const validate = (): string | null => {
    if (mode === "recurring" && !d.name.trim()) return "Bitte einen Namen für das Abo angeben";
    if (!d.customerId) return "Bitte einen Kunden wählen";
    if (!d.items.length) return "Mindestens eine Position anlegen";
    const bad = d.items.findIndex((i) => !i.name.trim() || !i.quantity);
    if (bad >= 0) return `Position ${bad + 1}: Bezeichnung und Menge angeben`;
    if (mode === "recurring" && d.endDate && d.endDate < d.nextDate) return "Das Enddatum liegt vor der nächsten Rechnung";
    return null;
  };

  const body = () => {
    const items = d.items.map(({ id: _id, lineNet: _l, ...rest }) => rest);
    const common = { customerId: d.customerId, subject: d.subject, introText: d.introText, notes: d.notes, discountId: d.discountId, taxExemption: d.taxExemption, items };
    if (mode !== "recurring" && profiles.length) Object.assign(common, { profileId: d.profileId });
    if (mode === "recurring")
      return { ...common, name: d.name, interval: d.interval, nextDate: d.nextDate, endDate: d.endDate, autoIssue: d.autoIssue, servicePeriod: d.servicePeriod, active: d.active };
    const dates = { issueDate: d.issueDate, serviceDateFrom: d.serviceDateFrom, serviceDateTo: d.serviceDateTo, footerText: d.footerText };
    return mode === "quote" ? { ...common, ...dates, validUntil: d.dueDate } : { ...common, ...dates, dueDate: d.dueDate };
  };

  const persist = async (): Promise<string> => {
    if (id) {
      await api.put(`${ENDPOINT[mode]}/${id}`, body());
      return id;
    }
    return (await api.post<{ id: string }>(ENDPOINT[mode], body())).id;
  };

  const save = () => {
    const e = validate();
    if (e) return toast.error(e);
    void run(
      "draft",
      async () => {
        const newId = await persist();
        go(mode === "invoice" ? { name: "invoice", id: newId } : mode === "quote" ? { name: "quote", id: newId } : { name: "recurring" });
      },
      mode === "recurring" ? "Abo gespeichert" : "Entwurf gespeichert",
    );
  };

  const issue = (send: boolean) =>
    run("issue", async () => {
      const newId = await persist();
      if (mode === "quote") {
        const r = await api.post<{ mail: MailResult | null }>(`/api/quotes/${newId}/send`, { send });
        if (r.mail?.ok) toast.ok(`Angebot an ${customer?.email} gesendet`);
        else if (r.mail?.error || r.mail?.skipped) toast.error(`Angebot festgeschrieben, aber nicht gesendet: ${r.mail.error ?? r.mail.skipped}`);
        else toast.ok("Angebot festgeschrieben");
        setConfirmIssue(false);
        go({ name: "quote", id: newId });
        return;
      }
      const r = await api.post<{ id: string; mail: MailResult | null }>(`/api/invoices/${newId}/issue`, { send: true });
      if (r.mail?.ok) toast.ok(`Rechnung ausgestellt und an ${customer?.email} gesendet`);
      else if (r.mail?.error) toast.error(`Rechnung ausgestellt, aber E-Mail fehlgeschlagen: ${r.mail.error}`);
      else toast.ok(r.mail?.skipped ? `Rechnung ausgestellt (${r.mail.skipped})` : "Rechnung ausgestellt");
      setConfirmIssue(false);
      go({ name: "invoice", id: newId });
    });

  const zeroLines = !small && d.items.some((i) => i.taxRate === 0);
  const exemptions = settings.invoice.taxExemptions;
  const exemption = exemptions.find((x) => x.code === (d.taxExemption ?? settings.invoice.defaultExemption)) ?? exemptions[0];
  const issueDate = d.issueDate ?? todayIso();
  const autoDue = addDaysIso(issueDate, mode === "quote" ? settings.quotes.validDays : settings.invoice.paymentDays);
  const willMail = mailOn && !!customer?.email && (mode === "quote" || settings.automation.sendInvoiceOnIssue);

  const title =
    mode === "recurring" ? (id ? "Abo-Rechnung bearbeiten" : "Neue Abo-Rechnung") : mode === "quote" ? (id ? "Angebot bearbeiten" : "Neues Angebot") : id ? "Entwurf bearbeiten" : "Neue Rechnung";

  return (
    <>
      <PageHeader
        title={title}
        actions={
          <>
            <Button variant="ghost" onClick={back}>Abbrechen</Button>
            <Button variant={mode === "recurring" ? "primary" : "secondary"} busy={busy === "draft"} onClick={save}>
              {mode === "recurring" ? "Speichern" : "Als Entwurf speichern"}
            </Button>
            {mode !== "recurring" ? (
              <Button
                variant="primary"
                onClick={() => {
                  const e = validate();
                  if (e) toast.error(e);
                  else setConfirmIssue(true);
                }}
              >
                {mode === "quote" ? "Angebot senden" : "Ausstellen"}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="editor-head">
        {mode === "recurring" ? <TextField label="Name" value={d.name} onChange={set("name")} placeholder="z. B. Hosting Praxis Dr. Weber" span={2} /> : null}
        <div className="field span-2">
          <label htmlFor="cust">Kunde</label>
          <select
            id="cust"
            value={d.customerId}
            onChange={(e) => {
              const c = customers.find((x) => x.id === e.target.value);
              setD((x) => ({ ...x, customerId: e.target.value, discountId: null, profileId: c?.profileId ?? x.profileId }));
            }}
          >
            <option value="">Kunde wählen</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {customerName(c)} ({c.number})
              </option>
            ))}
          </select>
          {customer ? (
            <div className="field-hint">
              {[customer.street, [customer.zip, customer.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
              {customer.email ? ` – ${customer.email}` : " – keine E-Mail hinterlegt"}
            </div>
          ) : null}
        </div>
        {mode !== "recurring" && profiles.length ? (
          <SelectField
            label="Absender"
            value={d.profileId ?? ""}
            onChange={(v) => set("profileId")(v || null)}
            options={[{ value: "", label: settings.company.name || "Hauptfirma" }, ...profiles.map((p) => ({ value: p.id, label: p.label }))]}
          />
        ) : null}
        {mode === "recurring" ? (
          <>
            <SelectField label="Rhythmus" value={d.interval} onChange={set("interval")} options={INTERVALS} />
            <TextField label="Nächste Rechnung am" type="date" value={d.nextDate} onChange={(v) => set("nextDate")(v || todayIso())} hint="Danach automatisch im Rhythmus" />
            <TextField label="Endet am" type="date" value={d.endDate} onChange={(v) => set("endDate")(v || null)} hint="Leer = unbefristet" />
            <TextField label="Betreff" value={d.subject} onChange={(v) => set("subject")(v || null)} placeholder="z. B. Hosting {monthName} {year}" />
          </>
        ) : (
          <>
            <TextField
              label={mode === "quote" ? "Angebotsdatum" : "Rechnungsdatum"}
              type="date"
              value={d.issueDate}
              onChange={(v) => set("issueDate")(v || null)}
              hint={mode === "quote" ? "Leer = Tag des Versands" : "Leer = Tag des Ausstellens"}
            />
            <TextField
              label={mode === "quote" ? "Gültig bis" : "Fällig am"}
              type="date"
              value={d.dueDate}
              onChange={(v) => set("dueDate")(v || null)}
              hint={`Leer = ${mode === "quote" ? settings.quotes.validDays : settings.invoice.paymentDays} Tage (${date(autoDue)})`}
            />
            <TextField label="Leistung von" type="date" value={d.serviceDateFrom} onChange={(v) => set("serviceDateFrom")(v || null)} hint={mode === "quote" ? "Optional" : "Leer = Rechnungsdatum"} />
            <TextField label="Leistung bis" type="date" value={d.serviceDateTo} onChange={(v) => set("serviceDateTo")(v || null)} hint="Nur bei Zeiträumen" />
            <TextField label="Betreff" value={d.subject} onChange={(v) => set("subject")(v || null)} span={2} placeholder="z. B. Relaunch Webseite" />
          </>
        )}
      </div>

      {mode === "recurring" ? (
        <div className="toggle-grid">
          <Toggle
            label="Automatisch ausstellen und versenden"
            checked={d.autoIssue}
            onChange={set("autoIssue")}
            hint={d.autoIssue ? "Am Stichtag wird die Rechnung ausgestellt und an den Kunden gemailt." : "Am Stichtag wird nur ein Entwurf angelegt, den du selbst prüfst."}
          />
          <Toggle label="Abgerechneten Zeitraum als Leistungszeitraum eintragen" checked={d.servicePeriod} onChange={set("servicePeriod")} hint="z. B. 01.11.2026 – 30.11.2026 bei monatlich" />
          <Toggle label="Aktiv" checked={d.active} onChange={set("active")} hint="Pausierte Abos erzeugen keine Rechnungen" />
        </div>
      ) : null}

      <Section
        title="Positionen"
        aside={
          <div className="inline-actions">
            <select className="product-picker" value="" onChange={(e) => addProduct(e.target.value)} aria-label="Produkt einfügen">
              <option value="">Produkt einfügen …</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} – {money(p.priceNet)}/{p.unit}
                </option>
              ))}
            </select>
            <Button variant="ghost" onClick={() => setD((x) => ({ ...x, items: [...x.items, emptyItem(settings.invoice.defaultTaxRate)] }))}>
              Freie Position
            </Button>
          </div>
        }
      >
        <table className="table items">
          <thead>
            <tr>
              <th className="w-pos">Pos.</th>
              <th>Bezeichnung</th>
              <th className="w-qty num">Menge</th>
              <th className="w-unit">Einheit</th>
              <th className="w-price num">Einzelpreis netto</th>
              {!small ? <th className="w-tax">USt.</th> : null}
              <th className="w-disc num">Rabatt %</th>
              <th className="w-total num">Gesamt netto</th>
              <th className="w-act" />
            </tr>
          </thead>
          <tbody>
            {d.items.map((it, idx) => (
              <tr key={idx}>
                <td className="muted">{idx + 1}</td>
                <td>
                  <input
                    aria-label={`Bezeichnung Position ${idx + 1}`}
                    value={it.name}
                    onChange={(e) => updateItem(idx, { name: e.target.value })}
                    placeholder={mode === "recurring" ? "z. B. Webhosting {monthName} {year}" : "Leistung oder Artikel"}
                  />
                  <textarea
                    aria-label={`Beschreibung Position ${idx + 1}`}
                    className="item-desc"
                    rows={1}
                    value={it.description ?? ""}
                    onChange={(e) => updateItem(idx, { description: e.target.value || null })}
                    placeholder="Beschreibung (optional)"
                  />
                </td>
                <td><NumberInput ariaLabel="Menge" value={it.quantity} onChange={(v) => updateItem(idx, { quantity: v ?? 0 })} /></td>
                <td><input aria-label="Einheit" value={it.unit} onChange={(e) => updateItem(idx, { unit: e.target.value })} /></td>
                <td><MoneyInput ariaLabel="Einzelpreis" value={it.unitPriceNet} onChange={(v) => updateItem(idx, { unitPriceNet: v ?? 0 })} allowNegative /></td>
                {!small ? (
                  <td>
                    <select aria-label="Steuersatz" value={String(it.taxRate)} onChange={(e) => updateItem(idx, { taxRate: Number(e.target.value) })}>
                      {[...new Set([...rates, it.taxRate])].map((r) => (
                        <option key={r} value={r}>{num(r)} %</option>
                      ))}
                    </select>
                  </td>
                ) : null}
                <td>
                  <NumberInput
                    ariaLabel="Positionsrabatt"
                    digits={2}
                    value={it.discountBps ? it.discountBps / 100 : null}
                    onChange={(v) => updateItem(idx, { discountBps: Math.min(10000, Math.max(0, Math.round((v ?? 0) * 100))) })}
                  />
                </td>
                <td className="num strong">{money(totals.lines[idx] ?? 0)}</td>
                <td className="row-actions">
                  <button className="icon-btn" onClick={() => moveItem(idx, -1)} disabled={idx === 0} aria-label="Nach oben">↑</button>
                  <button className="icon-btn" onClick={() => moveItem(idx, 1)} disabled={idx === d.items.length - 1} aria-label="Nach unten">↓</button>
                  <button className="icon-btn" onClick={() => removeItem(idx)} aria-label="Position entfernen">×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="totals-row">
          <div>
            <div className="discount-pick">
              <label htmlFor="disc">Rabatt auf {mode === "quote" ? "das Angebot" : "die Rechnung"}</label>
              <select id="disc" value={d.discountId ?? ""} onChange={(e) => set("discountId")(e.target.value || null)} disabled={!d.customerId}>
                <option value="">Kein Rabatt</option>
                {(discounts.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} ({discountLabel(x)}){x.scope === "CUSTOMER" ? " – Kundenrabatt" : x.scope === "PRODUCT" ? " – Produktrabatt" : ""}
                  </option>
                ))}
              </select>
              {discount?.minOrderNet && totals.subtotalNet < discount.minOrderNet ? (
                <div className="field-hint text-warn">Mindestbestellwert {money(discount.minOrderNet)} noch nicht erreicht</div>
              ) : null}
              {small ? <div className="field-hint">Kleinunternehmerregelung aktiv. Es steht: „{settings.invoice.smallBusinessText}“</div> : null}
            </div>
            {zeroLines ? (
              <div className="discount-pick">
                <label htmlFor="exemption">Grund für 0 % Umsatzsteuer</label>
                <select id="exemption" value={exemption?.code ?? ""} onChange={(e) => set("taxExemption")(e.target.value)}>
                  {settings.invoice.taxExemptions.map((x) => (
                    <option key={x.code} value={x.code}>
                      {x.label}
                    </option>
                  ))}
                </select>
                <div className="field-hint">Es steht: „{exemption?.text}“</div>
              </div>
            ) : null}
          </div>
          <dl className="totals">
            {totals.discountTotal ? (
              <>
                <div><dt>Zwischensumme</dt><dd>{money(totals.subtotalNet)}</dd></div>
                <div><dt>Rabatt</dt><dd>- {money(totals.discountTotal)}</dd></div>
              </>
            ) : null}
            {!small ? (
              <>
                <div><dt>Netto</dt><dd>{money(totals.totalNet)}</dd></div>
                {totals.taxBreakdown.map((t) => (
                  <div key={t.rate}><dt>USt. {num(t.rate)} %</dt><dd>{money(t.tax)}</dd></div>
                ))}
              </>
            ) : null}
            <div className="grand"><dt>{mode === "recurring" ? "Gesamt je Rechnung" : "Gesamt"}</dt><dd>{money(totals.totalGross)}</dd></div>
          </dl>
        </div>
      </Section>

      <Section title="Texte">
        <div className="grid-2">
          <TextArea label="Einleitung" value={d.introText} onChange={(v) => set("introText")(v || null)} span={2} rows={2} />
          {mode === "invoice" ? (
            <TextArea
              label="Zahlungshinweis"
              value={d.footerText}
              onChange={(v) => set("footerText")(v || null)}
              rows={2}
              hint={<>Leer = Standardtext aus den Einstellungen. Platzhalter: {"{total}"}, {"{dueDate}"}, {"{invoiceNumber}"}</>}
            />
          ) : mode === "quote" ? (
            <TextArea
              label="Gültigkeit und Bedingungen"
              value={d.footerText}
              onChange={(v) => set("footerText")(v || null)}
              rows={2}
              hint={<>Leer = „{settings.quotes.footerText}“. Platzhalter: {"{validUntil}"}</>}
            />
          ) : null}
          <TextArea label="Weitere Hinweise" value={d.notes} onChange={(v) => set("notes")(v || null)} rows={2} hint={mode === "quote" ? "Erscheint auf dem Angebot" : "Erscheint auf der Rechnung"} />
        </div>
        {mode === "recurring" ? (
          <p className="muted small">
            Platzhalter in Betreff, Positionen und Texten: <code>{"{monthName}"}</code> Oktober, <code>{"{month}"}</code> 10, <code>{"{year}"}</code> 2026,{" "}
            <code>{"{quarter}"}</code> Q4, <code>{"{period}"}</code> 01.10.2026 – 31.10.2026.
          </p>
        ) : null}
      </Section>

      {confirmIssue && mode === "invoice" ? (
        <Confirm
          title="Rechnung ausstellen?"
          text={
            <>
              <p>
                Die Rechnung über <strong>{money(totals.totalGross)}</strong> an {customerName(customer)} bekommt eine fortlaufende Nummer und kann danach nicht mehr geändert, nur noch
                storniert werden.
              </p>
              {willMail ? (
                <p>Sie wird automatisch als PDF{settings.invoice.attachXRechnung ? " mit E-Rechnung (XRechnung)" : ""} an <strong>{customer?.email}</strong> gesendet.</p>
              ) : (
                <p className="muted">Es wird keine E-Mail verschickt{!customer?.email ? " (keine E-Mail-Adresse beim Kunden)" : ""}.</p>
              )}
            </>
          }
          confirmLabel={willMail ? "Ausstellen und senden" : "Ausstellen"}
          busy={busy === "issue"}
          onCancel={() => setConfirmIssue(false)}
          onConfirm={() => void issue(true)}
        />
      ) : null}
      {confirmIssue && mode === "quote" ? (
        <Confirm
          title="Angebot senden?"
          text={
            <>
              <p>Das Angebot über <strong>{money(totals.totalGross)}</strong> bekommt eine Nummer und ist danach nicht mehr änderbar (nur als Kopie).</p>
              {willMail ? (
                <p>Es geht als PDF mit Link zur Online-Annahme an <strong>{customer?.email}</strong>.</p>
              ) : (
                <p className="muted">Es wird keine E-Mail verschickt{!customer?.email ? " (keine E-Mail-Adresse beim Kunden)" : ""}. Den Link zur Annahme findest du danach im Angebot.</p>
              )}
            </>
          }
          confirmLabel={willMail ? "Senden" : "Festschreiben"}
          busy={busy === "issue"}
          onCancel={() => setConfirmIssue(false)}
          onConfirm={() => void issue(willMail)}
        />
      ) : null}
    </>
  );
}
