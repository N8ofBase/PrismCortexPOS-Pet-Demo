import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { formatMoney } from "@pet-pos/core";
import type { DepositView } from "@pet-pos/api";
import { errorMessage } from "../ui/errors.ts";
import { useBooking } from "./context.ts";

/** The deposit id in /book/pay/<id>, or null. */
export function payIdFromPath(path: string): string | null {
  return /^\/book\/pay\/([0-9a-f-]{36})\/?$/.exec(path)?.[1] ?? null;
}

/**
 * Sends the customer to pay. The demo's links are our own stand-in page; a real Square
 * link leaves the site. Returns the deposit id when the stand-in page should show.
 */
export function goPay(url: string): string | null {
  const id = payIdFromPath(url);
  if (id) {
    history.pushState(null, "", url);
    return id;
  }
  location.assign(url);
  return null;
}

/** Demo only: stands in for Square's payment page. No card fields, and nothing is charged. */
export function PayPage({ id, onDone }: { id: string; onDone: (v: DepositView) => void }) {
  const { api } = useBooking();
  const d = useQuery({ queryKey: ["deposit", id], queryFn: () => api.call("depositStatus", { id }) });
  const answer = useMutation({
    mutationFn: (outcome: "paid" | "canceled") => api.call("simulateDepositPayment", { id, outcome }),
    onSuccess: (v) => onDone(v),
  });
  // Already paid, refunded or let go: nothing to pay here, so go back.
  const settled = d.data && d.data.status !== "pending" ? d.data : null;
  useEffect(() => {
    if (settled) onDone(settled);
  }, [settled, onDone]);

  if (d.isError) return <p className="error-box">{errorMessage(d.error)}</p>;
  if (!d.data) return <p className="muted">Opening the payment page…</p>;
  const v = d.data;
  if (settled) return null;
  return (
    <section className="panel pay-sim" aria-label="Payment" style={{ display: "grid", gap: 10 }}>
      <p className="note small" style={{ margin: 0 }}>
        Simulated Square checkout. In the demo there's no card to enter and nothing is charged.
      </p>
      <h2 style={{ margin: 0 }}>{v.storeName}</h2>
      <p style={{ margin: 0 }}>
        Deposit for {v.description}
        <br />
        <b className="num" style={{ fontSize: "1.6rem" }}>
          {formatMoney(v.amountCents)}
        </b>
      </p>
      {answer.isError && <p className="error-box">{errorMessage(answer.error)}</p>}
      <div className="actions">
        <button
          type="button"
          className="primary big"
          disabled={answer.isPending}
          onClick={() => answer.mutate("paid")}
        >
          Pay {formatMoney(v.amountCents)}
        </button>
        <button type="button" disabled={answer.isPending} onClick={() => answer.mutate("canceled")}>
          Cancel
        </button>
      </div>
    </section>
  );
}
