import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import {
  bookingDeposit,
  clockText,
  durationText,
  formatMoney,
  formatPhone,
  shortDay,
  SIZE_HINT,
  SIZES,
  SPECIES,
  SPECIES_LABEL,
  todayIso,
  type PetSize,
  type Species,
} from "@pet-pos/core";
import type { BookingPage, MyAppointment, MyPet } from "@pet-pos/api";
import { errorMessage } from "../ui/errors.ts";
import { useBooking } from "./context.ts";

/** Price and minutes for a pet size, from the menu (the server reprices when booking). */
export function estimate(page: BookingPage, serviceId: string, addonIds: string[], size: PetSize) {
  const pick = page.services.filter((s) => s.id === serviceId || addonIds.includes(s.id));
  return {
    priceCents: pick.reduce((t, s) => t + s.priceCents[size], 0),
    minutes: pick.reduce((t, s) => t + s.minutes[size], 0),
  };
}

export interface BookStart {
  petId?: string;
  serviceId?: string;
  addonIds?: string[];
}

/**
 * Booking in steps: pet, service, groomer, day, time, review. Rescheduling skips
 * straight to the day, keeping the pet and service.
 */
export function BookFlow({
  pets,
  start,
  reschedule,
  newCustomer = false,
  onDone,
  onCancel,
}: {
  pets: MyPet[];
  /** No finished groom yet, for "New customers only" deposits. */
  newCustomer?: boolean;
  start?: BookStart;
  reschedule?: MyAppointment;
  onDone: (a: MyAppointment) => void;
  onCancel?: () => void;
}) {
  const { api, page } = useBooking();
  const qc = useQueryClient();
  const mains = page.services.filter((s) => s.kind === "main");
  const addons = page.services.filter((s) => s.kind === "addon");
  const [petId, setPetId] = useState(
    reschedule?.petId ?? start?.petId ?? (pets.length === 1 ? pets[0]!.id : ""),
  );
  const [serviceId, setServiceId] = useState(reschedule?.serviceId ?? start?.serviceId ?? "");
  const [addonIds, setAddonIds] = useState<string[]>(reschedule?.addonIds ?? start?.addonIds ?? []);
  const [staffId, setStaffId] = useState<string>(reschedule?.staffId ?? "any");
  const [day, setDay] = useState<string | null>(null);
  const [time, setTime] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [adding, setAdding] = useState(pets.length === 0);
  const [error, setError] = useState<string | null>(null);
  const pet = pets.find((p) => p.id === petId);
  const ready = !!pet?.size && !!serviceId && !pet.rabiesLapsed;

  const times = useQuery({
    queryKey: ["openTimes", petId, serviceId, addonIds, staffId],
    queryFn: () =>
      api.call("openTimes", {
        petId,
        serviceId,
        addonIds,
        staffId: staffId === "any" ? null : staffId,
        from: todayIso(),
        days: Math.min(page.daysAhead, 31),
      }),
    enabled: ready,
  });

  const book = useMutation({
    mutationFn: () =>
      reschedule
        ? api.call("rescheduleMine", {
            id: reschedule.id,
            staffId: staffId === "any" ? null : staffId,
            day: day!,
            start: time!,
          })
        : api.call("bookOnline", {
            petId,
            serviceId,
            addonIds,
            staffId: staffId === "any" ? null : staffId,
            day: day!,
            start: time!,
            notes,
          }),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ["myAccount"] });
      void qc.invalidateQueries({ queryKey: ["openTimes"] });
      onDone(a);
    },
    onError: (err) => {
      setError(errorMessage(err));
      setTime(null);
      void qc.invalidateQueries({ queryKey: ["openTimes"] });
    },
  });

  const est = pet?.size && serviceId ? estimate(page, serviceId, addonIds, pet.size) : null;
  const depositCents =
    est && !reschedule
      ? bookingDeposit({
          rule: page.depositRule,
          serviceDepositCents: page.services.find((s) => s.id === serviceId)?.depositCents ?? 0,
          quoteCents: est.priceCents,
          isNewCustomer: newCustomer,
        })
      : 0;
  const dayTimes = times.data?.find((d) => d.day === day)?.times ?? [];

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {!reschedule && (
        <section className="panel" aria-label="Pet" style={{ display: "grid", gap: 8 }}>
          <h2 style={{ margin: 0 }}>1. Your pet</h2>
          <div className="cat-tabs" style={{ marginTop: 0, flexWrap: "wrap" }}>
            {pets.map((p) => (
              <button
                type="button"
                key={p.id}
                aria-pressed={p.id === petId}
                onClick={() => {
                  setPetId(p.id);
                  setDay(null);
                  setTime(null);
                }}
              >
                {p.name}
              </button>
            ))}
            <button type="button" aria-pressed={adding} onClick={() => setAdding(!adding)}>
              + Add a pet
            </button>
          </div>
          {adding && (
            <PetForm
              onSaved={(p) => {
                setPetId(p.id);
                setAdding(false);
              }}
            />
          )}
          {pet && !pet.size && <SizeFix pet={pet} />}
          {pet?.rabiesLapsed && (
            <p className="error-box" style={{ margin: 0 }}>
              {pet.name}'s rabies vaccination has expired. Please call us
              {page.phone ? ` at ${formatPhone(page.phone)}` : ""} to book.
            </p>
          )}
        </section>
      )}

      {!reschedule && (
        <section className="panel" aria-label="Service" style={{ display: "grid", gap: 8 }}>
          <h2 style={{ margin: 0 }}>2. Service</h2>
          {mains.map((s) => (
            <label className="check" key={s.id}>
              <input
                type="radio"
                name="service"
                checked={serviceId === s.id}
                onChange={() => {
                  setServiceId(s.id);
                  setDay(null);
                  setTime(null);
                }}
              />
              <span>
                <b>{s.name}</b>
                {pet?.size &&
                  ` · ${formatMoney(s.priceCents[pet.size])} · about ${durationText(s.minutes[pet.size])}`}
                {s.description && <span className="sub">{s.description}</span>}
              </span>
            </label>
          ))}
          {addons.length > 0 && serviceId && (
            <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6 }}>
              <legend className="muted small">Add-ons</legend>
              {addons.map((a) => (
                <label className="check" key={a.id}>
                  <input
                    type="checkbox"
                    checked={addonIds.includes(a.id)}
                    onChange={(e) => {
                      setAddonIds(
                        e.target.checked ? [...addonIds, a.id] : addonIds.filter((x) => x !== a.id),
                      );
                      setDay(null);
                      setTime(null);
                    }}
                  />
                  {a.name}
                  {pet?.size && ` · +${formatMoney(a.priceCents[pet.size])}`}
                </label>
              ))}
            </fieldset>
          )}
        </section>
      )}

      {ready && (
        <section className="panel" aria-label="When" style={{ display: "grid", gap: 8 }}>
          <h2 style={{ margin: 0 }}>
            {reschedule ? `New time for ${reschedule.petName}` : "3. Groomer and time"}
          </h2>
          <label style={{ maxWidth: 320 }}>
            Groomer
            <select
              value={staffId}
              onChange={(e) => {
                setStaffId(e.target.value);
                setDay(null);
                setTime(null);
              }}
            >
              <option value="any">Any groomer</option>
              {page.groomers.map((g) => (
                <option key={g.staffId} value={g.staffId}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          {times.isError && <p className="error-box">{errorMessage(times.error)}</p>}
          {times.isPending && <p className="muted">Finding open times…</p>}
          {times.data && (
            <div
              className="cat-tabs"
              style={{ marginTop: 0, flexWrap: "wrap" }}
              role="group"
              aria-label="Days"
            >
              {times.data.map((d) => (
                <button
                  type="button"
                  key={d.day}
                  aria-pressed={day === d.day}
                  disabled={!d.times.length}
                  onClick={() => {
                    setDay(d.day);
                    setTime(null);
                    setError(null);
                  }}
                >
                  {shortDay(d.day)}
                </button>
              ))}
            </div>
          )}
          {times.data && times.data.every((d) => !d.times.length) && (
            <p className="muted">No open times in the next few weeks. Please call us.</p>
          )}
          {day && (
            <div
              className="cat-tabs"
              style={{ marginTop: 0, flexWrap: "wrap" }}
              role="group"
              aria-label="Times"
            >
              {dayTimes.map((t) => (
                <button type="button" key={t} aria-pressed={time === t} onClick={() => setTime(t)}>
                  {clockText(t)}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {ready && day && time !== null && (
        <section className="panel" aria-label="Review" style={{ display: "grid", gap: 8 }}>
          <h2 style={{ margin: 0 }}>{reschedule ? "Move it" : "4. Review"}</h2>
          <p style={{ margin: 0 }}>
            <b>{reschedule?.petName ?? pet?.name}</b> ·{" "}
            {reschedule?.label ?? mains.find((s) => s.id === serviceId)?.name}
            {!reschedule &&
              addonIds.length > 0 &&
              ` + ${addons
                .filter((a) => addonIds.includes(a.id))
                .map((a) => a.name)
                .join(" + ")}`}
            <br />
            {shortDay(day)} at {clockText(time)} with{" "}
            {staffId === "any"
              ? "the first groomer free"
              : page.groomers.find((g) => g.staffId === staffId)?.name}
            {est && !reschedule && (
              <>
                <br />
                {formatMoney(est.priceCents)} · about {durationText(est.minutes)}.{" "}
                {depositCents ? "" : "Pay at pickup."}
              </>
            )}
          </p>
          {depositCents > 0 && (
            <p className="note" style={{ margin: 0 }}>
              A {formatMoney(depositCents)} deposit holds your time. You pay it now, and it comes off the{" "}
              {formatMoney(est!.priceCents)} at pickup. It's refunded if you cancel at least{" "}
              {page.cutoffHours} hours before. We hold the time for {page.holdMinutes} minutes while you pay.
            </p>
          )}
          {!reschedule && (
            <label>
              Anything we should know?
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={500}
                placeholder="Nervous with dryers, short summer cut…"
              />
            </label>
          )}
          {error && (
            <p className="error-box" role="alert" style={{ margin: 0 }}>
              {error}
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="primary big"
              disabled={book.isPending}
              onClick={() => book.mutate()}
            >
              {reschedule
                ? "Move my appointment"
                : depositCents
                  ? `Book and pay ${formatMoney(depositCents)}`
                  : "Book"}
            </button>
            {onCancel && (
              <button type="button" onClick={onCancel}>
                Never mind
              </button>
            )}
          </div>
        </section>
      )}
      {error && !(day && time !== null) && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function PetForm({ onSaved }: { onSaved: (p: MyPet) => void }) {
  const { api } = useBooking();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: "", species: "dog" as Species, breed: "", size: "" as PetSize | "" });
  const save = useMutation({
    mutationFn: () =>
      api.call("savePet", { name: f.name, species: f.species, breed: f.breed, size: f.size || null }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ["myAccount"] });
      onSaved(p);
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }
  return (
    <form onSubmit={submit} className="form" style={{ alignItems: "end" }} aria-label="Add a pet">
      <label>
        Name
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
      </label>
      <label>
        Type
        <select value={f.species} onChange={(e) => setF({ ...f, species: e.target.value as Species })}>
          {SPECIES.map((s) => (
            <option key={s} value={s}>
              {SPECIES_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Breed
        <input value={f.breed} onChange={(e) => setF({ ...f, breed: e.target.value })} />
      </label>
      <label>
        Size
        <select value={f.size} onChange={(e) => setF({ ...f, size: e.target.value as PetSize })} required>
          <option value="">Pick a size</option>
          {SIZES.map((z) => (
            <option key={z} value={z}>
              {z} · {SIZE_HINT[z]}
            </option>
          ))}
        </select>
      </label>
      <button className="primary" disabled={save.isPending}>
        Add pet
      </button>
      {save.isError && <span className="field-error">{errorMessage(save.error)}</span>}
    </form>
  );
}

function SizeFix({ pet }: { pet: MyPet }) {
  const { api } = useBooking();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (size: PetSize) =>
      api.call("savePet", { id: pet.id, name: pet.name, species: pet.species, breed: pet.breed, size }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["myAccount"] }),
  });
  return (
    <label style={{ maxWidth: 320 }}>
      What size is {pet.name}?
      <select defaultValue="" onChange={(e) => e.target.value && save.mutate(e.target.value as PetSize)}>
        <option value="">Pick a size</option>
        {SIZES.map((z) => (
          <option key={z} value={z}>
            {z} · {SIZE_HINT[z]}
          </option>
        ))}
      </select>
    </label>
  );
}
