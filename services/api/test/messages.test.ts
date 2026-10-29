import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { addDays, atLocal, todayIso, type Ctx } from "@pet-pos/core";
import { ensureDemo, listDemoStaff, withBusiness, type DB } from "@pet-pos/db";
import { createTestDb, insertBusiness } from "@pet-pos/db/test-db";
import { sendDueMessages } from "../src/messages.ts";
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
let sample: string;
let catParent: string;
let family: string;

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
  const id = async (phone: string) => (await invoke(db, owner, "lookupByPhone", { phone }))!.id;
  [sample, catParent, family] = [await id("2125550100"), await id("2125550101"), await id("2125550102")];
});

function pub<N extends PublicName>(name: N, input: PublicInput<N>, token: string | null = null) {
  return invokePublic(db, { businessId, token, demo: true }, name, input) as Promise<PublicOutput<N>>;
}

async function signIn(contact: string): Promise<string> {
  const sent = await pub("requestCode", { contact });
  const r = await pub("verifyCode", { contact, code: sent.demoCode! });
  if (r.status !== "signed_in") throw new Error("not signed in");
  return r.token;
}

const q = <T>(run: (trx: Parameters<Parameters<typeof withBusiness>[2]>[0]) => Promise<T>) =>
  withBusiness(db, businessId, run);

const messages = (kind?: string) =>
  q((trx) => {
    let x = trx
      .selectFrom("appointment_messages as m")
      .innerJoin("appointments as a", "a.id", "m.appointment_id")
      .select([
        "m.kind",
        "m.channel",
        "m.to_address",
        "m.subject",
        "m.body",
        "a.pet_name",
        "m.appointment_id",
      ]);
    if (kind) x = x.where("m.kind", "=", kind as never);
    return x.orderBy("m.created_at").execute();
  });

const sweep = (at: Date) => q((trx) => sendDueMessages(trx, businessId, at));

/** Today at 10:30 AM: after the 10:00 reminder time, inside sending hours. */
const midMorning = () => atLocal(todayIso(), 10 * 60 + 30);

async function petOf(customerId: string, name: string) {
  return (await invoke(db, owner, "getCustomer", { id: customerId })).pets.find((p) => p.name === name)!.id;
}

async function book(customerId: string, pet: string, day = tue, start = "09:00", confirm?: boolean) {
  return invoke(db, cashier, "bookAppointment", {
    customerId,
    petId: await petOf(customerId, pet),
    serviceId: svc.Bath!,
    addonIds: [],
    staffId: A,
    day,
    start,
    ...(confirm === undefined ? {} : { confirm }),
    size: "S" as const,
    override: true,
  });
}

describe("booking confirmations", () => {
  it("texts an opted-in customer once, says how to stop the first time, and can be skipped", async () => {
    const a = await book(sample, "Biscuit");
    expect(a.confirmation).toMatchObject({ sent: { channel: "sms", to: "2125550100" } });
    const [m] = await messages("confirm");
    expect(m!.body).toMatch(
      /^Sample Pet Store \(DEMO\): Biscuit's Sample Bath & brush \(DEMO\) is booked for .* at 9:00 AM with Sample Groomer \(DEMO\)\. Manage it: petpos-demo\.prismcortex\.net\/book Reply STOP to opt out\.$/,
    );
    const b = await book(sample, "Biscuit", addDays(tue, 1));
    expect("sent" in b.confirmation! && b.confirmation.sent.body).not.toMatch(/STOP/);
    const c = await book(sample, "Biscuit", addDays(tue, 2), "09:00", false);
    expect(c.confirmation).toBeNull();
    expect(c.reach).toEqual({ channel: "sms", to: "2125550100" });
  });

  it("sends nothing to a customer who can't be reached, and says why", async () => {
    const a = await book(catParent, "Mo");
    expect(a.confirmation).toEqual({ skipped: "this customer hasn't agreed to texts and has no email" });
    expect(a.reach).toEqual({ none: "this customer hasn't agreed to texts and has no email" });
    expect(await messages("confirm")).toEqual([]);
  });

  it("emails when the customer prefers it, and confirms a held online booking only once paid", async () => {
    const p = await invoke(db, owner, "getCustomer", { id: sample });
    await invoke(db, owner, "saveCustomer", {
      id: sample,
      customer: {
        name: p.name,
        phone: p.phone ?? "",
        email: p.email ?? "",
        street: p.street ?? "",
        city: p.city ?? "",
        state: p.state ?? "",
        zip: p.zip ?? "",
        birthday: p.birthday ?? "",
        smsOptIn: p.smsOptIn,
        notes: p.notes ?? "",
      },
      pets: p.pets.map((x) => ({
        id: x.id,
        name: x.name,
        species: x.species,
        breed: x.breed ?? "",
        birthday: x.birthday ?? "",
      })),
      messages: { contactPref: "email", nudgesOff: false, emailOff: false },
    });
    const token = await signIn("2125550100");
    const biscuit = (await pub("myAccount", undefined, token)).pets.find((x) => x.name === "Biscuit")!;
    const held = await pub(
      "bookOnline",
      { petId: biscuit.id, serviceId: svc.Full!, addonIds: [], staffId: A, day: tue, start: 540 },
      token,
    );
    expect(await messages("confirm")).toEqual([]);
    await pub("simulateDepositPayment", { id: held.deposit!.id, outcome: "paid" }, token);
    const [m] = await messages("confirm");
    expect(m).toMatchObject({
      channel: "email",
      to_address: "customer.demo@example.com",
      subject: "Sample Pet Store (DEMO): Biscuit's groom is booked",
    });
    expect(m!.body).toContain("$20.00 deposit paid.");
  });
});

