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
  return (await moneyTotalsByPeriod(trx, [from, to]))[0]!;
}

/**
 * moneyTotals for back-to-back periods in one go: edges [d0, d1, …, dn] give n periods,
 * d0..d1, d1..d2 and so on. The same queries as moneyTotals, grouped by period, so the
 * Reports page's day rows add up to its range totals and match end of day for each day.
 */
export async function moneyTotalsByPeriod(trx: Transaction<DB>, edges: Date[]): Promise<MoneyTotals[]> {
  if (edges.length < 2) throw new RangeError("moneyTotalsByPeriod needs at least two edges");
  const from = edges[0]!;
  const to = edges[edges.length - 1]!;
  const n = edges.length - 1;
  const arr = sql`ARRAY[${sql.join(edges.map((e) => sql`${e.toISOString()}::timestamptz`))}]`;
  // Period number 1..n for a time inside the range (width_bucket on the edges).
  const period = (col: string) => sql<number>`width_bucket(${sql.ref(col)}, ${arr})::int`;

  const sales = await trx
    .selectFrom("sales")
    .select([
      period("created_at").as("p"),
      sql<number>`count(*)::int`.as("count"),
      sql<number>`coalesce(sum(total_cents), 0)::int`.as("gross"),
      sql<number>`coalesce(sum(discount_cents), 0)::int`.as("discount"),
      sql<number>`coalesce(sum(tax_cents), 0)::int`.as("tax"),
    ])
    .where("source", "=", "register")
    .where("status", "=", "paid")
    .where("created_at", ">=", from)
    .where("created_at", "<", to)
    .groupBy(sql`1`)
    .execute();
  const astro = await trx
    .selectFrom("sale_discounts as d")
    .innerJoin("sales as s", "s.id", "d.sale_id")
    .select([period("s.created_at").as("p"), sql<number>`coalesce(sum(d.amount_cents), 0)::int`.as("n")])
    .where("s.source", "=", "register")
    .where("s.status", "=", "paid")
    .where("s.created_at", ">=", from)
    .where("s.created_at", "<", to)
    .where("d.source", "in", ["astro_offer", "astro_reward"])
    .groupBy(sql`1`)
    .execute();
  // Voided sales' payments are marked refunded, so only money still held counts.
  const taken = await trx
    .selectFrom("payments")
    .select([
      period("completed_at").as("p"),
      "method",
      sql<number>`coalesce(sum(amount_cents), 0)::int`.as("n"),
    ])
    .where("status", "=", "completed")
    .where("completed_at", ">=", from)
    .where("completed_at", "<", to)
    .groupBy([sql`1`, "method"])
    .execute();
  const back = await trx
    .selectFrom("refund_payments as rp")
    .innerJoin("refunds as r", "r.id", "rp.refund_id")
    .select([period("r.created_at").as("p"), "rp.method", sql<number>`sum(rp.amount_cents)::int`.as("n")])
    .where("r.created_at", ">=", from)
    .where("r.created_at", "<", to)
    .groupBy([sql`1`, "rp.method"])
    .execute();
  const refunds = await trx
    .selectFrom("refunds")
    .select([
      period("created_at").as("p"),
      sql<number>`count(*)::int`.as("n"),
      sql<number>`coalesce(sum(amount_cents + tax_cents), 0)::int`.as("cents"),
    ])
    .where("created_at", ">=", from)
    .where("created_at", "<", to)
    .groupBy(sql`1`)
    .execute();
  const depositsPaid = await trx
    .selectFrom("deposits")
    .select([period("paid_at").as("p"), sql<number>`coalesce(sum(amount_cents), 0)::int`.as("n")])
    .where("paid_at", ">=", from)
    .where("paid_at", "<", to)
    .groupBy(sql`1`)
    .execute();
  const depositsBack = await trx
    .selectFrom("deposits")
    .select([period("refunded_at").as("p"), sql<number>`coalesce(sum(refunded_cents), 0)::int`.as("n")])
    .where("refunded_at", ">=", from)
    .where("refunded_at", "<", to)
    .groupBy(sql`1`)
    .execute();
  const used = await trx
    .selectFrom("payments as p")
    .innerJoin("deposits as d", "d.id", "p.deposit_id")
    .select([
      period("p.completed_at").as("p"),
      sql<number>`coalesce(sum(p.amount_cents) FILTER (WHERE d.kept_sale_id IS DISTINCT FROM p.sale_id), 0)::int`.as(
        "used",
      ),
      sql<number>`coalesce(sum(p.amount_cents) FILTER (WHERE d.kept_sale_id = p.sale_id), 0)::int`.as("kept"),
    ])
    .where("p.method", "=", "deposit")
    .where("p.status", "=", "completed")
    .where("p.completed_at", ">=", from)
    .where("p.completed_at", "<", to)
    .groupBy(sql`1`)
    .execute();

  return Array.from({ length: n }, (_, i) => {
    const p = i + 1;
    const s = sales.find((r) => r.p === p);
    const ref = refunds.find((r) => r.p === p);
    const by = (rows: { p: number; method: string; n: number }[], m: "card" | "cash") =>
      rows.find((r) => r.p === p && r.method === m)?.n ?? 0;
    const u = used.find((r) => r.p === p);
    const gross = s?.gross ?? 0;
    const refundCents = ref?.cents ?? 0;
    return {
      count: s?.count ?? 0,
      grossCents: gross,
      discountCents: s?.discount ?? 0,
      taxCents: s?.tax ?? 0,
      astroDiscountCents: astro.find((r) => r.p === p)?.n ?? 0,
      cardInCents: by(taken, "card"),
      cashInCents: by(taken, "cash"),
      cardBackCents: by(back, "card"),
      cashBackCents: by(back, "cash"),
      refundCount: ref?.n ?? 0,
      refundCents,
      netCents: gross - refundCents,
      depositsTakenCents: depositsPaid.find((r) => r.p === p)?.n ?? 0,
      depositsUsedCents: u?.used ?? 0,
      depositsKeptCents: u?.kept ?? 0,
      depositsRefundedCents: depositsBack.find((r) => r.p === p)?.n ?? 0,
    };
  });
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

export interface CategoryTotals {
  /** The category the line sold under; null for lines with none. */
  category: string | null;
  /** Units sold in the range. */
  qty: number;
  /** Paid for lines in the range (after discounts, before tax). */
  salesCents: number;
  /** Refunded in the range (before tax), on any sale, by the refunded line's category. */
  refundCents: number;
  netCents: number;
}

/**
 * Sales by category for a range, net of refunds made in it. The rows add up to
 * moneyTotals' gross − tax − refunds before tax, so the Reports page can't disagree
 * with the Sales page.
 */
export async function categoryTotals(trx: Transaction<DB>, from: Date, to: Date): Promise<CategoryTotals[]> {
  const sold = await trx
    .selectFrom("sale_lines as l")
    .innerJoin("sales as s", "s.id", "l.sale_id")
    .select([
      "l.category",
      sql<number>`coalesce(sum(l.qty), 0)::int`.as("qty"),
      sql<number>`coalesce(sum(l.line_total_cents), 0)::int`.as("cents"),
    ])
    .where("s.source", "=", "register")
    .where("s.status", "=", "paid")
    .where("s.created_at", ">=", from)
    .where("s.created_at", "<", to)
    .groupBy("l.category")
    .execute();
  const back = await trx
    .selectFrom("refund_lines as rl")
    .innerJoin("refunds as r", "r.id", "rl.refund_id")
    .innerJoin("sale_lines as l", "l.id", "rl.sale_line_id")
    .select(["l.category", sql<number>`coalesce(sum(rl.amount_cents), 0)::int`.as("cents")])
    .where("r.created_at", ">=", from)
    .where("r.created_at", "<", to)
    .groupBy("l.category")
    .execute();
  const keys = [...new Set([...sold.map((x) => x.category), ...back.map((x) => x.category)])];
  return keys.map((category) => {
    const s = sold.find((x) => x.category === category);
    const r = back.find((x) => x.category === category)?.cents ?? 0;
    return {
      category,
      qty: s?.qty ?? 0,
      salesCents: s?.cents ?? 0,
      refundCents: r,
      netCents: (s?.cents ?? 0) - r,
    };
  });
}
