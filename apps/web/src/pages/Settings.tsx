import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, Route, Routes } from "react-router";
import {
  can,
  centsToInput,
  formatTaxPercent,
  parseMoney,
  parseTaxPercent,
  readableOn,
  ROLE_LABEL,
  ROLES,
  taxPercentInput,
  type Role,
} from "@pet-pos/core";
import type { DemoCounts, StaffListItem, StoreSettings } from "@pet-pos/api";
import { useSession } from "../session.tsx";
import { ConfirmTyped } from "../ui/ConfirmTyped.tsx";
import { errorMessage, fieldErrors } from "../ui/errors.ts";
import { SlideOver } from "../ui/SlideOver.tsx";
import { StoreMark } from "../ui/StoreMark.tsx";
import { useToast } from "../ui/Toast.tsx";
import { DiscountsSection } from "./settings/DiscountsSection.tsx";
import { MessagesSection } from "./settings/MessagesSection.tsx";
import { OnlineBookingSection } from "./settings/OnlineBookingSection.tsx";
import { ImportPage } from "./settings/ImportPage.tsx";
import { resizeLogo } from "./settings/logo.ts";

export function SettingsRoutes() {
  return (
    <Routes>
      <Route index element={<Settings />} />
      <Route path="import" element={<ImportPage />} />
    </Routes>
  );
}

function Settings() {
  const { api, me, switchRole } = useSession();
  const canEdit = can(me.staff.role, "settings.edit");
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.call("getSettings") });

  return (
    <>
      <div className="page-head">
        <h1>Store settings</h1>
        <button type="button" onClick={switchRole}>
          Switch role
        </button>
      </div>

      {settings.isError && <p className="error-box">{errorMessage(settings.error)}</p>}
      {settings.data && <StoreForm key={JSON.stringify(settings.data)} s={settings.data} canEdit={canEdit} />}

      <StaffSection />

      {settings.data && (
        <OnlineBookingSection
          key={JSON.stringify(settings.data.booking)}
          s={settings.data}
          canEdit={canEdit}
        />
      )}
      {settings.data && (
        <MessagesSection key={JSON.stringify(settings.data.messages)} s={settings.data} canEdit={canEdit} />
      )}

      {can(me.staff.role, "discounts.manage") && <DiscountsSection />}

      {can(me.staff.role, "import.run") && (
        <section className="panel">
          <h2>Bulk import</h2>
          <p className="muted">
            Load customers and pets, products, Astro programs and punch balances from a CSV or Excel file. You
            see a preview before anything is saved, and any import can be undone.
          </p>
          <div>
            <Link to="import">Import a file</Link>
          </div>
        </section>
      )}

      {can(me.staff.role, "demo.remove") && <DemoData />}
    </>
  );
}

/** Tax percent field check, shared with the test. */
export function taxError(input: string): string | null {
  return parseTaxPercent(input) === null ? "Enter the sales tax as a percent, like 8.875." : null;
}

