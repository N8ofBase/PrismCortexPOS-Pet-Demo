import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  centsToInput,
  DENOMINATION_LABEL,
  DENOMINATIONS,
  depositFor,
  expectedCash,
  formatMoney,
  needsShortNote,
  overShortLabel,
  parseMoney,
  todayIso,
} from "@pet-pos/core";
import type { DrawerCountResult, DrawerSummary } from "@pet-pos/api";
import { useSession } from "../../session.tsx";
import { errorMessage } from "../../ui/errors.ts";
import { useToast } from "../../ui/Toast.tsx";

/** Cents counted from the denomination boxes; blank boxes count as 0. */
export function countedFrom(boxes: Record<string, string>): number | null {
  let total = 0;
  for (const d of DENOMINATIONS) {
    const v = (boxes[d] ?? "").trim();
    if (!v) continue;
    if (!/^\d+$/.test(v)) return null;
    total += d * Number(v);
  }
  return total;
}

/** "ok" (even), "over" or "short", for the color of the over/short line. */
export function overShortTone(cents: number): "ok" | "low" | "out" {
  return cents === 0 ? "ok" : cents > 0 ? "low" : "out";
}

export function EndOfDayPage() {
  const { api } = useSession();
  const [day, setDay] = useState(todayIso());
  const s = useQuery({ queryKey: ["drawer", day], queryFn: () => api.call("drawerSummary", { day }) });
  const history = useQuery({
    queryKey: ["drawerCounts"],
    queryFn: () => {
      const to = todayIso();
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return api.call("listDrawerCounts", { from: todayIso(d), to });
    },
  });

  return (
    <>
      <div className="page-head">
        <h1>End of day</h1>
        <Link to="..">Back to sales</Link>
      </div>
      <div className="toolbar">
        <label>
          <span className="muted small">Day </span>
          <input
            type="date"
            value={day}
            max={todayIso()}
            onChange={(e) => e.target.value && setDay(e.target.value)}
            aria-label="Day to close"
          />
        </label>
      </div>
      {s.isError && <p className="error-box">{errorMessage(s.error)}</p>}
      {s.data && <CountForm key={`${day}-${s.data.counts.length}`} s={s.data} />}

      <h2>Past counts</h2>
      <div className="tablewrap">
        <table className="wide">
          <thead>
            <tr>
              <th>Day</th>
              <th>Counted by</th>
              <th className="r">Expected</th>
              <th className="r">Counted</th>
              <th className="r">Over / short</th>
              <th className="r">Card</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {history.data?.map((c) => (
              <tr key={c.id}>
                <td className="num" style={{ whiteSpace: "nowrap" }}>
                  {c.day}{" "}
                  <span className="muted small">
                    {new Date(c.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </span>
                </td>
                <td>{c.staffName ?? "—"}</td>
                <td className="r num">{formatMoney(c.expectedCents)}</td>
                <td className="r num">{formatMoney(c.countedCents)}</td>
                <td className="r">
                  <span className={`tag ${overShortTone(c.overShortCents)}`}>
                    {overShortLabel(c.overShortCents)}
                  </span>
                </td>
                <td className="r num">{formatMoney(c.cardCents)}</td>
                <td>{c.note}</td>
              </tr>
            ))}
            {history.data?.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No counts in the last 30 days.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CountForm({ s }: { s: DrawerSummary }) {
  const { api } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [starting, setStarting] = useState(centsToInput(s.startingCents));
  const [byTotal, setByTotal] = useState(false);
  const [boxes, setBoxes] = useState<Record<string, string>>({});
  const [total, setTotal] = useState("");
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<DrawerCountResult | null>(null);

  const startCents = parseMoney(starting);
  const counted = byTotal ? parseMoney(total) : countedFrom(boxes);
  const expected = startCents === null ? null : expectedCash(startCents, s.cashInCents, s.cashOutCents);
  const overShort = counted !== null && expected !== null ? counted - expected : null;
  const touched = byTotal ? !!total.trim() : Object.values(boxes).some((v) => v.trim());
  const noteNeeded = touched && overShort !== null && needsShortNote(overShort);

  const save = useMutation({
    mutationFn: () =>
      api.call("saveDrawerCount", {
        day: s.day,
        startingCents: startCents!,
        denominations: byTotal
          ? null
          : Object.fromEntries(
              Object.entries(boxes)
                .filter(([, v]) => v.trim())
                .map(([k, v]) => [k, Number(v)]),
            ),
        countedCents: byTotal ? counted! : undefined,
        note,
      }),
    onSuccess: (r) => {
      setSaved(r);
      toast(`Count saved: ${r.label}`);
      void qc.invalidateQueries({ queryKey: ["drawerCounts"] });
    },
    onError: (err) => toast(errorMessage(err)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  const t = s.totals;
  const deposit = counted !== null && startCents !== null ? depositFor(counted, startCents) : null;
  const last = s.counts[0];

  return (
    <>
      <div className="kpis">
        <Kpi label="Sales" value={String(t.count)} />
        <Kpi label="Gross sales" value={formatMoney(t.grossCents)} />
        <Kpi label="Discounts" value={formatMoney(t.discountCents)} />
        <Kpi label="Tax collected" value={formatMoney(t.taxCents)} />
        <Kpi label="Refunds" value={t.refundCents ? `−${formatMoney(t.refundCents)}` : formatMoney(0)} />
        <Kpi label="Net sales" value={formatMoney(t.netCents)} />
      </div>

      <section className="panel">
        <h2>Card total</h2>
        <p style={{ margin: 0 }}>
          <b className="num">{formatMoney(s.cardCents)}</b>{" "}
          <span className="muted">
            ({formatMoney(t.cardInCents)} taken
            {t.cardBackCents ? `, ${formatMoney(t.cardBackCents)} refunded` : ""})
          </span>
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          In the demo this comes from the simulated card reader. With a real Square Terminal, check it against
          Square's batch report.
        </p>
        {(t.depositsTakenCents > 0 || t.depositsUsedCents > 0 || t.depositsKeptCents > 0) && (
          <p className="small" style={{ margin: 0 }}>
            Online deposits taken {formatMoney(t.depositsTakenCents)} · used at the register{" "}
            {formatMoney(t.depositsUsedCents)} · kept as no-show or cancellation fees{" "}
            {formatMoney(t.depositsKeptCents)}. These come through Square online, not this reader.
          </p>
        )}
      </section>

      <form className="panel" onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <h2>Count the drawer</h2>
        {last && (
          <p className="muted small" style={{ margin: 0 }}>
            Already counted by {last.staffName ?? "someone"} at{" "}
            {new Date(last.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}:{" "}
            {overShortLabel(last.overShortCents)}. Counting again adds a recount; the newest one counts.
          </p>
        )}
        <div className="totals" aria-label="Expected cash">
          <div>
            <label>
              Starting cash{" "}
              <input
                value={starting}
                onChange={(e) => setStarting(e.target.value)}
                inputMode="decimal"
                style={{ width: 110 }}
                aria-label="Starting cash"
              />
            </label>
            <span className="num">{startCents === null ? "?" : formatMoney(startCents)}</span>
          </div>
          <div>
            <span>+ Cash taken</span>
            <span className="num">{formatMoney(s.cashInCents)}</span>
          </div>
          <div>
            <span>− Cash handed back (refunds)</span>
            <span className="num">{formatMoney(s.cashOutCents)}</span>
          </div>
          <div className="grand">
            <span>Expected in the drawer</span>
            <span className="num">{expected === null ? "?" : formatMoney(expected)}</span>
          </div>
        </div>

        <label className="check">
          <input type="checkbox" checked={byTotal} onChange={(e) => setByTotal(e.target.checked)} />
          Just enter the total
        </label>
        {byTotal ? (
          <label>
            Cash counted ($)
            <input value={total} onChange={(e) => setTotal(e.target.value)} inputMode="decimal" autoFocus />
          </label>
        ) : (
          <div className="form" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))" }}>
            {DENOMINATIONS.map((d) => (
              <label key={d}>
                {DENOMINATION_LABEL[d]}
                <input
                  value={boxes[d] ?? ""}
                  onChange={(e) => setBoxes({ ...boxes, [d]: e.target.value })}
                  inputMode="numeric"
                  aria-label={`How many ${DENOMINATION_LABEL[d]}`}
                />
              </label>
            ))}
          </div>
        )}

        <div className="totals" aria-label="Count result">
          <div>
            <span>Counted</span>
            <span className="num">{counted === null ? "Check the counts" : formatMoney(counted)}</span>
          </div>
          {touched && overShort !== null && (
            <div>
              <span>Over / short</span>
              <span className={`tag ${overShortTone(overShort)}`}>{overShortLabel(overShort)}</span>
            </div>
          )}
          {touched && deposit && (
            <p style={{ margin: "6px 0 0" }}>
              Take {formatMoney(deposit.depositCents)} to the bank, leave {formatMoney(deposit.leaveCents)} in
              the drawer.
            </p>
          )}
        </div>

        <label>
          Note
          {noteNeeded ? " (required: short more than " + formatMoney(s.shortNoteCents) + ")" : " (optional)"}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-invalid={noteNeeded && !note.trim()}
          />
        </label>

        <div className="actions">
          <button
            className="primary big"
            disabled={
              !touched ||
              counted === null ||
              startCents === null ||
              (noteNeeded && !note.trim()) ||
              save.isPending
            }
          >
            Save count
          </button>
        </div>
        {saved && (
          <p className="note" style={{ margin: 0 }}>
            Saved. {saved.label}. Take {formatMoney(saved.depositCents)} to the bank, leave{" "}
            {formatMoney(saved.leaveCents)} in the drawer.
          </p>
        )}
      </form>
    </>
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
