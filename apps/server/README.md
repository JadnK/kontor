# Kontor – Server

Node 22, Fastify 5, Drizzle ORM, PostgreSQL. Betrieb siehe [docs/installation.md](../../docs/installation.md), Entwicklung siehe [docs/entwicklung.md](../../docs/entwicklung.md).

```
src/
├─ index.ts       Start: Migrationen, Server, Hintergrund-Jobs
├─ app.ts         Fastify, Anmeldung, öffentliche Pfade, Routen
├─ config.ts      Umgebungsvariablen
├─ cli.ts         reset-password
├─ db/            Schema und Verbindung
├─ routes/        HTTP-Endpunkte je Bereich
└─ lib/           Fachlogik (Rechnen, PDF, E-Rechnung, Mails, Bank, Tickets, Verträge …)
drizzle/          SQL-Migrationen
assets/fonts/     PDF-Schrift (Arimo, SIL Open Font License)
```

```bash
npm install
npx tsx --env-file=.env src/index.ts   # Entwicklung
npm run build && npm start             # Produktion
```
