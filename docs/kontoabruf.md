# Automatischer Kontoabruf (N26, Sparkasse, Volksbank …)

Kontor holt Zahlungseingänge selbst vom Geschäftskonto und bucht sie gegen offene Rechnungen. Du musst keine Kontoauszüge mehr hochladen.

Banken geben Kontodaten nur an lizenzierte Dienste heraus (PSD2). N26 hat keine eigene Schnittstelle für Kunden und kein FinTS/HBCI. Kontor nutzt deshalb **Enable Banking** als Vermittler:

- Für die eigenen Konten ist es kostenlos (eingeschränkter Modus).
- Kontor bekommt nur **Lesezugriff**. Überweisungen sind darüber nicht möglich.

```
Kontor-Server ──(signierte Anfrage)──▶ Enable Banking ──(PSD2)──▶ N26
      ▲                                                         │
      └──────── Umsätze (alle 6 h) ◀────────────────────────────┘
```

## Voraussetzungen

- Der Kontor-Server ist per **HTTPS aus dem Internet erreichbar**, z. B. `https://kontor.deinedomain.de` über den Nginx Proxy Manager.
- In `deploy/.env` steht diese Adresse als `PUBLIC_URL`. Dorthin schickt die Bank dich nach dem Login zurück.
- Server auf dem aktuellen Stand: `git pull && docker compose up -d --build`.

## Einmalig: Enable Banking einrichten (ca. 5 Minuten)

