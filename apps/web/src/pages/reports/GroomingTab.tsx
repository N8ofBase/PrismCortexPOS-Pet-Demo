import { averageCents, formatMoney, percentOfTotal } from "@pet-pos/core";
import type { GroomerReportRow, NoShowRow, ServiceReportRow } from "@pet-pos/api";
import { useSession } from "../../session.tsx";
import { count, Kpi, money, ReportTable, text } from "./ReportTable.tsx";
import { ReportState, useReport } from "./ReportsPage.tsx";

type Range = { from: string; to: string };

const when = (d: Date) =>
  new Date(d).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export function GroomingTab({ range }: { range: Range }) {
  const { api } = useSession();
  const q = useReport("grooming", range, () => api.call("groomingReport", range));
  if (!q.data) return <ReportState q={q} />;
  const r = q.data;
  const rb = r.rebook;
  const noShowShare = percentOfTotal(r.noShows, r.booked);

  return (
    <>
      <div className="kpis">
        <Kpi label="Grooming revenue" value={formatMoney(r.revenueCents)} sub="After discounts, before tax" />
        <Kpi label="Grooms paid" value={r.grooms.toLocaleString("en-US")} />
        <Kpi
          label="Average groom"
          value={r.grooms ? formatMoney(averageCents(r.revenueCents, r.grooms)) : "—"}
        />
        <Kpi
          label="No-shows"
          value={String(r.noShows)}
          sub={noShowShare === null ? undefined : `${noShowShare}% of ${r.booked} booked`}
          warn={noShowShare !== null && noShowShare >= 10}
        />
        <Kpi
          label="Rebooked"
          value={rb.ratePercent === null ? "—" : `${rb.ratePercent}%`}
          sub={rebookSub(rb)}
        />
      </div>

      <ReportTable<GroomerReportRow>
        title="By groomer"
        range={range}
        rows={r.groomers}
        rowKey={(x) => x.staffId}
        columns={[
          text("Groomer", (x) => x.name),
          count("Grooms paid", (x) => x.grooms),
          money("Revenue", (x) => x.salesCents),
          money("Average groom", (x) => x.averageCents),
          money("Refunds", (x) => x.refundCents),
          count("No-shows", (x) => x.noShows),
        ]}
        empty="No grooms paid in this range."
        note="Revenue is net of refunds on grooms made in the range."
      />

      <ReportTable<ServiceReportRow>
        title="By service"
        range={range}
        rows={r.services}
        rowKey={(x) => x.serviceId}
        columns={[
          text("Service", (x) => x.name),
          count("Grooms paid", (x) => x.grooms),
          money("Revenue", (x) => x.salesCents),
          money("Average", (x) => averageCents(x.salesCents, x.grooms)),
        ]}
        empty="No grooms paid in this range."
        note="Add-ons are part of the main service's price."
      />

      <ReportTable<NoShowRow>
        title="No-shows"
        range={range}
        rows={r.noShowList}
        rowKey={(x) => x.id}
        columns={[
          {
            label: "When",
            sort: (x) => new Date(x.startsAt).getTime(),
            show: (x) => when(x.startsAt),
            csv: (x) => new Date(x.startsAt).toISOString(),
          },
          text("Pet", (x) => x.petName),
          text("Customer", (x) => x.customerName),
          text("Groomer", (x) => x.groomerName),
          text("Service", (x) => x.serviceName),
          {
            label: "Deposit kept",
            num: true,
            sort: (x) => x.keptCents ?? 0,
            show: (x) => (x.keptCents ? formatMoney(x.keptCents) : "—"),
            csv: (x) => (x.keptCents ? { cents: x.keptCents } : null),
          },
        ]}
        empty="No no-shows in this range."
      />

      <p className="muted small report-note">
        Rebooked: the pet's next groom is booked within the service's rebook weeks plus two (a full groom
        every 6 weeks counts within 8). "Before they left" counts next grooms booked on or before the day of
        the groom.
      </p>
    </>
  );
}

function rebookSub(rb: {
  rebooked: number;
  bookedBeforeLeaving: number;
  beforeLeavingPercent: number | null;
  tooSoon: number;
}) {
  const parts: string[] = [];
  if (rb.beforeLeavingPercent !== null) parts.push(`${rb.beforeLeavingPercent}% before they left`);
  if (rb.tooSoon) parts.push(`${rb.tooSoon} more still ${rb.tooSoon === 1 ? "has" : "have"} time`);
  return parts.join(" · ") || undefined!;
}
