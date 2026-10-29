// Deposits, shared by the booking page, the grooming calendar and the register: holding a
// time while the customer pays, marking it paid, refunding, keeping it as a fee, and
// applying it to the sale at pickup. Payment links go through `checkout`.
import { sql, type Transaction } from "kysely";
import { AppError, applyDeposit, clockText, minutesOfDay, shortDay } from "@pet-pos/core";
import type { DB, DepositStatus } from "@pet-pos/db";
import { confirmBooking } from "./messages.ts";
import { checkout } from "./payments/checkout.ts";
import { currentLocationId, nextReceiptNumber } from "./shared.ts";

type Trx = Transaction<DB>;

/** Who did it, for the audit log: a staff member, or the customer online (no staff id). */
export interface Actor {
  businessId: string;
  staffId: string | null;
}

async function log(
  trx: Trx,
  actor: Actor,
  action: string,
  depositId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  await trx
    .insertInto("audit_log")
    .values({
      business_id: actor.businessId,
      staff_id: actor.staffId,
      action,
      entity: "deposit",
      entity_id: depositId,
      before: JSON.stringify(before),
      after: JSON.stringify(after),
    })
    .execute();
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "Thu Oct 22, 9:00 AM" */
export function apptWhen(startsAt: Date): string {
  return `${shortDay(localDay(startsAt))}, ${clockText(minutesOfDay(startsAt))}`;
}

/**
 * Cancels held bookings whose time to pay has run out, so they stop blocking the slot.
 * Runs before anything looks for free time.
 */
export async function releaseHolds(trx: Trx): Promise<number> {
  const gone = await trx
    .updateTable("appointments")
    .set({ status: "canceled", canceled_at: new Date() })
    .where("status", "=", "held")
    .where("hold_expires_at", "<", new Date())
    .returning(["id", "deposit_id"])
    .execute();
  const ids = gone.map((g) => g.deposit_id).filter((x): x is string => !!x);
  if (ids.length)
    await trx
      .updateTable("deposits")
      .set({ status: "expired" })
      .where("id", "in", ids)
      .where("status", "=", "pending")
      .execute();
  return gone.length;
}

/** Makes the deposit and its payment link, and ties it to the appointment. */
export async function createDeposit(
  trx: Trx,
  v: { businessId: string; appointmentId: string; amountCents: number },
): Promise<{ id: string; url: string }> {
  const a = await trx
    .selectFrom("appointments as a")
    .innerJoin("businesses as b", "b.id", "a.business_id")
    .select(["a.customer_id", "a.pet_name", "a.service_name", "a.starts_at", "a.is_demo", "b.name as store"])
    .where("a.id", "=", v.appointmentId)
    .executeTakeFirstOrThrow();
  const d = await trx
    .insertInto("deposits")
    .values({
      business_id: v.businessId,
      appointment_id: v.appointmentId,
      customer_id: a.customer_id,
      amount_cents: v.amountCents,
      is_demo: a.is_demo,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const link = await checkout.createLink({
    depositId: d.id,
    amountCents: v.amountCents,
    description: `${a.store}: deposit for ${a.pet_name}'s ${a.service_name}, ${apptWhen(a.starts_at)}`,
  });
  await trx
    .updateTable("deposits")
    .set({ link_id: link.linkId, link_url: link.url })
    .where("id", "=", d.id)
    .execute();
  await trx.updateTable("appointments").set({ deposit_id: d.id }).where("id", "=", v.appointmentId).execute();
  return { id: d.id, url: link.url };
}

export type PaidResult = "paid" | "already" | "refunded_late";

/**
 * The payment came in (Square's webhook, or the demo's Pay button). A held booking
 * becomes booked. If the booking is gone by then (the hold ran out, or it was canceled),
 * the money goes straight back. Safe to call twice.
 */
export async function markDepositPaid(trx: Trx, depositId: string, providerRef: string): Promise<PaidResult> {
  const d = await trx
    .selectFrom("deposits")
    .selectAll()
    .where("id", "=", depositId)
    .forUpdate()
    .executeTakeFirst();
  if (!d) throw new AppError("not_found", "That deposit doesn't exist.");
  if (!["pending", "expired", "canceled"].includes(d.status)) return "already";
  const a = await trx
    .selectFrom("appointments")
    .select(["id", "status"])
    .where("id", "=", d.appointment_id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const now = new Date();
  const live = ["held", "booked", "checked_in", "in_progress", "ready"].includes(a.status);
  if (d.status === "pending" && live) {
    await trx
      .updateTable("deposits")
      .set({ status: "paid", provider_ref: providerRef, paid_at: now })
      .where("id", "=", d.id)
      .execute();
    if (a.status === "held") {
      await trx
        .updateTable("appointments")
        .set({ status: "booked", hold_expires_at: null })
        .where("id", "=", a.id)
        .execute();
      // A held online booking is confirmed once its deposit is in.
      await confirmBooking(trx, { businessId: d.business_id, staffId: null }, a.id);
    }
    return "paid";
  }
  const { refundRef } = await checkout.refund(providerRef, d.amount_cents);
  await trx
    .updateTable("deposits")
    .set({
      status: "refunded",
      provider_ref: providerRef,
      paid_at: now,
      refund_ref: refundRef,
      refunded_cents: d.amount_cents,
      refunded_at: now,
    })
    .where("id", "=", d.id)
    .execute();
  await log(
    trx,
    { businessId: d.business_id, staffId: null },
    "deposit.refund",
    d.id,
    { status: d.status },
    { status: "refunded", refunded_cents: d.amount_cents, reason: "paid after the booking was gone" },
  );
  return "refunded_late";
}

/**
 * Gives a deposit back: a paid one is refunded to the card, an unpaid one's link is
 * dropped. Returns the cents refunded. Anything already used or refunded is left alone.
 */
export async function refundDeposit(
  trx: Trx,
  actor: Actor,
  depositId: string,
  reason: string,
): Promise<number> {
  const d = await trx
    .selectFrom("deposits")
    .selectAll()
    .where("id", "=", depositId)
    .forUpdate()
    .executeTakeFirst();
  if (!d) return 0;
  if (d.status === "pending") {
    await trx.updateTable("deposits").set({ status: "canceled" }).where("id", "=", d.id).execute();
    return 0;
  }
  if (d.status !== "paid" || !d.provider_ref) return 0;
  const cents = d.amount_cents - d.refunded_cents;
  const { refundRef } = await checkout.refund(d.provider_ref, cents);
  await trx
    .updateTable("deposits")
    .set({
      status: "refunded",
      refund_ref: refundRef,
      refunded_cents: d.amount_cents,
      refunded_at: new Date(),
    })
    .where("id", "=", d.id)
    .execute();
  await log(
    trx,
    actor,
    "deposit.refund",
    d.id,
    { status: d.status },
    { status: "refunded", refunded_cents: cents, reason },
  );
  return cents;
}

/** Refunds the live deposit on each of these appointments (canceled by staff, a call-out, or a customer delete). */
export async function refundDepositsFor(trx: Trx, actor: Actor, appointmentIds: string[], reason: string) {
  if (!appointmentIds.length) return 0;
  const ds = await trx
    .selectFrom("deposits")
    .select("id")
    .where("appointment_id", "in", appointmentIds)
    .where("status", "in", ["pending", "paid"])
    .execute();
  let n = 0;
  for (const d of ds) n += await refundDeposit(trx, actor, d.id, reason);
  return n;
}

/**
 * Keeps a paid deposit as a no-show or late-cancel fee: a paid sale with one untaxed
 * line, paid by the deposit, so it counts in sales, has a receipt and can be refunded.
 */
export async function keepDeposit(
  trx: Trx,
  actor: Actor & { staffId: string },
  depositId: string,
  label: "No-show fee" | "Cancellation fee",
): Promise<{ saleId: string; receiptNumber: number }> {
  const d = await trx
    .selectFrom("deposits as d")
    .innerJoin("appointments as a", "a.id", "d.appointment_id")
    .select([
      "d.id",
      "d.status",
      "d.amount_cents",
      "d.refunded_cents",
      "d.provider_ref",
      "d.customer_id",
      "d.is_demo",
      "a.pet_name",
      "a.starts_at",
    ])
    .where("d.id", "=", depositId)
    .forUpdate("d")
    .executeTakeFirst();
  if (!d || d.status !== "paid") throw new AppError("invalid", "There's no paid deposit to keep.");
  const cents = d.amount_cents - d.refunded_cents;
  const locationId = await currentLocationId(trx);
  const loc = await trx
    .selectFrom("locations")
    .select("tax_rate_mpct")
    .where("id", "=", locationId)
    .executeTakeFirstOrThrow();
  const receiptNumber = await nextReceiptNumber(trx, actor.businessId);
  const now = new Date();
  const sale = await trx
    .insertInto("sales")
    .values({
      business_id: actor.businessId,
      location_id: locationId,
      customer_id: d.customer_id,
      staff_id: actor.staffId,
      receipt_number: receiptNumber,
      status: "paid",
      subtotal_cents: cents,
      total_cents: cents,
      tax_rate_mpct: loc.tax_rate_mpct,
      discounts_before_tax: false,
      paid_at: now,
      is_demo: d.is_demo,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await trx
    .insertInto("sale_lines")
    .values({
      business_id: actor.businessId,
      sale_id: sale.id,
      position: 1,
      name: `${label}: ${d.pet_name}, ${shortDay(localDay(d.starts_at))}`,
      tax_class: "exempt",
      qty: 1,
      unit_price_cents: cents,
      line_total_cents: cents,
    })
    .execute();
  await trx
    .insertInto("payments")
    .values({
      business_id: actor.businessId,
      sale_id: sale.id,
      method: "deposit",
      provider: "square",
      provider_ref: d.provider_ref,
      status: "completed",
      amount_cents: cents,
      staff_id: actor.staffId,
      completed_at: now,
      deposit_id: d.id,
    })
    .execute();
  await trx
    .updateTable("deposits")
    .set({ status: "kept", kept_sale_id: sale.id })
    .where("id", "=", d.id)
    .execute();
  await log(
    trx,
    actor,
    "deposit.keep",
    d.id,
    { status: "paid" },
    { status: "kept", sale_id: sale.id, cents, label },
  );
  return { saleId: sale.id, receiptNumber };
}

/**
 * Applies the paid deposits on these grooms to a new sale, up to its total. Any part a
 * discounted sale doesn't need goes back to the customer's card.
 */
export async function applyDepositsToSale(
  trx: Trx,
  actor: Actor,
  saleId: string,
  appointmentIds: string[],
  totalCents: number,
): Promise<{ appliedCents: number; refundedCents: number }> {
  if (!appointmentIds.length) return { appliedCents: 0, refundedCents: 0 };
  const ds = await trx
    .selectFrom("deposits")
    .selectAll()
    .where("appointment_id", "in", appointmentIds)
    .where("status", "=", "paid")
    .orderBy("paid_at")
    .forUpdate()
    .execute();
  let applied = 0;
  let refunded = 0;
  for (const d of ds) {
    const available = d.amount_cents - d.refunded_cents;
    const r = applyDeposit(totalCents - applied, available);
    let status: DepositStatus = "applied";
    let refundRef = d.refund_ref;
    if (r.refundCents > 0 && d.provider_ref) {
      refundRef = (await checkout.refund(d.provider_ref, r.refundCents)).refundRef;
      await log(
        trx,
        actor,
        "deposit.refund",
        d.id,
        { status: "paid" },
        {
          status: r.appliedCents ? "applied" : "refunded",
          refunded_cents: r.refundCents,
          reason: "more than the sale needed",
          sale_id: saleId,
        },
      );
    }
    if (r.appliedCents > 0)
      await trx
        .insertInto("payments")
        .values({
          business_id: actor.businessId,
          sale_id: saleId,
          method: "deposit",
          provider: "square",
          provider_ref: d.provider_ref,
          status: "completed",
          amount_cents: r.appliedCents,
          staff_id: actor.staffId,
          completed_at: new Date(),
          deposit_id: d.id,
        })
        .execute();
    else status = "refunded";
    await trx
      .updateTable("deposits")
      .set({
        status,
        applied_sale_id: r.appliedCents > 0 ? saleId : null,
        refunded_cents: d.refunded_cents + r.refundCents,
        refund_ref: refundRef,
        refunded_at: r.refundCents > 0 ? new Date() : d.refunded_at,
      })
      .where("id", "=", d.id)
      .execute();
    applied += r.appliedCents;
    refunded += r.refundCents;
  }
  return { appliedCents: applied, refundedCents: refunded };
}

/** A voided sale gives its deposits back to their grooms, ready to apply next time. */
export async function restoreDeposits(trx: Trx, saleId: string): Promise<void> {
  const pays = await trx
    .selectFrom("payments")
    .select(["id", "deposit_id"])
    .where("sale_id", "=", saleId)
    .where("method", "=", "deposit")
    .where("status", "=", "completed")
    .execute();
  for (const p of pays) {
    await trx.updateTable("payments").set({ status: "canceled" }).where("id", "=", p.id).execute();
    if (p.deposit_id)
      await trx
        .updateTable("deposits")
        .set({ status: "paid", applied_sale_id: null })
        .where("id", "=", p.deposit_id)
        .where("status", "=", "applied")
        .execute();
  }
}

/** Paid deposits waiting on these grooms, for showing on the register ticket. */
export async function paidDeposits(trx: Trx, appointmentIds: string[]): Promise<Map<string, number>> {
  if (!appointmentIds.length) return new Map();
  const rows = await trx
    .selectFrom("deposits")
    .select(["appointment_id", sql<number>`sum(amount_cents - refunded_cents)::int`.as("cents")])
    .where("appointment_id", "in", appointmentIds)
    .where("status", "=", "paid")
    .groupBy("appointment_id")
    .execute();
  return new Map(rows.map((r) => [r.appointment_id, r.cents]));
}
