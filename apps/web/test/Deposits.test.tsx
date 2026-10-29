import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppointmentRow, BookingPage, CheckoutResult, DepositView, MyPet } from "@pet-pos/api";
import { addDays, todayIso } from "@pet-pos/core";
import type { PublicApi } from "../src/api/client.ts";
import { BookFlow } from "../src/book/BookFlow.tsx";
import { BookingContext } from "../src/book/context.ts";
import { payIdFromPath, PayPage } from "../src/book/PayPage.tsx";
import { AppointmentPanel } from "../src/pages/grooming/AppointmentPanel.tsx";
import { PaymentPanel } from "../src/pages/register/PaymentPanel.tsx";
import { renderAs } from "./render.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const page: BookingPage = {
  storeName: "Sample Pet Store",
  logo: null,
  brandColor: null,
  enabled: true,
  message: null,
  phone: "2125550199",
  daysAhead: 30,
  cutoffHours: 24,
  depositRule: "new",
  holdMinutes: 15,
  services: [
    {
      id: "full",
      name: "Full groom",
      kind: "main",
      description: null,
      priceCents: { S: 5500, M: 7000, L: 8500, XL: 10500 },
      minutes: { S: 90, M: 120, L: 150, XL: 180 },
      depositCents: 2000,
    },
  ],
  groomers: [{ staffId: "g1", name: "Groomer A" }],
};

