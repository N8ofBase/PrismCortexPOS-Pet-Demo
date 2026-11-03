// Reports (Phase 5a). All read-only, for owners and managers. Money comes from the
// shared totals (moneyTotals, categoryTotals, groomingTotals), so a report can't
// disagree with the Sales page or end of day. Imported orders never count.
import { sql, type Transaction } from "kysely";
import {
  AppError,
  addDays,
  atLocal,
  averageCents,
  CATEGORIES,
  FEES_CATEGORY,
  GROOMING_CATEGORY,
  rebookStats,
  reportDays,
  todayIso,
  weekStart,
  type DoneGroom,
  type RebookStats,
} from "@pet-pos/core";
import type { DB } from "@pet-pos/db";
import { defineHandler } from "../handler.ts";
import { localDay } from "./grooming.ts";
import {
  categoryTotals,
  groomingTotals,
  moneyTotals,
  moneyTotalsByPeriod,
  type CategoryTotals,
  type MoneyTotals,
} from "./totals.ts";

type Trx = Transaction<DB>;

export interface ReportRange {
  /** First business day, "YYYY-MM-DD". */
  from: string;
  /** Last business day, inclusive. */
  to: string;
}

/** Local midnight of the first day to local midnight after the last. */
function bounds(r: ReportRange): { days: string[]; start: Date; end: Date } {
  const days = reportDays(r.from, r.to);
  return { days, start: atLocal(r.from, 0), end: atLocal(addDays(r.to, 1), 0) };
}

// ---- Sales ----

export interface PaymentTypeRow {
  key: "card" | "cash" | "deposits";
  label: string;
  inCents: number;
  backCents: number;
  netCents: number;
}

export interface SalesDayRow {
  day: string;
  count: number;
  netCents: number;
  cardCents: number;
  cashCents: number;
  depositsCents: number;
  taxCents: number;
}

export interface TopProductRow {
  productId: string;
  name: string;
  sku: string | null;
  qty: number;
  netCents: number;
}

export interface SalesReport {
  totals: MoneyTotals;
  /** Refunds before tax, so the category rows can be checked against the tiles. */
  refundTaxCents: number;
  paymentTypes: PaymentTypeRow[];
  categories: CategoryTotals[];
  days: SalesDayRow[];
  topProducts: TopProductRow[];
}

/** Product categories in the store's order, then any others, then Grooming, Fees and none. */
export function categoryOrder(a: string | null, b: string | null): number {
  const rank = (c: string | null) => {
    if (c === null) return 1000;
    if (c === FEES_CATEGORY) return 999;
    if (c === GROOMING_CATEGORY) return 998;
    const i = (CATEGORIES as readonly string[]).indexOf(c);
    return i >= 0 ? i : 100;
  };
  return rank(a) - rank(b) || (a ?? "").localeCompare(b ?? "");
}

export const salesReport = defineHandler<ReportRange, SalesReport>({
  action: "reports.view",
  async run(trx, _ctx, range) {
    const { days, start, end } = bounds(range);
    const totals = await moneyTotals(trx, start, end);
    const refundTax = await trx
      .selectFrom("refunds")
      .select(sql<number>`coalesce(sum(tax_cents), 0)::int`.as("n"))
      .where("created_at", ">=", start)
      .where("created_at", "<", end)
      .executeTakeFirstOrThrow();
    const paymentTypes: PaymentTypeRow[] = [
      row("card", "Card (counter)", totals.cardInCents, totals.cardBackCents),
      row("cash", "Cash", totals.cashInCents, totals.cashBackCents),
      row("deposits", "Deposits paid online", totals.depositsTakenCents, totals.depositsRefundedCents),
    ];
    const categories = (await categoryTotals(trx, start, end)).sort((a, b) =>
      categoryOrder(a.category, b.category),
    );

    // One period per day, from the same queries as the range totals.
    const perDay = await moneyTotalsByPeriod(trx, [...days.map((d) => atLocal(d, 0)), end]);
    const dayRows: SalesDayRow[] = days.map((day, i) => {
      const t = perDay[i]!;
      return {
        day,
        count: t.count,
        netCents: t.netCents,
        cardCents: t.cardInCents - t.cardBackCents,
        cashCents: t.cashInCents - t.cashBackCents,
        depositsCents: t.depositsTakenCents - t.depositsRefundedCents,
        taxCents: t.taxCents,
      };
    });

    return {
      totals,
      refundTaxCents: refundTax.n,
      paymentTypes,
      categories,
      days: dayRows,
      topProducts: await topProducts(trx, start, end, 20),
    };
  },
});

