import { sql } from "kysely";
import { barcodeVariants, normalizePhone, orderKey, orderLine, parseLooseDate } from "@pet-pos/core";
import { currentLocationId } from "../shared.ts";
import { Skip, text, type Row, type RowCtx, type RowResult } from "./base.ts";

/** Noon local time on the order's date, so it never slips to the day before. */
function orderTime(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
}

/**
 * Past orders file, one row per item. The first row of an order creates it (status
 * paid, source import); later rows add lines and raise its total. No payments, stock
 * moves or punches. An order already imported by an earlier file is skipped.
 */
export async function orderRow(r: Row, rc: RowCtx): Promise<RowResult> {
  const date = parseLooseDate(r.date ?? "", rc.today);
  if (!date) throw new Skip(date === null ? "No date" : "Date isn't a date");
  if (date > rc.today) throw new Skip("Date is in the future");

  const phone = normalizePhone(r.phone);
  const email = text(r.email);
  let customer = phone
    ? await rc.trx
        .selectFrom("customers")
        .select(["id", "name"])
        .where("phone", "=", phone)
        .executeTakeFirst()
    : undefined;
  if (!customer && email)
    customer = await rc.trx
      .selectFrom("customers")
      .select(["id", "name"])
      .where(sql`lower(email)`, "=", email.toLowerCase())
      .executeTakeFirst();
  if (!customer) throw new Skip("No customer with this phone or email. Import customers first.");

  const money = orderLine(r);
  if (typeof money === "string") throw new Skip(money);

  const sku = text(r.sku);
  const barcode = text(r.barcode);
  let product = sku
    ? await rc.trx
        .selectFrom("products")
        .select(["id", "name", "sku", "barcode", "tax_class", "category"])
        .where(sql`lower(sku)`, "=", sku.toLowerCase())
        .executeTakeFirst()
    : undefined;
  if (!product && barcode)
    product = await rc.trx
      .selectFrom("products")
      .select(["id", "name", "sku", "barcode", "tax_class", "category"])
      .where("barcode", "in", barcodeVariants(barcode))
      .executeTakeFirst();
  const name = text(r.item) ?? product?.name ?? sku ?? barcode;
  if (!name) throw new Skip("Needs an item name, SKU or barcode");
  if (!product) rc.warn(`"${name}" didn't match a product; it will show by name`);

  const key = orderKey(r.receipt, date);
  const existing = await rc.trx
    .selectFrom("sales")
    .select(["id", "import_batch_id"])
    .where("source", "=", "import")
    .where("customer_id", "=", customer.id)
    .where("import_key", "=", key)
    .executeTakeFirst();
  if (existing && existing.import_batch_id !== rc.changes.batchId) throw new Skip("Already imported");

  let saleId: string;
  let action: RowResult["action"];
  if (existing) {
    saleId = existing.id;
    action = "update";
    await rc.trx
      .updateTable("sales")
      .set({
        subtotal_cents: sql`subtotal_cents + ${money.unitPriceCents * money.qty}`,
        discount_cents: sql`discount_cents + ${money.discountCents}`,
        total_cents: sql`total_cents + ${money.lineTotalCents}`,
      })
      .where("id", "=", saleId)
      .execute();
  } else {
    const at = orderTime(date);
    const row = await rc.trx
      .insertInto("sales")
      .values({
        business_id: rc.ctx.businessId,
        location_id: await currentLocationId(rc.trx),
        customer_id: customer.id,
        staff_id: null,
        receipt_number: null,
        status: "paid",
        source: "import",
        import_key: key,
        import_batch_id: rc.changes.batchId,
        subtotal_cents: money.unitPriceCents * money.qty,
        discount_cents: money.discountCents,
        tax_cents: 0,
        total_cents: money.lineTotalCents,
        tax_rate_mpct: 0,
        discounts_before_tax: true,
        paid_at: at,
        created_at: at,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    saleId = row.id;
    action = "new";
    await rc.changes.add("sale", saleId, "created", null, { customer_id: customer.id, import_key: key });
  }

  const pos = await rc.trx
    .selectFrom("sale_lines")
    .select(sql<number>`coalesce(max(position), 0)::int`.as("n"))
    .where("sale_id", "=", saleId)
    .executeTakeFirstOrThrow();
  await rc.trx
    .insertInto("sale_lines")
    .values({
      business_id: rc.ctx.businessId,
      sale_id: saleId,
      position: pos.n + 1,
      product_id: product?.id ?? null,
      name,
      sku: product?.sku ?? sku ?? null,
      barcode: product?.barcode ?? barcode ?? null,
      tax_class: product?.tax_class ?? "standard",
      qty: money.qty,
      unit_price_cents: money.unitPriceCents,
      discount_cents: money.discountCents,
      line_total_cents: money.lineTotalCents,
      tax_cents: 0,
      category: product?.category ?? null,
    })
    .execute();

  return { action, label: `${customer.name} · ${date} · ${money.qty}× ${name}` };
}
