// The public booking page: the store's menu, customer sign-in with a one-time code,
// the customer's own pets and appointments, open times, and booking.
import { sql, type Transaction } from "kysely";
import {
  AppError,
  addDays,
  atLocal,
  bookingDeposit,
  canChange,
  CODE_RULES,
  codeFromBytes,
  formatMoney,
  formatPhone,
  isIsoDate,
  minutesOfDay,
  normalizeContact,
  openTimes,
  pickGroomer,
  quoteAppointment,
  rabiesLapsed,
  SIZES,
  SPECIES,
  todayIso,
  type OpenGroomer,
  type PetSize,
  type Species,
} from "@pet-pos/core";
import type { DB } from "@pet-pos/db";
import { currentLocationId } from "../shared.ts";
import {
  appointmentRows,
  checkSlot,
  loadDay,
  localDay,
  rates,
  toService,
  type ServiceRow,
} from "../handlers/grooming.ts";
import { apptWhen, createDeposit, markDepositPaid, refundDeposit, releaseHolds } from "../deposits.ts";
import { definePublic, type PublicCtx, type SignedCtx } from "./handler.ts";

type Trx = Transaction<DB>;

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function settings(trx: Trx, businessId: string) {
  return trx
    .selectFrom("businesses")
    .select([
      "name",
      "logo_data",
      "brand_color",
      "booking_enabled",
      "booking_days_ahead",
      "booking_notice_minutes",
      "booking_cutoff_hours",
      "booking_step_minutes",
      "booking_message",
      "public_phone",
      "deposit_rule",
      "deposit_hold_minutes",
    ])
    .where("id", "=", businessId)
    .executeTakeFirstOrThrow();
}

const callUs = (phone: string | null) => (phone ? `call us at ${formatPhone(phone)}` : "call the store");

async function onlineServices(trx: Trx): Promise<ServiceRow[]> {
  const rows = await trx
    .selectFrom("services")
    .selectAll()
    .where("online", "=", true)
    .where("active", "=", true)
    .where("archived_at", "is", null)
    .orderBy("kind", "desc")
    .orderBy("position")
    .orderBy("name")
    .execute();
  return rows.map(toService);
}

async function onlineGroomers(trx: Trx) {
  return trx
    .selectFrom("staff")
    .select(["id", "name"])
    .where("grooms", "=", true)
    .where("active", "=", true)
    .where("books_online", "=", true)
    .orderBy("name")
    .execute();
}

// ---- the page ----

export interface BookingPage {
  storeName: string;
  logo: string | null;
  brandColor: string | null;
  enabled: boolean;
  message: string | null;
  phone: string | null;
  daysAhead: number;
  cutoffHours: number;
  /** Which bookings pay a deposit: none, every one whose service has one, or new customers only. */
  depositRule: "off" | "all" | "new";
  /** Minutes an unpaid booking holds its time. */
  holdMinutes: number;
  services: {
    id: string;
    name: string;
    kind: "main" | "addon";
    description: string | null;
    priceCents: Record<PetSize, number>;
    minutes: Record<PetSize, number>;
    depositCents: number;
  }[];
  groomers: { staffId: string; name: string }[];
}

export const bookingPage = definePublic<void, BookingPage>({
  signedIn: false,
  async run(trx, ctx) {
    const b = await settings(trx, ctx.businessId);
    return {
      storeName: b.name,
      logo: b.logo_data,
      brandColor: b.brand_color,
      enabled: b.booking_enabled,
      message: b.booking_message,
      phone: b.public_phone,
      daysAhead: b.booking_days_ahead,
      cutoffHours: b.booking_cutoff_hours,
      depositRule: b.deposit_rule,
      holdMinutes: b.deposit_hold_minutes,
      services: (await onlineServices(trx)).map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        description: s.description,
        priceCents: s.priceCents,
        minutes: s.minutes,
        depositCents: s.kind === "main" ? s.depositCents : 0,
      })),
      groomers: (await onlineGroomers(trx)).map((g) => ({ staffId: g.id, name: g.name })),
    };
  },
});

// ---- sign-in with a one-time code ----

