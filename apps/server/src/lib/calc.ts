/**
 * Rechnungsberechnung. Identische Kopie liegt in apps/desktop/src/lib/calc.ts
 * (CI prüft per diff, dass beide gleich sind).
 * Alle Beträge in Cent, Rabatte in Basispunkten (100 bps = 1 %).
 */

export interface CalcItem {
  quantity: number;
  unitPriceNet: number;
  taxRate: number;
  discountBps?: number;
  productId?: string | null;
}

export interface CalcDiscount {
  type: "PERCENT" | "FIXED";
  value: number;
  scope: "ALL" | "CUSTOMER" | "PRODUCT";
  productId?: string | null;
  minOrderNet?: number | null;
}

export interface TaxLine {
  rate: number;
  net: number;
  tax: number;
}

export interface CalcResult {
  lines: number[];
  subtotalNet: number;
  discountTotal: number;
  totalNet: number;
  taxTotal: number;
  totalGross: number;
  taxBreakdown: TaxLine[];
}

const round = (n: number) => Math.round(n + Number.EPSILON * Math.sign(n));

export function lineNet(item: CalcItem): number {
  const gross = item.quantity * item.unitPriceNet;
  const disc = (item.discountBps ?? 0) / 10000;
  return round(gross * (1 - disc));
}

export function calculate(items: CalcItem[], discount: CalcDiscount | null, smallBusiness: boolean): CalcResult {
  const lines = items.map(lineNet);
  const subtotalNet = lines.reduce((a, b) => a + b, 0);

  // Rabatt je Position bestimmen (proportional verteilt, damit die USt je Satz korrekt bleibt)
  const lineDiscounts = lines.map(() => 0);
  if (discount && (discount.minOrderNet == null || subtotalNet >= discount.minOrderNet)) {
    const eligible = lines.map((_, i) =>
      discount.scope === "PRODUCT" ? !!discount.productId && items[i].productId === discount.productId : true,
    );
    const base = lines.reduce((a, l, i) => a + (eligible[i] ? l : 0), 0);
    if (base > 0) {
      let total =
        discount.type === "PERCENT" ? round((base * discount.value) / 10000) : Math.min(discount.value, base);
      total = Math.max(0, total);
      let distributed = 0;
      let lastIdx = -1;
      lines.forEach((l, i) => {
        if (!eligible[i] || l === 0) return;
        const share = round((total * l) / base);
        lineDiscounts[i] = share;
        distributed += share;
        lastIdx = i;
      });
      if (lastIdx >= 0) lineDiscounts[lastIdx] += total - distributed;
    }
  }
  const discountTotal = lineDiscounts.reduce((a, b) => a + b, 0);

  const byRate = new Map<number, number>();
  lines.forEach((l, i) => {
    const rate = smallBusiness ? 0 : items[i].taxRate;
    byRate.set(rate, (byRate.get(rate) ?? 0) + l - lineDiscounts[i]);
  });

  const taxBreakdown: TaxLine[] = [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, net]) => ({ rate, net, tax: round((net * rate) / 100) }));

  const totalNet = subtotalNet - discountTotal;
  const taxTotal = taxBreakdown.reduce((a, t) => a + t.tax, 0);
  return { lines, subtotalNet, discountTotal, totalNet, taxTotal, totalGross: totalNet + taxTotal, taxBreakdown };
}

export function formatMoney(cents: number, currency = "EUR"): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);
}

export function formatDiscount(d: { type: "PERCENT" | "FIXED"; value: number }, currency = "EUR"): string {
  return d.type === "PERCENT"
    ? `${(d.value / 100).toLocaleString("de-DE", { maximumFractionDigits: 2 })} %`
    : formatMoney(d.value, currency);
}
