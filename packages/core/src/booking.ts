// Online booking: which start times a customer can pick, who gets "Any groomer",
// when a booking can still be changed, and the sign-in code rules. Pure functions;
// the server reruns the slot check when the customer taps Book.
import { overlaps } from "./grooming.ts";

export interface OpenGroomer {
  staffId: string;
  /** Hours that day in minutes since midnight; null when they don't work. */
  hours: { start: number; end: number } | null;
  timeOff: { start: number; end: number }[];
  /** Bookings that day: start to end plus buffer. */
  busy: { start: number; end: number }[];
}

export interface OpenTime {
  start: number;
  /** Groomers free at this time, in the order given. */
  staffIds: string[];
}

/**
 * Start times open on one day, every `step` minutes. A time is open for a groomer
 * when the groom fits inside their hours, starts no earlier than `earliest` (the
 * minimum notice, for today), and the groom plus buffer misses their time off and
 * other bookings.
 */
export function openTimes(v: {
  groomers: OpenGroomer[];
  minutes: number;
  buffer: number;
  step: number;
  /** Minutes since midnight before which nothing can start (notice); 0 for later days. */
  earliest: number;
}): OpenTime[] {
  const starts = new Set<number>();
  for (const g of v.groomers) {
    if (!g.hours) continue;
    const first = Math.ceil(g.hours.start / v.step) * v.step;
    for (let t = first; t + v.minutes <= g.hours.end; t += v.step) starts.add(t);
  }
  return [...starts]
    .sort((a, b) => a - b)
    .filter((t) => t >= v.earliest)
    .map((start) => {
      const end = start + v.minutes + v.buffer;
      const staffIds = v.groomers
        .filter(
          (g) =>
            !!g.hours &&
            start >= g.hours.start &&
            start + v.minutes <= g.hours.end &&
            !g.timeOff.some((o) => overlaps(start, end, o.start, o.end)) &&
            !g.busy.some((b) => overlaps(start, end, b.start, b.end)),
        )
        .map((g) => g.staffId);
      return { start, staffIds };
    })
    .filter((t) => t.staffIds.length > 0);
}

/** "Any groomer": whoever has the fewest bookings that day, ties to the first. */
export function pickGroomer(staffIds: string[], bookings: Record<string, number>): string | null {
  let best: string | null = null;
  for (const id of staffIds) if (best === null || (bookings[id] ?? 0) < (bookings[best] ?? 0)) best = id;
  return best;
}

/** True while a booking can still be canceled or moved online: before the store's cutoff. */
export function canChange(startsAt: Date, now: Date, cutoffHours: number): boolean {
  return startsAt.getTime() - now.getTime() >= cutoffHours * 3600_000;
}

/** Sign-in code rules. */
export const CODE_RULES = {
  digits: 6,
  expiresMinutes: 10,
  maxTries: 5,
  /** Codes one phone or email can ask for. */
  perMinute: 1,
  perHour: 5,
  sessionDays: 30,
} as const;

/** "482913" from random bytes, so every code has 6 digits. */
export function codeFromBytes(bytes: Uint8Array): string {
  const n = ((bytes[0]! << 16) | (bytes[1]! << 8) | bytes[2]!) % 1_000_000;
  return String(n).padStart(CODE_RULES.digits, "0");
}

/** A phone (10 digits) or an email (lower case), or null when it's neither. */
export function normalizeContact(input: string): { kind: "phone" | "email"; value: string } | null {
  const t = input.trim();
  if (/@/.test(t)) {
    const e = t.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? { kind: "email", value: e } : null;
  }
  let d = t.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length === 10 ? { kind: "phone", value: d } : null;
}

export type DepositRule = "off" | "all" | "new";

/**
 * The deposit an online booking asks for, in cents (0 for none). The service's deposit,
 * when the store's rule applies to this customer, never more than the groom's quote.
 */
export function bookingDeposit(v: {
  rule: DepositRule;
  serviceDepositCents: number;
  quoteCents: number;
  isNewCustomer: boolean;
}): number {
  if (v.rule === "off" || (v.rule === "new" && !v.isNewCustomer)) return 0;
  return Math.max(0, Math.min(v.serviceDepositCents, v.quoteCents));
}

/** How much of a paid deposit goes toward a sale, and what's left over to refund. */
export function applyDeposit(
  saleTotalCents: number,
  depositCents: number,
): { appliedCents: number; refundCents: number } {
  const applied = Math.max(0, Math.min(saleTotalCents, depositCents));
  return { appliedCents: applied, refundCents: depositCents - applied };
}

/** Minutes an unpaid online booking holds its time. */
export const HOLD_MINUTES = [10, 15, 30] as const;
