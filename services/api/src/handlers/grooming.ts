// Grooming: the service menu, groomer hours and time off, the day calendar and
// appointments. Every booking is repriced here with quoteAppointment(); the database's
// exclusion constraint is the last word on double-booking.
import { sql, type Transaction } from "kysely";
import {
  AppError,
  atLocal,
  canStep,
  channelFor,
  unreachableNote,
  clockText,
  isIsoDate,
  minutesOfDay,
  minutesToTime,
  quoteAppointment,
  rabiesLapsed,
  SIZES,
  timeToMinutes,
  weekDays,
  weekStart,
  withinHours,
  suggestCallout,
  type CalloutGroomer,
  type ApptStatus,
  type Ctx,
  type PetSize,
  type Quote,
  type ServiceRates,
} from "@pet-pos/core";
import type { DB, MessageKind } from "@pet-pos/db";
import { defineHandler } from "../handler.ts";
import { audit, currentLocationId, requireInt } from "../shared.ts";
import { returnSupplies, useSupplies } from "./supplies.ts";
import { keepDeposit, refundDeposit, refundDepositsFor, releaseHolds } from "../deposits.ts";
import { confirmBooking, notify, type NotifyResult } from "../messages.ts";

type Trx = Transaction<DB>;
type Sized = Record<PetSize, number>;

// ---- services ----

export interface ServiceRow {
  id: string;
  name: string;
  kind: "main" | "addon";
  description: string | null;
  priceCents: Sized;
  minutes: Sized;
  bufferMinutes: number;
  depositCents: number;
  rebookWeeks: number | null;
  online: boolean;
  active: boolean;
  archived: boolean;
}

type ServiceDb = {
  id: string;
  name: string;
  kind: "main" | "addon";
  description: string | null;
  price_s_cents: number;
  price_m_cents: number;
  price_l_cents: number;
  price_xl_cents: number;
  minutes_s: number;
  minutes_m: number;
  minutes_l: number;
  minutes_xl: number;
  buffer_minutes: number;
  deposit_cents: number;
  rebook_weeks: number | null;
  online: boolean;
  active: boolean;
  archived_at: Date | null;
};

export function toService(s: ServiceDb): ServiceRow {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    description: s.description,
    priceCents: { S: s.price_s_cents, M: s.price_m_cents, L: s.price_l_cents, XL: s.price_xl_cents },
    minutes: { S: s.minutes_s, M: s.minutes_m, L: s.minutes_l, XL: s.minutes_xl },
    bufferMinutes: s.buffer_minutes,
    depositCents: s.deposit_cents,
    rebookWeeks: s.rebook_weeks,
    online: s.online,
    active: s.active,
    archived: !!s.archived_at,
  };
}

export const rates = (s: ServiceRow): ServiceRates => ({
  name: s.name,
  priceCents: s.priceCents,
  minutes: s.minutes,
  bufferMinutes: s.bufferMinutes,
});

export const listServices = defineHandler<{ all?: boolean }, ServiceRow[]>({
  action: "grooming.view",
  async run(trx, _ctx, input) {
    let q = trx.selectFrom("services").selectAll();
    if (!input?.all) q = q.where("archived_at", "is", null).where("active", "=", true);
    const rows = await q.orderBy("kind", "desc").orderBy("position").orderBy("name").execute();
    return rows.map(toService);
  },
});

export interface ServiceInput {
  id?: string;
  name: string;
  kind: "main" | "addon";
  description: string | null;
  priceCents: Sized;
  minutes: Sized;
  bufferMinutes: number;
  depositCents: number;
  /** Weeks until the rebook reminder; null uses the store's default. */
  rebookWeeks?: number | null;
  online: boolean;
  active: boolean;
}

export const saveService = defineHandler<ServiceInput, { id: string }>({
  action: "grooming.manage",
  async run(trx, ctx, input) {
    const name = input.name.trim();
    if (!name)
      throw new AppError("invalid", "Service name is required.", { name: "Service name is required." });
    if (input.kind !== "main" && input.kind !== "addon")
      throw new AppError("invalid", "Pick main service or add-on.");
    for (const z of SIZES) {
      requireInt(input.priceCents[z], `Price for size ${z}`, { min: 0, max: 1_000_000 });
      requireInt(input.minutes[z], `Minutes for size ${z}`, { min: 0, max: 720 });
      if (input.kind === "main" && input.minutes[z] <= 0)
        throw new AppError("invalid", `Set the minutes for size ${z}.`, {
          minutes: `Set the minutes for size ${z}.`,
        });
    }
    requireInt(input.bufferMinutes, "Buffer", { min: 0, max: 240 });
    requireInt(input.depositCents, "Deposit", { min: 0, max: 1_000_000 });
    if (input.rebookWeeks != null) requireInt(input.rebookWeeks, "Rebook weeks", { min: 1, max: 52 });
    const values = {
      name,
      kind: input.kind,
      description: input.description?.trim() || null,
      price_s_cents: input.priceCents.S,
      price_m_cents: input.priceCents.M,
      price_l_cents: input.priceCents.L,
      price_xl_cents: input.priceCents.XL,
      minutes_s: input.minutes.S,
      minutes_m: input.minutes.M,
      minutes_l: input.minutes.L,
      minutes_xl: input.minutes.XL,
      buffer_minutes: input.bufferMinutes,
      deposit_cents: input.depositCents,
      ...(input.rebookWeeks !== undefined ? { rebook_weeks: input.rebookWeeks } : {}),
      online: input.online,
      active: input.active,
    };
    try {
      if (input.id) {
        const before = await trx
          .selectFrom("services")
          .selectAll()
          .where("id", "=", input.id)
          .executeTakeFirst();
        if (!before) throw new AppError("not_found", "That service doesn't exist.");
        await trx.updateTable("services").set(values).where("id", "=", input.id).execute();
        const keys = ["price_s_cents", "price_m_cents", "price_l_cents", "price_xl_cents"] as const;
        if (keys.some((k) => before[k] !== values[k]))
          await audit(trx, ctx, {
            action: "service.price_change",
            entity: "service",
            entityId: input.id,
            before: Object.fromEntries(keys.map((k) => [k, before[k]])),
            after: Object.fromEntries(keys.map((k) => [k, values[k]])),
          });
        return { id: input.id };
      }
      const row = await trx
        .insertInto("services")
        .values({ ...values, business_id: ctx.businessId })
        .returning("id")
        .executeTakeFirstOrThrow();
      return { id: row.id };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e?.code === "23505" && e.message?.includes("services_name_per_business"))
        throw new AppError("conflict", "There's already a service with that name.", {
          name: "There's already a service with that name.",
        });
      throw err;
    }
  },
});