function row(key: PaymentTypeRow["key"], label: string, inCents: number, backCents: number): PaymentTypeRow {
  return { key, label, inCents, backCents, netCents: inCents - backCents };
}

async function topProducts(trx: Trx, start: Date, end: Date, limit: number): Promise<TopProductRow[]> {
  const sold = await trx
    .selectFrom("sale_lines as l")
    .innerJoin("sales as s", "s.id", "l.sale_id")
    .select([
      "l.product_id",
      sql<string>`max(l.name)`.as("name"),
      sql<string | null>`max(l.sku)`.as("sku"),
      sql<number>`sum(l.qty)::int`.as("qty"),
      sql<number>`sum(l.line_total_cents)::int`.as("cents"),
    ])
    .where("l.product_id", "is not", null)
    .where("s.source", "=", "register")
    .where("s.status", "=", "paid")
    .where("s.created_at", ">=", start)
    .where("s.created_at", "<", end)
    .groupBy("l.product_id")
    .execute();
  const back = await trx
    .selectFrom("refund_lines as rl")
    .innerJoin("refunds as r", "r.id", "rl.refund_id")
    .innerJoin("sale_lines as l", "l.id", "rl.sale_line_id")
    .select(["l.product_id", sql<number>`sum(rl.amount_cents)::int`.as("cents")])
    .where("l.product_id", "is not", null)
    .where("r.created_at", ">=", start)
    .where("r.created_at", "<", end)
    .groupBy("l.product_id")
    .execute();
  const names = sold.length
    ? await trx
        .selectFrom("products")
        .select(["id", "name", "sku"])
        .where(
          "id",
          "in",
          sold.map((s) => s.product_id!),
        )
        .execute()
    : [];
  return sold
    .map((s) => {
      const p = names.find((n) => n.id === s.product_id);
      return {
        productId: s.product_id!,
        name: p?.name ?? s.name,
        sku: p?.sku ?? s.sku,
        qty: s.qty,
        netCents: s.cents - (back.find((b) => b.product_id === s.product_id)?.cents ?? 0),
      };
    })
    .sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name))
    .slice(0, limit);
}

// ---- Grooming ----

export interface GroomerReportRow {
  staffId: string;
  name: string;
  grooms: number;
  salesCents: number;
  refundCents: number;
  averageCents: number;
  noShows: number;
}

export interface ServiceReportRow {
  serviceId: string;
  name: string;
  grooms: number;
  salesCents: number;
}

export interface NoShowRow {
  id: string;
  startsAt: Date;
  petName: string;
  customerName: string | null;
  groomerName: string;
  serviceName: string;
  /** A deposit kept as a no-show fee. */
  keptCents: number | null;
}

export interface GroomingReport {
  revenueCents: number;
  grooms: number;
  /** Grooms booked in the range that weren't canceled: the base for the no-show share. */
  booked: number;
  noShows: number;
  groomers: GroomerReportRow[];
  services: ServiceReportRow[];
  noShowList: NoShowRow[];
  rebook: RebookStats;
}

