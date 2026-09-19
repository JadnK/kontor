import { useState } from "react";
import { useAction, useApi, useLoad, useNav, useSession, useToast } from "../lib/store";
import { date, money, num, todayIso } from "../lib/format";
import { saveFile } from "../lib/native";
import type { ReportSummary } from "../lib/types";
import { Button, ErrorBox, Loading, PageHeader, Section } from "../components/ui";
import { Icon } from "../components/Icon";

const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
type Period = "year" | "q1" | "q2" | "q3" | "q4" | "custom";

function rangeOf(year: string, p: Period, from: string, to: string) {
  if (p === "custom") return { from, to };
  if (p === "year") return { from: `${year}-01-01`, to: `${year}-12-31` };
  const q = Number(p.slice(1));
  const start = String((q - 1) * 3 + 1).padStart(2, "0");
  const endMonth = q * 3;
  const last = new Date(Date.UTC(Number(year), endMonth, 0)).getUTCDate();
  return { from: `${year}-${start}-01`, to: `${year}-${String(endMonth).padStart(2, "0")}-${last}` };
}

export function Reports() {
  const api = useApi();
  const toast = useToast();
  const { go } = useNav();
  const { settings } = useSession();
  const { busy, run } = useAction();
  const year0 = todayIso().slice(0, 4);
  const [year, setYear] = useState(year0);
  const [period, setPeriod] = useState<Period>("year");
  const [cFrom, setCFrom] = useState(`${year0}-01-01`);
  const [cTo, setCTo] = useState(todayIso());
  const r = rangeOf(year, period, cFrom, cTo);
  const qs = new URLSearchParams(r).toString();
  const { data, error, loading, reload } = useLoad(() => api.get<ReportSummary>(`/api/reports/summary?${qs}`), [qs]);
  const years = Array.from({ length: 6 }, (_, i) => String(Number(year0) - i));
  const datevReady = !!settings.datev.consultantNumber && !!settings.datev.clientNumber;

  const download = (kind: "journal" | "datev") =>
    run(kind, async () => {
      const f = await api.download(kind === "journal" ? `/api/reports/journal.csv?${qs}` : `/api/reports/datev?${qs}`);
      const path = await saveFile(f.blob, f.filename);
      if (path) toast.ok(`Gespeichert: ${path}`);
    });

  return (
    <>
      <PageHeader
        title="Auswertung"
        sub="Einnahmen-Überschuss-Rechnung, Umsatzsteuer und Export für die Steuerberatung. Grundlage sind die erfassten Einnahmen und Ausgaben (Zuflussprinzip)."
        actions={
          <>
            <Button busy={busy === "journal"} onClick={() => download("journal")}><Icon name="download" /> Journal (CSV)</Button>
            <Button
              busy={busy === "datev"}
              onClick={() => (datevReady ? download("datev") : go({ name: "settings", tab: "datev" }))}
              title={datevReady ? "DATEV-Buchungsstapel (EXTF) herunterladen" : "Erst Berater- und Mandantennummer eintragen"}
            >
              <Icon name="download" /> DATEV-Export
            </Button>
          </>
        }
      />

      <div className="toolbar">
        <select value={year} onChange={(e) => setYear(e.target.value)} aria-label="Jahr" disabled={period === "custom"}>
          {years.map((y) => <option key={y}>{y}</option>)}
        </select>
        <div className="segmented" role="group" aria-label="Zeitraum">
          {(["year", "q1", "q2", "q3", "q4", "custom"] as Period[]).map((p) => (
            <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)}>
              {p === "year" ? "Jahr" : p === "custom" ? "Frei" : p.toUpperCase()}
            </button>
          ))}
        </div>
        {period === "custom" ? (
          <>
            <input type="date" value={cFrom} onChange={(e) => setCFrom(e.target.value)} aria-label="Von" />
            <span className="muted">bis</span>
            <input type="date" value={cTo} onChange={(e) => setCTo(e.target.value)} aria-label="Bis" />
          </>
        ) : null}
      </div>

      {!datevReady ? (
        <div className="hint hint-info" style={{ marginBottom: 16 }}>
          Für den DATEV-Export fehlen Berater- und Mandantennummer.{" "}
          <button className="link" onClick={() => go({ name: "settings", tab: "datev" })}>Jetzt eintragen</button>
        </div>
      ) : null}

      {loading && !data ? <Loading /> : error || !data ? <ErrorBox error={error ?? "Keine Daten"} onRetry={reload} /> : <ReportBody d={data} />}
    </>
  );
}

