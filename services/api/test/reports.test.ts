import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { addDays, todayIso, type Ctx } from "@pet-pos/core";
import { ensureDemo, listDemoStaff, withBusiness, type DB } from "@pet-pos/db";
import { createTestDb, insertBusiness } from "@pet-pos/db/test-db";
import type { TicketInput } from "../src/handlers/register.ts";
import { invoke } from "../src/registry.ts";

let db: Kysely<DB>;
let businessId: string;
let owner: Ctx;
let manager: Ctx;
let cashier: Ctx;
let groomer: Ctx;
let sku: Record<string, { id: string; onHand: number; priceCents: number; costCents: number }>;
let sampleCustomer: string;
let family: string;
let club: string;
const today = todayIso();
const range = { from: today, to: today };

async function setup(salesHistory = false) {
  ({ db } = await createTestDb());
  businessId = await ensureDemo(db, { salesHistory });
  const staff = await listDemoStaff(db);
  const ctx = (role: Ctx["role"]): Ctx => ({
    businessId,
    role,
    staffId: staff.find((s) => s.role === role)!.id,
  });
  owner = ctx("owner");
  manager = ctx("manager");
  cashier = ctx("cashier");
  groomer = ctx("groomer");
  sku = Object.fromEntries(
    (await invoke(db, owner, "listProducts", { includeArchived: true })).map((p) => [p.sku, p]),
  );
  sampleCustomer = (await invoke(db, owner, "lookupByPhone", { phone: "2125550100" }))!.id;
  family = (await invoke(db, owner, "lookupByPhone", { phone: "2125550102" }))!.id;
  club = (await invoke(db, owner, "listPrograms", undefined))[0]!.id;
}

const ticket = (lines: [string, number, boolean?][], over: Partial<TicketInput> = {}): TicketInput => ({
  customerId: null,
  lines: lines.map(([code, qty, offer], i) => ({
    key: String(i),
    productId: sku[code]!.id,
    qty,
    applyOffer: !!offer,
  })),
  rewards: [],
  discounts: [],
  ...over,
});
async function ring(t: TicketInput, method: "cash" | "card" = "cash") {
  const s = await invoke(db, cashier, "startCheckout", t);
  const due = s.totalCents - s.depositCents;
  if (due > 0) {
    if (method === "cash")
      await invoke(db, cashier, "payCash", { saleId: s.saleId, amountCents: due, tenderedCents: due });
    else {
      const p = await invoke(db, cashier, "startCardPayment", { saleId: s.saleId, amountCents: due });
      await invoke(db, cashier, "simulateTerminalResult", { paymentId: p.paymentId, outcome: "approved" });
    }
  }
  return s;
}
/** Moves a sale (and its payments, punches and queue row) back n days. */
async function backdate(saleId: string, days: number) {
  const at = new Date(Date.now() - days * 86_400_000);
  await db.updateTable("sales").set({ created_at: at, paid_at: at }).where("id", "=", saleId).execute();
  await db.updateTable("payments").set({ completed_at: at }).where("sale_id", "=", saleId).execute();
  await db.updateTable("astro_punches").set({ created_at: at }).where("sale_id", "=", saleId).execute();
  await db.updateTable("astro_queue").set({ created_at: at }).where("sale_id", "=", saleId).execute();
}
async function refundFirstLine(saleId: string) {
  const line = (await invoke(db, owner, "getSale", { id: saleId })).lines[0]!.id;
  return invoke(db, owner, "refundSale", {
    saleId,
    lines: [{ saleLineId: line, qty: 1 }],
    restock: true,
    reason: "changed_mind",
  });
}

