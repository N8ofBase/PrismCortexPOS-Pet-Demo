import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  addDays,
  can,
  clockText,
  formatMoney,
  snapMinutes,
  STATUS_LABEL,
  todayIso,
  weekStart,
} from "@pet-pos/core";
import type { AppointmentRow, DayGroomer } from "@pet-pos/api";
import { useSession } from "../../session.tsx";
import { errorMessage } from "../../ui/errors.ts";
import { AppointmentPanel } from "./AppointmentPanel.tsx";
import { BookingPanel, type BookingStart } from "./BookingPanel.tsx";
import { CalloutPanel } from "./CalloutPanel.tsx";
import { MyDay } from "./MyDay.tsx";
import { useMove, type PendingMove } from "./useMove.ts";
import { WeekView } from "./WeekView.tsx";

/** 30-minute rows, 34 px tall, as in the prototype. */
export const SLOT = 30;
export const SLOT_PX = 34;

/** True on a phone-sized screen, where the calendar columns are too cramped. */
export function useNarrow(width = 700): boolean {
  const query = `(max-width: ${width - 1}px)`;
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(query).matches,
  );
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return narrow;
}

/** The hours the grid shows: whole hours around the earliest start and latest end. */
export function gridHours(groomers: DayGroomer[], appts: AppointmentRow[]): { from: number; to: number } {
  const starts = [...groomers.flatMap((g) => (g.hours ? [g.hours.start] : [])), ...appts.map((a) => a.start)];
  const ends = [...groomers.flatMap((g) => (g.hours ? [g.hours.end] : [])), ...appts.map((a) => a.blockEnd)];
  if (!starts.length) return { from: 9 * 60, to: 17 * 60 };
  return { from: Math.floor(Math.min(...starts) / 60) * 60, to: Math.ceil(Math.max(...ends) / 60) * 60 };
}

/** Top and height in px for an appointment on the grid. */
export function placeBlock(
  a: Pick<AppointmentRow, "start" | "end">,
  from: number,
): { top: number; height: number } {
  return {
    top: ((a.start - from) / SLOT) * SLOT_PX + 2,
    height: Math.max(SLOT_PX - 4, ((a.end - a.start) / SLOT) * SLOT_PX - 4),
  };
}

/**
 * Where a dragged appointment lands: the pointer's height in the column, less where
 * the block was grabbed, snapped to 15 minutes.
 */
export function dropStart(pointerY: number, colTop: number, from: number, grabMinutes: number): number {
  return snapMinutes(from + ((pointerY - colTop) / SLOT_PX) * SLOT - grabMinutes);
}

