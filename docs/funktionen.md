# Funktionen

## Kunden, Produkte, Rabatte

- Kunden mit Nummer, Ansprechpartner, Adresse, USt-IdNr., Leitweg-ID, Stundensatz, Standard-Absender und Notizen. Die Kundenseite zeigt Umsatz, offene Posten, Rechnungen, Verträge, Tickets, Projekte, Zahlungen und Mails.
- Kunden mit Rechnungen werden archiviert statt gelöscht.
- Produkte und Leistungen mit Artikelnummer, Einheit, Nettopreis und Steuersatz.
- Rabatte in Prozent oder als Betrag – für alle, einen Kunden oder ein Produkt, mit Code, Mindestbestellwert und Zeitraum. Kunden werden auf Wunsch per Mail informiert.

## Rechnungen

- Entwurf → Ausstellen (fortlaufende Nummer, alle Daten werden eingefroren) → Zahlung → bezahlt. Ausgestellte Rechnungen lassen sich nur noch stornieren.
- Positionsrabatte erscheinen auf dem PDF nachvollziehbar: voller Preis, „Rabatt 10 %“ mit Betrag in Euro, Summe der Position. Belegrabatte stehen als „Rabatt 10 %“ mit Euro-Betrag bei den Summen.
- Mehrere Steuersätze, Leistungsdatum oder -zeitraum, Kopie als Vorlage.
- PDF nach DIN 5008 mit Logo, eingebetteter Schrift und GiroCode. Drei Designs: *Klassisch*, *Modern*, *Schlicht*.
- ZUGFeRD 2 (PDF/A-3) ist Standard, XRechnung 3.0 zusätzlich als Anhang oder Download – siehe [e-rechnung.md](e-rechnung.md).
- 0 % Umsatzsteuer nur mit Grund: Kleinunternehmer (§ 19), steuerfrei (§ 4), Reverse Charge (§ 13b), EU-Leistung (§ 3a), innergemeinschaftliche Lieferung, Ausfuhr, Nullsatz. Die Texte sind einstellbar.
- Rechnungen gehen beim Ausstellen automatisch per Mail raus, mit Zahlungslink, wenn Online-Zahlung eingerichtet ist.

## Angebote

- Eigener Nummernkreis, Gültigkeit, Einleitung und Bedingungen.
- Beim Versand bekommt der Kunde einen Link: Angebot im Browser ansehen, mit Namen annehmen oder ablehnen. Kontor meldet die Antwort per Mail und legt auf Wunsch gleich den Rechnungsentwurf an.

## Verträge

- Wartung, Hosting, Betreuung: Beginn, Mindestlaufzeit, automatische Verlängerung, Kündigungsfrist in Tagen, Wochen oder Monaten, Abrechnungsrhythmus, Leistungen, Ansprechpartner, unterschriebenes PDF.
- Kontor rechnet Mindestlaufzeit, nächstes mögliches Vertragsende und den letzten Tag für die Kündigung selbst aus.
- Übersicht: monatliche Einnahmen (netto), aufs Jahr gerechnet, Prognose für 12 Monate, wer welchen Vertrag hat, bald ablaufende Kündigungsfristen und auslaufende Verträge.
- Erinnerung per Mail vor Ablauf einer Kündigungsfrist.
- Kündigung erfassen (vom Kunden oder von uns, mit Zugangsdatum) – das Vertragsende wird berechnet, eine abweichende Sonderkündigung ist möglich. Kündigungen lassen sich zurücknehmen.
- Verknüpfte Abo-Rechnung: Kontor rechnet den Vertrag automatisch ab. Preisänderungen und das Vertragsende gehen an die Abrechnung über.

## Abo-Rechnungen

- Monatlich, vierteljährlich, halbjährlich, jährlich, mit Stichtag und Ende.
- Platzhalter wie `{monthName} {year}` oder `{period}` in Betreff und Positionen.
- Ausstellen und versenden oder nur Entwurf. Verpasste Termine (Server war aus) werden nachgeholt.

## Mahnwesen

- Automatische Zahlungserinnerung nach Fälligkeit.
- Mahnstufen mit Gebühren, Verzugszinsen nach § 288 BGB (Basiszins + 5 bzw. + 9 Prozentpunkte) und Verzugspauschale bei Geschäftskunden.
- Mahnung als PDF mit Forderungsaufstellung, per Mail oder für den Postversand.

## Zahlungsabgleich und Einnahmen

