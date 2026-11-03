import { describe, expect, it } from "vitest";
import {
  averageCents,
  centsCsv,
  csvFileName,
  matchPreset,
  presetRange,
  rebookStats,
  rebookWindowDays,
  reportDays,
  toCsv,
} from "../src/index.ts";

describe("report ranges", () => {
  it("lists every day, inclusive", () => {
    expect(reportDays("2026-10-30", "2026-11-02")).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    expect(reportDays("2026-11-03", "2026-11-03")).toEqual(["2026-11-03"]);
  });

  it("refuses bad, backwards and too-long ranges", () => {
    expect(() => reportDays("2026-11-31", "2026-12-01")).toThrow("Pick a start and end date.");
    expect(() => reportDays("2026-11-03", "2026-11-02")).toThrow(/after the end date/);
    expect(reportDays("2025-10-03", "2026-11-03")).toHaveLength(397);
    expect(() => reportDays("2025-10-02", "2026-11-03")).toThrow("Pick a range of 13 months or less.");
  });

  it("works out the presets from today", () => {
    const today = "2026-11-03"; // a Tuesday
    expect(presetRange("today", today)).toEqual({ from: today, to: today });
    expect(presetRange("yesterday", today)).toEqual({ from: "2026-11-02", to: "2026-11-02" });
    expect(presetRange("this_week", today)).toEqual({ from: "2026-11-02", to: today });
    expect(presetRange("last_week", today)).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    expect(presetRange("this_month", today)).toEqual({ from: "2026-11-01", to: today });
    expect(presetRange("last_month", today)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(presetRange("last_month", "2027-01-15")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(presetRange("last_month", "2028-03-01")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    // A Sunday belongs to the week that started the Monday before.
    expect(presetRange("this_week", "2026-11-08")).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(matchPreset("2026-10-01", "2026-10-31", today)).toBe("last_month");
    expect(matchPreset("2026-10-02", "2026-10-31", today)).toBeNull();
  });
});

describe("rebooking", () => {
  const today = "2026-11-03";
  it("uses the service's rebook weeks plus two, or eight weeks", () => {
    expect(rebookWindowDays(6)).toBe(56);
    expect(rebookWindowDays(4)).toBe(42);
    expect(rebookWindowDays(null)).toBe(56);
  });

  it("sorts grooms into rebooked, not rebooked and too soon to tell", () => {
    const s = rebookStats(
      [
        // Rebooked inside the window, booked on the day of the groom.
        { day: "2026-08-01", rebookWeeks: 6, next: { day: "2026-09-12", bookedDay: "2026-08-01" } },
        // Rebooked on the last day of the window, booked later by phone.
        { day: "2026-08-01", rebookWeeks: 4, next: { day: "2026-09-12", bookedDay: "2026-08-20" } },
        // Next groom outside the window.
        { day: "2026-08-01", rebookWeeks: 4, next: { day: "2026-09-13", bookedDay: "2026-09-01" } },
        // Nothing booked and the window has closed.
        { day: "2026-08-01", rebookWeeks: null, next: null },
        // Nothing booked yet, but there's still time.
        { day: "2026-10-20", rebookWeeks: 6, next: null },
        // Booked before this groom even happened counts as before they left.
        { day: "2026-10-20", rebookWeeks: 6, next: { day: "2026-12-01", bookedDay: "2026-10-01" } },
      ],
      today,
    );
    expect(s).toEqual({
      done: 6,
      rebooked: 3,
      bookedBeforeLeaving: 2,
      notRebooked: 2,
      tooSoon: 1,
      ratePercent: 60,
      beforeLeavingPercent: 40,
    });
  });

  it("has no rate when there's nothing to count yet", () => {
    expect(rebookStats([{ day: "2026-11-01", rebookWeeks: 4, next: null }], today)).toMatchObject({
      tooSoon: 1,
      ratePercent: null,
    });
    expect(rebookStats([], today).ratePercent).toBeNull();
  });
});

describe("report money", () => {
  it("averages to the cent, half up, without floats", () => {
    expect(averageCents(1000, 3)).toBe(333);
    expect(averageCents(1001, 2)).toBe(501);
    expect(averageCents(-1001, 2)).toBe(-501);
    expect(averageCents(500, 0)).toBe(0);
  });
});

describe("CSV", () => {
  it("writes cents as plain dollars", () => {
    expect(centsCsv(1230)).toBe("12.30");
    expect(centsCsv(-5)).toBe("-0.05");
    expect(centsCsv(123400)).toBe("1234.00");
    expect(centsCsv(0)).toBe("0.00");
  });

  it("quotes commas, quotes and line breaks, and defuses formulas", () => {
    const csv = toCsv(
      ["Product", "Qty", "Net"],
      [
        ['Treats, "small"', 2, { cents: 2598 }],
        ["=HYPERLINK(1)", null, { cents: -5 }],
        ["Two\nlines", 0, undefined],
      ],
    );
    expect(csv).toBe(
      'Product,Qty,Net\r\n"Treats, ""small""",2,25.98\r\n\'=HYPERLINK(1),,-0.05\r\n"Two\nlines",0,\r\n',
    );
  });

  it("names the file after the report and range", () => {
    expect(csvFileName("Sales by category", "2026-10-01", "2026-10-31")).toBe(
      "sales-by-category_2026-10-01_2026-10-31.csv",
    );
    expect(csvFileName("Reorder list", "2026-11-03", "2026-11-03")).toBe("reorder-list_2026-11-03.csv");
  });
});
