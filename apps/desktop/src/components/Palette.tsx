import { useEffect, useMemo, useRef, useState } from "react";
import { useApi, useNav, type Route } from "../lib/store";
import { customerName, money } from "../lib/format";
import type { Customer, InvoiceListRow, TicketRow } from "../lib/types";
import { Icon, type IconName } from "./Icon";

interface Item {
  key: string;
  group: string;
  label: string;
  sub?: string;
  icon: IconName;
  route: Route;
}

const COMMANDS: Item[] = [
  { key: "c-new-inv", group: "Aktionen", label: "Neue Rechnung", sub: "Strg N", icon: "plus", route: { name: "invoice-edit" } },
  { key: "c-dash", group: "Seiten", label: "Übersicht", icon: "home", route: { name: "dashboard" } },
  { key: "c-inv", group: "Seiten", label: "Rechnungen", icon: "invoice", route: { name: "invoices" } },
  { key: "c-overdue", group: "Seiten", label: "Überfällige Rechnungen", icon: "invoice", route: { name: "invoices", status: "OVERDUE" } },
  { key: "c-tickets", group: "Seiten", label: "Tickets", icon: "ticket", route: { name: "tickets" } },
  { key: "c-cust", group: "Seiten", label: "Kunden", icon: "users", route: { name: "customers" } },
  { key: "c-prod", group: "Seiten", label: "Produkte", icon: "box", route: { name: "products" } },
  { key: "c-disc", group: "Seiten", label: "Rabatte", icon: "percent", route: { name: "discounts" } },
  { key: "c-inc", group: "Seiten", label: "Einnahmen", icon: "wallet", route: { name: "income" } },
  { key: "c-bank", group: "Seiten", label: "Zahlungsabgleich", icon: "bank", route: { name: "bank" } },
  { key: "c-set", group: "Seiten", label: "Einstellungen", icon: "settings", route: { name: "settings" } },
];

/** Schnellsuche über Kunden, Rechnungen, Tickets und Seiten (Strg+K) */
export function Palette({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const { go } = useNav();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [found, setFound] = useState<Item[]>([]);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setFound([]);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      const enc = encodeURIComponent(term);
      const [cs, is, ts] = await Promise.all([
        api.get<Customer[]>(`/api/customers?q=${enc}`).catch(() => [] as Customer[]),
        api.get<InvoiceListRow[]>(`/api/invoices?q=${enc}`).catch(() => [] as InvoiceListRow[]),
        api.get<TicketRow[]>(`/api/tickets?status=ALL&q=${enc}`).catch(() => [] as TicketRow[]),
      ]);
      if (!alive) return;
      setFound([
        ...cs.slice(0, 6).map((c): Item => ({ key: `k${c.id}`, group: "Kunden", label: customerName(c), sub: c.number, icon: "users", route: { name: "customer", id: c.id } })),
        ...is.slice(0, 6).map(
          (i): Item => ({ key: `r${i.id}`, group: "Rechnungen", label: `${i.number ?? "Entwurf"} – ${i.customerName}`, sub: money(i.totalGross), icon: "invoice", route: { name: "invoice", id: i.id } }),
        ),
        ...ts.slice(0, 6).map((t): Item => ({ key: `t${t.id}`, group: "Tickets", label: `${t.number} – ${t.subject}`, sub: t.contactEmail, icon: "ticket", route: { name: "ticket", id: t.id } })),
      ]);
      setSel(0);
    }, 180);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, api]);

  const items = useMemo(() => {
    const term = q.trim().toLowerCase();
    return [...found, ...COMMANDS.filter((c) => !term || c.label.toLowerCase().includes(term))];
  }, [q, found]);

  const pick = (i: Item | undefined) => {
    if (!i) return;
    onClose();
    go(i.route);
  };

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  let lastGroup = "";
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Schnellsuche">
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            value={q}
            placeholder="Kunde, Rechnungsnummer, Ticket oder Seite"
            aria-label="Suchbegriff"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(items.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") pick(items[sel]);
            }}
          />
        </div>
        <ul className="palette-list" ref={listRef} role="listbox" aria-label="Treffer">
          {items.length === 0 ? <li className="palette-group">Keine Treffer</li> : null}
          {items.map((it, idx) => {
            const head = it.group !== lastGroup ? <div className="palette-group">{it.group}</div> : null;
            lastGroup = it.group;
            return (
              <li key={it.key}>
                {head}
                <button className="palette-item" role="option" aria-selected={idx === sel} onMouseEnter={() => setSel(idx)} onClick={() => pick(it)}>
                  <Icon name={it.icon} />
                  {it.label}
                  {it.sub ? <span className="sub">{it.sub}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