/** Services are archived, never deleted, so old appointments keep their name. */
export const archiveService = defineHandler<{ id: string }, void>({
  action: "grooming.manage",
  async run(trx, _ctx, { id }) {
    const res = await trx
      .updateTable("services")
      .set({ archived_at: new Date(), active: false })
      .where("id", "=", id)
      .executeTakeFirst();
    if (res.numUpdatedRows === 0n) throw new AppError("not_found", "That service doesn't exist.");
  },
});

// ---- groomers ----

export interface GroomerRow {
  staffId: string;
  name: string;
  role: string;
  grooms: boolean;
  /** Takes online bookings. */
  booksOnline: boolean;
  active: boolean;
  /** Weekly hours: "09:00" times. */
  hours: { weekday: number; start: string; end: string }[];
  timeOff: { id: string; startsAt: Date; endsAt: Date; note: string | null }[];
}

/** Groomers (or, with all, every active staff member, for ticking who grooms). */
export const listGroomers = defineHandler<{ all?: boolean }, GroomerRow[]>({
  action: "grooming.view",
  async run(trx, _ctx, input) {
    let q = trx
      .selectFrom("staff")
      .select(["id", "name", "role", "grooms", "books_online", "active"])
      .where("active", "=", true);
    if (!input?.all) q = q.where("grooms", "=", true);
    const staff = await q.orderBy("name").execute();
    if (!staff.length) return [];
    const ids = staff.map((s) => s.id);
    const hours = await trx
      .selectFrom("groomer_hours")
      .select(["staff_id", "weekday", "start_time", "end_time"])
      .where("staff_id", "in", ids)
      .orderBy("weekday")
      .execute();
    const off = await trx
      .selectFrom("time_off")
      .select(["id", "staff_id", "starts_at", "ends_at", "note"])
      .where("staff_id", "in", ids)
      .where("ends_at", ">", new Date())
      .orderBy("starts_at")
      .execute();
    return staff.map((s) => ({
      staffId: s.id,
      name: s.name,
      role: s.role,
      grooms: s.grooms,
      booksOnline: s.books_online,
      active: s.active,
      hours: hours
        .filter((h) => h.staff_id === s.id)
        .map((h) => ({ weekday: h.weekday, start: h.start_time.slice(0, 5), end: h.end_time.slice(0, 5) })),
      timeOff: off
        .filter((t) => t.staff_id === s.id)
        .map((t) => ({ id: t.id, startsAt: t.starts_at, endsAt: t.ends_at, note: t.note })),
    }));
  },
});

export interface GroomerInput {
  staffId: string;
  grooms: boolean;
  /** Left out: unchanged. */
  booksOnline?: boolean;
  hours: { weekday: number; start: string; end: string }[];
}

export const saveGroomer = defineHandler<GroomerInput, void>({
  action: "grooming.manage",
  async run(trx, ctx, { staffId, grooms, hours, booksOnline }) {
    const s = await trx.selectFrom("staff").select("id").where("id", "=", staffId).executeTakeFirst();
    if (!s) throw new AppError("not_found", "That staff member doesn't exist.");
    const seen = new Set<number>();
    const rows = hours.map((h) => {
      requireInt(h.weekday, "Weekday", { min: 0, max: 6 });
      if (seen.has(h.weekday)) throw new AppError("invalid", "Each day can only have one set of hours.");
      seen.add(h.weekday);
      const start = timeToMinutes(h.start);
      const end = timeToMinutes(h.end);
      if (end <= start) throw new AppError("invalid", "The end time must be after the start time.");
      return {
        business_id: ctx.businessId,
        staff_id: staffId,
        weekday: h.weekday,
        start_time: minutesToTime(start),
        end_time: minutesToTime(end),
      };
    });
    await trx
      .updateTable("staff")
      .set({ grooms, ...(booksOnline !== undefined ? { books_online: booksOnline } : {}) })
      .where("id", "=", staffId)
      .execute();
    await trx.deleteFrom("groomer_hours").where("staff_id", "=", staffId).execute();
    if (rows.length) await trx.insertInto("groomer_hours").values(rows).execute();
  },
});

export const addTimeOff = defineHandler<
  { staffId: string; startsAt: string; endsAt: string; note?: string },
  { id: string }
