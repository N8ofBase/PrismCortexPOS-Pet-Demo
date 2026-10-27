import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import {
  can,
  clockText,
  formatMoney,
  formatPhone,
  minutesOfDay,
  minutesToTime,
  nextSteps,
  timeToMinutes,
  STATUS_LABEL,
  type ApptStatus,
} from "@pet-pos/core";
import type { AppointmentRow } from "@pet-pos/api";
import { useSession } from "../../session.tsx";
import { errorMessage } from "../../ui/errors.ts";
import { SlideOver } from "../../ui/SlideOver.tsx";
import { useToast } from "../../ui/Toast.tsx";
import { TwoTapButton } from "../../ui/TwoTapButton.tsx";
import { AppointmentNotes } from "./Notes.tsx";
import { useMove, type PendingMove } from "./useMove.ts";

/** Moves an appointment to a status, with the toasts the counter needs. */
export function useStatus() {
  const { api, me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (v: { id: string; status: ApptStatus; keepDeposit?: boolean }) =>
      api.call("setAppointmentStatus", v),
    onSuccess: (a) => {
      toast(
        a.status === "ready" && a.customerPhone
          ? me.business.textWhenReady
            ? `${a.petName} is ready. Text sent to ${formatPhone(a.customerPhone)} (a preview in the demo).`
            : `${a.petName} is ready. Text ${formatPhone(a.customerPhone)} to let them know.`
          : `${a.petName}: ${STATUS_LABEL[a.status].toLowerCase()}`,
      );
      void qc.invalidateQueries({ queryKey: ["groomingDay"] });
      void qc.invalidateQueries({ queryKey: ["groomingWeek"] });
      void qc.invalidateQueries({ queryKey: ["appointmentMessages", a.id] });
      void qc.invalidateQueries({ queryKey: ["customerAppointments"] });
      void qc.invalidateQueries({ queryKey: ["sales"] });
    },
    onError: (err) => toast(errorMessage(err)),
  });
}

/** Rabies, allergies and coat notes, the things a groomer must see first. */
export function PetAlerts({ a }: { a: AppointmentRow }) {
  return (
    <>
      {a.rabiesLapsed && <span className="tag out">Rabies expired. Ask for proof before the groom.</span>}
      {a.allergies && (
        <span>
          <b>Allergies:</b> {a.allergies}
        </span>
      )}
      {(a.coat || a.temperament) && (
        <span className="muted">{[a.coat, a.temperament].filter(Boolean).join(" · ")}</span>
      )}
      {a.lastNote && (
        <span>
          <b>Last time:</b> {a.lastNote}
        </span>
      )}
    </>
  );
}

