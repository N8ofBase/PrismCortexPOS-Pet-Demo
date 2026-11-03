import { averageCents, formatMoney, percentOfTotal, shortDay } from "@pet-pos/core";
import type { CategoryTotals, PaymentTypeRow, SalesDayRow, TopProductRow } from "@pet-pos/api";
import { useSession } from "../../session.tsx";
import { count, Kpi, money, ReportTable, text } from "./ReportTable.tsx";
import { ReportState, useReport } from "./ReportsPage.tsx";

type Range = { from: string; to: string };

export function SalesTab({ range }: { range: Range }) {
  const { api } = useSession();
  const q = useReport("sales", range, () => api.call("salesReport", range));
  if (!q.data) return <ReportState q={q} />;
  const r = q.data;
  const t = r.totals;
  const storeDiscount = t.discountCents - t.astroDiscountCents;
  const netBeforeTax = r.categories.reduce((s, c) => s + c.netCents, 0);

  return (
    <>
      <div className="kpis">
        <Kpi label="Net sales" value={formatMoney(t.netCents)} sub="After refunds, with tax" />
        <Kpi label="Sales" value={t.count.toLocaleString("en-US")} />
        <Kpi label="Average sale" value={formatMoney(averageCents(t.grossCents, t.count))} />
        <Kpi label="Tax collected" value={formatMoney(t.taxCents)} />
        <Kpi
          label="Discounts"
          value={formatMoney(t.discountCents)}
          sub={`Store ${formatMoney(storeDiscount)} · Astro ${formatMoney(t.astroDiscountCents)}`}
        />
        <Kpi
          label={`Refunds${t.refundCount ? ` (${t.refundCount})` : ""}`}
          value={t.refundCents ? `−${formatMoney(t.refundCents)}` : formatMoney(0)}
        />
      </div>

      <ReportTable<PaymentTypeRow>
        title="Money in by payment type"
        range={range}
        rows={r.paymentTypes}
        rowKey={(x) => x.key}
        columns={[
          text("Type", (x) => x.label),
          money("In", (x) => x.inCents),
          money("Back", (x) => x.backCents),
          money("Net", (x) => x.netCents),
        ]}
        total={{
          key: "card",
          label: "Total",
          inCents: r.paymentTypes.reduce((s, x) => s + x.inCents, 0),
          backCents: r.paymentTypes.reduce((s, x) => s + x.backCents, 0),
          netCents: r.paymentTypes.reduce((s, x) => s + x.netCents, 0),
        }}
        empty="No money in this range."
        note="Deposits come through Square online, not the counter reader or the drawer. A deposit used on a groom is already in the deposits row, so it isn't counted twice."
      />

      <ReportTable<CategoryTotals>
        title="Sales by category"
        range={range}
        rows={r.categories}
        rowKey={(x) => x.category ?? "none"}
        columns={[
          text("Category", (x) => x.category ?? "No category"),
          count("Items sold", (x) => x.qty),
          money("Sales", (x) => x.salesCents),
          money("Refunds", (x) => x.refundCents),
          money("Net", (x) => x.netCents),
          {
            label: "Share",
            num: true,
            sort: (x) => x.netCents,
            show: (x) => percentText(percentOfTotal(x.netCents, netBeforeTax)),
            csv: (x) => percentOfTotal(x.netCents, netBeforeTax),
          },
        ]}
        total={{
          category: "Total",
          qty: r.categories.reduce((s, x) => s + x.qty, 0),
          salesCents: r.categories.reduce((s, x) => s + x.salesCents, 0),
          refundCents: r.categories.reduce((s, x) => s + x.refundCents, 0),
          netCents: netBeforeTax,
        }}
        empty="No sales in this range."
        note="After discounts, before tax. Each sale counts under the category its product had when it sold."
      />

      <ReportTable<SalesDayRow>
        title="Day by day"
        range={range}
        rows={r.days}
        rowKey={(x) => x.day}
        columns={[
          {
            label: "Day",
            sort: (x) => x.day,
            show: (x) => (x.day === "Total" ? "Total" : shortDay(x.day)),
            csv: (x) => x.day,
          },
          count("Sales", (x) => x.count),
          money("Net sales", (x) => x.netCents),
          money("Card", (x) => x.cardCents),
          money("Cash", (x) => x.cashCents),
          money("Deposits", (x) => x.depositsCents),
          money("Tax", (x) => x.taxCents),
        ]}
        total={{
          day: "Total",
          count: t.count,
          netCents: t.netCents,
          cardCents: t.cardInCents - t.cardBackCents,
          cashCents: t.cashInCents - t.cashBackCents,
          depositsCents: t.depositsTakenCents - t.depositsRefundedCents,
          taxCents: t.taxCents,
        }}
        empty="No days in this range."
        note="Card, cash and deposits are net of refunds made that day."
      />

      <ReportTable<TopProductRow>
        title="Top products"
        range={range}
        rows={r.topProducts}
        rowKey={(x) => x.productId}
        columns={[
          text("SKU", (x) => x.sku),
          text("Product", (x) => x.name),
          count("Sold", (x) => x.qty),
          money("Net", (x) => x.netCents),
        ]}
        empty="No products sold in this range."
        note="The 20 best sellers by net sales, after discounts and refunds, before tax."
      />
    </>
  );
}

function percentText(p: number | null): string {
  return p === null ? "—" : `${p}%`;
}