1. **Konto anlegen** auf [enablebanking.com](https://enablebanking.com) und die E-Mail-Adresse bestätigen.
2. **Anwendung anlegen:** Im Control Panel unter *API applications* eine neue Anwendung erstellen.
   - **Environment:** `Production`
   - **Redirect URLs:** genau die Adresse aus Kontor unter *Einstellungen → Zahlungsabgleich → Redirect-URL* (Knopf „Kopieren“). Sie sieht so aus: `https://kontor.deinedomain.de/api/bank/sync/callback`
   - **Privacy Policy / Terms URL:** im eingeschränkten Modus nicht geprüft. Die eigene Website oder die Server-Adresse eintragen.
3. **Schlüssel sichern:** Beim Absenden lädt der Browser eine `.pem`-Datei herunter. Das ist der **Private Key**, er wird nur dieses eine Mal angeboten. Gut aufheben.
4. **Application-ID notieren:** Sie steht im Control Panel bei der Anwendung (auch *Client ID* oder *kid* genannt).
5. **Eigenes Konto verknüpfen:** Bei der Anwendung auf **„Link accounts“** klicken, N26 auswählen, anmelden und in der N26-App bestätigen. Danach steht die Anwendung auf *Restricted* und *Active*.
   - Ohne diesen Schritt lehnt Enable Banking im kostenlosen Modus alle Konten ab.

## In Kontor eintragen

6. *Einstellungen → Zahlungsabgleich → Automatischer Kontoabruf*:
   - **Application-ID** eintragen.
   - **Private Key (.pem)** → „Datei wählen“ → die heruntergeladene `.pem`-Datei. Sie wird verschlüsselt auf dem Server gespeichert.
   - **Automatisch abrufen** einschalten.
   - **Speichern**.
7. Links auf **Zahlungsabgleich** → **„Bank verbinden“**:
   - **Land:** Deutschland. **Bank:** N26. **Kontoart:** Geschäfts- oder Privatkonto, je nachdem, was du bei N26 hast.
   - **Umsätze abrufen ab:** Ab hier werden Zahlungen übernommen, Standard sind die letzten 30 Tage. Wenn du vorher schon Kontoauszüge importiert hast, das Datum nach der letzten importierten Buchung wählen.
   - **„Weiter zur Bank“**: Der Browser öffnet sich. Bei N26 anmelden, Konto (und ggf. Spaces) auswählen, in der N26-App bestätigen.
8. Der Browser zeigt **„Bankkonto verbunden“**, und Kontor ruft sofort die Umsätze ab. Fertig.

## Was danach passiert

- **Abruf:** Alle 6 Stunden holt der Server neue Buchungen. Das Intervall ist einstellbar. „Jetzt abrufen“ geht jederzeit von Hand.
- **Welche Umsätze:** Nur **gebuchte Gutschriften**. Abbuchungen und vorgemerkte Umsätze werden ignoriert.
- **Abgleich:** Gleich wie beim Datei-Import.
  - Rechnungsnummer im Verwendungszweck → wird automatisch gebucht. Die Rechnung ist dann bezahlt, und die Zahlungsbestätigung geht raus, falls aktiviert.
  - Mehrere Rechnungsnummern und die Summe passt → alle werden gebucht.
  - Nur Betrag oder Name passt → erscheint als Vorschlag unter „Zu prüfen“.
- **Doppelte Buchungen:** Bereits abgerufene Buchungen werden erkannt und nicht doppelt übernommen.
- **Mehrere Konten:** Gibst du mehrere Konten oder Spaces frei, kannst du einzelne auf der Seite Zahlungsabgleich per Haken abwählen.

## Alle 180 Tage: Freigabe erneuern

Die PSD2-Regeln begrenzen jede Bankfreigabe auf höchstens 180 Tage. Danach muss der Kontoinhaber neu zustimmen.

- Kontor zeigt die Restlaufzeit an.
- **7 Tage vorher** geht eine Erinnerung an die Firmen-E-Mail-Adresse (Einstellungen → Firma). Dafür muss der Mailversand eingerichtet sein.
- Zum Verlängern: Zahlungsabgleich → **„Neu verbinden“** → bei N26 bestätigen. Der Abruf macht nahtlos weiter.

## Wenn etwas nicht klappt

| Meldung / Problem | Ursache und Lösung |
|---|---|
| „Application-ID oder Private Key falsch“ | Die Application-ID gehört nicht zur `.pem`-Datei. Beides aus derselben Anwendung nehmen, die Anwendung muss *Production* sein. |
| Browser zeigt nach dem N26-Login einen Fehler oder „Seite nicht erreichbar“ | Die Redirect-URL zeigt auf eine Adresse, die von außen nicht erreichbar ist. `PUBLIC_URL` prüfen, sie muss exakt der in Enable Banking eingetragenen Redirect-URL entsprechen. Notlösung: Die komplette Adresse aus der Adresszeile kopieren und in Kontor unter „Browser zeigt am Ende einen Fehler?“ einfügen. |
| Enable Banking meldet „redirect_url not allowed“ | Die Redirect-URL in Enable Banking stimmt nicht Zeichen für Zeichen mit der in Kontor angezeigten überein (http/https, Schrägstrich am Ende). |
| „Die Bank hat keine Konten freigegeben“ | Beim N26-Login kein Konto angehakt, oder das Konto ist in Enable Banking nicht unter „Link accounts“ verknüpft. |
| „Bankfreigabe abgelaufen oder widerrufen“ | Nach 180 Tagen, oder in der N26-App wurde der Zugriff entzogen → „Neu verbinden“. |
| „Die Bank erlaubt gerade keine weiteren Abrufe“ | Ohne dass du aktiv dabei bist, erlauben Banken meist nur 4 Abrufe pro Tag. Später erneut versuchen, das Intervall nicht unter 360 Minuten stellen. |
| Zahlung kommt nicht an | Erst wenn N26 sie als *gebucht* führt, nicht während sie nur vorgemerkt ist. Bei Echtzeitüberweisung meist sofort, sonst am nächsten Bankarbeitstag. |

## Sicherheit

- Der Private Key liegt AES-verschlüsselt in der Datenbank (Schlüssel aus `APP_SECRET`). Er wird nie an die App zurückgegeben und ist nicht im JSON-Export enthalten.
- Kontor speichert keine Bank-Zugangsdaten. Der Login läuft ausschließlich auf den Seiten von N26 bzw. Enable Banking.
- „Trennen“ beendet die Freigabe auch bei der Bank.
