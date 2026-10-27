// Refund math. Everything is integer cents and running totals, so refunding a line
// in several goes adds up to exactly what was paid for it, never a cent more or less.
//
// A line's units are refunded paid units first, then free (Astro reward) units:
//   paid units p = qty − reward units on the line
//   money back for the first R units = floor(lineTotal × min(R, p) / p)
// Each refund gives back that running total minus what earlier refunds gave back.
// Tax works the same way on the line's tax share.
import { AppError } from "./errors.ts";
import { formatMoney } from "./money.ts";
import { allocate } from "./sale.ts";

export const REFUND_REASONS = ["damaged", "wrong_item", "changed_mind", "price_adjustment", "other"] as const;
export type RefundReasonCode = (typeof REFUND_REASONS)[number];

export const REFUND_REASON_LABEL: Record<RefundReasonCode, string> = {
  damaged: "Damaged",
  wrong_item: "Wrong item",
  changed_mind: "Changed mind",
  price_adjustment: "Price adjustment",
  other: "Other",
};

export interface RefundableLine {
  id: string;
  name: string;
  qty: number;
  /** What was paid for the line after discounts, before tax. */
  lineTotalCents: number;
  /** The line's share of the sale's tax. */
  taxCents: number;
  /** Units that were the free Astro reward. */
  rewardUnits: number;
  /** Units, cents and tax already refunded on earlier refunds. */
  refundedQty: number;
  refundedCents: number;
  refundedTaxCents: number;
}

/** Running total for the first `units` units, paid units first. */
function upTo(total: number, units: number, paid: number): number {
  if (paid <= 0) return 0;
  const n = Math.min(units, paid);
  const p = total * n;
  if (!Number.isSafeInteger(p)) throw new RangeError("Amount too large to refund exactly");
  return Math.floor(p / paid);
}

export interface LineRefund {
  lineId: string;
  name: string;
  qty: number;
  amountCents: number;
  taxCents: number;
  /** Paid units in this refund (they earned punches). */
  paidUnits: number;
  /** Free reward units in this refund. */
  rewardUnits: number;
}

/** Money and units back for refunding `qty` more units of a line. */
export function refundLine(line: RefundableLine, qty: number): LineRefund {
  const left = line.qty - line.refundedQty;
  if (!Number.isInteger(qty) || qty < 1 || qty > left)
    throw new AppError(
      "invalid",
      left > 0
        ? `${line.name}: you can refund 1 to ${left}.`
        : `${line.name} has already been refunded in full.`,
    );
  const paid = line.qty - line.rewardUnits;
  const before = line.refundedQty;
  const after = before + qty;
  const amount = upTo(line.lineTotalCents, after, paid) - line.refundedCents;
  const tax = upTo(line.taxCents, after, paid) - line.refundedTaxCents;
  return {
    lineId: line.id,
    name: line.name,
    qty,
    amountCents: Math.max(0, amount),
    taxCents: Math.max(0, tax),
    paidUnits: Math.min(after, paid) - Math.min(before, paid),
    rewardUnits: Math.max(0, after - paid) - Math.max(0, before - paid),
  };
}

/**
 * Each line's share of a sale's tax, for sales rung before shares were stored:
 * the tax spread over the taxable lines by what was paid for them.
 */
export function taxShares(
  taxCents: number,
  lines: { lineTotalCents: number; taxClass: "standard" | "exempt" }[],
): number[] {
  return allocate(
    taxCents,
    lines.map((l) => (l.taxClass === "standard" ? l.lineTotalCents : 0)),
  );
}

/** How a sale was paid. A deposit is card money taken online before the visit. */
export type PaymentMethod = "card" | "cash" | "deposit";

export interface RefundablePayment {
  id: string;
  method: PaymentMethod;
  /** Amount minus what's already been refunded. */
  availableCents: number;
}

export interface PaymentRefund {
  paymentId: string;
  method: PaymentMethod;
  amountCents: number;
}

/** Where the money goes back: card payments first (in the order taken), then the online deposit, then cash. */
export function splitRefund(amountCents: number, payments: RefundablePayment[]): PaymentRefund[] {
  const ordered = [
    ...payments.filter((p) => p.method === "card"),
    ...payments.filter((p) => p.method === "deposit"),
    ...payments.filter((p) => p.method === "cash"),
  ];
  const available = ordered.reduce((s, p) => s + Math.max(0, p.availableCents), 0);
  if (amountCents > available)
    throw new AppError("invalid", `Only ${formatMoney(available)} is left to refund on this sale.`);
  const out: PaymentRefund[] = [];
  let left = amountCents;
  for (const p of ordered) {
    if (left <= 0) break;
    const n = Math.min(left, Math.max(0, p.availableCents));
    if (n > 0) out.push({ paymentId: p.id, method: p.method, amountCents: n });
    left -= n;
  }
  return out;
}

/** "Refund $43.21 to the card · Hand back $10.00 cash" */
export function refundSplitLabel(parts: { method: PaymentMethod; amountCents: number }[]): string {
  const sum = (m: PaymentMethod) =>
    parts.filter((p) => p.method === m).reduce((s, p) => s + p.amountCents, 0);
  const [card, deposit, cash] = [sum("card"), sum("deposit"), sum("cash")];
  const out: string[] = [];
  if (card) out.push(`Refund ${formatMoney(card)} to the card`);
  if (deposit) out.push(`Refund ${formatMoney(deposit)} to the card that paid the deposit`);
  if (cash) out.push(`Hand back ${formatMoney(cash)} cash`);
  return out.length ? out.join(" · ") : "Nothing to pay back";
}
