import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { formatMoney, formatDiscount } from "./calc.js";
import { formatDate } from "./http.js";
import { customerDisplayName, type InvoiceDoc } from "./invoice-service.js";
import type { Settings } from "./settings.js";
import { renderXRechnung } from "./xrechnung.js";

const MM = 72 / 25.4;
const PAGE_W = 210 * MM;
const PAGE_H = 297 * MM;
const LEFT = 25 * MM;
const RIGHT = PAGE_W - 20 * MM;
const CONTENT_W = RIGHT - LEFT;
const FOOTER_TOP = PAGE_H - 30 * MM;
const INK = "#1b1b1b";
const MUTED = "#6b6b6b";
const RULE = "#d6d6d6";
const QR = 27 * MM;

/** Eingebettete Schrift (Arimo, metrisch gleich Helvetica/Arial) – nötig für PDF/A und Sonderzeichen aller Sprachen */
const FONT_DIR = fileURLToPath(new URL("../../assets/fonts/", import.meta.url));
const FONT_FILES = { regular: `${FONT_DIR}Arimo-Regular.ttf`, bold: `${FONT_DIR}Arimo-Bold.ttf` };
const HAS_FONTS = existsSync(FONT_FILES.regular) && existsSync(FONT_FILES.bold);
const FR = "Body";
const FB = "Body-Bold";

export type InvoiceDesign = "classic" | "modern" | "minimal";

function qty(n: number) {
  return n.toLocaleString("de-DE", { maximumFractionDigits: 3 });
}

export interface DunningInfo {
  label: string;
  level: number;
  date: string;
  open: number;
  fees: number;
  interest: number;
  interestRate: number | null;
  interestDays: number | null;
  flatFee: number;
  claim: number;
  payUntil: string;
}

export interface PdfOptions {
  /** Angebot statt Rechnung */
  quote?: { validUntil: string | null; acceptUrl: string | null };
  /** Mahnung zur Rechnung */
  dunning?: DunningInfo;
  /** Link zur Online-Zahlung */
  payUrl?: string | null;
  /** ZUGFeRD/Factur-X: CII-XML einbetten, PDF wird PDF/A-3b */
  zugferd?: string | null;
}

/**
 * GiroCode (EPC069-12): Banking-Apps füllen damit Empfänger, IBAN, Betrag und Verwendungszweck aus.
 * Nur für EUR-Überweisungen an eine SEPA-IBAN.
 */
export function epcPayload(company: Settings["company"], amountCents: number, reference: string): string | null {
  const iban = company.iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return null;
  if (amountCents <= 0 || amountCents > 99_999_999_999) return null;
  const name = (company.name || company.owner).trim().slice(0, 70);
  if (!name) return null;
  const bic = company.bic.replace(/\s+/g, "").toUpperCase();
  return [
    "BCD",
    "002",
    "1",
    "SCT",
    /^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(bic) ? bic : "",
    name,
    iban,
    `EUR${(amountCents / 100).toFixed(2)}`,
    "",
    "",
    reference.slice(0, 140),
  ].join("\n");
}

async function giroCode(company: Settings["company"], amount: number, reference: string): Promise<Buffer | null> {
  const payload = epcPayload(company, amount, reference);
  if (!payload) return null;
  try {
    // Fehlerkorrektur M ist von der EPC-Richtlinie vorgegeben
    // Ruhezone (2 Module) gehört zum Code – sonst scheitern manche Banking-Apps an Linien oder Text daneben
    return await QRCode.toBuffer(payload, { errorCorrectionLevel: "M", margin: 2, width: 320, type: "png" });
  } catch {
    return null;
  }
}

