// Grooming: quotes, times and the appointment status flow. Pure functions shared by
// the calendar, the booking form and the server (which reprices every booking).
// Money is integer cents; times are minutes since midnight in the store's local time.
import { addDays } from "./dates.ts";
import { AppError } from "./errors.ts";
import { formatMoney } from "./money.ts";
import { SIZES, type PetSize } from "./pets.ts";
import type { Role } from "./auth.ts";

export const SIZE_HINT: Record<PetSize, string> = {
  S: "under 20 lb",
  M: "21–50 lb",
  L: "51–90 lb",
  XL: "over 90 lb",
};

export interface ServiceRates {
  name: string;
  priceCents: Record<PetSize, number>;
  minutes: Record<PetSize, number>;
  bufferMinutes: number;
}

export interface Quote {
  priceCents: number;
  /** Service plus add-ons, without the buffer. */
  minutes: number;
  bufferMinutes: number;
  /** "Full groom + Teeth brushing" */
  label: string;
}

/** Price and minutes for a pet size: the main service plus add-ons. The buffer is the main service's. */
export function quoteAppointment(main: ServiceRates, addons: ServiceRates[], size: PetSize): Quote {
  if (!(SIZES as readonly string[]).includes(size)) throw new AppError("invalid", "Pick the pet's size.");
  let price = main.priceCents[size];
  let minutes = main.minutes[size];
  for (const a of addons) {
    price += a.priceCents[size];
    minutes += a.minutes[size];
  }
  if (minutes <= 0) throw new AppError("invalid", `${main.name} has no time set for size ${size}.`);
  return {
    priceCents: price,
    minutes,
    bufferMinutes: main.bufferMinutes,
    label: [main.name, ...addons.map((a) => a.name)].join(" + "),
  };
}

/** "45 min", "2 hr", "2 hr 10 min" */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** "09:00" or "09:00:00" → 540. */
export function timeToMinutes(t: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) throw new AppError("invalid", "Pick a time.");
  const n = Number(m[1]) * 60 + Number(m[2]);
  if (n < 0 || n >= 24 * 60) throw new AppError("invalid", "Pick a time.");
  return n;
}

