import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { can, formatDate, formatMoney, todayIso } from "@pet-pos/core";
import type { AstroCheckCandidate, AstroCheckRow, AstroProgramReportRow } from "@pet-pos/api";
import { useSession } from "../../session.tsx";
import { errorMessage } from "../../ui/errors.ts";
import { useToast } from "../../ui/Toast.tsx";
import { count, Kpi, money, ReportTable, text } from "./ReportTable.tsx";
import { ReportState, useReport } from "./ReportsPage.tsx";

type Range = { from: string; to: string };

/** Days since a time, in words: "today", "1 day", "9 days". */
export function ageText(at: Date | null, now = new Date()): string {
  if (!at) return "";
  const days = Math.floor((now.getTime() - new Date(at).getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
}

export function AstroTab({ range }: { range: Range }) {
  const { api, me } = useSession();
  const q = useReport("astro", range, () => api.call("astroReport", range));
  if (!q.data) return <ReportState q={q} />;
  const r = q.data;
  const b = r.backlog;
  const stale = r.checkDue;

  return (
    <>
      <div className="kpis">
        <Kpi label="Punches earned" value={r.earned.toLocaleString("en-US")} />
        <Kpi
          label="Rewards redeemed"
          value={String(r.rewards)}
          sub={r.rewards ? formatMoney(r.rewardCents) : undefined}
        />
        <Kpi
          label="Offers redeemed"
          value={String(r.offers)}
          sub={r.offers ? formatMoney(r.offerCents) : undefined}
        />
        <Kpi
          label="Waiting to enter in Astro"
          value={String(b.pending)}
          sub={b.oldestAt ? `Oldest: ${ageText(b.oldestAt)}` : "All entered"}
          warn={b.overWeek > 0}
        />
        <Kpi
          label="Last Astro check"
          value={r.lastCheckAt ? formatDate(todayLocal(r.lastCheckAt)) : "Never"}
          sub={stale ? "Due: check this week's customers below" : undefined}
          warn={stale}
        />
      </div>

      <ReportTable<AstroProgramReportRow>
        title="By program"
        range={range}
        rows={r.programs}
        rowKey={(x) => x.programId || "none"}
        columns={[
          text("Program", (x) => x.name),
          count("Punches earned", (x) => x.earned),
          count("Taken back by refunds", (x) => x.takenBack),
          count("Rewards", (x) => x.rewards),
          money("Reward value", (x) => x.rewardCents),
          count("Offers", (x) => x.offers),
          money("Offer value", (x) => x.offerCents),
        ]}
        empty="No Astro activity in this range."
      />

      <section className="report-section" aria-label="Queue backlog">
        <div className="report-head">
          <h2>Queue backlog</h2>
          <Link to="/astro">Open the queue</Link>
        </div>
        <div className="tablewrap">
          <table>
            <tbody>
              <tr>
                <td>Waiting under a day</td>
                <td className="r num">{b.underDay}</td>
              </tr>
              <tr>
                <td>1 to 7 days</td>
                <td className="r num">{b.underWeek}</td>
              </tr>
              <tr>
                <td>
                  Over a week{" "}
                  {b.overWeek > 0 && <span className="tag low">Enter these in the Astro portal</span>}
                </td>
                <td className="r num">{b.overWeek}</td>
              </tr>
              {b.failed > 0 && (
                <tr>
                  <td>Failed to send</td>
                  <td className="r num">{b.failed}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted small report-note">This is the queue as of now, whatever range is picked.</p>
      </section>

      <AstroCheck week={r.week} toCheck={r.toCheck} canSave={can(me.staff.role, "astro.edit")} />

      <ReportTable<AstroCheckRow>
        title="Past Astro checks"
        range={range}
        rows={r.checks}
        rowKey={(x) => x.id}
        columns={[
          {
            label: "Checked",
            sort: (x) => new Date(x.createdAt).getTime(),
            show: (x) => formatDate(todayLocal(x.createdAt)),
            csv: (x) => todayLocal(x.createdAt),
          },
          text("Customer", (x) => x.customerName),
          text("Program", (x) => x.programName),
          count("Here", (x) => x.localBalance),
          {
            label: "Astro",
            num: true,
            sort: (x) => x.astroBalance ?? x.localBalance,
            show: (x) => String(x.astroBalance ?? x.localBalance),
            csv: (x) => x.astroBalance ?? x.localBalance,
          },
          {
            label: "Result",
            sort: (x) => (x.matches ? 1 : 0),
            show: (x) =>
              x.matches ? (
                <span className="tag ok">Matches</span>
              ) : (
                <span className="tag low">Off by {Math.abs((x.astroBalance ?? 0) - x.localBalance)}</span>
              ),
            csv: (x) =>
              x.matches ? "Matches" : `Off by ${Math.abs((x.astroBalance ?? 0) - x.localBalance)}`,
          },
          text("By", (x) => x.staffName),
        ]}
        empty="No checks saved yet."
        note="A mismatch isn't fixed here. Correct the punches in the Astro portal or on the customer's profile."
      />
    </>
  );
}

function todayLocal(d: Date): string {
  return todayIso(new Date(d));
}

/** This week's customers to look up in the Astro portal. */
function AstroCheck({
  week,
  toCheck,
  canSave,
}: {
  week: string;
  toCheck: AstroCheckCandidate[];
  canSave: boolean;
}) {
  return (
    <section className="report-section" aria-label="Weekly Astro check">
      <div className="report-head">
        <h2>Weekly Astro check</h2>
        <span className="muted small">Week of {formatDate(week)}</span>
      </div>
      <p className="muted small report-note">
        Look up each customer in the Astro retailer portal and type the punches Astro shows, or tap Matches. A
        box left empty counts as matching. It catches a sale that was missed or entered twice.
      </p>
      {toCheck.length === 0 && (
        <p className="muted">
          No customers had Astro activity in the last 30 days, so there's nothing to check.
        </p>
      )}
      <div className="check-list">
        {toCheck.map((c) => (
          <CheckCard key={c.customerId} c={c} canSave={canSave} />
        ))}
      </div>
    </section>
  );
}

function CheckCard({ c, canSave }: { c: AstroCheckCandidate; canSave: boolean }) {
  const { api } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (rows: { programId: string; astroBalance: number | null }[]) =>
      api.call("saveAstroCheck", { customerId: c.customerId, rows }),
    onSuccess: (saved) => {
      const off = saved.filter((s) => !s.matches);
      toast(off.length ? `Saved: ${off.length} doesn't match` : "Saved: matches Astro");
      setValues({});
      void qc.invalidateQueries({ queryKey: ["report", "astro"] });
    },
    onError: (err) => toast(errorMessage(err)),
  });
  const typed = c.programs.map((p) => ({ p, v: (values[p.programId] ?? "").trim() }));
  const bad = typed.some(({ v }) => v !== "" && !/^\d{1,4}$/.test(v));

  return (
    <div className="card check-card">
      <div className="report-head">
        <b>{c.customerName}</b>
        {c.checkedAt && <span className="tag ok">Checked this week</span>}
      </div>
      {c.programs.map((p) => (
        <label key={p.programId} className="check-row">
          <span>
            {p.programName}
            <span className="sub">Here: {p.localBalance} punches</span>
          </span>
          {canSave && (
            <input
              inputMode="numeric"
              placeholder="Astro shows"
              aria-label={`${c.customerName}: ${p.programName} punches in Astro`}
              value={values[p.programId] ?? ""}
              onChange={(e) => setValues({ ...values, [p.programId]: e.target.value })}
            />
          )}
        </label>
      ))}
      {canSave && c.programs.length > 0 && (
        <div className="actions">
          <button
            type="button"
            disabled={save.isPending}
            onClick={() =>
              save.mutate(c.programs.map((p) => ({ programId: p.programId, astroBalance: null })))
            }
          >
            Matches
          </button>
          <button
            type="button"
            className="primary"
            disabled={save.isPending || bad || typed.every(({ v }) => v === "")}
            onClick={() =>
              save.mutate(
                typed.map(({ p, v }) => ({
                  programId: p.programId,
                  astroBalance: v === "" ? null : Number(v),
                })),
              )
            }
          >
            Save what Astro shows
          </button>
        </div>
      )}
      {bad && <p className="error-box">Type the punches Astro shows, as a whole number.</p>}
    </div>
  );
}
