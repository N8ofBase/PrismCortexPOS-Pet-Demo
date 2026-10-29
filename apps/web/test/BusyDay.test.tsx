import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppointmentRow, CalloutRow, GroomingDay } from "@pet-pos/api";
import { addDays, todayIso, weekDays, weekStart } from "@pet-pos/core";
import { dropStart, SLOT_PX } from "../src/pages/grooming/Calendar.tsx";
import { CalloutPanel, initialChoices, toChanges } from "../src/pages/grooming/CalloutPanel.tsx";
import { WeekView, worksOn } from "../src/pages/grooming/WeekView.tsx";
import { GroomingTable } from "../src/pages/SalesPage.tsx";
import { ToastProvider, useToast } from "../src/ui/Toast.tsx";
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

describe("dragging", () => {
  it("turns the pointer's position into a snapped start time", () => {
    // Grid from 8:00; 30-minute rows of 34 px. Grabbed at the block's top.
    expect(dropStart(100 + 4 * SLOT_PX, 100, 480, 0)).toBe(600);
    // A little below 10:00 snaps back to 10:00; grabbed 30 minutes into the block.
    expect(dropStart(100 + 4 * SLOT_PX + 5, 100, 480, 30)).toBe(570);
    expect(dropStart(100 + 4 * SLOT_PX + 12, 100, 480, 0)).toBe(615);
  });
});

describe("Undo on the toast", () => {
  it("shows the action and runs it", () => {
    const undo = vi.fn();
    function Show() {
      const toast = useToast();
      return (
        <button
          type="button"
          onClick={() => toast("Moved Biscuit to 10:30 AM", { label: "Undo", onClick: undo })}
        >
          go
        </button>
      );
    }
    render(
      <ToastProvider>
        <Show />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(screen.getByRole("status").textContent).toContain("Moved Biscuit to 10:30 AM");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

const dayOf = (day: string, over: Partial<GroomingDay> = {}): GroomingDay => ({
  day,
  groomers: [
    { staffId: "g1", name: "Sample Groomer A", hours: { start: 480, end: 960 }, timeOff: [] },
    { staffId: "g2", name: "Sample Groomer B", hours: { start: 600, end: 1080 }, timeOff: [] },
  ],
  appointments: [],
  summary: { appointments: 0, inShop: 0, ready: 0, expectedCents: 0 },
  ...over,
});

describe("week view", () => {
  it("lays out groomers by day, greying days off and time off", async () => {
    const start = weekStart(todayIso());
    const days = weekDays(start).map((d, i) =>
      i === 1
        ? dayOf(d, {
            appointments: [appt()],
            groomers: [
              { staffId: "g1", name: "Sample Groomer A", hours: { start: 480, end: 960 }, timeOff: [] },
              {
                staffId: "g2",
                name: "Sample Groomer B",
                hours: { start: 600, end: 1080 },
                timeOff: [{ start: 0, end: 1440, note: "Vacation" }],
              },
            ],
            summary: { appointments: 1, inShop: 0, ready: 0, expectedCents: 7000 },
          })
        : i === 0
          ? dayOf(d, {
              groomers: [
                { staffId: "g1", name: "Sample Groomer A", hours: { start: 480, end: 960 }, timeOff: [] },
              ],
            })
          : dayOf(d),
    );
    expect(worksOn(days[1]!, "g2")).toBe(false);
    const onPickDay = vi.fn();
    renderAs(
      "cashier",
      <WeekView day={todayIso()} narrow={false} onOpen={() => {}} onPickDay={onPickDay} />,
      {
        groomingWeek: { start, days },
      },
    );
    const tue = addDays(start, 1);
    const cell = await screen.findByTestId(`cell-Sample Groomer A-${tue}`);
    expect(cell.textContent).toContain("Biscuit");
    expect(screen.getByTestId(`cell-Sample Groomer B-${tue}`).className).toContain("off");
    expect(screen.getByTestId(`cell-Sample Groomer B-${start}`).className).toContain("off");
    expect(screen.getByTestId(`cell-Sample Groomer A-${start}`).className).not.toContain("off");
    fireEvent.click(screen.getAllByRole("button", { name: /^Open / })[1]!);
    expect(onPickDay).toHaveBeenCalledWith(tue);
  });
});

describe("groomer called out", () => {
  const rows: CalloutRow[] = [
    { appointment: appt({ id: "a1", petName: "Biscuit", start: 540 }), suggestion: null },
    {
      appointment: appt({ id: "a2", petName: "Mo", start: 780 }),
      suggestion: { staffId: "g2", name: "Sample Groomer B" },
    },
  ];

  it("starts from the suggestions", () => {
    const c = initialChoices(rows);
    expect(c.a1).toEqual({ action: "leave", staffId: "", start: 540 });
    expect(toChanges(rows, c, "2026-10-21")).toEqual([
      { id: "a1", action: "leave" },
      { id: "a2", action: "move", staffId: "g2", day: "2026-10-21", start: 780 },
    ]);
  });

  it("shows each appointment with its suggestion and applies them", async () => {
    const { call } = renderAs("cashier", <CalloutPanel day="2026-10-21" onClose={() => {}} />, {
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
        {
          staffId: "g2",
          name: "Sample Groomer B",
          role: "groomer",
          grooms: true,
          active: true,
          hours: [],
          timeOff: [],
        },
      ],
      calloutPreview: rows,
      applyCallout: { moved: 1, canceled: 0, left: 1, texts: 1 },
    });
    await screen.findByRole("option", { name: "Sample Groomer A" });
    fireEvent.change(screen.getByLabelText("Groomer"), { target: { value: "g1" } });
    expect(await screen.findByText("Nobody is free then: needs a new time")).toBeTruthy();
    expect(screen.getByText("Suggested: Sample Groomer B at the same time")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("applyCallout", {
        staffId: "g1",
        day: "2026-10-21",
        changes: [
          { id: "a1", action: "leave" },
          { id: "a2", action: "move", staffId: "g2", day: "2026-10-21", start: 780 },
        ],
        notify: true,
        addTimeOff: true,
      }),
    );
  });
});

describe("grooming on the Sales page", () => {
  it("lists each groomer's grooms and sales with a total", () => {
    render(
      <GroomingTable
        grooming={[
          { staffId: "g1", name: "Sample Groomer A", grooms: 2, salesCents: 15000, refundCents: 0 },
          { staffId: "g2", name: "Sample Groomer B", grooms: 1, salesCents: 0, refundCents: 6000 },
        ]}
        noShows={1}
      />,
    );
    const t = screen.getByRole("region", { name: "Grooming by groomer" }).textContent!;
    expect(t).toContain("$150.00");
    expect(t).toContain("$75.00");
    expect(t).toContain("−$60.00");
    expect(t).toContain("Total");
    expect(t).toContain("1 no-show on this day.");
  });
});
