import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BookingPage, MessageRow, MyMessageSettings } from "@pet-pos/api";
import type { PublicApi } from "../src/api/client.ts";
import { BookingContext } from "../src/book/context.ts";
import { MessagePrefs, Unsubscribe } from "../src/book/MessagePrefs.tsx";
import { MessagesView, sweepText } from "../src/pages/grooming/MessagesView.tsx";
import { renderAs } from "./render.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const row: MessageRow = {
  id: "m1",
  appointmentId: "a1",
  kind: "nudge",
  channel: "sms",
  to: "2125550102",
  subject: null,
  body: "Sample Pet Store: it's been 4 weeks since Clover's last groom. Book the next one: petpos-demo.prismcortex.net/book",
  status: "preview",
  createdAt: new Date(),
  petName: "Clover",
  customerName: "Sample Family",
};

describe("Grooming → Messages", () => {
  it("lists messages, filters by kind and sends what's due", async () => {
    const { call } = renderAs("cashier", <MessagesView />, {
      listMessages: [row],
      sendDueNow: { reminders: 1, nudges: 0, skipped: 1, quiet: false },
    });
    expect(await screen.findByText(/since Clover's last groom/)).toBeTruthy();
    expect(screen.getByText("Text (212) 555-0102")).toBeTruthy();
    expect(screen.getByText("Preview")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "reminder" } });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("listMessages", expect.objectContaining({ kind: "reminder" })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send due messages now" }));
    expect(
      await screen.findByText("Sent 1 reminder · 1 couldn't be sent (no text opt-in or email)"),
    ).toBeTruthy();
  });

  it("says plainly what the sweep did", () => {
    expect(sweepText({ reminders: 0, nudges: 2, skipped: 0, quiet: false })).toBe("Sent 2 rebook reminders");
    expect(sweepText({ reminders: 0, nudges: 0, skipped: 0, quiet: false })).toBe("Nothing was due");
    expect(sweepText({ reminders: 0, nudges: 0, skipped: 0, quiet: true })).toMatch(/quiet hours/);
  });
});

const page = { storeName: "Sample Pet Store" } as BookingPage;

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

describe("the customer's own message settings", () => {
  it("turns texts on with the consent wording, picks email, and turns off rebook reminders", async () => {
    const s: MyMessageSettings = {
      phone: "2125550100",
      email: "pat@example.com",
      smsOptIn: false,
      contactPref: null,
      nudgesOff: false,
      emailOff: false,
    };
    const { call } = renderBook(<MessagePrefs />, {
      myMessageSettings: s,
      saveMyMessageSettings: (i: unknown) => ({ ...s, ...(i as object) }),
    });
    const texts = await screen.findByLabelText(/Texts to \(212\) 555-0100/);
    expect(texts.closest("label")!.textContent).toContain("Reply STOP to opt out.");
    fireEvent.click(texts);
    fireEvent.change(screen.getByLabelText("Send them by"), { target: { value: "email" } });
    fireEvent.click(screen.getByLabelText("Remind me when it's time for the next groom"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("saveMyMessageSettings", {
        smsOptIn: true,
        contactPref: "email",
        nudgesOff: true,
        emailOff: false,
      }),
    );
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("unsubscribes from a rebook email's link", async () => {
    const { call } = renderBook(<Unsubscribe token="abc" />, {
      unsubscribe: { storeName: "Sample Pet Store", off: "nudges" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rebook reminders only" }));
    expect(await screen.findByText(/won't get rebook reminders from Sample Pet Store anymore/)).toBeTruthy();
    expect(call).toHaveBeenCalledWith("unsubscribe", { token: "abc", what: "nudges" });
  });
});
