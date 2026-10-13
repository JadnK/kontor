# Änderungen

## 1.0.0 – Oktober 2026

- **Verträge**: Laufzeit, Verlängerung, Kündigungsfristen, monatliche Einnahmen mit 12-Monats-Prognose, Erinnerung vor Fristablauf, Kündigung erfassen und zurücknehmen, automatische Abrechnung, Vertragsdokument
- **ZUGFeRD 2** (PDF/A-3, EN 16931) als Standard für Rechnungs-PDFs, eingebettete Schrift
- **Rechnungsdesigns** Klassisch, Modern, Schlicht
- **Weitere Firmen**: eigene Absenderdaten, Bank, Logo, Umsatzsteuer-Status und Nummernkreis
- **Benachrichtigungen** bei Zahlungen, Tickets und Angebotsantworten
- Positionsrabatte auf dem PDF mit Euro-Betrag und Positionssumme, Belegrabatt als „Rabatt 10 %“
- § 19-Hinweis: „Steuerbefreiung für Kleinunternehmer gemäß § 19 UStG.“
- XRechnung: Verkäuferkennung auch ohne USt-IdNr. (BR-CO-26)
- GiroCode mit Ruhezone, Infoblock und Seitenzahlen überlappen nicht mehr
- Datensicherung enthält alle Bereiche inkl. Belege und Dokumente

## 0.7.0 – Oktober 2026

- Kundenportal mit persönlichem Link: Rechnungen, Angebote, Anfragen
- Anfrage-Formular für die Website (iframe oder eigenes Formular), Spam-Schutz
- Online-Zahlung über Stripe mit Webhook, PayPal.me, Zahlungsseite mit GiroCode
- Stripe-Auszahlungen werden im Kontoauszug erkannt

## 0.6.0 – September 2026

- Zeiterfassung mit Stoppuhr, Projekten, Budget und Abrechnung
- Ausgaben mit Belegen, Abbuchungen aus dem Konto, gelernte Empfänger
- Auswertung: EÜR, Umsatzsteuer je Quartal, Kleinunternehmergrenze, DATEV-Export
- Tickets: nur Kunden, Absage-Mail, Prioritäten, Kategorien, Auto-Schließen, Zeit & Material abrechnen

## 0.5.0 – September 2026

- Angebote mit Online-Annahme, Angebot → Rechnung
- Abo-Rechnungen mit Leistungszeitraum und Nachholen
- Mahnstufen mit Gebühren und Verzugszinsen
- GiroCode auf Rechnungen und Mahnungen

## 0.4.0 – August 2026

- Automatischer Kontoabruf über Enable Banking (PSD2)
- Teilzahlungen mit eigener Mail und Restbetrag
- Doppelte Zahlungen und doppelte Bestätigungen werden verhindert

## 0.3.0 – Juli 2026

- Ticket-Postfach mit Filter, Antworten aus der App
- Zahlungsabgleich per CAMT, MT940 und CSV
- Datensicherung als JSON (zusammenführen oder ersetzen)
- Gründe für 0 % Umsatzsteuer, Adresszusatz, Hell/Dunkel

## 0.2.0 – Juli 2026

- XRechnung 3.0
- Einnahmen mit Kategorien und CSV-Export
- Benutzer mit Einladungscode, Rollen
- Desktop-Builds und Releases über GitHub Actions

## 0.1.0 – Juni 2026

- Kunden, Produkte, Rabatte
- Rechnungen mit PDF, Storno, automatischem Mailversand und Zahlungserinnerung
- Server mit Docker, Discovery und mehreren Verbindungsprofilen in der App
