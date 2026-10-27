import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { addDays, todayIso, type Ctx } from "@pet-pos/core";
import { ensureDemo, listDemoStaff, withBusiness, type DB } from "@pet-pos/db";
import { createTestDb, insertBusiness } from "@pet-pos/db/test-db";
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

describe("the booking page", () => {
  it("shows the store, the online menu and the groomers", async () => {
    const p = await pub("bookingPage", undefined);
    expect(p).toMatchObject({
      storeName: "Sample Pet Store (DEMO)",
      enabled: true,
      phone: "2125550199",
      cutoffHours: 24,
    });
    expect(p.services.map((s) => [s.name, s.kind])).toEqual([
      ["Sample Full groom (DEMO)", "main"],
      ["Sample Bath & brush (DEMO)", "main"],
      ["Sample Teeth brushing (DEMO)", "addon"],
    ]);
    expect(p.groomers.map((g) => g.name)).toEqual(["Sample Groomer (DEMO)", "Sample Groomer B (DEMO)"]);
  });
});

describe("signing in with a one-time code", () => {
  it("signs in a known customer by phone; the code is only shown in the demo", async () => {
    const sent = await pub("requestCode", { contact: "(212) 555-0100" });
    expect(sent.sentTo).toBe("a text to (212) 555-0100");
    expect(sent.demoCode).toMatch(/^\d{6}$/);
    const r = await pub("verifyCode", { contact: "2125550100", code: sent.demoCode! });
    expect(r).toMatchObject({ status: "signed_in", name: "Sample Customer (DEMO)" });
    const hosted = await invokePublic(db, { businessId, token: null, demo: false }, "requestCode", {
      contact: "family.demo@example.com",
    });
    expect(hosted).toEqual({ sentTo: "an email to family.demo@example.com" });
    // Only hashes are stored.
    const rows = await withBusiness(db, businessId, (trx) =>
      trx.selectFrom("customer_login_codes").select("code_hash").execute(),
    );
    expect(rows.every((x) => x.code_hash.length === 64 && x.code_hash !== sent.demoCode)).toBe(true);
  });

  it("signs up a new customer by email after asking their name", async () => {
    const sent = await pub("requestCode", { contact: "Pat@Example.com" });
    expect(await pub("verifyCode", { contact: "pat@example.com", code: sent.demoCode! })).toEqual({
      status: "needs_name",
    });
    const r = await pub("verifyCode", {
      contact: "pat@example.com",
      code: sent.demoCode!,
      name: " Pat Lee ",
    });
    expect(r).toMatchObject({ status: "signed_in", name: "Pat Lee" });
    const c = await invoke(db, owner, "searchCustomers", { q: "Pat Lee" });
    expect(c[0]).toMatchObject({ email: "pat@example.com", phone: null });
  });

  it("refuses wrong, used and expired codes, too many tries, and too many requests", async () => {
    await expect(pub("requestCode", { contact: "555-0100" })).rejects.toThrow(/10-digit/);
    const sent = await pub("requestCode", { contact: "2125550100" });
    await expect(pub("requestCode", { contact: "2125550100" })).rejects.toThrow(/Wait a minute/);
    const wrong = sent.demoCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++)
      expect(await pub("verifyCode", { contact: "2125550100", code: wrong })).toMatchObject({
        status: "wrong",
      });
    await expect(pub("verifyCode", { contact: "2125550100", code: sent.demoCode! })).rejects.toThrow(
      /Too many tries/,
    );

    const other = await pub("requestCode", { contact: "2125550101" });
    await db
      .updateTable("customer_login_codes")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("contact", "=", "2125550101")
      .execute();
    await expect(pub("verifyCode", { contact: "2125550101", code: other.demoCode! })).rejects.toThrow(
      /expired/,
    );

    await db
      .updateTable("customer_login_codes")
      .set({ created_at: new Date(Date.now() - 5 * 60_000) })
      .execute();
    const t = await pub("requestCode", { contact: "2125550102" });
    await pub("verifyCode", { contact: "2125550102", code: t.demoCode! });
    await expect(pub("verifyCode", { contact: "2125550102", code: t.demoCode! })).rejects.toThrow(
      /isn't right/,
    );
  });

  it("needs a valid session for the customer's own data, and signs out", async () => {
    await expect(pub("myAccount", undefined)).rejects.toThrow(/sign in again/);
    await expect(pub("myAccount", undefined, "made-up-token")).rejects.toThrow(/sign in again/);
    const token = await signIn("2125550100");
    expect((await pub("myAccount", undefined, token)).name).toBe("Sample Customer (DEMO)");
    await pub("signOut", { token });
    await expect(pub("myAccount", undefined, token)).rejects.toThrow(/sign in again/);
  });
});

