import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { addDays, todayIso, type Ctx } from "@pet-pos/core";
import { ensureDemo, listDemoStaff, withBusiness, type DB } from "@pet-pos/db";
import { createTestDb, insertBusiness } from "@pet-pos/db/test-db";
import type { TicketInput } from "../src/handlers/register.ts";
import { invoke } from "../src/registry.ts";
import {
  invokePublic,
  type PublicInput,
  type PublicName,
  type PublicOutput,
} from "../src/public/registry.ts";

let db: Kysely<DB>;
let businessId: string;
let owner: Ctx;
let cashier: Ctx;
let svc: Record<string, string>;
let A: string;

function nextTuesday(): string {
  let d = addDays(todayIso(), 2);
  while (new Date(`${d}T12:00:00`).getDay() !== 2) d = addDays(d, 1);
  return d;
}
const tue = nextTuesday();

beforeEach(async () => {
  ({ db } = await createTestDb());
  businessId = await ensureDemo(db);
  const staff = await listDemoStaff(db);
  owner = { businessId, role: "owner", staffId: staff.find((s) => s.role === "owner")!.id };
  cashier = { businessId, role: "cashier", staffId: staff.find((s) => s.role === "cashier")!.id };
  svc = Object.fromEntries(
    (await invoke(db, owner, "listServices", {})).map((s) => [s.name.split(" ")[1], s.id]),
  );
  A = (await invoke(db, owner, "listGroomers", {})).find((g) => g.name === "Sample Groomer (DEMO)")!.staffId;
});

function pub<N extends PublicName>(name: N, input: PublicInput<N>, token: string | null = null, demo = true) {
  return invokePublic(db, { businessId, token, demo }, name, input) as Promise<PublicOutput<N>>;
}

async function signIn(contact: string, name?: string): Promise<string> {
  const sent = await pub("requestCode", { contact });
  const r = await pub("verifyCode", { contact, code: sent.demoCode!, name });
  if (r.status !== "signed_in") throw new Error("not signed in");
  return r.token;
}

const q = <T>(run: (trx: Parameters<Parameters<typeof withBusiness>[2]>[0]) => Promise<T>) =>
  withBusiness(db, businessId, run);

const deposit = (id: string) =>
  q((trx) => trx.selectFrom("deposits").selectAll().where("id", "=", id).executeTakeFirstOrThrow());

const audits = (action: string) =>
  q((trx) => trx.selectFrom("audit_log").selectAll().where("action", "=", action).execute());

/** Biscuit (size M) books a Full groom ($70.00, $20.00 deposit) on Tuesday at 9:00 with groomer A. */
async function bookFull(token: string, start = 540) {
  const acct = await pub("myAccount", undefined, token);
  const biscuit = acct.pets.find((p) => p.name === "Biscuit")!;
  return pub(
    "bookOnline",
    { petId: biscuit.id, serviceId: svc.Full!, addonIds: [], staffId: A, day: tue, start },
    token,
  );
}

