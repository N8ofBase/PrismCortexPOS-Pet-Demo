import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import {
  BREED_PLACEHOLDER,
  duplicatePetName,
  formatPhone,
  SPECIES,
  SPECIES_LABEL,
  validateCustomer,
  type CustomerInput,
  type Species,
} from "@pet-pos/core";
import type { CustomerProfile, CustomerMessagePrefs } from "@pet-pos/api";
import { useSession } from "../../session.tsx";
import { errorMessage, fieldErrors } from "../../ui/errors.ts";
import { SlideOver } from "../../ui/SlideOver.tsx";
import { useToast } from "../../ui/Toast.tsx";

interface PetRow {
  key: number;
  id?: string;
  name: string;
  species: Species;
  breed: string;
  birthday: string;
}

const EMPTY: CustomerInput = {
  name: "",
  phone: "",
  email: "",
  street: "",
  city: "",
  state: "",
  zip: "",
  birthday: "",
  smsOptIn: false,
  notes: "",
};

let nextKey = 1;
const blankPet = (): PetRow => ({ key: nextKey++, name: "", species: "dog", breed: "", birthday: "" });

/** Add or edit a customer and their pets in one form, as in the prototype. */
export function CustomerForm({
  id,
  onClose,
  onSaved,
}: {
  id: string | null;
  onClose: () => void;
  onSaved?: (id: string) => void;
}) {
  const { api } = useSession();
  const existing = useQuery({
    queryKey: ["customer", id],
    queryFn: () => api.call("getCustomer", { id: id! }),
    enabled: !!id,
  });

  if (id && !existing.data)
    return (
      <SlideOver title="Edit customer" onClose={onClose}>
        {existing.isError ? (
          <p className="error-box">{errorMessage(existing.error)}</p>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </SlideOver>
    );
  return <Form key={id ?? "new"} profile={existing.data ?? null} onClose={onClose} onSaved={onSaved} />;
}

const OPT_IN_SOURCE = { counter: "at the counter", online: "online", import: "imported" } as const;

function toInput(p: CustomerProfile): CustomerInput {
  return {
    name: p.name,
    phone: formatPhone(p.phone),
    email: p.email ?? "",
    street: p.street ?? "",
    city: p.city ?? "",
    state: p.state ?? "",
    zip: p.zip ?? "",
    birthday: p.birthday ?? "",
    smsOptIn: p.smsOptIn,
    notes: p.notes ?? "",
  };
}

function Form({
  profile,
  onClose,
  onSaved,
}: {
  profile: CustomerProfile | null;
  onClose: () => void;
  onSaved?: (id: string) => void;
}) {
  const { api } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [c, setC] = useState<CustomerInput>(profile ? toInput(profile) : EMPTY);
  const [msg, setMsg] = useState<CustomerMessagePrefs>(
    profile?.messages ?? { contactPref: null, nudgesOff: false, emailOff: false },
  );
  const [pets, setPets] = useState<PetRow[]>(
    profile?.pets.length
      ? profile.pets.map((p) => ({
          key: nextKey++,
          id: p.id,
          name: p.name,
          species: p.species,
          breed: p.breed ?? "",
          birthday: p.birthday ?? "",
        }))
      : [blankPet()],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: () =>
      api.call("saveCustomer", {
        id: profile?.id,
        customer: c,
        pets: pets.map(({ id, name, species, breed, birthday }) => ({ id, name, species, breed, birthday })),
        messages: msg,
      }),
    onSuccess: ({ id }) => {
      toast(profile ? "Customer saved" : "Customer added");
      void qc.invalidateQueries({ queryKey: ["customers"] });
      void qc.invalidateQueries({ queryKey: ["customer", id] });
      onSaved?.(id);
      onClose();
    },
    onError: (err) => {
      setErrors(fieldErrors(err));
      toast(errorMessage(err));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = { ...validateCustomer(c) };
    const dup = duplicatePetName(pets.map((p) => p.name));
    if (dup) errs.pets = dup;
    setErrors(errs);
    if (Object.keys(errs).length) return;
    save.mutate();
  }

  const set = (k: keyof CustomerInput) => (e: { target: { value: string } }) =>
    setC({ ...c, [k]: e.target.value });
  const setPet = (key: number, patch: Partial<PetRow>) =>
    setPets((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const field = (
    k: keyof CustomerInput,
    label: string,
    props: React.InputHTMLAttributes<HTMLInputElement> = {},
  ) => (
    <label>
      {label}
      <input
        value={c[k] as string}
        onChange={set(k)}
        autoComplete="off"
        aria-invalid={!!errors[k]}
        aria-describedby={errors[k] ? `err-${k}` : undefined}
        {...props}
      />
      {errors[k] && (
        <span className="field-error" id={`err-${k}`}>
          {errors[k]}
        </span>
      )}
    </label>
  );

  return (
    <SlideOver title={profile ? `Edit ${profile.name}` : "New customer"} onClose={onClose}>
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        <div className="form">
          {field("name", "Name", { required: true, autoFocus: !profile })}
          {field("phone", "Phone", { inputMode: "tel" })}
          {field("email", "Email", { type: "email" })}
          {field("street", "Street address")}
          {field("city", "City")}
          {field("state", "State", { maxLength: 2, style: { textTransform: "uppercase" } })}
          {field("zip", "ZIP", { inputMode: "numeric", maxLength: 10 })}
          {field("birthday", "Birthday (optional)", { type: "date" })}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={c.smsOptIn}
            onChange={(e) => setC({ ...c, smsOptIn: e.target.checked })}
          />
          Text messages OK (confirmations, reminders and pickup alerts)
        </label>
        {profile?.smsOptIn && profile.smsOptInAt && (
          <span className="muted small">
            Agreed {new Date(profile.smsOptInAt).toLocaleDateString()}
            {profile.smsOptInSource ? ` · ${OPT_IN_SOURCE[profile.smsOptInSource]}` : ""}
          </span>
        )}
        <div className="form" style={{ alignItems: "end" }}>
          <label>
            Send messages by
            <select
              value={msg.contactPref ?? "text"}
              onChange={(e) => setMsg({ ...msg, contactPref: e.target.value as "text" | "email" })}
            >
              <option value="text">Text</option>
              <option value="email">Email</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={!msg.nudgesOff}
              onChange={(e) => setMsg({ ...msg, nudgesOff: !e.target.checked })}
            />
            Rebook reminders
          </label>
          {msg.emailOff && (
            <label className="check">
              <input type="checkbox" checked={false} onChange={() => setMsg({ ...msg, emailOff: false })} />
              Unsubscribed from email · tick to send email again
            </label>
          )}
        </div>
        <label>
          Notes
          <textarea rows={2} value={c.notes} onChange={set("notes")} />
        </label>

        <div style={{ display: "grid", gap: 8 }}>
          <b style={{ fontSize: ".9rem" }}>Pets</b>
          {pets.map((p) => (
            <div className="petrow" key={p.key}>
              <label>
                Pet name
                <input
                  value={p.name}
                  onChange={(e) => setPet(p.key, { name: e.target.value })}
                  placeholder="e.g. Biscuit"
                  autoComplete="off"
                />
              </label>
              <fieldset className="ptype">
                <legend>Type</legend>
                {SPECIES.map((s) => (
                  <label key={s}>
                    <input
                      type="radio"
                      name={`ptype-${p.key}`}
                      value={s}
                      checked={p.species === s}
                      onChange={() => setPet(p.key, { species: s })}
                    />{" "}
                    {SPECIES_LABEL[s]}
                  </label>
                ))}
              </fieldset>
              <label style={{ flex: "0 1 170px" }}>
                Birthday (optional)
                <input
                  type="date"
                  value={p.birthday}
                  onChange={(e) => setPet(p.key, { birthday: e.target.value })}
                />
              </label>
              <label>
                Breed or notes
                <input
                  value={p.breed}
                  onChange={(e) => setPet(p.key, { breed: e.target.value })}
                  placeholder={BREED_PLACEHOLDER[p.species]}
                  autoComplete="off"
                />
              </label>
              {(pets.length > 1 || p.name) && (
                <button
                  type="button"
                  aria-label={`Remove ${p.name || "this pet"}`}
                  onClick={() =>
                    setPets((ps) => (ps.length > 1 ? ps.filter((x) => x.key !== p.key) : [blankPet()]))
                  }
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          {errors.pets && <span className="field-error">{errors.pets}</span>}
          <div>
            <button type="button" onClick={() => setPets((ps) => [...ps, blankPet()])}>
              + Add another pet
            </button>
          </div>
          {profile && profile.pets.some((p) => !pets.some((r) => r.id === p.id)) && (
            <p className="warn-line">Removing a pet deletes its details and vaccinations when you save.</p>
          )}
        </div>

        <div className="actions">
          <button className="primary" type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : profile ? "Save customer" : "Add customer"}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </SlideOver>
  );
}
