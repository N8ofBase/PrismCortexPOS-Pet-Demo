import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { addDays, atLocal, todayIso, type Ctx } from "@pet-pos/core";
import { ensureDemo, listDemoStaff, withBusiness, type DB } from "@pet-pos/db";
import { createTestDb, insertBusiness } from "@pet-pos/db/test-db";
import type { BookingInput } from "../src/handlers/grooming.ts";
import { invoke } from "../src/registry.ts";

let db: Kysely<DB>;
let businessId: string;
let owner: Ctx;
let cashier: Ctx;
let groomer: Ctx;
let A: string;
let B: string;
let svc: Record<string, string>;
let pets: Record<string, { id: string; customerId: string }>;

/** The next Tuesday at least two days out: both sample groomers work Tuesdays. */
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
  const ctx = (role: Ctx["role"]): Ctx => ({
    businessId,
    role,
    staffId: staff.find((s) => s.role === role)!.id,
  });
  owner = ctx("owner");
  cashier = ctx("cashier");
  groomer = ctx("groomer");
  const g = await invoke(db, owner, "listGroomers", {});
  A = g.find((x) => x.name === "Sample Groomer (DEMO)")!.staffId;
  B = g.find((x) => x.name === "Sample Groomer B (DEMO)")!.staffId;
  svc = Object.fromEntries(
    (await invoke(db, owner, "listServices", {})).map((s) => [s.name.split(" ")[1], s.id]),
  );
  const all = await withBusiness(db, businessId, (trx) =>
    trx.selectFrom("pets").select(["id", "name", "customer_id"]).execute(),
  );
  pets = Object.fromEntries(all.map((p) => [p.name, { id: p.id, customerId: p.customer_id }]));
});

const book = (pet: string, over: Partial<BookingInput> = {}) =>
  invoke(db, cashier, "bookAppointment", {
    customerId: pets[pet]!.customerId,
    petId: pets[pet]!.id,
    serviceId: svc.Full!,
    addonIds: [],
    staffId: A,
    day: tue,
    start: "09:00",
    override: true,
    ...over,
  });
const messages = (appointmentId: string) => invoke(db, owner, "appointmentMessages", { appointmentId });

