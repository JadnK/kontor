# Entwicklung

## Lokal starten

```bash
# Datenbank
docker run -d --name kontor-db -e POSTGRES_USER=kontor -e POSTGRES_PASSWORD=kontor \
  -e POSTGRES_DB=kontor -p 5432:5432 postgres:16-alpine

# Server – http://localhost:8080
cd apps/server
cp .env.example .env          # APP_SECRET setzen
npm install
npx tsx --env-file=.env src/index.ts

# Oberfläche im Browser – http://localhost:1420, Serveradresse http://localhost:8080
cd apps/desktop
npm install
npm run dev                   # oder: npx tauri dev für das echte Fenster
```

## Aufbau

### Server – `apps/server/src`

| Ordner | Inhalt |
|---|---|
| `db/` | Drizzle-Schema (`schema.ts`) und Verbindung |
| `routes/` | HTTP-Endpunkte je Bereich: `invoices`, `quotes`, `contracts`, `recurring`, `bank`, `bank-sync`, `tickets`, `time`, `expenses`, `reports`, `portal` (öffentliche Seiten, Zahlung, Formular), `notify`, `backup`, `admin`, `auth` … |
| `lib/` | Fachlogik ohne HTTP: `calc` (Beträge), `pdf`, `xrechnung`, `dunning`, `recurring`, `contracts`, `tickets`, `bank-sync`, `expenses`, `portal` (Stripe, Links), `automation` (Zeitplan), `settings`, `mail` … |
| `drizzle/` | SQL-Migrationen, laufen beim Start automatisch |
| `assets/fonts/` | eingebettete PDF-Schrift (Arimo, SIL OFL) |

Alle Beträge sind Cent als Ganzzahl. Datumsangaben ohne Uhrzeit sind ISO-Strings (`2026-10-13`).

### Desktop – `apps/desktop/src`

| Ordner | Inhalt |
|---|---|
| `pages/` | eine Datei je Bereich (Rechnungen, Verträge, Tickets, Einstellungen …) |
| `components/` | `ui.tsx` (Felder, Modal, Tabellen-Bausteine), `Layout`, `TimeTracking`, `Notifier`, `PublicLinks` … |
| `lib/` | `api` (HTTP-Client), `store` (Navigation, Sitzung, Hooks), `types`, `format`, `calc`, `native` (Tauri) |
| `styles.css` | gesamtes Styling, Farben als CSS-Variablen für Hell/Dunkel |
| `../src-tauri/` | Rust-Hülle: Fenster, Dateien speichern, Benachrichtigungen |

## Schema ändern

```bash
cd apps/server
# src/db/schema.ts anpassen
npx drizzle-kit generate --name kurze_beschreibung
```

Die neue Datei in `drizzle/` mit einchecken.

## Rechenlogik

`calc.ts` gibt es im Server und als Kopie in der App (Live-Vorschau im Editor). Der Server rechnet verbindlich. CI bricht ab, wenn die Dateien auseinanderlaufen.

## Prüfen

```bash
cd apps/server && npm run typecheck && npm run build
cd apps/desktop && npm run typecheck && npx vite build
```

CI (`ci.yml`) startet den Server gegen eine echte PostgreSQL, prüft Migrationen, Discovery-Endpunkt und Anmeldeschutz und baut die Oberfläche.

## Externe Dienste zum Testen

| Variable | Zweck |
|---|---|
| `EB_API_URL` | Enable-Banking-API umbiegen (Mock) |
| `STRIPE_API_URL` | Stripe-API umbiegen (Mock) |
| `KONTOR_INSECURE_TLS=1` | selbstsignierte Zertifikate beim Mailserver erlauben |
