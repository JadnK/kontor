import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useApp, type Route } from "../lib/store";
import { useTheme, type ThemeMode } from "../lib/theme";
import { Icon, type IconName } from "./Icon";
import { Palette } from "./Palette";
import { TimerWidget } from "./TimeTracking";
import { Notifier } from "./Notifier";

interface Counts {
  tickets: number;
  bank: number;
  overdue: number;
  quotes: number;
}

const NAV: { route: Route; label: string; icon: IconName; match: Route["name"][]; count?: keyof Counts; group?: string }[] = [
  { route: { name: "dashboard" }, label: "Übersicht", icon: "home", match: ["dashboard"] },
  { route: { name: "invoices" }, label: "Rechnungen", icon: "invoice", match: ["invoices", "invoice", "invoice-edit"], count: "overdue" },
  { route: { name: "quotes" }, label: "Angebote", icon: "quote", match: ["quotes", "quote", "quote-edit"], count: "quotes" },
  { route: { name: "tickets" }, label: "Tickets", icon: "ticket", match: ["tickets", "ticket"], count: "tickets" },
  { route: { name: "customers" }, label: "Kunden", icon: "users", match: ["customers", "customer"] },
  { route: { name: "time" }, label: "Zeiterfassung", icon: "clock", match: ["time"] },
  { route: { name: "products" }, label: "Produkte", icon: "box", match: ["products"], group: "Stammdaten" },
  { route: { name: "discounts" }, label: "Rabatte", icon: "percent", match: ["discounts"] },
  { route: { name: "contracts" }, label: "Verträge", icon: "contract", match: ["contracts", "contract", "contract-edit"] },
  { route: { name: "recurring" }, label: "Abo-Rechnungen", icon: "repeat", match: ["recurring", "recurring-edit"] },
  { route: { name: "income" }, label: "Einnahmen", icon: "wallet", match: ["income"], group: "Finanzen" },
  { route: { name: "expenses" }, label: "Ausgaben", icon: "receipt", match: ["expenses"] },
  { route: { name: "bank" }, label: "Zahlungsabgleich", icon: "bank", match: ["bank"], count: "bank" },
  { route: { name: "reports" }, label: "Auswertung", icon: "chart", match: ["reports"] },
  { route: { name: "mails" }, label: "E-Mail-Protokoll", icon: "mail", match: ["mails"] },
];

const COUNT_TITLE: Record<keyof Counts, string> = {
  overdue: "überfällige Rechnungen",
  bank: "offene Zahlungseingänge",
  tickets: "ungelesene Tickets",
  quotes: "angenommene Angebote ohne Rechnung",
};

const THEMES: { mode: ThemeMode; icon: IconName; label: string }[] = [
  { mode: "light", icon: "sun", label: "Hell" },
  { mode: "system", icon: "monitor", label: "Wie System" },
  { mode: "dark", icon: "moon", label: "Dunkel" },
];

export function ThemeSwitch({ className = "theme-switch" }: { className?: string }) {
  const [mode, setMode] = useTheme();
  return (
    <div className={className} role="group" aria-label="Darstellung">
      {THEMES.map((t) => (
        <button key={t.mode} aria-pressed={mode === t.mode} title={t.label} aria-label={t.label} onClick={() => setMode(t.mode)}>
          <Icon name={t.icon} />
        </button>
      ))}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { session, route, go } = useApp();
  const [menu, setMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const [counts, setCounts] = useState<Counts>({ tickets: 0, bank: 0, overdue: 0, quotes: 0 });
  const host = session.profile.url.replace(/^https?:\/\//, "");

  const loadCounts = useCallback(async () => {
    try {
      const d = await session.api.get<{ overdue: { n: number }; bankPending: number; tickets: { unread: number }; quotes?: { accepted: number } }>("/api/dashboard");
      setCounts({ tickets: d.tickets?.unread ?? 0, bank: d.bankPending ?? 0, overdue: d.overdue?.n ?? 0, quotes: d.quotes?.accepted ?? 0 });
    } catch {
      /* Zähler sind nicht kritisch */
    }
  }, [session.api]);

  // Zähler bei jedem Seitenwechsel und jede Minute aktualisieren
  useEffect(() => {
    void loadCounts();
  }, [route, loadCounts]);
  useEffect(() => {
    const t = setInterval(loadCounts, 60_000);
    return () => clearInterval(t);
  }, [loadCounts]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (mod && e.key.toLowerCase() === "n" && !e.shiftKey) {
        e.preventDefault();
        go({ name: "invoice-edit" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            K
          </span>
          <div className="brand-text">
            <strong>{session.settings.company.name || "Kontor"}</strong>
            <span>{host}</span>
          </div>
        </div>
        <button className="search-trigger" onClick={() => setPalette(true)}>
          <Icon name="search" />
          Suchen
          <kbd>Strg K</kbd>
        </button>
        <nav className="nav" aria-label="Hauptnavigation">
          {NAV.map((n) => {
            const active = n.match.includes(route.name);
            const c = n.count ? counts[n.count] : 0;
            return (
              <div key={n.label} style={{ display: "contents" }}>
                {n.group ? <div className="nav-group">{n.group}</div> : null}
                <button className={active ? "active" : ""} onClick={() => go(n.route)} aria-current={active ? "page" : undefined}>
                  <Icon name={n.icon} />
                  {n.label}
                  {n.count && c > 0 ? (
                    <span className={`nav-badge ${n.count === "bank" || n.count === "quotes" ? "quiet" : ""}`} title={`${c} ${COUNT_TITLE[n.count]}`}>
                      {c}
                    </span>
                  ) : null}
                </button>
              </div>
            );
          })}
        </nav>
        <TimerWidget />
        <Notifier />
        <div className="nav-bottom">
          <button className={route.name === "settings" ? "active" : ""} onClick={() => go({ name: "settings" })}>
            <Icon name="settings" />
            Einstellungen
          </button>
          <ThemeSwitch />
          <div className="user-box">
            <button className="user-btn" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
              <span className="avatar" aria-hidden>
                {session.user.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="user-name">
                {session.user.name}
                <small>{session.user.role === "ADMIN" ? "Administrator" : "Mitarbeiter"}</small>
              </span>
            </button>
            {menu ? (
              <div className="user-menu" onMouseLeave={() => setMenu(false)}>
                <button
                  onClick={() => {
                    setMenu(false);
                    go({ name: "settings", tab: "account" });
                  }}
                >
                  Mein Konto
                </button>
                <button onClick={session.switchServer}>Server wechseln</button>
                <button onClick={session.logout}>Abmelden</button>
              </div>
            ) : null}
          </div>
        </div>
      </aside>
      <main className="content">{children}</main>
      {palette ? <Palette onClose={() => setPalette(false)} /> : null}
    </div>
  );
}
