import { sql, type Transaction } from "kysely";
import { AppError, isRole, isUniqueViolation, type Role } from "@pet-pos/core";
import type { DB } from "@pet-pos/db";
import { defineHandler } from "../handler.ts";

export interface Me {
  staff: { id: string; name: string; role: Role };
  business: {
    id: string;
    name: string;
    brandColor: string | null;
    logo: string | null;
    modules: Record<string, boolean>;
    astroDiscountsBeforeTax: boolean;
    /** Charge sales tax on grooming. */
    groomingTaxable: boolean;
    /** Text customers when their pet is ready. */
    textWhenReady: boolean;
    /** On a no-show, keep a paid deposit as a fee (or refund it). */
    keepDepositOnNoShow: boolean;
  };
  /** taxRateMpct: thousandths of a percent (8.875% = 8875). */
  location: { id: string; name: string; taxRateMpct: number } | null;
}

/** The signed-in staff member, their business and its first location. */
export const me = defineHandler<void, Me>({
  action: null,
  async run(trx, ctx) {
    const staff = await trx
      .selectFrom("staff")
      .select(["id", "name", "role", "active"])
      .where("id", "=", ctx.staffId)
      .executeTakeFirst();
    if (!staff || !staff.active)
      throw new AppError("forbidden", "This staff account isn't active. Ask the owner.");
    if (staff.role !== ctx.role) throw new AppError("forbidden", "Your role changed. Sign in again.");

    const business = await trx
      .selectFrom("businesses")
      .select([
        "id",
        "name",
        "brand_color",
        "logo_data",
        "modules",
        "astro_discounts_before_tax",
        "grooming_taxable",
        "text_when_ready",
        "deposit_no_show",
      ])
      .where("id", "=", ctx.businessId)
      .executeTakeFirstOrThrow();
    const location = await trx
      .selectFrom("locations")
      .select(["id", "name", "tax_rate_mpct"])
      .orderBy("created_at")
      .executeTakeFirst();

    return {
      staff: { id: staff.id, name: staff.name, role: staff.role },
      business: {
        id: business.id,
        name: business.name,
        brandColor: business.brand_color,
        logo: business.logo_data,
        modules: business.modules,
        astroDiscountsBeforeTax: business.astro_discounts_before_tax,
        groomingTaxable: business.grooming_taxable,
        textWhenReady: business.text_when_ready,
        keepDepositOnNoShow: business.deposit_no_show === "keep",
      },
      location: location
        ? { id: location.id, name: location.name, taxRateMpct: location.tax_rate_mpct }
        : null,
    };
  },
});

export interface StaffListItem {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  active: boolean;
}

export const listStaff = defineHandler<void, StaffListItem[]>({
  action: "staff.view",
  async run(trx) {
    return trx
      .selectFrom("staff")
      .select(["id", "name", "email", "role", "active"])
      .orderBy("active", "desc")
      .orderBy("name")
      .execute();
  },
});

export interface StaffInput {
  name: string;
  email: string;
  role: Role;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanStaff(input: StaffInput) {
  const name = input.name.trim();
  if (!name) throw new AppError("invalid", "Name is required.", { name: "Name is required." });
  const email = input.email.trim() || null;
  if (email && !EMAIL.test(email))
    throw new AppError("invalid", "Enter an email like name@example.com.", {
      email: "Enter an email like name@example.com.",
    });
  if (!isRole(input.role)) throw new AppError("invalid", "Pick a role.", { role: "Pick a role." });
  return { name, email, role: input.role };
}

function duplicateEmail(err: unknown): never {
  if (isUniqueViolation(err, "staff_email_per_business"))
    throw new AppError("conflict", "Someone on staff already uses that email.", {
      email: "Someone on staff already uses that email.",
    });
  throw err;
}

async function activeOwners(trx: Transaction<DB>): Promise<number> {
  const row = await trx
    .selectFrom("staff")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("role", "=", "owner")
    .where("active", "=", true)
    .executeTakeFirstOrThrow();
  return row.n;
}

export const addStaff = defineHandler<StaffInput, { id: string }>({
  action: "staff.manage",
  async run(trx, ctx, input) {
    const values = cleanStaff(input);
    try {
      const row = await trx
        .insertInto("staff")
        .values({ ...values, business_id: ctx.businessId, grooms: values.role === "groomer" })
        .returning("id")
        .executeTakeFirstOrThrow();
      return { id: row.id };
    } catch (err) {
      return duplicateEmail(err);
    }
  },
});

/**
 * Change name, email, role or active. The store always keeps at least one active
 * owner, and nobody can deactivate themselves.
 */
export const updateStaff = defineHandler<StaffInput & { id: string; active: boolean }, void>({
  action: "staff.manage",
  async run(trx, ctx, input) {
    const values = cleanStaff(input);
    const current = await trx
      .selectFrom("staff")
      .select(["role", "active"])
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!current) throw new AppError("not_found", "That staff member doesn't exist.");
    if (input.id === ctx.staffId && !input.active)
      throw new AppError("invalid", "You can't deactivate yourself. Ask another owner.");
    const losingOwner =
      current.role === "owner" && current.active && (values.role !== "owner" || !input.active);
    if (losingOwner && (await activeOwners(trx)) <= 1)
      throw new AppError(
        "invalid",
        "The store needs at least one active owner. Make someone else an owner first.",
      );
    try {
      await trx
        .updateTable("staff")
        .set({ ...values, active: input.active })
        .where("id", "=", input.id)
        .execute();
    } catch (err) {
      duplicateEmail(err);
    }
  },
});
