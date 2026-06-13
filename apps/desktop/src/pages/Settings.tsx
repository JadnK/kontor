import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAction, useLoad, useSession } from "../lib/store";
import { dateTime, num } from "../lib/format";
import { notify, saveFile } from "../lib/native";
import { loadNotifyPrefs, NOTIFY_LABELS, saveNotifyPrefs, type NotifyKind } from "../components/Notifier";
import type { CompanyProfile, Exemption, Settings, User } from "../lib/types";
import { Button, Confirm, Field, Modal, MoneyInput, NumberField, NumberInput, PageHeader, Section, SelectField, TextArea, TextField, Toggle } from "../components/ui";
import { Icon } from "../components/Icon";
import { useTheme, type ThemeMode } from "../lib/theme";

type Tab =
  | "company"
  | "profiles"
  | "invoice"
  | "mail"
  | "automation"
  | "templates"
  | "tickets"
  | "quotes"
  | "time"
  | "contracts"
  | "expenses"
  | "datev"
  | "portal"
  | "payments"
  | "bank"
  | "users"
  | "backup"
  | "appearance"
  | "account"
  | "connection";

const TABS: { value: Tab; label: string; admin?: boolean; group?: string }[] = [
  { value: "company", label: "Firma", admin: true, group: "Betrieb" },
  { value: "profiles", label: "Weitere Firmen", admin: true },
  { value: "invoice", label: "Rechnungen & Steuer", admin: true },
  { value: "quotes", label: "Angebote", admin: true },
  { value: "contracts", label: "Verträge", admin: true },
  { value: "time", label: "Zeiterfassung", admin: true },
  { value: "bank", label: "Zahlungsabgleich", admin: true },
  { value: "expenses", label: "Ausgaben", admin: true },
  { value: "datev", label: "Auswertung & DATEV", admin: true },
  { value: "mail", label: "E-Mail-Versand", admin: true, group: "Kommunikation" },
  { value: "automation", label: "Automatik", admin: true },
  { value: "templates", label: "E-Mail-Vorlagen", admin: true },
  { value: "tickets", label: "Ticket-Postfach", admin: true },
  { value: "portal", label: "Kundenportal & Formular", admin: true },
  { value: "payments", label: "Online-Zahlung", admin: true },
  { value: "users", label: "Benutzer", admin: true, group: "Verwaltung" },
  { value: "backup", label: "Datensicherung", admin: true },
  { value: "appearance", label: "Darstellung & Hinweise", group: "Persönlich" },
  { value: "account", label: "Mein Konto" },
  { value: "connection", label: "Verbindung" },
];

export function SettingsPage({ initialTab }: { initialTab?: string }) {
  const { user } = useSession();
  const admin = user.role === "ADMIN";
  const visible = TABS.filter((t) => admin || !t.admin);
  const [tab, setTab] = useState<Tab>((visible.find((t) => t.value === initialTab)?.value ?? visible[0].value) as Tab);

  return (
    <>
      <PageHeader title="Einstellungen" sub={admin ? undefined : "Firmen- und Rechnungseinstellungen kann nur ein Administrator ändern."} />
      <div className="settings">
        <nav className="settings-nav" aria-label="Einstellungsbereiche">
          {visible.map((t) => (
            <div key={t.value} style={{ display: "contents" }}>
              {t.group && admin ? <div className="nav-group">{t.group}</div> : null}
              <button className={tab === t.value ? "active" : ""} onClick={() => setTab(t.value)} aria-current={tab === t.value ? "page" : undefined}>
                {t.label}
              </button>
            </div>
          ))}
        </nav>
        <div className="settings-body">
          {tab === "company" && <CompanyTab />}
          {tab === "profiles" && <ProfilesTab />}
          {tab === "invoice" && <InvoiceTab />}
          {tab === "quotes" && <QuotesTab />}
          {tab === "bank" && <BankTab />}
          {tab === "time" && <TimeTab />}
          {tab === "contracts" && <ContractsTab />}
          {tab === "expenses" && <ExpensesTab />}
          {tab === "datev" && <DatevTab />}
          {tab === "portal" && <PortalTab />}
          {tab === "payments" && <PaymentsTab />}
          {tab === "mail" && <MailTab />}
          {tab === "automation" && <AutomationTab />}
          {tab === "templates" && <TemplatesTab />}
          {tab === "tickets" && <TicketsTab />}
          {tab === "users" && <UsersTab />}
          {tab === "backup" && <BackupTab />}
          {tab === "appearance" && (
            <>
              <AppearanceTab />
              <NotifySection />
            </>
          )}
          {tab === "account" && <AccountTab />}
          {tab === "connection" && <ConnectionTab />}
        </div>
      </div>
    </>
  );
}

/** Gemeinsame Logik: Abschnitt lokal bearbeiten, beim Speichern an den Server senden */
function useSection<K extends keyof Settings>(key: K) {
  const { settings, reloadSettings, api } = useSession();
  const { busy, run } = useAction();
  const [value, setValue] = useState<Settings[K]>(settings[key]);
  useEffect(() => setValue(settings[key]), [settings, key]);
  const dirty = JSON.stringify(value) !== JSON.stringify(settings[key]);
  const set = <F extends keyof Settings[K]>(f: F) => (v: Settings[K][F]) => setValue((x) => ({ ...x, [f]: v }));
  const save = () =>
    run("save", async () => {
      await api.put(`/api/settings/${key}`, value);
      await reloadSettings();
    }, "Einstellungen gespeichert");
  return { value, setValue, set, save, dirty, busy: busy === "save" };
}

function SaveBar({ dirty, busy, onSave, extra }: { dirty: boolean; busy: boolean; onSave: () => void; extra?: ReactNode }) {
  return (
    <div className="save-bar">
      {extra}
      <Button variant="primary" disabled={!dirty} busy={busy} onClick={onSave}>
        Änderungen speichern
      </Button>
    </div>
  );
}

function CompanyTab() {
  const s = useSection("company");
  const c = s.value;
  const [logoErr, setLogoErr] = useState<string | null>(null);
  const onLogo = (file: File | undefined) => {
    setLogoErr(null);
    if (!file) return;
    if (file.size > 300_000) return setLogoErr("Logo ist zu groß (max. 300 KB). Bitte als PNG oder JPG verkleinern.");
    const r = new FileReader();
    r.onload = () => s.set("logo")(String(r.result));
    r.readAsDataURL(file);
  };
  return (
    <>
      <Section title="Firmendaten">
        <p className="muted">Diese Angaben stehen im Kopf und in der Fußzeile jeder Rechnung und werden beim Ausstellen fest in die Rechnung übernommen.</p>
        <div className="grid-4">
          <TextField label="Firmenname" value={c.name} onChange={s.set("name")} span={2} />
          <TextField label="Inhaber / Geschäftsführung" value={c.owner} onChange={s.set("owner")} span={2} />
          <TextField
            label="Adresszusatz"
            value={c.addressAddition}
            onChange={s.set("addressAddition")}
            span={2}
            placeholder="z. B. c/o MDC#1156"
            hint="Für gemietete Geschäftsadressen: steht als eigene Zeile unter deinem Namen, der Name bleibt dein echter."
          />
          <TextField label="Straße und Hausnummer" value={c.street} onChange={s.set("street")} span={2} />
          <TextField label="PLZ" value={c.zip} onChange={s.set("zip")} />
          <TextField label="Ort" value={c.city} onChange={s.set("city")} />
          <TextField label="E-Mail" type="email" value={c.email} onChange={s.set("email")} span={2} />
          <TextField label="Telefon" value={c.phone} onChange={s.set("phone")} />
          <TextField label="Website" value={c.website} onChange={s.set("website")} />
        </div>
      </Section>
      <Section title="Steuer und Register">
        <div className="grid-4">
          <TextField label="Steuernummer" value={c.taxNumber} onChange={s.set("taxNumber")} span={2} />
          <TextField label="USt-IdNr." value={c.vatId} onChange={s.set("vatId")} span={2} hint="Wird bevorzugt angezeigt, wenn vorhanden" />
          <TextField label="Registergericht" value={c.registerCourt} onChange={s.set("registerCourt")} span={2} />
          <TextField label="Registernummer" value={c.registerNumber} onChange={s.set("registerNumber")} span={2} />
        </div>
      </Section>
      <Section title="Bankverbindung">
        <div className="grid-4">
          <TextField label="Bank" value={c.bankName} onChange={s.set("bankName")} span={2} />
          <TextField label="IBAN" value={c.iban} onChange={(v) => s.set("iban")(v.toUpperCase())} span={2} />
          <TextField label="BIC" value={c.bic} onChange={(v) => s.set("bic")(v.toUpperCase())} />
        </div>
      </Section>
      <Section title="Logo">
        <div className="logo-row">
          {c.logo ? <img src={c.logo} alt="Firmenlogo" className="logo-preview" /> : <div className="logo-empty">Kein Logo – der Firmenname wird als Schriftzug gedruckt.</div>}
          <div className="stack">
            <input type="file" accept="image/png,image/jpeg" onChange={(e) => onLogo(e.target.files?.[0])} aria-label="Logo hochladen" />
            {c.logo ? <Button variant="ghost" onClick={() => s.set("logo")("")}>Logo entfernen</Button> : null}
            {logoErr ? <div className="field-error">{logoErr}</div> : <div className="field-hint">PNG oder JPG, max. 300 KB. Wird oben rechts gedruckt.</div>}
          </div>
        </div>
      </Section>
      <SaveBar dirty={s.dirty} busy={s.busy} onSave={s.save} />
    </>
  );
}

function newProfileId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function ProfilesTab() {
  const s = useSection("profiles");
  const { settings } = useSession();
  const list = s.value.list;
  const [edit, setEdit] = useState<CompanyProfile | null>(null);
  const save = (p: CompanyProfile) => {
    const exists = list.some((x) => x.id === p.id);
    s.set("list")(exists ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]);
    setEdit(null);
  };
  return (
    <>
      <Section title="Weitere Firmen">
        <p className="muted">
          Für ein zweites Gewerbe oder eine weitere Marke: eigene Absenderdaten, Bankverbindung, Logo und auf Wunsch eigener Rechnungsnummernkreis. Kunden, Angebote und Rechnungen bekommen dann eine
          Auswahl „Absender“. Leere Felder übernehmen die Daten der Hauptfirma ({settings.company.name || "Firma"}).
        </p>
        {list.length ? (
          <table className="table compact">
            <thead>
              <tr><th>Profil</th><th>Firmenname</th><th>Rechnungsnummer</th><th /></tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <td className="strong">{p.label}</td>
                  <td>{p.company.name || <span className="muted">{settings.company.name}</span>}</td>
                  <td className="mono">{p.numberFormat || <span className="muted">gemeinsam ({settings.invoice.numberFormat})</span>}</td>
                  <td className="row-actions">
                    <Button variant="ghost" className="btn-sm" onClick={() => setEdit(p)}>Bearbeiten</Button>
                    <Button variant="ghost" className="btn-sm danger-text" onClick={() => s.set("list")(list.filter((x) => x.id !== p.id))}>Entfernen</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">Noch keine weitere Firma angelegt.</p>
        )}
        <Button onClick={() => setEdit({ id: newProfileId(), label: "", company: {}, accentColor: "", numberFormat: "", smallBusiness: "inherit" })}>
          <Icon name="plus" /> Firma hinzufügen
        </Button>
      </Section>
      <SaveBar dirty={s.dirty} busy={s.busy} onSave={s.save} />
      {edit ? <ProfileDialog initial={edit} onClose={() => setEdit(null)} onSave={save} /> : null}
    </>
  );
}

