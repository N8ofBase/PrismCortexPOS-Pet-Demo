import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { clockText, minutesToTime, taxPercentInput, timeToMinutes } from "@pet-pos/core";
import type { StoreSettings } from "@pet-pos/api";
import { useSession } from "../../session.tsx";
import { errorMessage } from "../../ui/errors.ts";
import { useToast } from "../../ui/Toast.tsx";

/** Settings → Messages: confirmations, the day-before reminder and rebook reminders. */
export function MessagesSection({ s, canEdit }: { s: StoreSettings; canEdit: boolean }) {
  const { api } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const m = s.messages;
  const [f, setF] = useState({
    confirmOn: m.confirmOn,
    remindOn: m.remindOn,
    remindTime: minutesToTime(m.remindMinute),
    nudgeOn: m.nudgeOn,
    nudgeWeeks: String(m.nudgeWeeks),
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
        messages: {
          confirmOn: f.confirmOn,
          remindOn: f.remindOn,
          remindMinute: timeToMinutes(f.remindTime),
          nudgeOn: f.nudgeOn,
          nudgeWeeks: Number(f.nudgeWeeks),
        },
      }),
    onSuccess: () => {
      toast("Messages saved");
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => toast(errorMessage(err)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <section className="panel">
      <h2>Messages to customers</h2>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}>
          <label className="check">
            <input
              type="checkbox"
              checked={f.confirmOn}
              onChange={(e) => setF({ ...f, confirmOn: e.target.checked })}
            />
            Send a confirmation when a groom is booked
          </label>
          <div className="form" style={{ alignItems: "end" }}>
            <label className="check">
              <input
                type="checkbox"
                checked={f.remindOn}
                onChange={(e) => setF({ ...f, remindOn: e.target.checked })}
              />
              Remind customers the day before
            </label>
            <label>
              at
              <input
                type="time"
                min="09:00"
                max="20:00"
                step={900}
                value={f.remindTime}
                onChange={(e) => e.target.value && setF({ ...f, remindTime: e.target.value })}
              />
            </label>
          </div>
          <div className="form" style={{ alignItems: "end" }}>
            <label className="check">
              <input
                type="checkbox"
                checked={f.nudgeOn}
                onChange={(e) => setF({ ...f, nudgeOn: e.target.checked })}
              />
              Send a rebook reminder when nothing's booked
            </label>
            <label>
              after (weeks)
              <input
                type="number"
                min={1}
                max={52}
                value={f.nudgeWeeks}
                onChange={(e) => setF({ ...f, nudgeWeeks: e.target.value })}
              />
            </label>
          </div>
        </fieldset>
        <p className="muted small" style={{ margin: 0 }}>
          Each service can have its own rebook weeks under Grooming → Services. Messages go by text when the
          customer has agreed to texts, otherwise by email. Nothing goes out between {clockText(20 * 60)} and{" "}
          {clockText(9 * 60)}.
        </p>
        {canEdit && (
          <div>
            <button className="primary" disabled={save.isPending}>
              Save messages
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
