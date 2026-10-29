import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { formatPhone } from "@pet-pos/core";
import { SMS_CONSENT, type MyMessageSettings } from "@pet-pos/api";
import { errorMessage } from "../ui/errors.ts";
import { useBooking } from "./context.ts";

/** My account → Messages: text or email, texts on or off, and rebook reminders. */
export function MessagePrefs() {
  const { api } = useBooking();
  const q = useQuery({ queryKey: ["myMessages"], queryFn: () => api.call("myMessageSettings") });
  if (q.isError) return <p className="error-box">{errorMessage(q.error)}</p>;
  if (!q.data) return <p className="muted">Loading…</p>;
  return <Form s={q.data} />;
}

function Form({ s }: { s: MyMessageSettings }) {
  const { api } = useBooking();
  const qc = useQueryClient();
  const [f, setF] = useState(s);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api.call("saveMyMessageSettings", {
        smsOptIn: f.smsOptIn,
        contactPref: f.contactPref,
        nudgesOff: f.nudgesOff,
        emailOff: f.emailOff,
      }),
    onSuccess: (r) => {
      qc.setQueryData(["myMessages"], r);
      setSaved(true);
    },
  });
  const change = (x: Partial<MyMessageSettings>) => {
    setF({ ...f, ...x });
    setSaved(false);
  };

  return (
    <section className="panel" aria-label="Messages" style={{ display: "grid", gap: 10 }}>
      <h2 style={{ margin: 0 }}>Messages about your grooms</h2>
      <p className="muted small" style={{ margin: 0 }}>
        We send a confirmation when you book, a reminder the day before, and a note when it's time for the
        next groom.
      </p>
      {f.phone && (
        <label className="check">
          <input
            type="checkbox"
            checked={f.smsOptIn}
            onChange={(e) => change({ smsOptIn: e.target.checked })}
          />
          <span>
            Texts to {formatPhone(f.phone)}
            <span className="sub">{SMS_CONSENT}</span>
          </span>
        </label>
      )}
      {f.phone && f.email && (
        <label style={{ maxWidth: 320 }}>
          Send them by
          <select
            value={f.contactPref ?? "text"}
            onChange={(e) => change({ contactPref: e.target.value as "text" | "email" })}
          >
            <option value="text">Text</option>
            <option value="email">Email to {f.email}</option>
          </select>
        </label>
      )}
      {f.email && f.emailOff && (
        <label className="check">
          <input
            type="checkbox"
            checked={!f.emailOff}
            onChange={(e) => change({ emailOff: !e.target.checked })}
          />
          Email to {f.email} (you unsubscribed)
        </label>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={!f.nudgesOff}
          onChange={(e) => change({ nudgesOff: !e.target.checked })}
        />
        Remind me when it's time for the next groom
      </label>
      {save.isError && <p className="error-box">{errorMessage(save.error)}</p>}
      <div className="actions" style={{ alignItems: "center" }}>
        <button type="button" className="primary" disabled={save.isPending} onClick={() => save.mutate()}>
          Save
        </button>
        {saved && <span className="muted small">Saved.</span>}
      </div>
    </section>
  );
}

/** /book/unsubscribe?t=…, from a rebook email. Works without signing in. */
export function Unsubscribe({ token }: { token: string }) {
  const { api, page } = useBooking();
  const go = useMutation({
    mutationFn: (what: "nudges" | "email") => api.call("unsubscribe", { token, what }),
  });
  if (go.data)
    return (
      <section className="panel" role="status">
        <h2 style={{ marginTop: 0 }}>Done</h2>
        <p style={{ margin: 0 }}>
          {go.data.off === "nudges"
            ? `You won't get rebook reminders from ${go.data.storeName} anymore.`
            : `You won't get any more email from ${go.data.storeName}.`}{" "}
          To change it back, sign in and open Messages.
        </p>
      </section>
    );
  return (
    <section className="panel" style={{ display: "grid", gap: 10 }}>
      <h2 style={{ margin: 0 }}>Unsubscribe</h2>
      <p style={{ margin: 0 }}>What would you like to stop getting from {page.storeName}?</p>
      {go.isError && <p className="error-box">{errorMessage(go.error)}</p>}
      <div className="actions">
        <button type="button" className="primary" disabled={go.isPending} onClick={() => go.mutate("nudges")}>
          Rebook reminders only
        </button>
        <button type="button" disabled={go.isPending} onClick={() => go.mutate("email")}>
          All email
        </button>
      </div>
    </section>
  );
}