function StoreForm({ s, canEdit }: { s: StoreSettings; canEdit: boolean }) {
  const { api } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    name: s.name,
    brandColor: s.brandColor ?? "#0f6e5a",
    logo: s.logo,
    locationName: s.locationName,
    taxPercent: taxPercentInput(s.taxRateMpct),
    astroDiscountsBeforeTax: s.astroDiscountsBeforeTax,
    refundLimit: centsToInput(s.refundApprovalCents),
    drawerFloat: centsToInput(s.drawerFloatCents),
    groomingTaxable: s.groomingTaxable,
    textWhenReady: s.textWhenReady,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: () => {
      const { refundLimit, drawerFloat, ...rest } = f;
      return api.call("updateSettings", {
        ...rest,
        refundApprovalCents: parseMoney(refundLimit)!,
        drawerFloatCents: parseMoney(drawerFloat)!,
      });
    },
    onSuccess: () => {
      toast("Settings saved");
      setErrors({});
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err) => {
      setErrors(fieldErrors(err));
      toast(errorMessage(err));
    },
  });

  async function pickLogo(file: File | undefined) {
    if (!file) return;
    try {
      setF({ ...f, logo: await resizeLogo(file) });
      setErrors({ ...errors, logo: "" });
    } catch (err) {
      setErrors({ ...errors, logo: err instanceof Error ? err.message : "Couldn't read that image." });
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const tax = taxError(f.taxPercent);
    if (tax) return setErrors({ taxPercent: tax });
    if (parseMoney(f.refundLimit) === null)
      return setErrors({ refundApprovalCents: "Enter the refund limit in dollars, like 50.00." });
    if (parseMoney(f.drawerFloat) === null)
      return setErrors({ drawerFloatCents: "Enter the starting cash in dollars, like 100.00." });
    save.mutate();
  }

  const err = (k: string) => (errors[k] ? <span className="field-error">{errors[k]}</span> : null);
  const text = readableOn(f.brandColor);

  return (
    <section className="panel">
      <h2>Store</h2>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}>
          <div className="form">
            <label>
              Store name
              <input
                value={f.name}
                onChange={(e) => setF({ ...f, name: e.target.value })}
                aria-invalid={!!errors.name}
              />
              {err("name")}
            </label>
            <label>
              Location name
              <input
                value={f.locationName}
                onChange={(e) => setF({ ...f, locationName: e.target.value })}
                aria-invalid={!!errors.locationName}
              />
              {err("locationName")}
            </label>
            <label>
              Sales tax (%)
              <input
                value={f.taxPercent}
                onChange={(e) => setF({ ...f, taxPercent: e.target.value })}
                inputMode="decimal"
                aria-invalid={!!errors.taxPercent}
              />
              {err("taxPercent")}
            </label>
            <label>
              Managers can refund up to ($)
              <input
                value={f.refundLimit}
                onChange={(e) => setF({ ...f, refundLimit: e.target.value })}
                inputMode="decimal"
                aria-invalid={!!errors.refundApprovalCents}
              />
              {err("refundApprovalCents")}
              <span className="muted small">Above this, the owner approves the refund on the tablet.</span>
            </label>
            <label>
              Starting cash in the drawer ($)
              <input
                value={f.drawerFloat}
                onChange={(e) => setF({ ...f, drawerFloat: e.target.value })}
                inputMode="decimal"
                aria-invalid={!!errors.drawerFloatCents}
              />
              {err("drawerFloatCents")}
              <span className="muted small">Left in the drawer each morning; end of day counts from it.</span>
            </label>
            <label>
              Brand color
              <input
                type="color"
                value={f.brandColor}
                onChange={(e) => setF({ ...f, brandColor: e.target.value })}
                style={{ padding: 2, height: 40 }}
              />
              {err("brandColor")}
            </label>
          </div>
          <div className="form" style={{ alignItems: "end" }}>
            <label>
              Logo
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => void pickLogo(e.target.files?.[0])}
              />
              {err("logo")}
            </label>
            {f.logo && (
              <div>
                <button type="button" onClick={() => setF({ ...f, logo: null })}>
                  Remove logo
                </button>
              </div>
            )}
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={f.astroDiscountsBeforeTax}
              onChange={(e) => setF({ ...f, astroDiscountsBeforeTax: e.target.checked })}
            />
            Astro offers and rewards come off before tax
          </label>
          <p className="muted small" style={{ margin: 0 }}>
            Check the store's Astro agreement. When this is off, tax is charged on the price before the Astro
            discount.
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={f.groomingTaxable}
              onChange={(e) => setF({ ...f, groomingTaxable: e.target.checked })}
            />
            Charge sales tax on grooming
          </label>
          <p className="muted small" style={{ margin: 0 }}>
            Many states don't tax pet grooming; some do. Check your state's rules.
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={f.textWhenReady}
              onChange={(e) => setF({ ...f, textWhenReady: e.target.checked })}
            />
            Text customers when their pet is ready for pickup
          </label>
        </fieldset>

        <div>
          <span className="muted small">Sidebar preview</span>
          <div
            className="store-header"
            style={{ background: f.brandColor, color: text, maxWidth: 240, borderRadius: 10 }}
          >
            <StoreMark name={f.name || "Store"} logo={f.logo} color={text} />
            <span>
              <b>{f.name || "Store name"}</b>
              <small>
                {f.locationName} · sales tax{" "}
                {parseTaxPercent(f.taxPercent) === null
                  ? "?"
                  : formatTaxPercent(parseTaxPercent(f.taxPercent)!)}
              </small>
            </span>
          </div>
        </div>

        {canEdit ? (
          <div>
            <button className="primary" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save settings"}
            </button>
          </div>
        ) : (
          <p className="muted small">Only the owner can change store settings.</p>
        )}
      </form>
    </section>
  );
}