export function AppointmentPanel({
  a,
  onEdit,
  onClose,
}: {
  a: AppointmentRow;
  onEdit: () => void;
  onClose: () => void;
}) {
  const { api, me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const status = useStatus();
  const role = me.staff.role;
  const canBook = can(role, "grooming.book");
  const steps = nextSteps(a.status, role);
  const paidDeposit = a.deposit?.status === "paid" ? a.deposit.amountCents - a.deposit.refundedCents : 0;
  const [refundOnCancel, setRefundOnCancel] = useState(true);
  const [noShow, setNoShow] = useState<{ keep: boolean } | null>(null);
  const cancel = useMutation({
    mutationFn: () =>
      api.call("cancelAppointment", { id: a.id, ...(paidDeposit ? { refundDeposit: refundOnCancel } : {}) }),
    onSuccess: () => {
      toast(
        paidDeposit
          ? refundOnCancel
            ? `Appointment canceled · ${formatMoney(paidDeposit)} deposit refunded`
            : `Appointment canceled · ${formatMoney(paidDeposit)} deposit kept as a cancellation fee`
          : "Appointment canceled",
      );
      void qc.invalidateQueries({ queryKey: ["groomingDay"] });
      void qc.invalidateQueries({ queryKey: ["customerAppointments"] });
      onClose();
    },
    onError: (err) => toast(errorMessage(err)),
  });
  const open = !["done", "canceled", "no_show"].includes(a.status);
  const [moving, setMoving] = useState(false);
  const movable = canBook && (a.status === "booked" || a.status === "checked_in");

  return (
    <SlideOver title={`${a.petName} · ${a.serviceName}`} onClose={onClose}>
      <div style={{ display: "grid", gap: 10 }}>
        <span>
          <span className={`chip ${a.status}`}>{STATUS_LABEL[a.status]}</span>
        </span>
        <div className="kpis">
          <div className="kpi">
            <span className="muted">When</span>
            <b style={{ fontSize: "1rem" }}>
              {clockText(a.start)} – {clockText(a.end)}
            </b>
            <span className="muted small">
              {new Date(a.startsAt).toLocaleDateString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}{" "}
              · {a.groomerName}
            </span>
          </div>
          <div className="kpi">
            <span className="muted">Customer</span>
            <b style={{ fontSize: "1rem" }}>{a.customerName ?? "Customer deleted"}</b>
            <span className="muted mono">{formatPhone(a.customerPhone)}</span>
          </div>
          <div className="kpi">
            <span className="muted">Price · size {a.size}</span>
            <b className="num">{formatMoney(a.priceCents)}</b>
            <span className="muted small">{a.label}</span>
          </div>
        </div>
        {a.source === "online" && <span className="muted small">Booked online by the customer.</span>}
        <PetAlerts a={a} />
        {a.notes && (
          <p style={{ margin: 0 }}>
            <b>Notes:</b> {a.notes}
          </p>
        )}
        <div className="actions">
          {steps.map((s) => (
            <button
              type="button"
              key={s.to}
              className={s.undo ? "" : "primary"}
              disabled={status.isPending}
              onClick={() =>
                s.to === "no_show" && paidDeposit
                  ? setNoShow({ keep: me.business.keepDepositOnNoShow })
                  : status.mutate({ id: a.id, status: s.to })
              }
            >
              {s.label}
            </button>
          ))}
          {can(role, "register.use") &&
            ["booked", "checked_in", "in_progress", "ready"].includes(a.status) &&
            a.customerId && (
              <button
                type="button"
                className={a.status === "ready" ? "primary" : ""}
                onClick={() =>
                  navigate("/register", {
                    state: { groom: { appointmentId: a.id, customerId: a.customerId } },
                  })
                }
              >
                Check out at register
              </button>
            )}
          {canBook && open && (
            <button type="button" onClick={onEdit}>
              Edit
            </button>
          )}
          {movable && (
            <button type="button" onClick={() => setMoving(!moving)} aria-pressed={moving}>
              Move
            </button>
          )}
          {canBook && a.status !== "done" && a.status !== "canceled" && paidDeposit > 0 && (
            <label className="check small">
              <input
                type="checkbox"
                checked={refundOnCancel}
                onChange={(e) => setRefundOnCancel(e.target.checked)}
              />
              If canceled, refund the {formatMoney(paidDeposit)} deposit
            </label>
          )}
          {canBook && a.status !== "done" && a.status !== "canceled" && (
            <TwoTapButton
              className="dangerbtn"
              label="Cancel appointment"
              confirmLabel="Tap again to cancel"
              disabled={cancel.isPending}
              onConfirm={() => cancel.mutate()}
            />
          )}
        </div>
        {noShow && (
          <div className="note" role="alert" style={{ display: "grid", gap: 8 }}>
            <label className="check">
              <input
                type="checkbox"
                checked={noShow.keep}
                onChange={(e) => setNoShow({ keep: e.target.checked })}
              />
              Keep the {formatMoney(paidDeposit)} deposit as a no-show fee
            </label>
            <span className="muted small">
              {noShow.keep
                ? "It's rung up as a paid sale, so it shows in today's sales with a receipt number."
                : "It goes back to the card that paid it."}
            </span>
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={status.isPending}
                onClick={() =>
                  status.mutate(
                    { id: a.id, status: "no_show", keepDeposit: noShow.keep },
                    { onSuccess: () => setNoShow(null) },
                  )
                }
              >
                Mark no-show
              </button>
              <button type="button" onClick={() => setNoShow(null)}>
                Never mind
              </button>
            </div>
          </div>
        )}
        <DepositLine a={a} canBook={canBook && open} />
        {a.status === "done" && (
          <p style={{ margin: 0 }}>
            {a.receiptNumber ? `Paid · receipt #${a.receiptNumber}` : "Done (paid outside the register)"}
            {a.saleRefundedCents > 0 && (
              <span className="tag low"> Refunded {formatMoney(a.saleRefundedCents)}</span>
            )}
          </p>
        )}
        {moving && <MoveForm a={a} onDone={() => setMoving(false)} />}
        <Messages a={a} canText={canBook && open} />
        <AppointmentNotes appointmentId={a.id} />
      </div>
    </SlideOver>
  );
}

const holdTime = (d: Date) => clockText(minutesOfDay(new Date(d)));

/** The deposit on this groom, and asking for or refunding one. */
function DepositLine({ a, canBook }: { a: AppointmentRow; canBook: boolean }) {
  const { api, me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [asked, setAsked] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["groomingDay"] });
    void qc.invalidateQueries({ queryKey: ["groomingWeek"] });
    void qc.invalidateQueries({ queryKey: ["appointmentMessages", a.id] });
  };
  const ask = useMutation({
    mutationFn: (text: boolean) => api.call("requestDeposit", { appointmentId: a.id, text }),
    onSuccess: (r) => {
      setAsked(r.url);
      toast(r.texted ? "Deposit link texted (a preview in the demo)" : "Deposit link made");
      refresh();
    },
    onError: (err) => toast(errorMessage(err)),
  });
  const refund = useMutation({
    mutationFn: () => api.call("refundDeposit", { id: a.deposit!.id }),
    onSuccess: (r) => {
      toast(r.refundedCents ? `${formatMoney(r.refundedCents)} deposit refunded` : "Deposit link canceled");
      refresh();
    },
    onError: (err) => toast(errorMessage(err)),
  });
  const d = a.deposit;
  const amount = d ? formatMoney(d.amountCents - (d.status === "applied" ? 0 : d.refundedCents)) : "";
  const paidOn = d?.paidAt
    ? new Date(d.paidAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "";
  const canRefund = can(me.staff.role, "sales.refund");

  if (!d || d.status === "canceled" || d.status === "expired") {
    if (!canBook || (a.status !== "booked" && a.status !== "checked_in")) return null;
    return (
      <div className="actions" style={{ alignItems: "center" }}>
        <button type="button" disabled={ask.isPending} onClick={() => ask.mutate(false)}>
          Ask for a deposit
        </button>
        {a.customerPhone && (
          <button type="button" disabled={ask.isPending} onClick={() => ask.mutate(true)}>
            Ask for a deposit and text the link
          </button>
        )}
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 4 }} aria-label="Deposit">
      {d.status === "pending" && a.status === "held" && (
        <span className="note small">
          Waiting for the {formatMoney(d.amountCents)} deposit. The time is held until{" "}
          {a.holdUntil ? holdTime(a.holdUntil) : "soon"}, then let go.
        </span>
      )}
      {d.status === "pending" && a.status !== "held" && (
        <span className="small">
          {formatMoney(d.amountCents)} deposit asked for, not paid yet.
          {(asked ?? d.url) && (
            <>
              {" "}
              Link: <span className="mono">{asked ?? d.url}</span>
            </>
          )}
        </span>
      )}
      {d.status === "paid" && (
        <span className="small">
          <span className="tag ok">Deposit</span> {amount} paid online {paidOn}. It comes off at the register.
        </span>
      )}
      {d.status === "applied" && <span className="small">{amount} deposit used on the sale.</span>}
      {d.status === "refunded" && (
        <span className="muted small">{formatMoney(d.refundedCents)} deposit refunded.</span>
      )}
      {d.status === "kept" && (
        <span className="small">
          {amount} deposit kept as a fee{d.keptReceiptNumber ? ` · receipt #${d.keptReceiptNumber}` : ""}.
        </span>
      )}
      {canRefund && (d.status === "paid" || (d.status === "pending" && a.status !== "held")) && (
        <div>
          <TwoTapButton
            label={d.status === "paid" ? "Refund deposit" : "Cancel deposit link"}
            confirmLabel={
              d.status === "paid" ? `Tap again: refund ${amount}` : "Tap again to cancel the link"
            }
            disabled={refund.isPending}
            onConfirm={() => refund.mutate()}
          />
        </div>
      )}
    </div>
  );
}

