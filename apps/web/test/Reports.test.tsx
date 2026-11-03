import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router";
import type { AstroReport, MoneyTotals, SalesReport, StockReport } from "@pet-pos/api";
import { ReportsRoutes } from "../src/pages/reports/ReportsPage.tsx";
import { renderAs } from "./render.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const totals: MoneyTotals = {
  count: 3,
  grossCents: 10700,
  discountCents: 500,
  taxCents: 700,
  astroDiscountCents: 500,
  cardInCents: 6420,
  cashInCents: 4280,
  cardBackCents: 0,
  cashBackCents: 1070,
  refundCount: 1,
  refundCents: 1070,
  netCents: 9630,
  depositsTakenCents: 2000,
  depositsUsedCents: 0,
  depositsKeptCents: 0,
  depositsRefundedCents: 0,
};

const sales: SalesReport = {
  totals,
  refundTaxCents: 70,
  paymentTypes: [
    { key: "card", label: "Card (counter)", inCents: 6420, backCents: 0, netCents: 6420 },
    { key: "cash", label: "Cash", inCents: 4280, backCents: 1070, netCents: 3210 },
    { key: "deposits", label: "Deposits paid online", inCents: 2000, backCents: 0, netCents: 2000 },
  ],
  categories: [
    { category: "Dog food", qty: 1, salesCents: 6000, refundCents: 0, netCents: 6000 },
    { category: "Treats, chews", qty: 4, salesCents: 4000, refundCents: 1000, netCents: 3000 },
  ],
  days: [
    {
      day: "2026-11-02",
      count: 1,
      netCents: 3210,
      cardCents: 0,
      cashCents: 3210,
      depositsCents: 2000,
      taxCents: 210,
    },
    {
      day: "2026-11-03",
      count: 2,
      netCents: 6420,
      cardCents: 6420,
      cashCents: 0,
      depositsCents: 0,
      taxCents: 490,
    },
  ],
  topProducts: [{ productId: "p1", name: "Dog food", sku: "0001", qty: 1, netCents: 6000 }],
};

const path = "/reports/sales?from=2026-11-02&to=2026-11-03";
const app = (
  <Routes>
    <Route path="/reports/*" element={<ReportsRoutes />} />
  </Routes>
);

describe("reports", () => {
  it("shows the sales tiles and tables for the range in the address", async () => {
    const { call } = renderAs("manager", app, { salesReport: sales }, path);
    expect((await screen.findAllByText("$96.30")).length).toBeGreaterThan(0);
    expect(call).toHaveBeenCalledWith("salesReport", { from: "2026-11-02", to: "2026-11-03" });
    const cats = within(screen.getByRole("region", { name: "Sales by category" }));
    expect(cats.getByText("Treats, chews")).toBeTruthy();
    // Shares of net before tax: $60 and $30 of $90.
    expect(cats.getByText("67%")).toBeTruthy();
    expect(cats.getByText("33%")).toBeTruthy();
    expect(cats.getByText("$90.00")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sales" }).getAttribute("aria-current")).toBe("page");
  });

  it("sorts by a column and downloads exactly what's on screen", async () => {
    let csv = "";
    let name = "";
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      void (b as Blob).text().then((t) => (csv = t));
      return "blob:x";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      name = this.download;
    });
    renderAs("owner", app, { salesReport: sales }, path);
    const region = within(await screen.findByRole("region", { name: "Sales by category" }));
    fireEvent.click(region.getByRole("button", { name: "Category" }));
    fireEvent.click(region.getByRole("button", { name: /Category/ }));
    const rows = region.getAllByRole("row").map((r) => r.textContent);
    expect(rows[1]).toContain("Treats, chews");
    fireEvent.click(region.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => expect(csv).not.toBe(""));
    expect(name).toBe("sales-by-category_2026-11-02_2026-11-03.csv");
    expect(csv).toBe(
      "Category,Items sold,Sales,Refunds,Net,Share\r\n" +
        '"Treats, chews",4,40.00,10.00,30.00,33\r\n' +
        "Dog food,1,60.00,0.00,60.00,67\r\n" +
        "Total,5,100.00,10.00,90.00,100\r\n",
    );
  });

  it("shows the stock tab as of today, without a date range", async () => {
    const stock: StockReport = {
      asOf: "2026-11-03",
      costCents: 12345,
      retailCents: 23456,
      low: 1,
      out: 1,
      noCost: 1,
      reorder: [
        {
          productId: "p4",
          sku: "0004",
          name: "Rope toy",
          brand: null,
          category: "Supplies",
          onHand: 0,
          reorderAt: 4,
          soldLast30: 9,
          costCents: 0,
          backBar: false,
        },
      ],
      categories: [{ category: "Supplies", units: 3, costCents: 12345, retailCents: 23456 }],
      countsToCheck: [],
    };
    renderAs("owner", app, { stockReport: stock }, "/reports/stock");
    expect((await screen.findAllByText("$123.45")).length).toBeGreaterThan(0);
    expect(screen.getByText("1 product has no cost entered")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Date range" })).toBeNull();
    expect(screen.queryByLabelText("From")).toBeNull();
    expect(screen.getByText("As of today")).toBeTruthy();
    const reorder = within(screen.getByRole("region", { name: "Reorder list" }));
    expect(reorder.getByText("Out")).toBeTruthy();
    expect(reorder.getByText("No cost")).toBeTruthy();
  });

  it("saves the weekly Astro check, and hides the boxes from cashiers' view", async () => {
    const astro: AstroReport = {
      earned: 12,
      rewards: 1,
      rewardCents: 6499,
      offers: 2,
      offerCents: 1000,
      programs: [],
      backlog: {
        pending: 3,
        underDay: 1,
        underWeek: 1,
        overWeek: 1,
        failed: 0,
        oldestAt: new Date(Date.now() - 9 * 86_400_000),
      },
      week: "2026-11-02",
      toCheck: [
        {
          customerId: "c1",
          customerName: "Sample Family (DEMO)",
          programs: [{ programId: "a1", programName: "Dry food club", localBalance: 4 }],
          checkedAt: null,
        },
      ],
      checks: [],
      lastCheckAt: null,
      checkDue: true,
    };
    const { call } = renderAs(
      "manager",
      app,
      { astroReport: astro, saveAstroCheck: [{ matches: false }] },
      "/reports/astro?from=2026-11-01&to=2026-11-03",
    );
    expect(await screen.findByText("Oldest: 9 days")).toBeTruthy();
    expect(screen.getByText("Enter these in the Astro portal")).toBeTruthy();
    expect(screen.getByText("Never")).toBeTruthy();
    const box = screen.getByLabelText("Sample Family (DEMO): Dry food club punches in Astro");
    fireEvent.change(box, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save what Astro shows" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("saveAstroCheck", {
        customerId: "c1",
        rows: [{ programId: "a1", astroBalance: 3 }],
      }),
    );
    fireEvent.change(box, { target: { value: "x" } });
    expect(screen.getByText("Type the punches Astro shows, as a whole number.")).toBeTruthy();
  });
});