export const groomingReport = defineHandler<ReportRange & { today?: string }, GroomingReport>({
  action: "reports.view",
  async run(trx, _ctx, range) {
    const { start, end } = bounds(range);
    const { groomers } = await groomingTotals(trx, start, end);
    const perGroomer = await trx
      .selectFrom("appointments")
      .select(["staff_id", sql<number>`count(*)::int`.as("n")])
      .where("status", "=", "no_show")
      .where("starts_at", ">=", start)
      .where("starts_at", "<", end)
      .groupBy("staff_id")
      .execute();
    const missingIds = perGroomer
      .map((p) => p.staff_id)
      .filter((id) => !groomers.some((g) => g.staffId === id));
    const missing = missingIds.length
      ? await trx.selectFrom("staff").select(["id", "name"]).where("id", "in", missingIds).execute()
      : [];
    const rows: GroomerReportRow[] = [
      ...groomers.map((g) => ({
        ...g,
        averageCents: averageCents(g.salesCents, g.grooms),
        noShows: perGroomer.find((p) => p.staff_id === g.staffId)?.n ?? 0,
      })),
      ...missing.map((m) => ({
        staffId: m.id,
        name: m.name,
        grooms: 0,
        salesCents: 0,
        refundCents: 0,
        averageCents: 0,
        noShows: perGroomer.find((p) => p.staff_id === m.id)?.n ?? 0,
      })),
    ].sort((a, b) => a.name.localeCompare(b.name));

    const booked = await trx
      .selectFrom("appointments")
      .select([
        sql<number>`count(*) FILTER (WHERE status NOT IN ('canceled', 'held'))::int`.as("booked"),
        sql<number>`count(*) FILTER (WHERE status = 'no_show')::int`.as("noShows"),
      ])
      .where("starts_at", ">=", start)
      .where("starts_at", "<", end)
      .executeTakeFirstOrThrow();

    const services = await serviceTotals(trx, start, end);

    const noShowList = await trx
      .selectFrom("appointments as a")
      .innerJoin("staff as st", "st.id", "a.staff_id")
      .leftJoin("customers as c", "c.id", "a.customer_id")
      .leftJoin("deposits as d", (j) => j.onRef("d.id", "=", "a.deposit_id").on("d.status", "=", "kept"))
      .select([
        "a.id",
        "a.starts_at as startsAt",
        "a.pet_name as petName",
        "c.name as customerName",
        "st.name as groomerName",
        "a.service_name as serviceName",
        "d.amount_cents as keptCents",
      ])
      .where("a.status", "=", "no_show")
      .where("a.starts_at", ">=", start)
      .where("a.starts_at", "<", end)
      .orderBy("a.starts_at")
      .limit(500)
      .execute();

    const done = await trx
      .selectFrom("appointments as a")
      .innerJoin("services as sv", "sv.id", "a.service_id")
      .select([
        "a.starts_at",
        "sv.rebook_weeks",
        sql<Date | null>`n.starts_at`.as("next_at"),
        sql<Date | null>`n.created_at`.as("next_booked_at"),
      ])
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom("appointments as x")
            .select(["x.starts_at", "x.created_at"])
            .whereRef("x.pet_id", "=", "a.pet_id")
            .whereRef("x.starts_at", ">", "a.starts_at")
            .where("x.status", "not in", ["canceled", "no_show", "held"])
            .orderBy("x.starts_at")
            .limit(1)
            .as("n"),
        (j) => j.onTrue(),
      )
      .where("a.status", "=", "done")
      .where("a.pet_id", "is not", null)
      .where("a.starts_at", ">=", start)
      .where("a.starts_at", "<", end)
      .execute();
    const grooms: DoneGroom[] = done.map((d) => ({
      day: localDay(d.starts_at),
      rebookWeeks: d.rebook_weeks,
      next:
        d.next_at && d.next_booked_at
          ? { day: localDay(d.next_at), bookedDay: localDay(d.next_booked_at) }
          : null,
    }));

    const revenue = rows.reduce((s, g) => s + g.salesCents, 0);
    return {
      revenueCents: revenue,
      grooms: rows.reduce((s, g) => s + g.grooms, 0),
      booked: booked.booked,
      noShows: booked.noShows,
      groomers: rows,
      services,
      noShowList,
      rebook: rebookStats(grooms, range.today ?? todayIso()),
    };
  },
});

