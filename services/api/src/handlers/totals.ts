// The day's money, used by both the Sales page KPIs and end of day, so they can't disagree.
// Imported orders (source import) are never counted: that money was taken in the old system.
import { sql, type Transaction } from "kysely";
import type { DB } from "@pet-pos/db";

export interface MoneyTotals {
  /** Paid register sales rung in the range. */
  count: number;
  grossCents: number;
  discountCents: number;
  taxCents: number;
  astroDiscountCents: number;
  /** Completed payments taken in the range (cash is what stayed in the drawer, change excluded). */
  cardInCents: number;
  cashInCents: number;
  /** Refunds made in the range, on any sale, by where the money went. */
  cardBackCents: number;
  cashBackCents: number;
  refundCount: number;
  refundCents: number;
  /** gross − refunds. */
  netCents: number;
  /** Deposits paid online in the range: card money through Square, not the drawer or the counter reader. */
  depositsTakenCents: number;
  /** Deposits used on grooms paid at the register in the range. */
  depositsUsedCents: number;
  /** Deposits kept as no-show or cancellation fees in the range (part of gross sales). */
  depositsKeptCents: number;
  /** Deposits given back in the range: canceled grooms, and the part a sale didn't need. */
  depositsRefundedCents: number;
}

export async function moneyTotals(trx: Transaction<DB>, from: Date, to: Date): Promise<MoneyTotals> {
  const sales = await trx
    .selectFrom("sales")
    .select([
      sql<number>`count(*)::int`.as("count"),
      sql<number>`coalesce(sum(total_cents), 0)::int`.as("gross"),
      sql<number>`coalesce(sum(discount_cents), 0)::int`.as("discount"),
      sql<number>`coalesce(sum(tax_cents), 0)::int`.as("tax"),
    ])
    .where("source", "=", "register")
    .where("status", "=", "paid")
    .where("created_at", ">=", from)
    .where("created_at", "<", to)
    .executeTakeFirstOrThrow();
  const astro = await trx
    .selectFrom("sale_discounts as d")
    .innerJoin("sales as s", "s.id", "d.sale_id")
    .select(sql<number>`coalesce(sum(d.amount_cents), 0)::int`.as("n"))
    .where("s.source", "=", "register")
    .where("s.status", "=", "paid")
    .where("s.created_at", ">=", from)
    .where("s.created_at", "<", to)
    .where("d.source", "in", ["astro_offer", "astro_reward"])
    .executeTakeFirstOrThrow();
  // Voided sales' payments are marked refunded, so only money still held counts.
  const taken = await trx
    .selectFrom("payments")
    .select(["method", sql<number>`coalesce(sum(amount_cents), 0)::int`.as("n")])
    .where("status", "=", "completed")
    .where("completed_at", ">=", from)
    .where("completed_at", "<", to)
    .groupBy("method")
    .execute();
  const back = await trx
    .selectFrom("refund_payments as rp")
    .innerJoin("refunds as r", "r.id", "rp.refund_id")
    .select(["rp.method", sql<number>`sum(rp.amount_cents)::int`.as("n")])
    .where("r.created_at", ">=", from)
    .where("r.created_at", "<", to)
    .groupBy("rp.method")
    .execute();
  const refunds = await trx
    .selectFrom("refunds")
    .select([
      sql<number>`count(*)::int`.as("n"),
      sql<number>`coalesce(sum(amount_cents + tax_cents), 0)::int`.as("cents"),
    ])
    .where("created_at", ">=", from)
    .where("created_at", "<", to)
    .executeTakeFirstOrThrow();
  const deposits = await trx
    .selectFrom("deposits")
    .select([
      sql<number>`coalesce(sum(amount_cents) FILTER (WHERE paid_at >= ${from} AND paid_at < ${to}), 0)::int`.as(
        "taken",
      ),
      sql<number>`coalesce(sum(refunded_cents) FILTER (WHERE refunded_at >= ${from} AND refunded_at < ${to}), 0)::int`.as(
        "back",
      ),
    ])
    .executeTakeFirstOrThrow();
  const used = await trx
    .selectFrom("payments as p")
    .innerJoin("deposits as d", "d.id", "p.deposit_id")
    .select([
      sql<number>`coalesce(sum(p.amount_cents) FILTER (WHERE d.kept_sale_id IS DISTINCT FROM p.sale_id), 0)::int`.as(
        "used",
      ),
      sql<number>`coalesce(sum(p.amount_cents) FILTER (WHERE d.kept_sale_id = p.sale_id), 0)::int`.as("kept"),
    ])
    .where("p.method", "=", "deposit")
    .where("p.status", "=", "completed")
    .where("p.completed_at", ">=", from)
    .where("p.completed_at", "<", to)
    .executeTakeFirstOrThrow();
  const by = (rows: { method: string; n: number }[], m: "card" | "cash") =>
    rows.find((r) => r.method === m)?.n ?? 0;
  return {
    count: sales.count,
    grossCents: sales.gross,
    discountCents: sales.discount,
    taxCents: sales.tax,
    astroDiscountCents: astro.n,
    cardInCents: by(taken, "card"),
    cashInCents: by(taken, "cash"),
    cardBackCents: by(back, "card"),
    cashBackCents: by(back, "cash"),
    refundCount: refunds.n,
    refundCents: refunds.cents,
    netCents: sales.gross - refunds.cents,
    depositsTakenCents: deposits.taken,
    depositsUsedCents: used.used,
    depositsKeptCents: used.kept,
    depositsRefundedCents: deposits.back,
  };
}

