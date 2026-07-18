/**
 * Entscheidet, ob eine eingehende Mail ein Ticket wird.
 * Punktesystem: positive Punkte sprechen für Werbung/Spam, negative für ein echtes Anliegen.
 * Jede Entscheidung liefert lesbare Gründe, damit aussortierte Mails nachvollziehbar sind.
 */

export interface MailFacts {
  fromEmail: string;
  fromName: string | null;
  subject: string;
  text: string;
  html: string | null;
  headers: Map<string, unknown>;
  attachmentCount: number;
}

export interface FilterContext {
  ownAddress: string;
  knownCustomer: boolean;
  level: "low" | "normal" | "strict";
  onlyKnownCustomers: boolean;
  allowSenders: string[];
  blockSenders: string[];
}

export interface FilterResult {
  accept: boolean;
  score: number;
  reasons: string[];
  /** Kurzbegründung für die Liste der aussortierten Mails */
  verdict: string;
}

const THRESHOLD = { low: 7, normal: 4, strict: 2 } as const;

const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");

const AD_WORDS = [
  "newsletter",
  "abmelden",
  "abbestellen",
  "unsubscribe",
  "nicht mehr erhalten",
  "im browser anzeigen",
  "view in browser",
  "jetzt kaufen",
  "jetzt bestellen",
  "jetzt sichern",
  "nur fuer kurze zeit",
  "nur heute",
  "gutscheincode",
  "gratis",
  "% rabatt",
  "webinar",
  "black friday",
  "cyber monday",
  " sale ",
  "seo-",
  " seo ",
  "backlinks",
  "google ranking",
  "erste seite bei google",
  "kooperationsanfrage",
  "partnerprogramm",
  "affiliate",
  "bitcoin",
  "krypto",
  "crypto",
  "gewinnspiel",
  "sie haben gewonnen",
  "lotterie",
  "erbschaft",
  "exklusiv fuer sie",
  "limited offer",
  "special offer",
  "click here",
  "hier klicken",
  "business proposal",
  "lead generation",
  "website redesign",
  "guest post",
  "gastbeitrag",
  "first page of google",
  "seo services",
  "rank your website",
  "increase your traffic",
  "mehr traffic",
  "mehr kunden gewinnen",
  "we are a leading",
  "outsourcing",
];

const PHISHING = [
  "konto wurde gesperrt",
  "konto gesperrt",
  "verify your account",
  "bestaetigen sie ihre identitaet",
  "passwort laeuft ab",
  "password expires",
  "unusual sign-in",
  "ungewoehnliche anmeldung",
  "postfach ist voll",
  "mailbox is full",
];

const SUPPORT_WORDS = [
  "problem",
  "fehler",
  "funktioniert nicht",
  "geht nicht",
  "hilfe",
  "frage",
  "rechnung",
  "support",
  "defekt",
  "stoerung",
  "kaputt",
  "anfrage",
  "termin",
  "reklamation",
  "fehlermeldung",
  "koennen sie",
  "koennten sie",
  "ich habe",
  "wir haben",
  "auftrag",
  "bestellung",
  "lieferung",
  "rueckruf",
  "dringend",
  "angebot fuer",
  "kostenvoranschlag",
  "reparatur",
  "wartung",
];

const ESP_HEADERS = [
  "x-mailchimp",
  "x-mc-user",
  "x-campaign",
  "x-campaignid",
  "x-cmail",
  "x-cleverreach",
  "x-newsletter",
  "x-mailjet-campaign",
  "x-sib-id",
  "x-sfmc-stack",
  "x-rapidmail",
  "x-klaviyo",
];

function header(h: Map<string, unknown>, key: string): string {
  const v = h.get(key);
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && v && "value" in v) return String((v as { value: unknown }).value);
  return String(v);
}

/** Eintrag "name@firma.de" passt genau, "@firma.de" oder "firma.de" auf die ganze Domain */
export function senderMatches(list: string[], email: string): boolean {
  const e = email.toLowerCase();
  const domain = e.split("@")[1] ?? "";
  return list.some((raw) => {
    const x = raw.trim().toLowerCase();
    if (!x) return false;
    if (x.includes("@") && !x.startsWith("@")) return x === e;
    const d = x.replace(/^@/, "");
    return domain === d || domain.endsWith(`.${d}`);
  });
}

export function isAutoReply(m: Pick<MailFacts, "headers" | "subject">): boolean {
  const auto = header(m.headers, "auto-submitted").toLowerCase();
  if (auto && auto !== "no") return true;
  if (m.headers.has("x-autoreply") || m.headers.has("x-autorespond")) return true;
  if (header(m.headers, "precedence").toLowerCase() === "auto_reply") return true;
  return /^(automatische antwort|abwesenheitsnotiz|out of office|autoreply|auto-reply|automatic reply|abwesend)/i.test(m.subject.trim());
}