async function serviceTotals(trx: Trx, start: Date, end: Date): Promise<ServiceReportRow[]> {
  const sold = await trx
    .selectFrom("sale_lines as l")
    .innerJoin("sales as s", "s.id", "l.sale_id")
    .innerJoin("appointments as a", "a.id", "l.appointment_id")
    .select([
      "a.service_id",
      sql<string>`max(a.service_name)`.as("name"),
      sql<number>`count(*)::int`.as("grooms"),
      sql<number>`sum(l.line_total_cents)::int`.as("cents"),
    ])
    .where("s.source", "=", "register")
    .where("s.status", "=", "paid")
    .where("s.created_at", ">=", start)
    .where("s.created_at", "<", end)
    .groupBy("a.service_id")
    .execute();
  const back = await trx
    .selectFrom("refund_lines as rl")
    .innerJoin("refunds as r", "r.id", "rl.refund_id")
    .innerJoin("sale_lines as l", "l.id", "rl.sale_line_id")
    .innerJoin("appointments as a", "a.id", "l.appointment_id")
    .select(["a.service_id", sql<number>`sum(rl.amount_cents)::int`.as("cents")])
    .where("r.created_at", ">=", start)
    .where("r.created_at", "<", end)
    .groupBy("a.service_id")
    .execute();
  const ids = [...new Set([...sold.map((s) => s.service_id), ...back.map((b) => b.service_id)])];
  const names = ids.length
    ? await trx.selectFrom("services").select(["id", "name"]).where("id", "in", ids).execute()
    : [];
  return ids
    .map((id) => {
      const s = sold.find((x) => x.service_id === id);
      return {
        serviceId: id,
        name: names.find((n) => n.id === id)?.name ?? s?.name ?? "",
        grooms: s?.grooms ?? 0,
        salesCents: (s?.cents ?? 0) - (back.find((b) => b.service_id === id)?.cents ?? 0),
      };
    })
    .sort((a, b) => b.salesCents - a.salesCents || a.name.localeCompare(b.name));
}

// ---- Stock ----

export interface ReorderRow {
  productId: string;
  sku: string;
  name: string;
  brand: string | null;
  category: string;
  onHand: number;
  reorderAt: number;
  soldLast30: number;
  costCents: number;
  backBar: boolean;
}

export interface StockCategoryRow {
  category: string;
  units: number;
  costCents: number;
  retailCents: number;
}

export interface CountToCheckRow {
  productId: string;
  sku: string;
  name: string;
  onHand: number;
}

export interface StockReport {
  asOf: string;
  costCents: number;
  retailCents: number;
  low: number;
  out: number;
  /** Products with stock on hand and no cost entered: left out of the cost value. */
  noCost: number;
  reorder: ReorderRow[];
  categories: StockCategoryRow[];
  countsToCheck: CountToCheckRow[];
}