export interface CodeSent {
  /** "a text to (212) 555-0100" or "an email to pat@example.com" */
  sentTo: string;
  /** Demo mode only: the code, shown on screen instead of sent. */
  demoCode?: string;
}

export const requestCode = definePublic<{ contact: string }, CodeSent>({
  signedIn: false,
  async run(trx, ctx, { contact }) {
    const c = normalizeContact(contact ?? "");
    if (!c) throw new AppError("invalid", "Enter a 10-digit mobile number or an email address.");
    const recent = await trx
      .selectFrom("customer_login_codes")
      .select(["created_at"])
      .where("contact", "=", c.value)
      .where("created_at", ">", new Date(Date.now() - 3600_000))
      .execute();
    if (recent.filter((r) => r.created_at.getTime() > Date.now() - 60_000).length >= CODE_RULES.perMinute)
      throw new AppError("invalid", "A code was just sent. Wait a minute before asking for another.");
    if (recent.length >= CODE_RULES.perHour)
      throw new AppError("invalid", "Too many codes asked for. Try again in an hour.");
    const b = new Uint8Array(3);
    crypto.getRandomValues(b);
    const code = codeFromBytes(b);
    await trx
      .insertInto("customer_login_codes")
      .values({
        business_id: ctx.businessId,
        contact: c.value,
        code_hash: await sha256(`${ctx.businessId}:${c.value}:${code}`),
        expires_at: new Date(Date.now() + CODE_RULES.expiresMinutes * 60_000),
      })
      .execute();
    // Hosted mode sends the code by text or email here; the demo shows it instead.
    return {
      sentTo: c.kind === "phone" ? `a text to ${formatPhone(c.value)}` : `an email to ${c.value}`,
      ...(ctx.demo ? { demoCode: code } : {}),
    };
  },
});

export type VerifyResult =
  | { status: "signed_in"; token: string; name: string }
  /** The code is right but there's no customer yet: ask for their name and verify again. */
  | { status: "needs_name" }
  /**
   * A wrong code. Returned rather than thrown, so the try is counted: an error would
   * roll the count back along with the transaction.
   */
  | { status: "wrong"; message: string };

export const verifyCode = definePublic<{ contact: string; code: string; name?: string }, VerifyResult>({
  signedIn: false,
  async run(trx, ctx, { contact, code, name }) {
    const c = normalizeContact(contact ?? "");
    if (!c) throw new AppError("invalid", "Enter a 10-digit mobile number or an email address.");
    const row = await trx
      .selectFrom("customer_login_codes")
      .select(["id", "code_hash", "expires_at", "attempts", "used_at"])
      .where("contact", "=", c.value)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    const wrong = "That code isn't right. Check it, or ask for a new one.";
    if (!row || row.used_at) throw new AppError("invalid", wrong);
    if (row.expires_at < new Date())
      throw new AppError("invalid", "That code has expired. Ask for a new one.");
    if (row.attempts >= CODE_RULES.maxTries)
      throw new AppError("invalid", "Too many tries. Ask for a new code.");
    if (row.code_hash !== (await sha256(`${ctx.businessId}:${c.value}:${(code ?? "").trim()}`))) {
      await trx
        .updateTable("customer_login_codes")
        .set({ attempts: row.attempts + 1 })
        .where("id", "=", row.id)
        .execute();
      return { status: "wrong", message: wrong };
    }
    let customer = await trx
      .selectFrom("customers")
      .select(["id", "name"])
      .where(c.kind === "phone" ? "phone" : sql<string>`lower(email)`, "=", c.value)
      .executeTakeFirst();
    if (!customer) {
      const n = name?.trim();
      if (!n) return { status: "needs_name" };
      customer = await trx
        .insertInto("customers")
        .values({
          business_id: ctx.businessId,
          name: n.slice(0, 120),
          ...(c.kind === "phone" ? { phone: c.value } : { email: c.value }),
        })
        .returning(["id", "name"])
        .executeTakeFirstOrThrow();
    }
    await trx
      .updateTable("customer_login_codes")
      .set({ used_at: new Date() })
      .where("id", "=", row.id)
      .execute();
    const token = randomHex(32);
    await trx
      .insertInto("customer_sessions")
      .values({
        business_id: ctx.businessId,
        customer_id: customer.id,
        token_hash: await sha256(token),
        expires_at: new Date(Date.now() + CODE_RULES.sessionDays * 86_400_000),
      })
      .execute();
    return { status: "signed_in", token, name: customer.name };
  },
});

