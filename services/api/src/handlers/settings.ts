import { AppError, isHexColor, normalizePhone, parseTaxPercent } from "@pet-pos/core";
import { defineHandler } from "../handler.ts";
import { audit } from "../shared.ts";

export interface StoreSettings {
  name: string;
  brandColor: string | null;
  logo: string | null;
  locationId: string;
  locationName: string;
  taxRateMpct: number;
  /** Astro offers and rewards come off before tax (true) or after. */
  astroDiscountsBeforeTax: boolean;
  /** Managers can refund up to this without the owner's OK. */
  refundApprovalCents: number;
  /** Starting cash left in the drawer each morning. */
  drawerFloatCents: number;
  /** Charge sales tax on grooming. */
  groomingTaxable: boolean;
  /** Text customers when their pet is ready for pickup. */
  textWhenReady: boolean;
  booking: BookingSettings;
}

/** Online booking (Phase 4a). */
export interface BookingSettings {
  enabled: boolean;
  daysAhead: number;
  noticeMinutes: number;
  cutoffHours: number;
  stepMinutes: 15 | 30 | 60;
  message: string | null;
  /** 10 digits, shown to customers. */
  phone: string | null;
  /** Deposits (4b): which online bookings pay one, how long an unpaid one holds its time, and no-shows. */
  depositRule: "off" | "all" | "new";
  holdMinutes: 10 | 15 | 30;
  noShow: "keep" | "refund";
}

/** Largest logo data URL accepted (the browser resizes to 256 px first). */
export const MAX_LOGO_CHARS = 300_000;

export const getSettings = defineHandler<void, StoreSettings>({
  action: "settings.view",
  async run(trx, ctx) {
    const b = await trx
      .selectFrom("businesses")
      .select([
        "name",
        "brand_color",
        "logo_data",
        "astro_discounts_before_tax",
        "refund_approval_cents",
        "drawer_float_cents",
        "grooming_taxable",
        "text_when_ready",
        "booking_enabled",
        "booking_days_ahead",
        "booking_notice_minutes",
        "booking_cutoff_hours",
        "booking_step_minutes",
        "booking_message",
        "deposit_rule",
        "deposit_hold_minutes",
        "deposit_no_show",
        "public_phone",
      ])
      .where("id", "=", ctx.businessId)
      .executeTakeFirstOrThrow();
    const loc = await trx
      .selectFrom("locations")
      .select(["id", "name", "tax_rate_mpct"])
      .orderBy("created_at")
      .executeTakeFirst();
    if (!loc) throw new AppError("invalid", "This store has no location set up yet.");
    return {
      name: b.name,
      brandColor: b.brand_color,
      logo: b.logo_data,
      locationId: loc.id,
      locationName: loc.name,
      taxRateMpct: loc.tax_rate_mpct,
      astroDiscountsBeforeTax: b.astro_discounts_before_tax,
      refundApprovalCents: b.refund_approval_cents,
      drawerFloatCents: b.drawer_float_cents,
      groomingTaxable: b.grooming_taxable,
      textWhenReady: b.text_when_ready,
      booking: {
        enabled: b.booking_enabled,
        daysAhead: b.booking_days_ahead,
        noticeMinutes: b.booking_notice_minutes,
        cutoffHours: b.booking_cutoff_hours,
        stepMinutes: b.booking_step_minutes as 15 | 30 | 60,
        message: b.booking_message,
        phone: b.public_phone,
        depositRule: b.deposit_rule,
        holdMinutes: b.deposit_hold_minutes as 10 | 15 | 30,
        noShow: b.deposit_no_show,
      },
    };
  },
});

export interface SettingsInput {
  name: string;
  brandColor: string | null;
  /** data:image/… URL, or null to remove the logo. */
  logo: string | null;
  locationName: string;
  /** As typed: "8.875" or "8.875%". */
  taxPercent: string;
  astroDiscountsBeforeTax: boolean;
  /** Left out: unchanged. */
  refundApprovalCents?: number;
  /** Left out: unchanged. */
  drawerFloatCents?: number;
  /** Left out: unchanged. */
  groomingTaxable?: boolean;
  /** Left out: unchanged. */
  textWhenReady?: boolean;
  /** Left out: unchanged. The phone can be typed in any format. */
  booking?: Omit<BookingSettings, "phone" | "depositRule" | "holdMinutes" | "noShow"> &
    Partial<Pick<BookingSettings, "depositRule" | "holdMinutes" | "noShow">> & { phone: string | null };
}

