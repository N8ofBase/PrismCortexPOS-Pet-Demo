import type { Transaction } from "kysely";
import {
  AppError,
  cleanCustomer,
  duplicatePetName,
  DUPLICATE_PET_MESSAGE,
  isIsoDate,
  isUniqueViolation,
  normalizePhone,
  todayIso,
  validateCustomer,
  type CustomerInput,
  type PetSize,
  type Species,
} from "@pet-pos/core";
import type { DB } from "@pet-pos/db";
import { defineHandler } from "../handler.ts";
import { audit, likePattern } from "../shared.ts";
import { cancelUpcomingFor, countUpcomingFor } from "./grooming.ts";

export interface PetSummary {
  id: string;
  name: string;
  species: Species;
  breed: string | null;
  birthday: string | null;
}

export interface PunchCard {
  programId: string;
  programName: string;
  balance: number;
  buyCount: number;
  rewardText: string;
}

export interface CustomerCard {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  birthday: string | null;
  pets: PetSummary[];
  punchCards: PunchCard[];
}

export interface Vaccination {
  id: string;
  vaccine: string;
  expiresOn: string;
}

export interface PetDetail extends PetSummary {
  size: PetSize | null;
  coat: string | null;
  weightLb: number | null;
  temperament: string | null;
  allergies: string | null;
  vetName: string | null;
  vaccinations: Vaccination[];
}

/** How the customer wants messages about their grooms (Phase 4c). */
export interface CustomerMessagePrefs {
  /** Text or email when they have both; null means text when they've agreed to texts. */
  contactPref: "text" | "email" | null;
  /** No "time for the next groom?" reminders. */
  nudgesOff: boolean;
  /** Unsubscribed from all email. */
  emailOff: boolean;
}

export interface CustomerProfile extends Omit<CustomerCard, "pets"> {
  smsOptIn: boolean;
  /** When and where they agreed to texts. */
  smsOptInAt: Date | null;
  smsOptInSource: "counter" | "online" | "import" | null;
  messages: CustomerMessagePrefs;
  notes: string | null;
  pets: PetDetail[];
}

export const CUSTOMER_COLUMNS = [
  "id",
  "name",
  "phone",
  "email",
  "street",
  "city",
  "state",
  "zip",
  "birthday",
] as const;

/** Adds pets and punch cards to customer rows (two queries, however many customers). */
export async function toCards(
  trx: Transaction<DB>,
  rows: Omit<CustomerCard, "pets" | "punchCards">[],
): Promise<CustomerCard[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const pets = await trx
    .selectFrom("pets")
    .select(["id", "customer_id", "name", "species", "breed", "birthday"])
    .where("customer_id", "in", ids)
    .orderBy("created_at")
    .orderBy("name")
    .execute();
  const cards = await punchCards(trx, ids);
  return rows.map((r) => ({
    ...r,
    pets: pets
      .filter((p) => p.customer_id === r.id)
      .map((p) => ({ id: p.id, name: p.name, species: p.species, breed: p.breed, birthday: p.birthday })),
    punchCards: cards.get(r.id) ?? [],
  }));
}

async function punchCards(trx: Transaction<DB>, customerIds: string[]): Promise<Map<string, PunchCard[]>> {
  const rows = await trx
    .selectFrom("astro_balances as b")
    .innerJoin("astro_programs as a", "a.id", "b.program_id")
    .select([
      "b.customer_id",
      "b.program_id as programId",
      "a.name as programName",
      "b.balance",
      "a.buy_count as buyCount",
      "a.reward_text as rewardText",
    ])
    .where("b.customer_id", "in", customerIds)
    .where("b.balance", ">", 0)
    .orderBy("a.name")
    .execute();
  const map = new Map<string, PunchCard[]>();
  for (const { customer_id, ...card } of rows) map.set(customer_id, [...(map.get(customer_id) ?? []), card]);
  return map;
}

