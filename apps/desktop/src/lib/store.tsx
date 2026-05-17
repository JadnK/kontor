import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Api } from "./api";
import { errorMessage } from "./api";
import type { Profile } from "./connection";
import type { Settings, User } from "./types";

export type Route =
  | { name: "dashboard" }
  | { name: "customers" }
  | { name: "customer"; id: string }
  | { name: "products" }
  | { name: "discounts" }
  | { name: "invoices"; status?: string }
  | { name: "invoice"; id: string }
  | { name: "invoice-edit"; id?: string; customerId?: string }
  | { name: "quotes" }
  | { name: "quote"; id: string }
  | { name: "quote-edit"; id?: string; customerId?: string }
  | { name: "recurring" }
  | { name: "recurring-edit"; id?: string; customerId?: string }
  | { name: "income" }
  | { name: "time" }
  | { name: "expenses" }
  | { name: "reports" }
  | { name: "contracts" }
  | { name: "contract"; id: string }
  | { name: "contract-edit"; id?: string; customerId?: string }
  | { name: "bank" }
  | { name: "tickets"; view?: string }
  | { name: "ticket"; id: string }
  | { name: "mails" }
  | { name: "settings"; tab?: string };

export interface Session {
  profile: Profile;
  api: Api;
  user: User;
  settings: Settings;
  reloadSettings: () => Promise<void>;
  logout: () => void;
  switchServer: () => void;
}

interface Ctx {
  session: Session;
  route: Route;
  go: (r: Route) => void;
  back: () => void;
}

const AppCtx = createContext<Ctx | null>(null);

export function AppProvider({ value, children }: { value: Ctx; children: ReactNode }) {
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp außerhalb des Providers");
  return c;
}

export const useSession = () => useApp().session;
export const useApi = () => useApp().session.api;
export const useNav = () => {
  const { go, back, route } = useApp();
  return { go, back, route };
};

// ---------- Toasts ----------
export interface Toast {
  id: number;
  kind: "ok" | "error" | "info";
  text: string;
}
type ToastFn = (kind: Toast["kind"], text: string) => void;
const ToastCtx = createContext<ToastFn>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback<ToastFn>((kind, text) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastCtx);
  return {
    ok: (t: string) => push("ok", t),
    error: (e: unknown) => push("error", errorMessage(e)),
    info: (t: string) => push("info", t),
  };
}

// ---------- Daten laden ----------
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => alive && setError(errorMessage(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1), setData };
}

/** Hilfsfunktion für Aktionen mit Ladezustand und Fehler-Toast */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        if (success) toast.ok(success);
        return r;
      } catch (e) {
        toast.error(e);
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return { busy, run };
}