function ReportBody({ d }: { d: ReportSummary }) {
  const small = d.smallBusiness;
  const months = allMonths(d);
  const max = Math.max(1, ...months.map((m) => Math.max(m.income, m.expenses)));
  const ku = d.smallBusinessCheck;
  return (
    <>
      <p className="muted" style={{ margin: "0 0 14px" }}>
        {date(d.from)} – {date(d.to)} · {num(d.counts.incomes)} Einnahmen, {num(d.counts.expenses)} Ausgaben
      </p>
      <div className="figures">
        <div className="figure">
          <span className="figure-label">Betriebseinnahmen</span>
          <span className="figure-value">{money(small ? d.incomeGross : d.incomeNet)}</span>
          <span className="figure-note">{small ? "Kleinunternehmer, ohne USt" : `netto · brutto ${money(d.incomeGross)}`}</span>
        </div>
        <div className="figure">
          <span className="figure-label">Betriebsausgaben</span>
          <span className="figure-value">{money(d.expensesDeductible)}</span>
          <span className="figure-note">{small ? "absetzbar, brutto" : `absetzbar, netto · brutto ${money(d.expensesGross)}`}</span>
        </div>
        <div className={`figure ${d.profit < 0 ? "figure-alert" : ""}`}>
          <span className="figure-label">{d.profit < 0 ? "Verlust" : "Gewinn"}</span>
          <span className="figure-value">{money(d.profit)}</span>
          <span className="figure-note">Einnahmen minus Ausgaben</span>
        </div>
        {small ? (
          <div className="figure">
            <span className="figure-label">Offene Forderungen</span>
            <span className="figure-value">{money(d.openReceivables)}</span>
            <span className="figure-note">heute, noch nicht eingenommen</span>
          </div>
        ) : (
          <div className={`figure ${d.vatPayable > 0 ? "" : ""}`}>
            <span className="figure-label">{d.vatPayable < 0 ? "USt-Erstattung" : "USt-Zahllast"}</span>
            <span className="figure-value">{money(Math.abs(d.vatPayable))}</span>
            <span className="figure-note">USt {money(d.vatCollected)} − VSt {money(d.inputTax)}</span>
          </div>
        )}
      </div>

      <div className="dash-grid" style={{ marginTop: 24 }}>
        <Section title="Verlauf">
          <div className="chart">
            <div className="chart-head">
              <span><i className="legend legend-in" /> Einnahmen <i className="legend legend-out" /> Ausgaben</span>
              <strong>{money(max)}</strong>
            </div>
            <div className="bars" style={{ gridTemplateColumns: `repeat(${Math.max(1, months.length)}, 1fr)` }} role="img" aria-label="Einnahmen und Ausgaben je Monat">
              {months.map((m) => {
                const mm = Number(m.month.slice(5, 7));
                return (
                  <div className="bar-col" key={m.month} title={`${MONTHS[mm - 1]} ${m.month.slice(0, 4)}: Einnahmen ${money(m.income)}, Ausgaben ${money(m.expenses)}`}>
                    <div className="bar-track bar-pair">
                      <div className="bar bar-in" style={{ height: `${(m.income / max) * 100}%` }} />
                      <div className="bar bar-out" style={{ height: `${(m.expenses / max) * 100}%` }} />
                    </div>
                    <span>{MONTHS[mm - 1]}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </Section>

        <Section title="Kleinunternehmergrenze">
          <div className="ku-box">
            <LimitBar label={`Umsatz ${ku.year - 1}`} value={ku.previousYear} limit={ku.limitPrevious} />
            <LimitBar label={`Umsatz ${ku.year} bisher`} value={ku.currentYear} limit={ku.limitCurrent} />
            <LimitBar label={`${ku.year} hochgerechnet`} value={ku.projected} limit={ku.limitPrevious} note="zählt für nächstes Jahr" />
            <p className="muted small" style={{ margin: "10px 0 0" }}>
              {small
                ? ku.eligible
                  ? ku.nextYearEligible
                    ? "Du liegst unter beiden Grenzen. Die Kleinunternehmerregelung passt."
                    : `Hochgerechnet überschreitest du ${money(ku.limitPrevious)} – ab ${ku.year + 1} musst du voraussichtlich Umsatzsteuer ausweisen.`
                  : `Grenze überschritten. Ab dem Umsatz, der ${money(ku.limitCurrent)} übersteigt, gilt die Regelbesteuerung – sprich mit deiner Steuerberatung.`
                : ku.eligible
                  ? "Du weist Umsatzsteuer aus. Nach den Umsätzen könntest du die Kleinunternehmerregelung nutzen."
                  : "Du weist Umsatzsteuer aus (Regelbesteuerung)."}
            </p>
          </div>
        </Section>
      </div>

      {!small ? (
        <Section title="Umsatzsteuer je Quartal">
          <table className="table compact">
            <thead><tr><th>Quartal</th><th className="num">Umsatzsteuer</th><th className="num">Vorsteuer</th><th className="num">Zahllast</th></tr></thead>
            <tbody>
              {d.quarters.map((q) => (
                <tr key={q.quarter}>
                  <td>Q{q.quarter}</td>
                  <td className="num">{money(q.vat)}</td>
                  <td className="num">{money(q.inputTax)}</td>
                  <td className={`num strong ${q.payable < 0 ? "text-ok" : ""}`}>{money(q.payable)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td>Summe</td><td className="num">{money(d.vatCollected)}</td><td className="num">{money(d.inputTax)}</td><td className="num strong">{money(d.vatPayable)}</td></tr></tfoot>
          </table>
          <p className="muted small" style={{ marginTop: 8 }}>Vorschau zur Kontrolle. Die Voranmeldung selbst läuft weiter über ELSTER oder deine Steuerberatung.</p>
        </Section>
      ) : null}

      <div className="dash-grid">
        <Section title="Einnahmen">
          {d.incomeByCategory.length === 0 ? <p className="muted">Keine Einnahmen im Zeitraum.</p> : (
            <table className="table compact">
              <thead><tr><th>Kategorie</th><th className="num">Betrag</th></tr></thead>
              <tbody>{d.incomeByCategory.map((c) => <tr key={c.category}><td>{c.category}</td><td className="num">{money(c.amount)}</td></tr>)}</tbody>
            </table>
          )}
          {!small && d.incomeByRate.length ? (
            <table className="table compact" style={{ marginTop: 14 }}>
              <thead><tr><th>Steuersatz</th><th className="num">Netto</th><th className="num">USt</th></tr></thead>
              <tbody>{d.incomeByRate.map((x) => <tr key={x.rate}><td>{num(x.rate)} %</td><td className="num">{money(x.net)}</td><td className="num">{money(x.tax)}</td></tr>)}</tbody>
            </table>
          ) : null}
        </Section>
        <Section title="Ausgaben nach Kategorie">
          {d.expensesByCategory.length === 0 ? <p className="muted">Keine Ausgaben im Zeitraum.</p> : (
            <table className="table compact">
              <thead><tr><th>Kategorie</th><th className="num">Anzahl</th><th className="num">Brutto</th>{small ? null : <th className="num">VSt</th>}<th className="num">absetzbar</th></tr></thead>
              <tbody>
                {d.expensesByCategory.map((c) => (
                  <tr key={c.category}>
                    <td>{c.category}</td>
                    <td className="num muted">{c.count}</td>
                    <td className="num">{money(c.gross)}</td>
                    {small ? null : <td className="num">{money(c.tax)}</td>}
                    <td className="num strong">{money(c.deductible)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>
    </>
  );
}

/** Alle Monate des Zeitraums, auch ohne Buchungen */
function allMonths(d: ReportSummary) {
  const have = new Map(d.months.map((m) => [m.month, m]));
  const out: ReportSummary["months"] = [];
  let y = Number(d.from.slice(0, 4));
  let m = Number(d.from.slice(5, 7));
  const endY = Number(d.to.slice(0, 4));
  const endM = Number(d.to.slice(5, 7));
  while ((y < endY || (y === endY && m <= endM)) && out.length < 36) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(have.get(key) ?? { month: key, income: 0, expenses: 0, vat: 0, inputTax: 0 });
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

function LimitBar({ label, value, limit, note }: { label: string; value: number; limit: number; note?: string }) {
  const pct = Math.min(100, (value / Math.max(1, limit)) * 100);
  const cls = value > limit ? "over" : pct > 80 ? "warn" : "";
  return (
    <div className="limit">
      <div className="limit-head">
        <span>{label}{note ? <span className="muted"> · {note}</span> : null}</span>
        <span><strong>{money(value)}</strong> <span className="muted">von {money(limit)}</span></span>
      </div>
      <div className={`budget-bar ${cls}`}><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
