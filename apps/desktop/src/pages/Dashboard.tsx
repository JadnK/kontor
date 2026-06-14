import { useApi, useLoad, useNav, useSession } from "../lib/store";
import { date, money } from "../lib/format";
import { Button, ErrorBox, Loading, PageHeader, Section } from "../components/ui";
import { Icon } from "../components/Icon";

interface Dash {
  open: { n: number; sum: number };
  overdue: { n: number; sum: number };
  incomeYear: number;
  incomeMonth: number;
  drafts: number;
  customers: number;
  failedMails: number;
  bankPending: number;
  tickets: { open: number; unread: number; pending: number };
  recentIncome: { id: string; date: string; amount: number; description: string | null }[];
  months: { m: string; total: number }[];
  dueInvoices: { id: string; number: string; dueDate: string | null; open: number; overdue: boolean; reminderCount: number; customerName: string }[];
}

const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

function last12(): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 11; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

function dueLabel(iso: string | null, overdue: boolean) {
  if (!iso) return "";
  const days = Math.round((new Date(`${iso}T12:00:00`).getTime() - Date.now()) / 86_400_000);
  if (overdue) return `${Math.abs(days)} Tage überfällig`;
  if (days === 0) return "heute fällig";
  if (days === 1) return "morgen fällig";
  return `fällig am ${date(iso)}`;
}

