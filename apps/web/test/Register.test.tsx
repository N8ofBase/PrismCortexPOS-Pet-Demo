import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckoutResult, ProductRow } from "@pet-pos/api";
import { PaymentPanel } from "../src/pages/register/PaymentPanel.tsx";
import { receiptText } from "@pet-pos/core";
import {
  addProduct,
  EMPTY_TICKET,
  priceTicket,
  setQty,
  toInput,
  toggleOffer,
} from "../src/pages/register/ticket.ts";
import { todayRange } from "../src/pages/SalesPage.tsx";
import { CameraButton, cameraErrorMessage } from "../src/ui/scanner/CameraScanner.tsx";
import { createDeduper } from "../src/ui/scanner/detector.ts";
import { renderAs } from "./render.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const food: ProductRow = {
  id: "p1",
  sku: "0001",
  barcode: "012345678905",
  name: "Adult Dog Food 24 lb",
  brand: "Sample Brand",
  category: "Dog food",
  priceCents: 6499,
  costCents: 4300,
  taxClass: "standard",
  reorderAt: 6,
  onHand: 14,
  astroProgramId: "club",
  astroProgramName: "Dry food club",
  offerLabel: "$5 off 24 lb bag",
  offerCents: 500,
  active: true,
  backBar: false,
  unit: null,
};

describe("ticket", () => {
  it("adds, merges, counts and removes lines, and prices as it goes", () => {
    let t = addProduct(EMPTY_TICKET, food);
    t = addProduct(t, food);
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]!.qty).toBe(2);
    expect(priceTicket(t, 7000, true).priced).toMatchObject({
      subtotalCents: 12998,
      taxCents: 910,
      totalCents: 13908,
    });

    t = toggleOffer(t, t.lines[0]!.key);
    expect(priceTicket(t, 7000, true).priced!.totalCents).toBe(12998 - 500 + 875);

    t = setQty(t, t.lines[0]!.key, 0);
    expect(t.lines).toEqual([]);
  });

  it("sends ids and choices to the server, never prices", () => {
    const t = addProduct(EMPTY_TICKET, food);
    const input = toInput(t);
    expect(input).toEqual({
      customerId: null,
      lines: [{ key: t.lines[0]!.key, productId: "p1", qty: 1, applyOffer: false }],
      rewards: [],
      discounts: [],
    });
    expect(JSON.stringify(input)).not.toContain("6499");
  });

  it("explains a ticket that can't be priced", () => {
    const rule = {
      id: "d",
      name: "Employee",
      kind: "percent" as const,
      percentMpct: 20000,
      amountCents: null,
      scope: "ticket" as const,
      combinable: false,
    };
    const row = {
      ...rule,
      code: null,
      cashOnly: false,
      needsApproval: false,
      askNote: false,
      active: true,
      archived: false,
      timesUsed: 0,
    };
    const t = {
      ...addProduct(EMPTY_TICKET, food),
      discounts: [
        { discount: row, lineKey: null, note: null, approvedBy: null, approverName: null },
        {
          discount: { ...row, id: "e", name: "Senior" },
          lineKey: null,
          note: null,
          approvedBy: null,
          approverName: null,
        },
      ],
    };
    expect(priceTicket(t, 7000, true).problem).toMatch(/Only one whole-ticket discount/);
  });
});

const sale: CheckoutResult = {
  saleId: "s1",
  receiptNumber: 1001,
  subtotalCents: 1299,
  discountCents: 0,
  taxCents: 91,
  totalCents: 1390,
  cashOnly: false,
  depositCents: 0,
  depositRefundedCents: 0,
  paid: false,
};