describe("the sweep", () => {
  it("sends tomorrow's reminder and a due rebook nudge once, however often it runs", async () => {
    const r = await sweep(midMorning());
    expect(r).toEqual({ reminders: 1, nudges: 1, skipped: 0, quiet: false });
    expect(await sweep(midMorning())).toEqual({ reminders: 0, nudges: 0, skipped: 0, quiet: false });
    const all = await messages();
    expect(all.map((m) => [m.kind, m.pet_name])).toEqual(
      expect.arrayContaining([
        ["reminder", "Biscuit"],
        ["nudge", "Clover"],
      ]),
    );
    const nudge = all.find((m) => m.kind === "nudge")!;
    expect(nudge.body).toMatch(
      /^Sample Pet Store \(DEMO\): it's been 4 weeks since Clover's last groom\. Book the next one: petpos-demo\.prismcortex\.net\/book\?pet=.*&service=/,
    );
  });

  it("waits out quiet hours, and before the reminder time", async () => {
    expect(await sweep(atLocal(todayIso(), 21 * 60))).toMatchObject({ quiet: true, reminders: 0 });
    expect((await sweep(atLocal(todayIso(), 9 * 60 + 30))).reminders).toBe(0);
  });

  it("skips canceled grooms, pets already rebooked, nudges turned off, and recent nudges", async () => {
    const day = await invoke(db, owner, "groomingDay", { day: addDays(todayIso(), 1) });
    await invoke(db, cashier, "cancelAppointment", {
      id: day.appointments.find((a) => a.petName === "Biscuit")!.id,
    });
    await book(family, "Clover", tue);
    const r = await sweep(midMorning());
    expect(r).toMatchObject({ reminders: 0, nudges: 0 });

    // Clover's new booking canceled: the nudge is due again, unless nudges are off.
    const rexAppt = (await invoke(db, owner, "customerAppointments", { customerId: family })).find(
      (a) => a.petName === "Clover",
    )!;
    await invoke(db, cashier, "cancelAppointment", { id: rexAppt.id });
    await q((trx) =>
      trx.updateTable("customers").set({ nudges_off: true }).where("id", "=", family).execute(),
    );
    expect(await sweep(midMorning())).toMatchObject({ nudges: 0, skipped: 1 });
    await q((trx) =>
      trx.updateTable("customers").set({ nudges_off: false }).where("id", "=", family).execute(),
    );
    expect((await sweep(midMorning())).nudges).toBe(1);
    // A later finished groom for Clover is due too, but not within 14 days of the last nudge.
    const d = await db
      .selectFrom("appointments")
      .selectAll()
      .where("pet_name", "=", "Clover")
      .where("status", "=", "done")
      .executeTakeFirstOrThrow();
    const later = atLocal(addDays(todayIso(), -30), 11 * 60);
    await db
      .insertInto("appointments")
      .values({
        business_id: d.business_id,
        location_id: d.location_id,
        customer_id: d.customer_id,
        pet_id: d.pet_id,
        staff_id: d.staff_id,
        service_id: d.service_id,
        service_name: d.service_name,
        pet_name: d.pet_name,
        size: d.size,
        status: "done",
        price_cents: d.price_cents,
        starts_at: later,
        ends_at: new Date(later.getTime() + 75 * 60000),
        block_ends_at: new Date(later.getTime() + 90 * 60000),
        done_at: new Date(later.getTime() + 75 * 60000),
      })
      .execute();
    expect((await sweep(midMorning())).nudges).toBe(0);
    await db
      .updateTable("appointment_messages")
      .set({ created_at: new Date(Date.now() - 15 * 86_400_000) })
      .where("kind", "=", "nudge")
      .execute();
    expect((await sweep(midMorning())).nudges).toBe(1);
  });

  it("is turned off in Settings", async () => {
    const s = await invoke(db, owner, "getSettings", undefined);
    await invoke(db, owner, "updateSettings", {
      name: s.name,
      brandColor: s.brandColor,
      logo: s.logo,
      locationName: s.locationName,
      taxPercent: "7",
      astroDiscountsBeforeTax: s.astroDiscountsBeforeTax,
      messages: { ...s.messages, remindOn: false, nudgeOn: false },
    });
    expect(await sweep(midMorning())).toMatchObject({ reminders: 0, nudges: 0 });
    await expect(
      invoke(db, owner, "updateSettings", {
        name: s.name,
        brandColor: s.brandColor,
        logo: s.logo,
        locationName: s.locationName,
        taxPercent: "7",
        astroDiscountsBeforeTax: s.astroDiscountsBeforeTax,
        messages: { ...s.messages, remindMinute: 6 * 60 },
      }),
    ).rejects.toThrow(/between 9:00 AM and 8:00 PM/);
  });
});

