// Grooming → Messages: every message to customers, and the sweep that sends reminders
// and rebook nudges when they're due.
import { AppError, isIsoDate, atLocal, addDays } from "@pet-pos/core";
import type { MessageKind } from "@pet-pos/db";
import { defineHandler } from "../handler.ts";
import { sendDueMessages, type SweepResult } from "../messages.ts";

export interface MessageRow {
  id: string;
  appointmentId: string;
  kind: MessageKind;
  channel: "sms" | "email";
  to: string;
  subject: string | null;
  body: string;
  status: "preview" | "queued" | "sent" | "failed";
  createdAt: Date;
  petName: string;
  customerName: string | null;
}

const KINDS: MessageKind[] = ["confirm", "reminder", "nudge", "ready", "moved", "canceled", "deposit"];

/** Messages sent in a range of days, newest first. */
export const listMessages = defineHandler<
  { from: string; to: string; kind?: MessageKind | null },
  MessageRow[]
>({
  action: "grooming.view",
  async run(trx, _ctx, { from, to, kind }) {
    if (!isIsoDate(from) || !isIsoDate(to)) throw new AppError("invalid", "Pick the days to show.");
    if (kind && !KINDS.includes(kind)) throw new AppError("invalid", "Pick a kind of message.");
    let q = trx
      .selectFrom("appointment_messages as m")
      .innerJoin("appointments as a", "a.id", "m.appointment_id")
      .leftJoin("customers as c", "c.id", "a.customer_id")
      .select([
        "m.id",
        "m.appointment_id as appointmentId",
        "m.kind",
        "m.channel",
        "m.to_address as to",
        "m.subject",
        "m.body",
        "m.status",
        "m.created_at as createdAt",
        "a.pet_name as petName",
        "c.name as customerName",
      ])
      .where("m.created_at", ">=", atLocal(from, 0))
      .where("m.created_at", "<", atLocal(addDays(to, 1), 0));
    if (kind) q = q.where("m.kind", "=", kind);
    return q.orderBy("m.created_at", "desc").limit(500).execute();
  },
});

/**
 * Sends the reminders and rebook nudges due now. The demo runs it when the grooming
 * screens open (and from Send due messages now); hosted mode runs it on a schedule.
 */
export const sendDueNow = defineHandler<void, SweepResult>({
  action: "grooming.view",
  run: (trx, ctx) => sendDueMessages(trx, ctx.businessId),
});