export async function renderInvoicePdf(doc: InvoiceDoc, opts: PdfOptions = {}): Promise<Buffer> {
  const { invoice: inv, items, customer, company, invoiceSettings: st } = doc;
  const cur = st.currency;
  const accent = st.accentColor;
  const quote = opts.quote;
  const dun = opts.dunning;
  const isStorno = inv.kind === "CANCELLATION" && !quote;
  const title = dun
    ? dun.label
    : quote
      ? inv.status === "DRAFT"
        ? "Angebot (Entwurf)"
        : "Angebot"
      : isStorno
        ? "Stornorechnung"
        : inv.status === "DRAFT"
          ? "Rechnung (Entwurf)"
          : "Rechnung";

  // GiroCode: offener Betrag der Rechnung bzw. Gesamtforderung der Mahnung
  let qr: Buffer | null = null;
  if (st.showGiroCode !== false && !quote && !isStorno && cur === "EUR") {
    const amount = dun ? dun.claim : inv.totalGross - inv.paidTotal;
    if (amount > 0 && inv.number) qr = await giroCode(company, amount, `${inv.number}${customer.number ? ` ${customer.number}` : ""}`);
  }

  const design: InvoiceDesign = st.design ?? "classic";
  // ZUGFeRD: ausgestellte Rechnungen bekommen die Rechnungsdaten eingebettet (nicht Angebot, Mahnung, Entwurf)
  const wantZugferd = opts.zugferd !== undefined ? opts.zugferd : st.zugferd !== false && !quote && !dun && inv.status !== "DRAFT" && !!inv.number ? renderXRechnung(doc, "en16931") : null;
  const zugferd = wantZugferd && HAS_FONTS ? wantZugferd : null;
  const pdf = new PDFDocument({
    size: "A4",
    margins: { top: 20 * MM, bottom: 32 * MM, left: LEFT, right: PAGE_W - RIGHT },
    info: { Title: `${title} ${dun ? "" : (inv.number ?? "")}`.trim(), Author: company.name || "Kontor", Creator: "Kontor", Producer: "Kontor" },
    bufferPages: true,
    ...(zugferd ? { pdfVersion: "1.7" as const, subset: "PDF/A-3b" as const, lang: "de-DE" } : {}),
  });
  if (HAS_FONTS) {
    pdf.registerFont(FR, FONT_FILES.regular);
    pdf.registerFont(FB, FONT_FILES.bold);
  } else {
    pdf.registerFont(FR, "Helvetica");
    pdf.registerFont(FB, "Helvetica-Bold");
  }
  if (zugferd) {
    const now = new Date();
    pdf.file(Buffer.from(zugferd, "utf8"), {
      name: "factur-x.xml",
      type: "text/xml",
      relationship: "Alternative",
      description: "Factur-X/ZUGFeRD-Rechnungsdaten",
      creationDate: now,
      modifiedDate: now,
    } as Parameters<typeof pdf.file>[1] & { relationship: string });
    pdf.appendXML(FACTURX_XMP);
  }
  if (design === "modern") {
    // Farbband oben über die ganze Breite
    pdf.rect(0, 0, PAGE_W, 6 * MM).fill(accent);
  }
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on("end", () => resolve(Buffer.concat(chunks))));

  // ---------- Kopf ----------
  if (company.logo?.startsWith("data:image/")) {
    try {
      const b64 = company.logo.split(",")[1];
      pdf.image(Buffer.from(b64, "base64"), RIGHT - 55 * MM, 15 * MM, { fit: [55 * MM, 22 * MM], align: "right" });
    } catch {
      /* ungültiges Logo ignorieren */
    }
  } else if (company.name) {
    pdf.font(FB).fontSize(14).fillColor(accent).text(company.name, LEFT, 20 * MM, {
      width: CONTENT_W,
      align: "right",
    });
  }

  // Absenderzeile über dem Adressfeld (DIN 5008)
  const senderLine = [company.name, company.addressAddition, company.street, [company.zip, company.city].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  pdf.font(FR).fontSize(7).fillColor(MUTED).text(senderLine, LEFT, 47 * MM, { width: 85 * MM });
  pdf
    .moveTo(LEFT, 50.5 * MM)
    .lineTo(LEFT + 85 * MM, 50.5 * MM)
    .lineWidth(0.4)
    .strokeColor(RULE)
    .stroke();

  // Empfänger
  const name = customerDisplayName(customer);
  const contact = customer.type === "COMPANY" ? [customer.firstName, customer.lastName].filter(Boolean).join(" ") : "";
  const addr = [
    name,
    contact,
    customer.street,
    [customer.zip, customer.city].filter(Boolean).join(" "),
    customer.country && customer.country !== "DE" ? customer.country : "",
  ].filter(Boolean) as string[];
  pdf.font(FR).fontSize(10).fillColor(INK).text(addr.join("\n"), LEFT, 53 * MM, { width: 85 * MM, lineGap: 1.5 });

  // Infoblock rechts
  const info: [string, string][] = [];
  if (dun) {
    info.push(["Datum", formatDate(dun.date)]);
    info.push(["Rechnungs-Nr.", inv.number ?? "—"]);
    info.push(["Rechnungsdatum", formatDate(inv.issueDate)]);
    if (inv.dueDate) info.push(["Fällig seit", formatDate(inv.dueDate)]);
  } else if (quote) {
    info.push(["Angebots-Nr.", inv.number ?? "—"]);
    info.push(["Datum", formatDate(inv.issueDate) || "—"]);
    if (quote.validUntil) info.push(["Gültig bis", formatDate(quote.validUntil)]);
  } else {
    info.push([isStorno ? "Storno-Nr." : "Rechnungs-Nr.", inv.number ?? "—"]);
    info.push(["Datum", formatDate(inv.issueDate) || "—"]);
    if (isStorno && doc.original?.number) info.push(["Zu Rechnung", doc.original.number]);
  }
  if (!dun && st.showServiceDate && inv.serviceDateFrom) {
    info.push([
      inv.serviceDateTo && inv.serviceDateTo !== inv.serviceDateFrom ? "Leistungszeitraum" : "Leistungsdatum",
      inv.serviceDateTo && inv.serviceDateTo !== inv.serviceDateFrom
        ? `${formatDate(inv.serviceDateFrom)} – ${formatDate(inv.serviceDateTo)}`
        : formatDate(inv.serviceDateFrom),
    ]);
  }
  info.push(["Kunden-Nr.", customer.number]);
  if (customer.vatId && !dun) info.push(["USt-IdNr. Kunde", customer.vatId]);
  if (!isStorno && !quote && !dun && inv.dueDate) info.push(["Fällig am", formatDate(inv.dueDate)]);

  // Infoblock: Beschriftung links, Wert rechtsbündig; passt beides nicht in eine Zeile, rutscht der Wert darunter
  let iy = 50 * MM;
  const ix = 120 * MM;
  const iw = RIGHT - ix;
  pdf.font(FR).fontSize(8.5);
  for (const [k, v] of info) {
    const kw = pdf.widthOfString(k);
    const vw = pdf.widthOfString(v);
    pdf.fillColor(MUTED).text(k, ix, iy, { width: iw, lineBreak: false });
    if (kw + vw + 3 * MM <= iw) {
      pdf.fillColor(INK).text(v, ix, iy, { width: iw, align: "right", lineBreak: false });
      iy += 4.6 * MM;
    } else {
      iy += 4 * MM;
      pdf.fillColor(INK).text(v, ix, iy, { width: iw, align: "right" });
      iy = pdf.y + 1.6 * MM;
    }
  }

  // ---------- Betreff / Einleitung ----------
  let y = Math.max(100 * MM, iy + 8 * MM);
  const heading = dun ? `${title} zur Rechnung ${inv.number ?? ""}` : `${title}${inv.number ? ` ${inv.number}` : ""}`;
  pdf.font(FB).fontSize(design === "minimal" ? 13 : 14).fillColor(design === "modern" ? accent : INK).text(heading, LEFT, y);
  y = pdf.y + 2 * MM;
  if (inv.subject && !dun) {
    pdf.font(FB).fontSize(10).fillColor(INK).text(inv.subject, LEFT, y, { width: CONTENT_W });
    y = pdf.y + 2 * MM;
  }
  const intro = dun
    ? `leider konnten wir zur Rechnung ${inv.number} vom ${formatDate(inv.issueDate)}${inv.dueDate ? `, fällig am ${formatDate(inv.dueDate)},` : ""} noch keinen vollständigen Zahlungseingang feststellen. Wir bitten Sie, die folgende Forderung bis zum ${formatDate(dun.payUntil)} auszugleichen.`
    : isStorno
      ? `Hiermit stornieren wir die Rechnung ${doc.original?.number ?? ""}${doc.original?.issueDate ? ` vom ${formatDate(doc.original.issueDate)}` : ""} vollständig.`
      : (inv.introText ?? (quote ? null : st.introText));
  if (intro) {
    pdf.font(FR).fontSize(10).fillColor(INK).text(intro, LEFT, y + 2 * MM, { width: CONTENT_W, lineGap: 1.5 });
    y = pdf.y + 6 * MM;
  }

  const ensure = (h: number, onNew?: () => void) => {
    if (y + h > FOOTER_TOP - 4 * MM) {
      pdf.addPage();
      y = 25 * MM;
      onNew?.();
    }
  };

  const sums: [string, string, boolean?][] = [];

  if (dun) {
    // ---------- Forderungsaufstellung ----------
    sums.push(["Rechnungsbetrag", formatMoney(inv.totalGross, cur)]);
    if (inv.paidTotal > 0) sums.push(["Bereits bezahlt", `- ${formatMoney(inv.paidTotal, cur)}`]);
    sums.push(["Offener Rechnungsbetrag", formatMoney(dun.open, cur)]);
    if (dun.fees) sums.push(["Mahngebühren", formatMoney(dun.fees, cur)]);
    if (dun.interest)
      sums.push([
        `Verzugszinsen ${dun.interestRate?.toLocaleString("de-DE", { maximumFractionDigits: 2 })} % p. a. für ${dun.interestDays} Tage (§ 288 BGB)`,
        formatMoney(dun.interest, cur),
      ]);
    if (dun.flatFee) sums.push(["Verzugspauschale (§ 288 Abs. 5 BGB)", formatMoney(dun.flatFee, cur)]);
    sums.push(["Gesamtforderung", formatMoney(dun.claim, cur), true]);
  } else {
    // ---------- Positionen ----------
    const showTax = !inv.smallBusiness && new Set(items.map((i) => i.taxRate)).size > 1;
    const cols = [
      { key: "pos", label: "Pos.", w: 11 * MM, align: "left" as const },
      { key: "name", label: "Bezeichnung", w: 0, align: "left" as const },
      { key: "qty", label: "Menge", w: 22 * MM, align: "right" as const },
      ...(showTax ? [{ key: "tax", label: "USt.", w: 12 * MM, align: "right" as const }] : []),
      { key: "price", label: "Einzelpreis", w: 25 * MM, align: "right" as const },
      { key: "total", label: "Gesamt", w: 26 * MM, align: "right" as const },
    ];
    const fixed = cols.reduce((a, c) => a + c.w, 0);
    cols[1].w = CONTENT_W - fixed;

    const header = () => {
      if (design === "modern") pdf.rect(LEFT, y, CONTENT_W, 7 * MM).fill(accent);
      else if (design === "classic") pdf.rect(LEFT, y, CONTENT_W, 7 * MM).fill("#f2f2f0");
      let x = LEFT;
      for (const c of cols) {
        pdf
          .font(FB)
          .fontSize(8.5)
          .fillColor(design === "modern" ? "#ffffff" : design === "minimal" ? MUTED : INK)
          .text(c.label, x + 1.5 * MM, y + 2.2 * MM, { width: c.w - 3 * MM, align: c.align });
        x += c.w;
      }
      if (design === "minimal") pdf.moveTo(LEFT, y + 7 * MM).lineTo(RIGHT, y + 7 * MM).lineWidth(0.8).strokeColor(INK).stroke();
      y += 9 * MM;
    };

    header();
    items.forEach((it, idx) => {
      const desc = it.description?.trim();
      // Positionsrabatt nachvollziehbar: voller Preis, Rabatt in Euro, Summe der Position
      const before = Math.round(it.quantity * it.unitPriceNet);
      const discAmount = it.discountBps ? before - it.lineNet : 0;
      const discLabel = it.discountBps ? `Rabatt ${(it.discountBps / 100).toLocaleString("de-DE", { maximumFractionDigits: 2 })} %` : "";
      const nameW = cols[1].w - 3 * MM;
      pdf.font(FB).fontSize(9);
      const hName = pdf.heightOfString(it.name, { width: nameW });
      pdf.font(FR).fontSize(8.5);
      const hDesc = desc ? pdf.heightOfString(desc, { width: nameW }) + 1 : 0;
      const lineH = pdf.currentLineHeight(true) + 1;
      const hDisc = discAmount ? lineH * 2 + 2 : 0;
      const rowH = Math.max(hName + hDesc + hDisc, 10) + 3 * MM;
      ensure(rowH, header);

      let x = LEFT;
      let discY = y;
      const totalCol = cols[cols.length - 1];
      const totalX = RIGHT - totalCol.w + 1.5 * MM;
      const totalW = totalCol.w - 3 * MM;
      for (const c of cols) {
        const tx = x + 1.5 * MM;
        const tw = c.w - 3 * MM;
        if (c.key === "name") {
          pdf.font(FB).fontSize(9).fillColor(INK).text(it.name, tx, y, { width: tw });
          if (desc) pdf.font(FR).fontSize(8.5).fillColor(MUTED).text(desc, tx, pdf.y + 1, { width: tw });
          discY = pdf.y + 2;
        } else {
          const v =
            c.key === "pos"
              ? String(idx + 1)
              : c.key === "qty"
                ? `${qty(it.quantity)} ${it.unit}`
                : c.key === "tax"
                  ? `${it.taxRate.toLocaleString("de-DE")} %`
                  : c.key === "price"
                    ? formatMoney(it.unitPriceNet, cur)
                    : formatMoney(discAmount ? before : it.lineNet, cur);
          pdf.font(FR).fontSize(9).fillColor(INK).text(v, tx, y, { width: tw, align: c.align });
        }
        x += c.w;
      }
      if (discAmount) {
        const nameX = LEFT + cols[0].w + 1.5 * MM;
        pdf.font(FR).fontSize(8.5).fillColor(INK).text(discLabel, nameX, discY, { width: nameW });
        pdf.text(`- ${formatMoney(discAmount, cur)}`, totalX, discY, { width: totalW, align: "right" });
        const sumY = discY + lineH;
        pdf.moveTo(totalX + totalW * 0.25, sumY - 1).lineTo(totalX + totalW, sumY - 1).lineWidth(0.4).strokeColor(RULE).stroke();
        pdf.font(FB).fontSize(8.5).fillColor(INK).text("Summe Position", nameX, sumY + 1, { width: nameW });
        pdf.text(formatMoney(it.lineNet, cur), totalX, sumY + 1, { width: totalW, align: "right" });
      }
      y += rowH;
      if (design !== "minimal" || idx === items.length - 1) pdf.moveTo(LEFT, y - 1.5 * MM).lineTo(RIGHT, y - 1.5 * MM).lineWidth(0.4).strokeColor(RULE).stroke();
    });

    // ---------- Summen ----------
    const netLabel = inv.smallBusiness ? "Summe" : "Summe netto";
    if (inv.discountTotal) {
      sums.push(["Zwischensumme", formatMoney(inv.subtotalNet, cur)]);
      const d = inv.discountSnapshot as { name: string; type: "PERCENT" | "FIXED"; value: number } | null;
      // „Rabatt 10 %“ als Titel, Betrag in Euro; Name nur, wenn er mehr sagt als „Rabatt“
      const pct = d?.type === "PERCENT" ? ` ${formatDiscount(d, cur)}` : "";
      const nm = d?.name && !/^rabatt$/i.test(d.name.trim()) ? ` (${d.name})` : "";
      sums.push([`Rabatt${pct}${nm}`, `- ${formatMoney(Math.abs(inv.discountTotal), cur)}`]);
    }
    if (!inv.smallBusiness) {
      sums.push([netLabel, formatMoney(inv.totalNet, cur)]);
      for (const t of (inv.taxBreakdown as { rate: number; net: number; tax: number }[] | null) ?? []) {
        sums.push([`zzgl. ${t.rate.toLocaleString("de-DE")} % USt. auf ${formatMoney(t.net, cur)}`, formatMoney(t.tax, cur)]);
      }
    }
    sums.push([quote ? "Angebotssumme" : isStorno ? "Gutschriftsbetrag" : "Rechnungsbetrag", formatMoney(inv.totalGross, cur), true]);
    if (!quote && !isStorno && inv.paidTotal > 0 && inv.paidTotal < inv.totalGross) {
      sums.push(["Bereits bezahlt", formatMoney(inv.paidTotal, cur)]);
      sums.push(["Offener Betrag", formatMoney(inv.totalGross - inv.paidTotal, cur), true]);
    }
  }

  // Summenblock rechts; GiroCode links daneben (bei Mahnungen darunter)
  const sumsH = sums.length * 6 * MM + 6 * MM;
  ensure(dun ? sumsH : Math.max(sumsH, qr ? QR + 4 * MM : 0));
  y += 2 * MM;
  const blockTop = y;
  const sx = dun ? LEFT : LEFT + CONTENT_W * 0.42;
  const sw = RIGHT - sx;
  for (const [label, value, strong] of sums) {
    if (strong) {
      pdf.moveTo(sx, y - 1 * MM).lineTo(RIGHT, y - 1 * MM).lineWidth(0.8).strokeColor(design === "minimal" ? INK : accent).stroke();
      y += 1 * MM;
    }
    pdf.font(strong ? FB : FR).fontSize(strong ? 10.5 : 9).fillColor(INK);
    pdf.text(label, sx, y, { width: sw - 32 * MM });
    pdf.text(value, RIGHT - 30 * MM, y, { width: 30 * MM, align: "right" });
    y = Math.max(pdf.y, y + 5 * MM) + 1 * MM;
  }
  if (qr) {
    let top = blockTop;
    if (dun) {
      y += 4 * MM;
      ensure(QR + 4 * MM);
      top = y;
    }
    const capW = dun ? 80 * MM : CONTENT_W * 0.42 - QR - 6 * MM;
    pdf.font(FR).fontSize(7.5);
    const capH = pdf.heightOfString("Mit der Banking-App scannen – Empfänger, Betrag und Verwendungszweck sind ausgefüllt.", { width: capW, lineGap: 1 });
    pdf.image(qr, LEFT, top, { width: QR, height: QR });
    pdf
      .font(FR)
      .fontSize(7.5)
      .fillColor(MUTED)
      .text("Mit der Banking-App scannen – Empfänger, Betrag und Verwendungszweck sind ausgefüllt.", LEFT + QR + 3 * MM, top + QR - capH, {
        width: capW,
        lineGap: 1,
      });
    y = Math.max(y, top + QR, pdf.y) + 2 * MM;
  }

  // ---------- Hinweise ----------
  const notes: string[] = [];
  if (dun) {
    notes.push(`Bitte überweisen Sie ${formatMoney(dun.claim, cur)} bis zum ${formatDate(dun.payUntil)} unter Angabe der Rechnungsnummer ${inv.number}.`);
    if (opts.payUrl) notes.push(`Online bezahlen: ${opts.payUrl}`);
    notes.push("Sollte sich Ihre Zahlung mit diesem Schreiben überschnitten haben, betrachten Sie es bitte als gegenstandslos.");
    if (st.closingText) notes.push(st.closingText);
  } else {
    // Pflichthinweis zur Umsatzsteuer (§ 19, § 4, § 13b …) immer zuerst
    if (doc.exemption) notes.push(doc.exemption.text);
    if (!quote) for (const n of st.legalNotes) if (n.trim()) notes.push(n.trim());
    if (!isStorno && inv.footerText) notes.push(inv.footerText);
    if (quote?.acceptUrl) notes.push(`Angebot online ansehen und annehmen: ${quote.acceptUrl}`);
    if (inv.notes) notes.push(inv.notes);
    if (!quote && !isStorno && opts.payUrl) notes.push(`Bequem online bezahlen: ${opts.payUrl}`);
    if (!isStorno && st.closingText) notes.push(st.closingText);
  }

  y += 5 * MM;
  for (const n of notes) {
    pdf.font(FR).fontSize(9.5);
    const h = pdf.heightOfString(n, { width: CONTENT_W, lineGap: 1.5 });
    ensure(h + 4 * MM);
    pdf.fillColor(INK).text(n, LEFT, y, { width: CONTENT_W, lineGap: 1.5 });
    y = pdf.y + 3.5 * MM;
  }

  // ---------- Fußzeile auf jeder Seite ----------
  const colA = [company.name, company.owner, company.addressAddition, company.street, [company.zip, company.city].filter(Boolean).join(" ")];
  const colB = [
    company.phone && `Tel. ${company.phone}`,
    company.email,
    company.website,
    company.registerCourt && company.registerNumber ? `${company.registerCourt} ${company.registerNumber}` : "",
  ];
  const colC = [
    company.bankName,
    company.iban && `IBAN ${company.iban}`,
    company.bic && `BIC ${company.bic}`,
    company.vatId ? `USt-IdNr. ${company.vatId}` : company.taxNumber ? `St.-Nr. ${company.taxNumber}` : "",
  ];
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    // Fußzeile liegt im unteren Rand – sonst bricht pdfkit automatisch auf eine neue Seite um
    pdf.page.margins.bottom = 0;
    const fy = FOOTER_TOP + 6 * MM;
    pdf.moveTo(LEFT, fy - 3 * MM).lineTo(RIGHT, fy - 3 * MM).lineWidth(design === "modern" ? 1.2 : 0.4).strokeColor(design === "modern" ? accent : RULE).stroke();
    const w = CONTENT_W / 3;
    [colA, colB, colC].forEach((col, ci) => {
      pdf
        .font(FR)
        .fontSize(7.5)
        .fillColor(MUTED)
        .text(col.filter(Boolean).join("\n"), LEFT + ci * w, fy, { width: w - 3 * MM, lineGap: 1, lineBreak: true, height: PAGE_H - fy - 6 * MM, ellipsis: true });
    });
    if (range.count > 1) {
      // über der Trennlinie, damit es nie mit der Fußzeile kollidiert
      pdf
        .font(FR)
        .fontSize(7.5)
        .fillColor(MUTED)
        .text(`Seite ${i + 1} von ${range.count}`, LEFT, fy - 7 * MM, { width: CONTENT_W, align: "right", lineBreak: false });
    }
  }

  pdf.end();
  return done;
}

