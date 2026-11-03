// Product categories and stock status, as in the prototype's Inventory tab.

export const CATEGORIES = [
  "Dog food",
  "Cat food",
  "Treats",
  "Supplies",
  "Small animal",
  "Fish",
  "Bird",
] as const;

/** Report categories for lines that aren't products: grooms, and kept deposits. */
export const GROOMING_CATEGORY = "Grooming";
export const FEES_CATEGORY = "Fees";

/**
 * The ways one barcode can be stored. Scanners and cameras read a 12-digit UPC-A as
 * EAN-13 with a leading 0 (012345678905 ↔ 0012345678905), so both forms match.
 */
export function barcodeVariants(code: string): string[] {
  const c = code.trim();
  if (/^\d{12}$/.test(c)) return [c, `0${c}`];
  if (/^0\d{12}$/.test(c)) return [c, c.slice(1)];
  return [c];
}

export type StockStatus = "out" | "low" | "ok";

/** Out at zero or below; low at or under the reorder point; otherwise ok. */
export function stockStatus(onHand: number, reorderAt: number): StockStatus {
  if (onHand <= 0) return "out";
  if (onHand <= reorderAt) return "low";
  return "ok";
}

/** "Out", "4 left" or "14", for the on-hand tag. */
export function stockLabel(onHand: number, reorderAt: number): string {
  const s = stockStatus(onHand, reorderAt);
  return s === "out" ? "Out" : s === "low" ? `${onHand} left` : String(onHand);
}
