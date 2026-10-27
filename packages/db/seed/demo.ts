// Sample records for the demo. Every row is is_demo = true and named "(DEMO)",
// so "Remove all demo data" can find exactly these. Runs as the database owner.
//
// ensureDemo() fills in whatever part is missing, so a browser seeded by an
// earlier version picks up new sample data after an update without a reset.
import type { Kysely, Transaction } from "kysely";
import { addDays, atLocal, isIsoDate, todayIso, type Role } from "@pet-pos/core";
import type { DB } from "../src/schema.ts";

const DEMO_STAFF: { name: string; email: string; role: Role }[] = [
  { name: "Sample Owner (DEMO)", email: "owner.demo@example.com", role: "owner" },
  { name: "Sample Manager (DEMO)", email: "manager.demo@example.com", role: "manager" },
  { name: "Sample Cashier (DEMO)", email: "cashier.demo@example.com", role: "cashier" },
  { name: "Sample Groomer (DEMO)", email: "groomer.demo@example.com", role: "groomer" },
];

export async function hasDemoData(db: Kysely<DB>): Promise<boolean> {
  const row = await db.selectFrom("businesses").select("id").where("is_demo", "=", true).executeTakeFirst();
  return row !== undefined;
}

/** Creates any missing part of the sample store. Returns the demo business id. */
export async function ensureDemo(db: Kysely<DB>): Promise<string> {
  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom("businesses")
      .select("id")
      .where("is_demo", "=", true)
      .executeTakeFirst();
    const businessId = existing?.id ?? (await seedBusiness(trx));
    await once(trx, businessId, "inventory", "products", seedInventory);
    await once(trx, businessId, "customers", "customers", seedCustomers);
    await once(trx, businessId, "discounts", "discounts", seedDiscounts);
    await once(trx, businessId, "grooming", "services", seedGrooming);
    await once(trx, businessId, "grooming_supplies", "service_supplies", seedGroomingSupplies);
    await once(trx, businessId, "deposits", "deposits", seedDeposits);
    return businessId;
  });
}

/**
 * Loads a set of sample data the first time only. A browser seeded before parts were
 * recorded already has the data, so that just gets recorded.
 */
async function once(
  trx: Transaction<DB>,
  businessId: string,
  part: string,
  table: "products" | "customers" | "discounts" | "services" | "service_supplies" | "deposits",
  seed: (trx: Transaction<DB>, businessId: string) => Promise<void>,
): Promise<void> {
  const done = await trx
    .selectFrom("demo_seed_parts")
    .select("part")
    .where("business_id", "=", businessId)
    .where("part", "=", part)
    .executeTakeFirst();
  if (done) return;
  const legacy = await trx
    .selectFrom(table)
    .select("id")
    .where("business_id", "=", businessId)
    .where("is_demo", "=", true)
    .executeTakeFirst();
  if (!legacy) await seed(trx, businessId);
  await trx.insertInto("demo_seed_parts").values({ business_id: businessId, part }).execute();
}

/** Kept for callers from 1a: same as ensureDemo. */
export const seedDemo = ensureDemo;

