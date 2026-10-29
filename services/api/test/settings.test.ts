import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@pet-pos/core";
import { ensureDemo, listDemoStaff, withBusiness, type DB } from "@pet-pos/db";
import { createTestDb, insertBusiness } from "@pet-pos/db/test-db";
import { invoke } from "../src/registry.ts";

let db: Kysely<DB>;
let owner: Ctx;
let manager: Ctx;
let cashier: Ctx;

beforeEach(async () => {
  ({ db } = await createTestDb());
  const businessId = await ensureDemo(db);
  const staff = await listDemoStaff(db);
  const ctx = (role: Ctx["role"]): Ctx => ({
    businessId,
    role,
    staffId: staff.find((s) => s.role === role)!.id,
  });
  owner = ctx("owner");
  manager = ctx("manager");
  cashier = ctx("cashier");
});

const auditActions = async (action: string) =>
  withBusiness(db, owner.businessId, (trx) =>
    trx.selectFrom("audit_log").select(["action", "before", "after"]).where("action", "=", action).execute(),
  );

const settings = {
  name: "Happy Tails",
  brandColor: "#6b3fd1",
  logo: "data:image/png;base64,iVBORw0KGgo=",
  locationName: "Main St",
  taxPercent: "8.875",
  astroDiscountsBeforeTax: true,
};

describe("store settings", () => {
  it("saves name, color, logo and tax, and audits the tax change", async () => {
    await invoke(db, owner, "updateSettings", settings);
    expect(await invoke(db, manager, "getSettings", undefined)).toMatchObject({
      name: "Happy Tails",
      brandColor: "#6b3fd1",
      logo: settings.logo,
      locationName: "Main St",
      taxRateMpct: 8875,
    });
    const me = await invoke(db, cashier, "me", undefined);
    expect(me.business).toMatchObject({ name: "Happy Tails", logo: settings.logo });
    expect(await auditActions("settings.tax_rate")).toEqual([
      { action: "settings.tax_rate", before: { tax_rate_mpct: 7000 }, after: { tax_rate_mpct: 8875 } },
    ]);

    // Saving again with the same rate isn't another tax change.
    await invoke(db, owner, "updateSettings", { ...settings, name: "Happy Tails Pet Supply" });
    expect(await auditActions("settings.tax_rate")).toHaveLength(1);
  });

  it("explains bad values", async () => {
    await expect(
      invoke(db, owner, "updateSettings", {
        ...settings,
        name: " ",
        brandColor: "purple",
        taxPercent: "8.8755",
      }),
    ).rejects.toMatchObject({
      fields: {
        name: "Store name is required.",
        brandColor: "Pick a color with the color picker.",
        taxPercent: "Enter the sales tax as a percent, like 8.875.",
      },
    });
    await expect(
      invoke(db, owner, "updateSettings", { ...settings, logo: "data:image/svg+xml;base64,AAAA" }),
    ).rejects.toMatchObject({ fields: { logo: "Use a PNG, JPG or WebP image under 200 KB." } });
    await expect(
      invoke(db, owner, "updateSettings", {
        ...settings,
        logo: `data:image/png;base64,${"A".repeat(300_001)}`,
      }),
    ).rejects.toThrow(/under 200 KB/);
  });

  it("removes the logo", async () => {
    await invoke(db, owner, "updateSettings", settings);
    await invoke(db, owner, "updateSettings", { ...settings, logo: null });
    expect((await invoke(db, owner, "getSettings", undefined)).logo).toBeNull();
  });

  it("lets a manager look but not change, and keeps cashiers out", async () => {
    await expect(invoke(db, manager, "updateSettings", settings)).rejects.toThrow(/permission/);
    await expect(invoke(db, cashier, "getSettings", undefined)).rejects.toThrow(/permission/);
  });
});

describe("staff", () => {
  const pat = { name: "Pat Lee", email: "pat@example.com", role: "cashier" as const };

  it("adds staff, who then appear on the demo sign-in screen", async () => {
    await invoke(db, owner, "addStaff", pat);
    const list = await invoke(db, manager, "listStaff", undefined);
    expect(list.find((s) => s.name === "Pat Lee")).toMatchObject({
      email: "pat@example.com",
      role: "cashier",
      active: true,
    });
    const picker = await listDemoStaff(db);
    expect(picker.map((s) => s.name)).toEqual([
      "Sample Owner (DEMO)",
      "Sample Manager (DEMO)",
      "Sample Cashier (DEMO)",
      "Sample Groomer (DEMO)",
      "Sample Groomer B (DEMO)",
      "Pat Lee",
    ]);
  });

  it("refuses a duplicate email, ignoring case", async () => {
    await invoke(db, owner, "addStaff", pat);
    await expect(
      invoke(db, owner, "addStaff", { ...pat, name: "Other", email: "PAT@example.com" }),
    ).rejects.toThrow("Someone on staff already uses that email.");
  });

  it("changes a role and deactivates", async () => {
    const { id } = await invoke(db, owner, "addStaff", pat);
    await invoke(db, owner, "updateStaff", { id, ...pat, role: "manager", active: false });
    const s = (await invoke(db, owner, "listStaff", undefined)).find((x) => x.id === id);
    expect(s).toMatchObject({ role: "manager", active: false });
    expect((await listDemoStaff(db)).some((x) => x.id === id)).toBe(false);
  });

  it("always keeps an active owner, and nobody deactivates themselves", async () => {
    const self = { name: "Sample Owner (DEMO)", email: "owner.demo@example.com", role: "owner" as const };
    await expect(
      invoke(db, owner, "updateStaff", { id: owner.staffId, ...self, active: false }),
    ).rejects.toThrow("You can't deactivate yourself. Ask another owner.");
    await expect(
      invoke(db, owner, "updateStaff", { id: owner.staffId, ...self, role: "manager", active: true }),
    ).rejects.toThrow(/at least one active owner/);

    // With a second owner, the first can step down.
    await invoke(db, owner, "addStaff", { name: "Second Owner", email: "", role: "owner" });
    await invoke(db, owner, "updateStaff", { id: owner.staffId, ...self, role: "manager", active: true });
  });

  it("is for owners only", async () => {
    await expect(invoke(db, manager, "addStaff", pat)).rejects.toThrow(/permission/);
  });
});