/** Name, email or pet name; three or more digits also match anywhere in the phone. */
export const searchCustomers = defineHandler<{ q: string }, CustomerCard[]>({
  action: "customers.view",
  async run(trx, _ctx, { q }) {
    let query = trx.selectFrom("customers as c").select(CUSTOMER_COLUMNS.map((k) => `c.${k}` as const));
    const text = q.trim();
    if (text) {
      const pat = likePattern(text);
      const digits = text.replace(/\D/g, "");
      query = query.where((eb) =>
        eb.or([
          eb("c.name", "ilike", pat),
          eb("c.email", "ilike", pat),
          eb.exists(
            eb
              .selectFrom("pets as p")
              .select("p.id")
              .whereRef("p.customer_id", "=", "c.id")
              .where("p.name", "ilike", pat),
          ),
          ...(digits.length >= 3 ? [eb("c.phone", "like", `%${digits}%`)] : []),
        ]),
      );
    }
    const rows = await query.orderBy("c.name").limit(100).execute();
    return toCards(trx, rows);
  },
});

/** Exact match on the phone, typed in any format. For the register (Phase 2). */
export const lookupByPhone = defineHandler<{ phone: string }, CustomerCard | null>({
  action: "customers.view",
  async run(trx, _ctx, { phone }) {
    const digits = normalizePhone(phone);
    if (!digits) return null;
    const row = await trx
      .selectFrom("customers")
      .select(CUSTOMER_COLUMNS)
      .where("phone", "=", digits)
      .executeTakeFirst();
    return row ? ((await toCards(trx, [row]))[0] ?? null) : null;
  },
});

export const getCustomer = defineHandler<{ id: string }, CustomerProfile>({
  action: "customers.view",
  async run(trx, _ctx, { id }) {
    const c = await trx
      .selectFrom("customers")
      .select([
        ...CUSTOMER_COLUMNS,
        "sms_opt_in",
        "sms_opt_in_at",
        "sms_opt_in_source",
        "contact_pref",
        "nudges_off",
        "email_off",
        "notes",
      ])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!c) throw new AppError("not_found", "That customer doesn't exist. They may have been deleted.");
    const pets = await trx
      .selectFrom("pets")
      .selectAll()
      .where("customer_id", "=", id)
      .orderBy("created_at")
      .orderBy("name")
      .execute();
    const vacc = pets.length
      ? await trx
          .selectFrom("vaccinations")
          .select(["id", "pet_id", "vaccine", "expires_on"])
          .where(
            "pet_id",
            "in",
            pets.map((p) => p.id),
          )
          .orderBy("vaccine")
          .execute()
      : [];
    const cards = await punchCards(trx, [id]);
    const {
      sms_opt_in,
      sms_opt_in_at,
      sms_opt_in_source,
      contact_pref,
      nudges_off,
      email_off,
      notes,
      ...rest
    } = c;
    return {
      ...rest,
      smsOptIn: sms_opt_in,
      smsOptInAt: sms_opt_in_at,
      smsOptInSource: sms_opt_in_source,
      messages: { contactPref: contact_pref, nudgesOff: nudges_off, emailOff: email_off },
      notes,
      punchCards: cards.get(id) ?? [],
      pets: pets.map((p) => ({
        id: p.id,
        name: p.name,
        species: p.species,
        breed: p.breed,
        birthday: p.birthday,
        size: p.size,
        coat: p.coat,
        weightLb: p.weight_lb,
        temperament: p.temperament,
        allergies: p.allergies,
        vetName: p.vet_name,
        vaccinations: vacc
          .filter((v) => v.pet_id === p.id)
          .map((v) => ({ id: v.id, vaccine: v.vaccine, expiresOn: v.expires_on })),
      })),
    };
  },
});

export interface PetRowInput {
  id?: string;
  name: string;
  species: Species;
  breed: string;
  birthday: string;
}

/**
 * Saves a customer and their pet rows together, as the form does. Rows with an id
 * update that pet, rows without one are added, and the customer's other pets are removed.
 */
export const saveCustomer = defineHandler<
  { id?: string; customer: CustomerInput; pets: PetRowInput[]; messages?: CustomerMessagePrefs },
  { id: string }
