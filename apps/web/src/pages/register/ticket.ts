// The ticket being rung up: lines, customer, rewards and discounts. Priced in the
// browser with the same priceSale() the server reruns at checkout, and kept in this
// browser so a reload doesn't lose a sale in progress.
import { priceSale, type PricedSale, type TicketLine } from "@pet-pos/core";
import type { DiscountRow, ProductRow, RegisterCustomer, TicketInput } from "@pet-pos/api";

export interface TicketLineState {
  key: string;
  product: ProductRow;
  qty: number;
  applyOffer: boolean;
}

/** A groom on the ticket: the appointment's booked price, quantity 1. */
export interface GroomLineState {
  key: string;
  appointmentId: string;
  /** "Full groom + Teeth brushing · Biscuit" */
  name: string;
  priceCents: number;
  /** Paid online when booking; the server applies it at checkout. */
  depositCents?: number;
}

export interface TicketDiscountState {
  discount: DiscountRow;
  lineKey: string | null;
  note: string | null;
  approvedBy: string | null;
  approverName: string | null;
}

export interface Ticket {
  grooms: GroomLineState[];
  lines: TicketLineState[];
  customer: RegisterCustomer | null;
  rewards: string[];
  discounts: TicketDiscountState[];
}

export const EMPTY_TICKET: Ticket = { grooms: [], lines: [], customer: null, rewards: [], discounts: [] };

/** True when nothing is on the ticket to pay for. */
export function isEmpty(t: Ticket): boolean {
  return !t.lines.length && !t.grooms.length;
}

let seq = 0;
const newKey = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** Adds one of a product, or one more of a line already on the ticket. */
export function addProduct(t: Ticket, product: ProductRow, qty = 1): Ticket {
  const existing = t.lines.find((l) => l.product.id === product.id);
  if (existing)
    return {
      ...t,
      lines: t.lines.map((l) => (l === existing ? { ...l, qty: Math.min(9999, l.qty + qty), product } : l)),
    };
  return { ...t, lines: [...t.lines, { key: newKey(), product, qty, applyOffer: false }] };
}

/** Adds a groom once. */
export function addGroom(t: Ticket, g: Omit<GroomLineState, "key">): Ticket {
  if (t.grooms.some((x) => x.appointmentId === g.appointmentId)) return t;
  return { ...t, grooms: [...t.grooms, { ...g, key: `groom-${g.appointmentId}` }] };
}

export function removeGroom(t: Ticket, key: string): Ticket {
  return {
    ...t,
    grooms: t.grooms.filter((g) => g.key !== key),
    discounts: t.discounts.filter((d) => d.lineKey !== key),
  };
}

export function setQty(t: Ticket, key: string, qty: number): Ticket {
  if (qty <= 0) {
    const lines = t.lines.filter((l) => l.key !== key);
    return {
      ...t,
      lines,
      discounts: t.discounts.filter((d) => d.lineKey !== key),
      rewards: keepRewards(t.rewards, lines),
    };
  }
  return { ...t, lines: t.lines.map((l) => (l.key === key ? { ...l, qty: Math.min(9999, qty) } : l)) };
}

function keepRewards(rewards: string[], lines: TicketLineState[]): string[] {
  return rewards.filter((p) => lines.some((l) => l.product.astroProgramId === p));
}

export function toggleOffer(t: Ticket, key: string): Ticket {
  return { ...t, lines: t.lines.map((l) => (l.key === key ? { ...l, applyOffer: !l.applyOffer } : l)) };
}

export function toggleReward(t: Ticket, programId: string): Ticket {
  return {
    ...t,
    rewards: t.rewards.includes(programId)
      ? t.rewards.filter((p) => p !== programId)
      : [...t.rewards, programId],
  };
}

export function removeDiscount(t: Ticket, index: number): Ticket {
  return { ...t, discounts: t.discounts.filter((_, i) => i !== index) };
}

/** What the server needs: ids and choices, never prices. */
export function toInput(t: Ticket): TicketInput {
  return {
    customerId: t.customer?.card.id ?? null,
    lines: [
      ...t.grooms.map((g) => ({ key: g.key, appointmentId: g.appointmentId, qty: 1, applyOffer: false })),
      ...t.lines.map((l) => ({
        key: l.key,
        productId: l.product.id,
        qty: l.qty,
        applyOffer: l.applyOffer,
      })),
    ],
    rewards: t.rewards,
    discounts: t.discounts.map((d) => ({
      discountId: d.discount.id,
      lineKey: d.lineKey,
      note: d.note ?? undefined,
      approvedBy: d.approvedBy,
    })),
  };
}

function ticketLines(t: Ticket, groomingTaxable: boolean): TicketLine[] {
  const grooms: TicketLine[] = t.grooms.map((g) => ({
    key: g.key,
    productId: null,
    name: g.name,
    unitPriceCents: g.priceCents,
    qty: 1,
    taxClass: groomingTaxable ? "standard" : "exempt",
    astroProgramId: null,
    offer: null,
    applyOffer: false,
  }));
  return [
    ...grooms,
    ...t.lines.map((l): TicketLine => ({
      key: l.key,
      productId: l.product.id,
      name: l.product.name,
      unitPriceCents: l.product.priceCents,
      qty: l.qty,
      taxClass: l.product.taxClass,
      astroProgramId: l.product.astroProgramId,
      offer:
        l.product.offerLabel && l.product.offerCents
          ? { label: l.product.offerLabel, cents: l.product.offerCents }
          : null,
      applyOffer: l.applyOffer && !!l.product.offerCents,
    })),
  ];
}

export interface TicketPrice {
  priced: PricedSale | null;
  /** Why the ticket can't be priced as it stands (e.g. two discounts that don't combine). */
  problem: string | null;
}

/** Prices the ticket for the screen. Program names come from the customer's punch cards. */
export function priceTicket(
  t: Ticket,
  taxRateMpct: number,
  astroBeforeTax: boolean,
  groomingTaxable = false,
): TicketPrice {
  try {
    const cards = t.customer?.card.punchCards ?? [];
    const priced = priceSale({
      lines: ticketLines(t, groomingTaxable),
      storeDiscounts: t.discounts.map((d) => ({
        rule: d.discount,
        lineKey: d.discount.scope === "line" ? d.lineKey : null,
      })),
      rewards: t.rewards.map((p) => {
        const c = cards.find((x) => x.programId === p);
        return { programId: p, label: c ? `${c.rewardText} · ${c.programName}` : "Astro reward" };
      }),
      taxRateMpct,
      astroBeforeTax,
    });
    return { priced, problem: null };
  } catch (err) {
    return { priced: null, problem: err instanceof Error ? err.message : "This ticket can't be priced." };
  }
}

const KEY = (staffId: string) => `petpos.ticket.${staffId}`;

export function loadTicket(staffId: string): Ticket {
  try {
    const raw = localStorage.getItem(KEY(staffId));
    if (!raw) return EMPTY_TICKET;
    const t = JSON.parse(raw) as Ticket;
    return Array.isArray(t.lines) ? { ...EMPTY_TICKET, ...t } : EMPTY_TICKET;
  } catch {
    return EMPTY_TICKET;
  }
}

export function saveTicket(staffId: string, t: Ticket): void {
  try {
    if (isEmpty(t) && !t.customer && !t.discounts.length) localStorage.removeItem(KEY(staffId));
    else localStorage.setItem(KEY(staffId), JSON.stringify(t));
  } catch {
    // Private mode: the ticket just won't survive a reload.
  }
}
