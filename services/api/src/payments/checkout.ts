// Payment links for deposits, behind one small interface like the card reader. Demo mode
// uses SimulatedCheckout: the booking page shows a stand-in payment page with Pay and
// Cancel. Hosted mode (with Phase 2d) swaps in Square Payment Links, with Square's
// webhook calling markDepositPaid(). Card numbers never reach this code: Square holds
// them, we keep its references and amounts.

export interface DepositLink {
  /** Square's payment link id (simulated: "simlink_…"). */
  linkId: string;
  /** Where the customer pays. */
  url: string;
}

export interface DepositCheckout {
  readonly name: string;
  createLink(v: { depositId: string; amountCents: number; description: string }): Promise<DepositLink>;
  /** Refunds part or all of a paid deposit. */
  refund(providerRef: string, amountCents: number): Promise<{ refundRef: string }>;
}

function simRef(prefix: string): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export class SimulatedCheckout implements DepositCheckout {
  readonly name = "Square payment link (simulated)";

  async createLink({ depositId }: { depositId: string }): Promise<DepositLink> {
    return { linkId: simRef("simlink"), url: `/book/pay/${depositId}` };
  }

  async refund(): Promise<{ refundRef: string }> {
    return { refundRef: simRef("simrefund") };
  }
}

/** The payment links in use. Demo mode only has the simulated one. */
export const checkout: DepositCheckout = new SimulatedCheckout();
