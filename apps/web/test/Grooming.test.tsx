import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppointmentRow, BookingCheck, GroomingDay, ServiceRow } from "@pet-pos/api";
import { todayIso } from "@pet-pos/core";
import { AppointmentPanel } from "../src/pages/grooming/AppointmentPanel.tsx";
import { BookingPanel } from "../src/pages/grooming/BookingPanel.tsx";
import { Calendar, gridHours, placeBlock } from "../src/pages/grooming/Calendar.tsx";
import { hoursText } from "../src/pages/grooming/GroomersView.tsx";
import { MyDay } from "../src/pages/grooming/MyDay.tsx";
import { bySize } from "../src/pages/grooming/ServicesView.tsx";
import { renderAs } from "./render.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
  breed: "Beagle",
  allergies: null,
  coat: null,
  temperament: null,
  size: "M",
  serviceId: "s1",
  serviceName: "Full groom",
  addons: [],
  label: "Full groom",
  startsAt: new Date(),
  endsAt: new Date(),
  start: 9 * 60,
  end: 11 * 60,
  blockEnd: 11 * 60 + 15,
  priceCents: 7000,
  notes: null,
  rabiesLapsed: false,
  saleId: null,
  receiptNumber: null,
  saleRefundedCents: 0,
  noteCount: 0,
  lastNote: null,
  holdUntil: null,
  reach: { channel: "sms", to: "2125550100" },
  deposit: null,
  source: "staff",
  ...over,
});

const day = (appointments: AppointmentRow[]): GroomingDay => ({
  day: todayIso(),
  groomers: [
    { staffId: "g1", name: "Sample Groomer A", hours: { start: 8 * 60, end: 16 * 60 }, timeOff: [] },
    { staffId: "g2", name: "Sample Groomer B", hours: { start: 10 * 60, end: 18 * 60 }, timeOff: [] },
  ],
  appointments,
  summary: { appointments: appointments.length, inShop: 0, ready: 0, expectedCents: 7000 },
});