export const stockReport = defineHandler<{ today?: string } | undefined, StockReport>({
  action: "reports.view",
  async run(trx, _ctx, input) {
    const today = input?.today ?? todayIso();
    const since = atLocal(addDays(today, -29), 0);
    const products = await trx
      .selectFrom("products as p")
      .leftJoin("inventory_levels as l", "l.product_id", "p.id")
      .select([
        "p.id",
        "p.sku",
        "p.name",
        "p.brand",
        "p.category",
        "p.price_cents",
        "p.cost_cents",
        "p.reorder_at",
        "p.back_bar",
        sql<number>`coalesce(sum(l.on_hand), 0)::int`.as("on_hand"),
      ])
      .where("p.active", "=", true)
      .groupBy("p.id")
      .orderBy("p.name")
      .execute();
    const sold = await trx
      .selectFrom("inventory_moves")
      .select(["product_id", sql<number>`(-sum(qty_change))::int`.as("n")])
      .where("reason", "=", "sale")
      .where("created_at", ">=", since)
      .groupBy("product_id")
      .execute();

    let cost = 0;
    let retail = 0;
    let noCost = 0;
    const cats = new Map<string, StockCategoryRow>();
    for (const p of products) {
      const units = Math.max(0, p.on_hand);
      cost += units * p.cost_cents;
      if (!p.back_bar) retail += units * p.price_cents;
      if (units > 0 && p.cost_cents === 0) noCost++;
      const c = cats.get(p.category) ?? { category: p.category, units: 0, costCents: 0, retailCents: 0 };
      c.units += units;
      c.costCents += units * p.cost_cents;
      if (!p.back_bar) c.retailCents += units * p.price_cents;
      cats.set(p.category, c);
    }
    const low = products.filter((p) => p.on_hand <= p.reorder_at);
    return {
      asOf: today,
      costCents: cost,
      retailCents: retail,
      low: low.filter((p) => p.on_hand > 0).length,
      out: low.filter((p) => p.on_hand <= 0).length,
      noCost,
      reorder: low
        .map((p) => ({
          productId: p.id,
          sku: p.sku,
          name: p.name,
          brand: p.brand,
          category: p.category,
          onHand: p.on_hand,
          reorderAt: p.reorder_at,
          soldLast30: sold.find((s) => s.product_id === p.id)?.n ?? 0,
          costCents: p.cost_cents,
          backBar: p.back_bar,
        }))
        .sort((a, b) => Number(a.onHand > 0) - Number(b.onHand > 0) || a.name.localeCompare(b.name)),
      categories: [...cats.values()].sort((a, b) => categoryOrder(a.category, b.category)),
      countsToCheck: products
        .filter((p) => p.on_hand < 0)
        .map((p) => ({ productId: p.id, sku: p.sku, name: p.name, onHand: p.on_hand })),
    };
  },
});

// ---- Astro ----

export interface AstroProgramReportRow {
  programId: string;
  name: string;
  earned: number;
  /** Punches taken back by refunds. */
  takenBack: number;
  rewards: number;
  rewardCents: number;
  offers: number;
  offerCents: number;
}

export interface AstroBacklog {
  pending: number;
  underDay: number;
  underWeek: number;
  overWeek: number;
  failed: number;
  oldestAt: Date | null;
}

export interface AstroCheckCandidate {
  customerId: string;
  customerName: string;
  programs: { programId: string; programName: string; localBalance: number }[];
  /** Already checked this week. */
  checkedAt: Date | null;
}

export interface AstroCheckRow {
  id: string;
  createdAt: Date;
  customerName: string;
  programName: string;
  localBalance: number;
  astroBalance: number | null;
  matches: boolean;
  staffName: string | null;
}

export interface AstroReport {
  earned: number;
  rewards: number;
  rewardCents: number;
  offers: number;
  offerCents: number;
  programs: AstroProgramReportRow[];
  backlog: AstroBacklog;
  week: string;
  toCheck: AstroCheckCandidate[];
  checks: AstroCheckRow[];
  lastCheckAt: Date | null;
  /** No check saved in the last two weeks. */
  checkDue: boolean;
}

/** How many customers the weekly Astro check picks. */
export const ASTRO_CHECK_SIZE = 5;

