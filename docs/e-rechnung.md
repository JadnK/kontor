# E-Rechnung

Kontor erzeugt beide in Deutschland üblichen Formate. Beide basieren auf UN/CEFACT CII und der Norm EN 16931.

| Format | Was | Wofür |
|---|---|---|
| **ZUGFeRD 2 / Factur-X** | PDF/A-3 mit eingebetteter `factur-x.xml`, Profil EN 16931 | Standard für Geschäftskunden – sieht aus wie ein normales PDF, Buchhaltungsprogramme lesen die Daten automatisch |
| **XRechnung 3.0** | reine XML-Datei | öffentliche Auftraggeber (Leitweg-ID), Kunden, die ausdrücklich XRechnung verlangen |

## Einstellungen

*Einstellungen → Rechnungen & Steuer → E-Rechnung*

- **Rechnungs-PDF als ZUGFeRD erzeugen** – an (Standard). Gilt für alle ausgestellten Rechnungen und Stornos, nicht für Entwürfe, Angebote und Mahnungen.
- **XRechnung an Rechnungsmails anhängen** – zusätzlich die XML-Datei mitschicken.

Die XRechnung gibt es außerdem in jeder Rechnung unter *E-Rechnung (XML) speichern*.

## Pflichtangaben für eine gültige E-Rechnung

Fehlende Angaben zeigt Kontor bei der ausgestellten Rechnung an. Wichtig:

- **Verkäuferkennung (BR-CO-26):** Mindestens eine von USt-IdNr., Handelsregisternummer oder einer Verkäuferkennung muss enthalten sein. Ohne USt-IdNr. (typisch bei Kleinunternehmern) setzt Kontor die Steuernummer als Verkäuferkennung (BT-29) und – falls hinterlegt – Registergericht und -nummer (BT-30).
- **Kontakt des Verkäufers:** Telefon und E-Mail unter *Einstellungen → Firma*.
- **Leitweg-ID** beim Kunden, wenn an eine Behörde geliefert wird.
- **Grund für 0 % Umsatzsteuer** bei steuerfreien Positionen (wird beim Ausstellen erzwungen).

## Prüfen

Die erzeugten Dateien bestehen den offiziellen [KoSIT-Validator](https://github.com/itplr-kosit/validator) mit der XRechnung-Konfiguration – getestet mit Standard-, Kleinunternehmer-, Rabatt-, Storno- und 0 %-Rechnungen.

Selbst prüfen:

```bash
java -jar validationtool-standalone.jar -s scenarios.xml -r <konfiguration> rechnung.xml
```

Für ZUGFeRD-PDFs eignet sich z. B. der [Mustang-Validator](https://www.mustangproject.org/) oder das Online-Prüfportal von FeRD.

## Hintergrund

- Seit 2025 müssen Unternehmen in Deutschland E-Rechnungen empfangen können.
- Die Pflicht zum Versenden greift gestaffelt: ab 2027 bei mehr als 800.000 € Vorjahresumsatz, ab 2028 für alle.
- Kleinunternehmer sind vom Versenden ausgenommen, Kontor erzeugt ZUGFeRD trotzdem – schadet nicht und spart Rückfragen.
