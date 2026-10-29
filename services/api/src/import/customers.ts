import { sql } from "kysely";
import {
  normalizePhone,
  normalizeZip,
  parseLooseDate,
  parsePetsCell,
  parseSize,
  parseSpecies,
  parseYesNo,
  type PetSize,
  type Species,
} from "@pet-pos/core";
import { diff, Skip, text, type Row, type RowCtx, type RowResult } from "./base.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface PetIn {
  name: string;
  species: Species | null;
  breed: string | null;
  birthday?: string | null;
  size?: PetSize | null;
  allergies?: string | null;
  vet_name?: string | null;
}

/** A past date, or null with a warning. */
function pastDate(rc: RowCtx, raw: string | undefined, what: string): string | null | undefined {
  if (raw === undefined) return undefined;
  const d = parseLooseDate(raw, rc.today);
  if (d === null) return undefined;
  if (d === undefined) {
    rc.warn(`${what} "${raw}" isn't a date, left blank`);
    return undefined;
  }
  if (d > rc.today) {
    rc.warn(`${what} ${d} is in the future, left blank`);
    return undefined;
  }
  return d;
}

/** Finds a customer by phone, then email. Refuses a row whose phone and email point at two people. */
async function findCustomer(rc: RowCtx, phone: string | null, email: string | null) {
  const byPhone = phone
    ? await rc.trx.selectFrom("customers").selectAll().where("phone", "=", phone).executeTakeFirst()
    : undefined;
  const byEmail = email
    ? await rc.trx
        .selectFrom("customers")
        .selectAll()
        .where(sql`lower(email)`, "=", email.toLowerCase())
        .executeTakeFirst()
    : undefined;
  if (byPhone && byEmail && byPhone.id !== byEmail.id)
    throw new Skip("Phone and email belong to two different customers");
  return byPhone ?? byEmail;
}

