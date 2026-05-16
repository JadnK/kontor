import { useState, type FormEvent } from "react";
import { Api, errorMessage } from "../lib/api";
import {
  decodeInvite,
  discover,
  loadProfiles,
  newId,
  removeProfile,
  upsertProfile,
  type Discovery,
  type Preset,
  type Profile,
} from "../lib/connection";
import { openSession } from "../App";
import type { Settings, User } from "../lib/types";
import { Button, TextField } from "../components/ui";
import { ThemeSwitch } from "../components/Layout";

type Live = Awaited<ReturnType<typeof openSession>>;

type Step =
  | { kind: "list" }
  | { kind: "add" }
  | { kind: "invite" }
  | { kind: "login"; profile: Profile }
  | { kind: "setup"; url: string; info: Discovery; insecure: boolean }
  | { kind: "accept"; url: string; info: Discovery; token: string; email: string };

export function Connect({ onReady, preset, notice }: { onReady: (l: Live) => void; preset: Preset | null; notice: string | null }) {
  const [profiles, setProfiles] = useState<Profile[]>(loadProfiles);
  const [step, setStep] = useState<Step>(() => (loadProfiles().length ? { kind: "list" } : { kind: "add" }));
  const locked = !!preset?.lockServers;

  const finish = async (p: Profile) => onReady(await openSession(p));

  return (
    <div className="connect">
      <div className="connect-side">
        <div className="connect-brand">
          <span className="brand-mark" aria-hidden>
            K
          </span>
          Kontor
        </div>
        <p>Kunden, Produkte, Rabatte und Rechnungen deines Betriebs – gespeichert auf eurem eigenen Server.</p>
      </div>
      <div className="connect-main">
        <ThemeSwitch className="segmented connect-theme" />
        <div className="connect-card">
          {notice ? <div className="notice">{notice}</div> : null}
          {step.kind === "list" && (
            <ProfileList
              profiles={profiles}
              locked={locked}
              onPick={(p) => setStep({ kind: "login", profile: p })}
              onQuick={finish}
              onRemove={(id) => setProfiles(removeProfile(id))}
              onAdd={() => setStep({ kind: "add" })}
              onInvite={() => setStep({ kind: "invite" })}
            />
          )}
          {step.kind === "add" && (
            <AddServer
              canGoBack={profiles.length > 0}
              locked={locked}
              onBack={() => setStep({ kind: "list" })}
              onInvite={() => setStep({ kind: "invite" })}
              onFound={async (url, info, insecure) => {
                const api = new Api(url, null);
                const { needsSetup } = await api.get<{ needsSetup: boolean }>("/api/setup/status");
                if (needsSetup) {
                  setStep({ kind: "setup", url, info, insecure });
                } else {
                  const existing = loadProfiles().find((p) => p.instanceId === info.instanceId || p.url === url);
                  const p: Profile = existing ?? { id: newId(), name: info.name, url, instanceId: info.instanceId, email: null, token: null };
                  setProfiles(upsertProfile(p));
                  setStep({ kind: "login", profile: p });
                }
              }}
            />
          )}
          {step.kind === "invite" && (
            <InviteStep
              onBack={() => setStep(profiles.length ? { kind: "list" } : { kind: "add" })}
              onValid={(url, info, token, email) => setStep({ kind: "accept", url, info, token, email })}
            />
          )}
          {step.kind === "login" && (
            <Login
              profile={step.profile}
              onBack={() => setStep({ kind: "list" })}
              onDone={async (p) => {
                setProfiles(upsertProfile(p));
                await finish(p);
              }}
            />
          )}
          {step.kind === "setup" && (
            <Setup
              {...step}
              onBack={() => setStep({ kind: "add" })}
              onDone={async (p) => {
                setProfiles(upsertProfile(p));
                await finish(p);
              }}
            />
          )}
          {step.kind === "accept" && (
            <Accept
              {...step}
              onBack={() => setStep({ kind: "invite" })}
              onDone={async (p) => {
                setProfiles(upsertProfile(p));
                await finish(p);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function ProfileList({
  profiles,
  locked,
  onPick,
  onQuick,
  onRemove,
  onAdd,
  onInvite,
}: {
  profiles: Profile[];
  locked: boolean;
  onPick: (p: Profile) => void;
  onQuick: (p: Profile) => Promise<void>;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onInvite: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <>
      <h1>Verbindung wählen</h1>
      <ul className="profile-list">
        {profiles.map((p) => (
          <li key={p.id}>
            <button
              className="profile"
              disabled={!!busy}
              onClick={async () => {
                if (!p.token) return onPick(p);
                setBusy(p.id);
                setErr(null);
                try {
                  await onQuick(p);
                } catch (e) {
                  setErr(errorMessage(e));
                  onPick({ ...p, token: null });
                } finally {
                  setBusy(null);
                }
              }}
            >
              <strong>{p.name}</strong>
              <span>
                {p.url.replace(/^https?:\/\//, "")}
                {p.email ? ` – ${p.email}` : ""}
              </span>
              {busy === p.id ? <span className="spinner" aria-hidden /> : null}
            </button>
            {!p.preset || !locked ? (
              <button className="icon-btn" aria-label={`${p.name} entfernen`} title="Verbindung entfernen" onClick={() => onRemove(p.id)}>
                ×
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {err ? <div className="form-error">{err}</div> : null}
      <div className="connect-actions">
        {!locked ? <Button onClick={onAdd}>Server hinzufügen</Button> : null}
        <Button variant="ghost" onClick={onInvite}>
          Einladungscode einlösen
        </Button>
      </div>
    </>
  );
}

function AddServer({
  canGoBack,
  locked,
  onBack,
  onInvite,
  onFound,
}: {
  canGoBack: boolean;
  locked: boolean;
  onBack: () => void;
  onInvite: () => void;
  onFound: (url: string, info: Discovery, insecure: boolean) => Promise<void>;
}) {
  const [address, setAddress] = useState("");
  const { busy, error, submit } = useSubmit();
  if (locked) {
    return (
      <>
        <h1>Server ist vorgegeben</h1>
        <p className="muted">Die Serveradresse wird von deiner Firma verwaltet. Nutze einen Einladungscode oder melde dich bei einer vorhandenen Verbindung an.</p>
        <div className="connect-actions">
          <Button onClick={onInvite}>Einladungscode einlösen</Button>
          {canGoBack ? <Button variant="ghost" onClick={onBack}>Zurück</Button> : null}
        </div>
      </>
    );
  }
  return (
    <form onSubmit={submit(async () => {
      const r = await discover(address);
      await onFound(r.url, r.info, r.insecure);
    })}>
      <h1>Mit Server verbinden</h1>
      <p className="muted">
        Gib die Adresse eures Kontor-Servers ein. Du bekommst sie von der Person, die den Server betreibt – oder du löst direkt einen Einladungscode ein.
      </p>
      <TextField label="Serveradresse" value={address} onChange={setAddress} placeholder="kontor.meinefirma.de" autoFocus required
        hint="Auch IP-Adressen mit Port gehen, z. B. 192.168.1.20:8080" />
      {error ? <div className="form-error">{error}</div> : null}
      <div className="connect-actions">
        <Button variant="primary" type="submit" busy={busy}>Verbinden</Button>
        <Button variant="ghost" type="button" onClick={onInvite}>Einladungscode einlösen</Button>
        {canGoBack ? <Button variant="ghost" type="button" onClick={onBack}>Zurück</Button> : null}
      </div>
    </form>
  );
}

function InviteStep({ onBack, onValid }: { onBack: () => void; onValid: (url: string, info: Discovery, token: string, email: string) => void }) {
  const [code, setCode] = useState("");
  const { busy, error, submit } = useSubmit();
  return (
    <form onSubmit={submit(async () => {
      const inv = decodeInvite(code);
      const { url, info } = await discover(inv.url);
      const api = new Api(url, null);
      const meta = await api.post<{ email: string }>("/api/invites/inspect", { token: inv.token });
      onValid(url, info, inv.token, meta.email);
    })}>
      <h1>Einladung einlösen</h1>
      <p className="muted">Füge den Code ein, den du von deinem Administrator bekommen hast. Er enthält die Serveradresse – du musst nichts weiter eintragen.</p>
      <div className="field">
        <label htmlFor="invite">Einladungscode</label>
        <textarea id="invite" rows={4} className="mono-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="KONTOR1.…" autoFocus required />
      </div>
      {error ? <div className="form-error">{error}</div> : null}
      <div className="connect-actions">
        <Button variant="primary" type="submit" busy={busy}>Weiter</Button>
        <Button variant="ghost" type="button" onClick={onBack}>Zurück</Button>
      </div>
    </form>
  );
}

function Login({ profile, onBack, onDone }: { profile: Profile; onBack: () => void; onDone: (p: Profile) => Promise<void> }) {
  const [email, setEmail] = useState(profile.email ?? "");
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit();
  return (
    <form onSubmit={submit(async () => {
      const { url, info } = await discover(profile.url);
      if (profile.instanceId && profile.instanceId !== info.instanceId) {
        throw new Error("Unter dieser Adresse läuft ein anderer Kontor-Server als erwartet. Verbindung entfernen und neu einrichten, falls das gewollt ist.");
      }
      const api = new Api(url, null);
      const r = await api.post<{ token: string; user: User }>("/api/auth/login", { email, password });
      await onDone({ ...profile, url, instanceId: info.instanceId, email: r.user.email, token: r.token });
    })}>
      <h1>Anmelden</h1>
      <p className="muted">
        {profile.name} <span className="host">{profile.url.replace(/^https?:\/\//, "")}</span>
      </p>
      <TextField label="E-Mail" type="email" value={email} onChange={setEmail} autoFocus={!email} required />
      <TextField label="Passwort" type="password" value={password} onChange={setPassword} autoFocus={!!email} required />
      {error ? <div className="form-error">{error}</div> : null}
      <div className="connect-actions">
        <Button variant="primary" type="submit" busy={busy}>Anmelden</Button>
        <Button variant="ghost" type="button" onClick={onBack}>Andere Verbindung</Button>
      </div>
    </form>
  );
}

function Setup({ url, info, insecure, onBack, onDone }: { url: string; info: Discovery; insecure: boolean; onBack: () => void; onDone: (p: Profile) => Promise<void> }) {
  const [f, setF] = useState({ setupToken: "", companyName: "", name: "", email: "", password: "", password2: "" });
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const { busy, error, submit } = useSubmit();
  return (
    <form onSubmit={submit(async () => {
      if (f.password !== f.password2) throw new Error("Die Passwörter stimmen nicht überein");
      const api = new Api(url, null);
      const r = await api.post<{ token: string; user: User }>("/api/setup", {
        setupToken: f.setupToken, companyName: f.companyName, name: f.name, email: f.email, password: f.password,
      });
      const s = await new Api(url, r.token).get<Settings>("/api/settings");
      await onDone({ id: newId(), name: s.company.name || f.companyName, url, instanceId: info.instanceId, email: r.user.email, token: r.token });
    })}>
      <h1>Server einrichten</h1>
      <p className="muted">
        Dieser Server ist neu. Lege die Firma und das erste Administrator-Konto an. Das Einrichtungs-Token steht im Server-Log
        ({"docker compose logs server"}) oder in der Variable SETUP_TOKEN.
      </p>
      {insecure ? <div className="notice">Die Verbindung ist unverschlüsselt (http). Im Internet bitte nur mit https betreiben.</div> : null}
      <div className="grid-2">
        <TextField label="Einrichtungs-Token" value={f.setupToken} onChange={set("setupToken")} required span={2} autoFocus />
        <TextField label="Firmenname" value={f.companyName} onChange={set("companyName")} required span={2} />
        <TextField label="Dein Name" value={f.name} onChange={set("name")} required />
        <TextField label="E-Mail" type="email" value={f.email} onChange={set("email")} required />
        <TextField label="Passwort" type="password" value={f.password} onChange={set("password")} hint="Mindestens 10 Zeichen" required />
        <TextField label="Passwort wiederholen" type="password" value={f.password2} onChange={set("password2")} required />
      </div>
      {error ? <div className="form-error">{error}</div> : null}
      <div className="connect-actions">
        <Button variant="primary" type="submit" busy={busy}>Einrichten und anmelden</Button>
        <Button variant="ghost" type="button" onClick={onBack}>Zurück</Button>
      </div>
    </form>
  );
}

function Accept({ url, info, token, email, onBack, onDone }: { url: string; info: Discovery; token: string; email: string; onBack: () => void; onDone: (p: Profile) => Promise<void> }) {
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const { busy, error, submit } = useSubmit();
  return (
    <form onSubmit={submit(async () => {
      if (pw !== pw2) throw new Error("Die Passwörter stimmen nicht überein");
      const r = await new Api(url, null).post<{ token: string; user: User }>("/api/invites/accept", { token, name, password: pw });
      await onDone({ id: newId(), name: info.name, url, instanceId: info.instanceId, email: r.user.email, token: r.token });
    })}>
      <h1>Konto anlegen</h1>
      <p className="muted">
        Einladung zu <strong>{info.name}</strong> für {email}.
      </p>
      <TextField label="Dein Name" value={name} onChange={setName} required autoFocus />
      <TextField label="Passwort" type="password" value={pw} onChange={setPw} hint="Mindestens 10 Zeichen" required />
      <TextField label="Passwort wiederholen" type="password" value={pw2} onChange={setPw2} required />
      {error ? <div className="form-error">{error}</div> : null}
      <div className="connect-actions">
        <Button variant="primary" type="submit" busy={busy}>Konto anlegen</Button>
        <Button variant="ghost" type="button" onClick={onBack}>Zurück</Button>
      </div>
    </form>
  );
}