>({
  action: "grooming.manage",
  async run(trx, ctx, input) {
    const start = new Date(input.startsAt);
    const end = new Date(input.endsAt);
    if (isNaN(start.getTime()) || isNaN(end.getTime()))
      throw new AppError("invalid", "Pick when the time off starts and ends.");
    if (end <= start) throw new AppError("invalid", "Time off must end after it starts.");
    const row = await trx
      .insertInto("time_off")
      .values({
        business_id: ctx.businessId,
        staff_id: input.staffId,
        starts_at: start,
        ends_at: end,
        note: input.note?.trim() || null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { id: row.id };
  },
});

export const removeTimeOff = defineHandler<{ id: string }, void>({
  action: "grooming.manage",
  async run(trx, _ctx, { id }) {
    await trx.deleteFrom("time_off").where("id", "=", id).execute();
  },
});

// ---- the day ----

function dayBounds(day: string): { from: Date; to: Date; weekday: number } {
  if (!isIsoDate(day)) throw new AppError("invalid", "Pick a day.");
  const from = atLocal(day, 0);
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return { from, to: new Date(y, m - 1, d + 1), weekday: from.getDay() };
}

export interface AppointmentRow {
  id: string;
  status: ApptStatus;
  staffId: string;
  groomerName: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  petId: string | null;
  petName: string;
  species: string | null;
  breed: string | null;
  allergies: string | null;
  coat: string | null;
  temperament: string | null;
  size: PetSize;
  serviceId: string;
  serviceName: string;
  addons: { serviceId: string; name: string }[];
  /** "Full groom + Teeth brushing" */
  label: string;
  startsAt: Date;
  endsAt: Date;
  /** Minutes since local midnight, for placing on the calendar. */
  start: number;
  end: number;
  blockEnd: number;
  priceCents: number;
  notes: string | null;
  /** Rabies lapsed by the appointment's date. */
  rabiesLapsed: boolean;
  /** Booked by staff, or online by the customer. */
  source: "staff" | "online";
  /** The sale that paid for it. */
  saleId: string | null;
  receiptNumber: number | null;
  /** Money refunded on that sale (for "Refunded" on a paid groom). */
  saleRefundedCents: number;
  /** How messages reach the customer, or why they can't. */
  reach: { channel: "sms" | "email"; to: string } | { none: string };
  /** A held online booking: when its time to pay runs out. */
  holdUntil: Date | null;
  deposit: AppointmentDeposit | null;
  /** Grooming notes on this appointment. */
  noteCount: number;
  /** The pet's most recent note from an earlier groom: "last time: short summer cut". */
  lastNote: string | null;
}

export interface AppointmentDeposit {
  id: string;
  amountCents: number;
  refundedCents: number;
  status: "pending" | "paid" | "applied" | "refunded" | "kept" | "expired" | "canceled";
  paidAt: Date | null;
  /** The payment link, while it's unpaid. */
  url: string | null;
  /** The no-show or cancellation fee sale, when it was kept. */
  keptReceiptNumber: number | null;
}

function reachOf(r: {
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  sms_opt_in: boolean | null;
  contact_pref: "text" | "email" | null;
  email_off: boolean | null;
}): AppointmentRow["reach"] {
  if (r.customer_name === null) return { none: "the customer was deleted" };
  const c = {
    phone: r.customer_phone,
    email: r.customer_email,
    smsOptIn: !!r.sms_opt_in,
    pref: r.contact_pref,
    emailOff: !!r.email_off,
  };
  return channelFor(c) ?? { none: unreachableNote(c) };
}

export async function appointmentRows(
  trx: Trx,
  where: { from?: Date; to?: Date; ids?: string[]; customerId?: string },
) {
  let q = trx
    .selectFrom("appointments as a")
    .innerJoin("staff as st", "st.id", "a.staff_id")
    .leftJoin("customers as c", "c.id", "a.customer_id")
    .leftJoin("pets as p", "p.id", "a.pet_id")
    .leftJoin("deposits as d", "d.id", "a.deposit_id")
    .select([
      "a.id",
      "a.status",
      "a.hold_expires_at",
      "d.id as deposit_id",
      "d.amount_cents as deposit_cents",
      "d.refunded_cents as deposit_refunded_cents",
      "d.status as deposit_status",
      "d.paid_at as deposit_paid_at",
      "d.link_url as deposit_url",
      sql<number | null>`(SELECT s.receipt_number FROM sales s WHERE s.id = d.kept_sale_id)`.as(
        "deposit_kept_receipt",
      ),
      "a.staff_id",
      "st.name as groomer_name",
      "a.customer_id",
      "c.name as customer_name",
      "c.phone as customer_phone",
      "c.email as customer_email",
      "c.sms_opt_in",
      "c.contact_pref",
      "c.email_off",
      "a.pet_id",
      "a.pet_name",
      "p.species",
      "p.breed",
      "p.allergies",
      "p.coat",
      "p.temperament",
      "a.size",
      "a.service_id",
      "a.service_name",
      "a.starts_at",
      "a.ends_at",
      "a.block_ends_at",
      "a.price_cents",
      "a.notes",
      "a.source",
      "a.sale_id",
      sql<number | null>`(SELECT s.receipt_number FROM sales s WHERE s.id = a.sale_id)`.as("receipt_number"),
      sql<number>`coalesce((SELECT s.refunded_cents FROM sales s WHERE s.id = a.sale_id), 0)`.as(
        "sale_refunded_cents",
      ),
      sql<number>`(SELECT count(*)::int FROM grooming_notes n WHERE n.appointment_id = a.id)`.as(
        "note_count",
      ),
      sql<
        string | null
      >`(SELECT n.note FROM grooming_notes n WHERE n.pet_id = a.pet_id AND (n.appointment_id IS NULL OR n.appointment_id <> a.id) AND n.created_at < a.starts_at ORDER BY n.created_at DESC LIMIT 1)`.as(
        "last_note",
      ),
    ]);
  if (where.from) q = q.where("a.starts_at", ">=", where.from);
  if (where.to) q = q.where("a.starts_at", "<", where.to);
  if (where.ids) q = q.where("a.id", "in", where.ids);
  if (where.customerId) q = q.where("a.customer_id", "=", where.customerId);
  const rows = await q.where("a.status", "!=", "canceled").orderBy("a.starts_at").execute();
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const addons = await trx
    .selectFrom("appointment_addons")
    .select(["appointment_id", "service_id", "name"])
    .where("appointment_id", "in", ids)
    .orderBy("created_at")
    .execute();
  const petIds = rows.map((r) => r.pet_id).filter((x): x is string => !!x);
  const vacc = petIds.length
    ? await trx
        .selectFrom("vaccinations")
        .select(["pet_id", "vaccine", "expires_on"])
        .where("pet_id", "in", petIds)
        .execute()
    : [];
  return rows.map((r): AppointmentRow => {
    const ad = addons.filter((a) => a.appointment_id === r.id);
    const d = new Date(r.starts_at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return {
      id: r.id,
      status: r.status,
      staffId: r.staff_id,
      groomerName: r.groomer_name,
      customerId: r.customer_id,
      customerName: r.customer_name,
      customerPhone: r.customer_phone,
      petId: r.pet_id,
      petName: r.pet_name,
      species: r.species,
      breed: r.breed,
      allergies: r.allergies,
      coat: r.coat,
      temperament: r.temperament,
      size: r.size,
      serviceId: r.service_id,
      serviceName: r.service_name,
      addons: ad.map((a) => ({ serviceId: a.service_id, name: a.name })),
      label: [r.service_name, ...ad.map((a) => a.name)].join(" + "),
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      start: minutesOfDay(r.starts_at),
      end: minutesOfDay(r.ends_at),
      blockEnd: minutesOfDay(r.block_ends_at),
      priceCents: r.price_cents,
      notes: r.notes,
      source: r.source,
      saleId: r.sale_id,
      receiptNumber: r.receipt_number,
      saleRefundedCents: r.sale_refunded_cents,
      noteCount: r.note_count,
      lastNote: r.last_note,
      reach: reachOf(r),
      holdUntil: r.status === "held" ? r.hold_expires_at : null,
      deposit: r.deposit_id
        ? {
            id: r.deposit_id,
            amountCents: r.deposit_cents!,
            refundedCents: r.deposit_refunded_cents!,
            status: r.deposit_status!,
            paidAt: r.deposit_paid_at,
            url: r.deposit_status === "pending" ? r.deposit_url : null,
            keptReceiptNumber: r.deposit_kept_receipt,
          }
        : null,
      rabiesLapsed: rabiesLapsed(
        vacc
          .filter((v) => v.pet_id === r.pet_id)
          .map((v) => ({ vaccine: v.vaccine, expiresOn: v.expires_on })),
        day,
      ),
    };
  });
}

export interface DayGroomer {
  staffId: string;
  name: string;
  /** Minutes since midnight; null when they don't work this day but have appointments. */
  hours: { start: number; end: number } | null;
  timeOff: { start: number; end: number; note: string | null }[];
}

export interface GroomingDay {
  day: string;
  groomers: DayGroomer[];
  appointments: AppointmentRow[];
  summary: { appointments: number; inShop: number; ready: number; expectedCents: number };
}

export const groomingDay = defineHandler<{ day: string }, GroomingDay>({
  action: "grooming.view",
  run: (trx, _ctx, { day }) => loadDay(trx, day),
});

/** Seven days from a Monday, for the week view. */
export const groomingWeek = defineHandler<{ start: string }, { start: string; days: GroomingDay[] }>({
  action: "grooming.view",
  async run(trx, _ctx, { start }) {
    if (!isIsoDate(start)) throw new AppError("invalid", "Pick a week.");
    const days: GroomingDay[] = [];
    for (const d of weekDays(weekStart(start))) days.push(await loadDay(trx, d));
    return { start: weekStart(start), days };
  },
});

export async function loadDay(trx: Trx, day: string): Promise<GroomingDay> {
  await releaseHolds(trx);
  const { from, to, weekday } = dayBounds(day);
  const appointments = await appointmentRows(trx, { from, to });
  const staff = await trx
    .selectFrom("staff")
    .select(["id", "name", "grooms", "active"])
    .orderBy("name")
    .execute();
  const hours = await trx
    .selectFrom("groomer_hours")
    .select(["staff_id", "start_time", "end_time"])
    .where("weekday", "=", weekday)
    .execute();
  const off = await trx
    .selectFrom("time_off")
    .select(["staff_id", "starts_at", "ends_at", "note"])
    .where("starts_at", "<", to)
    .where("ends_at", ">", from)
    .execute();
  const busy = new Set(appointments.map((a) => a.staffId));
  const groomers: DayGroomer[] = staff
    .filter((s) => (s.grooms && s.active && hours.some((h) => h.staff_id === s.id)) || busy.has(s.id))
    .map((s) => {
      const h = hours.find((x) => x.staff_id === s.id);
      return {
        staffId: s.id,
        name: s.name,
        hours: h && s.grooms ? { start: timeToMinutes(h.start_time), end: timeToMinutes(h.end_time) } : null,
        timeOff: off
          .filter((t) => t.staff_id === s.id)
          .map((t) => ({
            start: t.starts_at <= from ? 0 : minutesOfDay(t.starts_at),
            end: t.ends_at >= to ? 24 * 60 : minutesOfDay(t.ends_at),
            note: t.note,
          })),
      };
    });
  const live = appointments.filter((a) => a.status !== "no_show");
  return {
    day,
    groomers,
    appointments,
    summary: {
      appointments: live.length,
      inShop: appointments.filter((a) => a.status === "checked_in" || a.status === "in_progress").length,
      ready: appointments.filter((a) => a.status === "ready").length,
      expectedCents: live.reduce((s, a) => s + a.priceCents, 0),
    },
  };
}

// ---- booking ----

export interface BookingInput {
  /** Send the customer a booking confirmation (default yes). */
  confirm?: boolean;
  customerId: string;
  petId: string;
  serviceId: string;
  addonIds: string[];
  staffId: string;
  day: string;
  /** "09:30" */
  start: string;
  /** Needed when the pet has no size on file; saved on the pet. */
  size?: PetSize | null;
  notes?: string;
  /** Book despite the warnings (outside hours, time off, rabies). */
  override?: boolean;
}

export interface BookingCheck {
  quote: Quote;
  size: PetSize;
  /** "9:00 AM – 11:10 AM" */
  when: string;
  /** Things to confirm with "Book anyway". */
  warnings: string[];
  /** Another appointment in the way: booking is refused. */
  clash: string | null;
}

interface Plan extends BookingCheck {
  startsAt: Date;
  endsAt: Date;
  blockEndsAt: Date;
  main: ServiceRow;
  addons: ServiceRow[];
  petName: string;
  setPetSize: boolean;
}

interface Slot {
  startsAt: Date;
  endsAt: Date;
  blockEndsAt: Date;
  /** "9:00 AM – 11:10 AM" */
  when: string;
  warnings: string[];
  clash: string | null;
}

/**
 * Whether a groomer can take a groom at a time: hours, time off and the pet's
 * rabies give warnings; another booking in the way (buffer included) is a clash.
 * Shared by booking, moving and the call-out.
 */
export async function checkSlot(
  trx: Trx,
  v: {
    groomer: { id: string; name: string };
    petId: string | null;
    petName: string;
    day: string;
    start: number;
    minutes: number;
    buffer: number;
    ignoreId: string | null;
  },
): Promise<Slot> {
  if (!isIsoDate(v.day)) throw new AppError("invalid", "Pick a day.");
  await releaseHolds(trx);
  const start = v.start;
  const end = start + v.minutes;
  const blockEnd = end + v.buffer;
  if (blockEnd > 24 * 60) throw new AppError("invalid", "That runs past midnight. Pick an earlier time.");
  const startsAt = atLocal(v.day, start);
  const endsAt = atLocal(v.day, end);
  const blockEndsAt = atLocal(v.day, blockEnd);
  const { groomer } = v;

  const warnings: string[] = [];
  const h = await trx
    .selectFrom("groomer_hours")
    .select(["start_time", "end_time"])
    .where("staff_id", "=", groomer.id)
    .where("weekday", "=", startsAt.getDay())
    .executeTakeFirst();
  const hours = h ? { start: timeToMinutes(h.start_time), end: timeToMinutes(h.end_time) } : null;
  if (!hours) warnings.push(`${groomer.name} doesn't work on this day.`);
  else if (!withinHours(start, end, hours))
    warnings.push(
      `This is outside ${groomer.name}'s hours (${clockText(hours.start)} – ${clockText(hours.end)}).`,
    );
  const off = await trx
    .selectFrom("time_off")
    .select(["note"])
    .where("staff_id", "=", groomer.id)
    .where("starts_at", "<", endsAt)
    .where("ends_at", ">", startsAt)
    .executeTakeFirst();
  if (off) warnings.push(`${groomer.name} has time off then${off.note ? ` (${off.note})` : ""}.`);
  if (v.petId) {
    const vacc = await trx
      .selectFrom("vaccinations")
      .select(["vaccine", "expires_on"])
      .where("pet_id", "=", v.petId)
      .execute();
    const rabies = vacc.find((x) => x.vaccine.trim().toLowerCase() === "rabies");
    if (rabies && rabiesLapsed([{ vaccine: rabies.vaccine, expiresOn: rabies.expires_on }], v.day))
      warnings.push(
        `${v.petName}'s rabies vaccination expired ${rabies.expires_on}. Ask for proof before the groom.`,
      );
  }

  let clashQ = trx
    .selectFrom("appointments")
    .select(["pet_name", "starts_at"])
    .where("staff_id", "=", groomer.id)
    .where("status", "not in", ["canceled", "no_show"])
    .where("starts_at", "<", blockEndsAt)
    .where("block_ends_at", ">", startsAt);
  if (v.ignoreId) clashQ = clashQ.where("id", "!=", v.ignoreId);
  const other = await clashQ.executeTakeFirst();
  const clash = other
    ? `${groomer.name} already has ${other.pet_name} at ${clockText(minutesOfDay(other.starts_at))}. Pick another time or groomer.`
    : null;
  return { startsAt, endsAt, blockEndsAt, when: `${clockText(start)} – ${clockText(end)}`, warnings, clash };
}

async function planBooking(trx: Trx, input: BookingInput, ignoreId: string | null): Promise<Plan> {
  if (!isIsoDate(input.day)) throw new AppError("invalid", "Pick a day.");
  const pet = await trx
    .selectFrom("pets")
    .select(["id", "name", "size", "customer_id"])
    .where("id", "=", input.petId)
    .executeTakeFirst();
  if (!pet || pet.customer_id !== input.customerId)
    throw new AppError("invalid", "Pick one of the customer's pets.");
  const size = (pet.size ?? input.size ?? null) as PetSize | null;
  if (!size || !(SIZES as readonly string[]).includes(size))
    throw new AppError("invalid", `Pick ${pet.name}'s size.`, { size: `Pick ${pet.name}'s size.` });

  const ids = [input.serviceId, ...input.addonIds];
  const rows = (await trx.selectFrom("services").selectAll().where("id", "in", ids).execute()).map(toService);
  const main = rows.find((s) => s.id === input.serviceId);
  if (!main || main.kind !== "main" || main.archived || !main.active)
    throw new AppError("invalid", "Pick a service that's on the menu.");
  const addons = input.addonIds.map((id) => {
    const a = rows.find((s) => s.id === id);
    if (!a || a.kind !== "addon" || a.archived || !a.active)
      throw new AppError("invalid", "An add-on isn't on the menu anymore.");
    return a;
  });
  const quote = quoteAppointment(rates(main), addons.map(rates), size);

  const groomer = await trx
    .selectFrom("staff")
    .select(["id", "name", "grooms", "active"])
    .where("id", "=", input.staffId)
    .executeTakeFirst();
  if (!groomer || !groomer.grooms || !groomer.active) throw new AppError("invalid", "Pick a groomer.");

  const slot = await checkSlot(trx, {
    groomer,
    petId: pet.id,
    petName: pet.name,
    day: input.day,
    start: timeToMinutes(input.start),
    minutes: quote.minutes,
    buffer: quote.bufferMinutes,
    ignoreId,
  });
  const { startsAt, endsAt, blockEndsAt, warnings, clash } = slot;

  return {
    quote,
    size,
    when: slot.when,
    warnings,
    clash,
    startsAt,
    endsAt,
    blockEndsAt,
    main,
    addons,
    petName: pet.name,
    setPetSize: !pet.size,
  };
}

/** What a booking would cost and take, and anything in the way. Nothing is saved. */
export const checkAppointment = defineHandler<BookingInput & { id?: string }, BookingCheck>({
  action: "grooming.book",
  async run(trx, _ctx, input) {
    const p = await planBooking(trx, input, input.id ?? null);
    return { quote: p.quote, size: p.size, when: p.when, warnings: p.warnings, clash: p.clash };
  },
});

function refuse(p: Plan, override: boolean | undefined) {
  if (p.clash) throw new AppError("conflict", p.clash);
  if (p.warnings.length && !override)
    throw new AppError("invalid", `${p.warnings.join(" ")} Tick "Book anyway" to go ahead.`);
}

/** Turns the database's double-booking refusal into the same plain message. */
async function saving<T>(
  trx: Trx,
  input: BookingInput,
  id: string | null,
  run: () => Promise<T>,
): Promise<T> {
  await sql`SAVEPOINT booking`.execute(trx);
  try {
    const r = await run();
    await sql`RELEASE SAVEPOINT booking`.execute(trx);
    return r;
  } catch (err) {
    await sql`ROLLBACK TO SAVEPOINT booking`.execute(trx);
    const e = err as { code?: string; message?: string };
    if (e?.code === "23P01" || e?.message?.includes("appointments_no_double_booking")) {
      const again = await planBooking(trx, input, id);
      throw new AppError(
        "conflict",
        again.clash ?? "That groomer is already booked then. Pick another time.",
      );
    }
    throw err;
  }
}

async function writeAddons(trx: Trx, ctx: Ctx, appointmentId: string, p: Plan) {
  await trx.deleteFrom("appointment_addons").where("appointment_id", "=", appointmentId).execute();
  for (const a of p.addons)
    await trx
      .insertInto("appointment_addons")
      .values({
        business_id: ctx.businessId,
        appointment_id: appointmentId,
        service_id: a.id,
        name: a.name,
        price_cents: a.priceCents[p.size],
        minutes: a.minutes[p.size],
      })
      .execute();
}

export const bookAppointment = defineHandler<
  BookingInput,
  AppointmentRow & { confirmation: NotifyResult | null }
>({
  action: "grooming.book",
  async run(trx, ctx, input) {
    const p = await planBooking(trx, input, null);
    refuse(p, input.override);
    if (p.setPetSize)
      await trx.updateTable("pets").set({ size: p.size }).where("id", "=", input.petId).execute();
    const locationId = await currentLocationId(trx);
    const row = await saving(trx, input, null, () =>
      trx
        .insertInto("appointments")
        .values({
          business_id: ctx.businessId,
          location_id: locationId,
          customer_id: input.customerId,
          pet_id: input.petId,
          staff_id: input.staffId,
          service_id: p.main.id,
          service_name: p.main.name,
          pet_name: p.petName,
          size: p.size,
          starts_at: p.startsAt,
          ends_at: p.endsAt,
          block_ends_at: p.blockEndsAt,
          price_cents: p.quote.priceCents,
          notes: input.notes?.trim() || null,
          created_by: ctx.staffId,
        })
        .returning("id")
        .executeTakeFirstOrThrow(),
    );
    await writeAddons(trx, ctx, row.id, p);
    const confirmation = input.confirm === false ? null : await confirmBooking(trx, ctx, row.id);
    return { ...(await appointmentRows(trx, { ids: [row.id] }))[0]!, confirmation };
  },
});

export const updateAppointment = defineHandler<BookingInput & { id: string }, AppointmentRow>({
  action: "grooming.book",
  async run(trx, ctx, input) {
    const a = await trx
      .selectFrom("appointments")
      .select(["status"])
      .where("id", "=", input.id)
      .forUpdate()
      .executeTakeFirst();
    if (!a) throw new AppError("not_found", "That appointment doesn't exist.");
    if (["done", "canceled", "no_show"].includes(a.status))
      throw new AppError("invalid", "This appointment can't be changed anymore.");
    const p = await planBooking(trx, input, input.id);
    refuse(p, input.override);
    if (p.setPetSize)
      await trx.updateTable("pets").set({ size: p.size }).where("id", "=", input.petId).execute();
    await saving(trx, input, input.id, () =>
      trx
        .updateTable("appointments")
        .set({
          customer_id: input.customerId,
          pet_id: input.petId,
          staff_id: input.staffId,
          service_id: p.main.id,
          service_name: p.main.name,
          pet_name: p.petName,
          size: p.size,
          starts_at: p.startsAt,
          ends_at: p.endsAt,
          block_ends_at: p.blockEndsAt,
          price_cents: p.quote.priceCents,
          notes: input.notes?.trim() || null,
        })
        .where("id", "=", input.id)
        .execute(),
    );
    await writeAddons(trx, ctx, input.id, p);
    return (await appointmentRows(trx, { ids: [input.id] }))[0]!;
  },
});

const STAMP: Partial<Record<ApptStatus, "checked_in_at" | "started_at" | "ready_at" | "done_at">> = {
  checked_in: "checked_in_at",
  in_progress: "started_at",
  ready: "ready_at",
  done: "done_at",
};

/** Moves an appointment along (or back one step). Groomers can start a groom and mark it ready. */
export const setAppointmentStatus = defineHandler<
  { id: string; status: ApptStatus; keepDeposit?: boolean },
  AppointmentRow
>({
  action: "grooming.view",
  async run(trx, ctx, { id, status, keepDeposit }) {
    const a = await trx
      .selectFrom("appointments")
      .select(["status", "staff_id", "deposit_id"])
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!a) throw new AppError("not_found", "That appointment doesn't exist.");
    if (!canStep(a.status, status, ctx.role))
      throw new AppError("forbidden", "You can't make that change to this appointment.");
    const now = new Date();
    const order: ApptStatus[] = ["booked", "checked_in", "in_progress", "ready", "done"];
    const set: Record<string, Date | null | string> = { status };
    const stamp = STAMP[status];
    if (stamp && order.indexOf(status) > order.indexOf(a.status)) set[stamp] = now;
    // Going back a step clears the step undone.
    const undone = STAMP[a.status];
    if (undone && order.indexOf(status) < order.indexOf(a.status)) set[undone] = null;
    try {
      await trx.updateTable("appointments").set(set).where("id", "=", id).execute();
    } catch (err) {
      const e = err as { code?: string };
      if (e?.code === "23P01")
        throw new AppError(
          "conflict",
          "Someone else is booked in that slot now, so this can't go back to booked.",
        );
      throw err;
    }
    if (status === "no_show" && a.deposit_id) await noShowDeposit(trx, ctx, a.deposit_id, keepDeposit);
    if (a.status === "no_show" && a.deposit_id) await undoNoShowDeposit(trx, a.deposit_id);
    // Back-bar supplies come off when the groom is finished, and go back if that's undone.
    if (status === "ready" || status === "done") await useSupplies(trx, ctx, id);
    if (status === "ready") await readyText(trx, ctx, id);
    else if (a.status === "ready") await returnSupplies(trx, ctx, id);
    return (await appointmentRows(trx, { ids: [id] }))[0]!;
  },
});

/** A paid deposit on a no-show: kept as a fee (the store's default) or refunded. */
async function noShowDeposit(trx: Trx, ctx: Ctx, depositId: string, keep: boolean | undefined) {
  const b = await trx
    .selectFrom("businesses")
    .select("deposit_no_show")
    .where("id", "=", ctx.businessId)
    .executeTakeFirstOrThrow();
  const d = await trx.selectFrom("deposits").select("status").where("id", "=", depositId).executeTakeFirst();
  if (d?.status === "pending") return void (await refundDeposit(trx, ctx, depositId, "no-show"));
  if (d?.status !== "paid") return;
  if (keep ?? b.deposit_no_show === "keep") await keepDeposit(trx, ctx, depositId, "No-show fee");
  else await refundDeposit(trx, ctx, depositId, "no-show, refunded");
}

/** Undoing a no-show: a kept fee has to be refunded first, so the money isn't taken twice. */
async function undoNoShowDeposit(trx: Trx, depositId: string) {
  const d = await trx
    .selectFrom("deposits as d")
    .leftJoin("sales as s", "s.id", "d.kept_sale_id")
    .select(["d.status", "s.receipt_number", "s.total_cents", "s.refunded_cents"])
    .where("d.id", "=", depositId)
    .executeTakeFirst();
  if (d?.status === "kept" && (d.refunded_cents ?? 0) < (d.total_cents ?? 0))
    throw new AppError(
      "invalid",
      `The deposit was kept as a no-show fee (receipt #${d.receipt_number}). Refund that sale first, then undo the no-show.`,
    );
}

export const cancelAppointment = defineHandler<{ id: string; refundDeposit?: boolean }, void>({
  action: "grooming.book",
  async run(trx, ctx, { id, refundDeposit: giveBack }) {
    const a = await trx
      .selectFrom("appointments")
      .select(["status", "deposit_id"])
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!a) throw new AppError("not_found", "That appointment doesn't exist.");
    if (a.status === "done")
      throw new AppError("invalid", "This groom is done and paid. Refund the sale instead.");
    if (a.status === "canceled") return;
    await trx
      .updateTable("appointments")
      .set({ status: "canceled", canceled_at: new Date(), hold_expires_at: null })
      .where("id", "=", id)
      .execute();
    if (!a.deposit_id) return;
    const d = await trx
      .selectFrom("deposits")
      .select("status")
      .where("id", "=", a.deposit_id)
      .executeTakeFirst();
    if (d?.status === "paid" && giveBack === false)
      await keepDeposit(trx, ctx, a.deposit_id, "Cancellation fee");
    else await refundDeposit(trx, ctx, a.deposit_id, "canceled by the store");
  },
});

/** Upcoming appointments for the customer profile. */
export const customerAppointments = defineHandler<{ customerId: string }, AppointmentRow[]>({
  action: "customers.view",
  async run(trx, _ctx, { customerId }) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const rows = await appointmentRows(trx, { customerId, from: today });
    return rows.filter((r) => r.status !== "done" && r.status !== "no_show");
  },
});

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** For the customer delete: cancels their upcoming appointments (today on, not yet started) and refunds deposits. */
export async function cancelUpcomingFor(trx: Trx, ctx: Ctx, customerId: string): Promise<number> {
  const rows = await trx
    .updateTable("appointments")
    .set({ status: "canceled", canceled_at: new Date(), hold_expires_at: null })
    .where("customer_id", "=", customerId)
    .where("starts_at", ">=", startOfToday())
    .where("status", "in", ["held", "booked", "checked_in"])
    .returning("id")
    .execute();
  await refundDepositsFor(
    trx,
    ctx,
    rows.map((r) => r.id),
    "customer deleted",
  );
  return rows.length;
}