describe("opt-outs", () => {
  it("the ready text honors the text opt-in", async () => {
    const day = await invoke(db, owner, "groomingDay", { day: todayIso() });
    const mo = day.appointments.find((a) => a.petName === "Mo")!;
    for (const status of ["checked_in", "in_progress", "ready"] as const)
      await invoke(db, owner, "setAppointmentStatus", { id: mo.id, status });
    expect((await messages("ready")).length).toBe(0);
  });

  it("unsubscribes from a nudge email's link, for that customer only", async () => {
    await q((trx) =>
      trx.updateTable("customers").set({ contact_pref: "email" }).where("id", "=", family).execute(),
    );
    await sweep(midMorning());
    const nudge = (await messages("nudge"))[0]!;
    expect(nudge.channel).toBe("email");
    const token = /unsubscribe\?t=([0-9a-f]+)/.exec(nudge.body)![1]!;
    await expect(pub("unsubscribe", { token: "0".repeat(48), what: "nudges" })).rejects.toThrow(
      /doesn't work/,
    );
    expect(await pub("unsubscribe", { token, what: "email" })).toEqual({
      storeName: "Sample Pet Store (DEMO)",
      off: "email",
    });
    const fam = await invoke(db, owner, "getCustomer", { id: family });
    expect(fam.messages).toMatchObject({ emailOff: true, nudgesOff: false });
    expect((await invoke(db, owner, "getCustomer", { id: sample })).messages.emailOff).toBe(false);
  });

  it("customers change their own settings online, and turning texts on is recorded", async () => {
    const token = await signIn("family.demo@example.com");
    await pub(
      "saveMyMessageSettings",
      { smsOptIn: false, contactPref: "email", nudgesOff: true, emailOff: false },
      token,
    );
    let fam = await invoke(db, owner, "getCustomer", { id: family });
    expect(fam).toMatchObject({ smsOptIn: false, smsOptInAt: null });
    await pub(
      "saveMyMessageSettings",
      { smsOptIn: true, contactPref: "text", nudgesOff: false, emailOff: false },
      token,
    );
    fam = await invoke(db, owner, "getCustomer", { id: family });
    expect(fam).toMatchObject({ smsOptIn: true, smsOptInSource: "online" });
    expect(fam.smsOptInAt).not.toBeNull();
    const mo = await signIn("2125550101");
    await expect(
      pub(
        "saveMyMessageSettings",
        { smsOptIn: false, contactPref: "email", nudgesOff: false, emailOff: false },
        mo,
      ),
    ).rejects.toThrow(/no email on your account/);
  });
});

describe("the Messages view", () => {
  it("lists messages by day and kind, runs the sweep, and keeps stores apart", async () => {
    await book(sample, "Biscuit");
    const today = todayIso();
    const all = await invoke(db, cashier, "listMessages", { from: today, to: today });
    expect(all[0]).toMatchObject({
      kind: "confirm",
      petName: "Biscuit",
      customerName: "Sample Customer (DEMO)",
    });
    expect(await invoke(db, cashier, "listMessages", { from: today, to: today, kind: "nudge" })).toEqual([]);
    const other = await insertBusiness(db, "other-store");
    const seen = await withBusiness(db, other, (trx) =>
      trx.selectFrom("appointment_messages").select("id").execute(),
    );
    expect(seen).toEqual([]);
  });
});
