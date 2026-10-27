import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { addDays, atLocal, todayIso, type Ctx } from "@pet-pos/core";
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
let groomerB: Ctx;
let sku: Record<string, { id: string; onHand: number }>;
let sampleCustomer: string;
let catParent: string;
/** Biscuit's demo groom today: Full groom + Teeth brushing, size M, $80, checked in. */
let biscuit: string;

beforeEach(async () => {
  ({ db } = await createTestDb());
  businessId = await ensureDemo(db);
  const staff = await listDemoStaff(db);
  const ctx = (role: Ctx["role"], name?: string): Ctx => ({
    businessId,
    role,
    staffId: staff.find((s) => s.role === role && (!name || s.name === name))!.id,
  });
  owner = ctx("owner");
  manager = ctx("manager");
  cashier = ctx("cashier");
  groomer = ctx("groomer", "Sample Groomer (DEMO)");
  groomerB = ctx("groomer", "Sample Groomer B (DEMO)");
  sku = Object.fromEntries((await invoke(db, owner, "listProducts", {})).map((p) => [p.sku, p]));
  sampleCustomer = (await invoke(db, owner, "lookupByPhone", { phone: "2125550100" }))!.id;
  catParent = (await invoke(db, owner, "lookupByPhone", { phone: "2125550101" }))!.id;
  const day = await invoke(db, owner, "groomingDay", { day: todayIso() });
  biscuit = day.appointments.find((a) => a.petName === "Biscuit")!.id;
});