>({
  action: "customers.edit",
  async run(trx, ctx, input) {
    const errors = validateCustomer(input.customer);
    const first = Object.values(errors)[0];
    if (first) throw new AppError("invalid", first, errors as Record<string, string>);

    const pets = input.pets
      .map((p) => ({
        ...p,
        name: p.name.trim(),
        breed: p.breed.trim() || null,
        birthday: p.birthday.trim() || null,
      }))
      .filter((p) => p.name);
    const dup = duplicatePetName(pets.map((p) => p.name));
    if (dup) throw new AppError("invalid", dup, { pets: dup });
    for (const p of pets) {
      if (!["dog", "cat", "other"].includes(p.species))
        throw new AppError("invalid", `Pick Dog, Cat or Other for ${p.name}.`);
      if (p.birthday && (!isIsoDate(p.birthday) || p.birthday > todayIso()))
        throw new AppError("invalid", `${p.name}'s birthday isn't a real past date.`);
    }

    const c = cleanCustomer(input.customer);
    const values = {
      name: c.name,
      phone: c.phone,
      email: c.email,
      street: c.street,
      city: c.city,
      state: c.state,
      zip: c.zip,
      birthday: c.birthday,
      sms_opt_in: c.smsOptIn,
      notes: c.notes,
      ...(input.messages
        ? {
            contact_pref:
              input.messages.contactPref === "email" || input.messages.contactPref === "text"
                ? input.messages.contactPref
                : null,
            nudges_off: !!input.messages.nudgesOff,
            email_off: !!input.messages.emailOff,
          }
        : {}),
    };
    // Record when and where they agreed to texts (for the 10DLC campaign).
    const was = input.id
      ? await trx.selectFrom("customers").select("sms_opt_in").where("id", "=", input.id).executeTakeFirst()
      : undefined;
    const consent =
      c.smsOptIn && !was?.sms_opt_in
        ? { sms_opt_in_at: new Date(), sms_opt_in_source: "counter" as const }
        : !c.smsOptIn
          ? { sms_opt_in_at: null, sms_opt_in_source: null }
          : {};

    try {
      let id = input.id;
      if (id) {
        const res = await trx
          .updateTable("customers")
          .set({ ...values, ...consent })
          .where("id", "=", id)
          .executeTakeFirst();
        if (res.numUpdatedRows === 0n)
          throw new AppError("not_found", "That customer doesn't exist anymore.");
      } else {
        id = (
          await trx
            .insertInto("customers")
            .values({ ...values, ...consent, business_id: ctx.businessId })
            .returning("id")
            .executeTakeFirstOrThrow()
        ).id;
      }

      const existing = await trx.selectFrom("pets").select("id").where("customer_id", "=", id).execute();
      const keep = new Set(pets.filter((p) => p.id).map((p) => p.id!));
      for (const p of pets.filter((p) => p.id)) {
        if (!existing.some((e) => e.id === p.id))
          throw new AppError("invalid", `${p.name} isn't this customer's pet.`);
      }
      const removed = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
      if (removed.length) await trx.deleteFrom("pets").where("id", "in", removed).execute();
      for (const p of pets) {
        const pv = { name: p.name, species: p.species, breed: p.breed, birthday: p.birthday };
        if (p.id) await trx.updateTable("pets").set(pv).where("id", "=", p.id).execute();
        else
          await trx
            .insertInto("pets")
            .values({ ...pv, business_id: ctx.businessId, customer_id: id })
            .execute();
      }
      return { id };
    } catch (err) {
      if (isUniqueViolation(err, "customers_phone_per_business"))
        throw new AppError("conflict", "Another customer already has that phone number.", {
          phone: "Another customer already has that phone number.",
        });
      if (isUniqueViolation(err, "customers_email_per_business"))
        throw new AppError("conflict", "Another customer already has that email.", {
          email: "Another customer already has that email.",
        });
      if (isUniqueViolation(err, "pets_name_per_customer"))
        throw new AppError("conflict", DUPLICATE_PET_MESSAGE, { pets: DUPLICATE_PET_MESSAGE });
      throw err;
    }
  },
});

export interface PetDetailsInput {
  petId: string;
  size: PetSize | null;
  coat: string;
  weightLb: number | null;
  temperament: string;
  allergies: string;
  vetName: string;
}

