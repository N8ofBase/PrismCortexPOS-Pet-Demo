// Renders a signed-in screen with a fake api, so screen tests don't need a database.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import type { Role } from "@pet-pos/core";
import type { Me } from "@pet-pos/api";
import type { Api } from "../src/api/client.ts";
import { SessionContext } from "../src/session.tsx";
import { ToastProvider } from "../src/ui/Toast.tsx";

export function meFor(role: Role): Me {
  return {
    staff: { id: "s1", name: `Sample ${role} (DEMO)`, role },
    business: {
      id: "b1",
      name: "Sample Pet Store (DEMO)",
      brandColor: null,
      logo: null,
      modules: {},
      astroDiscountsBeforeTax: true,
      groomingTaxable: false,
      textWhenReady: true,
      keepDepositOnNoShow: true,
    },
    location: { id: "l1", name: "Main store (DEMO)", taxRateMpct: 7000 },
  };
}

export function renderAs(role: Role, ui: ReactNode, responses: Record<string, unknown> = {}, path = "/") {
  // A response can be a function of the input, for screens that call with different inputs.
  const call = vi.fn(async (name: string, input?: unknown) => {
    if (!(name in responses)) throw new Error(`No fake response for ${name}`);
    const r = responses[name];
    return typeof r === "function" ? (r as (i: unknown) => unknown)(input) : r;
  });
  const api = { call } as unknown as Api;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <SessionContext.Provider
            value={{ api, me: meFor(role), switchRole: vi.fn(), resetDemo: vi.fn(async () => {}) }}
          >
            {ui}
          </SessionContext.Provider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, call };
}
