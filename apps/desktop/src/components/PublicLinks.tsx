import { useState } from "react";
import { useAction, useApi, useLoad, useNav, useSession, useToast } from "../lib/store";
import { dateTime, money } from "../lib/format";
import { openExternal } from "../lib/native";
import type { PayLinkInfo, PortalInfo } from "../lib/types";
import { Button, Confirm } from "./ui";
import { Icon } from "./Icon";

function copy(text: string, toast: ReturnType<typeof useToast>, msg = "Link kopiert") {
  void navigator.clipboard.writeText(text);
  toast.ok(msg);
}

/** Zahlungslink und Online-Zahlungen einer Rechnung (Seitenleiste) */
export function PayLinkCard({ invoiceId, status }: { invoiceId: string; status: string }) {
  const api = useApi();
  const toast = useToast();
  const { go } = useNav();
  const { user } = useSession();
  const { data } = useLoad(() => api.get<PayLinkInfo>(`/api/invoices/${invoiceId}/paylink`), [invoiceId, status]);
  if (!data) return null;
  const paid = data.payments.filter((p) => p.status === "PAID");
  if (!data.url && !paid.length) {
    if (status !== "ISSUED" || data.ready) return null;
    return user.role === "ADMIN" ? (
      <p className="muted small">
        Kunden online bezahlen lassen?{" "}
        <button className="link" onClick={() => go({ name: "settings", tab: "payments" })}>Online-Zahlung einrichten</button>
      </p>
    ) : null;
  }
  return (
    <div className="card-plain">
      <h3><Icon name="link" /> Online bezahlen</h3>
      {data.url ? (
        <>
          <p className="mono small break">{data.url}</p>
          <div className="row-actions">
            <Button variant="ghost" className="btn-sm" onClick={() => copy(data.url!, toast)}>Link kopieren</Button>
            <Button variant="ghost" className="btn-sm" onClick={() => void openExternal(data.url!)}>Öffnen</Button>
          </div>
        </>
      ) : null}
      {paid.length ? (
        <ul className="plain-list small">
          {paid.map((p) => (
            <li key={p.id}>
              {money(p.amount)} online bezahlt{p.method ? ` (${p.method === "card" ? "Karte" : p.method})` : ""}, {dateTime(p.paidAt)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Kundenportal-Link eines Kunden (Seitenleiste) */
export function PortalCard({ customerId, hasEmail }: { customerId: string; hasEmail: boolean }) {
  const api = useApi();
  const toast = useToast();
  const { busy, run } = useAction();
  const { settings } = useSession();
  const { data, reload } = useLoad(() => api.get<PortalInfo>(`/api/customers/${customerId}/portal`), [customerId]);
  const [renew, setRenew] = useState(false);
  if (!data || !data.enabled) return null;
  const mailReady = settings.mail.enabled && !!settings.mail.host;
  return (
    <div className="card-plain">
      <h3><Icon name="users" /> Kundenportal</h3>
      {!data.publicUrl ? (
        <p className="muted small">Auf dem Server fehlt die öffentliche Adresse (PUBLIC_URL).</p>
      ) : data.url ? (
        <>
          <p className="mono small break">{data.url}</p>
          <div className="row-actions">
            <Button variant="ghost" className="btn-sm" onClick={() => copy(data.url!, toast)}>Kopieren</Button>
            {hasEmail && mailReady ? (
              <Button variant="ghost" className="btn-sm" busy={busy === "send"} onClick={() => run("send", async () => { await api.post(`/api/customers/${customerId}/portal/send`); }, "Link per Mail gesendet")}>
                Per Mail senden
              </Button>
            ) : null}
            <Button variant="ghost" className="btn-sm" onClick={() => setRenew(true)}>Neuer Link</Button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">Persönlicher Link für Rechnungen, Angebote und Anfragen – ohne Passwort.</p>
          <div className="row-actions">
            <Button className="btn-sm" busy={busy === "create"} onClick={() => run("create", async () => { await api.post(`/api/customers/${customerId}/portal`, {}); reload(); })}>
              Link erzeugen
            </Button>
            {hasEmail && mailReady ? (
              <Button variant="ghost" className="btn-sm" busy={busy === "send"} onClick={() => run("send", async () => { await api.post(`/api/customers/${customerId}/portal/send`); reload(); }, "Link erzeugt und per Mail gesendet")}>
                Erzeugen und senden
              </Button>
            ) : null}
          </div>
        </>
      )}
      {renew ? (
        <Confirm
          title="Neuen Portal-Link erzeugen?"
          text="Der bisherige Link funktioniert danach nicht mehr – etwa wenn er in falsche Hände geraten ist. Den neuen Link musst du dem Kunden erneut schicken."
          confirmLabel="Neuen Link erzeugen"
          busy={busy === "renew"}
          onCancel={() => setRenew(false)}
          onConfirm={() =>
            run("renew", async () => {
              await api.post(`/api/customers/${customerId}/portal`, { renew: true });
              setRenew(false);
              reload();
            }, "Neuer Link erzeugt")
          }
        />
      ) : null}
    </div>
  );
}