/** Finds the customer for a session token, or null. Used by invokePublic. */
export async function customerForToken(trx: Trx, token: string | null): Promise<string | null> {
  if (!token) return null;
  const s = await trx
    .selectFrom("customer_sessions")
    .select(["id", "customer_id", "expires_at"])
    .where("token_hash", "=", await sha256(token))
    .executeTakeFirst();
  if (!s || s.expires_at < new Date()) return null;
  await trx
    .updateTable("customer_sessions")
    .set({ last_seen_at: new Date() })
    .where("id", "=", s.id)
    .execute();
  return s.customer_id;
}

export const signOut = definePublic<{ token: string }, void>({
  signedIn: false,
  async run(trx, _ctx, { token }) {
    await trx
      .deleteFrom("customer_sessions")
      .where("token_hash", "=", await sha256(token))
      .execute();
  },
});

// ---- the customer's account ----

export interface MyPet {
  id: string;
  name: string;
  species: Species;
  breed: string | null;
  size: PetSize | null;
  /** Rabies lapsed today. */
  rabiesLapsed: boolean;
}

export interface MyAppointment {
  id: string;
  petId: string | null;
  petName: string;
  serviceId: string;
  addonIds: string[];
  label: string;
  groomerName: string;
  staffId: string;
  day: string;
  start: number;
  end: number;
  priceCents: number;
  status: string;
  /** Before the store's cutoff, so it can still be canceled or moved online. */
  canChange: boolean;
  /** Waiting for the deposit: when the held time is let go. */
  holdUntil: Date | null;
  deposit: MyDeposit | null;
}

export interface MyDeposit {
  id: string;
  amountCents: number;
  status: "pending" | "paid" | "applied" | "refunded" | "kept" | "expired" | "canceled";
  /** Where to pay, while it's unpaid. */
  url: string | null;
}

export interface MyAccount {
  name: string;
  /** No finished groom yet: "New customers only" deposits apply. */
  newCustomer: boolean;
  pets: MyPet[];
  upcoming: MyAppointment[];
  recent: MyAppointment[];
}

async function myPets(trx: Trx, customerId: string): Promise<MyPet[]> {
  const pets = await trx
    .selectFrom("pets")
    .select(["id", "name", "species", "breed", "size"])
    .where("customer_id", "=", customerId)
    .orderBy("name")
    .execute();
  const vacc = pets.length
    ? await trx
        .selectFrom("vaccinations")
        .select(["pet_id", "vaccine", "expires_on"])
        .where(
          "pet_id",
          "in",
          pets.map((p) => p.id),
        )
        .execute()
    : [];
  return pets.map((p) => ({
    ...p,
    rabiesLapsed: rabiesLapsed(
      vacc.filter((v) => v.pet_id === p.id).map((v) => ({ vaccine: v.vaccine, expiresOn: v.expires_on })),
    ),
  }));
}