/** 540 → "09:00" */
export function minutesToTime(n: number): string {
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

/** 540 → "9:00 AM", 780 → "1:00 PM" */
export function clockText(n: number): string {
  const h = Math.floor(n / 60) % 24;
  const m = n % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Minutes since local midnight for a time. */
export function minutesOfDay(d: Date): number {
  const x = new Date(d);
  return x.getHours() * 60 + x.getMinutes();
}

/** A local date and minutes since midnight → a Date. */
export function atLocal(day: string, minutes: number): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
}

/** True when start..end fits inside the groomer's hours for the day. */
export function withinHours(
  start: number,
  end: number,
  hours: { start: number; end: number } | null,
): boolean {
  return !!hours && start >= hours.start && end <= hours.end;
}

/** True when two half-open ranges overlap. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export type ApptStatus =
  "held" | "booked" | "checked_in" | "in_progress" | "ready" | "done" | "no_show" | "canceled";

export const STATUS_LABEL: Record<ApptStatus, string> = {
  held: "Waiting for deposit",
  booked: "Booked",
  checked_in: "Checked in",
  in_progress: "In progress",
  ready: "Ready for pickup",
  done: "Done",
  no_show: "No-show",
  canceled: "Canceled",
};

const BOOKERS: readonly Role[] = ["owner", "manager", "cashier"];

/** Status changes and who may make them. Canceling has its own handler. */
const STEPS: { from: ApptStatus; to: ApptStatus; label: string; roles: readonly Role[] }[] = [
  { from: "booked", to: "checked_in", label: "Check in", roles: BOOKERS },
  { from: "booked", to: "no_show", label: "No-show", roles: BOOKERS },
  { from: "no_show", to: "booked", label: "Undo no-show", roles: BOOKERS },
  { from: "checked_in", to: "in_progress", label: "Start groom", roles: [...BOOKERS, "groomer"] },
  { from: "checked_in", to: "booked", label: "Undo check-in", roles: BOOKERS },
  { from: "in_progress", to: "ready", label: "Ready for pickup", roles: [...BOOKERS, "groomer"] },
  { from: "in_progress", to: "checked_in", label: "Undo start", roles: [...BOOKERS, "groomer"] },
  { from: "ready", to: "in_progress", label: "Undo ready", roles: [...BOOKERS, "groomer"] },
  // Paid at the register in 3b; by hand when it was paid another way.
  { from: "ready", to: "done", label: "Mark done (paid elsewhere)", roles: ["owner", "manager"] },
];

/** The next steps this role can take from a status, forward step first. */
export function nextSteps(
  status: ApptStatus,
  role: Role,
): { to: ApptStatus; label: string; undo: boolean }[] {
  return STEPS.filter((s) => s.from === status && s.roles.includes(role)).map((s) => ({
    to: s.to,
    label: s.label,
    undo: s.label.startsWith("Undo"),
  }));
}

export function canStep(from: ApptStatus, to: ApptStatus, role: Role): boolean {
  return STEPS.some((s) => s.from === from && s.to === to && s.roles.includes(role));
}

/** "Full groom + Teeth brushing · size M · $80.00 · 2 hr 10 min" */
export function quoteText(q: Quote, size: PetSize): string {
  return `${q.label} · size ${size} · ${formatMoney(q.priceCents)} · ${durationText(q.minutes)}`;
}

export interface SupplyRates {
  productId: string;
  qty: Record<PetSize, number>;
}

/** What a groom uses at a pet size: amounts per product added up, zeros left out. */
export function suppliesFor(rates: SupplyRates[], size: PetSize): { productId: string; qty: number }[] {
  const total = new Map<string, number>();
  for (const r of rates) total.set(r.productId, (total.get(r.productId) ?? 0) + r.qty[size]);
  return [...total].filter(([, qty]) => qty > 0).map(([productId, qty]) => ({ productId, qty }));
}

/** Snaps minutes since midnight to the nearest step (15 minutes on the calendar). */
export function snapMinutes(n: number, step = 15): number {
  return Math.max(0, Math.min(24 * 60 - step, Math.round(n / step) * step));
}

/** The Monday of the week a day falls in ("YYYY-MM-DD"). */
export function weekStart(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const wd = new Date(y, m - 1, d, 12).getDay();
  return addDays(day, wd === 0 ? -6 : 1 - wd);
}

/** Monday to Sunday from a week's start. */
export function weekDays(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue Oct 21" for a "YYYY-MM-DD" day. */
export function shortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return `${WEEKDAY[new Date(y, m - 1, d, 12).getDay()]} ${MONTH[m - 1]} ${d}`;
}

export interface CalloutGroomer {
  staffId: string;
  name: string;
  /** Hours that day, minutes since midnight; null when they don't work. */
  hours: { start: number; end: number } | null;
  timeOff: { start: number; end: number }[];
  /** Their bookings that day: start to end plus buffer. */
  busy: { start: number; end: number }[];
}

export interface CalloutSuggestion {
  appointmentId: string;
  /** Another groomer free at the same time, or null: it needs a new time. */
  staffId: string | null;
  name: string | null;
}

/**
 * For a groomer who called out: who can take each appointment at the same time.
 * The first groomer (in the order given) whose hours cover the groom, who has no
 * time off then and no booking in the way, buffer included. Each suggestion counts
 * as booked for the ones after it.
 */
export function suggestCallout(
  appointments: { id: string; start: number; end: number; blockEnd: number }[],
  groomers: CalloutGroomer[],
): CalloutSuggestion[] {
  const busy = new Map(groomers.map((g) => [g.staffId, [...g.busy]]));
  return [...appointments]
    .sort((a, b) => a.start - b.start)
    .map((a) => {
      const g = groomers.find(
        (x) =>
          withinHours(a.start, a.end, x.hours) &&
          !x.timeOff.some((t) => overlaps(a.start, a.blockEnd, t.start, t.end)) &&
          !busy.get(x.staffId)!.some((b) => overlaps(a.start, a.blockEnd, b.start, b.end)),
      );
      if (!g) return { appointmentId: a.id, staffId: null, name: null };
      busy.get(g.staffId)!.push({ start: a.start, end: a.blockEnd });
      return { appointmentId: a.id, staffId: g.staffId, name: g.name };
    });
}

/** The texts customers get about their appointments. Short and plain. */
export const appointmentText = {
  ready: (store: string, pet: string) => `${store}: ${pet} is ready for pickup!`,
  moved: (store: string, pet: string, day: string, time: number, groomer: string) =>
    `${store}: ${pet}'s groom is now ${shortDay(day)} at ${clockText(time)} with ${groomer}. Reply or call to change it.`,
  canceled: (store: string, pet: string, day: string, time: number) =>
    `${store}: ${pet}'s groom on ${shortDay(day)} at ${clockText(time)} is canceled. Call us to book a new time.`,
  deposit: (store: string, pet: string, day: string, time: number, amountCents: number, url: string) =>
    `${store}: please pay the ${formatMoney(amountCents)} deposit for ${pet}'s groom on ${shortDay(day)} at ${clockText(time)}: ${url}`,
};
