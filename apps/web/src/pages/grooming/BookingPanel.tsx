import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useState, type FormEvent } from "react";
import {
  durationText,
  formatMoney,
  formatPhone,
  minutesToTime,
  SIZE_HINT,
  SIZES,
  type PetSize,
} from "@pet-pos/core";
import type { AppointmentRow, BookingInput, NotifyResult } from "@pet-pos/api";
import { useSession } from "../../session.tsx";
import { errorMessage } from "../../ui/errors.ts";
import { SlideOver } from "../../ui/SlideOver.tsx";
import { useToast } from "../../ui/Toast.tsx";

export interface BookingStart {
  day: string;
  staffId?: string;
  /** Minutes since midnight. */
  start?: number;
  customerId?: string;
}

/** Start times every 15 minutes, 7 AM to 8 PM. */
const TIMES = Array.from({ length: (20 - 7) * 4 + 1 }, (_, i) => 7 * 60 + i * 15);

const clock = (n: number) => {
  const h = Math.floor(n / 60);
  return `${((h + 11) % 12) + 1}:${String(n % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

/** Book a new appointment, or edit one. The quote and warnings come from the server as you go. */
export function BookingPanel({
  from,
  editing,
  onClose,
}: {
  from: BookingStart;
  editing?: AppointmentRow;
  onClose: () => void;
}) {
  const { api } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [customerId, setCustomerId] = useState<string | null>(editing?.customerId ?? from.customerId ?? null);
  const [petId, setPetId] = useState<string | null>(editing?.petId ?? null);
  const [size, setSize] = useState<PetSize | "">("");
  const [serviceId, setServiceId] = useState<string>(editing?.serviceId ?? "");
  const [addonIds, setAddonIds] = useState<string[]>(editing?.addons.map((a) => a.serviceId) ?? []);
  const [staffId, setStaffId] = useState<string>(editing?.staffId ?? from.staffId ?? "");
  const [day, setDay] = useState(from.day);
  const [start, setStart] = useState<number>(editing?.start ?? from.start ?? 10 * 60);
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [override, setOverride] = useState(false);
  const [confirm, setConfirm] = useState(true);

  const services = useQuery({ queryKey: ["services"], queryFn: () => api.call("listServices", {}) });
  const groomers = useQuery({ queryKey: ["groomers"], queryFn: () => api.call("listGroomers", {}) });
  const customer = useQuery({
    queryKey: ["customer", customerId],
    queryFn: () => api.call("getCustomer", { id: customerId! }),
    enabled: !!customerId,
  });
  const mains = (services.data ?? []).filter((s) => s.kind === "main");
  const addons = (services.data ?? []).filter((s) => s.kind === "addon");
  const service = serviceId || mains[0]?.id || "";
  const groomer = staffId || groomers.data?.[0]?.staffId || "";
  const pets = customer.data?.pets ?? [];
  const pet = pets.find((p) => p.id === petId) ?? (pets.length === 1 ? pets[0] : undefined);
  const needsSize = !!pet && !pet.size;

  const input: BookingInput | null =
    customerId && pet && service && groomer && (!needsSize || size)
      ? {
          customerId,
          petId: pet.id,
          serviceId: service,
          addonIds,
          staffId: groomer,
          day,
          start: minutesToTime(start),
          size: needsSize ? (size as PetSize) : null,
          notes,
          override,
        }
      : null;
  const check = useQuery({
    queryKey: ["checkAppointment", { ...input, notes: "", override: false }, editing?.id],
    queryFn: () => api.call("checkAppointment", { ...input!, id: editing?.id }),
    enabled: !!input,
    placeholderData: keepPreviousData,
  });

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api.call("updateAppointment", { ...input!, id: editing.id })
        : api.call("bookAppointment", { ...input!, confirm }),
    onSuccess: (a) => {
      const c = "confirmation" in a ? (a.confirmation as NotifyResult | null) : null;
      toast(
        editing
          ? "Appointment saved"
          : `Booked ${a.petName} with ${a.groomerName}${
              c && "sent" in c
                ? ` · confirmation sent by ${c.sent.channel === "sms" ? "text" : "email"} (a preview in the demo)`
                : c && "skipped" in c
                  ? ` · no confirmation: ${c.skipped}`
                  : ""
            }`,
      );
      void qc.invalidateQueries({ queryKey: ["groomingDay"] });
      void qc.invalidateQueries({ queryKey: ["customerAppointments"] });
      void qc.invalidateQueries({ queryKey: ["customer"] });
      onClose();
    },
    onError: (err) => toast(errorMessage(err)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (input) save.mutate();
  }

  const c = check.data;
  const warnings = c?.warnings ?? [];
  const ready = !!input && !!c && !c.clash && (warnings.length === 0 || override) && !check.isFetching;

  return (
    <SlideOver title={editing ? "Edit appointment" : "Book an appointment"} onClose={onClose}>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        {customerId && customer.data ? (
          <div className="cust">
            <span>
              <b>{customer.data.name}</b> <span className="muted">{formatPhone(customer.data.phone)}</span>
            </span>
            {!editing && (
              <button
                type="button"
                className="link"
                onClick={() => {
                  setCustomerId(null);
                  setPetId(null);
                }}
              >
                Change
              </button>
            )}
          </div>
        ) : (
          <CustomerSearch
            onPick={(id) => {
              setCustomerId(id);
              setPetId(null);
            }}
          />
        )}

        {customerId && customer.data && (
          <>
            {pets.length === 0 ? (
              <p className="muted">This customer has no pets yet. Add one on their profile first.</p>
            ) : (
              <label>
                Pet
                <select value={pet?.id ?? ""} onChange={(e) => setPetId(e.target.value)} required>
                  {pets.length > 1 && <option value="">Pick a pet</option>}
                  {pets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.breed ? ` · ${p.breed}` : ""}
                      {p.size ? ` · size ${p.size}` : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {needsSize && (
              <label>
                {pet.name}'s size (saved on the pet)
                <select value={size} onChange={(e) => setSize(e.target.value as PetSize)} required>
                  <option value="">Pick a size</option>
                  {SIZES.map((z) => (
                    <option key={z} value={z}>
                      {z} · {SIZE_HINT[z]}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}

        <div className="form">
          <label>
            Service
            <select value={service} onChange={(e) => setServiceId(e.target.value)}>
              {mains.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Groomer
            <select value={groomer} onChange={(e) => setStaffId(e.target.value)}>
              {(groomers.data ?? []).map((g) => (
                <option key={g.staffId} value={g.staffId}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {addons.length > 0 && (
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", gap: 12, flexWrap: "wrap" }}>
            <legend className="muted small" style={{ marginBottom: 4 }}>
              Add-ons
            </legend>
            {addons.map((a) => (
              <label className="check" key={a.id}>
                <input
                  type="checkbox"
                  checked={addonIds.includes(a.id)}
                  onChange={(e) =>
                    setAddonIds(e.target.checked ? [...addonIds, a.id] : addonIds.filter((x) => x !== a.id))
                  }
                />
                {a.name}
              </label>
            ))}
          </fieldset>
        )}
        <div className="form">
          <label>
            Date
            <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
          </label>
          <label>
            Start
            <select value={start} onChange={(e) => setStart(Number(e.target.value))} aria-label="Start time">
              {(TIMES.includes(start) ? TIMES : [...TIMES, start].sort((a, b) => a - b)).map((t) => (
                <option key={t} value={t}>
                  {clock(t)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Notes for the groomer
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Nervous with dryers, short summer cut…"
          />
        </label>

        {check.isError && <p className="error-box">{errorMessage(check.error)}</p>}
        {c && input && (
          <div className="totals" aria-label="Quote">
            <div>
              <span>{c.quote.label}</span>
              <span className="num">{formatMoney(c.quote.priceCents)}</span>
            </div>
            <div className="muted">
              <span>
                Size {c.size} · {durationText(c.quote.minutes)}
                {c.quote.bufferMinutes ? ` + ${c.quote.bufferMinutes} min buffer` : ""}
              </span>
              <span>{c.when}</span>
            </div>
          </div>
        )}
        {c?.clash && (
          <p style={{ margin: 0, color: "var(--bad)", fontWeight: 700 }} role="alert">
            {c.clash}
          </p>
        )}
        {warnings.length > 0 && !c?.clash && (
          <div className="note" role="alert">
            {warnings.map((w) => (
              <span key={w}>{w}</span>
            ))}
            <label className="check">
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
              Book anyway
            </label>
          </div>
        )}

        {!editing && (
          <label className="check">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            Send a confirmation
          </label>
        )}
        <div className="actions">
          <button className="primary big" disabled={!ready || save.isPending}>
            {editing ? "Save changes" : "Book it"}
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        {!customerId && <p className="muted small">Pick a customer first.</p>}
      </form>
    </SlideOver>
  );
}

function CustomerSearch({ onPick }: { onPick: (id: string) => void }) {
  const { api } = useSession();
  const [q, setQ] = useState("");
  const term = useDeferredValue(q.trim());
  const hits = useQuery({
    queryKey: ["searchCustomers", term],
    queryFn: () => api.call("searchCustomers", { q: term }),
    enabled: term.length >= 2,
  });
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <label>
        Customer phone or name
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          inputMode="search"
          placeholder="Start typing a phone number or name"
          autoFocus
        />
      </label>
      {hits.data?.slice(0, 6).map((c) => (
        <button
          type="button"
          key={c.id}
          className="cust"
          onClick={() => onPick(c.id)}
          style={{ textAlign: "left" }}
        >
          <span>
            <b>{c.name}</b> <span className="muted">{formatPhone(c.phone)}</span>
          </span>
          <span className="muted small">{c.pets.map((p) => p.name).join(", ")}</span>
        </button>
      ))}
      {hits.data?.length === 0 && (
        <p className="muted small">No customer matches. Add them on Customers first.</p>
      )}
    </div>
  );
}