describe("calendar layout", () => {
  it("spans the groomers' hours and places blocks by time", () => {
    const d = day([appt()]);
    expect(gridHours(d.groomers, d.appointments)).toEqual({ from: 480, to: 1080 });
    // 9:00 is two 30-minute rows after 8:00; 2 hours is four rows.
    expect(placeBlock({ start: 540, end: 660 }, 480)).toEqual({ top: 2 * 34 + 2, height: 4 * 34 - 4 });
  });

  it("greys out hours a groomer doesn't work and books open times", async () => {
    renderAs("cashier", <Calendar />, { groomingDay: day([appt()]), listServices: [], listGroomers: [] });
    expect(await screen.findByRole("button", { name: "Book Sample Groomer A at 8:00 AM" })).toBeTruthy();
    // Groomer B starts at 10.
    expect(screen.queryByRole("button", { name: "Book Sample Groomer B at 9:00 AM" })).toBeNull();
    expect(screen.getByRole("button", { name: "Book Sample Groomer B at 10:00 AM" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Biscuit at 9:00 AM, Booked" })).toBeTruthy();
  });

  it("doesn't offer booking to groomers, and opens on their list", async () => {
    renderAs("groomer", <Calendar />, { groomingDay: day([appt({ staffId: "s1" })]) });
    expect(await screen.findByLabelText("Biscuit at 9:00 AM")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Book appointment" })).toBeNull();
  });
});

describe("status buttons", () => {
  it("lets a cashier check in, but a groomer only move a checked-in groom along", () => {
    renderAs("cashier", <AppointmentPanel a={appt()} onEdit={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Check in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "No-show" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel appointment" })).toBeTruthy();
    cleanup();
    renderAs("groomer", <AppointmentPanel a={appt()} onEdit={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Check in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel appointment" })).toBeNull();
  });

  it("gives My day one big button for the next step, plus Undo", async () => {
    const { call } = renderAs(
      "groomer",
      <MyDay
        appointments={[appt({ status: "in_progress", allergies: "Oatmeal shampoo", rabiesLapsed: true })]}
        onOpen={() => {}}
      />,
      { setAppointmentStatus: appt({ status: "ready" }) },
    );
    expect(screen.getByText("Rabies expired. Ask for proof before the groom.")).toBeTruthy();
    expect(screen.getByText("Oatmeal shampoo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ready for pickup" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("setAppointmentStatus", { id: "a1", status: "ready" }),
    );
    expect(screen.getByRole("button", { name: "Undo start" })).toBeTruthy();
  });
});

const service = (over: Partial<ServiceRow>): ServiceRow => ({
  id: "s1",
  name: "Full groom",
  kind: "main",
  description: null,
  priceCents: { S: 5500, M: 7000, L: 8500, XL: 10500 },
  minutes: { S: 90, M: 120, L: 150, XL: 180 },
  bufferMinutes: 15,
  depositCents: 0,
  rebookWeeks: null,
  online: true,
  active: true,
  archived: false,
  ...over,
});

describe("booking form", () => {
  it("shows the server's quote, needs Book anyway for warnings, and refuses a clash", async () => {
    let check: BookingCheck = {
      quote: { priceCents: 8000, minutes: 130, bufferMinutes: 15, label: "Full groom + Teeth" },
      size: "M",
      when: "9:00 AM – 11:10 AM",
      warnings: ["Biscuit's rabies vaccination expired 2026-09-20. Ask for proof before the groom."],
      clash: null,
    };
    const { call } = renderAs(
      "cashier",
      <BookingPanel
        from={{ day: todayIso(), staffId: "g1", start: 540, customerId: "c1" }}
        onClose={() => {}}
      />,
      {
        listServices: [service({}), service({ id: "s2", name: "Teeth", kind: "addon" })],
        listGroomers: [
          {
            staffId: "g1",
            name: "Sample Groomer A",
            role: "groomer",
            grooms: true,
            active: true,
            hours: [],
            timeOff: [],
          },
        ],
        getCustomer: {
          id: "c1",
          name: "Pat Lee",
          phone: "2125550100",
          pets: [{ id: "p1", name: "Biscuit", breed: "Beagle", size: "M", vaccinations: [] }],
        },
        checkAppointment: () => check,
        bookAppointment: { ...appt(), confirmation: null },
      },
    );
    const quote = await screen.findByLabelText("Quote");
    expect(quote.textContent).toContain("$80.00");
    expect(quote.textContent).toContain("2 hr 10 min + 15 min buffer");
    const book = screen.getByRole("button", { name: "Book it" }) as HTMLButtonElement;
    expect(book.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Book anyway"));
    expect(book.disabled).toBe(false);
    // A confirmation goes by default; unticked, none.
    const confirm = screen.getByLabelText("Send a confirmation") as HTMLInputElement;
    expect(confirm.checked).toBe(true);
    fireEvent.click(confirm);
    fireEvent.click(book);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("bookAppointment", expect.objectContaining({ confirm: false })),
    );

    check = {
      ...check,
      warnings: [],
      clash: "Sample Groomer A already has Rex at 9:00 AM. Pick another time or groomer.",
    };
    fireEvent.click(screen.getByLabelText("Teeth"));
    expect(await screen.findByText(/already has Rex/)).toBeTruthy();
    expect(book.disabled).toBe(true);
  });
});

describe("helpers", () => {
  it("writes hours and prices plainly", () => {
    expect(
      hoursText([
        { weekday: 1, start: "08:00", end: "16:00" },
        { weekday: 2, start: "08:00", end: "16:00" },
        { weekday: 6, start: "09:00", end: "15:00" },
      ]),
    ).toBe("Mon, Tue 8:00 AM – 4:00 PM; Sat 9:00 AM – 3:00 PM");
    expect(bySize({ S: 1000, M: 1000, L: 1000, XL: 1000 }, (n) => `$${n / 100}`, true)).toBe("+$10 flat");
    expect(bySize({ S: 90, M: 120, L: 150, XL: 180 }, String)).toBe("90 · 120 · 150 · 180");
  });
});
