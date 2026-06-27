/**
 * E-Rechnung im Format XRechnung 3.0 (UN/CEFACT CII, EN 16931).
 * Erzeugt eine eigenständige XML-Datei, die per Mail mitgeschickt oder heruntergeladen werden kann.
 */
import { customerDisplayName, type InvoiceDoc } from "./invoice-service.js";

const UNIT_CODES: Record<string, string> = {
  stk: "H87",
  "stück": "H87",
  std: "HUR",
  h: "HUR",
  stunde: "HUR",
  stunden: "HUR",
  min: "MIN",
  tag: "DAY",
  tage: "DAY",
  monat: "MON",
  monate: "MON",
  jahr: "ANN",
  kg: "KGM",
  g: "GRM",
  m: "MTR",
  km: "KMT",
  "m²": "MTK",
  m2: "MTK",
  l: "LTR",
  pauschal: "LS",
  psch: "LS",
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

const amt = (cents: number) => (cents / 100).toFixed(2);
const d102 = (iso: string) => iso.replace(/-/g, "").slice(0, 8);
const dt = (iso: string) => `<udt:DateTimeString format="102">${d102(iso)}</udt:DateTimeString>`;

/** Profil: XRechnung (eigenständige XML) oder EN 16931 (eingebettet als ZUGFeRD/Factur-X) */
export type CiiProfile = "xrechnung" | "en16931";
const GUIDELINE: Record<CiiProfile, string> = {
  xrechnung: "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
  en16931: "urn:cen.eu:en16931:2017",
};

export function renderXRechnung(doc: InvoiceDoc, profile: CiiProfile = "xrechnung"): string {
  const { invoice: inv, items, customer, company, invoiceSettings: st } = doc;
  const cur = st.currency;
  const isStorno = inv.kind === "CANCELLATION";
  const issue = inv.issueDate ?? new Date().toISOString().slice(0, 10);
  const sb = inv.smallBusiness;
  const exemption = doc.exemption?.text ?? "";
  /** UNTDID 5305: S Normalsatz, sonst Kategorie des Befreiungsgrunds (E, AE, K, G, Z) */
  const taxCategory = (rate: number) => (sb ? "E" : rate > 0 ? "S" : (doc.exemption?.category ?? "Z"));
  /** Begründung ist bei E, AE, K, G Pflicht, bei S und Z verboten */
  const needsReason = (rate: number) => ["E", "AE", "K", "G"].includes(taxCategory(rate));
  const hasCategory = (c: string) => items.some((it) => taxCategory(sb ? 0 : it.taxRate) === c);
  const buyerRef = customer.leitwegId || customer.number;
  const breakdown = (inv.taxBreakdown as { rate: number; net: number; tax: number }[] | null) ?? [];
  const lineSum = items.reduce((a, i) => a + i.lineNet, 0);

  const line = (it: (typeof items)[number], idx: number) => {
    const unit = UNIT_CODES[it.unit.trim().toLowerCase()] ?? "C62";
    const gross = Math.round(it.quantity * it.unitPriceNet);
    const allowance = gross - it.lineNet;
    const rate = sb ? 0 : it.taxRate;
    return `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>${idx + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${esc(it.name)}</ram:Name>${it.description ? `\n        <ram:Description>${esc(it.description)}</ram:Description>` : ""}
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice><ram:ChargeAmount>${amt(it.unitPriceNet)}</ram:ChargeAmount></ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="${unit}">${it.quantity}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${taxCategory(rate)}</ram:CategoryCode>
          <ram:RateApplicablePercent>${rate.toFixed(2)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>${
          allowance !== 0
            ? `
        <ram:SpecifiedTradeAllowanceCharge>
          <ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator>
          <ram:ActualAmount>${amt(allowance)}</ram:ActualAmount>
          <ram:Reason>Rabatt</ram:Reason>
        </ram:SpecifiedTradeAllowanceCharge>`
            : ""
        }
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${amt(it.lineNet)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`;
  };

  // Belegrabatt je Steuersatz (BG-20)
  const docAllowances: string[] = [];
  if (inv.discountTotal !== 0) {
    const byRate = new Map<number, number>();
    items.forEach((it) => {
      const r = sb ? 0 : it.taxRate;
      byRate.set(r, (byRate.get(r) ?? 0) + it.lineNet);
    });
    for (const t of breakdown) {
      const base = byRate.get(t.rate) ?? 0;
      const part = base - t.net;
      if (part === 0) continue;
      docAllowances.push(`
      <ram:SpecifiedTradeAllowanceCharge>
        <ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator>
        <ram:ActualAmount>${amt(part)}</ram:ActualAmount>
        <ram:Reason>${esc((inv.discountSnapshot as { name?: string } | null)?.name ?? "Rabatt")}</ram:Reason>
        <ram:CategoryTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${taxCategory(t.rate)}</ram:CategoryCode>
          <ram:RateApplicablePercent>${t.rate.toFixed(2)}</ram:RateApplicablePercent>
        </ram:CategoryTradeTax>
      </ram:SpecifiedTradeAllowanceCharge>`);
    }
  }

  const taxes = breakdown
    .map(
      (t) => `
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${amt(t.tax)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>${needsReason(t.rate) ? `\n        <ram:ExemptionReason>${esc(exemption || "Steuerbefreit")}</ram:ExemptionReason>` : ""}
        <ram:BasisAmount>${amt(t.net)}</ram:BasisAmount>
        <ram:CategoryCode>${taxCategory(t.rate)}</ram:CategoryCode>
        <ram:RateApplicablePercent>${t.rate.toFixed(2)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`,
    )
    .join("");

  const sellerTax = [
    company.vatId ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(company.vatId)}</ram:ID></ram:SpecifiedTaxRegistration>` : "",
    company.taxNumber ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">${esc(company.taxNumber)}</ram:ID></ram:SpecifiedTaxRegistration>` : "",
  ]
    .filter(Boolean)
    .join("\n        ");

  // BR-CO-26: Verkäuferkennung (BT-29), Registernummer (BT-30) oder USt-IdNr. (BT-31) muss vorhanden sein.
  // Ohne USt-IdNr. (z. B. Kleinunternehmer) wird die Steuernummer bzw. Firmenname als Verkäuferkennung gesetzt.
  const legalOrg = company.registerNumber.trim()
    ? `<ram:SpecifiedLegalOrganization><ram:ID>${esc([company.registerCourt, company.registerNumber].filter((x) => x?.trim()).join(" "))}</ram:ID></ram:SpecifiedLegalOrganization>`
    : "";
  const sellerId = !company.vatId.trim() && !legalOrg ? `<ram:ID>${esc(company.taxNumber.trim() || company.name)}</ram:ID>` : "";

  const delivery = inv.serviceDateFrom
    ? inv.serviceDateTo && inv.serviceDateTo !== inv.serviceDateFrom
      ? ""
      : `<ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime>${dt(inv.serviceDateFrom)}</ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent>`
    : `<ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime>${dt(issue)}</ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent>`;

  const period =
    inv.serviceDateFrom && inv.serviceDateTo && inv.serviceDateTo !== inv.serviceDateFrom
      ? `
      <ram:BillingSpecifiedPeriod>
        <ram:StartDateTime>${dt(inv.serviceDateFrom)}</ram:StartDateTime>
        <ram:EndDateTime>${dt(inv.serviceDateTo)}</ram:EndDateTime>
      </ram:BillingSpecifiedPeriod>`
      : "";

  const paymentTerms = isStorno
    ? "Stornorechnung – keine Zahlung erforderlich."
    : `Zahlbar bis ${inv.dueDate ? inv.dueDate.split("-").reverse().join(".") : ""} ohne Abzug.`;

  const buyerName = customerDisplayName(customer);
  const sellerContact = company.owner || company.name;

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:BusinessProcessSpecifiedDocumentContextParameter><ram:ID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</ram:ID></ram:BusinessProcessSpecifiedDocumentContextParameter>
    <ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>${GUIDELINE[profile]}</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${esc(inv.number ?? "ENTWURF")}</ram:ID>
    <ram:TypeCode>${isStorno ? "384" : "380"}</ram:TypeCode>
    <ram:IssueDateTime>${dt(issue)}</ram:IssueDateTime>${
      exemption ? `\n    <ram:IncludedNote><ram:Content>${esc(exemption)}</ram:Content></ram:IncludedNote>` : ""
    }${inv.notes ? `\n    <ram:IncludedNote><ram:Content>${esc(inv.notes)}</ram:Content></ram:IncludedNote>` : ""}
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>${items.map(line).join("")}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:BuyerReference>${esc(buyerRef)}</ram:BuyerReference>
      <ram:SellerTradeParty>${sellerId ? `\n        ${sellerId}` : ""}
        <ram:Name>${esc(company.name)}</ram:Name>${legalOrg ? `\n        ${legalOrg}` : ""}
        <ram:DefinedTradeContact>
          <ram:PersonName>${esc(sellerContact)}</ram:PersonName>
          <ram:TelephoneUniversalCommunication><ram:CompleteNumber>${esc(company.phone || "-")}</ram:CompleteNumber></ram:TelephoneUniversalCommunication>
          <ram:EmailURIUniversalCommunication><ram:URIID>${esc(company.email)}</ram:URIID></ram:EmailURIUniversalCommunication>
        </ram:DefinedTradeContact>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${esc(company.zip)}</ram:PostcodeCode>
          <ram:LineOne>${esc(company.street)}</ram:LineOne>${company.addressAddition ? `\n          <ram:LineTwo>${esc(company.addressAddition)}</ram:LineTwo>` : ""}
          <ram:CityName>${esc(company.city)}</ram:CityName>
          <ram:CountryID>${esc(company.country || "DE")}</ram:CountryID>
        </ram:PostalTradeAddress>
        <ram:URIUniversalCommunication><ram:URIID schemeID="EM">${esc(company.email)}</ram:URIID></ram:URIUniversalCommunication>
        ${sellerTax}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:ID>${esc(customer.number)}</ram:ID>
        <ram:Name>${esc(buyerName)}</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${esc(customer.zip ?? "")}</ram:PostcodeCode>
          <ram:LineOne>${esc(customer.street ?? "")}</ram:LineOne>
          <ram:CityName>${esc(customer.city ?? "")}</ram:CityName>
          <ram:CountryID>${esc(customer.country || "DE")}</ram:CountryID>
        </ram:PostalTradeAddress>${
          customer.email
            ? `\n        <ram:URIUniversalCommunication><ram:URIID schemeID="EM">${esc(customer.email)}</ram:URIID></ram:URIUniversalCommunication>`
            : ""
        }${
          customer.vatId
            ? `\n        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(customer.vatId)}</ram:ID></ram:SpecifiedTaxRegistration>`
            : ""
        }
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>
${
        // Innergemeinschaftliche Lieferung: Lieferland ist Pflicht (BT-80)
        hasCategory("K")
          ? `      <ram:ShipToTradeParty>
        <ram:Name>${esc(customerDisplayName(customer))}</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${esc(customer.zip ?? "")}</ram:PostcodeCode>
          <ram:LineOne>${esc(customer.street ?? "")}</ram:LineOne>
          <ram:CityName>${esc(customer.city ?? "")}</ram:CityName>
          <ram:CountryID>${esc(customer.country || "DE")}</ram:CountryID>
        </ram:PostalTradeAddress>
      </ram:ShipToTradeParty>\n`
          : ""
      }      ${delivery}
    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${cur}</ram:InvoiceCurrencyCode>${
        company.iban && !isStorno
          ? `
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>58</ram:TypeCode>
        <ram:PayeePartyCreditorFinancialAccount><ram:IBANID>${esc(company.iban.replace(/\s+/g, ""))}</ram:IBANID></ram:PayeePartyCreditorFinancialAccount>${
          company.bic
            ? `\n        <ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>${esc(company.bic)}</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>`
            : ""
        }
      </ram:SpecifiedTradeSettlementPaymentMeans>`
          : `
      <ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>1</ram:TypeCode></ram:SpecifiedTradeSettlementPaymentMeans>`
      }${taxes}${period}${docAllowances.join("")}
      <ram:SpecifiedTradePaymentTerms>
        <ram:Description>${esc(paymentTerms)}</ram:Description>${
          inv.dueDate && !isStorno ? `\n        <ram:DueDateDateTime>${dt(inv.dueDate)}</ram:DueDateDateTime>` : ""
        }
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${amt(lineSum)}</ram:LineTotalAmount>
        <ram:AllowanceTotalAmount>${amt(inv.discountTotal)}</ram:AllowanceTotalAmount>
        <ram:TaxBasisTotalAmount>${amt(inv.totalNet)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${cur}">${amt(inv.taxTotal)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${amt(inv.totalGross)}</ram:GrandTotalAmount>
        <ram:TotalPrepaidAmount>${amt(isStorno ? 0 : inv.paidTotal)}</ram:TotalPrepaidAmount>
        <ram:DuePayableAmount>${amt(isStorno ? inv.totalGross : inv.totalGross - inv.paidTotal)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>${
        isStorno && doc.original?.number
          ? `
      <ram:InvoiceReferencedDocument>
        <ram:IssuerAssignedID>${esc(doc.original.number)}</ram:IssuerAssignedID>${
          doc.original.issueDate
            ? `\n        <ram:FormattedIssueDateTime><qdt:DateTimeString format="102">${d102(doc.original.issueDate)}</qdt:DateTimeString></ram:FormattedIssueDateTime>`
            : ""
        }
      </ram:InvoiceReferencedDocument>`
          : ""
      }
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;
}

/** Fehlende Pflichtangaben für eine gültige XRechnung */
export function xrechnungIssues(doc: InvoiceDoc): string[] {
  const c = doc.company;
  const issues: string[] = [];
  if (!c.name) issues.push("Firmenname fehlt");
  if (!c.street || !c.zip || !c.city) issues.push("Firmenanschrift unvollständig");
  if (!c.email) issues.push("Firmen-E-Mail fehlt");
  if (!c.vatId && !c.taxNumber) issues.push("Steuernummer oder USt-IdNr. fehlt");
  if (!doc.customer.email) issues.push("E-Mail des Kunden fehlt (elektronische Adresse BT-49)");
  if (!doc.customer.zip || !doc.customer.city) issues.push("Kundenanschrift unvollständig");
  const cat = doc.exemption?.category;
  if (!doc.invoice.smallBusiness && (cat === "AE" || cat === "K") && !doc.customer.vatId) {
    issues.push("USt-IdNr. des Kunden fehlt (Pflicht bei Reverse Charge und innergemeinschaftlicher Lieferung)");
  }
  if (!doc.invoice.smallBusiness && (cat === "K" || cat === "G") && !c.vatId) issues.push("Eigene USt-IdNr. fehlt (Pflicht bei steuerfreier Lieferung ins Ausland)");
  return issues;
}
