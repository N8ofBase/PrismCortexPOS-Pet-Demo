// Six weeks of sample sales and grooms, so the demo's reports have something to show.
// Everything is is_demo; "Remove demo data" deletes it with remove_demo_sales() and
// remove_demo_grooming(). Runs as the database owner, like the rest of the seed.
//
// Prices, tax and discounts come from priceSale() and refunds from refundLine(), the
// same code the register uses, so the numbers are what a real day would give.
// Stock and Astro balances come out where they were: stock sold in the history was
// "received" just before it, and the Astro punches earned are redeemed by the end.
import { sql, type Insertable, type Transaction } from "kysely";
import {
  addDays,
  allocate,
  atLocal,
  changeDue,
  FEES_CATEGORY,
  GROOMING_CATEGORY,
  priceSale,
  refundLine,
  shortDay,
  todayIso,
  type AstroSalePayload,
  type TicketLine,
} from "@pet-pos/core";
import type { DB } from "../src/schema.ts";

type Trx = Transaction<DB>;

/** Days of history before today. */
export const HISTORY_DAYS = 42;

/** Row ids made here, so a sale and its lines go in with one insert each. */
const uuid = (): string =>
  (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();

/** A small fixed random sequence, so every demo gets the same six weeks. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Product {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  category: string;
  price_cents: number;
  tax_class: "standard" | "exempt";
  astro_program_id: string | null;
  astro_offer_label: string | null;
  astro_offer_cents: number | null;
}

interface PlannedLine {
  product?: Product;
  groom?: { appointmentId: string; name: string; priceCents: number };
  fee?: { name: string; cents: number };
  qty: number;
  applyOffer: boolean;
}

interface PlannedSale {
  at: Date;
  customerId: string | null;
  lines: PlannedLine[];
  reward: string | null;
  pay: "card" | "cash" | "split" | "deposit";
  depositId?: string;
  void?: boolean;
  refund?: { lineIndex: number; method: "card" | "cash"; at: Date; reason: "damaged" | "changed_mind" };
}

export async function seedSalesHistory(trx: Trx, businessId: string): Promise<void> {
  const today = todayIso();
  const rand = rng(20261103);

  const biz = await trx
    .selectFrom("businesses")
    .select(["astro_discounts_before_tax", "grooming_taxable"])
    .where("id", "=", businessId)
    .executeTakeFirstOrThrow();
  const loc = await trx
    .selectFrom("locations")
    .select(["id", "tax_rate_mpct"])
    .where("business_id", "=", businessId)
    .orderBy("created_at")
    .executeTakeFirstOrThrow();
  const products: Product[] = await trx
    .selectFrom("products")
    .select([
      "id",
      "sku",
      "barcode",
      "name",
      "category",
      "price_cents",
      "tax_class",
      "astro_program_id",
      "astro_offer_label",
      "astro_offer_cents",
    ])
    .where("business_id", "=", businessId)
    .where("is_demo", "=", true)
    .where("back_bar", "=", false)
    .where("active", "=", true)
    .orderBy("sku")
    .execute();
  const staff = await trx
    .selectFrom("staff")
    .select(["id", "role", "name", "grooms"])
    .where("business_id", "=", businessId)
    .where("is_demo", "=", true)
    .orderBy("name")
    .execute();
  const pets = await trx
    .selectFrom("pets")
    .select(["id", "name", "size", "customer_id"])
    .where("business_id", "=", businessId)
    .where("is_demo", "=", true)
    .execute();
  const services = await trx
    .selectFrom("services")
    .select([
      "id",
      "name",
      "price_s_cents",
      "price_m_cents",
      "price_l_cents",
      "price_xl_cents",
      "deposit_cents",
    ])
    .where("business_id", "=", businessId)
    .where("is_demo", "=", true)
    .where("kind", "=", "main")
    .execute();
  const program = await trx
    .selectFrom("astro_programs")
    .select(["id", "name", "buy_count"])
    .where("business_id", "=", businessId)
    .where("is_demo", "=", true)
    .executeTakeFirst();
  const family = await trx
    .selectFrom("customers")
    .select(["id", "name", "phone", "email", "astro_customer_id"])
    .where("business_id", "=", businessId)
    .where("is_demo", "=", true)
    .where("phone", "=", "2125550102")
    .executeTakeFirst();

  const cashier = staff.find((s) => s.role === "cashier");
  const manager = staff.find((s) => s.role === "manager");
  const groomers = staff.filter((s) => s.grooms);
  const bySku = (sku: string) => products.find((p) => p.sku === sku);
  const dogFood = bySku("0001");
  const catFood = bySku("0002");
  const treats = bySku("0003");
  const toy = bySku("0004");
  const full = services.find((s) => s.name.startsWith("Sample Full groom"));
  const bath = services.find((s) => s.name.startsWith("Sample Bath"));
  if (!cashier || !manager || !groomers.length || !dogFood || !catFood || !treats || !toy || !full || !bath)
    return;

  // ---- Grooms on the calendar ----
  // Biscuit, Rex, Mo and Clover have later grooms already (today, tomorrow, or Clover's
  // bath 5 weeks ago), so these show up as rebooked or not without new rebook nudges.
  const priceFor = (svc: (typeof services)[number], size: string) =>
    size === "S"
      ? svc.price_s_cents
      : size === "L"
        ? svc.price_l_cents
        : size === "XL"
          ? svc.price_xl_cents
          : svc.price_m_cents;
  const minutesFor = (svc: (typeof services)[number]) => (svc === full ? 120 : 75);
  const sales: PlannedSale[] = [];
  const groom = async (
    petName: string,
    daysAgo: number,
    startMinute: number,
    svc: (typeof services)[number],
    status: "done" | "no_show",
    bookedDaysAgo: number,
  ) => {
    const pet = pets.find((p) => p.name === petName);
    if (!pet) return null;
    const day = addDays(today, -daysAgo);
    const size = pet.size ?? "M";
    const price = priceFor(svc, size);
    const minutes = minutesFor(svc);
    // The second groomer works Sundays; the first doesn't.
    const sunday = new Date(`${day}T12:00:00`).getDay() === 0;
    const groomer = groomers[sunday ? groomers.length - 1 : daysAgo % groomers.length]!;
    const appt = await trx
      .insertInto("appointments")
      .values({
        business_id: businessId,
        location_id: loc.id,
        customer_id: pet.customer_id,
        pet_id: pet.id,
        staff_id: groomer.id,
        service_id: svc.id,
        service_name: svc.name,
        pet_name: pet.name,
        size,
        starts_at: atLocal(day, startMinute),
        ends_at: atLocal(day, startMinute + minutes),
        block_ends_at: atLocal(day, startMinute + minutes + 15),
        status,
        price_cents: price,
        checked_in_at: status === "done" ? atLocal(day, startMinute) : null,
        done_at: status === "done" ? atLocal(day, startMinute + minutes) : null,
        supplies_used_at: status === "done" ? atLocal(day, startMinute + minutes) : null,
        created_at: atLocal(addDays(today, -bookedDaysAgo), 11 * 60),
        is_demo: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    if (status === "done")
      sales.push({
        at: atLocal(day, startMinute + minutes + 10),
        customerId: pet.customer_id,
        lines: [
          {
            groom: { appointmentId: appt.id, name: `${svc.name} · ${pet.name}`, priceCents: price },
            qty: 1,
            applyOffer: false,
          },
        ],
        reward: null,
        pay: rand() < 0.7 ? "card" : "cash",
      });
    return {
      id: appt.id,
      day,
      customerId: pet.customer_id,
      petName: pet.name,
      startsAt: atLocal(day, startMinute),
    };
  };
  await groom("Clover", 77, 11 * 60, bath, "done", 80);
  await groom("Biscuit", 63, 9 * 60, full, "done", 70);
  await groom("Rex", 56, 10 * 60, bath, "done", 60);
  await groom("Mo", 45, 13 * 60, bath, "done", 50);
  await groom("Rex", 28, 10 * 60, bath, "done", 56);
  await groom("Mo", 33, 14 * 60, bath, "no_show", 40);
  // Juno's full groom was booked online with a deposit, and Juno didn't come: the
  // deposit was kept as a no-show fee.
  const juno = await groom("Juno", 12, 10 * 60, full, "no_show", 20);
  if (juno && full.deposit_cents > 0) {
    const dep = await trx
      .insertInto("deposits")
      .values({
        business_id: businessId,
        appointment_id: juno.id,
        customer_id: juno.customerId,
        amount_cents: full.deposit_cents,
        status: "kept",
        link_id: "demo-link-juno",
        provider_ref: "demo-payment-juno",
        paid_at: atLocal(addDays(today, -20), 11 * 60 + 5),
        created_at: atLocal(addDays(today, -20), 11 * 60),
        is_demo: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await trx
      .updateTable("appointments")
      .set({ deposit_id: dep.id, source: "online" })
      .where("id", "=", juno.id)
      .execute();
    sales.push({
      at: atLocal(juno.day, 17 * 60),
      customerId: juno.customerId,
      lines: [
        {
          fee: { name: `No-show fee: ${juno.petName}, ${shortDay(juno.day)}`, cents: full.deposit_cents },
          qty: 1,
          applyOffer: false,
        },
      ],
      reward: null,
      pay: "deposit",
      depositId: dep.id,
    });
  }

  // ---- Counter sales ----
  const weighted: [Product, number][] = [
    [treats, 40],
    [dogFood, 25],
    [catFood, 20],
    [toy, 15],
  ];
  const sum = weighted.reduce((s, [, w]) => s + w, 0);
  const pickProduct = () => {
    let r = rand() * sum;
    for (const [p, w] of weighted) if ((r -= w) < 0) return p;
    return treats;
  };
  for (let ago = HISTORY_DAYS; ago >= 1; ago--) {
    const day = addDays(today, -ago);
    const weekday = new Date(`${day}T12:00:00`).getDay();
    const n = 10 + Math.floor(rand() * 11) + (weekday === 6 ? 5 : 0);
    const minutes = Array.from({ length: n }, () => 9 * 60 + Math.floor(rand() * 600)).sort((a, b) => a - b);
    for (const m of minutes) {
      const lines: PlannedLine[] = [];
      const count = rand() < 0.6 ? 1 : rand() < 0.8 ? 2 : 3;
      for (let i = 0; i < count; i++) {
        const p = pickProduct();
        const existing = lines.find((l) => l.product === p);
        if (existing) existing.qty++;
        else
          lines.push({
            product: p,
            qty: p === treats && rand() < 0.3 ? 2 : 1,
            applyOffer: p === dogFood && rand() < 0.3,
          });
      }
      const r = rand();
      sales.push({
        at: atLocal(day, m),
        customerId: null,
        lines,
        reward: null,
        pay: r < 0.55 ? "card" : r < 0.9 ? "cash" : "split",
      });
    }
  }

  // The Sample Family fills a dry food card over the six weeks and redeems it three
  // days ago, so their balance ends where it started.
  if (family && program && dogFood.astro_program_id === program.id) {
    const visits = [40, 34, 27, 20, 13, 6];
    const per = Math.ceil(program.buy_count / visits.length);
    let left = program.buy_count;
    for (const ago of visits) {
      const qty = Math.min(per, left);
      left -= qty;
      if (qty <= 0) break;
      sales.push({
        at: atLocal(addDays(today, -ago), 16 * 60 + 30),
        customerId: family.id,
        lines: [
          { product: dogFood, qty, applyOffer: false },
          { product: treats, qty: 1, applyOffer: false },
        ],
        reward: null,
        pay: "card",
      });
    }
    sales.push({
      at: atLocal(addDays(today, -3), 16 * 60 + 30),
      customerId: family.id,
      lines: [{ product: dogFood, qty: 1, applyOffer: false }],
      reward: program.id,
      pay: "card",
    });
  }

  sales.sort((a, b) => a.at.getTime() - b.at.getTime());

  // Two refunds and one void, on plain counter sales.
  const counter = sales.filter(
    (s) => !s.customerId && s.pay !== "deposit" && s.lines.every((l) => l.product),
  );
  const withTreats = counter.filter((s) => s.lines.some((l) => l.product === treats));
  const refundA = withTreats.find((s) => s.at < atLocal(addDays(today, -16), 0) && s.pay === "card");
  if (refundA)
    refundA.refund = {
      lineIndex: refundA.lines.findIndex((l) => l.product === treats),
      method: "card",
      at: new Date(refundA.at.getTime() + 86_400_000),
      reason: "damaged",
    };
  const refundB = withTreats.find((s) => s.at > atLocal(addDays(today, -6), 0) && s.pay === "cash");
  if (refundB)
    refundB.refund = {
      lineIndex: refundB.lines.findIndex((l) => l.product === treats),
      method: "cash",
      at: new Date(refundB.at.getTime() + 2 * 3_600_000),
      reason: "changed_mind",
    };
  const voided = counter.find((s) => s.at > atLocal(addDays(today, -9), 0) && !s.refund);
  if (voided) voided.void = true;

  // ---- Write it ----
  // Rows are built in memory with their ids and written in a few large inserts: in the
  // browser every query is a round trip to the database worker.
  const counterRow = await trx
    .insertInto("business_counters")
    .values({ business_id: businessId, name: "receipt", value: 1000 + sales.length })
    .onConflict((oc) =>
      oc
        .columns(["business_id", "name"])
        .doUpdateSet({ value: sql`business_counters.value + ${sales.length}` }),
    )
    .returning("value")
    .executeTakeFirstOrThrow();
  let receipt = counterRow.value - sales.length;

  const rows = {
    sales: [] as Insertable<DB["sales"]>[],
    lines: [] as Insertable<DB["sale_lines"]>[],
    discounts: [] as Insertable<DB["sale_discounts"]>[],
    payments: [] as Insertable<DB["payments"]>[],
    moves: [] as Insertable<DB["inventory_moves"]>[],
    punches: [] as Insertable<DB["astro_punches"]>[],
    queue: [] as Insertable<DB["astro_queue"]>[],
    refunds: [] as Insertable<DB["refunds"]>[],
    refundLines: [] as Insertable<DB["refund_lines"]>[],
    refundPayments: [] as Insertable<DB["refund_payments"]>[],
  };
  const groomSales: { appointmentId: string; saleId: string }[] = [];
  let keptSale: { depositId: string; saleId: string } | null = null;

  // Stock sold in the history (less what came back) arrives the day before it starts,
  // so on-hand ends up where it was.
  const stockIn = new Map<string, number>();
  for (const s of sales) {
    if (s.void) continue;
    for (const [i, l] of s.lines.entries()) {
      if (!l.product) continue;
      const back = s.refund?.lineIndex === i && s.refund.reason !== "damaged" ? l.qty : 0;
      stockIn.set(l.product.id, (stockIn.get(l.product.id) ?? 0) + l.qty - back);
    }
  }
  const received = atLocal(addDays(today, -HISTORY_DAYS - 1), 8 * 60);
  for (const [productId, qty] of stockIn)
    if (qty > 0)
      rows.moves.push({
        business_id: businessId,
        product_id: productId,
        location_id: loc.id,
        qty_change: qty,
        reason: "receive",
        note: "Sample delivery",
        staff_id: manager.id,
        created_at: received,
        is_demo: true,
      });

  let pendingOld = false;
  for (const s of sales) {
    receipt++;
    const saleId = uuid();
    const ticket: TicketLine[] = s.lines.map((l, i) => {
      if (l.product)
        return {
          key: String(i),
          productId: l.product.id,
          name: l.product.name,
          unitPriceCents: l.product.price_cents,
          qty: l.qty,
          taxClass: l.product.tax_class,
          astroProgramId: l.product.astro_program_id,
          offer:
            l.product.astro_offer_label && l.product.astro_offer_cents
              ? { label: l.product.astro_offer_label, cents: l.product.astro_offer_cents }
              : null,
          applyOffer: l.applyOffer && !!l.product.astro_offer_cents,
        };
      const g = l.groom;
      return {
        key: String(i),
        productId: null,
        name: g ? g.name : l.fee!.name,
        unitPriceCents: g ? g.priceCents : l.fee!.cents,
        qty: 1,
        taxClass: g && biz.grooming_taxable ? "standard" : "exempt",
        astroProgramId: null,
        offer: null,
        applyOffer: false,
      };
    });
    const isFee = s.pay === "deposit";
    const priced = priceSale({
      lines: ticket,
      storeDiscounts: [],
      rewards: s.reward && program ? [{ programId: s.reward, label: `Reward: ${program.name}` }] : [],
      taxRateMpct: isFee ? 0 : loc.tax_rate_mpct,
      astroBeforeTax: biz.astro_discounts_before_tax,
    });
    const taxShares = allocate(
      priced.taxCents,
      priced.lines.map((l) => l.taxBaseCents),
    );
    const lineIds = s.lines.map(() => uuid());

    // A refund on this sale, through refundLine() like the Refund panel.
    let refund: { id: string; amountCents: number; taxCents: number; qty: number } | null = null;
    if (s.refund) {
      const i = s.refund.lineIndex;
      const back = refundLine(
        {
          id: lineIds[i]!,
          name: ticket[i]!.name,
          qty: s.lines[i]!.qty,
          lineTotalCents: priced.lines[i]!.netCents,
          taxCents: taxShares[i]!,
          rewardUnits: 0,
          refundedQty: 0,
          refundedCents: 0,
          refundedTaxCents: 0,
        },
        s.lines[i]!.qty,
      );
      refund = {
        id: uuid(),
        amountCents: back.amountCents,
        taxCents: back.taxCents,
        qty: back.qty,
      };
    }
    const refundTotal = refund ? refund.amountCents + refund.taxCents : 0;

    rows.sales.push({
      id: saleId,
      business_id: businessId,
      location_id: loc.id,
      customer_id: s.customerId,
      staff_id: cashier.id,
      receipt_number: receipt,
      status: s.void ? "canceled" : "paid",
      subtotal_cents: priced.subtotalCents,
      discount_cents: priced.discountCents,
      tax_cents: priced.taxCents,
      total_cents: priced.totalCents,
      tax_rate_mpct: loc.tax_rate_mpct,
      discounts_before_tax: isFee ? false : biz.astro_discounts_before_tax,
      paid_at: s.void ? null : s.at,
      canceled_at: s.void ? new Date(s.at.getTime() + 60_000) : null,
      refunded_cents: refundTotal,
      created_at: s.at,
      is_demo: true,
    });
    for (const [i, l] of s.lines.entries()) {
      const pl = priced.lines[i]!;
      rows.lines.push({
        id: lineIds[i]!,
        business_id: businessId,
        sale_id: saleId,
        position: i + 1,
        product_id: l.product?.id ?? null,
        appointment_id: l.groom?.appointmentId ?? null,
        name: ticket[i]!.name,
        sku: l.product?.sku ?? null,
        barcode: l.product?.barcode ?? null,
        tax_class: ticket[i]!.taxClass,
        qty: l.qty,
        unit_price_cents: ticket[i]!.unitPriceCents,
        discount_cents: pl.discountCents,
        line_total_cents: pl.netCents,
        astro_program_id: l.product?.astro_program_id ?? null,
        earns_punches: s.customerId ? pl.earnsPunches : 0,
        tax_cents: isFee ? null : taxShares[i]!,
        category: l.product ? l.product.category : l.groom ? GROOMING_CATEGORY : FEES_CATEGORY,
        created_at: s.at,
      });
      if (l.groom && !s.void) groomSales.push({ appointmentId: l.groom.appointmentId, saleId });
    }
    for (const d of priced.discounts)
      rows.discounts.push({
        business_id: businessId,
        sale_id: saleId,
        sale_line_id: d.lineKey ? (lineIds[Number(d.lineKey)] ?? null) : null,
        source: d.source,
        discount_id: d.discountId,
        name: d.name,
        amount_cents: d.amountCents,
        applied_by: cashier.id,
        created_at: s.at,
      });

    // Payments. The refund goes back to the payment of its kind.
    const pays: { method: "card" | "cash" | "deposit"; cents: number }[] =
      s.pay === "split" && priced.totalCents > 2000
        ? [
            { method: "cash", cents: 2000 },
            { method: "card", cents: priced.totalCents - 2000 },
          ]
        : [{ method: s.pay === "split" ? "card" : s.pay, cents: priced.totalCents }];
    const refundedPay = refund ? (pays.find((p) => p.method === s.refund!.method) ?? pays[0]!) : null;
    for (const p of pays) {
      if (p.cents <= 0) continue;
      const id = uuid();
      const tendered =
        p.method === "cash" ? Math.ceil(p.cents / 500) * 500 + (rand() < 0.3 ? 1000 : 0) : null;
      rows.payments.push({
        id,
        business_id: businessId,
        sale_id: saleId,
        method: p.method,
        provider: p.method === "cash" ? "cash" : "square",
        provider_ref:
          p.method === "card"
            ? `demo-terminal-${receipt}`
            : p.method === "deposit"
              ? "demo-payment-juno"
              : null,
        status: s.void ? "refunded" : "completed",
        amount_cents: p.cents,
        tendered_cents: tendered,
        change_cents: tendered ? (changeDue(p.cents, tendered) ?? 0) : 0,
        refunded_cents: s.void ? p.cents : p === refundedPay ? refundTotal : 0,
        staff_id: cashier.id,
        completed_at: s.at,
        deposit_id: p.method === "deposit" ? (s.depositId ?? null) : null,
        created_at: s.at,
      });
      if (refund && p === refundedPay)
        rows.refundPayments.push({
          business_id: businessId,
          refund_id: refund.id,
          payment_id: id,
          method: p.method,
          amount_cents: refundTotal,
          provider_ref: p.method === "card" ? `demo-refund-${receipt}` : null,
        });
    }
    if (isFee && s.depositId) keptSale = { depositId: s.depositId, saleId };
    if (s.void) continue;

    // Stock out.
    for (const l of s.lines)
      if (l.product)
        rows.moves.push({
          business_id: businessId,
          product_id: l.product.id,
          location_id: loc.id,
          qty_change: -l.qty,
          reason: "sale",
          ref_id: saleId,
          staff_id: cashier.id,
          created_at: s.at,
          is_demo: true,
        });

    // Astro: punches for the customer, and the queue row to enter in the portal.
    const earned = Object.entries(priced.earned).filter(([, n]) => n > 0);
    if (s.customerId && program)
      for (const [programId, qty] of earned)
        rows.punches.push({
          business_id: businessId,
          customer_id: s.customerId,
          program_id: programId,
          sale_id: saleId,
          qty,
          kind: "earn",
          created_at: s.at,
          is_demo: true,
        });
    if (s.customerId && s.reward && program)
      rows.punches.push({
        business_id: businessId,
        customer_id: s.customerId,
        program_id: s.reward,
        sale_id: saleId,
        qty: program.buy_count,
        kind: "redeem",
        created_at: s.at,
        is_demo: true,
      });
    const offers = priced.discounts.filter((d) => d.source === "astro_offer");
    const rewards = priced.discounts.filter((d) => d.source === "astro_reward");
    if ((s.customerId && earned.length) || offers.length || rewards.length) {
      const ageDays = (Date.now() - s.at.getTime()) / 86_400_000;
      // Entered within a day, except the last few days and one from over a week ago.
      const old = !pendingOld && ageDays > 8 && ageDays < 11;
      if (old) pendingOld = true;
      const pending = ageDays < 3 || old;
      const cust = s.customerId && s.customerId === family?.id ? family : null;
      const payload: AstroSalePayload = {
        saleId,
        receiptNumber: receipt,
        soldAt: s.at.toISOString(),
        customer: cust
          ? { name: cust.name, phone: cust.phone, email: cust.email, astroCustomerId: cust.astro_customer_id }
          : null,
        items: s.lines
          .filter((l) => l.product)
          .map((l) => ({
            sku: l.product!.sku,
            upc: l.product!.barcode,
            name: l.product!.name,
            qty: l.qty,
            unitPriceCents: l.product!.price_cents,
          })),
        earned:
          cust && program
            ? earned.map(([programId, punches]) => ({ programId, programName: program.name, punches }))
            : [],
        rewards: rewards.map((r) => ({
          programId: s.reward!,
          programName: program?.name ?? "",
          label: r.name,
          amountCents: r.amountCents,
        })),
        offers: offers.map((o) => ({
          label: o.name,
          amountCents: o.amountCents,
          sku: s.lines[Number(o.lineKey)]?.product?.sku ?? null,
        })),
      };
      rows.queue.push({
        business_id: businessId,
        sale_id: saleId,
        payload: JSON.stringify(payload),
        status: pending ? "pending" : "entered",
        entered_by: pending ? null : manager.id,
        entered_at: pending ? null : new Date(s.at.getTime() + 20 * 3_600_000),
        created_at: s.at,
      });
    }

    if (refund && s.refund) {
      const i = s.refund.lineIndex;
      rows.refunds.push({
        id: refund.id,
        business_id: businessId,
        sale_id: saleId,
        staff_id: manager.id,
        reason: s.refund.reason,
        restock: s.refund.reason !== "damaged",
        amount_cents: refund.amountCents,
        tax_cents: refund.taxCents,
        created_at: s.refund.at,
        is_demo: true,
      });
      rows.refundLines.push({
        business_id: businessId,
        refund_id: refund.id,
        sale_line_id: lineIds[i]!,
        qty: refund.qty,
        amount_cents: refund.amountCents,
        tax_cents: refund.taxCents,
      });
      if (s.refund.reason !== "damaged")
        rows.moves.push({
          business_id: businessId,
          product_id: s.lines[i]!.product!.id,
          location_id: loc.id,
          qty_change: refund.qty,
          reason: "return",
          ref_id: refund.id,
          staff_id: manager.id,
          created_at: s.refund.at,
          is_demo: true,
        });
    }
  }

  const insert = async <T extends keyof DB & string>(table: T, values: Insertable<DB[T]>[]) => {
    for (let i = 0; i < values.length; i += 400)
      await trx
        .insertInto(table)
        .values(values.slice(i, i + 400) as never)
        .execute();
  };
  await insert("sales", rows.sales);
  await insert("sale_lines", rows.lines);
  await insert("sale_discounts", rows.discounts);
  await insert("payments", rows.payments);
  await insert("inventory_moves", rows.moves);
  await insert("astro_punches", rows.punches);
  await insert("astro_queue", rows.queue);
  await insert("refunds", rows.refunds);
  await insert("refund_lines", rows.refundLines);
  await insert("refund_payments", rows.refundPayments);
  for (const g of groomSales)
    await trx
      .updateTable("appointments")
      .set({ sale_id: g.saleId })
      .where("id", "=", g.appointmentId)
      .execute();
  if (keptSale)
    await trx
      .updateTable("deposits")
      .set({ kept_sale_id: keptSale.saleId })
      .where("id", "=", keptSale.depositId)
      .execute();

  // Last week's Astro check: one customer, and Astro was one punch behind.
  if (family && program) {
    const local = await trx
      .selectFrom("astro_balances")
      .select("balance")
      .where("customer_id", "=", family.id)
      .where("program_id", "=", program.id)
      .executeTakeFirst();
    const bal = local?.balance ?? 0;
    await trx
      .insertInto("astro_checks")
      .values({
        business_id: businessId,
        customer_id: family.id,
        program_id: program.id,
        local_balance: bal,
        astro_balance: Math.max(0, bal - 1),
        matches: bal === 0,
        staff_id: manager.id,
        created_at: atLocal(addDays(today, -8), 10 * 60),
        is_demo: true,
      })
      .execute();
  }
}
