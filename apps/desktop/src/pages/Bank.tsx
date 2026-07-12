import { useEffect, useRef, useState } from "react";
import { useAction, useApi, useLoad, useNav, useSession, useToast } from "../lib/store";
import { date, money } from "../lib/format";
import type { BankTx, InvoiceListRow } from "../lib/types";
import { Button, Confirm, Empty, ErrorBox, Loading, Modal, PageHeader, SelectField, Tabs, TextField } from "../components/ui";
import { Icon } from "../components/Icon";
import { BankConnection } from "../components/BankConnection";

type View = "open" | "debits" | "matched" | "ignored";

interface ImportResult {
  format: string;
  total: number;
  credits: number;
  debitsSkipped: number;
  debits?: number;
  expensesBooked?: number;
  imported: number;
  duplicates: number;
  alreadyBooked?: number;
  matched: number;
  suggested: number;
  unmatched: number;
}

interface Summary {
  unmatched: { n: number };
  suggested: { n: number };
  matched: { n: number };
  ignored: { n: number };
  debits?: { n: number; sum: number };
  lastBookingDate: string | null;
}

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function Bank() {
  const api = useApi();
  const toast = useToast();
  const { go } = useNav();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const [view, setView] = useState<View>("open");
  const [drag, setDrag] = useState(false);
  const [asIncome, setAsIncome] = useState<BankTx | null>(null);
  const [unassign, setUnassign] = useState<BankTx | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const list = useLoad(() => api.get<BankTx[]>(`/api/bank/transactions?view=${view}`), [view]);
  const summary = useLoad(() => api.get<Summary>("/api/bank/summary"), []);
  const open = useLoad(() => api.get<InvoiceListRow[]>("/api/invoices?status=ISSUED"), []);
  const reload = () => {
    list.reload();
    summary.reload();
    open.reload();
  };

  const upload = (file: File | undefined) => {
    if (!file) return;
    void run("import", async () => {
      const r = await api.post<ImportResult>("/api/bank/import", { filename: file.name, data: await fileToBase64(file) });
      const parts = [`${r.imported} neue Zahlungseingänge (${r.format})`];
      if (r.matched) parts.push(`${r.matched} automatisch gebucht`);
      if (r.suggested) parts.push(`${r.suggested} Vorschläge`);
      if (r.duplicates) parts.push(`${r.duplicates} bereits bekannt`);
      if (r.alreadyBooked) parts.push(`${r.alreadyBooked} doppelt (Rechnung war schon bezahlt)`);
      if (r.debits) parts.push(`${r.debits} Abbuchungen${r.expensesBooked ? `, davon ${r.expensesBooked} automatisch als Ausgabe gebucht` : ""}`);
      toast.ok(parts.join(", "));
      setView("open");
      reload();
    });
    if (fileRef.current) fileRef.current.value = "";
  };

  const pending = (summary.data?.unmatched.n ?? 0) + (summary.data?.suggested.n ?? 0);

  return (
    <>
      <PageHeader
        title="Zahlungsabgleich"
        sub="Zahlungen mit Rechnungsnummer im Verwendungszweck werden automatisch gebucht, die Rechnung gilt dann als bezahlt."
        actions={
          <Button
            busy={busy === "rematch"}
            onClick={() =>
              run("rematch", async () => {
                const r = await api.post<{ matched: number; suggested: number }>("/api/bank/rematch");
                toast.ok(`${r.matched} gebucht, ${r.suggested} Vorschläge`);
                reload();
              })
            }
          >
            <Icon name="refresh" /> Neu abgleichen
          </Button>
        }
      />

      <BankConnection onSynced={reload} />

      <div
        className={`dropzone ${drag ? "drag" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          upload(e.dataTransfer.files?.[0]);
        }}
      >
        <Icon name="upload" />
        <div className="dropzone-text">
          <strong>Kontoauszug hierher ziehen</strong>
          <span className="muted small">
            CAMT.053 (XML) aus dem Online-Banking ist am genauesten. MT940 und CSV der meisten deutschen Banken gehen auch. Bereits importierte Buchungen werden erkannt.
            {summary.data?.lastBookingDate ? ` Letzte Buchung: ${date(summary.data.lastBookingDate)}.` : ""}
          </span>
        </div>
        <input ref={fileRef} type="file" accept=".xml,.csv,.txt,.sta,.mt940,.940" hidden onChange={(e) => upload(e.target.files?.[0])} />
        <Button variant="primary" busy={busy === "import"} onClick={() => fileRef.current?.click()}>
          Datei auswählen
        </Button>
      </div>

      {!settings.bank.autoBook ? (
        <div className="hint hint-info">
          <span>Automatisches Buchen ist aus – alle Treffer erscheinen als Vorschlag.</span>
          <Button variant="ghost" onClick={() => go({ name: "settings", tab: "bank" })}>
            Einstellung ändern
          </Button>
        </div>
      ) : null}

      <div className="toolbar">
        <Tabs
          value={view}
          onChange={setView}
          tabs={[
            { value: "open", label: "Zu prüfen", count: pending },
            { value: "debits", label: "Ausgaben", count: summary.data?.debits?.n },
            { value: "matched", label: "Zugeordnet", count: summary.data?.matched.n },
            { value: "ignored", label: "Ignoriert", count: summary.data?.ignored.n },
          ]}
        />
      </div>

      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : list.loading && !list.data ? (
        <Loading />
      ) : !list.data?.length ? (
        <Empty title={view === "open" ? "Nichts zu prüfen" : view === "debits" ? "Keine offenen Abbuchungen" : view === "matched" ? "Noch keine zugeordneten Zahlungen" : "Keine ignorierten Zahlungen"}>
          {view === "open" ? <p className="muted">Alle Zahlungseingänge sind zugeordnet. Neue kommen mit dem nächsten Kontoauszug.</p> : null}
          {view === "debits" ? <p className="muted">Abbuchungen aus dem Kontoauszug erscheinen hier. Ordnest du einen Empfänger einmal einer Kategorie zu, bucht Kontor ihn künftig automatisch.</p> : null}
        </Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Datum</th>
              <th>{view === "debits" ? "Empfänger" : "Zahler"}</th>
              <th>Verwendungszweck</th>
              <th className="num">Betrag</th>
              <th>{view === "open" ? "Zuordnung" : view === "debits" ? "Als Ausgabe buchen" : "Ergebnis"}</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((t) => (
              <tr key={t.id}>
                <td className="nowrap">{date(t.bookingDate)}</td>
                <td>
                  {t.counterpartyName ?? <span className="muted">unbekannt</span>}
                  {t.counterpartyIban ? <div className="sub mono">{t.counterpartyIban}</div> : null}
                </td>
                <td className="tx-purpose">{t.purpose ?? <span className="muted">–</span>}</td>
                <td className="num strong">{money(t.amount)}</td>
                <td>
                  {view === "debits" ? (
                    <DebitCell tx={t} onDone={reload} />
                  ) : t.status === "MATCHED" ? (
                    <div className="stack">
                      <div className="suggest">
                        <span className="badge badge-ok">Gebucht</span>
                        {t.invoiceId ? (
                          <button className="link" onClick={() => go({ name: "invoice", id: t.invoiceId! })}>
                            {t.invoiceNumber}
                          </button>
                        ) : null}
                        <Button variant="ghost" className="btn-sm" onClick={() => setUnassign(t)}>
                          Aufheben
                        </Button>
                      </div>
                      {t.matchNote ? <span className="suggest-note">{t.matchNote}</span> : null}
                    </div>
                  ) : t.status === "IGNORED" ? (
                    <div className="stack">
                      <Button
                        variant="ghost"
                        className="btn-sm"
                        busy={busy === `re${t.id}`}
                        onClick={() =>
                          run(`re${t.id}`, async () => {
                            await api.post(`/api/bank/transactions/${t.id}/reopen`);
                            reload();
                          })
                        }
                      >
                        Wieder prüfen
                      </Button>
                      {t.matchNote ? <span className="suggest-note">{t.matchNote}</span> : null}
                    </div>
                  ) : (
                    <div className="stack">
                      {t.status === "SUGGESTED" && t.invoiceId ? (
                        <div className="suggest">
                          <span className="badge badge-warn">Vorschlag</span>
                          <span>
                            {t.invoiceNumber}
                            {t.invoiceCustomer ? <span className="muted"> – {t.invoiceCustomer}</span> : null}
                          </span>
                          <Button
                            variant="primary"
                            className="btn-sm"
                            busy={busy === `ok${t.id}`}
                            onClick={() =>
                              run(
                                `ok${t.id}`,
                                async () => {
                                  await api.post(`/api/bank/transactions/${t.id}/assign`, { invoiceId: t.invoiceId });
                                  reload();
                                },
                                `Zahlung auf ${t.invoiceNumber} gebucht`,
                              )
                            }
                          >
                            <Icon name="check" /> Bestätigen
                          </Button>
                        </div>
                      ) : null}
                      {t.matchNote && t.status === "SUGGESTED" ? <span className="suggest-note">{t.matchNote}</span> : null}
                      <div className="suggest">
                        <select className="assign-select" aria-label="Rechnung wählen" value={pick[t.id] ?? ""} onChange={(e) => setPick((p) => ({ ...p, [t.id]: e.target.value }))}>
                          <option value="">{t.status === "SUGGESTED" ? "Andere Rechnung …" : "Rechnung wählen …"}</option>
                          {(open.data ?? [])
                            .filter((i) => i.kind === "INVOICE")
                            .map((i) => (
                              <option key={i.id} value={i.id}>
                                {i.number} – {i.customerName} – offen {money(i.totalGross - i.paidTotal)}
                              </option>
                            ))}
                        </select>
                        <Button
                          className="btn-sm"
                          disabled={!pick[t.id]}
                          busy={busy === `as${t.id}`}
                          onClick={() =>
                            run(
                              `as${t.id}`,
                              async () => {
                                await api.post(`/api/bank/transactions/${t.id}/assign`, { invoiceId: pick[t.id] });
                                reload();
                              },
                              "Zahlung gebucht",
                            )
                          }
                        >
                          Zuordnen
                        </Button>
                      </div>
                      <div className="suggest">
                        <Button variant="ghost" className="btn-sm" onClick={() => setAsIncome(t)}>
                          Als sonstige Einnahme
                        </Button>
                        <Button
                          variant="ghost"
                          className="btn-sm"
                          busy={busy === `ig${t.id}`}
                          onClick={() =>
                            run(`ig${t.id}`, async () => {
                              await api.post(`/api/bank/transactions/${t.id}/ignore`);
                              reload();
                            })
                          }
                        >
                          Ignorieren
                        </Button>
                      </div>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {asIncome ? (
        <IncomeDialog
          tx={asIncome}
          onClose={() => setAsIncome(null)}
          onDone={() => {
            setAsIncome(null);
            reload();
          }}
        />
      ) : null}
      {unassign ? (
        <Confirm
          title="Zuordnung aufheben?"
          text="Die gebuchte Einnahme wird gelöscht, die Rechnung ist danach wieder offen. Die Zahlung erscheint wieder unter „Zu prüfen“."
          confirmLabel="Aufheben"
          danger
          busy={busy === "un"}
          onCancel={() => setUnassign(null)}
          onConfirm={() =>
            run(
              "un",
              async () => {
                await api.post(`/api/bank/transactions/${unassign.id}/unassign`);
                setUnassign(null);
                reload();
              },
              "Zuordnung aufgehoben",
            )
          }
        />
      ) : null}
    </>
  );
}

function DebitCell({ tx, onDone }: { tx: BankTx; onDone: () => void }) {
  const api = useApi();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const cats = settings.expenses.categories;
  const [category, setCategory] = useState("");
  const [rate, setRate] = useState(19);
  const supplier = tx.counterpartyName || tx.purpose?.slice(0, 60) || "";
  useEffect(() => {
    if (!supplier) return;
    let alive = true;
    api
      .get<{ category: string | null }>(`/api/expenses/suggest?supplier=${encodeURIComponent(supplier)}`)
      .then((r) => { if (alive && r.category) setCategory(r.category); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [api, supplier]);
  return (
    <div className="stack">
      <div className="suggest">
        <select className="assign-select" aria-label="Kategorie" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Kategorie wählen …</option>
          {cats.map((c) => <option key={c.name}>{c.name}</option>)}
        </select>
        <select aria-label="Steuersatz" value={rate} onChange={(e) => setRate(Number(e.target.value))}>
          <option value={19}>19 %</option>
          <option value={7}>7 %</option>
          <option value={0}>0 %</option>
        </select>
        <Button
          variant="primary"
          className="btn-sm"
          disabled={!category}
          busy={busy === "book"}
          onClick={() =>
            run("book", async () => {
              await api.post(`/api/bank/transactions/${tx.id}/expense`, { category, taxRate: rate, supplier: supplier || undefined, remember: true });
              onDone();
            }, `Als Ausgabe gebucht (${category})`)
          }
        >
          Buchen
        </Button>
      </div>
      <div className="suggest">
        <span className="muted small">Kategorie wird für {supplier ? `„${supplier.slice(0, 30)}“` : "diesen Empfänger"} gemerkt.</span>
        <Button
          variant="ghost"
          className="btn-sm"
          busy={busy === "ig"}
          onClick={() =>
            run("ig", async () => {
              await api.post(`/api/bank/transactions/${tx.id}/ignore`);
              onDone();
            })
          }
        >
          Ignorieren
        </Button>
      </div>
    </div>
  );
}

function IncomeDialog({ tx, onClose, onDone }: { tx: BankTx; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [category, setCategory] = useState("Sonstiges");
  const [description, setDescription] = useState([tx.counterpartyName, tx.purpose].filter(Boolean).join(" – ").slice(0, 200));
  return (
    <Modal
      title={`${money(tx.amount)} als Einnahme buchen`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            busy={busy === "save"}
            onClick={() =>
              run(
                "save",
                async () => {
                  await api.post(`/api/bank/transactions/${tx.id}/income`, { category, description });
                  onDone();
                },
                "Als Einnahme gebucht",
              )
            }
          >
            Buchen
          </Button>
        </>
      }
    >
      <div className="grid-2">
        <SelectField
          label="Kategorie"
          value={category}
          onChange={setCategory}
          options={["Sonstiges", "Barverkauf", "Anzahlung", "Provision", "Erstattung", "Gutschein"].map((c) => ({ value: c, label: c }))}
        />
        <div />
        <TextField label="Beschreibung" value={description} onChange={setDescription} span={2} />
      </div>
    </Modal>
  );
}
