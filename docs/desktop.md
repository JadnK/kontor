# Desktop-App

## Installieren

Installer gibt es unter [Releases](../../../releases):

| Plattform | Datei |
|---|---|
| Windows | `Kontor_x.y.z_x64-setup.exe`, `Kontor_x.y.z_x64_de-DE.msi` oder `Kontor-portable.exe` |
| macOS (Intel + Apple Silicon) | `Kontor_x.y.z_universal.dmg` |
| Linux | `.deb`, `.rpm`, `.AppImage` |

Die Windows-Version ist nicht code-signiert: SmartScreen meldet beim ersten Start „Unbekannter Herausgeber“ (*Weitere Informationen → Trotzdem ausführen*). Die macOS-App ist nicht notarisiert: beim ersten Start Rechtsklick → *Öffnen*.

## Mit dem Server verbinden

Die App speichert nur Verbindungsprofile (Adresse, Instanz-Kennung, Anmeldung). Mehrere Server sind möglich.

1. **Einladungscode** – der Admin lädt unter *Einstellungen → Benutzer* ein und gibt den Code `KONTOR1.…` weiter. Darin stecken Adresse und Einmal-Token.
2. **Adresse eingeben** – z. B. `kontor.meinefirma.de` oder `192.168.1.20:8080`. Ohne `https://` wird erst https, dann http versucht.
3. **`kontor.json`** – für den Rollout in Firmen. Liegt die Datei neben `Kontor.exe` oder unter `%APPDATA%\de.jadenk.kontor\`, erscheinen die Server automatisch. Mit `"lockServers": true` lassen sich keine fremden Server hinzufügen. Vorlage: [`apps/desktop/kontor.example.json`](../apps/desktop/kontor.example.json)

Jeder Server meldet unter `GET /.well-known/kontor` eine Instanz-Kennung. Die App prüft vor jeder Anmeldung, ob sie wirklich mit demselben Server spricht wie beim letzten Mal, und schickt sonst kein Token mit.

## Bauen und veröffentlichen

Gebaut wird per GitHub Actions (`desktop.yml`), lokal ist kein Rust nötig.

- Push auf `main` oder *Actions → Desktop → Run workflow*: Installer liegen als Artefakte am Lauf.
- Release: `git tag v1.2.0 && git push --tags` – die Version kommt aus dem Tag, es entsteht ein GitHub-Release mit allen Installern. `server.yml` baut gleichzeitig das Server-Image.

Lokal (Node 22 und Rust):

```bash
cd apps/desktop
npm install
npx tauri dev      # Entwicklung
npx tauri build    # Installer unter src-tauri/target/release/bundle
```

## Tastenkürzel

| Kürzel | Aktion |
|---|---|
| `Strg+K` | Schnellsuche (Kunden, Rechnungen, Tickets …) |
| `Strg+N` | neue Rechnung |
| `Strg+Enter` | im Ticket: Antwort senden |
