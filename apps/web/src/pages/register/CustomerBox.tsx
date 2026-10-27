import { useMutation, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { formatDate, formatMoney, formatPhone, normalizePhone } from "@pet-pos/core";
import type { CustomerCard, GroomToCheckOut, ProductRow, RegisterCustomer } from "@pet-pos/api";
import { useSession } from "../../session.tsx";
import { errorMessage } from "../../ui/errors.ts";
import { useToast } from "../../ui/Toast.tsx";
import { BirthdayTag, PetChip } from "../customers/bits.tsx";

const rewardsReady = (c: CustomerCard) => c.punchCards.filter((p) => p.balance >= p.buyCount).length;

/** "Customer": find by phone or name, quick add, or show the attached customer. */
export function CustomerBox({
  customer,
  onAttach,
  onDrop,
  onAddProduct,
  groomsOnTicket = [],
  onAddGroom,
}: {
  customer: RegisterCustomer | null;
  onAttach: (c: RegisterCustomer) => void;
  onDrop: () => void;
  onAddProduct: (p: ProductRow) => void;
  groomsOnTicket?: string[];
  onAddGroom?: (g: { appointmentId: string; name: string; priceCents: number; depositCents: number }) => void;
}) {
  if (customer)
    return (
      <>
        <Attached c={customer} onDrop={onDrop} onAddProduct={onAddProduct} />
        {onAddGroom && (
          <GroomsWaiting customerId={customer.card.id} onTicket={groomsOnTicket} onAdd={onAddGroom} />
        )}
      </>
    );
  return <Lookup onAttach={onAttach} />;
}

function Attached({
  c,
  onDrop,
  onAddProduct,
}: {
  c: RegisterCustomer;
  onDrop: () => void;
  onAddProduct: (p: ProductRow) => void;
}) {
  const r = rewardsReady(c.card);
  return (
    <div className="cust">
      <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 4 }}>
        <span>
          <b>{c.card.name}</b>{" "}
          {r > 0 && (
            <span className="tag astro">
              {r} reward{r > 1 ? "s" : ""} ready
            </span>
          )}
        </span>
        <span className="muted small">{formatPhone(c.card.phone)}</span>
        {c.card.pets.length > 0 && (
          <div>
            {c.card.pets.map((p) => (
              <PetChip key={p.id} pet={p} />
            ))}
          </div>
        )}
        <BirthdayTag birthday={c.card.birthday} />
        {c.usuallyBuys.length > 0 && (
          <div style={{ display: "grid", gap: 4 }}>
            <span className="muted small" style={{ textTransform: "uppercase", letterSpacing: ".05em" }}>
              Usually buys
              {c.lastVisit
                ? ` · last visit ${formatDate(new Date(c.lastVisit).toISOString().slice(0, 10))}`
                : ""}
            </span>
            <div className="actions">
              {c.usuallyBuys.map((p) => (
                <button key={p.id} type="button" className="small" onClick={() => onAddProduct(p)}>
                  + {p.name} <span className="muted">×{p.times}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <button type="button" className="link" onClick={onDrop}>
        Change
      </button>
    </div>
  );
}

function Lookup({ onAttach }: { onAttach: (c: RegisterCustomer) => void }) {
  const { api } = useSession();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [newName, setNewName] = useState("");
  const query = useDeferredValue(q.trim());
  const digits = query.replace(/\D/g, "");
  const searchable = digits.length >= 3 || (!digits && query.length >= 2);
  const hits = useQuery({
    queryKey: ["customers", "register", query],
    queryFn: () => api.call("searchCustomers", { q: query }),
    enabled: searchable,
  });

  const attach = useMutation({
    mutationFn: (id: string) => api.call("registerCustomer", { id }),
    onSuccess: (c) => {
      onAttach(c);
      setQ("");
    },
    onError: (err) => toast(errorMessage(err)),
  });

  const add = useMutation({
    mutationFn: async () => {
      const { id } = await api.call("saveCustomer", {
        customer: {
          name: newName,
          phone: query,
          email: "",
          street: "",
          city: "",
          state: "",
          zip: "",
          birthday: "",
          smsOptIn: false,
          notes: "",
        },
        pets: [],
      });
      return api.call("registerCustomer", { id });
    },
    onSuccess: (c) => {
      toast("Customer added");
      onAttach(c);
      setQ("");
      setNewName("");
    },
    onError: (err) => toast(errorMessage(err)),
  });

  const list = searchable ? (hits.data ?? []) : [];
  const phone = normalizePhone(query);

  return (
    <form
      className="cust"
      style={{ display: "grid", gap: 6 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (list.length === 1) attach.mutate(list[0]!.id);
      }}
    >
      <label style={{ color: "var(--fg)", fontWeight: 700 }}>
        Customer
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          inputMode="tel"
          placeholder="Phone number or name"
          autoComplete="off"
        />
      </label>
      {!query && (
        <span className="muted small">Type a phone number to find a customer and their Astro cards.</span>
      )}
      {list.slice(0, 6).map((c) => {
        const r = rewardsReady(c);
        return (
          <button
            key={c.id}
            type="button"
            style={{ textAlign: "left", display: "flex", justifyContent: "space-between", gap: 8 }}
            onClick={() => attach.mutate(c.id)}
          >
            <span>
              <b>{c.name}</b> <span className="muted mono">{formatPhone(c.phone)}</span>
              {c.pets.length > 0 && <span className="sub">{c.pets.map((p) => p.name).join(", ")}</span>}
            </span>
            {r > 0 && <span className="tag astro">{r} ready</span>}
          </button>
        );
      })}
      {list.length > 6 && (
        <span className="muted small">{list.length - 6} more. Keep typing to narrow it down.</span>
      )}
      {searchable && hits.isSuccess && list.length === 0 && phone && (
        <>
          <span className="muted small">No customer with {formatPhone(phone)}. Add them:</span>
          <div className="actions" style={{ flexWrap: "nowrap" }}>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Customer name"
              aria-label="New customer name"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (newName.trim()) add.mutate();
                }
              }}
            />
            <button
              type="button"
              className="primary"
              disabled={!newName.trim() || add.isPending}
              onClick={() => add.mutate()}
            >
              Add
            </button>
          </div>
        </>
      )}
      {searchable && hits.isSuccess && list.length === 0 && !phone && (
        <span className="muted small">No match yet.</span>
      )}
    </form>
  );
}

const GROOM_STATUS: Record<string, string> = {
  booked: "booked",
  checked_in: "checked in",
  in_progress: "in progress",
  ready: "ready for pickup",
};

/** Today's unpaid grooms for the attached customer, one tap to put on the ticket. */
export function GroomsWaiting({
  customerId,
  onTicket,
  onAdd,
}: {
  customerId: string;
  onTicket: string[];
  onAdd: (g: { appointmentId: string; name: string; priceCents: number; depositCents: number }) => void;
}) {
  const { api } = useSession();
  const q = useQuery({
    queryKey: ["groomsToCheckOut", customerId],
    queryFn: () => api.call("groomsToCheckOut", { customerId }),
  });
  const waiting = (q.data ?? []).filter((g: GroomToCheckOut) => !onTicket.includes(g.appointmentId));
  if (!waiting.length) return null;
  return (
    <div className="astro-box" aria-label="Grooms waiting">
      <h3>Grooming today</h3>
      {waiting.map((g) => (
        <div
          key={g.appointmentId}
          className="actions"
          style={{ alignItems: "center", justifyContent: "space-between" }}
        >
          <span>
            <b>{g.petName}</b> · {g.label} · {GROOM_STATUS[g.status] ?? g.status}
          </span>
          <button
            type="button"
            onClick={() =>
              onAdd({
                appointmentId: g.appointmentId,
                name: `${g.label} · ${g.petName}`,
                priceCents: g.priceCents,
                depositCents: g.depositCents,
              })
            }
          >
            Add {formatMoney(g.priceCents)}
            {g.depositCents > 0 && ` (${formatMoney(g.depositCents)} deposit paid)`}
          </button>
        </div>
      ))}
    </div>
  );
}
