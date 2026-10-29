import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { can, centsToInput, formatMoney, parseMoney, SIZE_HINT, SIZES, type PetSize } from "@pet-pos/core";
import type { ServiceInput, ServiceRow } from "@pet-pos/api";
import { useSession } from "../../session.tsx";
import { errorMessage } from "../../ui/errors.ts";
import { SlideOver } from "../../ui/SlideOver.tsx";
import { useToast } from "../../ui/Toast.tsx";
import { TwoTapButton } from "../../ui/TwoTapButton.tsx";
import { SuppliesEditor } from "./SuppliesEditor.tsx";

const same = (r: Record<PetSize, number>) => SIZES.every((z) => r[z] === r.S);

/** "$55.00 · $70.00 · $85.00 · $105.00", or "$10.00 flat". */
export function bySize(r: Record<PetSize, number>, fmt: (n: number) => string, addon = false): string {
  return same(r) ? `${addon ? "+" : ""}${fmt(r.S)} flat` : SIZES.map((z) => fmt(r[z])).join(" · ");
}

export function ServicesView() {
  const { api, me } = useSession();
  const canEdit = can(me.staff.role, "grooming.manage");
  const list = useQuery({
    queryKey: ["services", "all"],
    queryFn: () => api.call("listServices", { all: true }),
  });
  const [editing, setEditing] = useState<ServiceRow | "new" | null>(null);
  const rows = (list.data ?? []).filter((s) => !s.archived);

  return (
    <>
      <div className="toolbar" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Services</h2>
        {canEdit && (
          <button type="button" className="primary" onClick={() => setEditing("new")}>
            Add service
          </button>
        )}
      </div>
      {list.isError && <p className="error-box">{errorMessage(list.error)}</p>}
      <div className="tablewrap">
        <table className="wide">
          <thead>
            <tr>
              <th>Service</th>
              <th>Price S · M · L · XL</th>
              <th>Minutes S · M · L · XL</th>
              <th className="r">Buffer</th>
              <th className="r">Deposit</th>
              <th>Online</th>
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>
                  <b>{s.name}</b>
                  {s.kind === "addon" && <span className="tag astro"> Add-on</span>}
                  {!s.active && <span className="tag muted"> Off</span>}
                  {s.description && <span className="sub">{s.description}</span>}
                </td>
                <td className="num">{bySize(s.priceCents, formatMoney, s.kind === "addon")}</td>
                <td className="num">{bySize(s.minutes, String)}</td>
                <td className="r num">{s.bufferMinutes ? `${s.bufferMinutes} min` : "—"}</td>
                <td className="r num">{s.depositCents ? formatMoney(s.depositCents) : "—"}</td>
                <td>
                  {s.online ? <span className="tag ok">On</span> : <span className="tag muted">Off</span>}
                </td>
                {canEdit && (
                  <td>
                    <button type="button" onClick={() => setEditing(s)}>
                      Edit
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {list.data && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No services yet. Tap Add service to build the grooming menu.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Sizes: {SIZES.map((z) => `${z} ${SIZE_HINT[z]}`).join(" · ")}. A deposit is asked for on online
        bookings as set under Settings → Online booking, and comes off the groom at the register.
      </p>
      {editing && (
        <ServiceForm service={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

const sizes = <T,>(f: (z: PetSize) => T): Record<PetSize, T> =>
  Object.fromEntries(SIZES.map((z) => [z, f(z)])) as Record<PetSize, T>;

function ServiceForm({ service, onClose }: { service: ServiceRow | null; onClose: () => void }) {
  const { api } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    name: service?.name ?? "",
    kind: service?.kind ?? ("main" as "main" | "addon"),
    description: service?.description ?? "",
    flat: service ? same(service.priceCents) && same(service.minutes) : false,
    price: sizes((z) => (service ? centsToInput(service.priceCents[z]) : "")),
    minutes: sizes((z) => (service ? String(service.minutes[z]) : "")),
    buffer: String(service?.bufferMinutes ?? 15),
    deposit: service ? centsToInput(service.depositCents) : "0.00",
    rebook: service?.rebookWeeks ? String(service.rebookWeeks) : "",
    online: service?.online ?? true,
    active: service?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (input: ServiceInput) => api.call("saveService", input),
    onSuccess: () => {
      toast(service ? "Service saved" : "Service added");
      void qc.invalidateQueries({ queryKey: ["services"] });
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const archive = useMutation({
    mutationFn: () => api.call("archiveService", { id: service!.id }),
    onSuccess: () => {
      toast("Service archived");
      void qc.invalidateQueries({ queryKey: ["services"] });
      onClose();
    },
    onError: (err) => toast(errorMessage(err)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const pick = (r: Record<PetSize, string>, z: PetSize) => (f.flat ? r.S : r[z]);
    const priceCents = sizes((z) => parseMoney(pick(f.price, z) || "0"));
    const minutes = sizes((z) => Number(pick(f.minutes, z) || "0"));
    if (SIZES.some((z) => priceCents[z] === null))
      return setError("Enter each price in dollars, like 55.00.");
    if (SIZES.some((z) => !Number.isInteger(minutes[z]))) return setError("Enter minutes as whole numbers.");
    const deposit = parseMoney(f.deposit || "0");
    if (deposit === null) return setError("Enter the deposit in dollars, like 20.00.");
    const rebook = f.rebook.trim() ? Number(f.rebook) : null;
    if (rebook !== null && (!Number.isInteger(rebook) || rebook < 1 || rebook > 52))
      return setError("Rebook after 1 to 52 weeks, or leave it empty for the store's default.");
    setError(null);
    save.mutate({
      id: service?.id,
      name: f.name,
      kind: f.kind,
      description: f.description,
      priceCents: priceCents as Record<PetSize, number>,
      minutes,
      bufferMinutes: Number(f.buffer || "0"),
      depositCents: deposit,
      rebookWeeks: rebook,
      online: f.online,
      active: f.active,
    });
  }

  return (
    <SlideOver title={service ? `Edit ${service.name}` : "New service"} onClose={onClose}>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <div className="form">
          <label>
            Name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus />
          </label>
          <label>
            Type
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "main" | "addon" })}>
              <option value="main">Main service</option>
              <option value="addon">Add-on</option>
            </select>
          </label>
          <label>
            Buffer after (min)
            <input
              type="number"
              min={0}
              step={5}
              value={f.buffer}
              onChange={(e) => setF({ ...f, buffer: e.target.value })}
            />
          </label>
          <label>
            Deposit ($)
            <input
              value={f.deposit}
              inputMode="decimal"
              onChange={(e) => setF({ ...f, deposit: e.target.value })}
            />
          </label>
          {f.kind === "main" && (
            <label>
              Rebook reminder after (weeks)
              <input
                value={f.rebook}
                inputMode="numeric"
                placeholder="Store default"
                onChange={(e) => setF({ ...f, rebook: e.target.value })}
              />
            </label>
          )}
        </div>
        <label>
          Description for customers
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </label>
        <div style={{ display: "grid", gap: 8 }}>
          <div className="actions" style={{ alignItems: "center" }}>
            <b className="small">Price and minutes by size</b>
            <label className="check">
              <input
                type="checkbox"
                checked={f.flat}
                onChange={(e) => setF({ ...f, flat: e.target.checked })}
              />
              Same for all sizes
            </label>
          </div>
          <div className="sizegrid">
            <span />
            {(f.flat ? (["S"] as PetSize[]) : SIZES).map((z) => (
              <span className="muted" key={z}>
                {f.flat ? "All sizes" : z}
              </span>
            ))}
            {f.flat && <span />}
            {f.flat && <span />}
            {f.flat && <span />}
            <span className="muted">Price $</span>
            {(f.flat ? (["S"] as PetSize[]) : SIZES).map((z) => (
              <input
                key={z}
                value={f.price[z]}
                inputMode="decimal"
                aria-label={`Price ${f.flat ? "for all sizes" : `size ${z}`}`}
                onChange={(e) => setF({ ...f, price: { ...f.price, [z]: e.target.value } })}
              />
            ))}
            {f.flat && <span />}
            {f.flat && <span />}
            {f.flat && <span />}
            <span className="muted">Minutes</span>
            {(f.flat ? (["S"] as PetSize[]) : SIZES).map((z) => (
              <input
                key={z}
                type="number"
                min={0}
                step={5}
                value={f.minutes[z]}
                aria-label={`Minutes ${f.flat ? "for all sizes" : `size ${z}`}`}
                onChange={(e) => setF({ ...f, minutes: { ...f.minutes, [z]: e.target.value } })}
              />
            ))}
            {f.flat && <span />}
            {f.flat && <span />}
            {f.flat && <span />}
          </div>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={f.online}
            onChange={(e) => setF({ ...f, online: e.target.checked })}
          />
          Customers can book this online
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={f.active}
            onChange={(e) => setF({ ...f, active: e.target.checked })}
          />
          On the menu
        </label>
        {error && <p className="error-box">{error}</p>}
        <div className="actions">
          <button className="primary" disabled={save.isPending}>
            Save service
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          {service && (
            <TwoTapButton
              className="dangerbtn"
              label="Archive"
              confirmLabel="Tap again to archive"
              onConfirm={() => archive.mutate()}
            />
          )}
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Booked appointments keep the price they were booked at. Price changes are recorded in the audit log.
        </p>
      </form>
      {service && <SuppliesEditor serviceId={service.id} />}
    </SlideOver>
  );
}