export const astroReport = defineHandler<ReportRange & { now?: string }, AstroReport>({
  action: "reports.view",
  async run(trx, _ctx, range) {
    const { start, end } = bounds(range);
    const now = range.now ? new Date(range.now) : new Date();
    const programs = await trx.selectFrom("astro_programs").select(["id", "name"]).orderBy("name").execute();
    const punches = await trx
      .selectFrom("astro_punches")
      .select(["program_id", "kind", sql<number>`sum(qty)::int`.as("n")])
      .where("kind", "in", ["earn", "refund_reversal"])
      .where("created_at", ">=", start)
      .where("created_at", "<", end)
      .groupBy(["program_id", "kind"])
      .execute();
    // Rewards and offers on paid register sales rung in the range, by the line's program.
    const discounts = await trx
      .selectFrom("sale_discounts as d")
      .innerJoin("sales as s", "s.id", "d.sale_id")
      .leftJoin("sale_lines as l", "l.id", "d.sale_line_id")
      .select([
        "d.source",
        "l.astro_program_id",
        sql<number>`count(*)::int`.as("n"),
        sql<number>`sum(d.amount_cents)::int`.as("cents"),
      ])
      .where("d.source", "in", ["astro_offer", "astro_reward"])
      .where("s.source", "=", "register")
      .where("s.status", "=", "paid")
      .where("s.created_at", ">=", start)
      .where("s.created_at", "<", end)
      .groupBy(["d.source", "l.astro_program_id"])
      .execute();

    const ids = new Set<string | null>([
      ...punches.map((p) => p.program_id),
      ...discounts.map((d) => d.astro_program_id),
    ]);
    const programRows: AstroProgramReportRow[] = [...ids].map((id) => {
      const pick = (kind: string) => punches.find((p) => p.program_id === id && p.kind === kind)?.n ?? 0;
      const disc = (source: string) =>
        discounts.find((d) => d.astro_program_id === id && d.source === source);
      return {
        programId: id ?? "",
        name: id ? (programs.find((p) => p.id === id)?.name ?? "") : "No program",
        earned: pick("earn"),
        takenBack: pick("refund_reversal"),
        rewards: disc("astro_reward")?.n ?? 0,
        rewardCents: disc("astro_reward")?.cents ?? 0,
        offers: disc("astro_offer")?.n ?? 0,
        offerCents: disc("astro_offer")?.cents ?? 0,
      };
    });
    programRows.sort((a, b) => a.name.localeCompare(b.name));

    const backlog = await astroBacklog(trx, now);
    const week = weekStart(localDay(now));
    const toCheck = await astroCheckCandidates(trx, now, week);
    const checks = await trx
      .selectFrom("astro_checks as k")
      .innerJoin("customers as c", "c.id", "k.customer_id")
      .innerJoin("astro_programs as p", "p.id", "k.program_id")
      .leftJoin("staff as st", "st.id", "k.staff_id")
      .select([
        "k.id",
        "k.created_at as createdAt",
        "c.name as customerName",
        "p.name as programName",
        "k.local_balance as localBalance",
        "k.astro_balance as astroBalance",
        "k.matches",
        "st.name as staffName",
      ])
      .orderBy("k.created_at", "desc")
      .limit(50)
      .execute();
    const last = await trx
      .selectFrom("astro_checks")
      .select(sql<Date | null>`max(created_at)`.as("at"))
      .executeTakeFirstOrThrow();

    const sum = (f: (r: AstroProgramReportRow) => number) => programRows.reduce((s, r) => s + f(r), 0);
    return {
      earned: sum((r) => r.earned),
      rewards: sum((r) => r.rewards),
      rewardCents: sum((r) => r.rewardCents),
      offers: sum((r) => r.offers),
      offerCents: sum((r) => r.offerCents),
      programs: programRows,
      backlog,
      week,
      toCheck,
      checks,
      lastCheckAt: last.at,
      checkDue: !last.at || now.getTime() - new Date(last.at).getTime() > 14 * 86_400_000,
    };
  },
});

async function astroBacklog(trx: Trx, now: Date): Promise<AstroBacklog> {
  const day = new Date(now.getTime() - 86_400_000);
  const week = new Date(now.getTime() - 7 * 86_400_000);
  const r = await trx
    .selectFrom("astro_queue")
    .select([
      sql<number>`count(*) FILTER (WHERE status = 'pending')::int`.as("pending"),
      sql<number>`count(*) FILTER (WHERE status = 'pending' AND created_at > ${day})::int`.as("underDay"),
      sql<number>`count(*) FILTER (WHERE status = 'pending' AND created_at <= ${day} AND created_at > ${week})::int`.as(
        "underWeek",
      ),
      sql<number>`count(*) FILTER (WHERE status = 'pending' AND created_at <= ${week})::int`.as("overWeek"),
      sql<number>`count(*) FILTER (WHERE status = 'failed')::int`.as("failed"),
      sql<Date | null>`min(created_at) FILTER (WHERE status = 'pending')`.as("oldestAt"),
    ])
    .executeTakeFirstOrThrow();
  return r;
}

/**
 * This week's customers to check against the Astro portal: five with Astro activity in
 * the last 30 days, picked the same way all week (a hash of the week and the customer).
 */