export const updateSettings = defineHandler<SettingsInput, void>({
  action: "settings.edit",
  async run(trx, ctx, input) {
    const errors: Record<string, string> = {};
    const name = input.name.trim();
    if (!name) errors.name = "Store name is required.";
    const locationName = input.locationName.trim();
    if (!locationName) errors.locationName = "Location name is required.";
    if (input.brandColor !== null && !isHexColor(input.brandColor))
      errors.brandColor = "Pick a color with the color picker.";
    if (
      input.logo !== null &&
      (!/^data:image\/(png|jpeg|webp);base64,/.test(input.logo) || input.logo.length > MAX_LOGO_CHARS)
    )
      errors.logo = "Use a PNG, JPG or WebP image under 200 KB.";
    const tax = parseTaxPercent(input.taxPercent);
    if (tax === null) errors.taxPercent = "Enter the sales tax as a percent, like 8.875.";
    const limit = input.refundApprovalCents;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0 || limit > 10_000_000))
      errors.refundApprovalCents = "Enter the refund limit in dollars, like 50.00.";
    const float = input.drawerFloatCents;
    if (float !== undefined && (!Number.isSafeInteger(float) || float < 0 || float > 10_000_000))
      errors.drawerFloatCents = "Enter the starting cash in dollars, like 100.00.";
    const bk = input.booking;
    let phone: string | null = null;
    if (bk) {
      const n = (v: unknown, lo: number, hi: number) =>
        typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
      if (!n(bk.daysAhead, 1, 180)) errors.bookingDaysAhead = "Booking ahead must be 1 to 180 days.";
      if (!n(bk.noticeMinutes, 0, 10080)) errors.bookingNotice = "Minimum notice must be 0 to 168 hours.";
      if (!n(bk.cutoffHours, 0, 336)) errors.bookingCutoff = "The cancel cutoff must be 0 to 336 hours.";
      if (![15, 30, 60].includes(bk.stepMinutes))
        errors.bookingStep = "Offer times every 15, 30 or 60 minutes.";
      if (bk.message && bk.message.length > 500)
        errors.bookingMessage = "Keep the welcome message under 500 characters.";
      if (bk.depositRule !== undefined && !["off", "all", "new"].includes(bk.depositRule))
        errors.depositRule = "Pick when to ask for a deposit.";
      if (bk.holdMinutes !== undefined && ![10, 15, 30].includes(bk.holdMinutes))
        errors.holdMinutes = "Hold an unpaid booking for 10, 15 or 30 minutes.";
      if (bk.noShow !== undefined && !["keep", "refund"].includes(bk.noShow))
        errors.noShow = "Pick keep or refund for no-shows.";
      if (bk.phone?.trim()) {
        phone = normalizePhone(bk.phone);
        if (!phone) errors.publicPhone = "Enter the store's 10-digit phone number.";
      }
    }
    const first = Object.values(errors)[0];
    if (first) throw new AppError("invalid", first, errors);

    const before = await trx
      .selectFrom("businesses")
      .select("refund_approval_cents")
      .where("id", "=", ctx.businessId)
      .executeTakeFirstOrThrow();
    await trx
      .updateTable("businesses")
      .set({
        ...(limit !== undefined ? { refund_approval_cents: limit } : {}),
        ...(float !== undefined ? { drawer_float_cents: float } : {}),
        ...(input.groomingTaxable !== undefined ? { grooming_taxable: input.groomingTaxable } : {}),
        ...(input.textWhenReady !== undefined ? { text_when_ready: input.textWhenReady } : {}),
        ...(bk
          ? {
              booking_enabled: bk.enabled,
              booking_days_ahead: bk.daysAhead,
              booking_notice_minutes: bk.noticeMinutes,
              booking_cutoff_hours: bk.cutoffHours,
              booking_step_minutes: bk.stepMinutes,
              booking_message: bk.message?.trim() || null,
              public_phone: phone,
              ...(bk.depositRule ? { deposit_rule: bk.depositRule } : {}),
              ...(bk.holdMinutes ? { deposit_hold_minutes: bk.holdMinutes } : {}),
              ...(bk.noShow ? { deposit_no_show: bk.noShow } : {}),
            }
          : {}),
        name,
        brand_color: input.brandColor,
        logo_data: input.logo,
        astro_discounts_before_tax: input.astroDiscountsBeforeTax,
      })
      .where("id", "=", ctx.businessId)
      .execute();

    const loc = await trx
      .selectFrom("locations")
      .select(["id", "tax_rate_mpct"])
      .orderBy("created_at")
      .executeTakeFirstOrThrow();
    await trx
      .updateTable("locations")
      .set({ name: locationName, tax_rate_mpct: tax! })
      .where("id", "=", loc.id)
      .execute();
    if (limit !== undefined && limit !== before.refund_approval_cents)
      await audit(trx, ctx, {
        action: "settings.refund_limit",
        entity: "business",
        entityId: ctx.businessId,
        before: { refund_approval_cents: before.refund_approval_cents },
        after: { refund_approval_cents: limit },
      });
    // The tax rate changes what customers pay, so it's audited like a price change.
    if (loc.tax_rate_mpct !== tax)
      await audit(trx, ctx, {
        action: "settings.tax_rate",
        entity: "location",
        entityId: loc.id,
        before: { tax_rate_mpct: loc.tax_rate_mpct },
        after: { tax_rate_mpct: tax },
      });
  },
});