export interface GroomerTotals {
  staffId: string;
  name: string;
  grooms: number;
  /** Paid for groom lines (after discounts, before tax), net of groom-line refunds in the range. */
  salesCents: number;
  refundCents: number;
}

/** Grooming sales by groomer for a range, and the no-shows. Part of the day's gross sales, broken down. */
export async function groomingTotals(
  trx: Transaction<DB>,
  from: Date,
  to: Date,
): Promise<{ groomers: GroomerTotals[]; noShows: number }> {
  const sold = await trx
    .selectFrom("sale_lines as l")
    .innerJoin("sales as s", "s.id", "l.sale_id")
    .innerJoin("appointments as a", "a.id", "l.appointment_id")
    .innerJoin("staff as st", "st.id", "a.staff_id")
    .select([
      "st.id",
      "st.name",
      sql<number>`count(*)::int`.as("grooms"),
      sql<number>`coalesce(sum(l.line_total_cents), 0)::int`.as("cents"),
    ])
    .where("s.source", "=", "register")
    .where("s.status", "=", "paid")
    .where("s.created_at", ">=", from)
    .where("s.created_at", "<", to)
    .groupBy(["st.id", "st.name"])
    .execute();
  const back = await trx
    .selectFrom("refund_lines as rl")
    .innerJoin("refunds as r", "r.id", "rl.refund_id")
    .innerJoin("sale_lines as l", "l.id", "rl.sale_line_id")
    .innerJoin("appointments as a", "a.id", "l.appointment_id")
    .select(["a.staff_id", sql<number>`coalesce(sum(rl.amount_cents), 0)::int`.as("cents")])
    .where("r.created_at", ">=", from)
    .where("r.created_at", "<", to)
    .groupBy("a.staff_id")
    .execute();
  const noShows = await trx
    .selectFrom("appointments")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("status", "=", "no_show")
    .where("starts_at", ">=", from)
    .where("starts_at", "<", to)
    .executeTakeFirstOrThrow();
  const ids = new Set([...sold.map((x) => x.id), ...back.map((x) => x.staff_id)]);
  const names = ids.size
    ? await trx
        .selectFrom("staff")
        .select(["id", "name"])
        .where("id", "in", [...ids])
        .execute()
    : [];
  const groomers = [...ids]
    .map((id) => {
      const s = sold.find((x) => x.id === id);
      const r = back.find((x) => x.staff_id === id)?.cents ?? 0;
      return {
        staffId: id,
        name: names.find((n) => n.id === id)?.name ?? "",
        grooms: s?.grooms ?? 0,
        salesCents: (s?.cents ?? 0) - r,
        refundCents: r,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { groomers, noShows: noShows.n };
}
