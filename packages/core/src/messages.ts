// Messages to customers about their grooms: who gets them and how (text or email),
// when reminders and rebook nudges fall due, quiet hours, and the wording.
import { addDays, todayIso } from "./dates.ts";
import { atLocal, clockText, minutesOfDay, shortDay } from "./grooming.ts";
import { formatMoney } from "./money.ts";
import { formatPhone } from "./phone.ts";

export type Channel = "sms" | "email";

export interface Reachable {
  phone: string | null;
  email: string | null;
  smsOptIn: boolean;
  /** The customer's choice when they have both. */
  pref: "text" | "email" | null;
  /** Unsubscribed from all email. */
  emailOff?: boolean;
}

/**
 * How to reach a customer, or null when there's no way they've agreed to. Texts need
 * the opt-in; email is used when they prefer it or can't get texts.
 */
export function channelFor(c: Reachable): { channel: Channel; to: string } | null {
  const text = c.phone && c.smsOptIn ? { channel: "sms" as const, to: c.phone } : null;
  const email = c.email && !c.emailOff ? { channel: "email" as const, to: c.email } : null;
  if (c.pref === "email") return email ?? text;
  return text ?? email;
}

/** Why a customer got nothing, for the note staff see. */
export function unreachableNote(c: Reachable): string {
  if (c.phone && !c.smsOptIn && !c.email) return "this customer hasn't agreed to texts and has no email";
  return "this customer has no text opt-in or email";
}

/** Texts go out only between 9:00 AM and 8:00 PM store time. */
export const QUIET_HOURS = { start: 9 * 60, end: 20 * 60 } as const;

/** The first time at or after `at` that a message may go out. */
export function sendableAt(at: Date): Date {
  const m = minutesOfDay(at);
  if (m < QUIET_HOURS.start) return atLocal(todayIso(at), QUIET_HOURS.start);
  if (m >= QUIET_HOURS.end) return atLocal(addDays(todayIso(at), 1), QUIET_HOURS.start);
  return at;
}

export function inQuietHours(now: Date): boolean {
  return sendableAt(now).getTime() !== now.getTime();
}

/** The day-before reminder: the store's reminder time on the day before the groom. */
export function reminderDueAt(startsAt: Date, remindMinute: number): Date {
  return atLocal(addDays(todayIso(startsAt), -1), remindMinute);
}

/** A rebook nudge: some weeks after the finished groom, in sendable hours. */
export function nudgeDueAt(doneAt: Date, weeks: number): Date {
  return sendableAt(new Date(doneAt.getTime() + weeks * 7 * 86_400_000));
}

/** No more than one nudge per pet in this many days. */
export const NUDGE_GAP_DAYS = 14;

/** The store's booking page, as a link that fits in a text. */
export function bookingLink(slug: string, isDemo: boolean, q?: { pet?: string; service?: string }): string {
  const base = isDemo ? "petpos-demo.prismcortex.net/book" : `${slug}.pos.prismcortex.net/book`;
  const s = Object.entries({ pet: q?.pet, service: q?.service })
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
    .join("&");
  return s ? `${base}?${s}` : base;
}

export const STOP_LINE = "Reply STOP to opt out.";

interface When {
  store: string;
  pet: string;
  service: string;
  day: string;
  time: number;
  groomer: string;
}

/** The words for confirmations, reminders and nudges. Emails reuse them with a subject. */
export const messageText = {
  confirm: (w: When & { depositCents: number; link: string }) =>
    `${w.store}: ${w.pet}'s ${w.service} is booked for ${shortDay(w.day)} at ${clockText(w.time)} with ${w.groomer}.${
      w.depositCents ? ` ${formatMoney(w.depositCents)} deposit paid.` : ""
    } Manage it: ${w.link}`,
  reminder: (w: When & { phone: string | null }) =>
    `${w.store}: reminder, ${w.pet}'s groom is tomorrow, ${shortDay(w.day)} at ${clockText(w.time)}.${
      w.phone ? ` Need to change it? Call ${formatPhone(w.phone)}.` : ""
    }`,
  nudge: (v: { store: string; pet: string; weeks: number; link: string }) =>
    `${v.store}: it's been ${v.weeks} weeks since ${v.pet}'s last groom. Book the next one: ${v.link}`,
};

export const SUBJECT = {
  confirm: (store: string, pet: string) => `${store}: ${pet}'s groom is booked`,
  reminder: (store: string, pet: string) => `${store}: ${pet}'s groom is tomorrow`,
  nudge: (store: string, pet: string) => `${store}: time for ${pet}'s next groom?`,
  ready: (store: string, pet: string) => `${store}: ${pet} is ready for pickup`,
  moved: (store: string, pet: string) => `${store}: ${pet}'s groom has moved`,
  canceled: (store: string, pet: string) => `${store}: ${pet}'s groom is canceled`,
  deposit: (store: string, pet: string) => `${store}: deposit for ${pet}'s groom`,
} as const;

/** The email body: the text's words, plus an unsubscribe line on nudges. */
export function emailBody(text: string, unsubscribeLink: string | null): string {
  return unsubscribeLink ? `${text}\n\nDon't want rebook reminders? Unsubscribe: ${unsubscribeLink}` : text;
}
