# Kundenportal und Anfrage-Formular

Beides braucht eine öffentliche Adresse (`PUBLIC_URL`).

## Kundenportal

Jeder Kunde kann einen persönlichen Link bekommen: `https://<PUBLIC_URL>/p/<code>`. Ohne Passwort sieht er dort:

- **Rechnungen** – offen und bezahlt, PDF zum Herunterladen, *Bezahlen*-Knopf bei offenen Rechnungen
- **Angebote** – ansehen, annehmen oder ablehnen
- **Anfragen** – eigene Tickets mit Verlauf (ohne interne Notizen), Antworten mit Dateien, neue Anfrage stellen

Link erzeugen und verschicken: beim Kunden in der rechten Spalte unter *Kundenportal* (*Kopieren*, *Per Mail senden*, *Neuer Link*). Ein neuer Link macht den alten sofort ungültig. In Mail-Vorlagen steht der Link als `{portalLink}` zur Verfügung.

Einstellungen unter *Einstellungen → Kundenportal & Formular*: Portal an/aus, welche Bereiche sichtbar sind, Begrüßungstext. Ob Kunden Anfragen stellen dürfen, steuert *Einstellungen → Ticket-Postfach → Tickets über Kundenportal und Webformular*.

## Anfrage-Formular für die Website

Ein fertiges Formular unter `https://<PUBLIC_URL>/form/ticket`. Jede Anfrage wird ein Ticket mit Eingangsbestätigung an den Absender.

### Einbetten

Der Code steht zum Kopieren unter *Einstellungen → Kundenportal & Formular*, zum Beispiel:

```html
<iframe id="kontor-form" src="https://kontor.meinefirma.de/form/ticket?embed=1"
        title="Anfrage senden" style="width:100%;border:0;min-height:640px"></iframe>
<script>
  addEventListener("message", function (e) {
    if (e.origin === "https://kontor.meinefirma.de" && e.data && e.data.kontor === "height")
      document.getElementById("kontor-form").style.height = e.data.height + "px";
  });
</script>
```

Das Skript passt die Höhe automatisch an. Nach dem Absenden schickt das Formular zusätzlich `{ kontor: "ticket-sent", number }` an die Seite – praktisch für eigenes Tracking.

### Optionen

- Überschrift, Einleitung, Text nach dem Absenden
- Telefon abfragen, Thema (Ticket-Kategorie) abfragen, Dateien erlauben
- **Nur Kunden**: nur bekannte E-Mail-Adressen (bzw. dieselbe Firmen-Domain, falls im Ticket-Postfach erlaubt), mit eigenem Hinweistext für alle anderen

### Eigenes Formular

Wer ein eigenes Formular bauen will, schickt per `POST /form/ticket` JSON oder ein klassisches HTML-Formular (`application/x-www-form-urlencoded`) mit den Feldern `name`, `email`, `subject`, `text` sowie optional `phone`, `category`, `website` (Honeypot, leer lassen). Die Website-Adresse muss dazu unter *Eigene Formulare erlauben von* eingetragen sein.

### Spam-Schutz

- verstecktes Honeypot-Feld: Bots bekommen eine Erfolgsmeldung, es entsteht kein Ticket
- höchstens 5 Anfragen je IP und 3 je E-Mail-Adresse in 10 Minuten
- Anfragen von fremden Websites werden abgewiesen