export function classify(m: MailFacts, ctx: FilterContext): FilterResult {
  const reasons: string[] = [];
  const email = m.fromEmail.toLowerCase();
  const local = email.split("@")[0] ?? "";
  const reject = (verdict: string, score = 99): FilterResult => ({ accept: false, score, reasons: [...reasons, verdict], verdict });

  if (ctx.ownAddress && email === ctx.ownAddress.toLowerCase()) return reject("Mail von der eigenen Ticket-Adresse");
  if (senderMatches(ctx.blockSenders, email)) return reject("Absender steht auf der Sperrliste");
  if (/^(mailer-daemon|postmaster)$/.test(local)) return reject("Zustellfehler / Unzustellbarkeitsmeldung");
  if (isAutoReply(m)) return reject("Automatische Antwort (Abwesenheitsnotiz)");
  const spamFlag = header(m.headers, "x-spam-flag").toLowerCase();
  const spamStatus = header(m.headers, "x-spam-status").toLowerCase();
  if (spamFlag === "yes" || spamStatus.startsWith("yes")) return reject("Vom Mailserver als Spam markiert");

  if (senderMatches(ctx.allowSenders, email)) return { accept: true, score: -99, reasons: ["Absender steht auf der Erlaubt-Liste"], verdict: "Erlaubt" };
  if (ctx.onlyKnownCustomers && !ctx.knownCustomer) return reject("Absender ist kein bekannter Kunde");

  let score = 0;
  let ticketSignals = 0;
  const add = (n: number, why: string) => {
    score += n;
    reasons.push(`${n > 0 ? "+" : ""}${n} ${why}`);
  };

  if (ctx.knownCustomer) {
    add(-5, "Absender ist Kunde");
    ticketSignals++;
  }

  // Massenversand-Kennzeichen
  if (m.headers.has("list-unsubscribe") || m.headers.has("list-id")) add(6, "Newsletter-Kopfzeilen (List-Unsubscribe/List-Id)");
  else {
    const prec = header(m.headers, "precedence").toLowerCase();
    if (["bulk", "list", "junk"].includes(prec)) add(4, `Massenversand (Precedence: ${prec})`);
  }
  if (ESP_HEADERS.some((h) => m.headers.has(h))) add(3, "Versand über Newsletter-Dienst");
  if (/^(no-?reply|do-?not-?reply|newsletter|news|marketing|promo|angebote|mailing)([._-]|$)/.test(local)) add(3, `Absenderadresse ${local}@…`);

  const body = ` ${fold(`${m.subject}\n${m.text}`).replace(/\s+/g, " ")} `;
  const ads = AD_WORDS.filter((w) => body.includes(w));
  if (ads.length) add(Math.min(6, ads.length), `Werbebegriffe: ${ads.slice(0, 4).map((a) => a.trim()).join(", ")}`);
  const phish = PHISHING.filter((w) => body.includes(w));
  if (phish.length) add(4, `Phishing-typisch: ${phish[0]}`);

  const links = (`${m.text} ${m.html ?? ""}`.match(/https?:\/\//g) ?? []).length;
  if (links > 25) add(3, `${links} Links`);
  else if (links > 10) add(2, `${links} Links`);
  if (m.html && m.html.length > 20_000 && m.text.replace(/\s+/g, " ").length < 400) add(2, "Fast nur Grafik/HTML, kaum Text");

  const support = SUPPORT_WORDS.filter((w) => body.includes(w));
  if (support.length) {
    add(-Math.min(4, support.length), `Anliegen erkennbar: ${support.slice(0, 3).join(", ")}`);
    ticketSignals++;
  }
  if (/\?/.test(m.text) && m.text.length < 5000) {
    add(-1, "Enthält eine Frage");
    ticketSignals++;
  }

  if (!m.text.trim() && !m.attachmentCount) return reject("Leere Nachricht", score);
  if (score >= THRESHOLD[ctx.level]) {
    const main = reasons.filter((r) => r.startsWith("+")).map((r) => r.replace(/^\+\d+ /, ""));
    return { accept: false, score, reasons, verdict: main[0] ?? "Sieht nach Werbung aus" };
  }
  if (ctx.level === "strict" && ticketSignals === 0) {
    return { accept: false, score, reasons: [...reasons, "Kein erkennbares Anliegen"], verdict: "Kein erkennbares Anliegen" };
  }
  return { accept: true, score, reasons, verdict: "Anfrage" };
}

/** Zitierten Verlauf bei Antworten abschneiden ("Am … schrieb …", "-----Ursprüngliche Nachricht-----" …) */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const markers = [
    /^\s*am .{4,120}schrieb.{0,120}:\s*$/i,
    /^\s*on .{4,120}wrote:\s*$/i,
    /^\s*-{2,}\s*(urspr(ü|ue)ngliche nachricht|original message)\s*-{2,}/i,
    /^\s*von:\s.+/i,
    /^\s*from:\s.+@/i,
    /^\s*_{10,}\s*$/,
  ];
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (markers.some((r) => r.test(lines[i]))) {
      cut = i;
      break;
    }
    if (/^\s*>/.test(lines[i]) && lines.slice(i).every((l) => !l.trim() || /^\s*>/.test(l))) {
      cut = i;
      break;
    }
  }
  const head = lines.slice(0, cut).join("\n").trim();
  return head || text.trim();
}
