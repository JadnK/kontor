# Kontor – Desktop

Tauri 2, React 18, TypeScript, Vite. Installieren und bauen siehe [docs/desktop.md](../../docs/desktop.md).

```
src/
├─ App.tsx         Verbindung, Anmeldung, Routen
├─ pages/          ein Bereich je Datei
├─ components/     UI-Bausteine, Layout, Stoppuhr, Benachrichtigungen
├─ lib/            API-Client, Zustand, Typen, Formatierung, Rechnen, Tauri-Funktionen
└─ styles.css      Styling mit Hell/Dunkel-Variablen
src-tauri/         Rust-Hülle (Fenster, Dateien, Benachrichtigungen, Installer)
```

```bash
npm install
npm run dev        # im Browser, http://localhost:1420
npx tauri dev      # als App
```