export async function countUpcomingFor(trx: Trx, customerId: string): Promise<number> {
  const r = await trx
    .selectFrom("appointments")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("customer_id", "=", customerId)
    .where("starts_at", ">=", startOfToday())
    .where("status", "in", ["booked", "checked_in"])
    .executeTakeFirstOrThrow();
  return r.n;
}

// ---- busy-day tools (3c) ----

/** The ready-for-pickup message: once per appointment, when the store has it on. */
async function readyText(trx: Trx, ctx: Ctx, id: string) {
  const b = await trx
    .selectFrom("businesses")
    .select(["text_when_ready"])
    .where("id", "=", ctx.businessId)
    .executeTakeFirstOrThrow();
  if (b.text_when_ready) await notify(trx, ctx, id, "ready");
}

export interface AppointmentMessage {
  id: string;
  kind: MessageKind;
  channel: "sms" | "email";
  to: string;
  subject: string | null;
  body: string;
  status: "preview" | "queued" | "sent" | "failed";
  createdAt: Date;
}

export const MESSAGE_COLUMNS = [
  "id",
  "kind",
  "channel",
  "to_address as to",
  "subject",
  "body",
  "status",
  "created_at as createdAt",
] as const;

export const appointmentMessages = defineHandler<{ appointmentId: string }, AppointmentMessage[]>({
  action: "grooming.view",
  async run(trx, _ctx, { appointmentId }) {
    return trx
      .selectFrom("appointment_messages")
      .select(MESSAGE_COLUMNS)
      .where("appointment_id", "=", appointmentId)
      .orderBy("created_at")
      .execute();
  },
});

