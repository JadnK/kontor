# Online-Zahlung

Jede offene Rechnung bekommt eine Zahlungsseite `https://<PUBLIC_URL>/pay/<code>`. Der Link steht automatisch in Rechnungs- und Erinnerungsmails (vor dem Gruß) und auf dem PDF. Im Kundenportal hat jede offene Rechnung einen *Bezahlen*-Knopf.

Auf der Seite gibt es, je nach Einrichtung:

- **Online bezahlen** über Stripe – Karte, Apple Pay, Google Pay und alles, was im Stripe-Konto freigeschaltet ist (z. B. PayPal, Klarna, SEPA-Lastschrift)
- **PayPal** über einen einfachen PayPal.me-Link
- **Überweisung** mit Bankdaten und GiroCode

Teilbezahlte Rechnungen zeigen nur den Restbetrag.

## Stripe einrichten

1. Konto auf [stripe.com](https://stripe.com) anlegen und verifizieren.
2. *Einstellungen → Zahlungsmethoden*: gewünschte Verfahren aktivieren.
3. *Entwickler → API-Schlüssel*: den **geheimen Schlüssel** (`sk_live_…`) kopieren.
4. *Entwickler → Webhooks → Endpunkt hinzufügen*:
   - URL: wird in Kontor unter *Einstellungen → Online-Zahlung* angezeigt (`https://<PUBLIC_URL>/api/payments/stripe/webhook`)
   - Ereignisse: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`
   - das **Signatur-Secret** (`whsec_…`) kopieren
5. In Kontor unter *Einstellungen → Online-Zahlung*: Stripe einschalten, beide Werte eintragen, speichern, *Verbindung prüfen*.

Zum Ausprobieren funktionieren auch Test-Schlüssel (`sk_test_…`) mit den Testkarten von Stripe.

### Was passiert bei einer Zahlung

1. Kunde klickt *Jetzt bezahlen* → Kontor legt eine Stripe-Checkout-Sitzung über den offenen Betrag an.
2. Nach der Zahlung meldet Stripe das per Webhook. Kontor bucht die Zahlung als Einnahme („Online (Stripe)“), die Rechnung ist bezahlt, die Zahlungsbestätigung geht raus.
3. Ohne Webhook bucht Kontor, sobald der Kunde auf die Rechnungsseite zurückkehrt. Mit Webhook klappt es immer – auch bei SEPA-Lastschrift, die erst nach Tagen bestätigt wird.

Jede Zahlung wird genau einmal gebucht, auch wenn Webhook und Rückkehr gleichzeitig ankommen.

### Auszahlungen und Gebühren

Stripe überweist gesammelt und zieht die Gebühren ab. Diese Sammelüberweisung erkennt Kontor im Kontoauszug und ignoriert sie, weil die einzelnen Zahlungen schon gebucht sind (abschaltbar). Die Stripe-Gebühren als Ausgabe erfassen, Kategorie *Bankgebühren* – Stripe schickt dafür monatlich eine Rechnung.

## PayPal.me

*Einstellungen → Online-Zahlung → PayPal*: nur den Namen hinter `paypal.me/` eintragen. Die Seite zeigt dann einen Link mit dem offenen Betrag. Diese Zahlungen kommen nicht automatisch an – sie werden wie eine Überweisung von Hand eingetragen. Wer PayPal mit automatischer Buchung will, schaltet PayPal in Stripe frei.