/** Adds the pet, or updates the owner's pet with the same name (ignoring case). Returns whether it was new. */
async function upsertPet(
  rc: RowCtx,
  customerId: string,
  p: PetIn,
): Promise<{ id: string; created: boolean }> {
  const existing = await rc.trx
    .selectFrom("pets")
    .selectAll()
    .where("customer_id", "=", customerId)
    .where(sql`lower(name)`, "=", p.name.toLowerCase())
    .executeTakeFirst();
  const values = {
    species: p.species ?? undefined,
    breed: p.breed ?? undefined,
    birthday: p.birthday ?? undefined,
    size: p.size ?? undefined,
    allergies: p.allergies ?? undefined,
    vet_name: p.vet_name ?? undefined,
  };
  if (existing) {
    const d = diff(existing, values);
    if (d) {
      await rc.trx.updateTable("pets").set(d.after).where("id", "=", existing.id).execute();
      await rc.changes.add("pet", existing.id, "updated", d.before, d.after);
    }
    return { id: existing.id, created: false };
  }
  const row = {
    name: p.name,
    species: p.species ?? "dog",
    breed: p.breed,
    birthday: p.birthday ?? null,
    size: p.size ?? null,
    allergies: p.allergies ?? null,
    vet_name: p.vet_name ?? null,
  };
  const { id } = await rc.trx
    .insertInto("pets")
    .values({
      ...row,
      business_id: rc.ctx.businessId,
      customer_id: customerId,
      import_batch_id: rc.changes.batchId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await rc.changes.add("pet", id, "created", null, row);
  return { id, created: true };
}

/** Pets from the "Pets" cell and from numbered columns (Pet 1 name, Pet 1 breed…). */
function petsInRow(r: Row, rc: RowCtx): PetIn[] {
  const pets: PetIn[] = parsePetsCell(r.pets ?? "").map((p) => ({ ...p }));
  const numbers = new Set(
    Object.keys(r)
      .map((k) => /^pet(\d+)\./.exec(k)?.[1])
      .filter((n): n is string => !!n),
  );
  for (const n of [...numbers].sort((a, b) => Number(a) - Number(b))) {
    const name = text(r[`pet${n}.name`]);
    if (!name) continue;
    const sp = parseSpecies(r[`pet${n}.type`] ?? "");
    pets.push({
      name,
      species: sp?.species ?? null,
      breed: text(r[`pet${n}.breed`]) ?? sp?.hint ?? null,
      birthday: pastDate(rc, r[`pet${n}.birthday`], `${name}'s birthday`) ?? null,
    });
  }
  const seen = new Set<string>();
  for (const p of pets) {
    const k = p.name.toLowerCase();
    if (seen.has(k)) throw new Skip(`Two pets named ${p.name} in this row`);
    seen.add(k);
  }
  return pets;
}

/** Customers and pets file. */
export async function customerRow(r: Row, rc: RowCtx): Promise<RowResult> {
  const name = (text(r.name) ?? [text(r.first), text(r.last)].filter(Boolean).join(" ")).trim();
  const phoneRaw = text(r.phone);
  const phone = normalizePhone(phoneRaw);
  if (phoneRaw && !phone) throw new Skip("Phone isn't 10 digits");
  let email = text(r.email) ?? null;
  if (email && !EMAIL.test(email)) {
    rc.warn(`Email "${email}" doesn't look like an email, left out`);
    email = null;
  }
  if (!phone && !email) throw new Skip("No phone or email");

  const existing = await findCustomer(rc, phone, email);
  if (!existing && !name) throw new Skip("No name");

  const values: Record<string, unknown> = {
    name: name || undefined,
    phone: phone ?? undefined,
    email: email ?? undefined,
    street: text(r.street),
    city: text(r.city),
    notes: text(r.notes),
  };
  const state = text(r.state);
  if (state) {
    if (/^[A-Za-z]{2}$/.test(state)) values.state = state.toUpperCase();
    else rc.warn(`State "${state}" isn't a 2-letter state, left blank`);
  }
  if (r.zip) {
    const zip = normalizeZip(r.zip);
    if (zip) values.zip = zip;
    else if (zip === undefined) rc.warn(`ZIP "${r.zip}" isn't a ZIP code, left blank`);
  }
  values.birthday = pastDate(rc, r.birthday, "Birthday");
  if (r.smsOptIn !== undefined) {
    const yes = parseYesNo(r.smsOptIn);
    if (yes === undefined) rc.warn(`SMS opt-in "${r.smsOptIn}" isn't yes or no, left as it was`);
    else if (yes !== null) {
      values.sms_opt_in = yes;
      if (yes) {
        values.sms_opt_in_at = new Date();
        values.sms_opt_in_source = "import";
      }
    }
  }
  const pets = petsInRow(r, rc);

  let customerId: string;
  let action: RowResult["action"];
  if (existing) {
    customerId = existing.id;
    action = "update";
    const d = diff(existing, values);
    if (d) {
      await rc.trx.updateTable("customers").set(d.after).where("id", "=", existing.id).execute();
      await rc.changes.add("customer", existing.id, "updated", d.before, d.after);
    }
  } else {
    const row = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    const inserted = await rc.trx
      .insertInto("customers")
      .values({
        ...row,
        name,
        business_id: rc.ctx.businessId,
        import_batch_id: rc.changes.batchId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    customerId = inserted.id;
    action = "new";
    await rc.changes.add("customer", customerId, "created", null, row);
  }
  for (const p of pets) await upsertPet(rc, customerId, p);

  const label = name || existing!.name;
  return { action, label: pets.length ? `${label} · ${pets.map((p) => p.name).join(", ")}` : label };
}

/** Pets file: one pet per row, attached to an existing owner. */
export async function petRow(r: Row, rc: RowCtx): Promise<RowResult> {
  const phoneRaw = text(r.ownerPhone);
  const phone = normalizePhone(phoneRaw);
  const email = text(r.ownerEmail) ?? null;
  if (!phone && !email) throw new Skip(phoneRaw ? "Owner phone isn't 10 digits" : "No owner phone or email");
  const owner = await findCustomer(rc, phone, email);
  if (!owner) throw new Skip("No customer with that phone or email");
  const name = text(r.petName);
  if (!name) throw new Skip("No pet name");

  const sp = parseSpecies(r.species ?? "");
  let size: PetSize | null | undefined;
  if (r.size) {
    size = parseSize(r.size);
    if (size === undefined) rc.warn(`Size "${r.size}" isn't S, M, L or XL, left blank`);
  }
  const pet = await upsertPet(rc, owner.id, {
    name,
    species: sp?.species ?? null,
    breed: text(r.breed) ?? sp?.hint ?? null,
    birthday: pastDate(rc, r.birthday, "Birthday") ?? null,
    size: size ?? null,
    allergies: text(r.allergies) ?? null,
    vet_name: text(r.vet) ?? null,
  });

  if (r.rabiesExpires) {
    const expires = parseLooseDate(r.rabiesExpires, rc.today);
    if (!expires) rc.warn(`Rabies expiry "${r.rabiesExpires}" isn't a date, left out`);
    else {
      const current = await rc.trx
        .selectFrom("vaccinations")
        .select(["id", "expires_on"])
        .where("pet_id", "=", pet.id)
        .where(sql`lower(vaccine)`, "=", "rabies")
        .executeTakeFirst();
      if (!current) {
        const { id } = await rc.trx
          .insertInto("vaccinations")
          .values({ business_id: rc.ctx.businessId, pet_id: pet.id, vaccine: "Rabies", expires_on: expires })
          .returning("id")
          .executeTakeFirstOrThrow();
        await rc.changes.add("vaccination", id, "created", null, { vaccine: "Rabies", expires_on: expires });
      } else if (current.expires_on !== expires) {
        await rc.trx
          .updateTable("vaccinations")
          .set({ expires_on: expires })
          .where("id", "=", current.id)
          .execute();
        await rc.changes.add(
          "vaccination",
          current.id,
          "updated",
          { expires_on: current.expires_on },
          { expires_on: expires },
        );
      }
    }
  }
  return { action: pet.created ? "new" : "update", label: `${name} · ${owner.name}` };
}
