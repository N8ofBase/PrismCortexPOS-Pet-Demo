import { sql, type Transaction } from "kysely";
import { AppError, type Ctx } from "@pet-pos/core";
import type { DB } from "@pet-pos/db";

/** The business's first location. One store for now; the data model allows more. */
export async function currentLocationId(trx: Transaction<DB>): Promise<string> {
  const loc = await trx.selectFrom("locations").select("id").orderBy("created_at").executeTakeFirst();
  if (!loc) throw new AppError("invalid", "This store has no location set up yet.");
  return loc.id;
}

/** Writes one audit_log row. Keep before/after to the fields that changed. */
export async function audit(
  trx: Transaction<DB>,
  ctx: Ctx,
  entry: {
    action: string;
    entity: string;
    entityId: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
): Promise<void> {
  await trx
    .insertInto("audit_log")
    .values({
      business_id: ctx.businessId,
      staff_id: ctx.staffId,
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId,
      before: entry.before ? JSON.stringify(entry.before) : null,
      after: entry.after ? JSON.stringify(entry.after) : null,
    })
    .execute();
}

/** For ILIKE searches: escapes the wildcard characters in what staff typed. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function requireInt(
  value: unknown,
  field: string,
  { min, max }: { min: number; max: number },
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new AppError("invalid", `${field} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

/** The next receipt number for the business (sales and kept deposits share it). */
export async function nextReceiptNumber(trx: Transaction<DB>, businessId: string): Promise<number> {
  const row = await trx
    .insertInto("business_counters")
    .values({ business_id: businessId, name: "receipt", value: 1001 })
    .onConflict((oc) =>
      oc.columns(["business_id", "name"]).doUpdateSet({ value: sql`business_counters.value + 1` }),
    )
    .returning("value")
    .executeTakeFirstOrThrow();
  return row.value;
}
