# Server installieren

Der Server hält alle Daten. Die Desktop-Apps verbinden sich über HTTPS mit ihm.

## Voraussetzungen

- Linux-Server mit Docker und Docker Compose
- eine Domain bzw. Subdomain, z. B. `kontor.meinefirma.de`
- ein Reverse Proxy mit HTTPS (Nginx Proxy Manager, Caddy, Traefik)

Ohne öffentliche HTTPS-Adresse funktioniert Kontor im LAN weiterhin, aber nicht: Kundenportal, Online-Annahme von Angeboten, Zahlungslinks, Website-Formular und Kontoabruf.

## Einrichten

```bash
git clone https://github.com/JadnK/kontor.git
cd kontor/deploy
cp .env.example .env
```

In `.env` mindestens eintragen:

| Variable | Wert |
|---|---|
| `POSTGRES_PASSWORD` | frei wählen |
| `APP_SECRET` | `openssl rand -hex 32` – danach nie mehr ändern, damit gespeicherte Passwörter lesbar bleiben |
| `PUBLIC_URL` | `https://kontor.meinefirma.de` |

```bash
docker compose up -d --build
docker compose logs server | grep Einrichtungs-Token
```

Im Reverse Proxy einen Host `kontor.meinefirma.de` → `http://<server>:8080` mit Let's-Encrypt-Zertifikat anlegen. Dann in der App die Adresse eingeben: Der Server merkt, dass er neu ist, und fragt nach dem Einrichtungs-Token, dem Firmennamen und dem ersten Admin-Konto.

### Fertiges Image statt lokal bauen

```bash
# in .env
KONTOR_IMAGE=ghcr.io/jadnk/kontor-server:latest
```

```bash
docker compose pull && docker compose up -d
```

Das Image baut der Workflow `server.yml` bei jedem Release. Ist das Paket privat, vorher `docker login ghcr.io`.

## Erste Schritte in der App

1. *Einstellungen → Firma*: Name, Anschrift, Steuernummer oder USt-IdNr., Bankverbindung, Logo
2. *Einstellungen → Rechnungen & Steuer*: Kleinunternehmer ja/nein, Nummernkreise, Zahlungsziel, Design
3. *Einstellungen → E-Mail-Versand*: SMTP-Zugang, *Testnachricht senden*
4. *Einstellungen → Benutzer*: Kolleginnen und Kollegen per Einladungscode hinzufügen

Alles Weitere (Ticket-Postfach, Kontoabruf, Online-Zahlung, Kundenportal) ist optional.

## Updates

```bash
cd kontor && git pull
cd deploy && docker compose up -d --build
```

Datenbank-Migrationen laufen beim Start automatisch.

## Datensicherung

- Der Dienst `backup` legt täglich einen `pg_dump` unter `deploy/backups/` ab und behält 14 Tage.
- Wiederherstellen: `docker compose exec -T db pg_restore -U kontor -d kontor --clean < backups/kontor-JJJJ-MM-TT.dump`
- Zusätzlich in der App: *Einstellungen → Datensicherung* exportiert alles als JSON (inkl. Belegen und Vertragsdokumenten) und spielt es wieder ein – zusammenführen oder ersetzen. Passwörter und API-Schlüssel sind nicht enthalten.

## Passwort vergessen

```bash
docker compose exec server node dist/cli.js reset-password admin@meinefirma.de
```

## Umgebungsvariablen

| Variable | Standard | Bedeutung |
|---|---|---|
| `DATABASE_URL` | – | PostgreSQL-Verbindung (setzt docker-compose selbst) |
| `APP_SECRET` | – | mind. 32 Zeichen, verschlüsselt Passwörter und Schlüssel in der Datenbank |
| `PUBLIC_URL` | – | öffentliche HTTPS-Adresse: Einladungscodes, Kundenportal, Zahlungslinks, Webhooks, Kontoabruf |
| `SETUP_TOKEN` | zufällig | Einmal-Token für die Ersteinrichtung, steht sonst im Log |
| `PORT` / `KONTOR_PORT` | 8080 | Port im Container bzw. auf dem Host |
| `INSTANCE_NAME` | Firmenname | Anzeigename in der Serverauswahl der App |
| `SESSION_DAYS` | 30 | Gültigkeit einer Anmeldung, verlängert sich bei Nutzung |
| `AUTOMATION_INTERVAL_MINUTES` | 60 | Takt für Erinnerungen, Mahnungen, Abo-Rechnungen, Fristen |
| `LOG_LEVEL` | info | `debug`, `info`, `warn`, `error` |
| `KONTOR_INSECURE_TLS` | – | `1` erlaubt selbstsignierte Zertifikate beim Mailserver (nur für Tests) |
