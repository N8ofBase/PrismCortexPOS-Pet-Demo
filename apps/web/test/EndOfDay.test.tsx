import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomerHistory, DrawerSummary } from "@pet-pos/api";
import { OrderHistory } from "../src/pages/customers/OrderHistory.tsx";
import { countedFrom, EndOfDayPage, overShortTone } from "../src/pages/sales/EndOfDay.tsx";
import { renderAs } from "./render.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const summary: DrawerSummary = {
  day: "2026-10-20",
  startingCents: 10000,
  cashInCents: 4670,
  cashOutCents: 1390,
  cardCents: 2280,
  totals: {
    count: 3,
    grossCents: 6950,
    discountCents: 0,
    taxCents: 455,
    astroDiscountCents: 0,
    cardInCents: 2280,
    cashInCents: 4670,
    cardBackCents: 0,
    cashBackCents: 1390,
    refundCount: 1,
    refundCents: 1390,
    netCents: 5560,
    depositsTakenCents: 0,
    depositsUsedCents: 0,
    depositsKeptCents: 0,
    depositsRefundedCents: 0,
  },
  counts: [],
  shortNoteCents: 500,
};

describe("count helpers", () => {
  it("adds up the boxes and refuses non-numbers", () => {
    expect(countedFrom({ "2000": "6", "25": "4", "1": "" })).toBe(12100);
    expect(countedFrom({})).toBe(0);
    expect(countedFrom({ "2000": "6.5" })).toBeNull();
    expect([overShortTone(0), overShortTone(5), overShortTone(-5)]).toEqual(["ok", "low", "out"]);
  });
});

describe("end of day", () => {
  it("counts by denomination with a running total, over/short and the deposit", async () => {
    renderAs("manager", <EndOfDayPage />, { drawerSummary: summary, listDrawerCounts: [] });
    expect((await screen.findByLabelText("Expected cash")).textContent).toContain("$132.80");
    fireEvent.change(screen.getByLabelText("How many $100"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("How many $20"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("How many $10"), { target: { value: "1" } });
    const result = screen.getByLabelText("Count result");
    expect(result.textContent).toContain("$130.00");
    expect(result.textContent).toContain("Short $2.80");
    expect(result.textContent).toContain("Take $30.00 to the bank, leave $100.00 in the drawer.");
    expect((screen.getByRole("button", { name: "Save count" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("takes a typed total, and needs a note when short more than $5.00", async () => {
    renderAs("manager", <EndOfDayPage />, { drawerSummary: summary, listDrawerCounts: [] });
    fireEvent.click(await screen.findByLabelText("Just enter the total"));
    fireEvent.change(screen.getByLabelText("Cash counted ($)"), { target: { value: "120" } });
    expect(screen.getByLabelText("Count result").textContent).toContain("Short $12.80");
    const save = screen.getByRole("button", { name: "Save count" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Note \(required/), {
      target: { value: "Paid a delivery from the drawer" },
    });
    expect(save.disabled).toBe(false);
  });
});

describe("order history", () => {
  it("labels imported orders and opens only our receipts", async () => {
    const history: CustomerHistory = {
      orders: 2,
      totalSpentCents: 4598,
      firstVisit: new Date("2025-03-14T12:00:00"),
      lastVisit: new Date("2026-10-20T12:00:00"),
      mostBought: [{ name: "Treats", qty: 4 }],
      page: [
        {
          id: "s1",
          source: "register",
          label: "#1001",
          date: new Date("2026-10-20T12:00:00"),
          items: "1× Treats",
          totalCents: 1390,
          refundedCents: 1390,
        },
        {
          id: "s2",
          source: "import",
          label: "Imported #A-1",
          date: new Date("2025-03-14T12:00:00"),
          items: "3× Treats",
          totalCents: 3208,
          refundedCents: 0,
        },
      ],
      next: null,
    };
    renderAs("cashier", <OrderHistory customerId="c1" />, { customerHistory: history });
    expect(await screen.findByRole("button", { name: "#1001" })).toBeTruthy();
    expect(screen.getByText("Imported #A-1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Imported #A-1" })).toBeNull();
    expect(screen.getByText("Fully refunded")).toBeTruthy();
    expect(screen.getByText("Treats (4)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
});