async function astroCheckCandidates(trx: Trx, now: Date, week: string): Promise<AstroCheckCandidate[]> {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const picked = await trx
    .selectFrom("astro_punches as p")
    .innerJoin("customers as c", "c.id", "p.customer_id")
    .select(["c.id", "c.name"])
    .where("p.kind", "in", ["earn", "redeem", "refund_reversal", "reward_return"])
    .where("p.created_at", ">=", since)
    .where("p.created_at", "<=", now)
    .groupBy(["c.id", "c.name"])
    .orderBy(sql`md5(${week} || c.id::text)`)
    .limit(ASTRO_CHECK_SIZE)
    .execute();
  if (!picked.length) return [];
  const ids = picked.map((p) => p.id);
  const balances = await trx
    .selectFrom("astro_balances as b")
    .innerJoin("astro_programs as a", "a.id", "b.program_id")
    .select(["b.customer_id", "b.program_id", "a.name", "b.balance"])
    .where("b.customer_id", "in", ids)
    .orderBy("a.name")
    .execute();
  const weekStartAt = atLocal(week, 0);
  const checked = await trx
    .selectFrom("astro_checks")
    .select(["customer_id", sql<Date>`max(created_at)`.as("at")])
    .where("customer_id", "in", ids)
    .where("created_at", ">=", weekStartAt)
    .groupBy("customer_id")
    .execute();
  return picked
    .map((c) => ({
      customerId: c.id,
      customerName: c.name,
      programs: balances
        .filter((b) => b.customer_id === c.id)
        .map((b) => ({ programId: b.program_id, programName: b.name, localBalance: b.balance })),
      checkedAt: checked.find((k) => k.customer_id === c.id)?.at ?? null,
    }))
    .sort((a, b) => a.customerName.localeCompare(b.customerName));
}

export interface SaveAstroCheckInput {
  customerId: string;
  /** Per program: what the Astro portal shows, or null for "Matches". */
  rows: { programId: string; astroBalance: number | null }[];
}

/** Saves one customer's Astro check. Balances aren't changed: fixing a mismatch is a manual step. */
export const saveAstroCheck = defineHandler<SaveAstroCheckInput, AstroCheckRow[]>({
  action: "astro.edit",
  async run(trx, ctx, input) {
    if (!input.rows.length) throw new AppError("invalid", "Nothing to save.");
    const customer = await trx
      .selectFrom("customers")
      .select(["id", "name"])
      .where("id", "=", input.customerId)
      .executeTakeFirst();
    if (!customer) throw new AppError("not_found", "That customer doesn't exist anymore.");
    const out: AstroCheckRow[] = [];
    for (const r of input.rows) {
      if (
        r.astroBalance !== null &&
        (!Number.isSafeInteger(r.astroBalance) || r.astroBalance < 0 || r.astroBalance > 9999)
      )
        throw new AppError("invalid", "Type the punches Astro shows, as a whole number.");
      const program = await trx
        .selectFrom("astro_programs")
        .select(["id", "name"])
        .where("id", "=", r.programId)
        .executeTakeFirst();
      if (!program) throw new AppError("not_found", "That Astro program doesn't exist anymore.");
      const bal = await trx
        .selectFrom("astro_balances")
        .select("balance")
        .where("customer_id", "=", customer.id)
        .where("program_id", "=", program.id)
        .executeTakeFirst();
      const local = bal?.balance ?? 0;
      const matches = r.astroBalance === null || r.astroBalance === local;
      const saved = await trx
        .insertInto("astro_checks")
        .values({
          business_id: ctx.businessId,
          customer_id: customer.id,
          program_id: program.id,
          local_balance: local,
          astro_balance: r.astroBalance,
          matches,
          staff_id: ctx.staffId,
        })
        .returning(["id", "created_at"])
        .executeTakeFirstOrThrow();
      out.push({
        id: saved.id,
        createdAt: saved.created_at,
        customerName: customer.name,
        programName: program.name,
        localBalance: local,
        astroBalance: r.astroBalance,
        matches,
        staffName: null,
      });
    }
    return out;
  },
});
