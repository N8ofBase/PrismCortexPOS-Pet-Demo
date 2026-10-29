// The customer's own message settings on the booking page, and the unsubscribe link in
// rebook emails (which works without signing in, for that customer only).
import { AppError } from "@pet-pos/core";
import { sha256 } from "../messages.ts";
import { definePublic, type SignedCtx } from "./handler.ts";

export interface MyMessageSettings {
  phone: string | null;
  email: string | null;
  /** Agreed to texts about their grooms. */
  smsOptIn: boolean;
  contactPref: "text" | "email" | null;
  nudgesOff: boolean;
  emailOff: boolean;
}

/** The consent wording shown next to the texts box, and kept with the opt-in. */
export const SMS_CONSENT =
  "Text me about my grooms: confirmations, reminders and when my pet is ready. Message and data rates may apply. Reply STOP to opt out.";

export const myMessageSettings = definePublic<void, MyMessageSettings>({
  signedIn: true,
  async run(trx, ctx) {
    const c = await trx
      .selectFrom("customers")
      .select(["phone", "email", "sms_opt_in", "contact_pref", "nudges_off", "email_off"])
      .where("id", "=", (ctx as SignedCtx).customerId)
      .executeTakeFirstOrThrow();
    return {
      phone: c.phone,
      email: c.email,
      smsOptIn: c.sms_opt_in,
      contactPref: c.contact_pref,
      nudgesOff: c.nudges_off,
      emailOff: c.email_off,
    };
  },
});

export const saveMyMessageSettings = definePublic<
  Pick<MyMessageSettings, "smsOptIn" | "contactPref" | "nudgesOff" | "emailOff">,
  MyMessageSettings
>({
  signedIn: true,
  async run(trx, ctx, input) {
    const id = (ctx as SignedCtx).customerId;
    const c = await trx
      .selectFrom("customers")
      .select(["phone", "email", "sms_opt_in"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    if (input.smsOptIn && !c.phone)
      throw new AppError(
        "invalid",
        "There's no mobile number on your account. Please call the store to add one.",
      );
    if (input.contactPref === "email" && !c.email)
      throw new AppError("invalid", "There's no email on your account. Please call the store to add one.");
    await trx
      .updateTable("customers")
      .set({
        sms_opt_in: !!input.smsOptIn,
        contact_pref:
          input.contactPref === "email" || input.contactPref === "text" ? input.contactPref : null,
        nudges_off: !!input.nudgesOff,
        email_off: !!input.emailOff,
        ...(input.smsOptIn && !c.sms_opt_in
          ? { sms_opt_in_at: new Date(), sms_opt_in_source: "online" as const }
          : !input.smsOptIn
            ? { sms_opt_in_at: null, sms_opt_in_source: null }
            : {}),
      })
      .where("id", "=", id)
      .execute();
    return myMessageSettings.run(trx, ctx, undefined);
  },
});

export interface Unsubscribed {
  storeName: string;
  /** What's off now. */
  off: "nudges" | "email";
}

/** From the link in a rebook email: turns off rebook reminders, or all email. */
export const unsubscribe = definePublic<{ token: string; what: "nudges" | "email" }, Unsubscribed>({
  signedIn: false,
  async run(trx, _ctx, { token, what }) {
    if (what !== "nudges" && what !== "email") throw new AppError("invalid", "Pick what to turn off.");
    const m = token
      ? await trx
          .selectFrom("appointment_messages as m")
          .innerJoin("appointments as a", "a.id", "m.appointment_id")
          .innerJoin("businesses as b", "b.id", "m.business_id")
          .select(["a.customer_id", "b.name"])
          .where("m.unsubscribe_token_hash", "=", await sha256(token))
          .executeTakeFirst()
      : undefined;
    if (!m?.customer_id)
      throw new AppError("not_found", "That link doesn't work anymore. Sign in to change your messages.");
    await trx
      .updateTable("customers")
      .set(what === "nudges" ? { nudges_off: true } : { email_off: true })
      .where("id", "=", m.customer_id)
      .execute();
    return { storeName: m.name, off: what };
  },
});