async function expireHold(appointmentId: string) {
  await q((trx) =>
    trx
      .updateTable("appointments")
      .set({ hold_expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", appointmentId)
      .execute(),
  );
}

describe("booking with a deposit", () => {
  it("holds the time until it's paid, then books it", async () => {
    const token = await signIn("2125550100");
    const a = await bookFull(token);
    expect(a.status).toBe("held");
    expect(a.holdUntil).not.toBeNull();
    expect(a.deposit).toMatchObject({
      amountCents: 2000,
      status: "pending",
      url: `/book/pay/${a.deposit!.id}`,
    });

    // Someone else can't take the held time.
    const family = await signIn("2125550102");
    const rex = (await pub("myAccount", undefined, family)).pets.find((p) => p.name === "Rex")!;
    await expect(
      pub(
        "bookOnline",
        { petId: rex.id, serviceId: svc.Bath!, addonIds: [], staffId: A, day: tue, start: 540 },
        family,
      ),
    ).rejects.toThrow(/isn't open anymore|just taken/);

    const v = await pub("simulateDepositPayment", { id: a.deposit!.id, outcome: "paid" }, token);
    expect(v).toMatchObject({ status: "paid", holdUntil: null, message: null, amountCents: 2000 });
    const mine = (await pub("myAccount", undefined, token)).upcoming.find((x) => x.id === a.id)!;
    expect(mine).toMatchObject({ status: "booked", deposit: { status: "paid", url: null } });
    // Paying twice does nothing more.
    expect(
      (await pub("simulateDepositPayment", { id: a.deposit!.id, outcome: "paid" }, token)).message,
    ).toMatch(/already paid/);
  });

  it("lets the time go when the hold runs out, and refunds a payment that comes too late", async () => {
    const token = await signIn("2125550100");
    const a = await bookFull(token);
    expect(
      (await pub("simulateDepositPayment", { id: a.deposit!.id, outcome: "canceled" }, token)).message,
    ).toMatch(/still held/);
    await expireHold(a.id);
    // The time is free again.
    const acct = await pub("myAccount", undefined, token);
    expect(acct.upcoming.find((x) => x.id === a.id)).toBeUndefined();
    await expect(pub("payDeposit", { appointmentId: a.id }, token)).rejects.toThrow(
      /hold on this time ran out/,
    );
    const again = await bookFull(token);
    expect(again.status).toBe("held");

    const late = await pub("simulateDepositPayment", { id: a.deposit!.id, outcome: "paid" }, token);
    expect(late.message).toMatch(
      /hold ran out before your payment came in\. Your \$20\.00 deposit was refunded/,
    );
    expect(await deposit(a.deposit!.id)).toMatchObject({ status: "refunded", refunded_cents: 2000 });
    expect((await audits("deposit.refund")).length).toBe(1);
  });

  it("follows the store's rule: off, and new customers only", async () => {
    const save = (depositRule: "off" | "new") =>
      invoke(db, owner, "updateSettings", {
        name: "Sample Pet Store (DEMO)",
        brandColor: null,
        logo: null,
        locationName: "Main store (DEMO)",
        taxPercent: "7",
        astroDiscountsBeforeTax: true,
        booking: {
          enabled: true,
          daysAhead: 30,
          noticeMinutes: 120,
          cutoffHours: 24,
          stepMinutes: 30,
          message: null,
          phone: "2125550199",
          depositRule,
        },
      });
    await save("off");
    const token = await signIn("2125550100");
    expect((await bookFull(token)).deposit).toBeNull();
    await save("new");
    // The sample customer has finished grooms, so they're not new.
    expect((await pub("myAccount", undefined, token)).newCustomer).toBe(false);
    expect((await bookFull(token, 720)).deposit).toBeNull();
    const pat = await signIn("pat@example.com", "Pat Lee");
    await pub("savePet", { name: "Rufus", species: "dog", size: "M" }, pat);
    const rufus = (await pub("myAccount", undefined, pat)).pets[0]!;
    const b = await pub(
      "bookOnline",
      {
        petId: rufus.id,
        serviceId: svc.Full!,
        addonIds: [],
        staffId: null,
        day: addDays(tue, 1),
        start: 600,
      },
      pat,
    );
    expect(b.deposit?.amountCents).toBe(2000);
    expect((await invoke(db, owner, "getSettings", undefined)).booking.depositRule).toBe("new");
  });
});

describe("canceling and no-shows", () => {
  async function paid(token: string, start = 540) {
    const a = await bookFull(token, start);
    await pub("simulateDepositPayment", { id: a.deposit!.id, outcome: "paid" }, token);
    return a;
  }

  it("refunds when the customer cancels in time, or cancels a held booking", async () => {
    const token = await signIn("2125550100");
    const a = await paid(token);
    await pub("cancelMine", { id: a.id }, token);
    expect(await deposit(a.deposit!.id)).toMatchObject({ status: "refunded", refunded_cents: 2000 });
    const held = await bookFull(token, 720);
    await pub("cancelMine", { id: held.id }, token);
    expect(await deposit(held.deposit!.id)).toMatchObject({ status: "canceled", refunded_cents: 0 });
  });

  it("staff cancel refunds by default, or keeps it as a cancellation fee", async () => {
    const token = await signIn("2125550100");
    const a = await paid(token);
    await invoke(db, cashier, "cancelAppointment", { id: a.id });
    expect((await deposit(a.deposit!.id)).status).toBe("refunded");
    const b = await paid(token, 720);
    await invoke(db, cashier, "cancelAppointment", { id: b.id, refundDeposit: false });
    const d = await deposit(b.deposit!.id);
    expect(d.status).toBe("kept");
    const sale = await invoke(db, owner, "getSale", { id: d.kept_sale_id! });
    expect(sale.lines[0]!.name).toMatch(/^Cancellation fee: Biscuit/);
  });

  it("a no-show keeps the deposit as a paid fee sale, or refunds it; undo needs the fee refunded", async () => {
    const token = await signIn("2125550100");
    const a = await paid(token);
    await invoke(db, cashier, "setAppointmentStatus", { id: a.id, status: "no_show" });
    const d = await deposit(a.deposit!.id);
    expect(d.status).toBe("kept");
    const sale = await invoke(db, owner, "getSale", { id: d.kept_sale_id! });
    expect(sale).toMatchObject({ status: "paid", totalCents: 2000, taxCents: 0 });
    expect(sale.receiptNumber).toBeGreaterThan(1000);
    expect(sale.payments).toMatchObject([{ method: "deposit", amountCents: 2000 }]);
    expect((await audits("deposit.keep")).length).toBe(1);
    await expect(invoke(db, cashier, "setAppointmentStatus", { id: a.id, status: "booked" })).rejects.toThrow(
      /Refund that sale first/,
    );
    // The fee counts in the day's sales, but not as counter card or cash.
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + 86_400_000);
    const day = await withBusiness(db, businessId, async (trx) =>
      (await import("../src/handlers/totals.ts")).moneyTotals(trx, from, to),
    );
    expect(day).toMatchObject({
      depositsKeptCents: 2000,
      depositsTakenCents: 2000,
      cardInCents: 0,
      cashInCents: 0,
    });

    const b = await paid(token, 720);
    await invoke(db, cashier, "setAppointmentStatus", { id: b.id, status: "no_show", keepDeposit: false });
    expect(await deposit(b.deposit!.id)).toMatchObject({ status: "refunded", kept_sale_id: null });
  });

  it("refunds on a call-out and a customer delete", async () => {
    const token = await signIn("2125550102");
    const acct = await pub("myAccount", undefined, token);
    const rex = acct.pets.find((p) => p.name === "Rex")!;
    const a = await pub(
      "bookOnline",
      { petId: rex.id, serviceId: svc.Full!, addonIds: [], staffId: A, day: tue, start: 540 },
      token,
    );
    await pub("simulateDepositPayment", { id: a.deposit!.id, outcome: "paid" }, token);
    await invoke(db, owner, "applyCallout", {
      staffId: A,
      day: tue,
      notify: false,
      addTimeOff: false,
      changes: [{ id: a.id, action: "cancel" }],
    });
    expect((await deposit(a.deposit!.id)).status).toBe("refunded");

    const b = await pub(
      "bookOnline",
      { petId: rex.id, serviceId: svc.Full!, addonIds: [], staffId: null, day: addDays(tue, 1), start: 600 },
      token,
    );
    await pub("simulateDepositPayment", { id: b.deposit!.id, outcome: "paid" }, token);
    const cust = (await invoke(db, owner, "lookupByPhone", { phone: "2125550102" }))!.id;
    await invoke(db, owner, "deleteCustomer", { id: cust });
    expect((await deposit(b.deposit!.id)).status).toBe("refunded");
  });
});

describe("at the register", () => {
  /** Biscuit's demo groom today ($80.00) came with a paid $20.00 deposit. */
  async function biscuitToday() {
    const day = await invoke(db, owner, "groomingDay", { day: todayIso() });
    return day.appointments.find((a) => a.petName === "Biscuit")!;
  }
  const customer = async () => (await invoke(db, owner, "lookupByPhone", { phone: "2125550100" }))!.id;
  const ticket = async (over: Partial<TicketInput> = {}): Promise<TicketInput> => ({
    customerId: await customer(),
    lines: [{ key: "g", appointmentId: (await biscuitToday()).id, qty: 1, applyOffer: false }],
    rewards: [],
    discounts: [],
    ...over,
  });

  it("shows the deposit waiting, applies it, and the rest is paid by cash", async () => {
    const b = await biscuitToday();
    expect(b.deposit).toMatchObject({ amountCents: 2000, status: "paid" });
    const waiting = await invoke(db, cashier, "groomsToCheckOut", { customerId: await customer() });
    expect(waiting[0]).toMatchObject({ priceCents: 8000, depositCents: 2000 });

    const s = await invoke(db, cashier, "startCheckout", await ticket());
    expect(s).toMatchObject({ totalCents: 8000, depositCents: 2000, depositRefundedCents: 0, paid: false });
    await expect(
      invoke(db, cashier, "payCash", { saleId: s.saleId, amountCents: 8000, tenderedCents: 8000 }),
    ).rejects.toThrow();
    const r = await invoke(db, cashier, "payCash", {
      saleId: s.saleId,
      amountCents: 6000,
      tenderedCents: 6000,
    });
    expect(r.paid).toBe(true);
    const sale = await invoke(db, owner, "getSale", { id: s.saleId });
    expect(sale.payments.map((p) => [p.method, p.amountCents])).toEqual([
      ["deposit", 2000],
      ["cash", 6000],
    ]);
    expect((await deposit(b.deposit!.id)).status).toBe("applied");
    expect((await biscuitToday()).status).toBe("done");
  });

  it("a void puts the deposit back; a later refund sends the deposit part back to its card", async () => {
    const b = await biscuitToday();
    const s = await invoke(db, cashier, "startCheckout", await ticket());
    const v = await invoke(db, cashier, "cancelSale", { saleId: s.saleId });
    expect(v.refundedCents).toBe(0);
    expect((await deposit(b.deposit!.id)).status).toBe("paid");

    const s2 = await invoke(db, cashier, "startCheckout", await ticket());
    expect(s2.depositCents).toBe(2000);
    await invoke(db, cashier, "payCash", { saleId: s2.saleId, amountCents: 6000, tenderedCents: 6000 });
    const sale = await invoke(db, owner, "getSale", { id: s2.saleId });
    const plan = await invoke(db, owner, "refundPreview", {
      saleId: s2.saleId,
      lines: [{ saleLineId: sale.lines[0]!.id, qty: 1 }],
      restock: false,
    });
    expect(plan.payments.map((p) => p.method)).toEqual(["deposit", "cash"]);
    expect(plan.label).toBe("Refund $20.00 to the card that paid the deposit · Hand back $60.00 cash");
    await invoke(db, owner, "refundSale", {
      saleId: s2.saleId,
      lines: [{ saleLineId: sale.lines[0]!.id, qty: 1 }],
      restock: false,
      reason: "other",
      note: "Groom redone",
    });
    const back = await q((trx) =>
      trx.selectFrom("refund_payments").select(["method", "amount_cents", "provider_ref"]).execute(),
    );
    expect(back.find((r) => r.method === "deposit")).toMatchObject({ amount_cents: 2000 });
    expect(back.find((r) => r.method === "deposit")!.provider_ref).toMatch(/^simrefund_/);
  });

  it("refunds the part of a deposit a discounted sale doesn't need", async () => {
    const b = await biscuitToday();
    await q((trx) =>
      trx.updateTable("deposits").set({ amount_cents: 9000 }).where("id", "=", b.deposit!.id).execute(),
    );
    const s = await invoke(db, cashier, "startCheckout", await ticket());
    expect(s).toMatchObject({ totalCents: 8000, depositCents: 8000, depositRefundedCents: 1000, paid: true });
    expect(await deposit(b.deposit!.id)).toMatchObject({ status: "applied", refunded_cents: 1000 });
  });
});

describe("staff deposits and separation", () => {
  it("asks for a deposit on a phone booking and texts the link; refunds need a manager", async () => {
    const cust = (await invoke(db, owner, "lookupByPhone", { phone: "2125550100" }))!.id;
    const pets = (await invoke(db, owner, "getCustomer", { id: cust })).pets;
    const appt = await invoke(db, cashier, "bookAppointment", {
      customerId: cust,
      petId: pets.find((p) => p.name === "Biscuit")!.id,
      serviceId: svc.Full!,
      addonIds: [],
      staffId: A,
      day: tue,
      start: "09:00",
    });
    expect(appt.deposit).toBeNull();
    const r = await invoke(db, cashier, "requestDeposit", { appointmentId: appt.id, text: true });
    expect(r).toMatchObject({ amountCents: 2000, url: `/book/pay/${r.depositId}` });
    expect(r.texted).toMatch(
      /please pay the \$20\.00 deposit for Biscuit's groom on .* at 9:00 AM: \/book\/pay\//,
    );
    await expect(invoke(db, cashier, "requestDeposit", { appointmentId: appt.id })).rejects.toThrow(
      /already has a deposit/,
    );
    await expect(invoke(db, cashier, "refundDeposit", { id: r.depositId })).rejects.toThrow();
    expect(await invoke(db, owner, "refundDeposit", { id: r.depositId })).toEqual({ refundedCents: 0 });
    expect((await deposit(r.depositId)).status).toBe("canceled");
  });

  it("keeps customers and stores apart, and the payment stand-in is demo only", async () => {
    const token = await signIn("2125550100");
    const a = await bookFull(token);
    const family = await signIn("2125550102");
    await expect(pub("depositStatus", { id: a.deposit!.id }, family)).rejects.toThrow(
      /isn't on your account/,
    );
    await expect(
      pub("simulateDepositPayment", { id: a.deposit!.id, outcome: "paid" }, family),
    ).rejects.toThrow(/isn't on your account/);
    await expect(
      pub("simulateDepositPayment", { id: a.deposit!.id, outcome: "paid" }, token, false),
    ).rejects.toThrow(/come from Square/);
    const other = await insertBusiness(db, "other-store");
    const seen = await withBusiness(db, other, (trx) => trx.selectFrom("deposits").select("id").execute());
    expect(seen).toEqual([]);
  });
});
