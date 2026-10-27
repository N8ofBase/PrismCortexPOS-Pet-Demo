// Grooming notes and photos, the pet's grooming history, back-bar supplies per
// service, and the grooms waiting to be paid at the register.
import { sql, type Transaction } from "kysely";
import { AppError, can, SIZES, todayIso, type Ctx, type PetSize } from "@pet-pos/core";
import type { DB } from "@pet-pos/db";
import { paidDeposits } from "../deposits.ts";
import { defineHandler } from "../handler.ts";
import { requireInt } from "../shared.ts";

// ---- notes and photos ----

/** Largest photo data URL accepted (the browser resizes to 1280 px JPEG first). */
export const MAX_PHOTO_CHARS = 400_000;
export const MAX_PHOTOS = 6;

export interface PhotoInput {
  kind: "before" | "after";
  /** data:image/jpeg;base64,… */
  data: string;
  width: number;
  height: number;
}

export interface GroomingPhoto {
  id: string;
  kind: "before" | "after";
  src: string | null;
  width: number;
  height: number;
}

export interface GroomingNote {
  id: string;
  appointmentId: string | null;
  staffId: string | null;
  staffName: string | null;
  note: string;
  createdAt: Date;
  photos: GroomingPhoto[];
  /** The signed-in staff member can delete it. */
  canDelete: boolean;
}

export const addGroomingNote = defineHandler<
  { appointmentId: string; note: string; photos: PhotoInput[] },
  GroomingNote
>({
  action: "grooming.notes",
  async run(trx, ctx, { appointmentId, note, photos }) {
    const a = await trx
      .selectFrom("appointments")
      .select(["id", "pet_id", "status"])
      .where("id", "=", appointmentId)
      .executeTakeFirst();
    if (!a) throw new AppError("not_found", "That appointment doesn't exist.");
    if (!a.pet_id) throw new AppError("invalid", "This pet's record was deleted.");
    const text = note.trim();
    if (!text && !photos.length) throw new AppError("invalid", "Write a note or add a photo.");
    if (text.length > 2000) throw new AppError("invalid", "Keep the note under 2,000 characters.");
    if (photos.length > MAX_PHOTOS) throw new AppError("invalid", `Add up to ${MAX_PHOTOS} photos.`);
    for (const p of photos) {
      if (p.kind !== "before" && p.kind !== "after")
        throw new AppError("invalid", "Mark each photo Before or After.");
      if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(p.data) || p.data.length > MAX_PHOTO_CHARS)
        throw new AppError("invalid", "A photo is too large or isn't a JPEG. Take it again.");
      requireInt(p.width, "Photo width", { min: 1, max: 4000 });
      requireInt(p.height, "Photo height", { min: 1, max: 4000 });
    }
    const row = await trx
      .insertInto("grooming_notes")
      .values({
        business_id: ctx.businessId,
        pet_id: a.pet_id,
        appointment_id: a.id,
        staff_id: ctx.staffId,
        note: text,
      })
      .returning(["id", "created_at"])
      .executeTakeFirstOrThrow();
    if (photos.length)
      await trx
        .insertInto("grooming_photos")
        .values(
          photos.map((p) => ({
            business_id: ctx.businessId,
            note_id: row.id,
            kind: p.kind,
            image_data: p.data,
            width: p.width,
            height: p.height,
            // base64: 4 characters carry 3 bytes.
            bytes: Math.floor(((p.data.length - p.data.indexOf(",") - 1) * 3) / 4),
          })),
        )
        .execute();
    return (await notesWhere(trx, ctx, { ids: [row.id] }))[0]!;
  },
});

