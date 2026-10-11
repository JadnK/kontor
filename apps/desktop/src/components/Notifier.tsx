import { useCallback, useEffect, useRef, useState } from "react";
import { useApi, useNav, type Route } from "../lib/store";
import { notify } from "../lib/native";
import { Icon } from "./Icon";

export type NotifyKind = "payment" | "ticket" | "ticketReply" | "quote";
interface FeedEvent {
  id: string;
  kind: NotifyKind;
  at: string;
  title: string;
  body: string;
  route: Route;
}
export interface NotifyPrefs {
  enabled: boolean;
  system: boolean;
  kinds: Record<NotifyKind, boolean>;
}

const KEY = "kontor.notify";
export const NOTIFY_LABELS: Record<NotifyKind, string> = {
  payment: "Zahlungseingänge",
  ticket: "Neue Tickets",
  ticketReply: "Antworten von Kunden",
  quote: "Angebot angenommen oder abgelehnt",
};
const DEFAULTS: NotifyPrefs = { enabled: true, system: true, kinds: { payment: true, ticket: true, ticketReply: true, quote: true } };

export function loadNotifyPrefs(): NotifyPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<NotifyPrefs> | null;
    return v ? { ...DEFAULTS, ...v, kinds: { ...DEFAULTS.kinds, ...(v.kinds ?? {}) } } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}
export function saveNotifyPrefs(p: NotifyPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* egal */
  }
  window.dispatchEvent(new Event("kontor:notify-prefs"));
}

/**
 * Fragt jede Minute neue Ereignisse ab. Ist das Fenster im Hintergrund, kommt eine Windows-Benachrichtigung,
 * sonst ein Hinweis unten rechts mit „Öffnen“.
 */
export function Notifier() {
  const api = useApi();
  const { go } = useNav();
  const [prefs, setPrefs] = useState(loadNotifyPrefs);
  const [items, setItems] = useState<FeedEvent[]>([]);
  const since = useRef<string | null>(null);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    const h = () => setPrefs(loadNotifyPrefs());
    window.addEventListener("kontor:notify-prefs", h);
    return () => window.removeEventListener("kontor:notify-prefs", h);
  }, []);

  const poll = useCallback(async () => {
    try {
      const q = since.current ? `?since=${encodeURIComponent(since.current)}` : "";
      const r = await api.get<{ now: string; events: FeedEvent[] }>(`/api/notifications/feed${q}`);
      since.current = r.now;
      const p = loadNotifyPrefs();
      if (!p.enabled) return;
      const fresh = r.events.filter((e) => !seen.current.has(e.id) && p.kinds[e.kind]);
      fresh.forEach((e) => seen.current.add(e.id));
      if (!fresh.length) return;
      const background = document.hidden || !document.hasFocus();
      if (background && p.system) {
        if (fresh.length > 3) await notify(`${fresh.length} Neuigkeiten in Kontor`, fresh.slice(0, 3).map((e) => e.title).join("\n"));
        else for (const e of fresh) await notify(e.title, e.body);
      }
      setItems((x) => [...x, ...fresh].slice(-5));
    } catch {
      /* Server kurz nicht erreichbar – beim nächsten Mal */
    }
  }, [api]);

  useEffect(() => {
    void poll();
    const t = setInterval(() => void poll(), 60_000);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [poll]);

  if (!prefs.enabled || !items.length) return null;
  return (
    <div className="notify-stack" role="status" aria-live="polite">
      {items.map((e) => (
        <div key={e.id} className={`notify notify-${e.kind}`}>
          <Icon name={e.kind === "payment" ? "wallet" : e.kind === "quote" ? "quote" : "ticket"} />
          <div className="notify-text">
            <strong>{e.title}</strong>
            <span>{e.body}</span>
          </div>
          <div className="notify-actions">
            <button
              className="link"
              onClick={() => {
                go(e.route);
                setItems((x) => x.filter((y) => y.id !== e.id));
              }}
            >
              Öffnen
            </button>
            <button className="icon-btn" aria-label="Schließen" onClick={() => setItems((x) => x.filter((y) => y.id !== e.id))}>
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
