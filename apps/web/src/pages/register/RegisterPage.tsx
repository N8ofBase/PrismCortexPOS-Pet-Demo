import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  can,
  CATEGORIES,
  discountValueLabel,
  formatMoney,
  formatTaxPercent,
  stockLabel,
  stockStatus,
} from "@pet-pos/core";
import type { CheckoutResult, DiscountRow, ProductRow } from "@pet-pos/api";
import { useSession } from "../../session.tsx";
import { errorMessage } from "../../ui/errors.ts";
import { CameraButton } from "../../ui/scanner/CameraScanner.tsx";
import { useToast } from "../../ui/Toast.tsx";
import { CustomerBox } from "./CustomerBox.tsx";
import { DiscountPicker } from "./DiscountPicker.tsx";
import { PaymentPanel, type PayMode } from "./PaymentPanel.tsx";
import { ReceiptSend } from "../sales/ReceiptSend.tsx";
import { ReceiptView } from "./ReceiptView.tsx";
import {
  addGroom,
  addProduct,
  EMPTY_TICKET,
  isEmpty,
  removeGroom,
  loadTicket,
  priceTicket,
  removeDiscount,
  saveTicket,
  setQty,
  toggleOffer,
  toggleReward,
  toInput,
  type Ticket,
  type TicketDiscountState,
} from "./ticket.ts";

type Stage =
  | { kind: "ticket" }
  | { kind: "pay"; sale: CheckoutResult; mode: PayMode }
  | { kind: "done"; saleId: string; changeCents: number };

