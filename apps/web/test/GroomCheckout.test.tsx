import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroomToCheckOut, PetGroomingHistory } from "@pet-pos/api";
import { PetGroomingHistory as History } from "../src/pages/customers/PetGroomingHistory.tsx";
import { fitSize } from "../src/pages/grooming/photo.ts";
import { NoteForm } from "../src/pages/grooming/Notes.tsx";
import { GroomsWaiting } from "../src/pages/register/CustomerBox.tsx";
import {
  addGroom,
  EMPTY_TICKET,
  isEmpty,
  priceTicket,
  removeGroom,
  toInput,
} from "../src/pages/register/ticket.ts";
import { renderAs } from "./render.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const groom = { appointmentId: "a1", name: "Full groom + Teeth · Biscuit", priceCents: 8000 };

describe("a groom on the ticket", () => {
  it("is one line at the booked price, untaxed unless the store taxes grooming", () => {
    let t = addGroom(EMPTY_TICKET, groom);
    t = addGroom(t, groom);
    expect(t.grooms).toHaveLength(1);
    expect(isEmpty(t)).toBe(false);
    expect(priceTicket(t, 7000, true).priced).toMatchObject({
      subtotalCents: 8000,
      taxCents: 0,
      totalCents: 8000,
    });
    expect(priceTicket(t, 7000, true, true).priced).toMatchObject({ taxCents: 560, totalCents: 8560 });
    expect(toInput(t).lines).toEqual([{ key: "groom-a1", appointmentId: "a1", qty: 1, applyOffer: false }]);
    expect(isEmpty(removeGroom(t, "groom-a1"))).toBe(true);
  });
});

describe("grooms waiting at the register", () => {
  it("offers today's unpaid grooms not already on the ticket", async () => {
    const waiting: GroomToCheckOut[] = [
      {
        appointmentId: "a1",
        petName: "Biscuit",
        label: "Full groom",
        status: "ready",
        priceCents: 7000,
        groomerName: "A",
        depositCents: 0,
      },
      {
        appointmentId: "a2",
        petName: "Rex",
        label: "Bath",
        status: "in_progress",
        priceCents: 6000,
        groomerName: "B",
        depositCents: 0,
      },
    ];
    const onAdd = vi.fn();
    renderAs("cashier", <GroomsWaiting customerId="c1" onTicket={["a2"]} onAdd={onAdd} />, {
      groomsToCheckOut: waiting,
    });
    expect(await screen.findByText(/ready for pickup/)).toBeTruthy();
    expect(screen.queryByText("Rex")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add $70.00" }));
    expect(onAdd).toHaveBeenCalledWith({
      appointmentId: "a1",
      name: "Full groom · Biscuit",
      priceCents: 7000,
      depositCents: 0,
    });
  });
});

describe("grooming notes", () => {
  it("fits photos inside 1280 px, keeping the shape", () => {
    expect(fitSize(4032, 3024)).toEqual({ width: 1280, height: 960 });
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitSize(3000, 4000)).toEqual({ width: 960, height: 1280 });
  });

  it("saves a note and opens the camera for photos", async () => {
    const { call } = renderAs("groomer", <NoteForm appointmentId="a1" />, {
      addGroomingNote: { id: "n1", note: "Short", photos: [] },
    });
    const picker = screen.getByLabelText("Add before photo") as HTMLInputElement;
    expect(picker.getAttribute("capture")).toBe("environment");
    expect(picker.accept).toBe("image/*");
    const save = screen.getByRole("button", { name: "Save note" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "After" }));
    expect(screen.getByLabelText("Add after photo")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Short summer cut" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("addGroomingNote", {
        appointmentId: "a1",
        note: "Short summer cut",
        photos: [],
      }),
    );
  });
});

describe("the pet's grooming history", () => {
  it("lists grooms with notes and photos", async () => {
    const history: PetGroomingHistory = {
      grooms: [
        {
          appointmentId: "a1",
          date: new Date("2026-09-29T10:00:00"),
          label: "Full groom",
          groomerName: "Sample Groomer A",
          priceCents: 7000,
          status: "done",
          receiptNumber: 1012,
          notes: [
            {
              id: "n1",
              appointmentId: "a1",
              staffId: "s1",
              staffName: "Sample Groomer A",
              note: "Matted behind the ears",
              createdAt: new Date("2026-09-29T12:00:00"),
              photos: [
                { id: "p1", kind: "after", src: "data:image/jpeg;base64,AAAA", width: 640, height: 480 },
              ],
              canDelete: false,
            },
          ],
        },
      ],
      next: null,
    };
    renderAs("cashier", <History petId="p1" />, { petGroomingHistory: history });
    expect(await screen.findByText("Matted behind the ears")).toBeTruthy();
    expect(screen.getByText(/receipt #1012/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "after photo" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open after photo" }));
    expect(screen.getByRole("dialog", { name: "Photo" })).toBeTruthy();
  });
});