describe("booking online", () => {
  it("offers open times that can be booked, lands on the calendar, and won't double-book", async () => {
    const token = await signIn("2125550100");
    const acct = await pub("myAccount", undefined, token);
    const biscuit = acct.pets.find((p) => p.name === "Biscuit")!;
    const days = await pub(
      "openTimes",
      { petId: biscuit.id, serviceId: svc.Bath!, addonIds: [], staffId: A, from: tue, days: 1 },
      token,
    );
    // Groomer A works 8–4 Tuesdays; a 75-minute bath (M) plus 15 buffer, every 30 minutes.
    expect(days[0]!.times[0]).toBe(480);
    expect(days[0]!.times.at(-1)).toBe(16 * 60 - 90);

    const booked = await pub(
      "bookOnline",
      {
        petId: biscuit.id,
        serviceId: svc.Bath!,
        addonIds: [svc.Teeth!],
        staffId: A,
        day: tue,
        start: 600,
        notes: "Short nails",
      },
      token,
    );
    expect(booked).toMatchObject({
      petName: "Biscuit",
      start: 600,
      priceCents: 4500 + 1000,
      groomerName: "Sample Groomer (DEMO)",
      canChange: true,
    });
    const cal = await invoke(db, owner, "groomingDay", { day: tue });
    expect(cal.appointments.find((a) => a.id === booked.id)).toMatchObject({
      source: "online",
      notes: "Short nails",
    });

    // The slot is gone for the next customer.
    const family = await signIn("2125550102");
    const rex = (await pub("myAccount", undefined, family)).pets.find((p) => p.name === "Rex")!;
    const again = await pub(
      "openTimes",
      { petId: rex.id, serviceId: svc.Bath!, addonIds: [], staffId: A, from: tue, days: 1 },
      family,
    );
    expect(again[0]!.times).not.toContain(600);
    await expect(
      pub(
        "bookOnline",
        { petId: rex.id, serviceId: svc.Bath!, addonIds: [], staffId: A, day: tue, start: 600 },
        family,
      ),
    ).rejects.toThrow(/isn't open anymore/);
    // Any groomer: Groomer B (no bookings yet) gets it.
    const any = await pub(
      "bookOnline",
      { petId: rex.id, serviceId: svc.Bath!, addonIds: [], staffId: null, day: tue, start: 600 },
      family,
    );
    expect(any.groomerName).toBe("Sample Groomer B (DEMO)");
  });

  it("refuses a lapsed rabies, a pet without a size, too far ahead, and other customers' pets", async () => {
    const cat = await signIn("2125550101");
    const mo = (await pub("myAccount", undefined, cat)).pets.find((p) => p.name === "Mo")!;
    expect(mo.rabiesLapsed).toBe(true);
    await expect(
      pub(
        "bookOnline",
        { petId: mo.id, serviceId: svc.Bath!, addonIds: [], staffId: null, day: tue, start: 660 },
        cat,
      ),
    ).rejects.toThrow("Mo's rabies vaccination has expired. Please call us at (212) 555-0199 to book.");

    const family = await signIn("2125550102");
    const clover = (await pub("myAccount", undefined, family)).pets.find((p) => p.name === "Clover")!;
    await expect(
      pub(
        "openTimes",
        { petId: clover.id, serviceId: svc.Bath!, addonIds: [], staffId: null, from: tue, days: 1 },
        family,
      ),
    ).rejects.toThrow(/Add Clover's size first/);
    const fixed = await pub(
      "savePet",
      { id: clover.id, name: "Clover", species: "other", breed: "Rabbit", size: "S" },
      family,
    );
    expect(fixed.size).toBe("S");

    const far = addDays(todayIso(), 45);
    await expect(
      pub(
        "bookOnline",
        { petId: clover.id, serviceId: svc.Bath!, addonIds: [], staffId: null, day: far, start: 660 },
        family,
      ),
    ).rejects.toThrow(/too far ahead/);
    await expect(
      pub(
        "bookOnline",
        { petId: mo.id, serviceId: svc.Bath!, addonIds: [], staffId: null, day: tue, start: 660 },
        family,
      ),
    ).rejects.toThrow(/Pick one of your pets/);
    await expect(pub("savePet", { id: mo.id, name: "Mo", species: "cat" }, family)).rejects.toThrow(
      /isn't on your account/,
    );
  });

  it("only offers online services and groomers who take online bookings", async () => {
    const token = await signIn("2125550100");
    const biscuit = (await pub("myAccount", undefined, token)).pets[0]!;
    await invoke(db, owner, "saveGroomer", {
      staffId: A,
      grooms: true,
      booksOnline: false,
      hours: [{ weekday: 2, start: "08:00", end: "16:00" }],
    });
    await expect(
      pub(
        "bookOnline",
        { petId: biscuit.id, serviceId: svc.Bath!, addonIds: [], staffId: A, day: tue, start: 480 },
        token,
      ),
    ).rejects.toThrow(/isn't open anymore/);
    const full = (await invoke(db, owner, "listServices", {})).find((s) => s.id === svc.Full)!;
    await invoke(db, owner, "saveService", { ...full, online: false });
    expect((await pub("bookingPage", undefined)).services.map((s) => s.id)).not.toContain(svc.Full);
    await expect(
      pub(
        "openTimes",
        { petId: biscuit.id, serviceId: svc.Full!, addonIds: [], staffId: null, from: tue, days: 1 },
        token,
      ),
    ).rejects.toThrow(/Pick a service/);
  });
});

describe("changing a booking", () => {
  it("cancels and reschedules before the cutoff, and not after", async () => {
    const token = await signIn("2125550100");
    const biscuit = (await pub("myAccount", undefined, token)).pets[0]!;
    const a = await pub(
      "bookOnline",
      { petId: biscuit.id, serviceId: svc.Bath!, addonIds: [], staffId: A, day: tue, start: 600 },
      token,
    );
    const moved = await pub("rescheduleMine", { id: a.id, staffId: A, day: tue, start: 660 }, token);
    expect(moved).toMatchObject({ start: 660, priceCents: a.priceCents });
    // Moving within its own old slot is fine too.
    expect((await pub("rescheduleMine", { id: a.id, staffId: A, day: tue, start: 630 }, token)).start).toBe(
      630,
    );

    // Inside the 24-hour cutoff, but tomorrow, clear of today's demo grooms.
    const soon = new Date(Date.now() + 23 * 3600_000);
    await db
      .updateTable("appointments")
      .set({
        starts_at: soon,
        ends_at: new Date(soon.getTime() + 75 * 60000),
        block_ends_at: new Date(soon.getTime() + 90 * 60000),
      })
      .where("id", "=", a.id)
      .execute();
    await expect(pub("cancelMine", { id: a.id }, token)).rejects.toThrow(
      "It's less than 24 hours away, so it can't be changed online. Please call us at (212) 555-0199.",
    );
    expect((await pub("myAccount", undefined, token)).upcoming.find((x) => x.id === a.id)?.canChange).toBe(
      false,
    );

    const b = await pub(
      "bookOnline",
      { petId: biscuit.id, serviceId: svc.Bath!, addonIds: [], staffId: A, day: addDays(tue, 7), start: 600 },
      token,
    );
    await pub("cancelMine", { id: b.id }, token);
    const day = await invoke(db, owner, "groomingDay", { day: addDays(tue, 7) });
    expect(day.appointments.find((x) => x.id === b.id)).toBeUndefined();
  });

  it("keeps customers out of each other's appointments and the staff handlers", async () => {
    const mine = await signIn("2125550100");
    const biscuit = (await pub("myAccount", undefined, mine)).pets[0]!;
    const a = await pub(
      "bookOnline",
      { petId: biscuit.id, serviceId: svc.Bath!, addonIds: [], staffId: A, day: tue, start: 600 },
      mine,
    );
    const theirs = await signIn("2125550102");
    await expect(pub("cancelMine", { id: a.id }, theirs)).rejects.toThrow(/isn't on your account/);
    expect((await pub("myAccount", undefined, theirs)).upcoming.map((x) => x.id)).not.toContain(a.id);
    await expect(
      invokePublic(
        db,
        { businessId, token: mine, demo: true },
        "deleteCustomer" as PublicName,
        { id: "x" } as never,
      ),
    ).rejects.toThrow(/Unknown action/);
  });
});

describe("settings and separation", () => {
  it("turns online booking off, and keeps stores apart", async () => {
    const set = await invoke(db, owner, "getSettings", undefined);
    expect(set.booking).toMatchObject({
      enabled: true,
      daysAhead: 30,
      cutoffHours: 24,
      stepMinutes: 30,
      phone: "2125550199",
    });
    await invoke(db, owner, "updateSettings", {
      name: set.name,
      brandColor: set.brandColor,
      logo: set.logo,
      locationName: set.locationName,
      taxPercent: "7",
      astroDiscountsBeforeTax: set.astroDiscountsBeforeTax,
      booking: { ...set.booking, enabled: false, phone: "(212) 555-0177" },
    });
    expect((await pub("bookingPage", undefined)).phone).toBe("2125550177");
    const token = await signIn("2125550100");
    const biscuit = (await pub("myAccount", undefined, token)).pets[0]!;
    await expect(
      pub(
        "openTimes",
        { petId: biscuit.id, serviceId: svc.Bath!, addonIds: [], staffId: null, from: tue, days: 1 },
        token,
      ),
    ).rejects.toThrow("Online booking isn't available. Please call us at (212) 555-0177.");

    const other = await insertBusiness(db, "other-store");
    await expect(
      invokePublic(db, { businessId: other, token, demo: true }, "myAccount", undefined),
    ).rejects.toThrow(/sign in again/);
  });
});
