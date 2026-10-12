# Kontor

Rechnungen, Angebote, Verträge, Tickets und Zahlungen für kleine Betriebe – als Desktop-App mit eigenem Server.

Kontor läuft auf Windows, macOS und Linux. Alle Daten liegen auf einem selbst betriebenen Server (Docker + PostgreSQL), mehrere Arbeitsplätze greifen gleichzeitig darauf zu. Kunden bekommen Rechnungen, Erinnerungen und Bestätigungen automatisch per Mail, zahlen online oder per GiroCode und sehen ihre Unterlagen in einem eigenen Kundenportal.

## Was drin ist

| Bereich | Kurz |
|---|---|
| **Rechnungen** | Entwurf → Ausstellen → Zahlung, Storno, Positions- und Belegrabatte, PDF nach DIN 5008 in drei Designs, GiroCode |
| **E-Rechnung** | ZUGFeRD 2 (PDF/A-3, Profil EN 16931) und XRechnung 3.0 – geprüft mit dem KoSIT-Validator |
| **Angebote** | Online annehmen per Link, aus dem Angebot wird mit einem Klick die Rechnung |
| **Verträge** | Laufzeit, Verlängerung, Kündigungsfristen, monatliche Einnahmen, Prognose, automatische Abrechnung |
| **Abo-Rechnungen** | monatlich bis jährlich, mit Leistungszeitraum, holen verpasste Termine nach |
| **Mahnwesen** | Zahlungserinnerung und Mahnstufen mit Gebühren und Verzugszinsen nach § 288 BGB |
| **Zahlungsabgleich** | Kontoabruf per PSD2 (z. B. N26, Sparkasse) oder CAMT/MT940/CSV, erkennt Rechnungsnummern und bucht automatisch |
| **Online-Zahlung** | Zahlungslink je Rechnung: Karte, Apple/Google Pay, PayPal & Co. über Stripe, bucht sich selbst |
| **Tickets** | eigenes Postfach per IMAP, Spam-Filter, nur für Kunden einstellbar, Zeit & Material direkt abrechnen |
| **Kundenportal** | persönlicher Link je Kunde: Rechnungen, Angebote, Anfragen – ohne Passwort |
| **Website-Formular** | Anfragen von der eigenen Website landen als Ticket, per iframe einbettbar |
| **Zeiterfassung** | Stoppuhr, Projekte mit Budget, Rundung, Abrechnen per Klick |
| **Ausgaben** | Belege per Drag & Drop, Abbuchungen aus dem Konto, Empfänger werden gelernt |
| **Auswertung** | Einnahmen-Überschuss, Umsatzsteuer je Quartal, Kleinunternehmergrenze, DATEV-Export |
| **Mehrere Firmen** | weitere Absender mit eigener Bank, eigenem Logo und Nummernkreis |

Ausführlich: [docs/funktionen.md](docs/funktionen.md)

## Schnellstart

**Server** (Linux mit Docker, Domain mit HTTPS über einen Reverse Proxy):

```bash
git clone https://github.com/JadnK/kontor.git
cd kontor/deploy
cp .env.example .env        # POSTGRES_PASSWORD, APP_SECRET, PUBLIC_URL eintragen
docker compose up -d --build
docker compose logs server | grep Einrichtungs-Token
```

**App:** Installer aus den [Releases](../../releases) laden, Serveradresse eingeben, mit dem Einrichtungs-Token den ersten Admin anlegen.

Details: [docs/installation.md](docs/installation.md)

## Aufbau

```
kontor/
├─ apps/
│  ├─ desktop/        Desktop-App – Tauri 2, React 18, TypeScript
│  └─ server/         API-Server – Node 22, Fastify 5, Drizzle ORM, PostgreSQL
├─ deploy/            docker-compose.yml und .env.example für den Betrieb
├─ docs/              Anleitungen
└─ .github/workflows  CI, Desktop-Builds für alle Plattformen, Server-Image
```

| Dokument | Inhalt |
|---|---|
| [installation.md](docs/installation.md) | Server einrichten, Updates, Datensicherung, Umgebungsvariablen |
| [desktop.md](docs/desktop.md) | App bauen, Releases, Firmen-Rollout mit `kontor.json` |
| [funktionen.md](docs/funktionen.md) | alle Funktionen im Detail |
| [e-rechnung.md](docs/e-rechnung.md) | ZUGFeRD, XRechnung, Validierung |
| [kontoabruf.md](docs/kontoabruf.md) | automatischer Kontoabruf über Enable Banking |
| [online-zahlung.md](docs/online-zahlung.md) | Stripe und PayPal einrichten |
| [kundenportal.md](docs/kundenportal.md) | Kundenportal und Anfrage-Formular für die Website |
| [entwicklung.md](docs/entwicklung.md) | lokal entwickeln, Schema ändern, Tests |
| [rechtliches.md](docs/rechtliches.md) | was Kontor abdeckt und was nicht |

## Lizenz

Alle Rechte vorbehalten. Nutzung nur nach Absprache.
