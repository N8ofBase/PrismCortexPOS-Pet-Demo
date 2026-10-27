import { describe, expect, it } from "vitest";
import {
  applyDeposit,
  canChange,
  codeFromBytes,
  bookingDeposit,
  normalizeContact,
  openTimes,
  pickGroomer,
} from "../src/index.ts";

describe("open times", () => {
  const a = { staffId: "a", hours: { start: 480, end: 960 }, timeOff: [], busy: [{ start: 540, end: 685 }] };
  const b = { staffId: "b", hours: { start: 600, end: 1080 }, timeOff: [{ start: 840, end: 960 }], busy: [] };

  it("fits the groom and its buffer around hours, time off and bookings", () => {
    // A 60-minute bath with a 15-minute buffer, every 30 minutes.
    const t = openTimes({ groomers: [a, b], minutes: 60, buffer: 15, step: 30, earliest: 0 });
    const at = (m: number) => t.find((x) => x.start === m)?.staffIds ?? [];
    // 8:00: A is free (busy from 9:00, and 8:00 + 75 min ends 9:15) → no; 8:00 runs into 9:00.
    expect(at(480)).toEqual([]);
    // 11:30: A free after 11:25; B free.
    expect(at(690)).toEqual(["a", "b"]);
    // 1:30 PM: B's time off starts at 2:00, and 1:30 + 75 runs past it.
    expect(at(810)).toEqual(["a"]);
    // 3:00 PM: A's last start (3:00 + 60 = 4:00); B is off until 4.
    expect(at(900)).toEqual(["a"]);
    expect(at(930)).toEqual([]);
    // 5:00 PM: B works until 6.
    expect(at(1020)).toEqual(["b"]);
    expect(t.some((x) => x.start === 1050)).toBe(false);
  });

  it("respects the minimum notice", () => {
    const t = openTimes({ groomers: [b], minutes: 60, buffer: 0, step: 30, earliest: 1000 });
    expect(t.map((x) => x.start)).toEqual([1020]);
  });

  it("returns nothing when nobody works", () => {
    expect(
      openTimes({ groomers: [{ ...a, hours: null }], minutes: 60, buffer: 0, step: 30, earliest: 0 }),
    ).toEqual([]);
  });
});

describe("any groomer", () => {
  it("picks whoever has the fewest bookings, ties to the first", () => {
    expect(pickGroomer(["a", "b"], { a: 3, b: 1 })).toBe("b");
    expect(pickGroomer(["a", "b"], {})).toBe("a");
    expect(pickGroomer([], {})).toBeNull();
  });
});

describe("cutoff and sign-in", () => {
  it("allows changes only before the cutoff", () => {
    const now = new Date("2026-10-21T10:00:00");
    expect(canChange(new Date("2026-10-22T10:00:00"), now, 24)).toBe(true);
    expect(canChange(new Date("2026-10-22T09:59:00"), now, 24)).toBe(false);
    expect(canChange(new Date("2026-10-21T10:00:00"), now, 0)).toBe(true);
  });

  it("makes six-digit codes and reads phones and emails", () => {
    expect(codeFromBytes(new Uint8Array([0, 0, 7]))).toBe("000007");
    expect(codeFromBytes(new Uint8Array([255, 255, 255]))).toMatch(/^\d{6}$/);
    expect(normalizeContact(" (212) 555-0100 ")).toEqual({ kind: "phone", value: "2125550100" });
    expect(normalizeContact("+1 212 555 0100")).toEqual({ kind: "phone", value: "2125550100" });
    expect(normalizeContact("Pat@Example.com")).toEqual({ kind: "email", value: "pat@example.com" });
    expect(normalizeContact("555-0100")).toBeNull();
    expect(normalizeContact("pat@")).toBeNull();
  });
});

describe("deposits", () => {
  const base = { serviceDepositCents: 2000, quoteCents: 7000, isNewCustomer: false };
  it("follows the store's rule", () => {
    expect(bookingDeposit({ ...base, rule: "off" })).toBe(0);
    expect(bookingDeposit({ ...base, rule: "all" })).toBe(2000);
    expect(bookingDeposit({ ...base, rule: "new" })).toBe(0);
    expect(bookingDeposit({ ...base, rule: "new", isNewCustomer: true })).toBe(2000);
  });
  it("is never more than the quote, and nothing when the service has none", () => {
    expect(bookingDeposit({ ...base, rule: "all", quoteCents: 1500 })).toBe(1500);
    expect(bookingDeposit({ ...base, rule: "all", serviceDepositCents: 0 })).toBe(0);
  });
  it("applies up to the sale total and refunds the rest", () => {
    expect(applyDeposit(7500, 2000)).toEqual({ appliedCents: 2000, refundCents: 0 });
    expect(applyDeposit(1200, 2000)).toEqual({ appliedCents: 1200, refundCents: 800 });
    expect(applyDeposit(0, 2000)).toEqual({ appliedCents: 0, refundCents: 2000 });
  });
});
