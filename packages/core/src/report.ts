// Reports (Phase 5a): date ranges, the rebooking rule, and CSV files. Money stays in
// integer cents until it's written out as text.
import { addDays, daysBetween, isIsoDate } from "./dates.ts";
import { AppError } from "./errors.ts";
import { centsToInput } from "./money.ts";

/** The longest report range: 13 months, so a month can be set against the same month last year. */
export const MAX_REPORT_DAYS = 397;

/** Every business day from `from` to `to`, inclusive. Refuses bad or too-long ranges. */
export function reportDays(from: string, to: string): string[] {
  if (!isIsoDate(from) || !isIsoDate(to)) throw new AppError("invalid", "Pick a start and end date.");
  const n = daysBetween(from, to);
  if (n < 0) throw new AppError("invalid", "The start date is after the end date.");
  if (n + 1 > MAX_REPORT_DAYS) throw new AppError("invalid", "Pick a range of 13 months or less.");
  return Array.from({ length: n + 1 }, (_, i) => addDays(from, i));
}

export type RangePreset = "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month";

export const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this_week", label: "This week" },
  { key: "last_week", label: "Last week" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
];

/** A preset as days. Weeks start on Monday, as on the grooming calendar. */
export function presetRange(preset: RangePreset, today: string): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number) as [number, number, number];
  const monday = (day: string) => {
    const [yy, mm, dd] = day.split("-").map(Number) as [number, number, number];
    const wd = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay();
    return addDays(day, wd === 0 ? -6 : 1 - wd);
  };
  const first = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-01`;
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "this_week":
      return { from: monday(today), to: today };
    case "last_week": {
      const start = addDays(monday(today), -7);
      return { from: start, to: addDays(start, 6) };
    }
    case "this_month":
      return { from: first(y, m), to: today };
    case "last_month": {
      const start = m === 1 ? first(y - 1, 12) : first(y, m - 1);
      return { from: start, to: addDays(first(y, m), -1) };
    }
  }
}

/** Which preset a range is, if any, so the bar can highlight it. */
export function matchPreset(from: string, to: string, today: string): RangePreset | null {
  for (const p of RANGE_PRESETS) {
    const r = presetRange(p.key, today);
    if (r.from === from && r.to === to) return p.key;
  }
  return null;
}

// ---- Rebooking ----

/** Weeks to wait for the next groom when a service has no rebook weeks set. */
export const DEFAULT_REBOOK_WEEKS = 6;
/** Grace on top of the service's rebook weeks before a groom counts as not rebooked. */
export const REBOOK_GRACE_WEEKS = 2;

export interface DoneGroom {
  /** The groom's local day. */
  day: string;
  rebookWeeks: number | null;
  /** The pet's next groom after this one that isn't canceled or a no-show. */
  next: { day: string; bookedDay: string } | null;
}

export interface RebookStats {
  /** Grooms done in the range. */
  done: number;
  /** The next groom is booked inside the window. */
  rebooked: number;
  /** Of those, booked on or before the day of the groom: booked before they left. */
  bookedBeforeLeaving: number;
  /** The window has closed with nothing booked inside it. */
  notRebooked: number;
  /** Not rebooked yet, but the window is still open: left out of the rate. */
  tooSoon: number;
  /** rebooked ÷ (rebooked + not rebooked), as a whole percent; null when there's nothing to count. */
  ratePercent: number | null;
  /** bookedBeforeLeaving ÷ the same base, as a whole percent. */
  beforeLeavingPercent: number | null;
}

/** Days after a groom that the next one must start within to count as rebooked. */
export function rebookWindowDays(rebookWeeks: number | null): number {
  return ((rebookWeeks ?? DEFAULT_REBOOK_WEEKS) + REBOOK_GRACE_WEEKS) * 7;
}

/**
 * The rebooking rule: a pet is rebooked when its next groom (not canceled or a no-show)
 * starts within the service's rebook weeks plus two weeks. A groom whose window is still
 * open and has nothing booked yet is "too soon to tell" and left out of the rate.
 */
export function rebookStats(grooms: DoneGroom[], today: string): RebookStats {
  let rebooked = 0;
  let beforeLeaving = 0;
  let notRebooked = 0;
  let tooSoon = 0;
  for (const g of grooms) {
    const window = rebookWindowDays(g.rebookWeeks);
    if (g.next && daysBetween(g.day, g.next.day) <= window) {
      rebooked++;
      if (daysBetween(g.next.bookedDay, g.day) >= 0) beforeLeaving++;
    } else if (daysBetween(g.day, today) < window) {
      tooSoon++;
    } else {
      notRebooked++;
    }
  }
  const base = rebooked + notRebooked;
  const pct = (n: number) => (base ? Math.round((n * 100) / base) : null);
  return {
    done: grooms.length,
    rebooked,
    bookedBeforeLeaving: beforeLeaving,
    notRebooked,
    tooSoon,
    ratePercent: pct(rebooked),
    beforeLeavingPercent: pct(beforeLeaving),
  };
}

/** A whole percent of a part in a total, or null when the total is zero. */
export function percentOfTotal(part: number, total: number): number | null {
  return total ? Math.round((part * 100) / total) : null;
}

/** Net ÷ count, rounded half up to the cent (half away from zero for refunds). */
export function averageCents(totalCents: number, count: number): number {
  if (!count) return 0;
  const sign = totalCents < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(totalCents) * 2 + count) / (2 * count));
}

// ---- CSV ----

export type CsvValue = string | number | null | undefined | { cents: number };

/** Cents as plain dollars for a spreadsheet: 1230 → "12.30", -5 → "-0.05". No floats. */
export function centsCsv(cents: number): string {
  return centsToInput(cents);
}

function cell(v: CsvValue): string {
  const s = v === null || v === undefined ? "" : typeof v === "object" ? centsCsv(v.cents) : String(v);
  // A leading = + - @ would run as a formula in Excel, so it's quoted with a ' first,
  // except plain numbers such as -0.05.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Rows to CSV text, with Windows line ends so Excel is happy. */
export function toCsv(header: string[], rows: CsvValue[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** "sales-by-category_2026-10-01_2026-10-31.csv" */
export function csvFileName(report: string, from: string, to: string): string {
  const slug = report
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return from === to ? `${slug}_${from}.csv` : `${slug}_${from}_${to}.csv`;
}
