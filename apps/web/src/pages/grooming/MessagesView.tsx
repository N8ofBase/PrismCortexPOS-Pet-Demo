import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { addDays, formatPhone, todayIso } from "@pet-pos/core";
import type { MessageRow, SweepResult } from "@pet-pos/api";
import { useSession } from "../../session.tsx";
import { errorMessage } from "../../ui/errors.ts";
import { useToast } from "../../ui/Toast.tsx";
import { KIND_LABEL } from "./AppointmentPanel.tsx";

type Kind = MessageRow["kind"];

/** What the sweep did, in a sentence. */
export function sweepText(r: SweepResult): string {
  if (r.quiet)
    return "It's quiet hours (8:00 PM to 9:00 AM). Reminders and rebook reminders wait until 9:00 AM.";
  const parts = [
    r.reminders && `${r.reminders} reminder${r.reminders === 1 ? "" : "s"}`,
    r.nudges && `${r.nudges} rebook reminder${r.nudges === 1 ? "" : "s"}`,
  ].filter(Boolean);
  const sent = parts.length ? `Sent ${parts.join(" and ")}` : "Nothing was due";
  return r.skipped ? `${sent} · ${r.skipped} couldn't be sent (no text opt-in or email)` : sent;
}

/** Grooming → Messages: every message to customers, newest first. */
export function MessagesView() {
  const { api } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [days, setDays] = useState(7);
  const [kind, setKind] = useState<Kind | "">("");
  const to = todayIso();
  const from = addDays(to, -(days - 1));
  const list = useQuery({
    queryKey: ["messages", from, to, kind],
    queryFn: () => api.call("listMessages", { from, to, kind: kind || null }),
  });
  const sweep = useMutation({
    mutationFn: () => api.call("sendDueNow"),
    onSuccess: (r) => {
      toast(sweepText(r));
      void qc.invalidateQueries({ queryKey: ["messages"] });
    },
    onError: (err) => toast(errorMessage(err)),
  });

  return (
    <section style={{ display: "grid", gap: 12 }} aria-label="Messages">
      <div className="actions" style={{ alignItems: "end" }}>
        <label>
          Show
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>Today</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
          </select>
        </label>
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind | "")}>
            <option value="">All</option>
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          style={{ marginLeft: "auto" }}
          disabled={sweep.isPending}
          onClick={() => sweep.mutate()}
        >
          Send due messages now
        </button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Reminders go the day before at the time set in Settings; rebook reminders go the set number of weeks
        after a groom when nothing's booked. Nothing goes out between 8:00 PM and 9:00 AM. In the demo nothing
        is really sent: each message is a preview.
      </p>
      {list.isError && <p className="error-box">{errorMessage(list.error)}</p>}
      <div className="tablewrap">
        <table className="wide">
          <thead>
            <tr>
              <th>When</th>
              <th>Kind</th>
              <th>To</th>
              <th>Message</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((m) => (
              <tr key={m.id}>
                <td className="num">
                  {new Date(m.createdAt).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </td>
                <td>
                  <b>{KIND_LABEL[m.kind]}</b>
                  <br />
                  <span className="muted small">{m.petName}</span>
                </td>
                <td>
                  {m.customerName ?? "Customer deleted"}
                  <br />
                  <span className="muted small">
                    {m.channel === "sms" ? `Text ${formatPhone(m.to)}` : `Email ${m.to}`}
                  </span>
                </td>
                <td style={{ maxWidth: 420 }}>
                  {m.subject && <b className="small">{m.subject}</b>}
                  <div className="small" style={{ whiteSpace: "pre-wrap" }}>
                    {m.body}
                  </div>
                </td>
                <td>{m.status === "preview" ? "Preview" : m.status}</td>
              </tr>
            ))}
            {list.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No messages in this range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