export function Dashboard() {
  const api = useApi();
  const { go } = useNav();
  const { settings, user } = useSession();
  const { data, error, loading, reload } = useLoad(() => api.get<Dash>("/api/dashboard"), []);

  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox error={error ?? "Keine Daten"} onRetry={reload} />;

  const months = last12().map((m) => ({ m, total: data.months.find((x) => x.m === m)?.total ?? 0 }));
  const max = Math.max(1, ...months.map((m) => m.total));
  const sum12 = months.reduce((a, m) => a + m.total, 0);
  const missingCompany = !settings.company.name || !settings.company.street || !settings.company.iban;
  const mailOff = !settings.mail.enabled || !settings.mail.host;
  const admin = user.role === "ADMIN";

  const hints = [
    data.tickets.unread > 0 && (
      <div className="hint hint-info" key="t">
        <span>{data.tickets.unread === 1 ? "1 neues Ticket wartet" : `${data.tickets.unread} neue Tickets warten`} auf eine Antwort.</span>
        <Button variant="ghost" onClick={() => go({ name: "tickets" })}>
          Tickets öffnen
        </Button>
      </div>
    ),
    data.bankPending > 0 && (
      <div className="hint hint-info" key="b">
        <span>{data.bankPending === 1 ? "1 Zahlungseingang ist" : `${data.bankPending} Zahlungseingänge sind`} noch keiner Rechnung zugeordnet.</span>
        <Button variant="ghost" onClick={() => go({ name: "bank" })}>
          Zuordnen
        </Button>
      </div>
    ),
    data.failedMails > 0 && (
      <div className="hint hint-danger" key="m">
        <span>{data.failedMails} E-Mail(s) konnten in den letzten 7 Tagen nicht zugestellt werden.</span>
        <Button variant="ghost" onClick={() => go({ name: "mails" })}>
          Protokoll ansehen
        </Button>
      </div>
    ),
    missingCompany && (
      <div className="hint" key="c">
        <span>Firmendaten sind unvollständig – Anschrift und Bankverbindung stehen auf jeder Rechnung.</span>
        {admin ? (
          <Button variant="ghost" onClick={() => go({ name: "settings", tab: "company" })}>
            Firmendaten ergänzen
          </Button>
        ) : null}
      </div>
    ),
    mailOff && (
      <div className="hint" key="o">
        <span>E-Mail-Versand ist aus. Rechnungen, Erinnerungen und Rabatte gehen nicht automatisch raus.</span>
        {admin ? (
          <Button variant="ghost" onClick={() => go({ name: "settings", tab: "mail" })}>
            E-Mail einrichten
          </Button>
        ) : null}
      </div>
    ),
  ].filter(Boolean);

  return (
    <>
      <PageHeader
        title="Übersicht"
        actions={
          <>
            <Button onClick={() => go({ name: "bank" })}>
              <Icon name="upload" /> Kontoauszug einlesen
            </Button>
            <Button variant="primary" onClick={() => go({ name: "invoice-edit" })}>
              <Icon name="plus" /> Neue Rechnung
            </Button>
          </>
        }
      />

      {hints.length ? <div className="hints">{hints}</div> : null}

      <div className="figures">
        <button className="figure" onClick={() => go({ name: "invoices", status: "ISSUED" })}>
          <span className="figure-label">Offene Forderungen</span>
          <span className="figure-value">{money(data.open.sum)}</span>
          <span className="figure-note">{data.open.n === 1 ? "1 Rechnung" : `${data.open.n} Rechnungen`}</span>
        </button>
        <button className={`figure ${data.overdue.n ? "figure-alert" : ""}`} onClick={() => go({ name: "invoices", status: "OVERDUE" })}>
          <span className="figure-label">Davon überfällig</span>
          <span className="figure-value">{money(data.overdue.sum)}</span>
          <span className="figure-note">{data.overdue.n === 1 ? "1 Rechnung" : `${data.overdue.n} Rechnungen`}</span>
        </button>
        <button className="figure" onClick={() => go({ name: "income" })}>
          <span className="figure-label">Eingenommen im {MONTHS[new Date().getMonth()]}</span>
          <span className="figure-value">{money(data.incomeMonth)}</span>
          <span className="figure-note">laufender Monat</span>
        </button>
        <button className="figure" onClick={() => go({ name: "tickets" })}>
          <span className="figure-label">Offene Tickets</span>
          <span className="figure-value">{data.tickets.open}</span>
          <span className="figure-note">{data.tickets.pending ? `${data.tickets.pending} warten auf Kunden` : "keine wartenden"}</span>
        </button>
      </div>

      <div className="dash-grid">
        <Section title="Einnahmen der letzten 12 Monate">
          <div className="chart">
            <div className="chart-head">
              <span>
                Summe <strong>{money(sum12)}</strong>
              </span>
              <span>
                {new Date().getFullYear()} bisher <strong>{money(data.incomeYear)}</strong>
              </span>
            </div>
            <div className="bars" role="img" aria-label="Balkendiagramm der Einnahmen je Monat">
              {months.map((m) => {
                const mm = Number(m.m.split("-")[1]);
                return (
                  <div className="bar-col" key={m.m} title={`${MONTHS[mm - 1]} ${m.m.slice(0, 4)}: ${money(m.total)}`}>
                    <div className="bar-track">
                      <div className="bar" style={{ height: `${(m.total / max) * 100}%` }} />
                    </div>
                    <span>{MONTHS[mm - 1]}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </Section>

        <Section
          title="Fällig als Nächstes"
          aside={
            <Button variant="ghost" onClick={() => go({ name: "invoices", status: "ISSUED" })}>
              Alle offenen
            </Button>
          }
        >
          {data.dueInvoices.length === 0 ? (
            <p className="muted">Keine offenen Rechnungen.</p>
          ) : (
            <ul className="due-list">
              {data.dueInvoices.map((d) => (
                <li key={d.id}>
                  <button onClick={() => go({ name: "invoice", id: d.id })}>
                    <span>
                      <strong>{d.customerName}</strong>
                      <div className="sub">
                        {d.number}
                        {d.reminderCount ? `, ${d.reminderCount}× erinnert` : ""}
                      </div>
                    </span>
                    <span>
                      <div className="due-amount">{money(d.open)}</div>
                      <div className={`sub ${d.overdue ? "text-danger" : ""}`} style={{ textAlign: "right" }}>
                        {dueLabel(d.dueDate, d.overdue)}
                      </div>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="dash-grid">
        <Section
          title="Letzte Zahlungseingänge"
          aside={
            <Button variant="ghost" onClick={() => go({ name: "income" })}>
              Alle Einnahmen
            </Button>
          }
        >
          {data.recentIncome.length === 0 ? (
            <p className="muted">Noch keine Einnahmen erfasst.</p>
          ) : (
            <table className="table compact">
              <tbody>
                {data.recentIncome.map((i) => (
                  <tr key={i.id}>
                    <td className="nowrap muted">{date(i.date)}</td>
                    <td>{i.description}</td>
                    <td className="num strong">{money(i.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
        <Section title="Bestand">
          <dl className="facts">
            <div>
              <dt>Aktive Kunden</dt>
              <dd>
                <button className="link" onClick={() => go({ name: "customers" })}>
                  {data.customers}
                </button>
              </dd>
            </div>
            <div>
              <dt>Rechnungsentwürfe</dt>
              <dd>
                <button className="link" onClick={() => go({ name: "invoices", status: "DRAFT" })}>
                  {data.drafts}
                </button>
              </dd>
            </div>
            <div>
              <dt>Einnahmen {new Date().getFullYear()}</dt>
              <dd>{money(data.incomeYear)}</dd>
            </div>
          </dl>
        </Section>
      </div>
    </>
  );
}