export const savePetDetails = defineHandler<PetDetailsInput, void>({
  action: "customers.edit",
  async run(trx, _ctx, p) {
    if (p.size && !["S", "M", "L", "XL"].includes(p.size))
      throw new AppError("invalid", "Pick a size: S, M, L or XL.");
    if (p.weightLb !== null && (!Number.isFinite(p.weightLb) || p.weightLb <= 0 || p.weightLb > 999))
      throw new AppError("invalid", "Weight must be between 0 and 999 lb.");
    const t = (s: string) => s.trim() || null;
    const res = await trx
      .updateTable("pets")
      .set({
        size: p.size,
        coat: t(p.coat),
        weight_lb: p.weightLb === null ? null : Math.round(p.weightLb * 10) / 10,
        temperament: t(p.temperament),
        allergies: t(p.allergies),
        vet_name: t(p.vetName),
      })
      .where("id", "=", p.petId)
      .executeTakeFirst();
    if (res.numUpdatedRows === 0n) throw new AppError("not_found", "That pet doesn't exist anymore.");
  },
});

/** Replaces a pet's vaccination list: one current expiry date per vaccine. */
export const saveVaccinations = defineHandler<
  { petId: string; rows: { vaccine: string; expiresOn: string }[] },
  void
>({
  action: "customers.edit",
  async run(trx, ctx, { petId, rows }) {
    const pet = await trx.selectFrom("pets").select("id").where("id", "=", petId).executeTakeFirst();
    if (!pet) throw new AppError("not_found", "That pet doesn't exist anymore.");
    const clean = rows
      .map((r) => ({ vaccine: r.vaccine.trim(), expiresOn: r.expiresOn.trim() }))
      .filter((r) => r.vaccine || r.expiresOn);
    const seen = new Set<string>();
    for (const r of clean) {
      if (!r.vaccine) throw new AppError("invalid", "Each row needs a vaccine name.");
      if (!isIsoDate(r.expiresOn)) throw new AppError("invalid", `Enter the date ${r.vaccine} expires.`);
      const k = r.vaccine.toLowerCase();
      if (seen.has(k))
        throw new AppError("invalid", `${r.vaccine} is listed twice. Keep the latest expiry only.`);
      seen.add(k);
    }
    await trx.deleteFrom("vaccinations").where("pet_id", "=", petId).execute();
    if (clean.length)
      await trx
        .insertInto("vaccinations")
        .values(
          clean.map((r) => ({
            business_id: ctx.businessId,
            pet_id: petId,
            vaccine: r.vaccine,
            expires_on: r.expiresOn,
          })),
        )
        .execute();
  },
});

export interface DeletePreview {
  name: string;
  petNames: string[];
  punchCards: number;
  vaccinations: number;
  /** Upcoming appointments that deleting will cancel. */
  appointments: number;
}

async function preview(trx: Transaction<DB>, id: string): Promise<DeletePreview> {
  const c = await trx.selectFrom("customers").select("name").where("id", "=", id).executeTakeFirst();
  if (!c) throw new AppError("not_found", "That customer doesn't exist. They may have been deleted.");
  const pets = await trx
    .selectFrom("pets")
    .select(["id", "name"])
    .where("customer_id", "=", id)
    .orderBy("created_at")
    .orderBy("name")
    .execute();
  const vaccinations = pets.length
    ? await trx
        .selectFrom("vaccinations")
        .select("id")
        .where(
          "pet_id",
          "in",
          pets.map((p) => p.id),
        )
        .execute()
    : [];
  const cards = await punchCards(trx, [id]);
  return {
    name: c.name,
    petNames: pets.map((p) => p.name),
    punchCards: cards.get(id)?.length ?? 0,
    vaccinations: vaccinations.length,
    appointments: await countUpcomingFor(trx, id),
  };
}

/** What a delete removes, for the warning before the typed confirmation. */
export const deletePreview = defineHandler<{ id: string }, DeletePreview>({
  action: "customers.delete",
  async run(trx, _ctx, { id }) {
    return preview(trx, id);
  },
});

/**
 * Deletes the customer, their pets, vaccinations and punch cards. The audit entry
 * keeps the name and counts only, never contact details.
 */
export const deleteCustomer = defineHandler<{ id: string }, void>({
  action: "customers.delete",
  async run(trx, ctx, { id }) {
    const p = await preview(trx, id);
    await cancelUpcomingFor(trx, ctx, id);
    await trx.deleteFrom("customers").where("id", "=", id).execute();
    await audit(trx, ctx, {
      action: "customer.delete",
      entity: "customer",
      entityId: id,
      before: {
        name: p.name,
        pets: p.petNames.length,
        punch_cards: p.punchCards,
        vaccinations: p.vaccinations,
        appointments_canceled: p.appointments,
      },
    });
  },
});
