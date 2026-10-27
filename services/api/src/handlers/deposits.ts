// Staff side of deposits: asking for one on a phone booking (with an optional text of
// the link), and refunding one by hand. Holding, paying, keeping and applying live in
// ../deposits.ts, shared with the booking page and the register.
import { AppError, appointmentText, minutesOfDay } from "@pet-pos/core";
import { defineHandler } from "../handler.ts";
import { createDeposit, refundDeposit as giveBack } from "../deposits.ts";
import { requireInt } from "../shared.ts";
import { localDay } from "./grooming.ts";

export interface DepositRequest {
  depositId: string;
  amountCents: number;
  url: string;
  /** The text saved for the customer (a preview in the demo), when asked for. */
  texted: string | null;
}

/** Asks for a deposit on a booked groom: a payment link, and a text with it if wanted. */
export const requestDeposit = defineHandler<
  { appointmentId: string; amountCents?: number; text?: boolean },
  DepositRequest
>({
  action: "grooming.book",
  async run(trx, ctx, { appointmentId, amountCents, text }) {
    const a = await trx
      .selectFrom("appointments as a")
      .innerJoin("services as s", "s.id", "a.service_id")
      .innerJoin("businesses as b", "b.id", "a.business_id")
      .leftJoin("customers as c", "c.id", "a.customer_id")
      .leftJoin("deposits as d", "d.id", "a.deposit_id")
      .select([
        "a.id",
        "a.status",
        "a.price_cents",
        "a.pet_name",
        "a.starts_at",
        "s.deposit_cents",
        "b.name as store",
        "c.phone",
        "d.status as deposit_status",
      ])
      .where("a.id", "=", appointmentId)
      .forUpdate("a")
      .executeTakeFirst();
    if (!a) throw new AppError("not_found", "That appointment doesn't exist.");
    if (a.status !== "booked" && a.status !== "checked_in")
      throw new AppError("invalid", "A deposit can only be asked for on a booked groom.");
    if (a.deposit_status && ["pending", "paid", "applied", "kept"].includes(a.deposit_status))
      throw new AppError("conflict", "This groom already has a deposit.");
    const cents = amountCents ?? Math.min(a.deposit_cents, a.price_cents);
    if (!cents) throw new AppError("invalid", "This service has no deposit set. Enter an amount.");
    requireInt(cents, "Deposit", { min: 1, max: a.price_cents });
    if (text && !a.phone) throw new AppError("invalid", "This customer has no phone number on file.");
    const d = await createDeposit(trx, { businessId: ctx.businessId, appointmentId, amountCents: cents });
    let texted: string | null = null;
    if (text && a.phone) {
      texted = appointmentText.deposit(
        a.store,
        a.pet_name,
        localDay(a.starts_at),
        minutesOfDay(a.starts_at),
        cents,
        d.url,
      );
      await trx
        .insertInto("appointment_messages")
        .values({
          business_id: ctx.businessId,
          appointment_id: appointmentId,
          kind: "deposit",
          to_address: a.phone,
          body: texted,
          created_by: ctx.staffId,
        })
        .execute();
    }
    return { depositId: d.id, amountCents: cents, url: d.url, texted };
  },
});

/** Refunds a paid deposit (or drops an unpaid link). Audited. */
export const refundDeposit = defineHandler<{ id: string }, { refundedCents: number }>({
  action: "sales.refund",
  async run(trx, ctx, { id }) {
    const d = await trx.selectFrom("deposits").select("status").where("id", "=", id).executeTakeFirst();
    if (!d) throw new AppError("not_found", "That deposit doesn't exist.");
    if (d.status !== "paid" && d.status !== "pending")
      throw new AppError(
        "invalid",
        d.status === "applied" || d.status === "kept"
          ? "This deposit is on a sale now. Refund the sale instead."
          : "This deposit has nothing left to refund.",
      );
    return { refundedCents: await giveBack(trx, ctx, id, "refunded by staff") };
  },
});