describe("moving an appointment", () => {
  it("keeps the price and services, refuses clashes, and can be undone", async () => {
    const a = await book("Biscuit", { addonIds: [svc.Teeth!] });
    const r = await invoke(db, cashier, "moveAppointment", {
      id: a.id,
      staffId: B,
      day: tue,
      start: 11 * 60,
    });
    expect(r.appointment).toMatchObject({
      staffId: B,
      start: 660,
      end: 790,
      priceCents: 8000,
      label: a.label,
    });
    expect(r).toMatchObject({ from: { staffId: A, day: tue, start: 540 }, timeChanged: true });

    const rex = await book("Rex", { staffId: B, start: "14:00", serviceId: svc.Bath! });
    await expect(
      invoke(db, cashier, "moveAppointment", { id: rex.id, staffId: B, day: tue, start: 12 * 60 }),
    ).rejects.toThrow(
      "Sample Groomer B (DEMO) already has Biscuit at 11:00 AM. Pick another time or groomer.",
    );

    // Undo: back where it was.
    const back = await invoke(db, cashier, "moveAppointment", { ...r.from, id: a.id, override: true });
    expect(back.appointment).toMatchObject({ staffId: A, start: 540 });
    // A groomer swap alone doesn't change the time.
    expect(
      (
        await invoke(db, cashier, "moveAppointment", {
          id: a.id,
          staffId: B,
          day: tue,
          start: 540,
          override: true,
        })
      ).timeChanged,
    ).toBe(false);
  });

  it("needs Move anyway for warnings, and won't move a started groom", async () => {
    const a = await book("Biscuit");
    // Groomer A works until 4: a 2-hour groom at 3 runs past.
    const err = await invoke(db, cashier, "moveAppointment", {
      id: a.id,
      staffId: A,
      day: tue,
      start: 15 * 60,
    }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/outside Sample Groomer \(DEMO\)'s hours.*Move it anyway\?/);
    expect((err as { fields?: Record<string, string> }).fields?.warnings).toBeTruthy();
    await invoke(db, cashier, "moveAppointment", {
      id: a.id,
      staffId: A,
      day: tue,
      start: 15 * 60,
      override: true,
    });

    await invoke(db, cashier, "setAppointmentStatus", { id: a.id, status: "checked_in" });
    await invoke(db, groomer, "setAppointmentStatus", { id: a.id, status: "in_progress" });
    await expect(
      invoke(db, cashier, "moveAppointment", { id: a.id, staffId: A, day: tue, start: 600 }),
    ).rejects.toThrow(/has started/);
    await expect(
      invoke(db, groomer, "moveAppointment", { id: a.id, staffId: A, day: tue, start: 600 }),
    ).rejects.toThrow(/permission/);
  });

  it("texts the customer a moved or canceled preview", async () => {
    const a = await book("Biscuit");
    const t = await invoke(db, cashier, "textAppointment", { id: a.id, kind: "moved" });
    expect(t).toMatchObject({ kind: "moved", to: "2125550100", status: "preview" });
    expect(t.body).toMatch(
      /^Sample Pet Store \(DEMO\): Biscuit's groom is now \w{3} \w{3} \d+ at 9:00 AM with Sample Groomer \(DEMO\)\./,
    );
    await db
      .updateTable("customers")
      .set({ sms_opt_in: false, email: null })
      .where("id", "=", pets.Biscuit!.customerId)
      .execute();
    await expect(invoke(db, cashier, "textAppointment", { id: a.id, kind: "canceled" })).rejects.toThrow(
      "Nothing was sent: this customer hasn't agreed to texts and has no email.",
    );
  });
});

describe("a groomer calls out", () => {
  it("suggests who's free and applies moves, cancels, time off and texts together", async () => {
    const biscuit = await book("Biscuit");
    const mo = await book("Mo", { start: "13:00", serviceId: svc.Bath! });
    const juno = await book("Juno", { start: "15:00", serviceId: svc.Bath! });
    const preview = await invoke(db, cashier, "calloutPreview", { staffId: A, day: tue });
    // Groomer B starts at 10, so 9:00 needs a new time; B is free at 1:00 and 3:00.
    expect(preview.map((r) => [r.appointment.petName, r.suggestion?.name ?? null])).toEqual([
      ["Biscuit", null],
      ["Mo", "Sample Groomer B (DEMO)"],
      ["Juno", "Sample Groomer B (DEMO)"],
    ]);

    const res = await invoke(db, cashier, "applyCallout", {
      staffId: A,
      day: tue,
      notify: true,
      addTimeOff: true,
      changes: [
        { id: biscuit.id, action: "move", staffId: B, start: 10 * 60 },
        { id: mo.id, action: "move", staffId: B },
        { id: juno.id, action: "cancel" },
      ],
    });
    // Mo's owner hasn't agreed to texts and has no email, so two go out.
    expect(res).toEqual({ moved: 2, canceled: 1, left: 0, texts: 2 });
    const day = await invoke(db, owner, "groomingDay", { day: tue });
    expect(day.appointments.filter((a) => a.staffId === B).map((a) => [a.petName, a.start])).toEqual([
      ["Biscuit", 600],
      ["Mo", 780],
    ]);
    expect(day.groomers.find((g) => g.staffId === A)!.timeOff).toEqual([
      { start: 0, end: 1440, note: "Called out" },
    ]);
    expect((await messages(juno.id)).map((m) => m.kind)).toEqual(["confirm", "canceled"]);
    const log = await withBusiness(db, businessId, (trx) =>
      trx.selectFrom("audit_log").select("after").where("action", "=", "grooming.callout").execute(),
    );
    expect(log).toHaveLength(1);
    expect(log[0]!.after).toMatchObject({
      groomer: "Sample Groomer (DEMO)",
      day: tue,
      moved: 2,
      canceled: 1,
    });
  });

  it("changes nothing when one move clashes", async () => {
    const biscuit = await book("Biscuit");
    const mo = await book("Mo", { start: "13:00", serviceId: svc.Bath! });
    // Biscuit to B at 12:30 runs past 1:00, where Mo is also going.
    await expect(
      invoke(db, cashier, "applyCallout", {
        staffId: A,
        day: tue,
        notify: true,
        addTimeOff: true,
        changes: [
          { id: mo.id, action: "move", staffId: B },
          { id: biscuit.id, action: "move", staffId: B, start: 12 * 60 + 30 },
        ],
      }),
    ).rejects.toThrow(/Biscuit: .*already has Mo.*Nothing was changed/);
    const day = await invoke(db, owner, "groomingDay", { day: tue });
    expect(day.appointments.every((a) => a.staffId === A)).toBe(true);
    expect(day.groomers.find((g) => g.staffId === A)!.timeOff).toEqual([]);
    expect(await messages(mo.id)).toEqual([]);
  });
});

describe("ready-for-pickup text", () => {
  it("is saved once, and not without a phone or with the setting off", async () => {
    const a = await book("Biscuit");
    const go = async (id: string) => {
      await invoke(db, cashier, "setAppointmentStatus", { id, status: "checked_in" });
      await invoke(db, groomer, "setAppointmentStatus", { id, status: "in_progress" });
      await invoke(db, groomer, "setAppointmentStatus", { id, status: "ready" });
    };
    await go(a.id);
    await invoke(db, groomer, "setAppointmentStatus", { id: a.id, status: "in_progress" });
    await invoke(db, groomer, "setAppointmentStatus", { id: a.id, status: "ready" });
    expect(
      (await messages(a.id)).filter((m) => m.kind === "ready").map((m) => [m.kind, m.to, m.body]),
    ).toEqual([["ready", "2125550100", "Sample Pet Store (DEMO): Biscuit is ready for pickup!"]]);

    const set = await invoke(db, owner, "getSettings", undefined);
    expect(set.textWhenReady).toBe(true);
    await invoke(db, owner, "updateSettings", {
      name: set.name,
      brandColor: set.brandColor,
      logo: set.logo,
      locationName: set.locationName,
      taxPercent: "7",
      astroDiscountsBeforeTax: set.astroDiscountsBeforeTax,
      textWhenReady: false,
    });
    const mo = await book("Mo", { start: "13:00", serviceId: svc.Bath! });
    await go(mo.id);
    expect(await messages(mo.id)).toEqual([]);
  });
});

describe("grooming revenue by groomer", () => {
  it("adds up paid grooms net of refunds, and counts no-shows", async () => {
    const today = await invoke(db, owner, "groomingDay", { day: todayIso() });
    const biscuit = today.appointments.find((a) => a.petName === "Biscuit")!;
    const mo = today.appointments.find((a) => a.petName === "Mo")!;
    const s = await invoke(db, cashier, "startCheckout", {
      customerId: biscuit.customerId,
      lines: [{ key: "g", appointmentId: biscuit.id, qty: 1, applyOffer: false }],
      rewards: [],
      discounts: [],
    });
    await invoke(db, cashier, "payCash", {
      saleId: s.saleId,
      amountCents: s.totalCents - s.depositCents,
      tenderedCents: s.totalCents - s.depositCents,
    });
    await invoke(db, cashier, "setAppointmentStatus", { id: mo.id, status: "no_show" });
    const from = atLocal(todayIso(), 0).toISOString();
    const to = atLocal(addDays(todayIso(), 1), 0).toISOString();
    let day = await invoke(db, owner, "listSales", { from, to });
    expect(day.grooming).toEqual([
      {
        staffId: biscuit.staffId,
        name: "Sample Groomer (DEMO)",
        grooms: 1,
        salesCents: 8000,
        refundCents: 0,
      },
    ]);
    expect(day.noShows).toBe(1);

    const line = (await invoke(db, owner, "getSale", { id: s.saleId })).lines[0]!.id;
    await invoke(db, owner, "refundSale", {
      saleId: s.saleId,
      lines: [{ saleLineId: line, qty: 1 }],
      restock: false,
      reason: "changed_mind",
    });
    day = await invoke(db, owner, "listSales", { from, to });
    expect(day.grooming[0]).toMatchObject({ grooms: 1, salesCents: 0, refundCents: 8000 });
  });
});

describe("week view", () => {
  it("returns Monday to Sunday with each day's groomers and appointments", async () => {
    await book("Biscuit");
    await invoke(db, owner, "addTimeOff", {
      staffId: B,
      startsAt: atLocal(tue, 0).toISOString(),
      endsAt: atLocal(addDays(tue, 1), 0).toISOString(),
      note: "Vacation",
    });
    const w = await invoke(db, cashier, "groomingWeek", { start: addDays(tue, 1) });
    expect(w.start).toBe(addDays(tue, -1));
    expect(w.days.map((d) => d.day)).toHaveLength(7);
    const t = w.days[1]!;
    expect(t.day).toBe(tue);
    expect(t.appointments.map((a) => a.petName)).toEqual(["Biscuit"]);
    expect(t.groomers.find((g) => g.staffId === B)!.timeOff[0]).toMatchObject({ note: "Vacation" });
    // Groomer B doesn't work Mondays.
    expect(w.days[0]!.groomers.map((g) => g.staffId)).not.toContain(B);
  });
});

describe("separation between businesses", () => {
  it("can't see or move another store's appointments", async () => {
    const a = await book("Biscuit");
    const other = await insertBusiness(db, "other-store");
    await db.insertInto("locations").values({ business_id: other, name: "Other" }).execute();
    const st = await db
      .insertInto("staff")
      .values({ business_id: other, name: "O", role: "owner", grooms: true })
      .returning("id")
      .executeTakeFirstOrThrow();
    const o: Ctx = { businessId: other, staffId: st.id, role: "owner" };
    expect((await invoke(db, o, "groomingWeek", { start: tue })).days.flatMap((d) => d.appointments)).toEqual(
      [],
    );
    await expect(
      invoke(db, o, "moveAppointment", { id: a.id, staffId: st.id, day: tue, start: 600 }),
    ).rejects.toThrow(/doesn't exist/);
    expect(await invoke(db, o, "appointmentMessages", { appointmentId: a.id })).toEqual([]);
  });
});
