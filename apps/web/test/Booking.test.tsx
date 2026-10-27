import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BookingPage, MyPet } from "@pet-pos/api";
import { addDays, todayIso } from "@pet-pos/core";
import type { PublicApi } from "../src/api/client.ts";
import { BookFlow, estimate } from "../src/book/BookFlow.tsx";
import { BookingContext } from "../src/book/context.ts";
import { SignIn } from "../src/book/SignIn.tsx";

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
  depositRule: "off",
  holdMinutes: 15,
  services: [
    {
      id: "bath",
      name: "Bath & brush",
      kind: "main",
      description: null,
      priceCents: { S: 3500, M: 4500, L: 6000, XL: 7500 },
      minutes: { S: 60, M: 75, L: 90, XL: 120 },
      depositCents: 0,
    },
    {
      id: "teeth",
      name: "Teeth brushing",
      kind: "addon",
      description: null,
      priceCents: { S: 1000, M: 1000, L: 1000, XL: 1000 },
      minutes: { S: 10, M: 10, L: 10, XL: 10 },
      depositCents: 0,
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
  const signIn = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <BookingContext.Provider
        value={{ api: { call } as unknown as PublicApi, page, name: "Pat", signIn, signOut: vi.fn() }}
      >
        {ui}
      </BookingContext.Provider>
    </QueryClientProvider>,
  );
  return { call, signIn };
}

describe("signing in", () => {
  it("shows the demo code, asks a new customer's name, and signs in", async () => {
    let tries = 0;
    const { call, signIn } = renderBook(<SignIn />, {
      requestCode: { sentTo: "a text to (212) 555-0100", demoCode: "482913" },
      verifyCode: () => {
        tries++;
        if (tries === 1)
          return { status: "wrong", message: "That code isn't right. Check it, or ask for a new one." };
        if (tries === 2) return { status: "needs_name" };
        return { status: "signed_in", token: "t", name: "Pat Lee" };
      },
    });
    fireEvent.change(screen.getByLabelText("Mobile number or email"), { target: { value: "2125550100" } });
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
    expect(await screen.findByText("482913")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "111111" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/isn't right/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.change(await screen.findByLabelText(/Your name/), { target: { value: "Pat Lee" } });
    fireEvent.click(screen.getByRole("button", { name: "Create my account" }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith("t", "Pat Lee"));
    expect(call).toHaveBeenLastCalledWith("verifyCode", {
      contact: "2125550100",
      code: "111111",
      name: "Pat Lee",
    });
  });
});

const biscuit: MyPet = {
  id: "p1",
  name: "Biscuit",
  species: "dog",
  breed: "Beagle",
  size: "M",
  rabiesLapsed: false,
};

describe("booking steps", () => {
  it("prices from the menu for the pet's size", () => {
    expect(estimate(page, "bath", ["teeth"], "M")).toEqual({ priceCents: 5500, minutes: 85 });
  });

  it("greys out full days, offers times, and books the one picked", async () => {
    const d1 = addDays(todayIso(), 1);
    const d2 = addDays(todayIso(), 2);
    const onDone = vi.fn();
    const { call } = renderBook(<BookFlow pets={[biscuit]} onDone={onDone} />, {
      openTimes: [
        { day: d1, times: [] },
        { day: d2, times: [540, 600] },
      ],
      bookOnline: { id: "a1", petName: "Biscuit" },
    });
    fireEvent.click(screen.getByLabelText(/Bath & brush/));
    const days = await screen.findByRole("group", { name: "Days" });
    const [full, open] = [...days.querySelectorAll("button")];
    expect((full as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(open!);
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    expect(screen.getByRole("region", { name: "Review" }).textContent).toContain("$45.00");
    fireEvent.click(screen.getByRole("button", { name: "Book" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("bookOnline", {
        petId: "p1",
        serviceId: "bath",
        addonIds: [],
        staffId: null,
        day: d2,
        start: 600,
        notes: "",
      }),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it("stops a pet whose rabies has lapsed", () => {
    renderBook(<BookFlow pets={[{ ...biscuit, rabiesLapsed: true }]} onDone={() => {}} />, {});
    expect(
      screen.getByText(/Biscuit's rabies vaccination has expired. Please call us at \(212\) 555-0199/),
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Bath & brush/));
    expect(screen.queryByRole("region", { name: "When" })).toBeNull();
  });
});