function StaffSection() {
  const { api, me } = useSession();
  const canManage = can(me.staff.role, "staff.manage");
  const staff = useQuery({ queryKey: ["staff"], queryFn: () => api.call("listStaff") });
  const [editing, setEditing] = useState<StaffListItem | "new" | null>(null);

  return (
    <section className="panel">
      <div className="page-head">
        <h2>Staff</h2>
        {canManage && (
          <button type="button" onClick={() => setEditing("new")}>
            Add staff
          </button>
        )}
      </div>
      {staff.isError && <p className="error-box">{errorMessage(staff.error)}</p>}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Status</th>
              {canManage && <th />}
            </tr>
          </thead>
          <tbody>
            {staff.data?.map((s) => (
              <tr key={s.id}>
                <td>
                  <b>{s.name}</b>
                  {s.email && <span className="sub">{s.email}</span>}
                </td>
                <td>{ROLE_LABEL[s.role]}</td>
                <td>
                  {s.active ? (
                    <span className="tag ok">Active</span>
                  ) : (
                    <span className="tag muted">Inactive</span>
                  )}
                </td>
                {canManage && (
                  <td>
                    <button type="button" onClick={() => setEditing(s)}>
                      Edit
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        In this demo, new staff appear on the "Who's using the register?" screen. In the hosted version they
        get an email invite to sign in.
      </p>
      {editing && <StaffForm staff={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

export function StaffForm({ staff, onClose }: { staff: StaffListItem | null; onClose: () => void }) {
  const { api, me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    name: staff?.name ?? "",
    email: staff?.email ?? "",
    role: (staff?.role ?? "cashier") as Role,
    active: staff?.active ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const isSelf = staff?.id === me.staff.id;

  const save = useMutation({
    mutationFn: async () => {
      if (staff) await api.call("updateStaff", { id: staff.id, ...f });
      else await api.call("addStaff", { name: f.name, email: f.email, role: f.role });
    },
    onSuccess: () => {
      toast(staff ? "Staff saved" : "Staff added");
      void qc.invalidateQueries({ queryKey: ["staff"] });
      void qc.invalidateQueries({ queryKey: ["demo-staff"] });
      onClose();
    },
    onError: (err) => {
      setErrors(fieldErrors(err));
      toast(errorMessage(err));
    },
  });

  return (
    <SlideOver title={staff ? `Edit ${staff.name}` : "Add staff"} onClose={onClose}>
      <form
        style={{ display: "grid", gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label>
          Name
          <input
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            required
            autoFocus={!staff}
          />
          {errors.name && <span className="field-error">{errors.name}</span>}
        </label>
        <label>
          Email (optional)
          <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          {errors.email && <span className="field-error">{errors.email}</span>}
        </label>
        <label>
          Role
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        {staff && !isSelf && (
          <label className="check">
            <input
              type="checkbox"
              checked={f.active}
              onChange={(e) => setF({ ...f, active: e.target.checked })}
            />
            Active (can sign in)
          </label>
        )}
        {isSelf && <p className="muted small">This is you. Another owner can deactivate your account.</p>}
        <div className="actions">
          <button className="primary" disabled={save.isPending}>
            {staff ? "Save" : "Add staff"}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </SlideOver>
  );
}

function plural(n: number, one: string, many: string) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "3 customers (5 pets), 4 products, 1 Astro program and 2 punch balances". */
export function demoSummary(c: DemoCounts): string {
  const parts = [
    c.customers
      ? `${plural(c.customers, "customer", "customers")}${c.pets ? ` (${plural(c.pets, "pet", "pets")})` : ""}`
      : "",
    c.products ? plural(c.products, "product", "products") : "",
    c.programs ? plural(c.programs, "Astro program", "Astro programs") : "",
    c.punches ? plural(c.punches, "punch balance", "punch balances") : "",
    c.discounts ? plural(c.discounts, "discount", "discounts") : "",
    c.services ? plural(c.services, "grooming service", "grooming services") : "",
    c.appointments ? plural(c.appointments, "appointment", "appointments") : "",
  ].filter(Boolean);
  return new Intl.ListFormat("en-US").format(parts);
}

export function DemoData() {
  const { api } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const counts = useQuery({ queryKey: ["demo-counts"], queryFn: () => api.call("demoDataPreview") });
  const total = counts.data
    ? counts.data.customers +
      counts.data.products +
      counts.data.programs +
      counts.data.discounts +
      counts.data.services +
      counts.data.appointments
    : 0;

  return (
    <section className="panel">
      <h2>Demo data</h2>
      <p className="muted">
        Sample records are marked (DEMO). Remove them all before the store starts using the register for real.
        Records you added yourself are kept.
      </p>
      <div className="actions">
        <button type="button" className="danger" disabled={!total} onClick={() => setConfirming(true)}>
          Remove all demo data
        </button>
        <span className="muted">
          {counts.data ? (total ? `${demoSummary(counts.data)} marked (DEMO)` : "No demo records left") : ""}
        </span>
      </div>
      {confirming && counts.data && (
        <ConfirmTyped
          title="Remove all demo data?"
          button="Remove demo data"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            try {
              await api.call("removeDemoData");
              toast("Demo data removed");
              setConfirming(false);
              for (const key of ["demo-counts", "customers", "customer", "products", "product", "programs"])
                void qc.invalidateQueries({ queryKey: [key] });
            } catch (err) {
              toast(errorMessage(err));
            }
          }}
        >
          <p>Deletes every record marked (DEMO): {demoSummary(counts.data)}. Your own records stay.</p>
          <p className="muted">
            The (DEMO) sign-ins and the store itself stay, so you can still get in. Sample records won't come
            back, unless you use Reset demo at the top of the screen.
          </p>
        </ConfirmTyped>
      )}
    </section>
  );
}