export function localDay(d: Date): string {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

/** Tells the customer their groom moved or was canceled, by text or email (a preview in the demo). */
export const textAppointment = defineHandler<{ id: string; kind: "moved" | "canceled" }, AppointmentMessage>({
  action: "grooming.book",
  async run(trx, ctx, { id, kind }) {
    const r = await notify(trx, ctx, id, kind);
    if ("skipped" in r) throw new AppError("invalid", `Nothing was sent: ${r.skipped}.`);
    const rows = await trx
      .selectFrom("appointment_messages")
      .select(MESSAGE_COLUMNS)
      .where("appointment_id", "=", id)
      .orderBy("created_at", "desc")
      .limit(1)
      .execute();
    return rows[0]!;
  },
});

export interface MoveResult {
  appointment: AppointmentRow;
  /** Where it was, so Undo can put it back. */
  from: { staffId: string; day: string; start: number };
  /** The day or time changed (a groomer swap alone doesn't need a text). */
  timeChanged: boolean;
}

/**
 * Moves an appointment to another groomer or time, keeping its services, price and
 * length. Warnings (outside hours, time off, rabies) need override, as with booking.
 */
export const moveAppointment = defineHandler<
  { id: string; staffId: string; day: string; start: number; override?: boolean },
  MoveResult
>({
  action: "grooming.book",
  async run(trx, _ctx, input) {
    const a = await trx
      .selectFrom("appointments")
      .select(["id", "status", "staff_id", "pet_id", "pet_name", "starts_at", "ends_at", "block_ends_at"])
      .where("id", "=", input.id)
      .forUpdate()
      .executeTakeFirst();
    if (!a) throw new AppError("not_found", "That appointment doesn't exist.");
    if (a.status !== "booked" && a.status !== "checked_in")
      throw new AppError("invalid", `${a.pet_name}'s groom has started, so it can't be moved.`);
    const groomer = await trx
      .selectFrom("staff")
      .select(["id", "name", "grooms", "active"])
      .where("id", "=", input.staffId)
      .executeTakeFirst();
    if (!groomer || !groomer.grooms || !groomer.active) throw new AppError("invalid", "Pick a groomer.");
    requireInt(input.start, "Start time", { min: 0, max: 24 * 60 - 1 });
    const minutes = Math.round((a.ends_at.getTime() - a.starts_at.getTime()) / 60000);
    const buffer = Math.round((a.block_ends_at.getTime() - a.ends_at.getTime()) / 60000);
    const slot = await checkSlot(trx, {
      groomer,
      petId: a.pet_id,
      petName: a.pet_name,
      day: input.day,
      start: input.start,
      minutes,
      buffer,
      ignoreId: a.id,
    });
    if (slot.clash) throw new AppError("conflict", slot.clash);
    if (slot.warnings.length && !input.override)
      throw new AppError("invalid", `${slot.warnings.join(" ")} Move it anyway?`, {
        warnings: slot.warnings.join(" "),
      });
    try {
      await sql`SAVEPOINT move`.execute(trx);
      await trx
        .updateTable("appointments")
        .set({
          staff_id: groomer.id,
          starts_at: slot.startsAt,
          ends_at: slot.endsAt,
          block_ends_at: slot.blockEndsAt,
        })
        .where("id", "=", a.id)
        .execute();
      await sql`RELEASE SAVEPOINT move`.execute(trx);
    } catch (err) {
      await sql`ROLLBACK TO SAVEPOINT move`.execute(trx);
      if ((err as { code?: string })?.code === "23P01")
        throw new AppError("conflict", `${groomer.name} is already booked then. Pick another time.`);
      throw err;
    }
    const fromDay = localDay(a.starts_at);
    const fromStart = minutesOfDay(a.starts_at);
    return {
      appointment: (await appointmentRows(trx, { ids: [a.id] }))[0]!,
      from: { staffId: a.staff_id, day: fromDay, start: fromStart },
      timeChanged: fromDay !== input.day || fromStart !== input.start,
    };
  },
});

// ---- a groomer calls out ----

export interface CalloutRow {
  appointment: AppointmentRow;
  /** Another groomer free at the same time, or null when it needs a new time. */
  suggestion: { staffId: string; name: string } | null;
}

async function dayGroomers(trx: Trx, day: string, exceptStaffId: string): Promise<CalloutGroomer[]> {
  const d = await loadDay(trx, day);
  const staff = await trx
    .selectFrom("staff")
    .select(["id", "name"])
    .where("grooms", "=", true)
    .where("active", "=", true)
    .where("id", "!=", exceptStaffId)
    .orderBy("name")
    .execute();
  return staff.map((st) => {
    const g = d.groomers.find((x) => x.staffId === st.id);
    return {
      staffId: st.id,
      name: st.name,
      hours: g?.hours ?? null,
      timeOff: g?.timeOff.map((t) => ({ start: t.start, end: t.end })) ?? [],
      busy: d.appointments
        .filter((a) => a.staffId === st.id && a.status !== "no_show")
        .map((a) => ({ start: a.start, end: a.blockEnd })),
    };
  });
}

export const calloutPreview = defineHandler<{ staffId: string; day: string }, CalloutRow[]>({
  action: "grooming.book",
  async run(trx, _ctx, { staffId, day }) {
    const d = await loadDay(trx, day);
    const mine = d.appointments.filter(
      (a) => a.staffId === staffId && (a.status === "booked" || a.status === "checked_in"),
    );
    const suggestions = suggestCallout(
      mine.map((a) => ({ id: a.id, start: a.start, end: a.end, blockEnd: a.blockEnd })),
      await dayGroomers(trx, day, staffId),
    );
    return mine.map((a) => {
      const s = suggestions.find((x) => x.appointmentId === a.id)!;
      return { appointment: a, suggestion: s.staffId ? { staffId: s.staffId, name: s.name! } : null };
    });
  },
});

export interface CalloutChange {
  id: string;
  action: "move" | "leave" | "cancel";
  staffId?: string;
  day?: string;
  start?: number;
}

export interface CalloutResult {
  moved: number;
  canceled: number;
  left: number;
  texts: number;
}

/**
 * Applies a call-out in one transaction: moves, cancels and leaves, all-day time off
 * for the groomer, texts to customers whose groom changed, and one audit entry.
 * A clash anywhere rolls the whole thing back.
 */
export const applyCallout = defineHandler<
  { staffId: string; day: string; changes: CalloutChange[]; notify: boolean; addTimeOff: boolean },
  CalloutResult
>({
  action: "grooming.book",
  async run(trx, ctx, { staffId, day, changes, notify: tell, addTimeOff: off }) {
    if (!isIsoDate(day)) throw new AppError("invalid", "Pick a day.");
    const out: CalloutResult = { moved: 0, canceled: 0, left: 0, texts: 0 };
    const log: Record<string, unknown>[] = [];
    for (const c of changes) {
      const a = await trx
        .selectFrom("appointments as a")
        .leftJoin("customers as cu", "cu.id", "a.customer_id")
        .select([
          "a.id",
          "a.status",
          "a.staff_id",
          "a.pet_id",
          "a.pet_name",
          "a.starts_at",
          "a.ends_at",
          "a.block_ends_at",
          "cu.phone",
        ])
        .where("a.id", "=", c.id)
        .forUpdate("a")
        .executeTakeFirst();
      if (!a || a.staff_id !== staffId)
        throw new AppError("invalid", "An appointment in the list isn't this groomer's anymore.");
      if (c.action === "leave") {
        out.left++;
        continue;
      }
      if (a.status !== "held" && a.status !== "booked" && a.status !== "checked_in")
        throw new AppError("invalid", `${a.pet_name}'s groom has started, so it can't be changed here.`);
      if (c.action === "cancel") {
        await trx
          .updateTable("appointments")
          .set({ status: "canceled", canceled_at: new Date(), hold_expires_at: null })
          .where("id", "=", a.id)
          .execute();
        await refundDepositsFor(trx, ctx, [a.id], "groomer called out");
        out.canceled++;
        log.push({ id: a.id, pet: a.pet_name, action: "cancel" });
        if (tell && "sent" in (await notify(trx, ctx, a.id, "canceled"))) out.texts++;
        continue;
      }
      const groomer = await trx
        .selectFrom("staff")
        .select(["id", "name", "grooms", "active"])
        .where("id", "=", c.staffId ?? "")
        .executeTakeFirst();
      if (!groomer || !groomer.grooms || !groomer.active)
        throw new AppError("invalid", `Pick a groomer for ${a.pet_name}.`);
      const toDay = c.day ?? day;
      const toStart = c.start ?? minutesOfDay(a.starts_at);
      const minutes = Math.round((a.ends_at.getTime() - a.starts_at.getTime()) / 60000);
      const buffer = Math.round((a.block_ends_at.getTime() - a.ends_at.getTime()) / 60000);
      const slot = await checkSlot(trx, {
        groomer,
        petId: a.pet_id,
        petName: a.pet_name,
        day: toDay,
        start: toStart,
        minutes,
        buffer,
        ignoreId: a.id,
      });
      if (slot.clash) throw new AppError("conflict", `${a.pet_name}: ${slot.clash} Nothing was changed.`);
      await trx
        .updateTable("appointments")
        .set({
          staff_id: groomer.id,
          starts_at: slot.startsAt,
          ends_at: slot.endsAt,
          block_ends_at: slot.blockEndsAt,
        })
        .where("id", "=", a.id)
        .execute();
      out.moved++;
      log.push({
        id: a.id,
        pet: a.pet_name,
        action: "move",
        to_staff: groomer.name,
        day: toDay,
        start: toStart,
      });
      if (tell && "sent" in (await notify(trx, ctx, a.id, "moved"))) out.texts++;
    }
    if (off) {
      const [y, m, d] = day.split("-").map(Number) as [number, number, number];
      const from = new Date(y, m - 1, d);
      const to = new Date(y, m - 1, d + 1);
      const has = await trx
        .selectFrom("time_off")
        .select("id")
        .where("staff_id", "=", staffId)
        .where("starts_at", "<=", from)
        .where("ends_at", ">=", to)
        .executeTakeFirst();
      if (!has)
        await trx
          .insertInto("time_off")
          .values({
            business_id: ctx.businessId,
            staff_id: staffId,
            starts_at: from,
            ends_at: to,
            note: "Called out",
          })
          .execute();
    }
    const who = await trx.selectFrom("staff").select("name").where("id", "=", staffId).executeTakeFirst();
    await audit(trx, ctx, {
      action: "grooming.callout",
      entity: "staff",
      entityId: staffId,
      after: { groomer: who?.name ?? null, day, ...out, changes: log, time_off: off },
    });
    return out;
  },
});