describe("sales report", () => {
  beforeEach(() => setup());

  it("matches the Sales page and end of day, and the rows add up", async () => {
    // Treats $12.99 ×2 cash, dog food with the $5 Astro offer by card, a split sale,
    // and Biscuit's $80 groom with its $20 deposit already paid online.
    await ring(ticket([["0003", 2]]));
    await ring(ticket([["0001", 1, true]], { customerId: sampleCustomer }), "card");
    const split = await invoke(
      db,
      cashier,
      "startCheckout",
      ticket([
        ["0002", 1],
        ["0004", 1],
      ]),
    );
    await invoke(db, cashier, "payCash", { saleId: split.saleId, amountCents: 1000, tenderedCents: 1000 });
    const p = await invoke(db, cashier, "startCardPayment", {
      saleId: split.saleId,
      amountCents: split.totalCents - 1000,
    });
    await invoke(db, cashier, "simulateTerminalResult", { paymentId: p.paymentId, outcome: "approved" });
    const day = await invoke(db, owner, "groomingDay", { day: today });
    const biscuit = day.appointments.find((a) => a.petName === "Biscuit")!.id;
    await ring({
      customerId: sampleCustomer,
      lines: [{ key: "g", appointmentId: biscuit, qty: 1, applyOffer: false }],
      rewards: [],
      discounts: [],
    });

    const r = await invoke(db, manager, "salesReport", range);
    const kpi = await invoke(db, manager, "drawerSummary", { day: today });
    expect(r.totals).toEqual(kpi.totals);
    expect(r.totals.count).toBe(4);

    // Payment types: card, cash, and the deposit paid online (not counter card).
    const byKey = Object.fromEntries(r.paymentTypes.map((x) => [x.key, x]));
    expect(byKey.cash!.inCents).toBe(r.totals.cashInCents);
    expect(byKey.card!.inCents).toBe(r.totals.cardInCents);
    expect(byKey.card!.inCents + byKey.cash!.inCents + r.totals.depositsUsedCents).toBe(r.totals.grossCents);

    // Categories add up to net sales before tax.
    const net = r.categories.reduce((s, c) => s + c.netCents, 0);
    expect(net).toBe(r.totals.grossCents - r.totals.taxCents - (r.totals.refundCents - r.refundTaxCents));
    expect(r.categories.map((c) => c.category)).toEqual([
      "Dog food",
      "Cat food",
      "Treats",
      "Supplies",
      "Grooming",
    ]);
    expect(r.categories.find((c) => c.category === "Grooming")!.netCents).toBe(8000);
    expect(r.categories.find((c) => c.category === "Treats")).toMatchObject({ qty: 2, salesCents: 2598 });

    // Day rows add up to the range.
    expect(r.days).toHaveLength(1);
    expect(r.days[0]).toMatchObject({
      day: today,
      count: 4,
      netCents: r.totals.netCents,
      taxCents: r.totals.taxCents,
    });

    expect(r.topProducts[0]).toMatchObject({
      name: "Sample Adult Dog Food 24 lb (DEMO)",
      qty: 1,
      netCents: 5999,
    });

    // The grooming tab's groomers add up to the Grooming category.
    const g = await invoke(db, manager, "groomingReport", range);
    expect(g.revenueCents).toBe(8000);
    expect(g.groomers.reduce((s, x) => s + x.salesCents, 0)).toBe(8000);
  });

  it("keeps a sale under the category it sold in", async () => {
    const s = await ring(ticket([["0003", 1]]));
    await db
      .updateTable("products")
      .set({ category: "Supplies" })
      .where("id", "=", sku["0003"]!.id)
      .execute();
    const r = await invoke(db, owner, "salesReport", range);
    expect(r.categories).toEqual([
      { category: "Treats", qty: 1, salesCents: 1299, refundCents: 0, netCents: 1299 },
    ]);
    // A refund counts under the refunded line's category too.
    await refundFirstLine(s.saleId);
    const after = await invoke(db, owner, "salesReport", range);
    expect(after.categories).toEqual([
      { category: "Treats", qty: 1, salesCents: 1299, refundCents: 1299, netCents: 0 },
    ]);
  });

  it("counts a refund on the day it was made, and never counts voids or imported orders", async () => {
    const old = await ring(ticket([["0003", 1]]));
    await backdate(old.saleId, 10);
    await refundFirstLine(old.saleId);
    const v = await invoke(db, cashier, "startCheckout", ticket([["0004", 1]]));
    await invoke(db, cashier, "payCash", { saleId: v.saleId, amountCents: 500, tenderedCents: 500 });
    await invoke(db, cashier, "cancelSale", { saleId: v.saleId });
    // An imported order today, from the old system.
    const loc = await db
      .selectFrom("locations")
      .select("id")
      .where("business_id", "=", businessId)
      .executeTakeFirstOrThrow();
    await db
      .insertInto("sales")
      .values({
        business_id: businessId,
        location_id: loc.id,
        customer_id: sampleCustomer,
        receipt_number: null as unknown as number,
        status: "paid",
        source: "import",
        subtotal_cents: 5000,
        total_cents: 5000,
        tax_rate_mpct: 0,
        discounts_before_tax: true,
        paid_at: new Date(),
        import_key: "date:test",
      })
      .execute();

    const r = await invoke(db, owner, "salesReport", range);
    expect(r.totals).toMatchObject({
      count: 0,
      grossCents: 0,
      refundCount: 1,
      refundCents: 1390,
      netCents: -1390,
    });
    expect(r.categories).toEqual([
      { category: "Treats", qty: 0, salesCents: 0, refundCents: 1299, netCents: -1299 },
    ]);
    expect(r.topProducts).toEqual([]);

    const then = addDays(today, -10);
    const back = await invoke(db, owner, "salesReport", { from: then, to: then });
    expect(back.totals).toMatchObject({ count: 1, grossCents: 1390, refundCents: 0 });
  });

  it("gives one row per day across a range", async () => {
    const a = await ring(ticket([["0003", 1]]));
    await backdate(a.saleId, 2);
    await ring(ticket([["0003", 2]]));
    const from = addDays(today, -6);
    const r = await invoke(db, owner, "salesReport", { from, to: today });
    expect(r.days.map((d) => d.day)).toEqual(Array.from({ length: 7 }, (_, i) => addDays(from, i)));
    for (const k of ["count", "netCents", "cardCents", "cashCents", "depositsCents", "taxCents"] as const)
      expect(r.days.reduce((s, d) => s + d[k], 0)).toBe(
        k === "count"
          ? r.totals.count
          : k === "netCents"
            ? r.totals.netCents
            : k === "cardCents"
              ? r.totals.cardInCents - r.totals.cardBackCents
              : k === "cashCents"
                ? r.totals.cashInCents - r.totals.cashBackCents
                : k === "depositsCents"
                  ? r.totals.depositsTakenCents - r.totals.depositsRefundedCents
                  : r.totals.taxCents,
      );
    expect(r.days.find((d) => d.day === addDays(today, -2))!.count).toBe(1);
  });

  it("refuses ranges over 13 months or the wrong way round", async () => {
    await expect(invoke(db, owner, "salesReport", { from: addDays(today, -400), to: today })).rejects.toThrow(
      "Pick a range of 13 months or less.",
    );
    await expect(invoke(db, owner, "salesReport", { from: today, to: addDays(today, -1) })).rejects.toThrow(
      /start date is after/,
    );
    await expect(
      invoke(db, owner, "salesReport", { from: addDays(today, -396), to: today }),
    ).resolves.toBeTruthy();
  });

  it("is for owners and managers only", async () => {
    for (const ctx of [cashier, groomer]) {
      for (const name of ["salesReport", "groomingReport", "astroReport"] as const)
        await expect(invoke(db, ctx, name, range)).rejects.toThrow("You don't have permission to do that.");
      await expect(invoke(db, ctx, "stockReport", undefined)).rejects.toThrow(
        "You don't have permission to do that.",
      );
    }
  });

  it("never shows another business's numbers", async () => {
    await ring(ticket([["0003", 1]]));
    const other = await insertBusiness(db, "other-store");
    await db.insertInto("locations").values({ business_id: other, name: "Other" }).execute();
    const st = await db
      .insertInto("staff")
      .values({ business_id: other, name: "O", role: "owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const o: Ctx = { businessId: other, staffId: st.id, role: "owner" };
    const r = await invoke(db, o, "salesReport", range);
    expect(r.totals.count).toBe(0);
    expect(r.categories).toEqual([]);
    const s = await invoke(db, o, "stockReport", undefined);
    expect(s).toMatchObject({ costCents: 0, reorder: [], categories: [] });
    const g = await invoke(db, o, "groomingReport", { from: addDays(today, -60), to: today });
    expect(g).toMatchObject({ grooms: 0, noShows: 0, groomers: [] });
    const a = await invoke(db, o, "astroReport", { from: addDays(today, -60), to: today });
    expect(a).toMatchObject({ earned: 0, programs: [], toCheck: [], checks: [] });
  });
});

describe("stock report", () => {
  beforeEach(() => setup());

  it("values stock at cost and retail, lists what to reorder, and flags odd counts", async () => {
    const products = await invoke(db, owner, "listProducts", {});
    const r = await invoke(db, manager, "stockReport", undefined);
    const cost = products.reduce((s, p) => s + Math.max(0, p.onHand) * p.costCents, 0);
    const retail = products
      .filter((p) => !p.backBar)
      .reduce((s, p) => s + Math.max(0, p.onHand) * p.priceCents, 0);
    expect(r).toMatchObject({ costCents: cost, retailCents: retail, asOf: today, noCost: 0 });
    // The rope toy is out (first), cat food is low.
    expect(r.reorder.slice(0, 2).map((x) => [x.sku, x.onHand])).toEqual([
      ["0004", 0],
      ["0002", 4],
    ]);
    expect(r.out).toBe(1);

    // Sold in the last 30 days, a product with no cost, and stock below zero.
    await ring(ticket([["0002", 2]]));
    await db.updateTable("products").set({ cost_cents: 0 }).where("id", "=", sku["0003"]!.id).execute();
    const loc = await db
      .selectFrom("locations")
      .select("id")
      .where("business_id", "=", businessId)
      .executeTakeFirstOrThrow();
    await db
      .insertInto("inventory_moves")
      .values({
        business_id: businessId,
        product_id: sku["0004"]!.id,
        location_id: loc.id,
        qty_change: -2,
        reason: "sale",
      })
      .execute();
    const after = await invoke(db, manager, "stockReport", undefined);
    expect(after.reorder.find((x) => x.sku === "0002")).toMatchObject({ onHand: 2, soldLast30: 2 });
    expect(after.noCost).toBe(1);
    expect(after.countsToCheck).toEqual([expect.objectContaining({ sku: "0004", onHand: -2 })]);
    // Negative stock counts as zero in the value.
    expect(after.costCents).toBe(cost - 2 * sku["0002"]!.costCents - 30 * sku["0003"]!.costCents);
    const cats = after.categories.reduce((s, c) => s + c.costCents, 0);
    expect(cats).toBe(after.costCents);
  });
});

describe("grooming report", () => {
  beforeEach(() => setup());

  it("counts no-shows, rebooking and revenue by service", async () => {
    // Clover's bath 5 weeks ago (done, nothing booked since) and Biscuit's groom 3 weeks
    // ago (done, booked again today) come with the demo.
    const from = addDays(today, -40);
    const r = await invoke(db, owner, "groomingReport", { from, to: today });
    expect(r.rebook).toMatchObject({ done: 2, rebooked: 1, tooSoon: 1, notRebooked: 0, ratePercent: 100 });

    const day = await invoke(db, owner, "groomingDay", { day: today });
    const mo = day.appointments.find((a) => a.petName === "Mo")!.id;
    await invoke(db, manager, "setAppointmentStatus", { id: mo, status: "no_show" });
    const after = await invoke(db, owner, "groomingReport", range);
    expect(after.noShows).toBe(1);
    expect(after.noShowList).toEqual([
      expect.objectContaining({ petName: "Mo", customerName: "Sample Cat Parent (DEMO)", keptCents: null }),
    ]);
    expect(after.groomers.find((g) => g.noShows === 1)).toBeTruthy();

    const biscuit = day.appointments.find((a) => a.petName === "Biscuit")!.id;
    await ring({
      customerId: sampleCustomer,
      lines: [{ key: "g", appointmentId: biscuit, qty: 1, applyOffer: false }],
      rewards: [],
      discounts: [],
    });
    const paid = await invoke(db, owner, "groomingReport", range);
    expect(paid.services).toEqual([
      expect.objectContaining({ name: "Sample Full groom (DEMO)", grooms: 1, salesCents: 8000 }),
    ]);
    expect(paid.grooms).toBe(1);
  });
});

describe("astro report", () => {
  beforeEach(() => setup());

  it("counts punches, rewards and offers, and how far behind the queue is", async () => {
    // The Sample Customer has 11 of 12: two bags with the offer fill the card and earn one more.
    const a = await ring(ticket([["0001", 2, true]], { customerId: sampleCustomer }), "card");
    await ring(ticket([["0001", 1]], { customerId: sampleCustomer, rewards: [club] }), "card");
    const r = await invoke(db, owner, "astroReport", range);
    expect(r).toMatchObject({ earned: 2, rewards: 1, rewardCents: 6499, offers: 1, offerCents: 500 });
    expect(r.programs).toEqual([
      expect.objectContaining({ programId: club, earned: 2, takenBack: 0, rewards: 1, offers: 1 }),
    ]);
    expect(r.backlog).toMatchObject({ pending: 2, underDay: 2, underWeek: 0, overWeek: 0 });

    await backdate(a.saleId, 9);
    const later = await invoke(db, owner, "astroReport", range);
    expect(later.backlog).toMatchObject({ pending: 2, underDay: 1, overWeek: 1 });
    expect(later.earned).toBe(0);

    // Punches taken back by a refund show apart.
    const c = await ring(ticket([["0001", 1]], { customerId: family }), "card");
    await refundFirstLine(c.saleId);
    const refunded = await invoke(db, owner, "astroReport", range);
    expect(refunded.programs[0]).toMatchObject({ earned: 1, takenBack: 1 });
  });

  it("picks customers to check against Astro and saves what Astro shows", async () => {
    await ring(ticket([["0001", 1]], { customerId: family }), "card");
    const r = await invoke(db, owner, "astroReport", range);
    expect(r.toCheck).toEqual([
      expect.objectContaining({
        customerId: family,
        checkedAt: null,
        programs: [expect.objectContaining({ programId: club, localBalance: 5 })],
      }),
    ]);
    await expect(
      invoke(db, cashier, "saveAstroCheck", {
        customerId: family,
        rows: [{ programId: club, astroBalance: 4 }],
      }),
    ).rejects.toThrow("You don't have permission to do that.");
    const saved = await invoke(db, manager, "saveAstroCheck", {
      customerId: family,
      rows: [{ programId: club, astroBalance: 4 }],
    });
    expect(saved[0]).toMatchObject({ localBalance: 5, astroBalance: 4, matches: false });
    await invoke(db, manager, "saveAstroCheck", {
      customerId: family,
      rows: [{ programId: club, astroBalance: null }],
    });
    const after = await invoke(db, owner, "astroReport", range);
    expect(after.toCheck[0]!.checkedAt).not.toBeNull();
    expect(after.checks.map((c) => c.matches)).toEqual([true, false]);
    expect(after.lastCheckAt).not.toBeNull();
    await expect(
      invoke(db, manager, "saveAstroCheck", {
        customerId: family,
        rows: [{ programId: club, astroBalance: -1 }],
      }),
    ).rejects.toThrow(/whole number/);

    // Saved checks can't be changed or deleted.
    await expect(
      withBusiness(db, businessId, (trx) => trx.updateTable("astro_checks").set({ matches: true }).execute()),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withBusiness(db, businessId, (trx) => trx.deleteFrom("astro_checks").execute()),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("sample sales history", () => {
  it("fills six weeks, leaves stock and punch cards where they were, and goes with remove demo data", async () => {
    await setup(true);
    const products = await invoke(db, owner, "listProducts", {});
    expect(Object.fromEntries(products.filter((p) => !p.backBar).map((p) => [p.sku, p.onHand]))).toEqual({
      "0001": 14,
      "0002": 4,
      "0003": 30,
      "0004": 0,
    });
    const profile = await invoke(db, owner, "getCustomer", { id: family });
    expect(profile.punchCards[0]).toMatchObject({ balance: 4 });

    const from = addDays(today, -42);
    const to = addDays(today, -1);
    const r = await invoke(db, owner, "salesReport", { from, to });
    expect(r.totals.count).toBeGreaterThan(400);
    expect(r.totals.refundCount).toBe(2);
    const net = r.categories.reduce((s, c) => s + c.netCents, 0);
    expect(net).toBe(r.totals.grossCents - r.totals.taxCents - (r.totals.refundCents - r.refundTaxCents));
    expect(r.days.reduce((s, d) => s + d.netCents, 0)).toBe(r.totals.netCents);
    expect(r.categories.map((c) => c.category)).toContain("Fees");
    expect(r.totals.depositsKeptCents).toBe(2000);

    const g = await invoke(db, owner, "groomingReport", { from: addDays(today, -90), to: today });
    expect(g.noShows).toBe(2);
    expect(g.noShowList.find((n) => n.petName === "Juno")!.keptCents).toBe(2000);
    expect(g.rebook.done).toBeGreaterThanOrEqual(6);
    expect(g.groomers.reduce((s, x) => s + x.salesCents, 0)).toBe(
      (await invoke(db, owner, "salesReport", { from: addDays(today, -90), to: today })).categories.find(
        (c) => c.category === "Grooming",
      )!.netCents,
    );

    const a = await invoke(db, owner, "astroReport", { from, to: today });
    expect(a.rewards).toBe(1);
    expect(a.backlog.overWeek).toBe(1);
    expect(a.checks).toHaveLength(1);

    // A sale the user rang stays; the sample history goes.
    const mine = await ring(ticket([["0003", 1]]));
    await invoke(db, owner, "removeDemoData", undefined);
    const left = await withBusiness(db, businessId, (trx) =>
      trx.selectFrom("sales").select(["id", "is_demo"]).execute(),
    );
    expect(left).toEqual([{ id: mine.saleId, is_demo: false }]);
    const checks = await withBusiness(db, businessId, (trx) =>
      trx.selectFrom("astro_checks").select("id").execute(),
    );
    expect(checks).toEqual([]);
  });
});