export const myAccount = definePublic<void, MyAccount>({
  signedIn: true,
  async run(trx, ctx) {
    const { customerId } = ctx as SignedCtx;
    const c = await trx
      .selectFrom("customers")
      .select("name")
      .where("id", "=", customerId)
      .executeTakeFirstOrThrow();
    const b = await settings(trx, ctx.businessId);
    await releaseHolds(trx);
    const today = atLocal(todayIso(), 0);
    const rows = await appointmentRows(trx, { customerId, from: addDaysDate(today, -365) });
    const now = new Date();
    const mine = rows.map((r): MyAppointment => ({
      id: r.id,
      petId: r.petId,
      petName: r.petName,
      serviceId: r.serviceId,
      addonIds: r.addons.map((a) => a.serviceId),
      label: r.label,
      groomerName: r.groomerName,
      staffId: r.staffId,
      day: localDay(r.startsAt),
      start: r.start,
      end: r.end,
      priceCents: r.priceCents,
      status: r.status,
      canChange: r.status === "booked" && canChange(r.startsAt, now, b.booking_cutoff_hours),
      holdUntil: r.holdUntil,
      deposit: r.deposit
        ? {
            id: r.deposit.id,
            amountCents: r.deposit.amountCents,
            status: r.deposit.status,
            url: r.deposit.url,
          }
        : null,
    }));
    return {
      name: c.name,
      newCustomer: await isNewCustomer(trx, customerId),
      pets: await myPets(trx, customerId),
      upcoming: mine
        .filter((a) => a.status === "held" || a.status === "booked" || a.status === "checked_in")
        .filter((a) => a.day >= todayIso()),
      recent: mine
        .filter((a) => a.status === "done")
        .reverse()
        .slice(0, 5),
    };
  },
});

async function isNewCustomer(trx: Trx, customerId: string): Promise<boolean> {
  const done = await trx
    .selectFrom("appointments")
    .select("id")
    .where("customer_id", "=", customerId)
    .where("status", "=", "done")
    .executeTakeFirst();
  return !done;
}

