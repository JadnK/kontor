import { useCallback, useEffect, useMemo, useState } from "react";
import { Api, errorMessage } from "./lib/api";
import {
  applyPreset,
  discover,
  getActiveId,
  loadProfiles,
  readPreset,
  setActiveId,
  upsertProfile,
  type Preset,
  type Profile,
} from "./lib/connection";
import { AppProvider, type Route, type Session } from "./lib/store";
import type { Settings, User } from "./lib/types";
import { Layout } from "./components/Layout";
import { Loading } from "./components/ui";
import { Connect } from "./pages/Connect";
import { Dashboard } from "./pages/Dashboard";
import { Customers } from "./pages/Customers";
import { CustomerDetail } from "./pages/CustomerDetail";
import { Products } from "./pages/Products";
import { Discounts } from "./pages/Discounts";
import { Invoices } from "./pages/Invoices";
import { InvoiceDetail } from "./pages/InvoiceDetail";
import { InvoiceEditor, QuoteEditor, RecurringEditor } from "./pages/InvoiceEditor";
import { Quotes } from "./pages/Quotes";
import { QuoteDetail } from "./pages/QuoteDetail";
import { Recurring } from "./pages/Recurring";
import { Income } from "./pages/Income";
import { TimePage } from "./pages/Time";
import { Expenses } from "./pages/Expenses";
import { Reports } from "./pages/Reports";
import { ContractDetail, ContractEditor, Contracts } from "./pages/Contracts";
import { MailLog } from "./pages/MailLog";
import { SettingsPage } from "./pages/Settings";
import { Bank } from "./pages/Bank";
import { Tickets } from "./pages/Tickets";
import { TicketDetail } from "./pages/TicketDetail";

interface Live {
  profile: Profile;
  api: Api;
  user: User;
  settings: Settings;
}

/** Verbindung prüfen und Sitzung aufbauen. Wirft bei Instanz-Wechsel oder abgelaufener Sitzung. */
export async function openSession(profile: Profile): Promise<Live> {
  const { url, info } = await discover(profile.url);
  if (profile.instanceId && profile.instanceId !== info.instanceId) {
    throw new Error(
      `Unter ${url} läuft inzwischen ein anderer Kontor-Server als beim letzten Mal. Aus Sicherheitsgründen wurde nicht angemeldet. Entferne die Verbindung und richte sie neu ein, wenn das so gewollt ist.`,
    );
  }
  const api = new Api(url, profile.token);
  const user = await api.get<User>("/api/auth/me");
  const settings = await api.get<Settings>("/api/settings");
  const updated = { ...profile, url, instanceId: info.instanceId, name: info.name || profile.name };
  upsertProfile(updated);
  return { profile: updated, api, user, settings };
}

export function App() {
  const [live, setLive] = useState<Live | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [history, setHistory] = useState<Route[]>([{ name: "dashboard" }]);

  useEffect(() => {
    (async () => {
      const p = await readPreset();
      if (p) {
        applyPreset(p);
        setPreset(p);
      }
      const active = loadProfiles().find((x) => x.id === getActiveId());
      if (active?.token) {
        try {
          setLive(await openSession(active));
        } catch (e) {
          setBootError(errorMessage(e));
        }
      }
      setBooting(false);
    })();
  }, []);

  const logout = useCallback(async () => {
    if (!live) return;
    try {
      await live.api.post("/api/auth/logout");
    } catch {
      /* egal, Token wird lokal verworfen */
    }
    upsertProfile({ ...live.profile, token: null });
    setLive(null);
    setHistory([{ name: "dashboard" }]);
  }, [live]);

  const switchServer = useCallback(() => {
    setActiveId(null);
    setLive(null);
    setHistory([{ name: "dashboard" }]);
  }, []);

  useEffect(() => {
    if (!live) return;
    live.api.setUnauthorizedHandler(() => {
      upsertProfile({ ...live.profile, token: null });
      setBootError("Deine Sitzung ist abgelaufen. Bitte erneut anmelden.");
      setLive(null);
    });
  }, [live]);

  const session: Session | null = useMemo(
    () =>
      live
        ? {
            ...live,
            logout,
            switchServer,
            reloadSettings: async () => {
              const settings = await live.api.get<Settings>("/api/settings");
              setLive((l) => (l ? { ...l, settings } : l));
            },
          }
        : null,
    [live, logout, switchServer],
  );

  if (booting) return <div className="boot"><Loading /></div>;

  if (!session) {
    return (
      <Connect
        preset={preset}
        notice={bootError}
        onReady={(l) => {
          setActiveId(l.profile.id);
          setBootError(null);
          setLive(l);
        }}
      />
    );
  }

  const route = history[history.length - 1];
  const go = (r: Route) => setHistory((h) => [...h.slice(-30), r]);
  const back = () => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));

  return (
    <AppProvider value={{ session, route, go, back }}>
      <Layout>
        <Page route={route} />
      </Layout>
    </AppProvider>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case "dashboard":
      return <Dashboard />;
    case "customers":
      return <Customers />;
    case "customer":
      return <CustomerDetail id={route.id} key={route.id} />;
    case "products":
      return <Products />;
    case "discounts":
      return <Discounts />;
    case "invoices":
      return <Invoices initialStatus={route.status} />;
    case "invoice":
      return <InvoiceDetail id={route.id} key={route.id} />;
    case "invoice-edit":
      return <InvoiceEditor id={route.id} customerId={route.customerId} key={route.id ?? "new"} />;
    case "quotes":
      return <Quotes />;
    case "quote":
      return <QuoteDetail id={route.id} key={route.id} />;
    case "quote-edit":
      return <QuoteEditor id={route.id} customerId={route.customerId} key={route.id ?? "new"} />;
    case "recurring":
      return <Recurring />;
    case "recurring-edit":
      return <RecurringEditor id={route.id} customerId={route.customerId} key={route.id ?? "new"} />;
    case "income":
      return <Income />;
    case "time":
      return <TimePage />;
    case "expenses":
      return <Expenses />;
    case "reports":
      return <Reports />;
    case "contracts":
      return <Contracts />;
    case "contract":
      return <ContractDetail id={route.id} key={route.id} />;
    case "contract-edit":
      return <ContractEditor id={route.id} customerId={route.customerId} key={route.id ?? "new"} />;
    case "bank":
      return <Bank />;
    case "tickets":
      return <Tickets initialView={route.view} />;
    case "ticket":
      return <TicketDetail id={route.id} key={route.id} />;
    case "mails":
      return <MailLog />;
    case "settings":
      return <SettingsPage initialTab={route.tab} />;
  }
}