function renderBook(ui: ReactNode, responses: Record<string, unknown>) {
  const call = vi.fn(async (name: string, input?: unknown) => {
    if (!(name in responses)) throw new Error(`No fake response for ${name}`);
    const r = responses[name];
    return typeof r === "function" ? (r as (i: unknown) => unknown)(input) : r;
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <BookingContext.Provider
        value={{
          api: { call } as unknown as PublicApi,
          page,
          name: "Pat",
          signIn: vi.fn(),
          signOut: vi.fn(),
        }}
      >
        {ui}
      </BookingContext.Provider>
    </QueryClientProvider>,
  );
  return { call };
}

const rufus: MyPet = { id: "p1", name: "Rufus", species: "dog", breed: null, size: "M", rabiesLapsed: false };

describe("the booking page asks for a deposit", () => {
  async function toReview(newCustomer: boolean) {
    const d = addDays(todayIso(), 2);
    renderBook(<BookFlow pets={[rufus]} newCustomer={newCustomer} onDone={vi.fn()} />, {
      openTimes: [{ day: d, times: [600] }],
    });
    fireEvent.click(screen.getByLabelText(/Full groom/));
    const days = await screen.findByRole("group", { name: "Days" });
    fireEvent.click(days.querySelector("button")!);
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    return screen.getByRole("region", { name: "Review" });
  }

  it("from a new customer, with its terms", async () => {
    const review = await toReview(true);
    expect(review.textContent).toContain(
      "A $20.00 deposit holds your time. You pay it now, and it comes off the $70.00 at pickup. It's refunded if you cancel at least 24 hours before.",
    );
    expect(screen.getByRole("button", { name: "Book and pay $20.00" })).toBeTruthy();
  });

  it("not from a returning customer when the store asks new customers only", async () => {
    const review = await toReview(false);
    expect(review.textContent).toContain("Pay at pickup.");
    expect(screen.getByRole("button", { name: "Book" })).toBeTruthy();
  });

  it("knows its payment page address", () => {
    expect(payIdFromPath("/book/pay/0b5c3c38-6a3e-4f1e-9b7a-2f1d4b1c9e01")).toBe(
      "0b5c3c38-6a3e-4f1e-9b7a-2f1d4b1c9e01",
    );
    expect(payIdFromPath("/book")).toBeNull();
  });
});

const view: DepositView = {
  id: "d1",
  appointmentId: "a1",
  status: "pending",
  amountCents: 2000,
  storeName: "Sample Pet Store",
  description: "Rufus · Full groom, Thu Oct 29, 10:00 AM",
  priceCents: 7000,
  holdUntil: new Date(),
  url: "/book/pay/d1",
  message: null,
};

describe("the simulated payment page", () => {
  it("pays, or cancels and keeps the hold", async () => {
    const onDone = vi.fn();
    const { call } = renderBook(<PayPage id="d1" onDone={onDone} />, {
      depositStatus: view,
      simulateDepositPayment: (i: unknown) => ({
        ...view,
        status: (i as { outcome: string }).outcome === "paid" ? "paid" : "pending",
      }),
    });
    expect(await screen.findByText(/Simulated Square checkout/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" })));
    fireEvent.click(screen.getByRole("button", { name: "Pay $20.00" }));
    await waitFor(() => expect(onDone).toHaveBeenLastCalledWith(expect.objectContaining({ status: "paid" })));
    expect(call).toHaveBeenCalledWith("simulateDepositPayment", { id: "d1", outcome: "paid" });
  });
});

describe("the register", () => {
  it("counts the deposit as paid and asks only for the rest", async () => {
    const sale: CheckoutResult = {
      saleId: "s1",
      receiptNumber: 1001,
      subtotalCents: 8000,
      discountCents: 0,
      taxCents: 0,
      totalCents: 8000,
      cashOnly: false,
      depositCents: 2000,
      depositRefundedCents: 0,
      paid: false,
    };
    renderAs("cashier", <PaymentPanel sale={sale} mode="card" onPaid={vi.fn()} onCanceled={vi.fn()} />, {});
    expect(screen.getByText("Deposit paid online")).toBeTruthy();
    expect(screen.getByText("Left to pay")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send $60.00 to the card reader" })).toBeTruthy();
    // Nothing to hand back: the deposit stays with the groom.
    expect(screen.getByRole("button", { name: "Back to ticket" })).toBeTruthy();
  });
});

describe("the appointment panel", () => {
  const appt = (over: Partial<AppointmentRow> = {}): AppointmentRow => ({
    id: "a1",
    status: "booked",
    staffId: "g1",
    groomerName: "Sample Groomer A",
    customerId: "c1",
    customerName: "Pat Lee",
    customerPhone: "2125550100",
    petId: "p1",
    petName: "Biscuit",
    species: "dog",
    breed: null,
    allergies: null,
    coat: null,
    temperament: null,
    size: "M",
    serviceId: "full",
    serviceName: "Full groom",
    addons: [],
    label: "Full groom",
    startsAt: new Date(),
    endsAt: new Date(),
    start: 540,
    end: 660,
    blockEnd: 675,
    priceCents: 7000,
    notes: null,
    rabiesLapsed: false,
    source: "online",
    saleId: null,
    receiptNumber: null,
    saleRefundedCents: 0,
    noteCount: 0,
    lastNote: null,
    holdUntil: null,
    reach: { channel: "sms", to: "2125550100" },
    deposit: {
      id: "d1",
      amountCents: 2000,
      refundedCents: 0,
      status: "paid",
      paidAt: new Date(),
      url: null,
      keptReceiptNumber: null,
    },
    ...over,
  });
  const quiet = { appointmentMessages: [], appointmentNotes: [] };

  it("asks before keeping a deposit on a no-show", async () => {
    const { call } = renderAs(
      "cashier",
      <AppointmentPanel a={appt()} onEdit={() => {}} onClose={() => {}} />,
      {
        ...quiet,
        setAppointmentStatus: appt({ status: "no_show" }),
      },
    );
    expect(screen.getByLabelText("Deposit").textContent).toMatch(/\$20\.00 paid online/);
    fireEvent.click(screen.getByRole("button", { name: "No-show" }));
    const keep = screen.getByLabelText("Keep the $20.00 deposit as a no-show fee") as HTMLInputElement;
    expect(keep.checked).toBe(true);
    fireEvent.click(keep);
    fireEvent.click(screen.getByRole("button", { name: "Mark no-show" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("setAppointmentStatus", {
        id: "a1",
        status: "no_show",
        keepDeposit: false,
      }),
    );
  });

  it("refunds on cancel unless unticked, and shows a held booking", async () => {
    const { call } = renderAs(
      "cashier",
      <AppointmentPanel a={appt()} onEdit={() => {}} onClose={() => {}} />,
      {
        ...quiet,
        cancelAppointment: undefined,
      },
    );
    fireEvent.click(screen.getByLabelText("If canceled, refund the $20.00 deposit"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel appointment" }));
    fireEvent.click(screen.getByRole("button", { name: "Tap again to cancel" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("cancelAppointment", { id: "a1", refundDeposit: false }),
    );
    cleanup();
    renderAs(
      "cashier",
      <AppointmentPanel
        a={appt({
          status: "held",
          holdUntil: new Date(),
          deposit: { ...appt().deposit!, status: "pending", paidAt: null, url: "/book/pay/d1" },
        })}
        onEdit={() => {}}
        onClose={() => {}}
      />,
      quiet,
    );
    expect(screen.getByLabelText("Deposit").textContent).toMatch(/Waiting for the \$20\.00 deposit/);
  });
});
