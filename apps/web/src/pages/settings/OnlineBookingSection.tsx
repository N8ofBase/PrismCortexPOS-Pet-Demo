import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { formatPhone, taxPercentInput } from "@pet-pos/core";
import type { StoreSettings } from "@pet-pos/api";
import { useSession } from "../../session.tsx";
import { errorMessage } from "../../ui/errors.ts";
import { useToast } from "../../ui/Toast.tsx";

/** Settings → Online booking: on/off, how far ahead, notice, cutoff, times, message and phone. */
export function OnlineBookingSection({ s, canEdit }: { s: StoreSettings; canEdit: boolean }) {
  const { api } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const b = s.booking;
  const [f, setF] = useState({
    enabled: b.enabled,
    daysAhead: String(b.daysAhead),
    noticeHours: String(b.noticeMinutes / 60),
    cutoffHours: String(b.cutoffHours),
    stepMinutes: b.stepMinutes,
    message: b.message ?? "",
    phone: formatPhone(b.phone),
    depositRule: b.depositRule,
    holdMinutes: b.holdMinutes,
    noShow: b.noShow,
  });

  const save = useMutation({
    mutationFn: () =>
      api.call("updateSettings", {
        name: s.name,
        brandColor: s.brandColor,
        logo: s.logo,
        locationName: s.locationName,
        taxPercent: taxPercentInput(s.taxRateMpct),
        astroDiscountsBeforeTax: s.astroDiscountsBeforeTax,
        booking: {
          enabled: f.enabled,
          daysAhead: Number(f.daysAhead),
          noticeMinutes: Math.round(Number(f.noticeHours) * 60),
          cutoffHours: Number(f.cutoffHours),
          stepMinutes: f.stepMinutes,
          message: f.message,
          phone: f.phone,
          depositRule: f.depositRule,
          holdMinutes: f.holdMinutes,
          noShow: f.noShow,
        },
      }),
    onSuccess: () => {
      toast("Online booking saved");
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["bookingPage"] });
    },
    onError: (err) => toast(errorMessage(err)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <section className="panel">
      <h2>Online booking</h2>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}>
          <label className="check">
            <input
              type="checkbox"
              checked={f.enabled}
              onChange={(e) => setF({ ...f, enabled: e.target.checked })}
            />
            Customers can book grooms online
          </label>
          <div className="form">
            <label>
              Book up to (days ahead)
              <input
                type="number"
                min={1}
                max={180}
                value={f.daysAhead}
                onChange={(e) => setF({ ...f, daysAhead: e.target.value })}
              />
            </label>
            <label>
              Minimum notice (hours)
              <input
                type="number"
                min={0}
                max={168}
                step={0.5}
                value={f.noticeHours}
                onChange={(e) => setF({ ...f, noticeHours: e.target.value })}
              />
            </label>
            <label>
              Cancel or change up to (hours before)
              <input
                type="number"
                min={0}
                max={336}
                value={f.cutoffHours}
                onChange={(e) => setF({ ...f, cutoffHours: e.target.value })}
              />
            </label>
            <label>
              Offer times every
              <select
                value={f.stepMinutes}
                onChange={(e) => setF({ ...f, stepMinutes: Number(e.target.value) as 15 | 30 | 60 })}
              >
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={60}>hour</option>
              </select>
            </label>
            <label>
              Store phone for customers
              <input
                value={f.phone}
                onChange={(e) => setF({ ...f, phone: e.target.value })}
                inputMode="tel"
                placeholder="(212) 555-0199"
              />
            </label>
          </div>
          <div className="form">
            <label>
              Deposits
              <select
                value={f.depositRule}
                onChange={(e) => setF({ ...f, depositRule: e.target.value as typeof f.depositRule })}
              >
                <option value="off">Off</option>
                <option value="all">Every online booking with a deposit</option>
                <option value="new">New customers only</option>
              </select>
            </label>
            <label>
              Hold an unpaid booking for
              <select
                value={f.holdMinutes}
                onChange={(e) => setF({ ...f, holdMinutes: Number(e.target.value) as 10 | 15 | 30 })}
              >
                <option value={10}>10 minutes</option>
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
              </select>
            </label>
            <label>
              On a no-show
              <select
                value={f.noShow}
                onChange={(e) => setF({ ...f, noShow: e.target.value as "keep" | "refund" })}
              >
                <option value="keep">Keep the deposit</option>
                <option value="refund">Refund it</option>
              </select>
            </label>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            The amount is the deposit set on each service. It comes off the groom at the register and is
            refunded when a customer cancels before the cutoff.
          </p>
          <label>
            Welcome message on the booking page
            <input
              value={f.message}
              onChange={(e) => setF({ ...f, message: e.target.value })}
              maxLength={500}
            />
          </label>
        </fieldset>
        <p className="muted small" style={{ margin: 0 }}>
          Choose which services are bookable under Grooming → Services, and which groomers under Grooming →
          Groomers. <a href="/book">Open the booking page</a>
        </p>
        {canEdit && (
          <div>
            <button className="primary" disabled={save.isPending}>
              Save online booking
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