/** Move without dragging: pick the groomer, day and time. */
function MoveForm({ a, onDone }: { a: AppointmentRow; onDone: () => void }) {
  const { api } = useSession();
  const d = new Date(a.startsAt);
  const [f, setF] = useState({
    staffId: a.staffId,
    day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    time: minutesToTime(a.start),
  });
  const [pending, setPending] = useState<PendingMove | null>(null);
  const move = useMove(setPending);
  const groomers = useQuery({ queryKey: ["groomers"], queryFn: () => api.call("listGroomers", {}) });
  const go = (override = false) =>
    move.mutate(
      { id: a.id, staffId: f.staffId, day: f.day, start: timeToMinutes(f.time), override },
      { onSuccess: onDone },
    );
  return (
    <div className="panel" style={{ display: "grid", gap: 8 }} aria-label="Move appointment">
      <div className="form" style={{ alignItems: "end" }}>
        <label>
          Groomer
          <select value={f.staffId} onChange={(e) => setF({ ...f, staffId: e.target.value })}>
            {(groomers.data ?? []).map((g) => (
              <option key={g.staffId} value={g.staffId}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Day
          <input
            type="date"
            value={f.day}
            onChange={(e) => e.target.value && setF({ ...f, day: e.target.value })}
          />
        </label>
        <label>
          Time
          <input
            type="time"
            step={900}
            value={f.time}
            onChange={(e) => e.target.value && setF({ ...f, time: e.target.value })}
          />
        </label>
        <button type="button" className="primary" disabled={move.isPending} onClick={() => go()}>
          Move it
        </button>
      </div>
      {pending && (
        <div className="note" role="alert">
          <span>{pending.message}</span>
          <div className="actions">
            <button type="button" className="primary" onClick={() => go(true)}>
              Move anyway
            </button>
            <button type="button" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const KIND_LABEL = {
  ready: "Ready text",
  moved: "Change text",
  canceled: "Canceled text",
  deposit: "Deposit link",
} as const;

/** Texts to the customer about this appointment, previews in the demo. */
function Messages({ a, canText }: { a: AppointmentRow; canText: boolean }) {
  const { api } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["appointmentMessages", a.id],
    queryFn: () => api.call("appointmentMessages", { appointmentId: a.id }),
  });
  const send = useMutation({
    mutationFn: () => api.call("textAppointment", { id: a.id, kind: "moved" }),
    onSuccess: () => {
      toast("Text saved (a preview in the demo)");
      void qc.invalidateQueries({ queryKey: ["appointmentMessages", a.id] });
    },
    onError: (err) => toast(errorMessage(err)),
  });
  const list = q.data ?? [];
  if (!list.length && !(canText && a.customerPhone)) return null;
  return (
    <section style={{ display: "grid", gap: 6 }} aria-label="Texts to the customer">
      <h3 style={{ margin: 0 }}>Texts to the customer</h3>
      {list.map((m) => (
        <div key={m.id} className="sub">
          <b>{KIND_LABEL[m.kind]}</b> to {formatPhone(m.to)} ·{" "}
          {new Date(m.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          <div className="receipt" style={{ marginTop: 4 }}>
            {m.body}
          </div>
        </div>
      ))}
      {list.length > 0 && (
        <p className="muted small" style={{ margin: 0 }}>
          In the demo, texts aren't sent. In the hosted version they go by Amazon SMS.
        </p>
      )}
      {canText && a.customerPhone && (
        <div>
          <button type="button" onClick={() => send.mutate()} disabled={send.isPending}>
            Text the customer the current time and groomer
          </button>
        </div>
      )}
    </section>
  );
}