export function RegisterPage() {
  const { api, me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [ticket, setTicket] = useState<Ticket>(() => loadTicket(me.staff.id));
  const [stage, setStage] = useState<Stage>({ kind: "ticket" });
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const navigate = useNavigate();
  const [picker, setPicker] = useState<{ start?: DiscountRow } | null>(null);
  const [cashOffer, setCashOffer] = useState<DiscountRow | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  useEffect(() => saveTicket(me.staff.id, ticket), [ticket, me.staff.id]);

  // "Check out at register" on an appointment: attach the customer and put the groom on the ticket.
  const location = useLocation();
  const incoming = (location.state as { groom?: { appointmentId: string; customerId: string } } | null)
    ?.groom;
  useEffect(() => {
    if (!incoming) return;
    navigate(".", { replace: true, state: null });
    void (async () => {
      try {
        const current = loadTicket(me.staff.id);
        if (current.customer && current.customer.card.id !== incoming.customerId && !isEmpty(current))
          return toast("The register has another customer's ticket open. Finish or clear it first.");
        const [customer, grooms] = await Promise.all([
          api.call("registerCustomer", { id: incoming.customerId }),
          api.call("groomsToCheckOut", { customerId: incoming.customerId }),
        ]);
        const g = grooms.find((x) => x.appointmentId === incoming.appointmentId);
        if (!g) return toast("That groom is already paid or isn't today's.");
        const base =
          current.customer?.card.id === incoming.customerId
            ? current
            : { ...current, rewards: [], grooms: [] };
        setTicket(
          addGroom(
            { ...base, customer },
            {
              appointmentId: g.appointmentId,
              name: `${g.label} · ${g.petName}`,
              priceCents: g.priceCents,
              depositCents: g.depositCents,
            },
          ),
        );
        toast("Groom added to the ticket. Add any retail items, then take payment.");
      } catch (err) {
        toast(errorMessage(err));
      }
    })();
    // Runs once per hand-off from the grooming screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.appointmentId]);

  const products = useQuery({
    queryKey: ["products", "register", q.trim(), category],
    queryFn: () =>
      api.call("listProducts", { q: q.trim() || undefined, category: category || undefined, forSale: true }),
    placeholderData: (prev) => prev,
  });
  const discounts = useQuery({
    queryKey: ["discounts", "register"],
    queryFn: () => api.call("listDiscounts", {}),
  });

  const price = useMemo(
    () =>
      priceTicket(
        ticket,
        me.location?.taxRateMpct ?? 0,
        me.business.astroDiscountsBeforeTax,
        me.business.groomingTaxable,
      ),
    [ticket, me.location?.taxRateMpct, me.business.astroDiscountsBeforeTax, me.business.groomingTaxable],
  );

  /** Applies a change only if the ticket can still be priced; otherwise says why. */
  function update(next: Ticket) {
    const p = priceTicket(next, me.location?.taxRateMpct ?? 0, me.business.astroDiscountsBeforeTax);
    if (p.problem) return toast(p.problem);
    setTicket(next);
  }

  function add(p: ProductRow) {
    update(addProduct(ticket, p));
    setMessage(null);
    setUnknownCode(null);
    scanRef.current?.focus();
  }

  const selfApproves = can(me.staff.role, "discounts.approve");
  function applyDiscount(d: DiscountRow) {
    if (d.scope === "line" || d.askNote || (d.needsApproval && !selfApproves)) return setPicker({ start: d });
    applyDiscountState({ discount: d, lineKey: null, note: null, approvedBy: null, approverName: null });
  }
  function applyDiscountState(s: TicketDiscountState) {
    update({ ...ticket, discounts: [...ticket.discounts, s] });
    setPicker(null);
    scanRef.current?.focus();
  }

  async function scan(code: string) {
    const c = code.trim();
    if (!c) return;
    try {
      const p = await api.call("findByCode", { code: c, forSale: true });
      if (p) {
        add(p);
        setQ("");
        return;
      }
      const d = discounts.data?.find((x) => x.code && x.code.toLowerCase() === c.toLowerCase());
      if (d) {
        setQ("");
        return applyDiscount(d);
      }
      const matches = products.data ?? [];
      if (q.trim() === c && matches.length === 1) {
        add(matches[0]!);
        setQ("");
      } else if (matches.length > 1 && q.trim() === c) {
        setUnknownCode(null);
        setMessage("Several matches. Tap one.");
      } else {
        setUnknownCode(/^[0-9]{6,14}$/.test(c) ? c : null);
        setMessage(`No product or discount with code ${c}.`);
      }
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  const checkout = useMutation({
    mutationFn: (t: Ticket) => api.call("startCheckout", toInput(t)),
    onError: (err) => toast(errorMessage(err)),
  });

  async function pay(mode: PayMode, t: Ticket = ticket) {
    let next = t;
    if (mode !== "cash") {
      const cashOnly = next.discounts.filter((d) => d.discount.cashOnly);
      if (cashOnly.length) {
        next = { ...next, discounts: next.discounts.filter((d) => !d.discount.cashOnly) };
        setTicket(next);
        toast(`${cashOnly.map((d) => d.discount.name).join(", ")} removed: it's for cash only`);
      }
    }
    const sale = await checkout.mutateAsync(next).catch(() => null);
    if (!sale) return;
    if (sale.depositRefundedCents)
      toast(
        `The deposit was more than the sale: ${formatMoney(sale.depositRefundedCents)} refunded to the card that paid it`,
      );
    if (sale.paid) return finish(sale.saleId, 0);
    setStage({ kind: "pay", sale, mode });
  }

  function onCash() {
    const available = discounts.data?.find(
      (d) => d.cashOnly && !ticket.discounts.some((x) => x.discount.id === d.id),
    );
    if (available && !ticket.discounts.some((d) => d.discount.scope === "ticket" && !d.discount.combinable))
      return setCashOffer(available);
    void pay("cash");
  }

  function finish(saleId: string, changeCents: number) {
    setTicket(EMPTY_TICKET);
    setStage({ kind: "done", saleId, changeCents });
    for (const key of [
      "products",
      "product",
      "customers",
      "customer",
      "sales",
      "groomingDay",
      "groomsToCheckOut",
    ])
      void qc.invalidateQueries({ queryKey: [key] });
  }

  const categories = useMemo(() => {
    const seen = new Set((products.data ?? []).map((p) => p.category));
    return [...new Set([...CATEGORIES.filter((c) => seen.has(c)), ...seen])];
  }, [products.data]);

  return (
    <div className="register">
      <div>
        <form
          className="scan"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void scan(q);
          }}
        >
          <input
            ref={scanRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setMessage(null);
            }}
            placeholder="Scan barcode, type SKU or discount code, or search"
            aria-label="Scan barcode or search products"
            autoComplete="off"
            autoFocus
            disabled={stage.kind !== "ticket"}
          />
          <button className="primary" disabled={stage.kind !== "ticket"}>
            Add
          </button>
          {stage.kind === "ticket" && (
            <CameraButton label="Camera" title="Scan an item" onCode={(c) => void scan(c)} />
          )}
        </form>
        {message && (
          <div className="error-box" style={{ marginTop: 8, display: "grid", gap: 6 }}>
            <span>{message}</span>
            {unknownCode && can(me.staff.role, "products.edit") && (
              <div>
                <button
                  type="button"
                  onClick={() => navigate("/inventory", { state: { newBarcode: unknownCode } })}
                >
                  New product with barcode {unknownCode}
                </button>
              </div>
            )}
          </div>
        )}
        <div className="cat-tabs" role="toolbar" aria-label="Categories">
          <button type="button" aria-pressed={!category} onClick={() => setCategory("")}>
            All
          </button>
          {(category ? [...new Set([category, ...categories])] : categories).map((c) => (
            <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>
        <div className="grid">
          {(products.data ?? []).slice(0, 60).map((p) => (
            <button
              key={p.id}
              type="button"
              className="prod"
              onClick={() => add(p)}
              disabled={stage.kind !== "ticket"}
            >
              <span className="nm">{p.name}</span>
              <span className="muted small">{p.brand || p.category}</span>
              {p.astroProgramId && (
                <span>
                  <span className="tag astro">Astro FB</span>
                </span>
              )}
              {p.offerCents && (
                <span>
                  <span className="tag astro">Offer {formatMoney(p.offerCents)}</span>
                </span>
              )}
              <span className="row">
                <b className="num">{formatMoney(p.priceCents)}</b>
                <span className={`tag ${stockStatus(p.onHand, p.reorderAt)}`}>
                  {stockLabel(p.onHand, p.reorderAt)}
                </span>
              </span>
            </button>
          ))}
          {products.data?.length === 0 && <p className="muted">No products match. Add them in Inventory.</p>}
        </div>
      </div>

      <aside className="ticket" aria-label="Ticket">
        {stage.kind === "done" ? (
          <Done
            saleId={stage.saleId}
            changeCents={stage.changeCents}
            onNew={() => {
              setStage({ kind: "ticket" });
              setTimeout(() => scanRef.current?.focus(), 0);
            }}
          />
        ) : stage.kind === "pay" ? (
          <PaymentPanel
            sale={stage.sale}
            mode={stage.mode}
            onPaid={finish}
            onCanceled={() => {
              setStage({ kind: "ticket" });
              void qc.invalidateQueries({ queryKey: ["sales"] });
            }}
          />
        ) : (
          <TicketView
            ticket={ticket}
            price={price}
            onTicket={update}
            onDiscounts={() => setPicker({})}
            busy={checkout.isPending}
            onPay={(m) => (m === "cash" ? onCash() : void pay(m))}
          />
        )}
      </aside>

      {picker && (
        <DiscountPicker
          discounts={discounts.data ?? []}
          lines={ticket.lines}
          start={picker.start}
          onApply={applyDiscountState}
          onClose={() => setPicker(null)}
        />
      )}
      {cashOffer && (
        <div className="scrim" onClick={() => setCashOffer(null)}>
          <section
            className="panel cash-offer"
            role="dialog"
            aria-label="Cash discount"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>
              Apply {cashOffer.name} ({discountValueLabel(cashOffer)})?
            </h2>
            <p className="muted">It's for cash payments only.</p>
            <div className="actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const next = {
                    ...ticket,
                    discounts: [
                      ...ticket.discounts,
                      {
                        discount: cashOffer,
                        lineKey: null,
                        note: null,
                        approvedBy: null,
                        approverName: null,
                      },
                    ],
                  };
                  setCashOffer(null);
                  const p = priceTicket(
                    next,
                    me.location?.taxRateMpct ?? 0,
                    me.business.astroDiscountsBeforeTax,
                    me.business.groomingTaxable,
                  );
                  if (p.problem) return toast(p.problem);
                  setTicket(next);
                  void pay("cash", next);
                }}
              >
                Apply and pay cash
              </button>
              <button
                type="button"
                onClick={() => {
                  setCashOffer(null);
                  void pay("cash");
                }}
              >
                Pay cash without it
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function TicketView({
  ticket,
  price,
  onTicket,
  onDiscounts,
  onPay,
  busy,
}: {
  ticket: Ticket;
  price: ReturnType<typeof priceTicket>;
  onTicket: (t: Ticket) => void;
  onDiscounts: () => void;
  onPay: (m: PayMode) => void;
  busy: boolean;
}) {
  const { me } = useSession();
  const p = price.priced;
  const depositCents = ticket.grooms.reduce((s, g) => s + (g.depositCents ?? 0), 0);
  const lineDiscounts = (key: string) => p?.discounts.filter((d) => d.lineKey === key) ?? [];
  const cards = ticket.customer?.card.punchCards ?? [];
  const programsOnTicket = new Map(
    ticket.lines
      .filter((l) => l.product.astroProgramId)
      .map((l) => [l.product.astroProgramId!, l.product.astroProgramName ?? "Astro program"]),
  );

  return (
    <>
      <CustomerBox
        customer={ticket.customer}
        onAttach={(c) => onTicket({ ...ticket, customer: c, rewards: [], grooms: [] })}
        onDrop={() => onTicket({ ...ticket, customer: null, rewards: [], grooms: [] })}
        onAddProduct={(prod) => onTicket(addProduct(ticket, prod))}
        groomsOnTicket={ticket.grooms.map((g) => g.appointmentId)}
        onAddGroom={(g) => onTicket(addGroom(ticket, g))}
      />

      <div className="lines">
        {ticket.grooms.map((g) => {
          const pl = p?.lines.find((x) => x.key === g.key);
          return (
            <div className="line" key={g.key}>
              <span>
                <b>{g.name}</b>
                <span className="sub">Grooming</span>
                {lineDiscounts(g.key).map((d, i) => (
                  <span key={i} className={`sub ${d.source === "store" ? "store-disc" : "disc"}`}>
                    {d.name} −{formatMoney(d.amountCents)}
                  </span>
                ))}
              </span>
              <span style={{ display: "grid", justifyItems: "end", gap: 4 }}>
                <b className="num">{formatMoney(pl?.grossCents ?? g.priceCents)}</b>
                <button type="button" className="link" onClick={() => onTicket(removeGroom(ticket, g.key))}>
                  Remove
                </button>
              </span>
            </div>
          );
        })}
        {ticket.lines.map((l) => {
          const pl = p?.lines.find((x) => x.key === l.key);
          return (
            <div className="line" key={l.key}>
              <span>
                <b>{l.product.name}</b>
                <span className="sub mono">
                  {l.product.sku} · {formatMoney(l.product.priceCents)}
                </span>
                {l.qty > l.product.onHand && (
                  <span className="sub" style={{ color: "var(--warn)" }}>
                    {l.product.onHand <= 0 ? "None on hand" : `Only ${l.product.onHand} on hand`}
                  </span>
                )}
                {l.product.offerCents && (
                  <label className="check disc">
                    <input
                      type="checkbox"
                      checked={l.applyOffer}
                      onChange={() => onTicket(toggleOffer(ticket, l.key))}
                    />
                    Apply Astro offer: {l.product.offerLabel}
                  </label>
                )}
                {lineDiscounts(l.key).map((d, i) => (
                  <span key={i} className={`sub ${d.source === "store" ? "store-disc" : "disc"}`}>
                    {d.name} −{formatMoney(d.amountCents)}
                  </span>
                ))}
              </span>
              <span style={{ display: "grid", justifyItems: "end", gap: 4 }}>
                <b className="num">{formatMoney(pl?.grossCents ?? l.product.priceCents * l.qty)}</b>
                <span className="qty">
                  <button
                    type="button"
                    aria-label={`Fewer ${l.product.name}`}
                    onClick={() => onTicket(setQty(ticket, l.key, l.qty - 1))}
                  >
                    −
                  </button>
                  <span className="num">{l.qty}</span>
                  <button
                    type="button"
                    aria-label={`More ${l.product.name}`}
                    onClick={() => onTicket(setQty(ticket, l.key, l.qty + 1))}
                  >
                    +
                  </button>
                </span>
              </span>
            </div>
          );
        })}
        {isEmpty(ticket) && <p className="muted">Scan or tap a product to start a sale.</p>}
      </div>

      {(cards.length > 0 || programsOnTicket.size > 0) && (
        <div className="astro-box">
          <h3>Astro</h3>
          {!ticket.customer && programsOnTicket.size > 0 && (
            <span className="muted">
              This sale earns Astro frequent buyer credit. Attach a customer so it counts.
            </span>
          )}
          {ticket.customer &&
            [...new Set([...cards.map((c) => c.programId), ...programsOnTicket.keys()])].map((pid) => {
              const card = cards.find((c) => c.programId === pid);
              const have = card?.balance ?? 0;
              const adding = p?.earned[pid] ?? 0;
              const redeeming = ticket.rewards.includes(pid);
              const buy = card?.buyCount;
              const full = !!card && have >= card.buyCount;
              return (
                <div key={pid}>
                  <b>{card?.programName ?? programsOnTicket.get(pid)}</b>{" "}
                  <span className="muted num">
                    {have}
                    {buy ? `/${buy}` : ""}
                    {adding || redeeming ? ` → ${have - (redeeming && buy ? buy : 0) + adding}` : ""}
                  </span>
                  {full && programsOnTicket.has(pid) && (
                    <label className="check disc" style={{ fontWeight: 700 }}>
                      <input
                        type="checkbox"
                        checked={redeeming}
                        onChange={() => onTicket(toggleReward(ticket, pid))}
                      />
                      Redeem: {card!.rewardText}
                    </label>
                  )}
                  {full && !programsOnTicket.has(pid) && (
                    <span className="sub disc">Reward ready. Add a qualifying item to redeem.</span>
                  )}
                </div>
              );
            })}
        </div>
      )}

      {price.problem && <p className="error-box">{price.problem}</p>}
      {p && (
        <div className="totals">
          <div>
            <span>Subtotal</span>
            <span className="num">{formatMoney(p.subtotalCents)}</span>
          </div>
          {p.discounts.map((d, i) => (
            <div key={i} className={d.source === "store" ? "store-disc" : "disc"}>
              <span>
                {d.name}
                {d.lineKey === null && d.source === "store" && (
                  <TicketDiscountExtras ticket={ticket} discountId={d.discountId} onTicket={onTicket} />
                )}
              </span>
              <span className="num">−{formatMoney(d.amountCents)}</span>
            </div>
          ))}
          <div className="muted">
            <span>Tax {formatTaxPercent(me.location?.taxRateMpct ?? 0)}</span>
            <span className="num">{formatMoney(p.taxCents)}</span>
          </div>
          <div className="grand">
            <span>Total</span>
            <span className="num">{formatMoney(p.totalCents)}</span>
          </div>
          {depositCents > 0 && (
            <>
              <div>
                <span>Deposit paid online</span>
                <span className="num">−{formatMoney(Math.min(depositCents, p.totalCents))}</span>
              </div>
              <div>
                <b>Due</b>
                <b className="num">{formatMoney(Math.max(0, p.totalCents - depositCents))}</b>
              </div>
            </>
          )}
        </div>
      )}
      {ticket.discounts.some((d) => d.lineKey !== null) && (
        <div className="actions small">
          {ticket.discounts.map((d, i) =>
            d.lineKey === null ? null : (
              <button
                key={i}
                type="button"
                className="link"
                onClick={() => onTicket(removeDiscount(ticket, i))}
              >
                Remove {d.discount.name}
              </button>
            ),
          )}
        </div>
      )}

      <div className="pay">
        <button
          type="button"
          className="primary"
          disabled={isEmpty(ticket) || busy || !p}
          onClick={() => onPay("card")}
        >
          Card
        </button>
        <button
          type="button"
          className="primary"
          disabled={isEmpty(ticket) || busy || !p}
          onClick={() => onPay("cash")}
        >
          Cash
        </button>
        <button type="button" disabled={isEmpty(ticket) || busy || !p} onClick={() => onPay("split")}>
          Split
        </button>
      </div>
      <div className="actions">
        <button type="button" onClick={onDiscounts} disabled={isEmpty(ticket)}>
          Discounts
        </button>
        <button type="button" style={{ marginLeft: "auto" }} onClick={() => onTicket(EMPTY_TICKET)}>
          Clear ticket
        </button>
      </div>
    </>
  );
}

/** The note, approver and a remove link under a whole-ticket discount. */
function TicketDiscountExtras({
  ticket,
  discountId,
  onTicket,
}: {
  ticket: Ticket;
  discountId: string | null;
  onTicket: (t: Ticket) => void;
}) {
  const i = ticket.discounts.findIndex((d) => d.discount.id === discountId && d.lineKey === null);
  const d = ticket.discounts[i];
  if (!d) return null;
  return (
    <>
      {d.note ? ` · ${d.note}` : ""}
      {d.approverName ? ` · OK ${d.approverName}` : ""}{" "}
      <button
        type="button"
        className="link"
        aria-label={`Remove ${d.discount.name}`}
        onClick={() => onTicket(removeDiscount(ticket, i))}
      >
        ×
      </button>
    </>
  );
}

function Done({ saleId, changeCents, onNew }: { saleId: string; changeCents: number; onNew: () => void }) {
  const { api } = useSession();
  const receipt = useQuery({
    queryKey: ["sale", saleId],
    queryFn: () => api.call("getSale", { id: saleId }),
  });
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <h2>Sale complete</h2>
      {changeCents > 0 && (
        <p className="change-due">
          Change due <b className="num">{formatMoney(changeCents)}</b>
        </p>
      )}
      {receipt.data ? <ReceiptView receipt={receipt.data} /> : <p className="muted">Loading the receipt…</p>}
      <div className="actions">
        <button type="button" className="primary big" onClick={onNew} autoFocus>
          New sale
        </button>
        <button type="button" onClick={() => window.print()} disabled={!receipt.data}>
          Print receipt
        </button>
      </div>
      {receipt.data && <ReceiptSend receipt={receipt.data} />}
    </div>
  );
}
