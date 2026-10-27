// The receipt, built once here so the printed copy, the screen and what's sent by
// email or text all match. 32 columns wide like a thermal printer (the prototype's format).
import { formatMoney } from "./money.ts";
import { REFUND_REASON_LABEL, type PaymentMethod, type RefundReasonCode } from "./refund.ts";
import { formatTaxPercent } from "./tax.ts";

export interface ReceiptRefund {
  id: string;
  createdAt: Date;
  reason: RefundReasonCode;
  note: string | null;
  restock: boolean;
  staffName: string | null;
  approvedByName: string | null;
  amountCents: number;
  taxCents: number;
  lines: { name: string; qty: number; amountCents: number }[];
  payments: { method: PaymentMethod; amountCents: number }[];
}

export interface ReceiptData {
  id: string;
  receiptNumber: number;
  status: "open" | "paid" | "canceled";
  createdAt: Date;
  paidAt: Date | null;
  storeName: string;
  locationName: string;
  staffName: string | null;
  customer: { id: string; name: string; email: string | null; phone: string | null } | null;
  lines: {
    id: string;
    name: string;
    sku: string | null;
    qty: number;
    unitPriceCents: number;
    discountCents: number;
    lineTotalCents: number;
  }[];
  discounts: { name: string; source: string; amountCents: number; note: string | null }[];
  payments: {
    method: PaymentMethod;
    status: string;
    amountCents: number;
    tenderedCents: number | null;
    changeCents: number;
  }[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  taxRateMpct: number;
  totalCents: number;
  refundedCents: number;
  refunds: ReceiptRefund[];
  earned: { programName: string; punches: number }[];
}

const W = 32;

const PAID_BY: Record<PaymentMethod, string> = {
  card: "Card (Square)",
  cash: "Cash",
  deposit: "Deposit paid online",
};
const pad = (left: string, right: string) => {
  const room = W - right.length - 1;
  const l = left.length > room ? `${left.slice(0, room - 1)}…` : left;
  return `${l.padEnd(W - right.length)}${right}`;
};

const when = (d: Date) =>
  new Date(d).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export function receiptText(r: ReceiptData): string {
  const out = [
    r.storeName,
    r.locationName,
    `${when(r.paidAt ?? r.createdAt)}  #${r.receiptNumber}`,
    "-".repeat(W),
  ];
  for (const l of r.lines) {
    out.push(pad(`${l.qty}× ${l.name}`, formatMoney(l.unitPriceCents * l.qty)));
  }
  for (const d of r.discounts) {
    out.push(pad(`  ${d.name}`, `-${formatMoney(d.amountCents)}`));
    if (d.note) out.push(`    ${d.note}`.slice(0, W));
  }
  out.push("-".repeat(W));
  out.push(pad("Subtotal", formatMoney(r.subtotalCents - r.discountCents)));
  out.push(pad(`Tax ${formatTaxPercent(r.taxRateMpct)}`, formatMoney(r.taxCents)));
  out.push(pad("TOTAL", formatMoney(r.totalCents)));
  for (const p of r.payments) {
    out.push(pad(PAID_BY[p.method], formatMoney(p.amountCents)));
    if (p.method === "cash" && p.changeCents) out.push(pad("Change", formatMoney(p.changeCents)));
    if (p.status === "refunded") out.push(pad("  Refunded", `-${formatMoney(p.amountCents)}`));
  }
  for (const f of r.refunds) {
    out.push("-".repeat(W), `REFUND ${when(f.createdAt)}`);
    for (const l of f.lines) out.push(pad(`  ${l.qty}× ${l.name}`, `-${formatMoney(l.amountCents)}`));
    if (f.taxCents) out.push(pad("  Tax", `-${formatMoney(f.taxCents)}`));
    for (const p of f.payments)
      out.push(pad(p.method === "cash" ? "  Cash back" : "  To card", `-${formatMoney(p.amountCents)}`));
    out.push(`  ${REFUND_REASON_LABEL[f.reason]}${f.note ? `: ${f.note}` : ""}`.slice(0, W));
  }
  if (r.refundedCents) {
    out.push("-".repeat(W));
    out.push(pad("Refunded", `-${formatMoney(r.refundedCents)}`));
    out.push(pad("NET PAID", formatMoney(r.totalCents - r.refundedCents)));
  }
  if (r.status === "canceled") out.push("", "*** CANCELED ***");
  if (r.customer) out.push("", `Customer: ${r.customer.name}`);
  if (r.earned.length)
    out.push(`Astro credit: ${r.earned.map((e) => `${e.punches} × ${e.programName}`).join(", ")}`);
  if (r.staffName) out.push(`Served by ${r.staffName}`);
  out.push("", "Thank you!");
  return out.join("\n");
}

/** The email: subject line and the receipt as plain text. */
export function receiptEmail(r: ReceiptData): { subject: string; body: string } {
  return {
    subject: `Your receipt from ${r.storeName} (#${r.receiptNumber})`,
    body: receiptText(r),
  };
}

/** The text message: short, because the customer asked for it at the counter. */
export function receiptSms(r: ReceiptData): string {
  let s = `${r.storeName}: receipt #${r.receiptNumber}, total ${formatMoney(r.totalCents)}`;
  if (r.refundedCents)
    s += `, refunded ${formatMoney(r.refundedCents)} (net ${formatMoney(r.totalCents - r.refundedCents)})`;
  return `${s}. Thank you!`;
}