async function seedBusiness(trx: Transaction<DB>): Promise<string> {
  const business = await trx
    .insertInto("businesses")
    .values({
      name: "Sample Pet Store (DEMO)",
      slug: "sample-pet-store-demo",
      brand_color: "#0f6e5a",
      modules: JSON.stringify({ astro: true, grooming: true }),
      booking_enabled: true,
      public_phone: "2125550199",
      booking_message: "Book a bath or full groom for your pet. New customers are welcome!",
      deposit_rule: "all",
      is_demo: true,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await trx
    .insertInto("locations")
    .values({ business_id: business.id, name: "Main store (DEMO)", tax_rate_mpct: 7000, is_demo: true })
    .execute();

  await trx
    .insertInto("staff")
    .values(
      DEMO_STAFF.map((s) => ({
        ...s,
        business_id: business.id,
        is_demo: true,
        grooms: s.role === "groomer",
      })),
    )
    .execute();

  return business.id;
}

// The prototype's sample products and program.
const DEMO_PRODUCTS = [
  {
    sku: "0001",
    name: "Sample Adult Dog Food 24 lb (DEMO)",
    brand: "Sample Brand",
    category: "Dog food",
    price_cents: 6499,
    cost_cents: 4300,
    reorder_at: 6,
    on_hand: 14,
    program: true,
    offer: { label: "$5 off 24 lb bag", cents: 500 },
  },
  {
    sku: "0002",
    name: "Sample Cat Food 12 lb (DEMO)",
    brand: "Sample Brand",
    category: "Cat food",
    price_cents: 3899,
    cost_cents: 2500,
    reorder_at: 5,
    on_hand: 4,
    program: true,
    offer: null,
  },
  {
    sku: "0003",
    name: "Sample Freeze-Dried Treats (DEMO)",
    brand: "Sample Treat Co",
    category: "Treats",
    price_cents: 1299,
    cost_cents: 700,
    reorder_at: 10,
    on_hand: 30,
    program: false,
    offer: null,
  },
  {
    sku: "0004",
    name: "Sample Rope Toy (DEMO)",
    brand: null,
    category: "Supplies",
    price_cents: 899,
    cost_cents: 350,
    reorder_at: 4,
    on_hand: 0,
    program: false,
    offer: null,
  },
];

async function seedInventory(trx: Transaction<DB>, businessId: string): Promise<void> {
  const location = await trx
    .selectFrom("locations")
    .select("id")
    .where("business_id", "=", businessId)
    .orderBy("created_at")
    .executeTakeFirstOrThrow();

  const program = await trx
    .insertInto("astro_programs")
    .values({
      business_id: businessId,
      name: "Sample dry food club (DEMO)",
      brand: "Sample Brand",
      buy_count: 12,
      reward_text: "Next bag free",
      is_demo: true,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  for (const p of DEMO_PRODUCTS) {
    const row = await trx
      .insertInto("products")
      .values({
        business_id: businessId,
        sku: p.sku,
        name: p.name,
        brand: p.brand,
        category: p.category,
        price_cents: p.price_cents,
        cost_cents: p.cost_cents,
        reorder_at: p.reorder_at,
        astro_program_id: p.program ? program.id : null,
        astro_offer_label: p.offer?.label ?? null,
        astro_offer_cents: p.offer?.cents ?? null,
        is_demo: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    if (p.on_hand !== 0) {
      await trx
        .insertInto("inventory_moves")
        .values({
          business_id: businessId,
          product_id: row.id,
          location_id: location.id,
          qty_change: p.on_hand,
          reason: "adjust",
          note: "Opening count",
          is_demo: true,
        })
        .execute();
    }
  }
}

// Phone numbers are in the fictional 555-01xx range. Dates are relative to the
// day the demo is set up, so the birthday tag and the expired-rabies warning always show.
async function seedCustomers(trx: Transaction<DB>, businessId: string): Promise<void> {
  const today = todayIso();
  // The same calendar day n years back (Feb 29 becomes Feb 28 in a non-leap year).
  const yearsAgo = (n: number, days = 0) => {
    const d = addDays(today, days);
    const back = `${Number(d.slice(0, 4)) - n}${d.slice(4)}`;
    return isIsoDate(back) ? back : back.replace(/-02-29$/, "-02-28");
  };
  const program = await trx
    .selectFrom("astro_programs")
    .select("id")
    .where("business_id", "=", businessId)
    .where("is_demo", "=", true)
    .executeTakeFirst();

  const customers = [
    {
      name: "Sample Customer (DEMO)",
      phone: "2125550100",
      email: "customer.demo@example.com",
      street: "12 Sample St",
      city: "Springfield",
      state: "IL",
      zip: "62701",
      birthday: null,
      sms_opt_in: true,
      punches: 11,
      pets: [
        {
          name: "Biscuit",
          species: "dog" as const,
          breed: "Beagle",
          size: "M" as const,
          birthday: yearsAgo(4, 40),
          weight_lb: 24.5,
          temperament: "Friendly; nervous with dryers",
          vaccines: [
            { vaccine: "Rabies", expires_on: addDays(today, 300) },
            { vaccine: "DHPP", expires_on: addDays(today, 20) },
          ],
        },
      ],
    },
    {
      name: "Sample Cat Parent (DEMO)",
      phone: "2125550101",
      email: null,
      street: null,
      city: null,
      state: null,
      zip: null,
      birthday: yearsAgo(38, 3),
      sms_opt_in: false,
      punches: 0,
      pets: [
        {
          name: "Mo",
          species: "cat" as const,
          breed: "Domestic shorthair",
          size: "S" as const,
          birthday: yearsAgo(9, 120),
          weight_lb: 11,
          temperament: null,
          vaccines: [{ vaccine: "Rabies", expires_on: addDays(today, -30) }],
        },
      ],
    },
    {
      name: "Sample Family (DEMO)",
      phone: "2125550102",
      email: "family.demo@example.com",
      street: null,
      city: "Springfield",
      state: "IL",
      zip: null,
      birthday: null,
      sms_opt_in: true,
      punches: 4,
      pets: [
        {
          name: "Rex",
          species: "dog" as const,
          breed: "Labrador",
          size: "L" as const,
          birthday: yearsAgo(2, 200),
          weight_lb: 68,
          temperament: null,
          vaccines: [],
        },
        {
          name: "Juno",
          species: "dog" as const,
          breed: "Shih tzu",
          size: "S" as const,
          birthday: null,
          weight_lb: null,
          temperament: null,
          vaccines: [],
        },
        {
          name: "Clover",
          species: "other" as const,
          breed: "Rabbit",
          size: null,
          birthday: yearsAgo(1, 5),
          weight_lb: null,
          temperament: null,
          vaccines: [],
        },
      ],
    },
  ];

  for (const { pets, punches, ...c } of customers) {
    const row = await trx
      .insertInto("customers")
      .values({ ...c, business_id: businessId, is_demo: true })
      .returning("id")
      .executeTakeFirstOrThrow();
    for (const { vaccines, ...p } of pets) {
      const pet = await trx
        .insertInto("pets")
        .values({ ...p, business_id: businessId, customer_id: row.id, is_demo: true })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (vaccines.length)
        await trx
          .insertInto("vaccinations")
          .values(vaccines.map((v) => ({ ...v, business_id: businessId, pet_id: pet.id, is_demo: true })))
          .execute();
    }
    if (program && punches > 0)
      await trx
        .insertInto("astro_punches")
        .values({
          business_id: businessId,
          customer_id: row.id,
          program_id: program.id,
          qty: punches,
          kind: "opening_balance",
          is_demo: true,
        })
        .execute();
  }
}

// Example store discounts until the owner's real list is in.
async function seedDiscounts(trx: Transaction<DB>, businessId: string): Promise<void> {
  const base = { business_id: businessId, is_demo: true };
  await trx
    .insertInto("discounts")
    .values([
      {
        ...base,
        name: "Cash discount (DEMO)",
        code: "CASH",
        kind: "percent",
        percent_mpct: 3000,
        scope: "ticket",
        cash_only: true,
      },
      {
        ...base,
        name: "Employee discount (DEMO)",
        code: "EMP",
        kind: "percent",
        percent_mpct: 20000,
        scope: "ticket",
        ask_note: true,
      },
      {
        ...base,
        name: "Senior Tuesday (DEMO)",
        code: "SR10",
        kind: "percent",
        percent_mpct: 10000,
        scope: "ticket",
      },
      {
        ...base,
        name: "Damaged bag (DEMO)",
        code: "DMG",
        kind: "fixed",
        amount_cents: 500,
        scope: "line",
        needs_approval: true,
      },
    ])
    .execute();
}

export interface DemoStaff {
  id: string;
  businessId: string;
  name: string;
  role: Role;
}

/**
 * Everyone active at the demo store, for the role picker: the four (DEMO) logins first,
 * then staff added in Settings. Owner access: only the demo build may call this.
 */
export async function listDemoStaff(db: Kysely<DB>): Promise<DemoStaff[]> {
  const rows = await db
    .selectFrom("staff as s")
    .innerJoin("businesses as b", "b.id", "s.business_id")
    .select(["s.id", "s.business_id", "s.name", "s.role", "s.is_demo"])
    .where("b.is_demo", "=", true)
    .where("s.active", "=", true)
    .execute();
  const order: Role[] = ["owner", "manager", "cashier", "groomer"];
  return rows
    .sort(
      (a, b) =>
        Number(b.is_demo) - Number(a.is_demo) ||
        order.indexOf(a.role) - order.indexOf(b.role) ||
        a.name.localeCompare(b.name),
    )
    .map((r) => ({ id: r.id, businessId: r.business_id, name: r.name, role: r.role }));
}

// The prototype's grooming menu, two groomers and a few appointments today, one in
// each early status, so the calendar isn't empty on first look.
async function seedGrooming(trx: Transaction<DB>, businessId: string): Promise<void> {
  const svc = async (v: {
    name: string;
    kind: "main" | "addon";
    description: string | null;
    prices: [number, number, number, number];
    minutes: [number, number, number, number];
    buffer: number;
    deposit: number;
    position: number;
  }) =>
    await trx
      .insertInto("services")
      .values({
        business_id: businessId,
        name: v.name,
        kind: v.kind,
        description: v.description,
        price_s_cents: v.prices[0],
        price_m_cents: v.prices[1],
        price_l_cents: v.prices[2],
        price_xl_cents: v.prices[3],
        minutes_s: v.minutes[0],
        minutes_m: v.minutes[1],
        minutes_l: v.minutes[2],
        minutes_xl: v.minutes[3],
        buffer_minutes: v.buffer,
        deposit_cents: v.deposit,
        position: v.position,
        is_demo: true,
      })
      .returning(["id", "name"])
      .executeTakeFirstOrThrow();
  const full = await svc({
    name: "Sample Full groom (DEMO)",
    kind: "main",
    description: "Bath, haircut, nails, ears",
    prices: [5500, 7000, 8500, 10500],
    minutes: [90, 120, 150, 180],
    buffer: 15,
    deposit: 2000,
    position: 1,
  });
  const bath = await svc({
    name: "Sample Bath & brush (DEMO)",
    kind: "main",
    description: "Bath, blow-dry, brush-out, nails",
    prices: [3500, 4500, 6000, 7500],
    minutes: [60, 75, 90, 120],
    buffer: 15,
    deposit: 0,
    position: 2,
  });
  const teeth = await svc({
    name: "Sample Teeth brushing (DEMO)",
    kind: "addon",
    description: null,
    prices: [1000, 1000, 1000, 1000],
    minutes: [10, 10, 10, 10],
    buffer: 0,
    deposit: 0,
    position: 3,
  });

  const a = await trx
    .selectFrom("staff")
    .select("id")
    .where("business_id", "=", businessId)
    .where("role", "=", "groomer")
    .where("is_demo", "=", true)
    .orderBy("name")
    .executeTakeFirst();
  if (!a) return;
  await trx.updateTable("staff").set({ grooms: true }).where("id", "=", a.id).execute();
  const b = await trx
    .insertInto("staff")
    .values({
      business_id: businessId,
      name: "Sample Groomer B (DEMO)",
      email: "groomer.b.demo@example.com",
      role: "groomer",
      grooms: true,
      is_demo: true,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const hours = [
    ...[1, 2, 3, 4, 5, 6].map((d) => ({
      staff_id: a.id,
      weekday: d,
      start_time: "08:00",
      end_time: "16:00",
    })),
    ...[0, 2, 3, 4, 5, 6].map((d) => ({
      staff_id: b.id,
      weekday: d,
      start_time: "10:00",
      end_time: "18:00",
    })),
  ];
  await trx
    .insertInto("groomer_hours")
    .values(hours.map((h) => ({ ...h, business_id: businessId, is_demo: true })))
    .execute();

  const pets = await trx
    .selectFrom("pets")
    .select(["id", "name", "size", "customer_id"])
    .where("business_id", "=", businessId)
    .where("is_demo", "=", true)
    .execute();
  const loc = await trx
    .selectFrom("locations")
    .select("id")
    .where("business_id", "=", businessId)
    .orderBy("created_at")
    .executeTakeFirstOrThrow();
  const today = todayIso();
  const book = async (
    petName: string,
    staffId: string,
    service: { id: string; name: string },
    start: number,
    status: "booked" | "checked_in" | "in_progress",
    sizeFallback: "S" | "M" | "L" | "XL",
    price: number,
    minutes: number,
    buffer: number,
    notes: string | null,
    addon?: { id: string; name: string },
  ) => {
    const pet = pets.find((p) => p.name === petName);
    if (!pet) return;
    const row = await trx
      .insertInto("appointments")
      .values({
        business_id: businessId,
        location_id: loc.id,
        customer_id: pet.customer_id,
        pet_id: pet.id,
        staff_id: staffId,
        service_id: service.id,
        service_name: service.name,
        pet_name: pet.name,
        size: pet.size ?? sizeFallback,
        starts_at: atLocal(today, start),
        ends_at: atLocal(today, start + minutes),
        block_ends_at: atLocal(today, start + minutes + buffer),
        status,
        price_cents: price,
        notes,
        checked_in_at: status === "booked" ? null : new Date(),
        started_at: status === "in_progress" ? new Date() : null,
        is_demo: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    if (addon)
      await trx
        .insertInto("appointment_addons")
        .values({
          business_id: businessId,
          appointment_id: row.id,
          service_id: addon.id,
          name: addon.name,
          price_cents: 1000,
          minutes: 10,
          is_demo: true,
        })
        .execute();
  };
  // Biscuit is size M: full groom $70 + teeth $10, 120 + 10 minutes.
  await book("Biscuit", a.id, full, 9 * 60, "checked_in", "M", 8000, 130, 15, "Short summer cut", teeth);
  await book("Rex", b.id, bath, 10 * 60 + 30, "in_progress", "L", 6000, 90, 15, null);
  await book("Mo", a.id, bath, 13 * 60, "booked", "S", 3500, 60, 15, "Nervous with dryers");
}

/** Biscuit's full groom today was booked online with a $20.00 deposit, so the register shows it applied. */
async function seedDeposits(trx: Transaction<DB>, businessId: string): Promise<void> {
  const appt = await trx
    .selectFrom("appointments")
    .select(["id", "customer_id"])
    .where("business_id", "=", businessId)
    .where("is_demo", "=", true)
    .where("pet_name", "=", "Biscuit")
    .where("status", "not in", ["done", "canceled", "no_show"])
    .where("sale_id", "is", null)
    .where("deposit_id", "is", null)
    .orderBy("starts_at", "desc")
    .executeTakeFirst();
  if (!appt) return;
  const paidAt = new Date(Date.now() - 2 * 86_400_000);
  const dep = await trx
    .insertInto("deposits")
    .values({
      business_id: businessId,
      appointment_id: appt.id,
      customer_id: appt.customer_id,
      amount_cents: 2000,
      status: "paid",
      link_id: "sim_link_demo",
      provider_ref: "sim_demo_deposit",
      paid_at: paidAt,
      is_demo: true,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await trx
    .updateTable("appointments")
    .set({ deposit_id: dep.id, source: "online" })
    .where("id", "=", appt.id)
    .execute();
}

/** A simple sample picture (SVG), so the demo's grooming history has photos to show. */
function samplePhoto(label: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect width="640" height="480" fill="${color}"/><circle cx="320" cy="250" r="90" fill="#ffffff" opacity="0.85"/><circle cx="250" cy="150" r="34" fill="#ffffff" opacity="0.85"/><circle cx="320" cy="122" r="34" fill="#ffffff" opacity="0.85"/><circle cx="390" cy="150" r="34" fill="#ffffff" opacity="0.85"/><text x="320" y="430" font-family="sans-serif" font-size="40" text-anchor="middle" fill="#ffffff">${label} (sample)</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Back-bar supplies for the sample services, and a past groom for Biscuit with a
// note and photos, so the grooming history isn't empty.
async function seedGroomingSupplies(trx: Transaction<DB>, businessId: string): Promise<void> {
  const location = await trx
    .selectFrom("locations")
    .select("id")
    .where("business_id", "=", businessId)
    .orderBy("created_at")
    .executeTakeFirstOrThrow();
  const supply = async (
    sku: string,
    name: string,
    unit: string,
    onHand: number,
    reorderAt: number,
    costCents: number,
  ) => {
    const row = await trx
      .insertInto("products")
      .values({
        business_id: businessId,
        sku,
        name,
        category: "Back-bar",
        price_cents: 0,
        cost_cents: costCents,
        tax_class: "exempt",
        reorder_at: reorderAt,
        back_bar: true,
        unit,
        is_demo: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await trx
      .insertInto("inventory_moves")
      .values({
        business_id: businessId,
        product_id: row.id,
        location_id: location.id,
        qty_change: onHand,
        reason: "adjust",
        note: "Opening count",
        is_demo: true,
      })
      .execute();
    return row.id;
  };
  const shampoo = await supply("BB-01", "Sample Oatmeal shampoo (DEMO)", "oz", 128, 32, 12);
  const conditioner = await supply("BB-02", "Sample Conditioner (DEMO)", "oz", 64, 16, 15);
  await supply("BB-03", "Sample Clipper blade (DEMO)", "each", 4, 2, 2400);

  const services = await trx
    .selectFrom("services")
    .select(["id", "name"])
    .where("business_id", "=", businessId)
    .where("is_demo", "=", true)
    .execute();
  const full = services.find((x) => x.name.startsWith("Sample Full groom"));
  const bath = services.find((x) => x.name.startsWith("Sample Bath"));
  const link = (serviceId: string, productId: string, qty: [number, number, number, number]) =>
    trx
      .insertInto("service_supplies")
      .values({
        business_id: businessId,
        service_id: serviceId,
        product_id: productId,
        qty_s: qty[0],
        qty_m: qty[1],
        qty_l: qty[2],
        qty_xl: qty[3],
        is_demo: true,
      })
      .execute();
  if (full) {
    await link(full.id, shampoo, [2, 3, 4, 6]);
    await link(full.id, conditioner, [1, 1, 2, 3]);
  }
  if (bath) await link(bath.id, shampoo, [2, 3, 4, 6]);

  // Biscuit's groom three weeks ago, paid elsewhere (before this system).
  const biscuit = await trx
    .selectFrom("pets")
    .select(["id", "customer_id", "name"])
    .where("business_id", "=", businessId)
    .where("is_demo", "=", true)
    .where("name", "=", "Biscuit")
    .executeTakeFirst();
  const groomer = await trx
    .selectFrom("staff")
    .select("id")
    .where("business_id", "=", businessId)
    .where("role", "=", "groomer")
    .where("is_demo", "=", true)
    .orderBy("name")
    .executeTakeFirst();
  if (!biscuit || !groomer || !full) return;
  const day = addDays(todayIso(), -21);
  const past = await trx
    .insertInto("appointments")
    .values({
      business_id: businessId,
      location_id: location.id,
      customer_id: biscuit.customer_id,
      pet_id: biscuit.id,
      staff_id: groomer.id,
      service_id: full.id,
      service_name: full.name,
      pet_name: biscuit.name,
      size: "M",
      starts_at: atLocal(day, 10 * 60),
      ends_at: atLocal(day, 12 * 60),
      block_ends_at: atLocal(day, 12 * 60 + 15),
      status: "done",
      price_cents: 7000,
      done_at: atLocal(day, 12 * 60),
      supplies_used_at: atLocal(day, 12 * 60),
      is_demo: true,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const note = await trx
    .insertInto("grooming_notes")
    .values({
      business_id: businessId,
      pet_id: biscuit.id,
      appointment_id: past.id,
      staff_id: groomer.id,
      note: "Short summer cut. A little matted behind the ears; brush there weekly.",
      created_at: atLocal(day, 12 * 60),
      is_demo: true,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  for (const [kind, color] of [
    ["before", "#8a6d4b"],
    ["after", "#0f6e5a"],
  ] as const) {
    const data = samplePhoto(kind === "before" ? "Before" : "After", color);
    await trx
      .insertInto("grooming_photos")
      .values({
        business_id: businessId,
        note_id: note.id,
        kind,
        image_data: data,
        width: 640,
        height: 480,
        bytes: data.length,
        is_demo: true,
      })
      .execute();
  }
}

/** The sample store's id, for the demo's public booking page. */
export async function demoBusinessId(db: Kysely<DB>): Promise<string | null> {
  const b = await db.selectFrom("businesses").select("id").where("is_demo", "=", true).executeTakeFirst();
  return b?.id ?? null;
}