/** A note's author can delete it the same day; owners and managers any time. */
export const deleteGroomingNote = defineHandler<{ id: string }, void>({
  action: "grooming.notes",
  async run(trx, ctx, { id }) {
    const n = await trx
      .selectFrom("grooming_notes")
      .select(["staff_id", "created_at"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!n) throw new AppError("not_found", "That note doesn't exist.");
    if (!mayDelete(ctx.role, ctx.staffId, n.staff_id, n.created_at))
      throw new AppError(
        "forbidden",
        "Only the groomer who wrote it (the same day) or a manager can delete this note.",
      );
    await trx.deleteFrom("grooming_notes").where("id", "=", id).execute();
  },
});

function mayDelete(role: Ctx["role"], me: string, author: string | null, at: Date): boolean {
  if (role === "owner" || role === "manager") return true;
  const d = new Date(at);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return author === me && day === todayIso() && can(role, "grooming.notes");
}

type Trx = Transaction<DB>;

async function notesWhere(trx: Trx, ctx: Ctx, where: { ids?: string[]; appointmentIds?: string[] }) {
  let q = trx
    .selectFrom("grooming_notes as n")
    .leftJoin("staff as s", "s.id", "n.staff_id")
    .select(["n.id", "n.appointment_id", "n.staff_id", "s.name as staff_name", "n.note", "n.created_at"]);
  if (where.ids) q = q.where("n.id", "in", where.ids);
  if (where.appointmentIds) q = q.where("n.appointment_id", "in", where.appointmentIds);
  const notes = await q.orderBy("n.created_at").execute();
  if (!notes.length) return [];
  const photos = await trx
    .selectFrom("grooming_photos")
    .select(["id", "note_id", "kind", "image_data", "storage_key", "width", "height"])
    .where(
      "note_id",
      "in",
      notes.map((n) => n.id),
    )
    .orderBy("created_at")
    .execute();
  return notes.map((n): GroomingNote => ({
    id: n.id,
    appointmentId: n.appointment_id,
    staffId: n.staff_id,
    staffName: n.staff_name,
    note: n.note,
    createdAt: n.created_at,
    photos: photos
      .filter((p) => p.note_id === n.id)
      .map((p) => ({ id: p.id, kind: p.kind, src: p.image_data, width: p.width, height: p.height })),
    canDelete: mayDelete(ctx.role, ctx.staffId, n.staff_id, n.created_at),
  }));
}

export const appointmentNotes = defineHandler<{ appointmentId: string }, GroomingNote[]>({
  action: "customers.view",
  run: (trx, ctx, { appointmentId }) => notesWhere(trx, ctx, { appointmentIds: [appointmentId] }),
});

// ---- the pet's grooming history ----

export interface PetGroom {
  appointmentId: string;
  date: Date;
  label: string;
  groomerName: string;
  priceCents: number;
  status: string;
  receiptNumber: number | null;
  notes: GroomingNote[];
}

export interface PetGroomingHistory {
  grooms: PetGroom[];
  next: string | null;
}

const HISTORY_PAGE = 10;

/** Past and in-progress grooms for a pet, newest first, with notes and photos. */
export const petGroomingHistory = defineHandler<
  { petId: string; before?: string | null },
  PetGroomingHistory
>({
  action: "customers.view",
  async run(trx, ctx, { petId, before }) {
    let q = trx
      .selectFrom("appointments as a")
      .innerJoin("staff as st", "st.id", "a.staff_id")
      .select([
        "a.id",
        "a.starts_at",
        "a.service_name",
        "a.price_cents",
        "a.status",
        "st.name as groomer_name",
        sql<number | null>`(SELECT s.receipt_number FROM sales s WHERE s.id = a.sale_id)`.as(
          "receipt_number",
        ),
        sql<string>`(SELECT string_agg(x.name, ' + ' ORDER BY x.created_at) FROM appointment_addons x WHERE x.appointment_id = a.id)`.as(
          "addons",
        ),
      ])
      .where("a.pet_id", "=", petId)
      // Grooms that have started (checked in or later); booked ones are upcoming, not history.
      .where("a.status", "in", ["checked_in", "in_progress", "ready", "done"]);
    if (before) q = q.where("a.starts_at", "<", new Date(before));
    const rows = await q
      .orderBy("a.starts_at", "desc")
      .limit(HISTORY_PAGE + 1)
      .execute();
    const page = rows.slice(0, HISTORY_PAGE);
    const notes = page.length ? await notesWhere(trx, ctx, { appointmentIds: page.map((r) => r.id) }) : [];
    return {
      grooms: page.map((r) => ({
        appointmentId: r.id,
        date: r.starts_at,
        label: r.addons ? `${r.service_name} + ${r.addons}` : r.service_name,
        groomerName: r.groomer_name,
        priceCents: r.price_cents,
        status: r.status,
        receiptNumber: r.receipt_number,
        notes: notes.filter((n) => n.appointmentId === r.id),
      })),
      next: rows.length > HISTORY_PAGE ? new Date(page[page.length - 1]!.starts_at).toISOString() : null,
    };
  },
});

// ---- back-bar supplies per service ----

export interface ServiceSupply {
  productId: string;
  productName: string;
  unit: string | null;
  qty: Record<PetSize, number>;
}

export const listServiceSupplies = defineHandler<{ serviceId: string }, ServiceSupply[]>({
  action: "grooming.view",
  async run(trx, _ctx, { serviceId }) {
    const rows = await trx
      .selectFrom("service_supplies as x")
      .innerJoin("products as p", "p.id", "x.product_id")
      .select(["x.product_id", "p.name", "p.unit", "x.qty_s", "x.qty_m", "x.qty_l", "x.qty_xl"])
      .where("x.service_id", "=", serviceId)
      .orderBy("p.name")
      .execute();
    return rows.map((r) => ({
      productId: r.product_id,
      productName: r.name,
      unit: r.unit,
      qty: { S: r.qty_s, M: r.qty_m, L: r.qty_l, XL: r.qty_xl },
    }));
  },
});

export const saveServiceSupplies = defineHandler<
  { serviceId: string; supplies: { productId: string; qty: Record<PetSize, number> }[] },
  void
>({
  action: "grooming.manage",
  async run(trx, ctx, { serviceId, supplies }) {
    const s = await trx.selectFrom("services").select("id").where("id", "=", serviceId).executeTakeFirst();
    if (!s) throw new AppError("not_found", "That service doesn't exist.");
    const seen = new Set<string>();
    for (const x of supplies) {
      if (seen.has(x.productId)) throw new AppError("invalid", "Each supply can be listed once.");
      seen.add(x.productId);
      for (const z of SIZES) requireInt(x.qty[z], `Amount for size ${z}`, { min: 0, max: 10000 });
    }
    if (supplies.length) {
      const found = await trx
        .selectFrom("products")
        .select("id")
        .where(
          "id",
          "in",
          supplies.map((x) => x.productId),
        )
        .execute();
      if (found.length !== supplies.length)
        throw new AppError("invalid", "A supply isn't in Inventory anymore.");
    }
    await trx.deleteFrom("service_supplies").where("service_id", "=", serviceId).execute();
    if (supplies.length)
      await trx
        .insertInto("service_supplies")
        .values(
          supplies.map((x) => ({
            business_id: ctx.businessId,
            service_id: serviceId,
            product_id: x.productId,
            qty_s: x.qty.S,
            qty_m: x.qty.M,
            qty_l: x.qty.L,
            qty_xl: x.qty.XL,
          })),
        )
        .execute();
  },
});

// ---- grooms waiting at the register ----

export interface GroomToCheckOut {
  appointmentId: string;
  petName: string;
  label: string;
  status: string;
  priceCents: number;
  groomerName: string;
  /** A deposit paid online, taken off at checkout. */
  depositCents: number;
}

/** Today's grooms for a customer that aren't paid yet, for the register's customer box. */
export const groomsToCheckOut = defineHandler<{ customerId: string }, GroomToCheckOut[]>({
  action: "register.use",
  async run(trx, _ctx, { customerId }) {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    const rows = await trx
      .selectFrom("appointments as a")
      .innerJoin("staff as st", "st.id", "a.staff_id")
      .select([
        "a.id",
        "a.pet_name",
        "a.service_name",
        "a.status",
        "a.price_cents",
        "st.name as groomer_name",
        sql<string>`(SELECT string_agg(x.name, ' + ' ORDER BY x.created_at) FROM appointment_addons x WHERE x.appointment_id = a.id)`.as(
          "addons",
        ),
      ])
      .where("a.customer_id", "=", customerId)
      .where("a.status", "in", ["booked", "checked_in", "in_progress", "ready"])
      .where("a.starts_at", ">=", from)
      .where("a.starts_at", "<", to)
      .orderBy("a.starts_at")
      .execute();
    const deposits = await paidDeposits(
      trx,
      rows.map((r) => r.id),
    );
    return rows.map((r) => ({
      appointmentId: r.id,
      petName: r.pet_name,
      label: r.addons ? `${r.service_name} + ${r.addons}` : r.service_name,
      status: r.status,
      priceCents: r.price_cents,
      groomerName: r.groomer_name,
      depositCents: deposits.get(r.id) ?? 0,
    }));
  },
});
