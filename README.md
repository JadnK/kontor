# Kontor

Desktop-App für kleine Betriebe: Kunden, Produkte, Rabatte und Rechnungen verwalten. Die Daten liegen auf einem eigenen Server, mehrere Arbeitsplätze greifen gleichzeitig darauf zu.

```
apps/desktop/   Tauri 2, React, TypeScript
apps/server/    Node 22, Fastify, Drizzle ORM, PostgreSQL
```

## Entwicklung

```bash
cd apps/server && npm install && npx tsx --env-file=.env src/index.ts
cd apps/desktop && npm install && npm run dev
```
