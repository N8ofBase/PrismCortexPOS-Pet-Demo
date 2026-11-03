import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type { Role } from "@pet-pos/core";
import type { Me } from "@pet-pos/api";
import { AdminShell } from "../src/layout/AdminShell.tsx";
import { meFor } from "./render.tsx";

afterEach(cleanup);

const me = (role: Role): Me => meFor(role);

function navLabels(role: Role, path = "/") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AdminShell me={me(role)} onSwitchRole={vi.fn()} onResetDemo={vi.fn(async () => {})} />
    </MemoryRouter>,
  );
  return within(screen.getByRole("navigation", { name: "Main" }))
    .getAllByRole("link")
    .map((a) => a.textContent);
}

describe("AdminShell", () => {
  it("shows the owner every section", () => {
    expect(navLabels("owner")).toEqual([
      "Register",
      "Grooming",
      "Inventory",
      "Customers",
      "Sales",
      "Reports",
      "Astro",
      "Settings",
    ]);
  });

  it("hides owner-only sections from a cashier", () => {
    expect(navLabels("cashier")).toEqual(["Register", "Grooming", "Inventory", "Customers", "Astro"]);
  });

  it("gives a groomer only what they use", () => {
    expect(navLabels("groomer")).toEqual(["Grooming", "Customers"]);
  });

  it("sends a cashier away from Settings to their first section", () => {
    navLabels("cashier", "/settings");
    const nav = within(screen.getByRole("navigation", { name: "Main" }));
    expect(nav.getByRole("link", { name: "Register" }).getAttribute("aria-current")).toBe("page");
  });

  it("always shows the demo banner", () => {
    navLabels("cashier");
    expect(screen.getByText("Demo · data stays on this device")).toBeTruthy();
  });
});

describe("sidebar branding", () => {
  it("shows the logo and uses readable text on the brand color", () => {
    const m = meFor("owner");
    m.business.brandColor = "#ffeb3b";
    m.business.logo = "data:image/png;base64,AAAA";
    render(
      <MemoryRouter>
        <AdminShell me={m} onSwitchRole={vi.fn()} onResetDemo={vi.fn(async () => {})} />
      </MemoryRouter>,
    );
    const header = screen.getByTestId("store-header");
    expect(header.style.background).toMatch(/#ffeb3b|rgb\(255, 235, 59\)/);
    expect(header.style.color).toMatch(/#18211e|rgb\(24, 33, 30\)/);
    expect(screen.getByRole("img", { name: "Sample Pet Store (DEMO) logo" })).toBeTruthy();
  });
});