describe("remove demo data", () => {
  it("deletes only the sample records, keeps the user's, and the samples don't come back", async () => {
    // The user's own records, including one tied to a sample program.
    const { id: myProgram } = await invoke(db, owner, "saveProgram", {
      name: "My club",
      brand: null,
      buyCount: 10,
      rewardText: "",
    });
    const samples = await invoke(db, owner, "listPrograms", undefined);
    const sampleProgram = samples.find((p) => p.name.endsWith("(DEMO)"))!;
    await invoke(db, owner, "saveProduct", {
      sku: "MINE-1",
      barcode: null,
      name: "My product",
      brand: null,
      category: "Treats",
      priceCents: 500,
      costCents: 0,
      taxClass: "standard",
      reorderAt: 0,
      astroProgramId: sampleProgram.id,
      offerLabel: null,
      offerCents: null,
      openingOnHand: 3,
    });
    const { id: mine } = await invoke(db, owner, "saveCustomer", {
      customer: {
        name: "My customer",
        phone: "2125550160",
        email: "",
        street: "",
        city: "",
        state: "",
        zip: "",
        birthday: "",
        smsOptIn: false,
        notes: "",
      },
      pets: [{ name: "Mine", species: "dog", breed: "", birthday: "" }],
    });
    await db
      .insertInto("astro_punches")
      .values({
        business_id: owner.businessId,
        customer_id: mine,
        program_id: myProgram,
        qty: 4,
        kind: "earn",
      })
      .execute();

    expect(await invoke(db, owner, "demoDataPreview", undefined)).toEqual({
      customers: 3,
      pets: 5,
      products: 7,
      programs: 1,
      punches: 2,
      discounts: 4,
      services: 3,
      appointments: 6,
    });
    await invoke(db, owner, "removeDemoData", undefined);
    expect(await invoke(db, owner, "demoDataPreview", undefined)).toEqual({
      customers: 0,
      pets: 0,
      products: 0,
      programs: 0,
      punches: 0,
      discounts: 0,
      services: 0,
      appointments: 0,
    });

    expect(
      (await invoke(db, owner, "searchCustomers", { q: "" })).map((c) => [c.name, c.punchCards[0]?.balance]),
    ).toEqual([["My customer", 4]]);
    expect(
      (await invoke(db, owner, "listProducts", {})).map((p) => [p.sku, p.onHand, p.astroProgramId]),
    ).toEqual([["MINE-1", 3, null]]);
    expect((await invoke(db, owner, "listPrograms", undefined)).map((p) => p.name)).toEqual(["My club"]);

    // Samples don't reload on the next visit, and the (DEMO) sign-ins still work.
    await ensureDemo(db);
    expect(await invoke(db, owner, "searchCustomers", { q: "" })).toHaveLength(1);
    expect((await invoke(db, owner, "me", undefined)).staff.name).toBe("Sample Owner (DEMO)");
    expect(await listDemoStaff(db)).toHaveLength(5);

    expect(await auditActions("customer.delete")).toHaveLength(3);
    expect(await auditActions("demo.remove")).toEqual([
      {
        action: "demo.remove",
        before: null,
        after: {
          customers: 3,
          pets: 5,
          products: 7,
          programs: 1,
          punches: 2,
          discounts: 4,
          services: 3,
          appointments: 6,
        },
      },
    ]);
  });

  it("is for the owner only, and only touches that store", async () => {
    await expect(invoke(db, manager, "removeDemoData", undefined)).rejects.toThrow(/permission/);

    const other = await insertBusiness(db, "other-store");
    await db
      .insertInto("customers")
      .values({ business_id: other, name: "Other sample", phone: "2125550170", is_demo: true })
      .execute();
    await invoke(db, owner, "removeDemoData", undefined);
    const left = await db.selectFrom("customers").select("name").where("business_id", "=", other).execute();
    expect(left).toEqual([{ name: "Other sample" }]);
  });
});
