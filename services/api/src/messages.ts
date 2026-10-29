// Messages to customers about their grooms. Every one goes through notify(): it picks
// text or email with channelFor(), honors opt-outs, writes the message to
// appointment_messages for the messenger, and sends confirmations, reminders and nudges
// once per groom. sendDueMessages() is the sweep for reminders and rebook nudges.
import { sql, type Transaction } from "kysely";
import {
  addDays,
  appointmentText,
  atLocal,
  bookingLink,
  channelFor,
  emailBody,
  inQuietHours,
  messageText,
  minutesOfDay,
  NUDGE_GAP_DAYS,
  nudgeDueAt,
  reminderDueAt,
  STOP_LINE,
  SUBJECT,
  todayIso,
  type Channel,
} from "@pet-pos/core";
import type { DB, MessageKind } from "@pet-pos/db";
import { messenger } from "./messaging/outbox.ts";

type Trx = Transaction<DB>;

export interface Sender {
  businessId: string;
  /** Null for the store's own sweep, or the customer online. */
  staffId: string | null;
}

export type NotifyResult = { sent: { channel: Channel; to: string; body: string } } | { skipped: string };

function localDay(d: Date): string {
  return todayIso(new Date(d));
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Messages that go once per appointment, however often they're asked for. */
const ONCE: MessageKind[] = ["confirm", "reminder", "nudge", "ready"];

/**
 * Writes one message to the customer about an appointment, by their channel. Returns
 * what was sent, or why nothing was (no opt-in or email, nudges turned off, already sent).
 */
export async function notify(
  trx: Trx,
  from: Sender,
  appointmentId: string,
  kind: MessageKind,
  extra: { depositUrl?: string; weeks?: number } = {},
): Promise<NotifyResult> {
  const a = await trx
    .selectFrom("appointments as a")
    .innerJoin("staff as st", "st.id", "a.staff_id")
    .innerJoin("businesses as b", "b.id", "a.business_id")
    .leftJoin("customers as c", "c.id", "a.customer_id")
    .leftJoin("deposits as d", "d.id", "a.deposit_id")
    .select([
      "a.id",
      "a.pet_id",
      "a.pet_name",
      "a.service_id",
      "a.service_name",
      "a.starts_at",
      "a.is_demo",
      "st.name as groomer",
      "b.name as store",
      "b.slug",
      "b.is_demo as demo_store",
      "b.public_phone",
      "c.id as customer_id",
      "c.phone",
      "c.email",
      "c.sms_opt_in",
      "c.contact_pref",
      "c.nudges_off",
      "c.email_off",
      "d.status as deposit_status",
      "d.amount_cents as deposit_cents",
    ])
    .where("a.id", "=", appointmentId)
    .executeTakeFirst();
  if (!a?.customer_id) return { skipped: "the customer was deleted" };
  if (kind === "nudge" && a.nudges_off) return { skipped: "the customer turned off rebook reminders" };
  const to = channelFor({
    phone: a.phone,
    email: a.email,
    smsOptIn: !!a.sms_opt_in,
    pref: a.contact_pref,
    emailOff: !!a.email_off,
  });
  if (!to)
    return {
      skipped:
        a.phone && !a.email
          ? "this customer hasn't agreed to texts and has no email"
          : "this customer has no text opt-in or email",
    };
  if (ONCE.includes(kind)) {
    const sent = await trx
      .selectFrom("appointment_messages")
      .select("id")
      .where("appointment_id", "=", appointmentId)
      .where("kind", "=", kind)
      .executeTakeFirst();
    if (sent) return { skipped: "already sent" };
  }

  const day = localDay(a.starts_at);
  const time = minutesOfDay(a.starts_at);
  const demo = a.demo_store;
  const w = { store: a.store, pet: a.pet_name, service: a.service_name, day, time, groomer: a.groomer };
  let text: string;
  switch (kind) {
    case "confirm":
      text = messageText.confirm({
        ...w,
        depositCents: a.deposit_status === "paid" ? (a.deposit_cents ?? 0) : 0,
        link: bookingLink(a.slug, demo),
      });
      break;
    case "reminder":
      text = messageText.reminder({ ...w, phone: a.public_phone });
      break;
    case "nudge":
      text = messageText.nudge({
        store: a.store,
        pet: a.pet_name,
        weeks: extra.weeks ?? 6,
        link: bookingLink(a.slug, demo, { pet: a.pet_id ?? undefined, service: a.service_id }),
      });
      break;
    case "ready":
      text = appointmentText.ready(a.store, a.pet_name);
      break;
    case "moved":
      text = appointmentText.moved(a.store, a.pet_name, day, time, a.groomer);
      break;
    case "canceled":
      text = appointmentText.canceled(a.store, a.pet_name, day, time);
      break;
    case "deposit":
      text = appointmentText.deposit(
        a.store,
        a.pet_name,
        day,
        time,
        a.deposit_cents ?? 0,
        extra.depositUrl ?? "",
      );
      break;
  }

  let body = text;
  let subject: string | null = null;
  let tokenHash: string | null = null;
  if (to.channel === "sms") {
    // The first text to a number says how to stop them.
    const before = await trx
      .selectFrom("appointment_messages")
      .select("id")
      .where("channel", "=", "sms")
      .where("to_address", "=", to.to)
      .executeTakeFirst();
    if (!before) body = `${text} ${STOP_LINE}`;
  } else {
    subject = SUBJECT[kind](a.store, a.pet_name);
    let link: string | null = null;
    if (kind === "nudge") {
      const token = randomHex(24);
      tokenHash = await sha256(token);
      link = `${demo ? "petpos-demo.prismcortex.net" : `${a.slug}.pos.prismcortex.net`}/book/unsubscribe?t=${token}`;
    }
    body = emailBody(text, link);
  }
  const row = await trx
    .insertInto("appointment_messages")
    .values({
      business_id: from.businessId,
      appointment_id: appointmentId,
      kind,
      channel: to.channel,
      to_address: to.to,
      subject,
      body,
      status: messenger.startStatus,
      unsubscribe_token_hash: tokenHash,
      created_by: from.staffId,
      is_demo: a.is_demo,
    })
    .onConflict((oc) => oc.doNothing())
    .returning("id")
    .executeTakeFirst();
  if (!row) return { skipped: "already sent" };
  return { sent: { channel: to.channel, to: to.to, body } };
}

/** A booking confirmation, when the store sends them. */
export async function confirmBooking(trx: Trx, from: Sender, appointmentId: string): Promise<NotifyResult> {
  const b = await trx
    .selectFrom("businesses")
    .select("confirm_on")
    .where("id", "=", from.businessId)
    .executeTakeFirstOrThrow();
  if (!b.confirm_on) return { skipped: "confirmations are off in Settings" };
  return notify(trx, from, appointmentId, "confirm");
}

export interface SweepResult {
  reminders: number;
  nudges: number;
  /** Due, but nothing went: no way to reach them, or nudges off. */
  skipped: number;
  /** Quiet hours: nothing goes out until 9:00 AM. */
  quiet: boolean;
}

/**
 * Sends the reminders and rebook nudges that are due. Safe to run as often as wanted:
 * each goes once per groom. Hosted mode runs it on a schedule; the demo runs it when the
 * grooming screens open.
 */
export async function sendDueMessages(trx: Trx, businessId: string, now = new Date()): Promise<SweepResult> {
  const out: SweepResult = { reminders: 0, nudges: 0, skipped: 0, quiet: inQuietHours(now) };
  if (out.quiet) return out;
  const b = await trx
    .selectFrom("businesses")
    .select(["remind_on", "remind_minute", "nudge_on", "nudge_weeks"])
    .where("id", "=", businessId)
    .executeTakeFirstOrThrow();
  const from: Sender = { businessId, staffId: null };
  const tally = (r: NotifyResult, key: "reminders" | "nudges") => {
    if ("sent" in r) out[key]++;
    else if (r.skipped !== "already sent") out.skipped++;
  };

  if (b.remind_on) {
    const soon = await trx
      .selectFrom("appointments as a")
      .select(["a.id", "a.starts_at", "a.created_at"])
      .where("a.status", "in", ["booked", "checked_in"])
      .where("a.starts_at", ">", now)
      .where("a.starts_at", "<", atLocal(addDays(todayIso(now), 2), 0))
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("appointment_messages as m")
              .select("m.id")
              .whereRef("m.appointment_id", "=", "a.id")
              .where("m.kind", "=", "reminder"),
          ),
        ),
      )
      .execute();
    for (const a of soon) {
      const due = reminderDueAt(a.starts_at, b.remind_minute);
      // Booked after the reminder time: the confirmation already told them.
      if (due > now || a.created_at > due) continue;
      tally(await notify(trx, from, a.id, "reminder"), "reminders");
    }
  }

  if (b.nudge_on) {
    // Each pet's latest finished groom in the last half year.
    const done = await trx
      .selectFrom("appointments as a")
      .innerJoin("services as s", "s.id", "a.service_id")
      .select(["a.id", "a.pet_id", "a.done_at", "s.rebook_weeks"])
      .where("a.status", "=", "done")
      .where("a.pet_id", "is not", null)
      .where("a.done_at", ">", new Date(now.getTime() - 26 * 7 * 86_400_000))
      .where(
        "a.done_at",
        "=",
        sql<Date>`(SELECT max(x.done_at) FROM appointments x WHERE x.pet_id = a.pet_id AND x.status = 'done')`,
      )
      .execute();
    for (const a of done) {
      const weeks = a.rebook_weeks ?? b.nudge_weeks;
      const due = nudgeDueAt(a.done_at!, weeks);
      // Not yet, or so long ago that a first sweep shouldn't dig it up.
      if (due > now || now.getTime() - due.getTime() > 30 * 86_400_000) continue;
      const upcoming = await trx
        .selectFrom("appointments")
        .select("id")
        .where("pet_id", "=", a.pet_id!)
        .where("status", "in", ["held", "booked", "checked_in", "in_progress", "ready"])
        .executeTakeFirst();
      if (upcoming) continue;
      const recent = await trx
        .selectFrom("appointment_messages as m")
        .innerJoin("appointments as x", "x.id", "m.appointment_id")
        .select("m.id")
        .where("m.kind", "=", "nudge")
        .where("x.pet_id", "=", a.pet_id!)
        .where("m.created_at", ">", new Date(now.getTime() - NUDGE_GAP_DAYS * 86_400_000))
        .executeTakeFirst();
      if (recent) continue;
      tally(await notify(trx, from, a.id, "nudge", { weeks }), "nudges");
    }
  }
  return out;
}