export function Calendar({ bookFor }: { bookFor?: string | null }) {
  const { api, me } = useSession();
  const canBook = can(me.staff.role, "grooming.book");
  const isGroomer = me.staff.role === "groomer";
  const narrow = useNarrow();
  const [day, setDay] = useState(todayIso());
  const [mode, setMode] = useState<"day" | "week">("day");
  const [listView, setListView] = useState(isGroomer);
  const [who, setWho] = useState<string>(isGroomer ? me.staff.id : "");
  const [booking, setBooking] = useState<{ from: BookingStart; editing?: AppointmentRow } | null>(
    bookFor && canBook ? { from: { day: todayIso(), customerId: bookFor } } : null,
  );
  const [open, setOpen] = useState<AppointmentRow | null>(null);
  const [callout, setCallout] = useState(false);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const move = useMove(setPending);
  const q = useQuery({
    queryKey: ["groomingDay", day],
    queryFn: () => api.call("groomingDay", { day }),
    enabled: mode === "day",
  });
  const data = q.data;
  const today = todayIso();
  const showList = listView || narrow;
  const step = mode === "week" ? 7 : 1;
  // Keep the open panel in step with fresh data.
  const current = open ? (data?.appointments.find((a) => a.id === open.id) ?? open) : null;

  return (
    <>
      <div className="toolbar" style={{ justifyContent: "space-between" }}>
        <div className="actions" style={{ alignItems: "center" }}>
          <button
            type="button"
            aria-label={mode === "week" ? "Previous week" : "Previous day"}
            onClick={() => setDay(addDays(day, -step))}
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => setDay(today)}
            aria-pressed={mode === "week" ? weekStart(day) === weekStart(today) : day === today}
          >
            {mode === "week" ? "This week" : "Today"}
          </button>
          <button
            type="button"
            aria-label={mode === "week" ? "Next week" : "Next day"}
            onClick={() => setDay(addDays(day, step))}
          >
            ›
          </button>
          <input
            type="date"
            value={day}
            onChange={(e) => e.target.value && setDay(e.target.value)}
            aria-label="Pick a date"
            style={{ width: "auto" }}
          />
          <b style={{ fontFamily: "var(--display)" }}>
            {mode === "week"
              ? `Week of ${new Date(`${weekStart(day)}T12:00:00`).toLocaleDateString(undefined, { month: "long", day: "numeric" })}`
              : new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
            {mode === "day" && day === today ? " · Today" : ""}
          </b>
        </div>
        <div className="actions">
          <div className="seg" role="group" aria-label="Day or week">
            <button type="button" aria-pressed={mode === "day"} onClick={() => setMode("day")}>
              Day
            </button>
            <button type="button" aria-pressed={mode === "week"} onClick={() => setMode("week")}>
              Week
            </button>
          </div>
          {mode === "day" && !narrow && (
            <div className="seg" role="group" aria-label="View">
              <button type="button" aria-pressed={!listView} onClick={() => setListView(false)}>
                Calendar
              </button>
              <button type="button" aria-pressed={listView} onClick={() => setListView(true)}>
                {isGroomer ? "My day" : "List"}
              </button>
            </div>
          )}
          {canBook && (
            <button type="button" onClick={() => setCallout(true)}>
              Groomer called out
            </button>
          )}
          {canBook && (
            <button type="button" className="primary" onClick={() => setBooking({ from: { day } })}>
              Book appointment
            </button>
          )}
        </div>
      </div>

      {pending && (
        <div className="note" role="alert">
          <span>{pending.message}</span>
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                move.mutate({ ...pending, override: true });
                setPending(null);
              }}
            >
              Move anyway
            </button>
            <button type="button" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "week" && (
        <WeekView
          day={day}
          narrow={narrow}
          onOpen={setOpen}
          onPickDay={(d) => {
            setDay(d);
            setMode("day");
          }}
        />
      )}

      {mode === "day" && q.isError && <p className="error-box">{errorMessage(q.error)}</p>}
      {mode === "day" && data && (
        <div className="kpis">
          <Kpi label="Appointments" value={String(data.summary.appointments)} />
          <Kpi label="In the shop now" value={String(data.summary.inShop)} />
          <Kpi label="Ready for pickup" value={String(data.summary.ready)} />
          <Kpi label="Grooming sales" value={formatMoney(data.summary.expectedCents)} />
        </div>
      )}

      {mode === "day" && data && showList && (
        <>
          {data.groomers.length > 1 && (
            <label style={{ maxWidth: 320 }}>
              Groomer
              <select value={who} onChange={(e) => setWho(e.target.value)}>
                <option value="">Everyone</option>
                {data.groomers.map((g) => (
                  <option key={g.staffId} value={g.staffId}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <MyDay appointments={data.appointments.filter((a) => !who || a.staffId === who)} onOpen={setOpen} />
        </>
      )}

      {mode === "day" && data && !showList && (
        <DayGrid
          groomers={data.groomers}
          appointments={data.appointments}
          canBook={canBook}
          onBook={(staffId, start) => setBooking({ from: { day, staffId, start } })}
          onOpen={setOpen}
          onMove={(a, staffId, start) => move.mutate({ id: a.id, staffId, day, start })}
          day={day}
        />
      )}
      {mode === "day" && !showList && (
        <p className="muted small">
          Tap an open time to book it. Tap an appointment to check it in, start the groom or mark it ready.
          {canBook ? " Drag a booked appointment to move it (on a tablet, press and hold first)." : ""}
        </p>
      )}

      {current && (
        <AppointmentPanel
          a={current}
          onClose={() => setOpen(null)}
          onEdit={() => {
            setOpen(null);
            setBooking({ from: { day }, editing: current });
          }}
        />
      )}
      {booking && (
        <BookingPanel from={booking.from} editing={booking.editing} onClose={() => setBooking(null)} />
      )}
      {callout && <CalloutPanel day={day} onClose={() => setCallout(false)} />}
    </>
  );
}

interface Drag {
  appt: AppointmentRow;
  pointerId: number;
  x: number;
  y: number;
  /** Minutes between the block's top and where it was grabbed. */
  grab: number;
  active: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

function DayGrid({
  groomers,
  appointments,
  canBook,
  onBook,
  onOpen,
  onMove,
  day,
}: {
  groomers: DayGroomer[];
  appointments: AppointmentRow[];
  canBook: boolean;
  onBook: (staffId: string, start: number) => void;
  onOpen: (a: AppointmentRow) => void;
  onMove: (a: AppointmentRow, staffId: string, start: number) => void;
  day: string;
}) {
  const drag = useRef<Drag | null>(null);
  const justDragged = useRef(false);
  const [ghost, setGhost] = useState<{ appt: AppointmentRow; staffId: string; start: number } | null>(null);
  const { from, to } = gridHours(groomers, appointments);

  useEffect(() => {
    // While dragging on a touch screen, the page mustn't scroll under the finger.
    const block = (e: TouchEvent) => {
      if (drag.current?.active) e.preventDefault();
    };
    window.addEventListener("touchmove", block, { passive: false });
    return () => window.removeEventListener("touchmove", block);
  }, []);

  function target(d: Drag, x: number, y: number) {
    const col = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-col]");
    if (!col) return null;
    const rect = col.getBoundingClientRect();
    return { staffId: col.dataset.col!, start: dropStart(y, rect.top, from, d.grab) };
  }

  function down(e: React.PointerEvent, a: AppointmentRow) {
    if (!canBook || (a.status !== "booked" && a.status !== "checked_in")) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const grab = ((e.clientY - rect.top) / SLOT_PX) * SLOT;
    const d: Drag = {
      appt: a,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      grab,
      active: false,
      timer: null,
    };
    drag.current = d;
    if (e.pointerType === "touch")
      d.timer = setTimeout(() => {
        d.active = true;
        setGhost({ appt: a, staffId: a.staffId, start: a.start });
      }, 400);
  }

  function moveTo(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const far = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (!d.active) {
      if (e.pointerType === "touch") {
        // Moving before the hold finishes is a scroll, not a drag.
        if (far > 8) {
          if (d.timer) clearTimeout(d.timer);
          drag.current = null;
        }
        return;
      }
      if (far < 5) return;
      d.active = true;
    }
    const t = target(d, e.clientX, e.clientY);
    if (t) setGhost({ appt: d.appt, ...t });
  }

  function up(e: React.PointerEvent) {
    const d = drag.current;
    drag.current = null;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.timer) clearTimeout(d.timer);
    if (!d.active) return;
    justDragged.current = true;
    setTimeout(() => (justDragged.current = false), 0);
    const t =
      target(d, e.clientX, e.clientY) ?? (ghost ? { staffId: ghost.staffId, start: ghost.start } : null);
    setGhost(null);
    if (t && (t.staffId !== d.appt.staffId || t.start !== d.appt.start)) onMove(d.appt, t.staffId, t.start);
  }

  if (!groomers.length)
    return (
      <p className="muted panel">
        No groomers work on {new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "long" })}s.
        Set groomer hours under Groomers.
      </p>
    );
  const rows = (to - from) / SLOT;
  const height = rows * SLOT_PX;
  const groomerName = (id: string) => groomers.find((g) => g.staffId === id)?.name ?? "";
  return (
    <div className="calwrap" onPointerMove={moveTo} onPointerUp={up} onPointerCancel={() => setGhost(null)}>
      <div
        className="cal"
        style={{ gridTemplateColumns: `56px repeat(${groomers.length}, minmax(170px, 1fr))` }}
      >
        <div className="hd" />
        {groomers.map((g) => (
          <div className="hd" key={g.staffId}>
            {g.name}
            <small>
              {g.hours ? `${clockText(g.hours.start)} – ${clockText(g.hours.end)}` : "Not working today"}
            </small>
          </div>
        ))}
        <div className="times" style={{ height }}>
          {Array.from({ length: rows / 2 + 1 }, (_, i) => (
            <span key={i} style={{ top: i * 2 * SLOT_PX }}>
              {i === 0 ? "" : clockText(from + i * 60).replace(":00", "")}
            </span>
          ))}
        </div>
        {groomers.map((g) => (
          <div
            className="col"
            style={{ height }}
            key={g.staffId}
            data-col={g.staffId}
            data-testid={`col-${g.name}`}
          >
            {Array.from({ length: rows }, (_, i) => {
              const m = from + i * SLOT;
              const off = !g.hours || m < g.hours.start || m >= g.hours.end;
              const hour = (i + 1) % 2 === 0 ? " hour" : "";
              return off || !canBook ? (
                <div
                  key={i}
                  className={`slot${off ? " off" : ""}${hour}`}
                  style={{ height: SLOT_PX }}
                  aria-hidden="true"
                />
              ) : (
                <button
                  type="button"
                  key={i}
                  className={`slot${hour}`}
                  style={{ height: SLOT_PX }}
                  aria-label={`Book ${g.name} at ${clockText(m)}`}
                  onClick={() => onBook(g.staffId, m)}
                />
              );
            })}
            {g.timeOff.map((t, i) => {
              const s = Math.max(t.start, from);
              const e = Math.min(t.end, to);
              if (e <= s) return null;
              return (
                <div
                  key={`off${i}`}
                  className="timeoff"
                  style={{ top: ((s - from) / SLOT) * SLOT_PX, height: ((e - s) / SLOT) * SLOT_PX }}
                >
                  Time off{t.note ? `: ${t.note}` : ""}
                </div>
              );
            })}
            {appointments
              .filter((a) => a.staffId === g.staffId)
              .map((a) => {
                const { top, height: h } = placeBlock(a, from);
                const movable = canBook && (a.status === "booked" || a.status === "checked_in");
                return (
                  <button
                    type="button"
                    key={a.id}
                    className={`appt ${a.status}${movable ? " movable" : ""}${ghost?.appt.id === a.id ? " dragging" : ""}`}
                    style={{ top, height: h }}
                    onPointerDown={(e) => down(e, a)}
                    onClick={() => !justDragged.current && onOpen(a)}
                    aria-label={`${a.petName} at ${clockText(a.start)}, ${STATUS_LABEL[a.status]}`}
                  >
                    <b>{a.petName}</b> <span className="muted">{clockText(a.start)}</span>
                    {a.rabiesLapsed && <span title="Rabies expired"> ⚠</span>}
                    {a.source === "online" && <span className="tag astro"> Online</span>}
                    {a.deposit?.status === "paid" && (
                      <span className="tag ok" title="Deposit paid online">
                        {" "}
                        $
                      </span>
                    )}
                    {a.status === "held" && <span className="muted"> · Waiting for deposit</span>}
                    <br />
                    {a.serviceName} · {a.size}
                    {h > 60 && (
                      <>
                        <br />
                        <span className="muted">{a.customerName ?? ""}</span>
                      </>
                    )}
                    {h > 84 && (
                      <>
                        <br />
                        <span className={`chip ${a.status}`}>{STATUS_LABEL[a.status]}</span>
                      </>
                    )}
                  </button>
                );
              })}
            {ghost && ghost.staffId === g.staffId && (
              <div
                className={`appt ${ghost.appt.status} ghost`}
                style={placeBlock(
                  { start: ghost.start, end: ghost.start + (ghost.appt.end - ghost.appt.start) },
                  from,
                )}
                aria-hidden="true"
              >
                <b>{ghost.appt.petName}</b>
                <br />
                {clockText(ghost.start)} – {clockText(ghost.start + (ghost.appt.end - ghost.appt.start))} ·{" "}
                {groomerName(ghost.staffId)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi">
      <span className="muted">{label}</span>
      <b className="num">{value}</b>
    </div>
  );
}