function ProfileDialog({ initial, onClose, onSave }: { initial: CompanyProfile; onClose: () => void; onSave: (p: CompanyProfile) => void }) {
  const { settings } = useSession();
  const main = settings.company;
  const [p, setP] = useState<CompanyProfile>(initial);
  const [err, setErr] = useState<string | null>(null);
  const c = p.company;
  const setC = (k: keyof typeof main) => (v: string) => setP((x) => ({ ...x, company: { ...x.company, [k]: v } }));
  const field = (k: keyof typeof main, label: string, span: 1 | 2 = 2, upper = false) => (
    <TextField label={label} value={(c[k] as string | undefined) ?? ""} onChange={(v) => setC(k)(upper ? v.toUpperCase() : v)} span={span} placeholder={(main[k] as string) || ""} />
  );
  const onLogo = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 300_000) return setErr("Logo ist zu groß (max. 300 KB)");
    const r = new FileReader();
    r.onload = () => setC("logo")(String(r.result));
    r.readAsDataURL(file);
  };
  return (
    <Modal
      title={initial.label ? `Firma „${initial.label}“` : "Weitere Firma"}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            onClick={() => {
              if (!p.label.trim()) return setErr("Bitte einen Namen für das Profil angeben");
              if (p.numberFormat.trim() && p.numberFormat.trim() === settings.invoice.numberFormat) return setErr("Die Rechnungsnummer muss sich von der Hauptfirma unterscheiden – oder leer bleiben");
              if (p.numberFormat.trim() && !/\{N+\}/.test(p.numberFormat)) return setErr("Die Rechnungsnummer braucht eine laufende Nummer, z. B. {NNNN}");
              onSave({ ...p, label: p.label.trim() });
            }}
          >
            Übernehmen
          </Button>
        </>
      }
    >
      <p className="muted small">Graue Werte kommen von der Hauptfirma. Nur ausfüllen, was abweicht. Gespeichert wird mit „Änderungen speichern“.</p>
      <div className="grid-4">
        <TextField label="Name des Profils" value={p.label} onChange={(v) => setP((x) => ({ ...x, label: v }))} span={2} placeholder="z. B. Fotografie" autoFocus />
        <TextField
          label="Eigene Rechnungsnummer"
          value={p.numberFormat}
          onChange={(v) => setP((x) => ({ ...x, numberFormat: v }))}
          span={2}
          placeholder={`leer = gemeinsam (${settings.invoice.numberFormat})`}
          hint="z. B. F-{YYYY}-{NNNN} für eigenen Nummernkreis"
        />
        {field("name", "Firmenname")}
        {field("owner", "Inhaber")}
        {field("addressAddition", "Adresszusatz")}
        {field("street", "Straße und Hausnummer")}
        {field("zip", "PLZ", 1)}
        {field("city", "Ort", 1)}
        {field("email", "E-Mail")}
        {field("phone", "Telefon", 1)}
        {field("website", "Website", 1)}
        {field("taxNumber", "Steuernummer")}
        {field("vatId", "USt-IdNr.")}
        {field("bankName", "Bank")}
        {field("iban", "IBAN", 2, true)}
        {field("bic", "BIC", 1, true)}
        <TextField label="Akzentfarbe PDF" type="color" value={p.accentColor || settings.invoice.accentColor} onChange={(v) => setP((x) => ({ ...x, accentColor: v }))} />
        <SelectField
          label="Umsatzsteuer"
          value={p.smallBusiness}
          onChange={(v) => setP((x) => ({ ...x, smallBusiness: v }))}
          options={[
            { value: "inherit", label: "wie Hauptfirma" },
            { value: "yes", label: "Kleinunternehmer (§ 19)" },
            { value: "no", label: "mit Umsatzsteuer" },
          ]}
          span={2}
        />
      </div>
      <div className="logo-row" style={{ marginTop: 12 }}>
        {c.logo ? <img src={c.logo} alt="Logo" className="logo-preview" /> : <div className="logo-empty">{main.logo ? "Logo der Hauptfirma" : "Kein Logo"}</div>}
        <div className="stack">
          <input type="file" accept="image/png,image/jpeg" onChange={(e) => onLogo(e.target.files?.[0])} aria-label="Logo hochladen" />
          {c.logo ? <Button variant="ghost" onClick={() => setC("logo")("")}>Eigenes Logo entfernen</Button> : null}
        </div>
      </div>
      {err ? <div className="field-error">{err}</div> : null}
    </Modal>
  );
}