const ticket = (over: Partial<TicketInput> = {}): TicketInput => ({
  customerId: sampleCustomer,
  lines: [{ key: "g", appointmentId: biscuit, qty: 1, applyOffer: false }],
  rewards: [],
  discounts: [],
  ...over,
});
const pay = async (t: TicketInput) => {
  const s = await invoke(db, cashier, "startCheckout", t);
  await invoke(db, cashier, "payCash", {
    saleId: s.saleId,
    // Biscuit's demo groom has a $20.00 deposit paid online, already taken off.
    amountCents: s.totalCents - s.depositCents,
    tenderedCents: s.totalCents - s.depositCents,
  });
  return s;
};
const appt = (id = biscuit) =>
  withBusiness(db, businessId, (trx) =>
    trx
      .selectFrom("appointments")
      .select(["status", "sale_id", "done_at", "supplies_used_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow(),
  );
const onHand = async (code: string) =>
  (await invoke(db, owner, "listProducts", { includeArchived: true })).find((p) => p.sku === code)!.onHand;

describe("checking out a groom", () => {
  it("rings the groom with retail items, untaxed by default, and paying marks it done", async () => {
    const s = await pay(
      ticket({
        lines: [
          { key: "g", appointmentId: biscuit, qty: 1, applyOffer: false },
          { key: "1", productId: sku["0003"]!.id, qty: 1, applyOffer: false },
        ],
      }),
    );
    // $80.00 groom (not taxed) + $12.99 treats + 7% tax on the treats (91¢).
    expect(s).toMatchObject({ subtotalCents: 9299, taxCents: 91, totalCents: 9390 });
    expect(await appt()).toMatchObject({ status: "done", sale_id: s.saleId });
    const receipt = await invoke(db, owner, "getSale", { id: s.saleId });
    expect(receipt.lines[0]!.name).toBe("Sample Full groom (DEMO) + Sample Teeth brushing (DEMO) · Biscuit");
    const day = await invoke(db, owner, "groomingDay", { day: todayIso() });
    expect(day.appointments.find((a) => a.id === biscuit)).toMatchObject({
      status: "done",
      receiptNumber: s.receiptNumber,
    });
    // A groom doesn't earn Astro punches or go to the Astro queue on its own.
    const q = await withBusiness(db, businessId, (trx) =>
      trx.selectFrom("astro_queue").select("id").execute(),
    );
    expect(q).toEqual([]);
  });

  it("taxes grooming when the store says so", async () => {
    const set = await invoke(db, owner, "getSettings", undefined);
    await invoke(db, owner, "updateSettings", {
      name: set.name,
      brandColor: set.brandColor,
      logo: set.logo,
      locationName: set.locationName,
      taxPercent: "7",
      astroDiscountsBeforeTax: set.astroDiscountsBeforeTax,
      groomingTaxable: true,
    });
    const s = await invoke(db, cashier, "startCheckout", ticket());
    expect(s).toMatchObject({ subtotalCents: 8000, taxCents: 560, totalCents: 8560 });
  });

  it("lets a whole-ticket discount cover grooming", async () => {
    const emp = (await invoke(db, owner, "listDiscounts", {})).find((d) => d.code === "EMP")!;
    const s = await invoke(
      db,
      cashier,
      "startCheckout",
      ticket({ discounts: [{ discountId: emp.id, lineKey: null, note: "Sam's dog" }] }),
    );
    expect(s).toMatchObject({ discountCents: 1600, totalCents: 6400 });
  });

  it("refuses the wrong customer, no customer, a groom on another open sale, and a canceled one", async () => {
    await expect(invoke(db, cashier, "startCheckout", ticket({ customerId: catParent }))).rejects.toThrow(
      "This groom is for Sample Customer (DEMO). Change the customer or remove the groom.",
    );
    await expect(invoke(db, cashier, "startCheckout", ticket({ customerId: null }))).rejects.toThrow(
      /Attach the customer/,
    );
    const open = await invoke(db, cashier, "startCheckout", ticket());
    await expect(invoke(db, cashier, "startCheckout", ticket())).rejects.toThrow(
      `Biscuit's groom is already on receipt #${open.receiptNumber}, which hasn't been paid.`,
    );
    // Canceling that sale frees the groom and leaves it as it was.
    await invoke(db, cashier, "cancelSale", { saleId: open.saleId });
    expect((await appt()).status).toBe("checked_in");
    await invoke(db, cashier, "startCheckout", ticket()).then((s) =>
      invoke(db, cashier, "cancelSale", { saleId: s.saleId }),
    );

    await invoke(db, cashier, "cancelAppointment", { id: biscuit });
    await expect(invoke(db, cashier, "startCheckout", ticket())).rejects.toThrow(/was canceled/);
  });

  it("refuses paying for a groom twice", async () => {
    await pay(ticket());
    await expect(invoke(db, cashier, "startCheckout", ticket())).rejects.toThrow(/already paid/);
  });

  it("refunds the groom line; the appointment stays done", async () => {
    const s = await pay(ticket());
    const line = (await invoke(db, owner, "getSale", { id: s.saleId })).lines[0]!.id;
    const r = await invoke(db, owner, "refundSale", {
      saleId: s.saleId,
      lines: [{ saleLineId: line, qty: 1 }],
      restock: false,
      reason: "other",
      note: "Unhappy with the cut",
    });
    expect(r.totalCents).toBe(8000);
    expect((await appt()).status).toBe("done");
    const day = await invoke(db, owner, "groomingDay", { day: todayIso() });
    expect(day.appointments.find((a) => a.id === biscuit)!.saleRefundedCents).toBe(8000);
  });

  it("lists today's unpaid grooms for the register", async () => {
    const list = await invoke(db, cashier, "groomsToCheckOut", { customerId: sampleCustomer });
    expect(list).toEqual([
      expect.objectContaining({ petName: "Biscuit", priceCents: 8000, status: "checked_in" }),
    ]);
    await pay(ticket());
    expect(await invoke(db, cashier, "groomsToCheckOut", { customerId: sampleCustomer })).toEqual([]);
  });
});

describe("back-bar supplies", () => {
  it("come off once when the groom is ready, go back on undo, and aren't taken again at payment", async () => {
    // Full groom size M: 3 oz shampoo, 1 oz conditioner; teeth brushing uses none.
    expect([await onHand("BB-01"), await onHand("BB-02")]).toEqual([128, 64]);
    await invoke(db, groomer, "setAppointmentStatus", { id: biscuit, status: "in_progress" });
    await invoke(db, groomer, "setAppointmentStatus", { id: biscuit, status: "ready" });
    expect([await onHand("BB-01"), await onHand("BB-02")]).toEqual([125, 63]);
    await invoke(db, groomer, "setAppointmentStatus", { id: biscuit, status: "in_progress" });
    expect([await onHand("BB-01"), await onHand("BB-02")]).toEqual([128, 64]);
    await invoke(db, groomer, "setAppointmentStatus", { id: biscuit, status: "ready" });
    await pay(ticket());
    expect([await onHand("BB-01"), await onHand("BB-02")]).toEqual([125, 63]);
  });

  it("come off at payment when the groom skipped ready", async () => {
    await pay(ticket());
    expect(await onHand("BB-01")).toBe(125);
    expect((await appt()).supplies_used_at).toBeInstanceOf(Date);
  });

  it("are kept off the register", async () => {
    expect((await invoke(db, cashier, "listProducts", { forSale: true })).map((p) => p.sku)).not.toContain(
      "BB-01",
    );
    expect(await invoke(db, cashier, "findByCode", { code: "bb-01", forSale: true })).toBeNull();
    await expect(
      invoke(db, cashier, "startCheckout", {
        customerId: null,
        lines: [{ key: "1", productId: sku["BB-01"]!.id, qty: 1, applyOffer: false }],
        rewards: [],
        discounts: [],
      }),
    ).rejects.toThrow(/isn't for sale/);
  });

  it("are set per service, each product once", async () => {
    const svc = (await invoke(db, owner, "listServices", {})).find((s) => s.name.startsWith("Sample Bath"))!;
    expect(
      (await invoke(db, owner, "listServiceSupplies", { serviceId: svc.id })).map((x) => x.productName),
    ).toEqual(["Sample Oatmeal shampoo (DEMO)"]);
    const qty = { S: 1, M: 1, L: 1, XL: 1 };
    await expect(
      invoke(db, manager, "saveServiceSupplies", {
        serviceId: svc.id,
        supplies: [
          { productId: sku["BB-02"]!.id, qty },
          { productId: sku["BB-02"]!.id, qty },
        ],
      }),
    ).rejects.toThrow(/once/);
    await invoke(db, manager, "saveServiceSupplies", {
      serviceId: svc.id,
      supplies: [{ productId: sku["BB-02"]!.id, qty }],
    });
    expect(
      (await invoke(db, owner, "listServiceSupplies", { serviceId: svc.id })).map((x) => x.unit),
    ).toEqual(["oz"]);
    await expect(
      invoke(db, cashier, "saveServiceSupplies", { serviceId: svc.id, supplies: [] }),
    ).rejects.toThrow(/permission/);
  });
});

const photo = {
  kind: "after" as const,
  data: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
  width: 1280,
  height: 960,
};

describe("grooming notes and photos", () => {
  it("lets groomers write notes with photos; cashiers only read them", async () => {
    const n = await invoke(db, groomer, "addGroomingNote", {
      appointmentId: biscuit,
      note: " Shaved short ",
      photos: [photo],
    });
    expect(n).toMatchObject({ note: "Shaved short", staffName: "Sample Groomer (DEMO)", canDelete: true });
    expect(n.photos).toEqual([expect.objectContaining({ kind: "after", width: 1280, src: photo.data })]);
    await expect(
      invoke(db, cashier, "addGroomingNote", { appointmentId: biscuit, note: "x", photos: [] }),
    ).rejects.toThrow(/permission/);
    expect(
      (await invoke(db, cashier, "appointmentNotes", { appointmentId: biscuit })).map((x) => x.note),
    ).toEqual(["Shaved short"]);
  });

  it("checks photos", async () => {
    await expect(
      invoke(db, groomer, "addGroomingNote", { appointmentId: biscuit, note: "", photos: [] }),
    ).rejects.toThrow(/Write a note or add a photo/);
    await expect(
      invoke(db, groomer, "addGroomingNote", {
        appointmentId: biscuit,
        note: "x",
        photos: [{ ...photo, data: "data:image/png;base64,iVBOR" }],
      }),
    ).rejects.toThrow(/isn't a JPEG/);
    await expect(
      invoke(db, groomer, "addGroomingNote", {
        appointmentId: biscuit,
        note: "x",
        photos: [{ ...photo, data: `data:image/jpeg;base64,${"A".repeat(400_001)}` }],
      }),
    ).rejects.toThrow(/too large/);
    await expect(
      invoke(db, groomer, "addGroomingNote", {
        appointmentId: biscuit,
        note: "x",
        photos: Array(7).fill(photo),
      }),
    ).rejects.toThrow(/up to 6/);
  });

  it("lets the author delete their note the same day, and managers any note", async () => {
    const n = await invoke(db, groomer, "addGroomingNote", {
      appointmentId: biscuit,
      note: "One",
      photos: [],
    });
    await expect(invoke(db, groomerB, "deleteGroomingNote", { id: n.id })).rejects.toThrow(
      /Only the groomer/,
    );
    expect((await invoke(db, groomerB, "appointmentNotes", { appointmentId: biscuit }))[0]!.canDelete).toBe(
      false,
    );
    await invoke(db, groomer, "deleteGroomingNote", { id: n.id });
    const old = await invoke(db, groomer, "addGroomingNote", {
      appointmentId: biscuit,
      note: "Two",
      photos: [],
    });
    await db
      .updateTable("grooming_notes")
      .set({ created_at: atLocal(addDays(todayIso(), -1), 600) })
      .where("id", "=", old.id)
      .execute();
    await expect(invoke(db, groomer, "deleteGroomingNote", { id: old.id })).rejects.toThrow(
      /Only the groomer/,
    );
    await invoke(db, manager, "deleteGroomingNote", { id: old.id });
    expect(await invoke(db, manager, "appointmentNotes", { appointmentId: biscuit })).toEqual([]);
  });

  it("shows the pet's last note on its next groom", async () => {
    const day = await invoke(db, owner, "groomingDay", { day: todayIso() });
    expect(day.appointments.find((a) => a.id === biscuit)!.lastNote).toBe(
      "Short summer cut. A little matted behind the ears; brush there weekly.",
    );
  });
});

describe("the pet's grooming history", () => {
  it("lists grooms newest first with notes and photos, 10 at a time", async () => {
    const pet = (await invoke(db, owner, "getCustomer", { id: sampleCustomer })).pets[0]!;
    const first = await invoke(db, cashier, "petGroomingHistory", { petId: pet.id });
    expect(first.grooms.map((g) => g.status)).toEqual(["checked_in", "done"]);
    expect(first.grooms[1]!.notes[0]!.photos.map((p) => p.kind)).toEqual(["before", "after"]);
    expect(first.next).toBeNull();

    // Ten more past grooms: eleven done in all.
    const a = await withBusiness(db, businessId, (trx) =>
      trx.selectFrom("appointments").selectAll().where("id", "=", biscuit).executeTakeFirstOrThrow(),
    );
    for (let i = 30; i < 40; i++) {
      const d = addDays(todayIso(), -i);
      await db
        .insertInto("appointments")
        .values({
          business_id: businessId,
          location_id: a.location_id,
          customer_id: a.customer_id,
          pet_id: a.pet_id,
          staff_id: a.staff_id,
          service_id: a.service_id,
          service_name: a.service_name,
          pet_name: a.pet_name,
          size: "M",
          starts_at: atLocal(d, 600),
          ends_at: atLocal(d, 660),
          block_ends_at: atLocal(d, 660),
          status: "done",
          price_cents: 7000,
        })
        .execute();
    }
    const p1 = await invoke(db, cashier, "petGroomingHistory", { petId: pet.id });
    expect(p1.grooms).toHaveLength(10);
    const p2 = await invoke(db, cashier, "petGroomingHistory", { petId: pet.id, before: p1.next });
    expect(p2.grooms).toHaveLength(2);
    expect(p2.next).toBeNull();
  });
});

describe("separation between businesses", () => {
  it("can't see or check out another store's grooms", async () => {
    const other = await insertBusiness(db, "other-store");
    await db.insertInto("locations").values({ business_id: other, name: "Other" }).execute();
    const st = await db
      .insertInto("staff")
      .values({ business_id: other, name: "O", role: "owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const o: Ctx = { businessId: other, staffId: st.id, role: "owner" };
    expect(await invoke(db, o, "groomsToCheckOut", { customerId: sampleCustomer })).toEqual([]);
    expect(await invoke(db, o, "appointmentNotes", { appointmentId: biscuit })).toEqual([]);
    await expect(invoke(db, o, "startCheckout", ticket())).rejects.toThrow(/doesn't exist anymore/);
  });
});
