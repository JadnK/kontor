# Kontor

Desktop-App (Windows, macOS, Linux) für kleine Betriebe: Kunden, Produkte, Rabatte, Rechnungen und Einnahmen verwalten. Alle Daten liegen zentral auf einem eigenen Server, mehrere Arbeitsplätze greifen gleichzeitig darauf zu. Rechnungen, Zahlungserinnerungen und Zahlungsbestätigungen gehen automatisch per E-Mail an die Kunden.

```
kontor/
├─ apps/desktop/     Desktop-App (Tauri 2, React, TypeScript)
├─ apps/server/      API-Server (Node 22, Fastify, Drizzle ORM, PostgreSQL)
├─ deploy/           docker-compose.yml + .env.example für den Server
└─ .github/workflows Desktop-Builds, Server-Image, CI
```

## Server installieren

```bash
git clone https://github.com/JadnK/kontor.git
cd kontor/deploy
cp .env.example .env   # POSTGRES_PASSWORD, APP_SECRET, PUBLIC_URL
docker compose up -d --build
docker compose logs server | grep Einrichtungs-Token
```

Im Reverse Proxy (z. B. Nginx Proxy Manager) einen Host auf `http://<host>:8080` mit HTTPS anlegen, dann in der App die Adresse eingeben.

Updates: `git pull && docker compose up -d --build` – Migrationen laufen beim Start automatisch.

## Desktop-App

Installer für Windows, macOS und Linux baut GitHub Actions. Release: `git tag v0.2.0 && git push --tags`.

## Entwicklung

```bash
cd apps/server && npm install && npx tsx --env-file=.env src/index.ts
cd apps/desktop && npm install && npm run dev
```

Schema ändern: `src/db/schema.ts` anpassen, `npm run db:generate`, Migration einchecken.