function addDaysDate(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export const savePet = definePublic<
  { id?: string; name: string; species: Species; breed?: string | null; size?: PetSize | null },
  MyPet
>({
  signedIn: true,
  async run(trx, ctx, input) {
    const { customerId } = ctx as SignedCtx;
    const name = input.name?.trim();
    if (!name) throw new AppError("invalid", "Enter your pet's name.");
    if (!(SPECIES as readonly string[]).includes(input.species))
      throw new AppError("invalid", "Pick dog, cat or other.");
    if (input.size && !(SIZES as readonly string[]).includes(input.size))
      throw new AppError("invalid", "Pick a size.");
    const values = {
      name: name.slice(0, 60),
      species: input.species,
      breed: input.breed?.trim() || null,
      size: input.size ?? null,
    };
    try {
      if (input.id) {
        const own = await trx
          .selectFrom("pets")
          .select("id")
          .where("id", "=", input.id)
          .where("customer_id", "=", customerId)
          .executeTakeFirst();
        if (!own) throw new AppError("not_found", "That pet isn't on your account.");
        await trx.updateTable("pets").set(values).where("id", "=", input.id).execute();
      } else {
        await trx
          .insertInto("pets")
          .values({ ...values, business_id: ctx.businessId, customer_id: customerId })
          .execute();
      }
    } catch (err) {
      if ((err as { code?: string })?.code === "23505")
        throw new AppError("conflict", `You already have a pet named ${name}.`);
      throw err;
    }
    return (await myPets(trx, customerId)).find((p) => p.name.toLowerCase() === name.toLowerCase())!;
  },
});

// ---- open times and booking ----

interface Wanted {
  petId: string;
  serviceId: string;
  addonIds: string[];
}

/** The pet (theirs, with a size), the services (online ones) and the length, for this customer. */
async function wanted(trx: Trx, ctx: SignedCtx, w: Wanted) {
  const pet = await trx
    .selectFrom("pets")
    .select(["id", "name", "size", "species"])
    .where("id", "=", w.petId)
    .where("customer_id", "=", ctx.customerId)
    .executeTakeFirst();
  if (!pet) throw new AppError("invalid", "Pick one of your pets.");
  if (!pet.size)
    throw new AppError("invalid", `Add ${pet.name}'s size first, so we can show the right price and time.`);
  const services = await onlineServices(trx);
  const main = services.find((s) => s.id === w.serviceId && s.kind === "main");
  if (!main) throw new AppError("invalid", "Pick a service.");
  const addons = (w.addonIds ?? []).map((id) => {
    const a = services.find((s) => s.id === id && s.kind === "addon");
    if (!a) throw new AppError("invalid", "An add-on isn't available online.");
    return a;
  });
  const quote = quoteAppointment(rates(main), addons.map(rates), pet.size);
  return { pet: { ...pet, size: pet.size }, main, addons, quote };
}

/** The first day and minute a booking can start, given the minimum notice. */
function earliestFor(day: string, noticeMinutes: number): number | null {
  const at = new Date(Date.now() + noticeMinutes * 60_000);
  const first = localDay(at);
  if (day < first) return null;
  return day === first ? minutesOfDay(at) : 0;
}

async function openOn(
  trx: Trx,
  day: string,
  minutes: number,
  buffer: number,
  step: number,
  notice: number,
  staffId: string | null,
) {
  const earliest = earliestFor(day, notice);
  if (earliest === null) return [];
  const d = await loadDay(trx, day);
  const allowed = new Set((await onlineGroomers(trx)).map((g) => g.id));
  const groomers: OpenGroomer[] = d.groomers
    .filter((g) => allowed.has(g.staffId) && (!staffId || g.staffId === staffId))
    .map((g) => ({
      staffId: g.staffId,
      hours: g.hours,
      timeOff: g.timeOff.map((t) => ({ start: t.start, end: t.end })),
      busy: d.appointments
        .filter((a) => a.staffId === g.staffId && a.status !== "no_show")
        .map((a) => ({ start: a.start, end: a.blockEnd })),
    }));
  const counts: Record<string, number> = {};
  for (const a of d.appointments)
    if (a.status !== "no_show") counts[a.staffId] = (counts[a.staffId] ?? 0) + 1;
  return openTimes({ groomers, minutes, buffer, step, earliest }).map((t) => ({ ...t, counts }));
}

export interface OpenDay {
  day: string;
  times: number[];
}

export const openTimesFor = definePublic<
  Wanted & { staffId: string | null; from: string; days: number },
  OpenDay[]
>({
  signedIn: true,
  async run(trx, ctx, input) {
    const b = await settings(trx, ctx.businessId);
    if (!b.booking_enabled)
      throw new AppError("invalid", `Online booking isn't available. Please ${callUs(b.public_phone)}.`);
    if (!isIsoDate(input.from)) throw new AppError("invalid", "Pick a day.");
    const w = await wanted(trx, ctx as SignedCtx, input);
    const last = addDays(todayIso(), b.booking_days_ahead);
    const out: OpenDay[] = [];
    for (let i = 0; i < Math.min(input.days ?? 14, 31); i++) {
      const day = addDays(input.from, i);
      if (day > last) break;
      const t = await openOn(
        trx,
        day,
        w.quote.minutes,
        w.quote.bufferMinutes,
        b.booking_step_minutes,
        b.booking_notice_minutes,
        input.staffId,
      );
      out.push({ day, times: t.map((x) => x.start) });
    }
    return out;
  },
});

/** Shared by booking and rescheduling: who takes it, and that the slot is still free and allowed. */
async function placeBooking(
  trx: Trx,
  ctx: SignedCtx,
  w: Awaited<ReturnType<typeof wanted>>,
  v: { staffId: string | null; day: string; start: number; ignoreId: string | null },
) {
  const b = await settings(trx, ctx.businessId);
  if (!b.booking_enabled)
    throw new AppError("invalid", `Online booking isn't available. Please ${callUs(b.public_phone)}.`);
  if (!isIsoDate(v.day) || v.day > addDays(todayIso(), b.booking_days_ahead))
    throw new AppError("invalid", "That day is too far ahead to book online.");
  if (w.pet.species !== "other" && rabiesLapsedOn(await rabiesFor(trx, w.pet.id), v.day))
    throw new AppError(
      "invalid",
      `${w.pet.name}'s rabies vaccination has expired. Please ${callUs(b.public_phone)} to book.`,
    );
  const open = await openOn(
    trx,
    v.day,
    w.quote.minutes,
    w.quote.bufferMinutes,
    b.booking_step_minutes,
    b.booking_notice_minutes,
    v.staffId,
  );
  const slot = open.find((t) => t.start === v.start);
  // Rescheduling: the appointment's own slot doesn't count against it.
  let staffIds = slot?.staffIds ?? [];
  if (v.ignoreId) {
    const groomers = v.staffId ? [v.staffId] : (await onlineGroomers(trx)).map((g) => g.id);
    staffIds = [];
    for (const id of groomers) {
      const g = await trx
        .selectFrom("staff")
        .select(["id", "name"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      const s = await checkSlot(trx, {
        groomer: g,
        petId: w.pet.id,
        petName: w.pet.name,
        day: v.day,
        start: v.start,
        minutes: w.quote.minutes,
        buffer: w.quote.bufferMinutes,
        ignoreId: v.ignoreId,
      });
      if (!s.clash && !s.warnings.some((x) => !x.includes("rabies"))) staffIds.push(id);
    }
    const earliest = earliestFor(v.day, b.booking_notice_minutes);
    if (earliest === null || v.start < earliest) staffIds = [];
  }
  if (!staffIds.length) throw new AppError("conflict", "Sorry, that time isn't open anymore. Pick another.");
  const staffId = v.staffId ?? pickGroomer(staffIds, slot?.counts ?? {})!;
  const g = await trx
    .selectFrom("staff")
    .select(["id", "name"])
    .where("id", "=", staffId)
    .executeTakeFirstOrThrow();
  const s = await checkSlot(trx, {
    groomer: g,
    petId: w.pet.id,
    petName: w.pet.name,
    day: v.day,
    start: v.start,
    minutes: w.quote.minutes,
    buffer: w.quote.bufferMinutes,
    ignoreId: v.ignoreId,
  });
  if (s.clash) throw new AppError("conflict", "Sorry, that time was just taken. Pick another.");
  return { staffId, slot: s };
}

async function rabiesFor(trx: Trx, petId: string) {
  return trx
    .selectFrom("vaccinations")
    .select(["vaccine", "expires_on"])
    .where("pet_id", "=", petId)
    .execute();
}

function rabiesLapsedOn(v: { vaccine: string; expires_on: string }[], day: string): boolean {
  return rabiesLapsed(
    v.map((x) => ({ vaccine: x.vaccine, expiresOn: x.expires_on })),
    day,
  );
}

/** Saves, turning the database's double-booking refusal into a plain message. */
async function guarded<T>(trx: Trx, run: () => Promise<T>): Promise<T> {
  await sql`SAVEPOINT online`.execute(trx);
  try {
    const r = await run();
    await sql`RELEASE SAVEPOINT online`.execute(trx);
    return r;
  } catch (err) {
    await sql`ROLLBACK TO SAVEPOINT online`.execute(trx);
    if ((err as { code?: string })?.code === "23P01")
      throw new AppError("conflict", "Sorry, that time was just taken. Pick another.");
    throw err;
  }
}

export const bookOnline = definePublic<
  Wanted & { staffId: string | null; day: string; start: number; notes?: string },
  MyAppointment
>({
  signedIn: true,
  async run(trx, ctx, input) {
    const c = ctx as SignedCtx;
    const w = await wanted(trx, c, input);
    const { staffId, slot } = await placeBooking(trx, c, w, {
      staffId: input.staffId,
      day: input.day,
      start: input.start,
      ignoreId: null,
    });
    const b = await settings(trx, ctx.businessId);
    const depositCents = bookingDeposit({
      rule: b.deposit_rule,
      serviceDepositCents: w.main.depositCents,
      quoteCents: w.quote.priceCents,
      isNewCustomer: await isNewCustomer(trx, c.customerId),
    });
    const locationId = await currentLocationId(trx);
    const row = await guarded(trx, () =>
      trx
        .insertInto("appointments")
        .values({
          business_id: ctx.businessId,
          location_id: locationId,
          customer_id: c.customerId,
          pet_id: w.pet.id,
          staff_id: staffId,
          service_id: w.main.id,
          service_name: w.main.name,
          pet_name: w.pet.name,
          size: w.pet.size,
          starts_at: slot.startsAt,
          ends_at: slot.endsAt,
          block_ends_at: slot.blockEndsAt,
          price_cents: w.quote.priceCents,
          notes: input.notes?.trim().slice(0, 500) || null,
          source: "online",
          ...(depositCents
            ? {
                status: "held" as const,
                hold_expires_at: new Date(Date.now() + b.deposit_hold_minutes * 60_000),
              }
            : {}),
        })
        .returning("id")
        .executeTakeFirstOrThrow(),
    );
    for (const a of w.addons)
      await trx
        .insertInto("appointment_addons")
        .values({
          business_id: ctx.businessId,
          appointment_id: row.id,
          service_id: a.id,
          name: a.name,
          price_cents: a.priceCents[w.pet.size],
          minutes: a.minutes[w.pet.size],
        })
        .execute();
    if (depositCents)
      await createDeposit(trx, {
        businessId: ctx.businessId,
        appointmentId: row.id,
        amountCents: depositCents,
      });
    return mine(trx, ctx, row.id);
  },
});

async function mine(trx: Trx, ctx: PublicCtx, id: string): Promise<MyAppointment> {
  const acct = await myAccount.run(trx, ctx, undefined);
  const a = [...acct.upcoming, ...acct.recent].find((x) => x.id === id);
  if (!a) throw new AppError("not_found", "That appointment isn't on your account.");
  return a;
}

async function ownBooked(trx: Trx, ctx: SignedCtx, id: string, allowHeld = false) {
  await releaseHolds(trx);
  const a = await trx
    .selectFrom("appointments")
    .select(["id", "status", "starts_at", "pet_id", "service_id", "deposit_id"])
    .where("id", "=", id)
    .where("customer_id", "=", ctx.customerId)
    .forUpdate()
    .executeTakeFirst();
  if (!a) throw new AppError("not_found", "That appointment isn't on your account.");
  if (allowHeld && a.status === "held") return a;
  const b = await settings(trx, ctx.businessId);
  if (a.status !== "booked" || !canChange(a.starts_at, new Date(), b.booking_cutoff_hours))
    throw new AppError(
      "invalid",
      `It's less than ${b.booking_cutoff_hours} hours away, so it can't be changed online. Please ${callUs(b.public_phone)}.`,
    );
  return a;
}

export const cancelMine = definePublic<{ id: string }, void>({
  signedIn: true,
  async run(trx, ctx, { id }) {
    const a = await ownBooked(trx, ctx as SignedCtx, id, true);
    await trx
      .updateTable("appointments")
      .set({ status: "canceled", canceled_at: new Date(), hold_expires_at: null })
      .where("id", "=", id)
      .execute();
    // Canceling in time gives the whole deposit back.
    if (a.deposit_id)
      await refundDeposit(
        trx,
        { businessId: ctx.businessId, staffId: null },
        a.deposit_id,
        "canceled online by the customer",
      );
  },
});

// ---- deposits ----

export interface DepositView {
  id: string;
  appointmentId: string;
  status: MyDeposit["status"];
  amountCents: number;
  storeName: string;
  /** "Biscuit · Full groom, Thu Oct 22, 9:00 AM" */
  description: string;
  priceCents: number;
  holdUntil: Date | null;
  url: string | null;
  /** What happened, in a sentence, after paying or canceling. */
  message: string | null;
}

async function depositView(
  trx: Trx,
  ctx: SignedCtx,
  id: string,
  message: string | null = null,
): Promise<DepositView> {
  const d = await trx
    .selectFrom("deposits as d")
    .innerJoin("appointments as a", "a.id", "d.appointment_id")
    .innerJoin("businesses as b", "b.id", "d.business_id")
    .select([
      "d.id",
      "d.status",
      "d.amount_cents",
      "d.link_url",
      "a.id as appointment_id",
      "a.status as appt_status",
      "a.hold_expires_at",
      "a.pet_name",
      "a.service_name",
      "a.starts_at",
      "a.price_cents",
      "b.name as store",
    ])
    .where("d.id", "=", id)
    .where("d.customer_id", "=", ctx.customerId)
    .executeTakeFirst();
  if (!d) throw new AppError("not_found", "That deposit isn't on your account.");
  return {
    id: d.id,
    appointmentId: d.appointment_id,
    status: d.status,
    amountCents: d.amount_cents,
    storeName: d.store,
    description: `${d.pet_name} · ${d.service_name}, ${apptWhen(d.starts_at)}`,
    priceCents: d.price_cents,
    holdUntil: d.appt_status === "held" ? d.hold_expires_at : null,
    url: d.status === "pending" ? d.link_url : null,
    message,
  };
}

/** The deposit and its booking, for the payment page and the page the customer returns to. */
export const depositStatus = definePublic<{ id: string }, DepositView>({
  signedIn: true,
  async run(trx, ctx, { id }) {
    await releaseHolds(trx);
    return depositView(trx, ctx as SignedCtx, id);
  },
});

/** A fresh look at the payment link for the customer's own held booking. */
export const payDeposit = definePublic<{ appointmentId: string }, DepositView>({
  signedIn: true,
  async run(trx, ctx, { appointmentId }) {
    const c = ctx as SignedCtx;
    await releaseHolds(trx);
    const a = await trx
      .selectFrom("appointments")
      .select(["status", "deposit_id"])
      .where("id", "=", appointmentId)
      .where("customer_id", "=", c.customerId)
      .executeTakeFirst();
    if (!a) throw new AppError("not_found", "That appointment isn't on your account.");
    if (a.status !== "held" || !a.deposit_id)
      throw new AppError("invalid", "The hold on this time ran out. Please book again.");
    return depositView(trx, c, a.deposit_id);
  },
});

/** Demo only: stands in for Square's payment page and its webhook. */
export const simulateDepositPayment = definePublic<{ id: string; outcome: "paid" | "canceled" }, DepositView>(
  {
    signedIn: true,
    async run(trx, ctx, { id, outcome }) {
      if (!ctx.demo) throw new AppError("forbidden", "Payments come from Square here.");
      const c = ctx as SignedCtx;
      const before = await depositView(trx, c, id);
      if (outcome === "canceled")
        return depositView(
          trx,
          c,
          id,
          before.holdUntil ? "Payment canceled. Your time is still held." : null,
        );
      const bytes = new Uint8Array(9);
      crypto.getRandomValues(bytes);
      const ref = `sim_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
      const r = await markDepositPaid(trx, id, ref);
      const message =
        r === "refunded_late"
          ? `Sorry, the hold ran out before your payment came in. Your ${formatMoney(before.amountCents)} deposit was refunded.`
          : r === "already"
            ? "This deposit was already paid."
            : null;
      return depositView(trx, c, id, message);
    },
  },
);

export const rescheduleMine = definePublic<
  { id: string; staffId: string | null; day: string; start: number },
  MyAppointment
>({
  signedIn: true,
  async run(trx, ctx, input) {
    const c = ctx as SignedCtx;
    const a = await ownBooked(trx, c, input.id);
    const addons = await trx
      .selectFrom("appointment_addons")
      .select("service_id")
      .where("appointment_id", "=", a.id)
      .execute();
    if (!a.pet_id) throw new AppError("invalid", "This pet's record was removed. Please call the store.");
    const w = await wanted(trx, c, {
      petId: a.pet_id,
      serviceId: a.service_id,
      addonIds: addons.map((x) => x.service_id),
    }).catch(() => null);
    if (!w) throw new AppError("invalid", "This groom can't be moved online. Please call the store.");
    // Keep the booked length and price: only the groomer and time change.
    const appt = await trx
      .selectFrom("appointments")
      .select(["starts_at", "ends_at", "block_ends_at"])
      .where("id", "=", a.id)
      .executeTakeFirstOrThrow();
    w.quote.minutes = Math.round((appt.ends_at.getTime() - appt.starts_at.getTime()) / 60000);
    w.quote.bufferMinutes = Math.round((appt.block_ends_at.getTime() - appt.ends_at.getTime()) / 60000);
    const { staffId, slot } = await placeBooking(trx, c, w, {
      staffId: input.staffId,
      day: input.day,
      start: input.start,
      ignoreId: a.id,
    });
    await guarded(trx, () =>
      trx
        .updateTable("appointments")
        .set({
          staff_id: staffId,
          starts_at: slot.startsAt,
          ends_at: slot.endsAt,
          block_ends_at: slot.blockEndsAt,
        })
        .where("id", "=", a.id)
        .execute(),
    );
    return mine(trx, ctx, a.id);
  },
});