- Kontoabruf per PSD2 über Enable Banking (z. B. N26, Sparkasse, Volksbank) – siehe [kontoabruf.md](kontoabruf.md) – oder Import von CAMT.052/053/054, MT940 und CSV der gängigen Banken.
- Rechnungsnummer im Verwendungszweck → wird automatisch gebucht, auch Sammelzahlungen. Treffer nur über Betrag und Name → Vorschlag.
- Teilzahlungen werden gebucht, der Kunde bekommt eine Mail mit dem Restbetrag.
- Dieselbe Zahlung zweimal (Datei und Kontoabruf, oder erst von Hand) wird erkannt, jede Zahlung wird genau einmal bestätigt.
- Abbuchungen landen unter *Ausgaben*; bekannte Empfänger werden automatisch gebucht. Stripe-Auszahlungen werden ignoriert, weil die Zahlungen schon einzeln gebucht sind.
- Einnahmen ohne Rechnung von Hand, Kategorien, CSV-Export.

## Online-Zahlung

- Jede offene Rechnung hat eine Zahlungsseite: Stripe (Karte, Apple Pay, Google Pay, PayPal, Klarna, SEPA – je nach Stripe-Konto), PayPal.me und Überweisung mit GiroCode.
- Bezahlt der Kunde über Stripe, ist die Rechnung sofort bezahlt und die Bestätigung geht raus.
- Einrichtung: [online-zahlung.md](online-zahlung.md)

## Tickets

- Eigenes Postfach (z. B. `support@firma.de`) per IMAP. Antworten gehen per SMTP aus der App, Rückantworten landen im selben Ticket.
- Filter gegen Werbung, Newsletter, Phishing und Abwesenheitsnotizen; Aussortiertes lässt sich mit einem Klick doch übernehmen.
- Einstellbar: nur Kunden (auch Kollegen mit derselben Firmen-Domain), Nicht-Kunden still aussortieren oder mit Absage antworten, Anhänge an/aus und Größenlimit, Team benachrichtigen, automatisch zuweisen, Standard-Priorität, Kategorien, Wiedereröffnen oder neues Ticket nach X Tagen, „Wartet auf Kunde“ nach X Tagen schließen.
- Kategorie und Priorität aus dem Betreff: „[Fehler] …“ setzt die Kategorie, „dringend“ hebt die Priorität.
- Zeit und Material direkt am Ticket erfassen und mit einem Klick als Rechnung stellen.

## Kundenportal und Website-Formular

- Persönlicher Link je Kunde ohne Passwort: offene und bezahlte Rechnungen mit PDF und Bezahlen-Knopf, Angebote zum Annehmen, Anfragen mit Verlauf und Antwortfeld.
- Anfrage-Formular für die eigene Website, als iframe oder eigenes Formular. Spam-Schutz eingebaut, „nur Kunden“ möglich.
- Details: [kundenportal.md](kundenportal.md)

## Zeiterfassung

- Stoppuhr in der Seitenleiste, Zeiten nachtragen, Projekte mit Stundensatz und Budget.
- Stundensatz: Eintrag → Projekt → Kunde → Standard.
- Abrechnen mit Rundung (auf, kaufmännisch, minutengenau, Takt frei) und Gruppierung (je Eintrag, Tag oder Projekt).

## Ausgaben und Auswertung

- Belege per Drag & Drop (PDF, Bild), Kategorien mit SKR03/SKR04-Konto und absetzbarem Anteil.
- Auswertung je Jahr, Quartal oder Zeitraum: Betriebseinnahmen, -ausgaben, Gewinn, Umsatzsteuer je Quartal, Einnahmen nach Steuersatz, Kleinunternehmergrenze (25.000 € Vorjahr / 100.000 € laufendes Jahr).
- Export als Journal (CSV) und als DATEV-Buchungsstapel für die Steuerberatung.

## Mehrere Firmen

- *Einstellungen → Weitere Firmen*: zweites Gewerbe oder eigene Marke mit abweichendem Namen, Adresse, Bank, Logo, Akzentfarbe, Umsatzsteuer-Status und auf Wunsch eigenem Rechnungsnummernkreis.
- Kunden bekommen einen Standard-Absender, Rechnungen und Angebote eine Auswahl „Absender“. Stornos kommen immer vom selben Absender wie die Rechnung.

## Benachrichtigungen

- Zahlungseingänge, neue Tickets, Kundenantworten und Angebotsantworten erscheinen als Windows-Benachrichtigung, wenn Kontor im Hintergrund ist, sonst oben rechts in der App. Je PC einstellbar.

## Benutzer und Bedienung

- Rollen Administrator und Mitarbeiter, Einladung per Code, Sperren.
- Hell, Dunkel oder wie das System. Schnellsuche mit `Strg+K`.
- Datensicherung als JSON in der App, Mail-Protokoll mit allen versendeten Mails und Fehlern.