function InvoiceTab() {
  const s = useSection("invoice");
  const v = s.value;
  const [ratesText, setRatesText] = useState(v.taxRates.map((r) => num(r)).join("; "));
  useEffect(() => setRatesText(v.taxRates.map((r) => num(r)).join("; ")), [v.taxRates]);
  return (
    <>
      <Section title="Umsatzsteuer">
        <Toggle
          label="Kleinunternehmerregelung (§ 19 UStG)"
          checked={v.smallBusiness}
          onChange={s.set("smallBusiness")}
          hint="Rechnungen weisen keine Umsatzsteuer aus. Gilt für alle neuen und noch nicht ausgestellten Rechnungen."
        />
        {v.smallBusiness ? (
          <TextArea label="Hinweistext auf der Rechnung" value={v.smallBusinessText} onChange={s.set("smallBusinessText")} rows={2} />
        ) : (
          <div className="grid-4">
            <SelectField
              label="Standard-Steuersatz"
              value={String(v.defaultTaxRate)}
              onChange={(x) => s.set("defaultTaxRate")(Number(x))}
              options={v.taxRates.map((r) => ({ value: String(r), label: `${num(r)} %` }))}
            />
            <TextField
              label="Verfügbare Steuersätze"
              value={ratesText}
              span={2}
              onChange={(t) => {
                setRatesText(t);
                const list = t.split(/[;\s]+/).map((x) => Number(x.replace(",", "."))).filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
                if (list.length) s.set("taxRates")([...new Set(list)]);
              }}
              hint="Mit Semikolon getrennt, z. B. 19; 7; 0"
            />
          </div>
        )}
      </Section>

      {!v.smallBusiness ? <ExemptionsEditor value={v.taxExemptions} defaultCode={v.defaultExemption} onChange={s.set("taxExemptions")} onDefault={s.set("defaultExemption")} /> : null}

      <Section title="Pflichthinweise und Texte">
        <TextArea
          label="Zusätzliche Hinweise (je Zeile ein Hinweis)"
          value={v.legalNotes.join("\n")}
          onChange={(t) => s.set("legalNotes")(t.split("\n"))}
          rows={3}
          hint="Erscheinen auf jeder Rechnung, z. B. „Steuerschuldnerschaft des Leistungsempfängers“ oder Hinweise zur Aufbewahrungspflicht bei Leistungen an Privatpersonen."
        />
        <TextArea label="Standard-Einleitung" value={v.introText} onChange={s.set("introText")} rows={2} />
        <TextArea
          label="Zahlungshinweis"
          value={v.paymentText}
          onChange={s.set("paymentText")}
          rows={2}
          hint={<>Platzhalter: {"{total}"}, {"{dueDate}"}, {"{invoiceNumber}"}, {"{customerName}"}</>}
        />
        <TextField label="Grußformel" value={v.closingText} onChange={s.set("closingText")} />
      </Section>

      <Section title="Bezahlen per QR-Code">
        <Toggle
          label="GiroCode auf Rechnungen und Mahnungen drucken"
          checked={v.showGiroCode}
          onChange={s.set("showGiroCode")}
          hint="Der Kunde scannt den Code mit seiner Banking-App: Empfänger, IBAN, Betrag und Rechnungsnummer sind ausgefüllt. Dadurch stimmt der Verwendungszweck fast immer und der Zahlungsabgleich trifft. Braucht IBAN und Firmennamen unter „Firma“."
        />
      </Section>

      <Section title="Gestaltung">
        <div className="design-picker" role="radiogroup" aria-label="Gestaltung des PDFs">
          {(
            [
              ["classic", "Klassisch", "Graue Tabellenkopfzeile, Akzentfarbe bei den Summen"],
              ["modern", "Modern", "Farbband oben, Tabellenkopf in der Akzentfarbe"],
              ["minimal", "Schlicht", "Ohne Flächen, nur feine Linien"],
            ] as const
          ).map(([k, l, d]) => (
            <button key={k} type="button" role="radio" aria-checked={v.design === k} className={`design-card ${v.design === k ? "on" : ""}`} onClick={() => s.set("design")(k)}>
              <span className={`design-preview dp-${k}`} style={{ ["--acc" as string]: v.accentColor }} aria-hidden>
                <i className="dp-band" />
                <i className="dp-line w60" />
                <i className="dp-line w40" />
                <i className="dp-head" />
                <i className="dp-row" />
                <i className="dp-row" />
                <i className="dp-sum" />
              </span>
              <strong>{l}</strong>
              <span className="muted small">{d}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="E-Rechnung">
        <Toggle
          label="Rechnungs-PDF als ZUGFeRD erzeugen"
          checked={v.zugferd}
          onChange={s.set("zugferd")}
          hint="Das PDF enthält zusätzlich die Rechnungsdaten als XML (ZUGFeRD 2 / Factur-X, Profil EN 16931) und ist PDF/A-3. Für Menschen sieht es aus wie immer, Buchhaltungsprogramme lesen die Daten automatisch aus. Erfüllt die E-Rechnungspflicht im B2B."
        />
        <Toggle
          label="XRechnung an Rechnungsmails anhängen"
          checked={v.attachXRechnung}
          onChange={s.set("attachXRechnung")}
          hint="Hängt zusätzlich zur PDF eine maschinenlesbare E-Rechnung (XRechnung 3.0, CII) an. Seit 2025 müssen Unternehmen E-Rechnungen empfangen können; die Pflicht zum Versenden gilt gestaffelt ab 2027/2028."
        />
      </Section>

      <Section title="Nummern und Zahlungsziel">
        <div className="grid-4">
          <TextField label="Rechnungsnummer" value={v.numberFormat} onChange={s.set("numberFormat")} hint="{YYYY} Jahr, {YY}, {MM}, {NNNN} laufende Nr." span={2} />
          <TextField label="Stornonummer" value={v.cancellationNumberFormat} onChange={s.set("cancellationNumberFormat")} span={2} />
          <TextField label="Kundennummer" value={v.customerNumberFormat} onChange={s.set("customerNumberFormat")} span={2} />
          <NumberField label="Zahlungsziel" value={v.paymentDays} onChange={(n) => s.set("paymentDays")(Math.max(0, Math.round(n ?? 0)))} suffix="Tage" />
          <TextField label="Akzentfarbe PDF" type="color" value={v.accentColor} onChange={s.set("accentColor")} />
        </div>
        <Toggle label="Leistungsdatum auf der Rechnung zeigen" checked={v.showServiceDate} onChange={s.set("showServiceDate")} hint="Pflichtangabe nach § 14 UStG – nur abschalten, wenn das Rechnungsdatum dem Leistungsdatum entspricht und das auf der Rechnung vermerkt ist." />
      </Section>
      <SaveBar dirty={s.dirty} busy={s.busy} onSave={s.save} />
    </>
  );
}

function QuotesTab() {
  const s = useSection("quotes");
  const v = s.value;
  return (
    <>
      <Section title="Angebote">
        <div className="grid-4">
          <TextField label="Angebotsnummer" value={v.numberFormat} onChange={s.set("numberFormat")} hint="{YYYY} Jahr, {NNNN} laufende Nr." span={2} />
          <NumberField label="Gültig für" value={v.validDays} onChange={(n) => s.set("validDays")(Math.min(365, Math.max(1, Math.round(n ?? 30))))} suffix="Tage" plain />
        </div>
        <TextArea label="Standard-Einleitung" value={v.introText} onChange={s.set("introText")} rows={2} />
        <TextArea label="Hinweis zu Gültigkeit und Bedingungen" value={v.footerText} onChange={s.set("footerText")} rows={2} hint={<>Platzhalter: {"{validUntil}"}, {"{quoteNumber}"}</>} />
      </Section>
      <Section title="Online-Annahme">
        <p className="muted">
          Jedes versendete Angebot bekommt einen geheimen Link. Darüber sieht der Kunde das Angebot im Browser und nimmt es mit seinem Namen an oder lehnt ab. Der Link nutzt die öffentliche
          Server-Adresse (PUBLIC_URL).
        </p>
        <div className="stack">
          <Toggle label="Mich per Mail benachrichtigen, wenn ein Kunde antwortet" checked={v.notifyOnAnswer} onChange={s.set("notifyOnAnswer")} hint="An die Firmen-E-Mail-Adresse" />
          <Toggle label="Bei Annahme automatisch einen Rechnungsentwurf anlegen" checked={v.draftOnAccept} onChange={s.set("draftOnAccept")} hint="Der Entwurf wird nicht ausgestellt – du prüfst ihn vorher." />
        </div>
      </Section>
      <SaveBar dirty={s.dirty} busy={s.busy} onSave={s.save} />
    </>
  );
}

function ContractsTab() {
  const s = useSection("contracts");
  const v = s.value;
  return (
    <>
      <Section title="Verträge">
        <div className="grid-4">
          <TextField label="Vertragsnummer" value={v.numberFormat} onChange={s.set("numberFormat")} hint="{YYYY} Jahr, {NNNN} laufende Nr." span={2} />
          <NumberField label="Erinnern vor Fristablauf" value={v.remindDays} onChange={(n) => s.set("remindDays")(Math.min(180, Math.max(0, Math.round(n ?? 30))))} suffix="Tage" span={2} hint="Verträge erscheinen dann unter „Demnächst“" />
        </div>
        <Toggle
          label="Per Mail an die Firmenadresse erinnern"
          checked={v.remindByMail}
          onChange={s.set("remindByMail")}
          hint="Einmal je Vertrag und Frist – damit sich kein Vertrag ungewollt verlängert (z. B. wenn du selbst kündigen oder Preise anpassen willst)."
        />
      </Section>
      <SaveBar dirty={s.dirty} busy={s.busy} onSave={s.save} />
    </>
  );
}

function TimeTab() {
  const s = useSection("time");
  const v = s.value;
  return (
    <>
      <Section title="Stundensatz">
        <div className="grid-4">
          <Field label="Standard-Stundensatz (netto)" hint="Gilt, wenn weder Eintrag, Projekt noch Kunde einen eigenen Satz haben.">
            {(id) => <MoneyInput id={id} value={v.defaultHourlyRate} onChange={(c) => s.set("defaultHourlyRate")(c ?? 0)} />}
          </Field>
          <NumberField label="Steuersatz" value={v.taxRate} onChange={(n) => s.set("taxRate")(Math.min(100, Math.max(0, n ?? 19)))} suffix="%" />
          <TextField label="Einheit auf der Rechnung" value={v.unit} onChange={s.set("unit")} placeholder="Std." />
        </div>
      </Section>
      <Section title="Abrechnung">
        <div className="field">
          <label>Runden</label>
          <div className="segmented" role="group" aria-label="Runden">
            {(
              [
                ["up", "Aufrunden"],
                ["nearest", "Kaufmännisch"],
                ["none", "Minutengenau"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} aria-pressed={v.rounding === k} onClick={() => s.set("rounding")(k)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        {v.rounding !== "none" ? (
          <div className="grid-4">
            <NumberField label="Takt" value={v.roundingMinutes} onChange={(n) => s.set("roundingMinutes")(Math.min(60, Math.max(1, Math.round(n ?? 15))))} suffix="Minuten" hint="z. B. 15 = Viertelstunden" />
          </div>
        ) : null}
        <div className="field">
          <label>Positionen auf der Rechnung</label>
          <div className="segmented" role="group" aria-label="Positionen">
            {(
              [
                ["entry", "Jeder Eintrag"],
                ["day", "Je Tag"],
                ["group", "Je Projekt/Ticket"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} aria-pressed={v.grouping === k} onClick={() => s.set("grouping")(k)}>
                {l}
              </button>
            ))}
          </div>
          <div className="field-hint">
            {v.grouping === "entry"
              ? "Jeder Zeiteintrag wird eine Position mit Datum und Beschreibung."
              : v.grouping === "day"
                ? "Alle Einträge eines Tages werden zusammengefasst."
                : "Eine Position je Projekt bzw. Ticket, die Einzelleistungen stehen in der Beschreibung."}
            {v.rounding !== "none" ? " Gerundet wird je Position." : ""}
          </div>
        </div>
      </Section>
      <SaveBar dirty={s.dirty} busy={s.busy} onSave={s.save} />
    </>
  );
}

function ExpensesTab() {
  const s = useSection("expenses");
  const v = s.value;
  const cats = v.categories;
  const setCat = (i: number, patch: Partial<(typeof cats)[number]>) => s.set("categories")(cats.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const learned = Object.entries(v.supplierCategories);
  return (
    <>
      <Section title="Kategorien">
        <p className="muted">Konten für den DATEV-Export. Der absetzbare Anteil zählt in der Auswertung (z. B. 70 % bei Bewirtung).</p>
        <table className="table compact steps-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>SKR03</th>
              <th>SKR04</th>
              <th>absetzbar</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cats.map((c, i) => (
              <tr key={i}>
                <td>
                  <input aria-label="Name" value={c.name} onChange={(e) => setCat(i, { name: e.target.value })} />
                </td>
                <td>
                  <input aria-label="SKR03-Konto" className="mono" style={{ width: 80 }} value={c.skr03} onChange={(e) => setCat(i, { skr03: e.target.value.replace(/\D/g, "").slice(0, 8) })} />
                </td>
                <td>
                  <input aria-label="SKR04-Konto" className="mono" style={{ width: 80 }} value={c.skr04} onChange={(e) => setCat(i, { skr04: e.target.value.replace(/\D/g, "").slice(0, 8) })} />
                </td>
                <td>
                  <div className="suffix-input" style={{ width: 90 }}>
                    <NumberInput value={c.deductible} onChange={(n) => setCat(i, { deductible: Math.min(100, Math.max(0, n ?? 100)) })} plain />
                    <span>%</span>
                  </div>
                </td>
                <td className="num">
                  <Button variant="ghost" className="btn-sm" onClick={() => s.set("categories")(cats.filter((_, j) => j !== i))} disabled={cats.length <= 1} aria-label={`${c.name} entfernen`}>
                    ×
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Button variant="ghost" onClick={() => s.set("categories")([...cats, { name: "Neue Kategorie", skr03: "4900", skr04: "6300", deductible: 100 }])}>
          <Icon name="plus" /> Kategorie hinzufügen
        </Button>
        {new Set(cats.map((c) => c.name.trim())).size !== cats.length || cats.some((c) => !c.name.trim()) ? <p className="text-danger small">Jede Kategorie braucht einen eindeutigen Namen.</p> : null}
      </Section>
      <Section title="Abbuchungen">
        <Toggle
          label="Bekannte Empfänger automatisch buchen"
          checked={v.autoBookKnown}
          onChange={s.set("autoBookKnown")}
          hint="Abbuchungen an Empfänger, die du schon einmal einer Kategorie zugeordnet hast, werden beim Kontoabruf direkt als Ausgabe gebucht."
        />
        {learned.length ? (
          <div className="field">
            <label>Gemerkte Empfänger ({learned.length})</label>
            <div className="chip-list">
              {learned.map(([k, c]) => (
                <span className="chip" key={k}>
                  {k} → {c}
                  <button
                    aria-label={`${k} vergessen`}
                    onClick={() => {
                      const next = { ...v.supplierCategories };
                      delete next[k];
                      s.set("supplierCategories")(next);
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </Section>
      <SaveBar dirty={s.dirty} busy={s.busy} onSave={s.save} />
    </>
  );
}

function DatevTab() {
  const s = useSection("datev");
  const v = s.value;
  const skr04 = v.chart === "SKR04";
  return (
    <>
      <Section title="DATEV-Export">
        <p className="muted">
          Der Export unter Auswertung erzeugt einen DATEV-Buchungsstapel (EXTF), den deine Steuerberatung direkt einlesen kann. Berater- und Mandantennummer bekommst du von ihr.
        </p>
        <div className="grid-4">
          <TextField label="Beraternummer" value={v.consultantNumber} onChange={(x) => s.set("consultantNumber")(x.replace(/\D/g, "").slice(0, 7))} />
          <TextField label="Mandantennummer" value={v.clientNumber} onChange={(x) => s.set("clientNumber")(x.replace(/\D/g, "").slice(0, 5))} />
          <SelectField
            label="Kontenrahmen"
            value={v.chart}
            onChange={s.set("chart")}
            options={[
              { value: "SKR03", label: "SKR03" },
              { value: "SKR04", label: "SKR04" },
            ]}
          />
          <NumberField label="Sachkontenlänge" plain value={v.accountLength} onChange={(n) => s.set("accountLength")(Math.min(8, Math.max(4, Math.round(n ?? 4))))} />
        </div>
      </Section>
      <Section title="Konten">
        <p className="muted small">Leer lassen für die Standardkonten. Die Konten der Ausgaben stellst du unter Ausgaben je Kategorie ein.</p>
        <div className="grid-4">
          <TextField label="Bank" value={v.bankAccount} onChange={s.set("bankAccount")} placeholder={skr04 ? "1800" : "1200"} />
          <TextField label="Erlöse 19 %" value={v.revenue19} onChange={s.set("revenue19")} placeholder={skr04 ? "4400" : "8400"} />
          <TextField label="Erlöse 7 %" value={v.revenue7} onChange={s.set("revenue7")} placeholder={skr04 ? "4300" : "8300"} />
          <TextField label="Erlöse steuerfrei" value={v.revenue0} onChange={s.set("revenue0")} placeholder={skr04 ? "4100" : "8100"} />
          <TextField label="Erlöse Kleinunternehmer" value={v.revenueSmall} onChange={s.set("revenueSmall")} placeholder={skr04 ? "4185" : "8195"} />
        </div>
      </Section>
      <SaveBar dirty={s.dirty} busy={s.busy} onSave={s.save} />
    </>
  );
}

interface PublicLinks {
  configured: boolean;
  base: string;
  formUrl: string;
  webhookUrl: string;
}

function CopyField({ label, value, hint, multiline }: { label: string; value: string; hint?: ReactNode; multiline?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="field">
      <label>{label}</label>
      <div className="inline-form copy-field">
        {multiline ? (
          <textarea readOnly value={value} className="mono" rows={4} onFocus={(e) => e.currentTarget.select()} aria-label={label} />
        ) : (
          <input readOnly value={value} className="mono" onFocus={(e) => e.currentTarget.select()} aria-label={label} />
        )}
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          }}
          disabled={!value}
        >
          {done ? "Kopiert" : "Kopieren"}
        </Button>
      </div>
      {hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

function PublicUrlHint({ links }: { links: PublicLinks | null }) {
  if (!links || links.configured) return null;
  return (
    <div className="hint hint-danger">
      <span>
        Auf dem Server ist keine öffentliche Adresse gesetzt (<span className="mono">PUBLIC_URL</span> in der .env). Ohne sie funktionieren Portal-Links, Formular und Zahlungslinks nicht für
        deine Kunden.
      </span>
    </div>
  );
}

function PortalTab() {
  const { api, settings } = useSession();
  const links = useLoad(() => api.get<PublicLinks>("/api/settings/public-links"), []);
  const p = useSection("portal");
  const w = useSection("webform");
  const pv = p.value;
  const wv = w.value;
  const ticketsOn = settings.tickets.portalTickets;
  const formUrl = links.data?.formUrl ?? "";
  const origin = links.data ? new URL(links.data.base).origin : "";
  const embed = formUrl
    ? `<iframe id="kontor-form" src="${formUrl}?embed=1" title="${wv.title.replace(/"/g, "")}" style="width:100%;border:0;min-height:640px"></iframe>
<script>addEventListener("message",function(e){if(e.origin==="${origin}"&&e.data&&e.data.kontor==="height")document.getElementById("kontor-form").style.height=e.data.height+"px"})</script>`
    : "";
  const [origins, setOrigins] = useState("");
  useEffect(() => setOrigins(wv.allowedOrigins.join("\n")), [wv.allowedOrigins]);
  return (
    <>
      <PublicUrlHint links={links.data} />
      <Section title="Kundenportal">
        <p className="muted">
          Jeder Kunde bekommt einen persönlichen Link. Darüber sieht er seine Rechnungen (mit PDF und Bezahlen-Knopf), Angebote und Anfragen und kann neue Anfragen stellen – ohne Passwort. Den
          Link verschickst du beim Kunden unter „Kundenportal“ oder per Platzhalter <span className="mono">{"{portalLink}"}</span> in den Mail-Vorlagen.
        </p>
        <Toggle label="Kundenportal einschalten" checked={pv.enabled} onChange={p.set("enabled")} />
        {pv.enabled ? (
          <>
            <div className="toggle-grid">
              <Toggle label="Rechnungen zeigen" checked={pv.showInvoices} onChange={p.set("showInvoices")} />
              <Toggle label="Angebote zeigen" checked={pv.showQuotes} onChange={p.set("showQuotes")} />
              <Toggle
                label="Anfragen zeigen"
                checked={pv.showTickets}
                onChange={p.set("showTickets")}
                hint={ticketsOn ? undefined : "Neue Anfragen sind unter Ticket-Postfach → „Tickets über Kundenportal und Webformular“ ausgeschaltet."}
              />
            </div>
            <TextArea label="Begrüßung oben im Portal" value={pv.introText} onChange={p.set("introText")} rows={2} />
          </>
        ) : null}
        <SaveBar dirty={p.dirty} busy={p.busy} onSave={p.save} />
      </Section>
      <Section title="Anfrage-Formular für deine Website">
        <p className="muted">Ein fertiges Formular, das Anfragen direkt als Ticket anlegt – mit Eingangsbestätigung, Kategorien und Dateien. Zum Einbetten den Code unten in deine Website kopieren.</p>
        <Toggle
          label="Formular einschalten"
          checked={wv.enabled}
          onChange={w.set("enabled")}
          hint={!ticketsOn ? "Achtung: Unter Ticket-Postfach ist „Tickets über Kundenportal und Webformular“ aus – das Formular bleibt dann gesperrt." : undefined}
        />
        {wv.enabled ? (
          <>
            <div className="grid-4">
              <TextField label="Überschrift" value={wv.title} onChange={w.set("title")} span={2} />
            </div>
            <TextArea label="Einleitung (optional)" value={wv.introText} onChange={w.set("introText")} rows={2} />
            <TextArea label="Text nach dem Absenden" value={wv.successText} onChange={w.set("successText")} rows={2} />
            <div className="toggle-grid">
              <Toggle label="Telefonnummer abfragen" checked={wv.askPhone} onChange={w.set("askPhone")} />
              <Toggle label="Thema (Kategorie) abfragen" checked={wv.askCategory} onChange={w.set("askCategory")} hint={settings.tickets.categories.length ? undefined : "Keine Kategorien angelegt"} />
              <Toggle label="Dateien erlauben" checked={wv.allowFiles} onChange={w.set("allowFiles")} />
            </div>
            <Toggle
              label="Nur Kunden"
              checked={wv.onlyCustomers}
              onChange={w.set("onlyCustomers")}
              hint="Nur wer mit einer bei dir hinterlegten E-Mail-Adresse schreibt (bzw. derselben Firmen-Domain, falls unter Ticket-Postfach erlaubt), kann das Formular absenden."
            />
            {wv.onlyCustomers ? <TextArea label="Hinweis für Nicht-Kunden" value={wv.nonCustomerText} onChange={w.set("nonCustomerText")} rows={2} /> : null}
            <TextArea
              label="Eigene Formulare erlauben von (optional)"
              value={origins}
              onChange={(x) => {
                setOrigins(x);
                w.set("allowedOrigins")(
                  x
                    .split(/[\s,]+/)
                    .map((o) => o.trim())
                    .filter((o) => /^https?:\/\/[^/\s]+/.test(o)),
                );
              }}
              rows={2}
              hint="Nur nötig, wenn du ein eigenes Formular baust, das per JavaScript an Kontor sendet. Eine Adresse je Zeile, z. B. https://www.deinefirma.de. Das eingebettete Formular braucht das nicht."
            />
            <CopyField label="Link zum Formular" value={formUrl} />
            <CopyField label="Code zum Einbetten" value={embed} multiline hint="Passt die Höhe automatisch an. Spam-Schutz (verstecktes Feld und Begrenzung je Absender) ist eingebaut." />
          </>
        ) : null}
        <SaveBar dirty={w.dirty} busy={w.busy} onSave={w.save} />
      </Section>
    </>
  );
}

function PaymentsTab() {
  const { api } = useSession();
  const { busy, run } = useAction();
  const links = useLoad(() => api.get<PublicLinks>("/api/settings/public-links"), []);
  const s = useSection("payments");
  const v = s.value;
  const [check, setCheck] = useState<{ livemode: boolean; webhook: boolean } | null>(null);
  return (
    <>
      <PublicUrlHint links={links.data} />
      <Section title="Online bezahlen">
        <p className="muted">
          Jede offene Rechnung bekommt einen Zahlungslink. Dort zahlt der Kunde per Karte, Apple Pay, Google Pay, Klarna & Co. (über Stripe), per PayPal oder per Überweisung mit GiroCode.
          Zahlungen über Stripe werden sofort gebucht, die Rechnung gilt als bezahlt und die Bestätigung geht raus.
        </p>
        <div className="toggle-grid">
          <Toggle label="Zahlungslink in Rechnungs- und Erinnerungsmails" checked={v.linkInMails} onChange={s.set("linkInMails")} hint="Wird vor dem Gruß eingefügt, außer die Vorlage nutzt {payLink} selbst." />
          <Toggle label="Zahlungslink auf dem Rechnungs-PDF" checked={v.linkOnPdf} onChange={s.set("linkOnPdf")} />
        </div>
      </Section>
      <Section title="Stripe">
        <ol className="steps">
          <li>
            Konto auf <span className="mono">stripe.com</span> anlegen und verifizieren. Unter <em>Einstellungen → Zahlungsmethoden</em> auswählen, was angeboten werden soll (z. B. Karte,
            PayPal, Klarna, SEPA-Lastschrift).
          </li>
          <li>
            Unter <em>Entwickler → API-Schlüssel</em> den <strong>geheimen Schlüssel</strong> (<span className="mono">sk_live_…</span>) kopieren und hier eintragen. Zum Ausprobieren geht auch{" "}
            <span className="mono">sk_test_…</span>.
          </li>
          <li>
            Unter <em>Entwickler → Webhooks</em> einen Endpunkt mit der Adresse unten anlegen, Ereignisse <span className="mono">checkout.session.completed</span>,{" "}
            <span className="mono">checkout.session.async_payment_succeeded</span> und <span className="mono">checkout.session.expired</span>. Das Signatur-Secret (
            <span className="mono">whsec_…</span>) hier eintragen.
          </li>
        </ol>
        <Toggle label="Stripe verwenden" checked={v.stripeEnabled} onChange={s.set("stripeEnabled")} />
        <div className="grid-4">
          <TextField
            label="Geheimer Schlüssel"
            type="password"
            value={v.stripeSecretKey}
            onChange={s.set("stripeSecretKey")}
            span={2}
            placeholder={v.hasStripeSecretKey ? "gespeichert – leer lassen zum Beibehalten" : "sk_live_…"}
          />
          <TextField
            label="Webhook-Secret"
            type="password"
            value={v.stripeWebhookSecret}
            onChange={s.set("stripeWebhookSecret")}
            span={2}
            placeholder={v.hasStripeWebhookSecret ? "gespeichert – leer lassen zum Beibehalten" : "whsec_…"}
          />
        </div>
        <CopyField
          label="Webhook-Adresse"
          value={links.data?.webhookUrl ?? ""}
          hint="Ohne Webhook wird eine Zahlung erst gebucht, wenn der Kunde nach dem Bezahlen auf die Seite zurückkehrt. Mit Webhook immer sofort – auch bei SEPA-Lastschrift, die erst nach Tagen bestätigt wird."
        />
        <div className="inline-form">
          <Button
            disabled={s.dirty || !v.hasStripeSecretKey}
            busy={busy === "verify"}
            onClick={() =>
              run("verify", async () => {
                setCheck(await api.post("/api/settings/payments/verify"));
              })
            }
          >
            Verbindung prüfen
          </Button>
          {s.dirty ? <span className="muted small">Erst speichern, dann prüfen.</span> : null}
          {check ? (
            <span className="small">
              <strong>Verbunden</strong> ({check.livemode ? "Live-Modus" : "Testmodus – es fließt kein echtes Geld"}){check.webhook ? "" : ", Webhook-Secret fehlt noch"}
            </span>
          ) : null}
        </div>
        <Toggle
          label="Stripe-Auszahlungen im Kontoauszug ignorieren"
          checked={v.ignorePayouts}
          onChange={s.set("ignorePayouts")}
          hint="Stripe überweist gesammelt (abzüglich Gebühren). Die einzelnen Zahlungen sind schon gebucht – die Sammelüberweisung wird deshalb nicht noch einmal gezählt. Die Stripe-Gebühren erfasst du als Ausgabe (Kategorie Bankgebühren)."
        />
      </Section>
      <Section title="PayPal (einfach)">
        <p className="muted small">
          Zeigt auf der Zahlungsseite einen PayPal.me-Link mit dem offenen Betrag. Diese Zahlungen kommen nicht automatisch an – du trägst sie wie eine Überweisung von Hand ein. Wer PayPal mit
          automatischer Buchung will, schaltet PayPal in Stripe frei.
        </p>
        <div className="grid-4">
          <TextField label="PayPal.me-Name" value={v.paypalMe} onChange={(x) => s.set("paypalMe")(x.replace(/^https?:\/\/(www\.)?paypal\.me\//i, "").replace(/\/.*$/, ""))} placeholder="z. B. musterfirma" span={2} hint="leer = aus" />
        </div>
      </Section>
      <SaveBar dirty={s.dirty} busy={s.busy} onSave={s.save} />
    </>
  );
}

function MailTab() {
  const { api, user } = useSession();
  const s = useSection("mail");
  const m = s.value;
  const { busy, run } = useAction();
  const [testTo, setTestTo] = useState(user.email);
  return (
    <>
      <Section title="Ausgangsserver (SMTP)">
        <Toggle label="E-Mail-Versand aktiv" checked={m.enabled} onChange={s.set("enabled")} hint="Ohne aktiven Versand verschickt Kontor keine E-Mails, auch nicht automatisch." />
        <div className="grid-4">
          <TextField label="SMTP-Server" value={m.host} onChange={s.set("host")} span={2} placeholder="smtp.ionos.de" />
          <NumberField label="Port" plain value={m.port} onChange={(n) => s.set("port")(Math.round(n ?? 587))} />
          <SelectField
            label="Verschlüsselung"
            value={m.secure ? "ssl" : "starttls"}
            onChange={(x) => s.setValue((v) => ({ ...v, secure: x === "ssl", port: x === "ssl" ? 465 : 587 }))}
            options={[
              { value: "starttls", label: "STARTTLS (587)" },
              { value: "ssl", label: "SSL/TLS (465)" },
            ]}
          />
          <TextField label="Benutzername" value={m.user} onChange={s.set("user")} span={2} />
          <TextField
            label="Passwort"
            type="password"
            value={m.password}
            onChange={s.set("password")}
            span={2}
            placeholder={m.hasPassword ? "gespeichert – leer lassen zum Beibehalten" : ""}
            hint="Wird verschlüsselt auf dem Server gespeichert und nie an die App zurückgegeben."
          />
        </div>
      </Section>
      <Section title="Absender">
        <div className="grid-4">
          <TextField label="Absendername" value={m.fromName} onChange={s.set("fromName")} span={2} />
          <TextField label="Absenderadresse" type="email" value={m.fromAddress} onChange={s.set("fromAddress")} span={2} hint="Leer = Benutzername" />
          <TextField label="Antwort an" type="email" value={m.replyTo} onChange={s.set("replyTo")} span={2} />
          <TextField label="Kopie (BCC) an" type="email" value={m.bcc} onChange={s.set("bcc")} span={2} hint="z. B. für die eigene Ablage" />
        </div>
      </Section>
      <SaveBar dirty={s.dirty} busy={s.busy} onSave={s.save} />
      <Section title="Verbindung testen">
        <p className="muted">Erst speichern, dann testen.</p>
        <div className="inline-form">
          <input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label="Test-Empfänger" />
          <Button busy={busy === "verify"} disabled={s.dirty} onClick={() => run("verify", () => api.post("/api/settings/mail/verify"), "Verbindung zum SMTP-Server klappt")}>Verbindung prüfen</Button>
          <Button busy={busy === "test"} disabled={s.dirty} onClick={() => run("test", () => api.post("/api/settings/mail/test", { to: testTo }), `Testnachricht an ${testTo} gesendet`)}>Testnachricht senden</Button>
        </div>
      </Section>
    </>
  );
}

function AutomationTab() {
  const { api } = useSession();
  const s = useSection("automation");
  const a = s.value;
  const { busy, run } = useAction();
  return (
    <>
      <Section title="Automatische E-Mails an Kunden">
        <p className="muted">Gesendet wird nur, wenn der E-Mail-Server eingerichtet ist und beim Kunden eine E-Mail-Adresse hinterlegt ist.</p>
        <div className="stack">
          <Toggle label="Rechnung beim Ausstellen senden" checked={a.sendInvoiceOnIssue} onChange={s.set("sendInvoiceOnIssue")} hint="Mit PDF, optional mit XRechnung. Gilt auch für Stornorechnungen." />
          <Toggle label="Zahlungsbestätigung senden" checked={a.sendPaymentConfirmation} onChange={s.set("sendPaymentConfirmation")} hint="Wenn eine Zahlung zu einer Rechnung erfasst wird. Deckt sie die Rechnung nicht ganz, geht die Vorlage „Teilzahlung“ mit dem Restbetrag raus." />
          <Toggle label="Kunden über neue Rabatte informieren" checked={a.sendDiscountNotice} onChange={s.set("sendDiscountNotice")} hint="Wenn einem Kunden ein persönlicher Rabatt gegeben wird." />
          <Toggle label="Willkommensmail an neue Kunden" checked={a.sendWelcome} onChange={s.set("sendWelcome")} />
          <Toggle label="Zahlungserinnerungen bei Überfälligkeit" checked={a.sendReminders} onChange={s.set("sendReminders")} />
        </div>
        {a.sendReminders ? (
          <div className="grid-4">
            <NumberField label="Erste Erinnerung" value={a.reminderAfterDays} onChange={(n) => s.set("reminderAfterDays")(Math.max(1, Math.round(n ?? 7)))} suffix="Tage nach Fälligkeit" span={2} />
            <NumberField label="Wiederholen alle" value={a.reminderRepeatDays} onChange={(n) => s.set("reminderRepeatDays")(Math.max(1, Math.round(n ?? 7)))} suffix="Tage" />
            <NumberField label="Höchstens" value={a.maxReminders} onChange={(n) => s.set("maxReminders")(Math.min(5, Math.max(0, Math.round(n ?? 2))))} suffix="Mal" />
          </div>
        ) : null}
      </Section>
      <Section title="Mahnstufen">
        <p className="muted">
          Nach den freundlichen Zahlungserinnerungen folgen die Mahnungen. Jede Stufe hat eine eigene Gebühr; Verzugszinsen und bei Firmenkunden die Verzugspauschale von 40 € (§ 288 BGB) werden
          automatisch berechnet. Mahnungen kannst du in jeder Rechnung von Hand erstellen.
        </p>
        <table className="table compact steps-table">
          <thead>
            <tr>
              <th>Bezeichnung</th>
              <th className="num">Tage nach vorheriger</th>
              <th className="num">Gebühr</th>
              <th>Verzugszinsen</th>
              <th className="w-act" />
            </tr>
          </thead>
          <tbody>
            {a.dunningSteps.map((st, i) => {
              const upd = (patch: Partial<typeof st>) => s.set("dunningSteps")(a.dunningSteps.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <tr key={i}>
                  <td><input aria-label="Bezeichnung" value={st.label} onChange={(e) => upd({ label: e.target.value })} /></td>
                  <td><NumberInput ariaLabel="Tage" plain value={st.days} onChange={(n) => upd({ days: Math.min(90, Math.max(1, Math.round(n ?? 14))) })} /></td>
                  <td><MoneyInput ariaLabel="Gebühr" value={st.fee} onChange={(c) => upd({ fee: c ?? 0 })} /></td>
                  <td><label className="inline-check"><input type="checkbox" checked={st.interest} onChange={(e) => upd({ interest: e.target.checked })} /> berechnen</label></td>
                  <td className="row-actions"><button className="icon-btn" aria-label="Stufe entfernen" onClick={() => s.set("dunningSteps")(a.dunningSteps.filter((_, j) => j !== i))}>×</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {a.dunningSteps.length < 4 ? (
          <Button variant="ghost" onClick={() => s.set("dunningSteps")([...a.dunningSteps, { label: `${a.dunningSteps.length + 1}. Mahnung`, days: 14, fee: 500, interest: true }])}>
            Stufe hinzufügen
          </Button>
        ) : null}
        <div className="grid-4">
          <NumberField label="Basiszinssatz" value={a.baseRate} onChange={(n) => s.set("baseRate")(n ?? 0)} suffix="%" hint="Ändert sich zum 1.1. und 1.7. – aktuell auf bundesbank.de" />
          <NumberField label="Zahlungsfrist in der Mahnung" value={a.dunningPayDays} onChange={(n) => s.set("dunningPayDays")(Math.min(60, Math.max(1, Math.round(n ?? 10))))} suffix="Tage" plain />
        </div>
        <div className="stack">
          <Toggle label="40 € Verzugspauschale bei Firmenkunden (§ 288 Abs. 5 BGB)" checked={a.b2bFlatFee} onChange={s.set("b2bFlatFee")} hint="Einmal je Rechnung, nur bei Kunden vom Typ Firma." />
          <Toggle
            label="Mahnungen automatisch versenden"
            checked={a.dunningAuto}
            onChange={s.set("dunningAuto")}
            hint="Aus: Mahnungen entstehen nur, wenn du sie in der Rechnung auslöst. An: nach den Erinnerungen folgt automatisch die nächste Stufe, wenn die Tage abgelaufen sind."
          />
        </div>
      </Section>
      <SaveBar
        dirty={s.dirty}
        busy={s.busy}
        onSave={s.save}
        extra={
          <Button variant="ghost" busy={busy === "run"} onClick={() => run("run", async () => {
            const r = await api.post<{ sent: number }>("/api/automation/reminders/run");
            return r;
          }, "Erinnerungslauf ausgeführt")}>
            Erinnerungen jetzt prüfen
          </Button>
        }
      />
    </>
  );
}

const TEMPLATE_INFO: Record<keyof Settings["templates"], { label: string; vars: string }> = {
  invoice: { label: "Rechnung", vars: "{customerName} {invoiceNumber} {total} {dueDate} {issueDate} {payLink} {payHint} {portalLink} {companyName}" },
  reminder: { label: "Zahlungserinnerung", vars: "{customerName} {invoiceNumber} {total} {open} {dueDate} {issueDate} {payLink} {payHint} {portalLink} {companyName}" },
  payment: { label: "Zahlungsbestätigung", vars: "{customerName} {invoiceNumber} {amount} {total} {companyName}" },
  dunning: { label: "Mahnung", vars: "{dunningLabel} {customerName} {invoiceNumber} {issueDate} {dueDate} {open} {feeLines} {claim} {payUntil} {companyName}" },
  quote: { label: "Angebot", vars: "{customerName} {quoteNumber} {total} {issueDate} {validUntil} {acceptLink} {companyName}" },
  partialPayment: { label: "Teilzahlung", vars: "{customerName} {invoiceNumber} {amount} {total} {paid} {open} {payLink} {payHint} {companyName}" },
  cancellation: { label: "Stornorechnung", vars: "{customerName} {invoiceNumber} {originalNumber} {total} {companyName}" },
  discount: { label: "Rabatt", vars: "{customerName} {discountName} {discountValue} {discountCode} {discountCodeLine} {discountValidLine} {companyName}" },
  welcome: { label: "Willkommen", vars: "{customerName} {customerNumber} {companyName}" },
  portal: { label: "Kundenportal-Link", vars: "{customerName} {customerNumber} {portalLink} {companyName}" },
};

function TemplatesTab() {
  const s = useSection("templates");
  const [which, setWhich] = useState<keyof Settings["templates"]>("invoice");
  const t = s.value[which];
  const update = (patch: Partial<{ subject: string; body: string }>) => s.setValue((v) => ({ ...v, [which]: { ...v[which], ...patch } }));
  return (
    <>
      <Section title="E-Mail-Vorlagen">
        <SelectField
          label="Vorlage"
          value={which}
          onChange={setWhich}
          options={(Object.keys(TEMPLATE_INFO) as (keyof Settings["templates"])[]).map((k) => ({ value: k, label: TEMPLATE_INFO[k].label }))}
        />
        <TextField label="Betreff" value={t.subject} onChange={(v) => update({ subject: v })} />
        <TextArea label="Text" value={t.body} onChange={(v) => update({ body: v })} rows={12} hint={<>Platzhalter: {TEMPLATE_INFO[which].vars}</>} />
      </Section>
      <SaveBar dirty={s.dirty} busy={s.busy} onSave={s.save} />
    </>
  );
}

function UsersTab() {
  const { api, user: me } = useSession();
  const { busy, run } = useAction();
  const users = useLoad(() => api.get<(User & { createdAt: string })[]>("/api/users"), []);
  const invites = useLoad(() => api.get<{ id: string; email: string; role: string; expiresAt: string }[]>("/api/invites"), []);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"USER" | "ADMIN">("USER");
  const [code, setCode] = useState<string | null>(null);

  return (
    <>
      <Section title="Benutzer">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>E-Mail</th>
              <th>Rolle</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(users.data ?? []).map((u) => (
              <tr key={u.id} className={u.active ? "" : "inactive"}>
                <td>{u.name}{u.id === me.id ? <span className="muted"> (du)</span> : null}</td>
                <td>{u.email}</td>
                <td>
                  <select
                    value={u.role}
                    disabled={u.id === me.id}
                    aria-label={`Rolle von ${u.name}`}
                    onChange={(e) => run("role", async () => { await api.patch(`/api/users/${u.id}`, { role: e.target.value }); users.reload(); }, "Rolle geändert")}
                  >
                    <option value="USER">Mitarbeiter</option>
                    <option value="ADMIN">Administrator</option>
                  </select>
                </td>
                <td>{u.active ? "Aktiv" : "Gesperrt"}</td>
                <td className="row-actions">
                  {u.id !== me.id ? (
                    <Button variant="ghost" onClick={() => run("active", async () => { await api.patch(`/api/users/${u.id}`, { active: !u.active }); users.reload(); }, u.active ? "Benutzer gesperrt" : "Benutzer entsperrt")}>
                      {u.active ? "Sperren" : "Entsperren"}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Mitarbeiter einladen">
        <p className="muted">
          Kontor erzeugt einen Einladungscode. Er enthält die Serveradresse – die eingeladene Person fügt ihn in der App unter „Einladungscode einlösen“ ein und vergibt ihr eigenes Passwort. Der Code ist 7 Tage gültig und nur einmal verwendbar.
        </p>
        <div className="inline-form">
          <input type="email" placeholder="E-Mail der Person" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="E-Mail" />
          <select value={role} onChange={(e) => setRole(e.target.value as "USER" | "ADMIN")} aria-label="Rolle">
            <option value="USER">Mitarbeiter</option>
            <option value="ADMIN">Administrator</option>
          </select>
          <Button
            variant="primary"
            busy={busy === "invite"}
            onClick={() => run("invite", async () => {
              const r = await api.post<{ code: string }>("/api/invites", { email, role });
              setCode(r.code);
              setEmail("");
              invites.reload();
            })}
          >
            Einladung erstellen
          </Button>
        </div>
        {code ? (
          <div className="invite-code">
            <textarea readOnly rows={3} value={code} className="mono-input" onFocus={(e) => e.target.select()} aria-label="Einladungscode" />
            <Button onClick={() => navigator.clipboard.writeText(code)}>Code kopieren</Button>
          </div>
        ) : null}
        {invites.data?.length ? (
          <table className="table compact">
            <tbody>
              {invites.data.map((i) => (
                <tr key={i.id}>
                  <td>{i.email}</td>
                  <td className="muted">gültig bis {dateTime(i.expiresAt)}</td>
                  <td className="row-actions">
                    <Button variant="ghost" onClick={() => run("revoke", async () => { await api.del(`/api/invites/${i.id}`); invites.reload(); }, "Einladung zurückgezogen")}>Zurückziehen</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Section>

    </>
  );
}

const CATEGORY_LABEL: Record<Exemption["category"], string> = {
  E: "steuerbefreit (E)",
  AE: "Reverse Charge (AE)",
  K: "innergemeinschaftlich (K)",
  G: "Ausfuhr Drittland (G)",
  Z: "Nullsatz (Z)",
};

/** Gründe für 0 % USt: Text erscheint auf der Rechnung, Kategorie steuert die E-Rechnung */
function ExemptionsEditor({
  value,
  defaultCode,
  onChange,
  onDefault,
}: {
  value: Exemption[];
  defaultCode: string;
  onChange: (v: Exemption[]) => void;
  onDefault: (c: string) => void;
}) {
  const update = (i: number, patch: Partial<Exemption>) => onChange(value.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <Section
      title="Hinweise bei 0 % Umsatzsteuer"
      aside={
        <Button
          variant="ghost"
          onClick={() => onChange([...value, { code: `EIGEN_${Date.now().toString(36).toUpperCase()}`, label: "Eigener Grund", text: "", category: "E" }])}
        >
          <Icon name="plus" /> Grund hinzufügen
        </Button>
      }
    >
      <p className="muted">
        Enthält eine Rechnung Positionen mit 0 %, muss der Grund darauf stehen (§ 14 Abs. 4 Nr. 8 UStG). Im Rechnungseditor wählst du den passenden Grund; der Text wird beim Ausstellen auf die Rechnung gedruckt.
        Texte bitte mit der Steuerberatung abstimmen.
      </p>
      <div className="ex-list">
        {value.map((e, i) => (
          <div className="ex-item" key={e.code}>
            <div className="field">
              <label htmlFor={`ex-l-${i}`}>Bezeichnung</label>
              <input id={`ex-l-${i}`} value={e.label} onChange={(ev) => update(i, { label: ev.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`ex-c-${i}`}>E-Rechnung</label>
              <select id={`ex-c-${i}`} value={e.category} onChange={(ev) => update(i, { category: ev.target.value as Exemption["category"] })}>
                {(Object.keys(CATEGORY_LABEL) as Exemption["category"][]).map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>&nbsp;</label>
              <div className="suggest">
                <label className="inline-check">
                  <input type="radio" name="ex-default" checked={defaultCode === e.code} onChange={() => onDefault(e.code)} /> Standard
                </label>
                {value.length > 1 ? (
                  <button className="icon-btn" aria-label={`${e.label} entfernen`} title="Entfernen" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                    ×
                  </button>
                ) : null}
              </div>
            </div>
            <textarea aria-label={`Text für ${e.label}`} rows={2} value={e.text} onChange={(ev) => update(i, { text: ev.target.value })} placeholder="Text, der auf der Rechnung steht" />
          </div>
        ))}
      </div>
    </Section>
  );
}

function BankTab() {
  const s = useSection("bank");
  return (
    <>
      <Section title="Zahlungsabgleich">
        <p className="muted">
          Kontoauszüge liest du unter <strong>Zahlungsabgleich</strong> ein (CAMT.053, MT940 oder CSV aus dem Online-Banking). Kontor sucht im Verwendungszweck nach Rechnungsnummern, auch mit Leerzeichen oder ohne Bindestriche.
        </p>
        <Toggle
          label="Eindeutige Treffer automatisch buchen"
          checked={s.value.autoBook}
          onChange={s.set("autoBook")}
          hint="Steht eine Rechnungsnummer im Verwendungszweck und passt der Betrag, wird die Zahlung sofort gebucht und die Rechnung als bezahlt markiert. Aus: alles erscheint nur als Vorschlag."
        />
        <p className="muted small">Zahlungen ohne Rechnungsnummer, aber mit passendem Betrag (und Namen), erscheinen immer nur als Vorschlag zum Bestätigen.</p>
      </Section>
      <BankSyncSection s={s} />
      <SaveBar dirty={s.dirty} busy={s.busy} onSave={s.save} />
    </>
  );
}

function BankSyncSection({ s }: { s: ReturnType<typeof useSection<"bank">> }) {
  const { api } = useSession();
  const status = useLoad(() => api.get<{ redirectUrl: string; connected: boolean; bank: { name: string } | null }>("/api/bank/sync"), []);
  const pemRef = useRef<HTMLInputElement>(null);
  const [pemName, setPemName] = useState<string | null>(null);
  const [pemErr, setPemErr] = useState<string | null>(null);
  const v = s.value;
  const onPem = async (file: File | undefined) => {
    setPemErr(null);
    if (!file) return;
    const text = await file.text();
    if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(text)) return setPemErr("Das ist keine Private-Key-Datei (.pem). Sie beginnt mit „-----BEGIN PRIVATE KEY-----“.");
    s.set("ebPrivateKey")(text.trim());
    setPemName(file.name);
    if (pemRef.current) pemRef.current.value = "";
  };
  useEffect(() => {
    if (!v.ebPrivateKey) setPemName(null);
  }, [v.ebPrivateKey]);
  const redirect = status.data?.redirectUrl ?? "";
  return (
    <Section title="Automatischer Kontoabruf">
      <p className="muted">
        Kontor holt die Umsätze direkt vom Bankkonto, über den lizenzierten Dienst <strong>Enable Banking</strong> (PSD2, nur Lesezugriff). Für eigene Konten kostenlos. Einmal einrichten:
      </p>
      <ol className="steps">
        <li>
          Auf <span className="mono">enablebanking.com</span> registrieren und im Control Panel unter <em>API applications</em> eine Anwendung anlegen: Umgebung <em>Production</em>,
          Redirect-URL siehe unten.
        </li>
        <li>Beim Anlegen wird eine <span className="mono">.pem</span>-Datei heruntergeladen – das ist der Private Key. Application-ID und Datei hier eintragen.</li>
        <li>
          In der Anwendung auf <em>Link accounts</em> klicken und das eigene Konto (z. B. N26) einmal verknüpfen. Ohne diesen Schritt bleibt die Anwendung im kostenlosen Modus gesperrt.
        </li>
        <li>Speichern, dann unter Zahlungsabgleich auf „Bank verbinden“.</li>
      </ol>
      <div className="field">
        <label>Redirect-URL (so in Enable Banking eintragen)</label>
        <div className="inline-form">
          <input readOnly value={redirect} className="mono" onFocus={(e) => e.currentTarget.select()} aria-label="Redirect-URL" />
          <Button onClick={() => void navigator.clipboard.writeText(redirect)} disabled={!redirect}>
            Kopieren
          </Button>
        </div>
        <div className="field-hint">
          Muss vom Browser aus erreichbar sein – also deine öffentliche Server-Adresse (<span className="mono">PUBLIC_URL</span> in der .env). Wenn hier eine interne Adresse steht,
          PUBLIC_URL setzen und den Server neu starten.
        </div>
      </div>
      <div className="grid-4">
        <TextField label="Application-ID" value={v.ebAppId} onChange={s.set("ebAppId")} placeholder="z. B. 7b2c…-…" span={2} />
        <div className="field span-2">
          <label>Private Key (.pem)</label>
          <div className="inline-form">
            <span className="pem-state">
              {pemName ? `${pemName} – noch nicht gespeichert` : v.hasEbPrivateKey ? "gespeichert" : <span className="muted">nicht hinterlegt</span>}
            </span>
            <Button onClick={() => pemRef.current?.click()}>{v.hasEbPrivateKey || pemName ? "Ersetzen" : "Datei wählen"}</Button>
          </div>
          <input ref={pemRef} type="file" accept=".pem,.key,.txt" hidden onChange={(e) => void onPem(e.target.files?.[0])} />
          {pemErr ? <div className="field-error">{pemErr}</div> : <div className="field-hint">Wird verschlüsselt auf dem Server gespeichert und nie wieder angezeigt.</div>}
        </div>
      </div>
      <Toggle
        label="Automatisch abrufen"
        checked={v.syncEnabled}
        onChange={s.set("syncEnabled")}
        hint="Der Server fragt das Konto regelmäßig ab und gleicht neue Zahlungseingänge ab. Aus: nur per „Jetzt abrufen“."
      />
      <div className="grid-4">
        <NumberField label="Abruf alle" value={v.syncMinutes} onChange={(n) => s.set("syncMinutes")(n ?? 360)} suffix="Minuten" plain span={2} hint="Banken erlauben ohne dein Zutun meist nur 4 Abrufe pro Tag, daher 360 Minuten (mind. 60). „Jetzt abrufen“ geht jederzeit." />
        <NumberField
          label="Erinnerung vor Ablauf"
          value={v.renewReminderDays}
          onChange={(n) => s.set("renewReminderDays")(n ?? 7)}
          suffix="Tage"
          plain
          span={2}
          hint="Die Freigabe der Bank gilt höchstens 180 Tage. Erinnerung geht an die Firmen-E-Mail (0 = aus)."
        />
      </div>
    </Section>
  );
}

function ListEditor({
  label,
  values,
  onChange,
  placeholder,
  hint,
  keepCase,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  hint?: string;
  keepCase?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = keepCase ? draft.trim() : draft.trim().toLowerCase();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  };
  return (
    <div className="field">
      <label>{label}</label>
      <div className="inline-form">
        <input
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          aria-label={label}
        />
        <Button onClick={add} disabled={!draft.trim()}>
          Hinzufügen
        </Button>
      </div>
      {values.length ? (
        <div className="chip-list">
          {values.map((v) => (
            <span className="chip" key={v}>
              {v}
              <button aria-label={`${v} entfernen`} onClick={() => onChange(values.filter((x) => x !== v))}>
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

function TicketsTab() {
  const { api } = useSession();
  const users = useLoad(() => api.get<User[]>("/api/users"), []);
  const s = useSection("tickets");
  const t = s.value;
  const { busy, run } = useAction();
  const [check, setCheck] = useState<{ imap: string; smtp: string; messages?: number } | null>(null);
  return (
    <>
      <Section title="Ticket-Postfach">
        <p className="muted">
          Ein eigenes Postfach nur für Anfragen (z. B. ticket@deinefirma.de). Kontor ruft es regelmäßig ab und macht aus passenden Mails Tickets. Antworten aus Kontor gehen über dieses Postfach raus, Rückantworten der Kunden landen automatisch
          im selben Ticket. Das Postfach selbst wird nicht verändert.
        </p>
        <Toggle label="Ticket-Postfach abrufen" checked={t.enabled} onChange={s.set("enabled")} hint={t.enabled && t.since ? `Berücksichtigt Mails ab ${dateTime(t.since)}.` : "Beim Einschalten werden nur Mails ab diesem Zeitpunkt berücksichtigt."} />
        <div className="grid-4">
          <TextField label="Ticket-Adresse" type="email" value={t.address} onChange={s.set("address")} span={2} placeholder="ticket@deinefirma.de" />
          <TextField label="Absendername" value={t.fromName} onChange={s.set("fromName")} span={2} placeholder="z. B. Support Muster GmbH" />
        </div>
      </Section>
      <Section title="Abruf (IMAP)">
        <div className="grid-4">
          <TextField label="IMAP-Server" value={t.imapHost} onChange={s.set("imapHost")} span={2} placeholder="imap.ionos.de" />
          <NumberField label="Port" plain value={t.imapPort} onChange={(n) => s.set("imapPort")(Math.round(n ?? 993))} />
          <SelectField
            label="Verschlüsselung"
            value={t.imapSecure ? "ssl" : "starttls"}
            onChange={(x) => s.setValue((v) => ({ ...v, imapSecure: x === "ssl", imapPort: x === "ssl" ? 993 : 143 }))}
            options={[
              { value: "ssl", label: "SSL/TLS (993)" },
              { value: "starttls", label: "STARTTLS (143)" },
            ]}
          />
          <TextField label="Benutzername" value={t.imapUser} onChange={s.set("imapUser")} span={2} />
          <TextField
            label="Passwort"
            type="password"
            value={t.imapPassword}
            onChange={s.set("imapPassword")}
            span={2}
            placeholder={t.hasImapPassword ? "gespeichert – leer lassen zum Beibehalten" : ""}
          />
          <TextField label="Ordner" value={t.folder} onChange={s.set("folder")} />
          <NumberField label="Abrufen alle" value={t.pollMinutes} onChange={(n) => s.set("pollMinutes")(Math.min(60, Math.max(1, Math.round(n ?? 2))))} suffix="Minuten" />
        </div>
      </Section>
      <Section title="Versand (SMTP)">
        <p className="muted small">Leer lassen, wenn Server und Zugangsdaten dieselben wie beim Abruf sind.</p>
        <div className="grid-4">
          <TextField label="SMTP-Server" value={t.smtpHost} onChange={s.set("smtpHost")} span={2} placeholder={t.imapHost.replace(/^imap\./, "smtp.") || "smtp.ionos.de"} />
          <NumberField label="Port" plain value={t.smtpPort} onChange={(n) => s.set("smtpPort")(Math.round(n ?? 587))} />
          <SelectField
            label="Verschlüsselung"
            value={t.smtpSecure ? "ssl" : "starttls"}
            onChange={(x) => s.setValue((v) => ({ ...v, smtpSecure: x === "ssl", smtpPort: x === "ssl" ? 465 : 587 }))}
            options={[
              { value: "starttls", label: "STARTTLS (587)" },
              { value: "ssl", label: "SSL/TLS (465)" },
            ]}
          />
          <TextField label="Benutzername" value={t.smtpUser} onChange={s.set("smtpUser")} span={2} placeholder={t.imapUser || "wie IMAP"} />
          <TextField label="Passwort" type="password" value={t.smtpPassword} onChange={s.set("smtpPassword")} span={2} placeholder={t.hasSmtpPassword ? "gespeichert" : "wie IMAP"} />
        </div>
        <div className="inline-form">
          <Button
            disabled={s.dirty}
            busy={busy === "verify"}
            onClick={() =>
              run("verify", async () => {
                setCheck(await api.post("/api/settings/tickets/verify"));
              })
            }
          >
            Verbindung prüfen
          </Button>
          {s.dirty ? <span className="muted small">Erst speichern, dann prüfen.</span> : null}
          {check ? (
            <span className="small">
              IMAP: <strong className={check.imap === "ok" ? "" : "text-danger"}>{check.imap === "ok" ? `ok (${check.messages ?? 0} Mails im Ordner)` : check.imap}</strong>
              {", "}SMTP: <strong className={check.smtp === "ok" ? "" : "text-danger"}>{check.smtp}</strong>
            </span>
          ) : null}
        </div>
      </Section>
      <Section title="Filter">
        <p className="muted">
          Jede Mail wird bewertet: Newsletter-Kennzeichen, Werbe- und Phishing-Begriffe, viele Links sprechen dagegen; bekannte Kunden, Fragen und typische Anliegen („funktioniert nicht“, „Rechnung“, „Termin“) dafür. Abwesenheitsnotizen und
          Zustellfehler werden immer aussortiert. Aussortierte Mails findest du unter Tickets → Aussortiert.
        </p>
        <div className="field">
          <label>Strenge</label>
          <div className="segmented" role="group" aria-label="Strenge des Filters">
            {(
              [
                ["low", "Locker"],
                ["normal", "Normal"],
                ["strict", "Streng"],
              ] as const
            ).map(([v, l]) => (
              <button key={v} aria-pressed={t.filterLevel === v} onClick={() => s.set("filterLevel")(v)}>
                {l}
              </button>
            ))}
          </div>
          <div className="field-hint">
            {t.filterLevel === "low"
              ? "Nur eindeutige Werbung und Newsletter fliegen raus."
              : t.filterLevel === "normal"
                ? "Werbung, Newsletter, Kaltakquise und Phishing werden aussortiert."
                : "Nur Mails mit erkennbarem Anliegen oder von bekannten Kunden werden Tickets."}
          </div>
        </div>
        <ListEditor label="Immer zulassen" values={t.allowSenders} onChange={s.set("allowSenders")} placeholder="name@firma.de oder @firma.de" />
        <ListEditor label="Immer aussortieren" values={t.blockSenders} onChange={s.set("blockSenders")} placeholder="werbung@shop.de oder @shop.de" hint="Eine Domain mit @ davor erfasst alle Adressen dieser Firma." />
      </Section>
      <Section title="Wer darf Tickets eröffnen">
        <Toggle
          label="Nur Kunden"
          checked={t.onlyKnownCustomers}
          onChange={s.set("onlyKnownCustomers")}
          hint="Der Absender muss als Kunde angelegt sein. Die Liste „Immer zulassen“ gilt zusätzlich."
        />
        {t.onlyKnownCustomers ? (
          <>
            <Toggle
              label="Kollegen des Kunden zulassen"
              checked={t.allowCustomerDomain}
              onChange={s.set("allowCustomerDomain")}
              hint="Auch andere Adressen mit derselben Firmen-Domain wie der Kunde (z. B. @kunde.de). Gilt nicht für Freemail wie gmail.com oder web.de."
            />
            <div className="field">
              <label>Mails von Nicht-Kunden</label>
              <div className="segmented" role="group" aria-label="Mails von Nicht-Kunden">
                <button aria-pressed={t.nonCustomerAction === "filter"} onClick={() => s.set("nonCustomerAction")("filter")}>Still aussortieren</button>
                <button aria-pressed={t.nonCustomerAction === "reject"} onClick={() => s.set("nonCustomerAction")("reject")}>Mit Absage antworten</button>
              </div>
              <div className="field-hint">Aussortierte Mails findest du unter Tickets → Aussortiert und kannst sie dort trotzdem als Ticket übernehmen.</div>
            </div>
            {t.nonCustomerAction === "reject" ? (
              <>
                <TextField label="Betreff der Absage" value={t.rejectSubject} onChange={s.set("rejectSubject")} />
                <TextArea label="Text der Absage" value={t.rejectBody} onChange={s.set("rejectBody")} rows={6} hint={<>Platzhalter: {"{subject} {companyName} {companyEmail}"}. Werbung und Newsletter bekommen nie eine Absage.</>} />
              </>
            ) : null}
          </>
        ) : null}
        <Toggle label="Tickets über Kundenportal und Webformular" checked={t.portalTickets} onChange={s.set("portalTickets")} hint="Kunden können Anfragen auch über ihren Portal-Link oder das Formular auf deiner Website stellen." />
        <Toggle label="Anhänge annehmen" checked={t.allowAttachments} onChange={s.set("allowAttachments")} hint={t.allowAttachments ? undefined : "Anhänge werden verworfen, der Text bleibt."} />
        {t.allowAttachments ? (
          <div className="grid-4">
            <NumberField label="Max. Größe je Anhang" value={t.maxAttachmentMb} onChange={(n) => s.set("maxAttachmentMb")(Math.min(50, Math.max(1, Math.round(n ?? 15))))} suffix="MB" />
          </div>
        ) : null}
      </Section>
      <Section title="Bearbeitung">
        <div className="grid-4">
          <SelectField
            label="Priorität neuer Tickets"
            value={t.defaultPriority}
            onChange={s.set("defaultPriority")}
            options={[
              { value: "LOW", label: "Niedrig" },
              { value: "NORMAL", label: "Normal" },
              { value: "HIGH", label: "Hoch" },
              { value: "URGENT", label: "Dringend" },
            ]}
          />
          <SelectField
            label="Automatisch zuweisen an"
            value={t.autoAssignUserId}
            onChange={s.set("autoAssignUserId")}
            options={[{ value: "", label: "Niemand" }, ...(users.data ?? []).filter((u) => u.active !== false).map((u) => ({ value: u.id, label: u.name }))]}
          />
        </div>
        <ListEditor label="Kategorien" values={t.categories} onChange={s.set("categories")} placeholder="z. B. Website" keepCase hint="Zum Sortieren und Filtern. Beginnt der Betreff mit „[Fehler]“ oder „Fehler:“, wird die Kategorie automatisch gesetzt. „dringend“ im Betreff hebt die Priorität auf Hoch." />
        <Toggle label="Team bei neuen Tickets benachrichtigen" checked={t.notifyTeam} onChange={s.set("notifyTeam")} />
        {t.notifyTeam ? <TextField label="Benachrichtigung an" type="email" value={t.notifyAddress} onChange={s.set("notifyAddress")} placeholder="leer = Firmen-E-Mail" hint="Bei Zuweisung bekommt zusätzlich der zuständige Benutzer die Mail." /> : null}
      </Section>
      <Section title="Rückantworten & Abschluss">
        <Toggle label="Antwort auf erledigtes Ticket öffnet es wieder" checked={t.reopenOnReply} onChange={s.set("reopenOnReply")} hint={t.reopenOnReply ? undefined : "Jede Antwort auf ein erledigtes Ticket wird ein neues Ticket (mit Verweis auf das alte)."} />
        {t.reopenOnReply ? (
          <div className="grid-4">
            <NumberField
              label="Aber neues Ticket nach"
              value={t.reopenMaxDays}
              onChange={(n) => s.set("reopenMaxDays")(Math.min(365, Math.max(0, Math.round(n ?? 0))))}
              suffix="Tagen"
              hint="0 = immer wieder öffnen"
            />
          </div>
        ) : null}
        <div className="grid-4">
          <NumberField
            label="„Wartet auf Kunde“ schließen nach"
            value={t.autoCloseDays}
            onChange={(n) => s.set("autoCloseDays")(Math.min(365, Math.max(0, Math.round(n ?? 0))))}
            suffix="Tagen"
            hint="0 = nie automatisch"
            span={2}
          />
        </div>
        {t.autoCloseDays > 0 ? (
          <>
            <Toggle label="Kunden beim automatischen Schließen informieren" checked={t.autoCloseNotify} onChange={s.set("autoCloseNotify")} />
            {t.autoCloseNotify ? <TextArea label="Text" value={t.autoCloseBody} onChange={s.set("autoCloseBody")} rows={6} hint={<>Platzhalter: {"{customerName} {ticketNumber} {subject} {companyName}"}</>} /> : null}
          </>
        ) : null}
      </Section>
      <Section title="Antworten">
        <Toggle label="Eingangsbestätigung senden" checked={t.autoReply} onChange={s.set("autoReply")} hint="Neue Tickets bekommen sofort eine Bestätigung mit Ticketnummer. Nicht bei aussortierten Mails." />
        {t.autoReply ? (
          <>
            <TextField label="Betreff der Eingangsbestätigung" value={t.autoReplySubject} onChange={s.set("autoReplySubject")} hint="Die Ticketnummer [T-…] wird automatisch vorangestellt." />
            <TextArea label="Text der Eingangsbestätigung" value={t.autoReplyBody} onChange={s.set("autoReplyBody")} rows={7} hint={<>Platzhalter: {"{customerName} {ticketNumber} {subject} {companyName}"}</>} />
          </>
        ) : null}
        <TextArea label="Signatur unter Antworten" value={t.signature} onChange={s.set("signature")} rows={3} hint={<>Platzhalter: {"{userName} {companyName}"}</>} />
        <TextField label="Ticketnummer" value={t.numberFormat} onChange={s.set("numberFormat")} hint="{YYYY} Jahr, {NNNN} laufende Nummer" />
      </Section>
      <SaveBar dirty={s.dirty} busy={s.busy} onSave={s.save} />
    </>
  );
}

interface ImportResult {
  counts: Record<string, { total: number; imported: number }>;
  settingsImported: boolean;
  exportedAt: string | null;
}

const IMPORT_LABELS: Record<string, string> = {
  customers: "Kunden",
  products: "Produkte",
  discounts: "Rabatte",
  invoices: "Rechnungen",
  invoiceItems: "Rechnungspositionen",
  bankTransactions: "Bankbuchungen",
  incomes: "Einnahmen",
  tickets: "Tickets",
  ticketMessages: "Ticket-Nachrichten",
  ticketAttachments: "Ticket-Anhänge",
  quotes: "Angebote",
  quoteItems: "Angebotspositionen",
  recurringInvoices: "Abo-Rechnungen",
  dunnings: "Mahnungen",
  onlinePayments: "Online-Zahlungen",
  expenses: "Ausgaben",
  projects: "Projekte",
  timeEntries: "Zeiteinträge",
  charges: "Material/Pauschalen",
  contracts: "Verträge",
};

function BackupTab() {
  const { api, reloadSettings } = useSession();
  const { busy, run } = useAction();
  const [file, setFile] = useState<{ name: string; data: Record<string, unknown> } | null>(null);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [withSettings, setWithSettings] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const pickFile = async (f: File | undefined) => {
    setFileError(null);
    setResult(null);
    if (!f) return;
    try {
      const data = JSON.parse(await f.text()) as Record<string, unknown>;
      if (data.format && data.format !== "kontor-export") throw new Error("Das ist keine Kontor-Sicherung");
      if (!Array.isArray(data.customers)) throw new Error("Die Datei enthält keine Kontor-Daten");
      setFile({ name: f.name, data });
    } catch (e) {
      setFile(null);
      setFileError(e instanceof SyntaxError ? "Die Datei ist kein gültiges JSON" : e instanceof Error ? e.message : String(e));
    }
  };

  const doImport = () =>
    run(
      "import",
      async () => {
        const r = await api.post<ImportResult>("/api/import", { mode, importSettings: withSettings, data: file!.data });
        setResult(r);
        setConfirm(false);
        if (r.settingsImported) await reloadSettings();
      },
      "Import abgeschlossen",
    );

  const counts = file
    ? Object.keys(IMPORT_LABELS)
        .map((k) => [k, Array.isArray(file.data[k]) ? (file.data[k] as unknown[]).length : 0] as const)
        .filter(([, n]) => n > 0)
    : [];

  return (
    <>
      <Section title="Export">
        <p className="muted">
          Speichert Kunden, Produkte, Rabatte, Rechnungen, Einnahmen, Bankbuchungen, Tickets, Nummernkreise und Einstellungen in einer JSON-Datei. Passwörter sind nicht enthalten. Die tägliche Datenbanksicherung übernimmt zusätzlich der
          Server.
        </p>
        <Button
          busy={busy === "export"}
          onClick={() =>
            run("export", async () => {
              const f = await api.download("/api/export");
              await saveFile(f.blob, f.filename);
            })
          }
        >
          <Icon name="download" /> Export herunterladen
        </Button>
      </Section>

      <Section title="Import">
        <p className="muted">Spielt eine Kontor-Sicherung wieder ein, z. B. nach einem Serverumzug. Benutzerkonten werden nicht importiert.</p>
        <div className="field">
          <input ref={fileRef} id="import-file" type="file" accept=".json,application/json" hidden onChange={(e) => void pickFile(e.target.files?.[0])} />
          <div>
            <Button onClick={() => fileRef.current?.click()}>
              <Icon name="upload" /> Sicherungsdatei auswählen
            </Button>
          </div>
          {fileError ? <div className="field-error">{fileError}</div> : null}
        </div>
        {file ? (
          <>
            <p className="small">
              <strong>{file.name}</strong>
              {typeof file.data.exportedAt === "string" ? `, erstellt ${dateTime(file.data.exportedAt)}` : ""}: {counts.map(([k, n]) => `${n} ${IMPORT_LABELS[k]}`).join(", ") || "keine Datensätze"}
            </p>
            <div className="field">
              <label>Vorgehen</label>
              <div className="segmented" role="group" aria-label="Import-Modus">
                <button aria-pressed={mode === "merge"} onClick={() => setMode("merge")}>
                  Zusammenführen
                </button>
                <button aria-pressed={mode === "replace"} onClick={() => setMode("replace")}>
                  Alles ersetzen
                </button>
              </div>
              <div className="field-hint">
                {mode === "merge"
                  ? "Fehlende Datensätze werden ergänzt. Vorhandene (gleiche ID oder Nummer) bleiben unverändert, nichts wird doppelt angelegt."
                  : "Alle Kunden, Rechnungen, Einnahmen, Tickets usw. auf diesem Server werden gelöscht und durch die Sicherung ersetzt."}
              </div>
            </div>
            <Toggle label="Einstellungen übernehmen" checked={withSettings} onChange={setWithSettings} hint="Firmendaten, Rechnungs- und Mail-Einstellungen, Vorlagen. Passwörter bleiben wie sie sind, das Ticket-Postfach bleibt aus." />
            <Button variant={mode === "replace" ? "danger" : "primary"} busy={busy === "import"} onClick={() => (mode === "replace" ? setConfirm(true) : void doImport())}>
              <Icon name="upload" /> {mode === "replace" ? "Alles ersetzen" : "Importieren"}
            </Button>
          </>
        ) : null}
        {result ? (
          <table className="table compact" style={{ marginTop: 16, maxWidth: 520 }}>
            <thead>
              <tr>
                <th>Bereich</th>
                <th className="num">In der Datei</th>
                <th className="num">Übernommen</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(result.counts)
                .filter(([, c]) => c.total > 0)
                .map(([k, c]) => (
                  <tr key={k}>
                    <td>{IMPORT_LABELS[k] ?? k}</td>
                    <td className="num">{c.total}</td>
                    <td className="num">{c.imported}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        ) : null}
      </Section>
      {confirm ? (
        <Confirm
          title="Alle Daten ersetzen?"
          text="Alle Geschäftsdaten auf diesem Server werden gelöscht und durch die Sicherung ersetzt. Das lässt sich nicht rückgängig machen. Lade vorher am besten einen aktuellen Export herunter."
          confirmLabel="Endgültig ersetzen"
          danger
          busy={busy === "import"}
          onCancel={() => setConfirm(false)}
          onConfirm={doImport}
        />
      ) : null}
    </>
  );
}

function AppearanceTab() {
  const [mode, setMode] = useTheme();
  const options: { value: ThemeMode; label: string; hint: string }[] = [
    { value: "light", label: "Hell", hint: "Immer hell" },
    { value: "dark", label: "Dunkel", hint: "Immer dunkel" },
    { value: "system", label: "Wie System", hint: "Folgt Windows bzw. macOS" },
  ];
  return (
    <Section title="Darstellung">
      <p className="muted">Gilt nur für diesen PC. Umschalten geht auch jederzeit unten in der Seitenleiste.</p>
      <div className="theme-cards" role="group" aria-label="Farbschema">
        {options.map((o) => (
          <button key={o.value} className="theme-card" aria-pressed={mode === o.value} onClick={() => setMode(o.value)}>
            <span className={`theme-preview ${o.value}`}>
              <i />
              <span />
            </span>
            <strong>{o.label}</strong>
            <span className="muted small">{o.hint}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

function NotifySection() {
  const [p, setP] = useState(loadNotifyPrefs);
  const update = (next: typeof p) => {
    setP(next);
    saveNotifyPrefs(next);
  };
  return (
    <Section title="Benachrichtigungen">
      <p className="muted">Gilt nur für diesen PC. Kontor schaut jede Minute nach Neuigkeiten.</p>
      <Toggle label="Benachrichtigungen anzeigen" checked={p.enabled} onChange={(v) => update({ ...p, enabled: v })} />
      {p.enabled ? (
        <>
          <Toggle
            label="Als Windows-Benachrichtigung, wenn Kontor im Hintergrund ist"
            checked={p.system}
            onChange={(v) => update({ ...p, system: v })}
            hint="Sonst erscheinen Neuigkeiten nur unten rechts in Kontor."
          />
          <div className="toggle-grid">
            {(Object.keys(NOTIFY_LABELS) as NotifyKind[]).map((k) => (
              <Toggle key={k} label={NOTIFY_LABELS[k]} checked={p.kinds[k]} onChange={(v) => update({ ...p, kinds: { ...p.kinds, [k]: v } })} />
            ))}
          </div>
          <Button onClick={() => void notify("Kontor", "So sehen Benachrichtigungen aus.")}>Test-Benachrichtigung</Button>
        </>
      ) : null}
    </Section>
  );
}

function AccountTab() {
  const { api, user } = useSession();
  const { busy, run } = useAction();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [next2, setNext2] = useState("");
  return (
    <Section title="Mein Konto">
      <dl className="facts">
        <div><dt>Name</dt><dd>{user.name}</dd></div>
        <div><dt>E-Mail</dt><dd>{user.email}</dd></div>
        <div><dt>Rolle</dt><dd>{user.role === "ADMIN" ? "Administrator" : "Mitarbeiter"}</dd></div>
      </dl>
      <h3 className="subhead">Passwort ändern</h3>
      <div className="grid-2 narrow">
        <TextField label="Aktuelles Passwort" type="password" value={current} onChange={setCurrent} span={2} />
        <TextField label="Neues Passwort" type="password" value={next} onChange={setNext} hint="Mindestens 10 Zeichen" />
        <TextField label="Wiederholen" type="password" value={next2} onChange={setNext2} />
      </div>
      <Button
        variant="primary"
        busy={busy === "pw"}
        disabled={!current || next.length < 10 || next !== next2}
        onClick={() => run("pw", async () => {
          await api.post("/api/auth/password", { current, next });
          setCurrent("");
          setNext("");
          setNext2("");
        }, "Passwort geändert")}
      >
        Passwort ändern
      </Button>
    </Section>
  );
}

function ConnectionTab() {
  const { profile, switchServer, logout } = useSession();
  return (
    <Section title="Verbindung">
      <dl className="facts">
        <div><dt>Server</dt><dd>{profile.url}</dd></div>
        <div><dt>Instanz</dt><dd className="mono">{profile.instanceId}</dd></div>
        <div><dt>Angemeldet als</dt><dd>{profile.email}</dd></div>
      </dl>
      <p className="muted">
        Alle Daten liegen auf diesem Server, nicht auf diesem PC. Die Instanz-Kennung schützt davor, dass sich die App unbemerkt mit einem anderen Server verbindet.
      </p>
      <p className="muted">
        Für Firmen-Installationen kann eine Datei <code>kontor.json</code> neben die <code>Kontor.exe</code> oder nach <code>%APPDATA%\de.jadenk.kontor\</code> gelegt werden. Die darin eingetragenen Server erscheinen automatisch in der Verbindungsauswahl.
      </p>
      <div className="inline-actions">
        <Button onClick={switchServer}>Server wechseln</Button>
        <Button variant="ghost" onClick={logout}>Abmelden</Button>
      </div>
    </Section>
  );
}