describe("payment", () => {
  it("shows change due for cash", async () => {
    const onPaid = vi.fn();
    const { call } = renderAs(
      "cashier",
      <PaymentPanel sale={sale} mode="cash" onPaid={onPaid} onCanceled={vi.fn()} />,
      {
        payCash: {
          paymentId: "x",
          status: "completed",
          changeCents: 610,
          paidCents: 1390,
          remainingCents: 0,
          paid: true,
        },
      },
    );
    fireEvent.change(screen.getByLabelText("Cash received ($)"), { target: { value: "20" } });
    expect(screen.getByText("$6.10")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Cash received ($)"), { target: { value: "10" } });
    expect(screen.getByText("That's less than $13.90.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Cash received ($)"), { target: { value: "20.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete cash payment" }));
    await vi.waitFor(() => expect(onPaid).toHaveBeenCalledWith("s1", 610));
    expect(call).toHaveBeenCalledWith("payCash", { saleId: "s1", amountCents: 1390, tenderedCents: 2000 });
  });

  it("drives the simulated card reader", async () => {
    const onPaid = vi.fn();
    const responses: Record<string, unknown> = {
      startCardPayment: {
        paymentId: "c1",
        status: "pending",
        changeCents: 0,
        paidCents: 0,
        remainingCents: 1390,
        paid: false,
      },
      simulateTerminalResult: {
        paymentId: "c1",
        status: "declined",
        changeCents: 0,
        paidCents: 0,
        remainingCents: 1390,
        paid: false,
      },
    };
    renderAs(
      "cashier",
      <PaymentPanel sale={sale} mode="card" onPaid={onPaid} onCanceled={vi.fn()} />,
      responses,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send $13.90 to the card reader" }));
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
    expect(await screen.findByText("Card declined. Try another card or take cash.")).toBeTruthy();

    responses.simulateTerminalResult = {
      paymentId: "c1",
      status: "completed",
      changeCents: 0,
      paidCents: 1390,
      remainingCents: 0,
      paid: true,
    };
    fireEvent.click(screen.getByRole("button", { name: "Send $13.90 to the card reader" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await vi.waitFor(() => expect(onPaid).toHaveBeenCalledWith("s1", 0));
  });

  it("won't take a card when a cash-only discount is on", () => {
    renderAs(
      "cashier",
      <PaymentPanel sale={{ ...sale, cashOnly: true }} mode="card" onPaid={vi.fn()} onCanceled={vi.fn()} />,
    );
    expect(screen.getByText(/cash-only discount/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /card reader/ })).toBeNull();
  });
});

describe("receipt", () => {
  it("prints in 32 columns with discounts, tax, payment and Astro credit", () => {
    const text = receiptText({
      id: "s1",
      receiptNumber: 1001,
      status: "paid",
      createdAt: new Date("2026-10-19T15:04:00"),
      paidAt: new Date("2026-10-19T15:05:00"),
      storeName: "Sample Pet Store (DEMO)",
      locationName: "Main store (DEMO)",
      staffName: "Sam",
      customer: { id: "c1", name: "Pat Lee", email: null, phone: null },
      lines: [
        {
          id: "l1",
          name: "Adult Dog Food 24 lb",
          sku: "0001",
          qty: 2,
          unitPriceCents: 6499,
          discountCents: 500,
          lineTotalCents: 12498,
        },
      ],
      discounts: [{ name: "$5 off 24 lb bag", source: "astro_offer", amountCents: 500, note: null }],
      payments: [
        { method: "cash", status: "completed", amountCents: 13373, tenderedCents: 14000, changeCents: 627 },
      ],
      subtotalCents: 12998,
      discountCents: 500,
      taxCents: 875,
      taxRateMpct: 7000,
      totalCents: 13373,
      refundedCents: 0,
      refunds: [],
      earned: [{ programName: "Dry food club", punches: 2 }],
    });
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(32);
    expect(text).toContain("2× Adult Dog Food 24 lb");
    expect(text).toMatch(/Tax 7%\s+\$8\.75/);
    expect(text).toMatch(/TOTAL\s+\$133\.73/);
    expect(text).toMatch(/Change\s+\$6\.27/);
    expect(text).toContain("Astro credit: 2 × Dry food club");
  });
});

describe("camera scanner", () => {
  it("ignores the same code within 1.5 seconds, but not a different one", () => {
    const d = createDeduper();
    expect(d("012345678905", 0)).toBe(true);
    expect(d("012345678905", 800)).toBe(false);
    expect(d("012345678905", 2000)).toBe(false); // still held in view: the window restarts
    expect(d("012345678905", 3600)).toBe(true);
    expect(d("098765432109", 3700)).toBe(true);
  });

  it("explains a blocked camera", () => {
    expect(cameraErrorMessage({ name: "NotAllowedError" })).toMatch(/Camera access is blocked/);
    expect(cameraErrorMessage({ name: "NotFoundError" })).toMatch(/No camera found/);
  });

  it("doesn't touch the camera until the button is tapped, then shows the help when refused", async () => {
    const getUserMedia = vi.fn(async () => {
      throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    });
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    render(<CameraButton onCode={vi.fn()} />);
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/Camera access is blocked/);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
});

describe("sales day", () => {
  it("covers local midnight to midnight", () => {
    const r = todayRange(new Date(2026, 9, 19, 15, 30));
    expect(new Date(r.from).getHours()).toBe(0);
    expect(new Date(r.to).getTime() - new Date(r.from).getTime()).toBe(24 * 3600_000);
  });
});