/** XMP-Metadaten für Factur-X/ZUGFeRD 2 (Profil EN 16931) inkl. PDF/A-Erweiterungsschema */
const FACTURX_XMP = `
<rdf:Description xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#" rdf:about="">
  <fx:DocumentType>INVOICE</fx:DocumentType>
  <fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>
  <fx:Version>1.0</fx:Version>
  <fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>
</rdf:Description>
<rdf:Description xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#" rdf:about="">
  <pdfaExtension:schemas>
    <rdf:Bag>
      <rdf:li rdf:parseType="Resource">
        <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
        <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
        <pdfaSchema:prefix>fx</pdfaSchema:prefix>
        <pdfaSchema:property>
          <rdf:Seq>
            <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentFileName</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The name of the embedded XML document</pdfaProperty:description></rdf:li>
            <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentType</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The type of the hybrid document in capital letters, e.g. INVOICE or ORDER</pdfaProperty:description></rdf:li>
            <rdf:li rdf:parseType="Resource"><pdfaProperty:name>Version</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The actual version of the standard applying to the embedded XML document</pdfaProperty:description></rdf:li>
            <rdf:li rdf:parseType="Resource"><pdfaProperty:name>ConformanceLevel</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The conformance level of the embedded XML document</pdfaProperty:description></rdf:li>
          </rdf:Seq>
        </pdfaSchema:property>
      </rdf:li>
    </rdf:Bag>
  </pdfaExtension:schemas>
</rdf:Description>
`;
