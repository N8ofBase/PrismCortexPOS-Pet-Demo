import { formatMoney, todayIso } from "@pet-pos/core";
import type { CountToCheckRow, ReorderRow, StockCategoryRow } from "@pet-pos/api";
import { Link } from "react-router";
import { useSession } from "../../session.tsx";
import { count, Kpi, money, ReportTable, text } from "./ReportTable.tsx";
import { ReportState, useReport } from "./ReportsPage.tsx";

export function StockTab() {
  const { api } = useSession();
  const q = useReport("stock", null, () => api.call("stockReport", undefined));
  if (!q.data) return <ReportState q={q} />;
  const r = q.data;
  const today = { from: r.asOf ?? todayIso(), to: r.asOf ?? todayIso() };

  return (
    <>
      <div className="kpis">
        <Kpi
          label="Stock value at cost"
          value={formatMoney(r.costCents)}
          sub={
            r.noCost ? `${r.noCost} product${r.noCost === 1 ? " has" : "s have"} no cost entered` : undefined
          }
          warn={r.noCost > 0}
        />
        <Kpi
          label="Stock value at retail"
          value={formatMoney(r.retailCents)}
          sub="Back-bar supplies not included"
        />
        <Kpi label="Items low" value={String(r.low)} warn={r.low > 0} />
        <Kpi label="Items out" value={String(r.out)} warn={r.out > 0} />
      </div>

      <ReportTable<ReorderRow>
        title="Reorder list"
        range={today}
        rows={r.reorder}
        rowKey={(x) => x.productId}
        columns={[
          text("SKU", (x) => x.sku),
          {
            label: "Product",
            sort: (x) => x.name,
            show: (x) => (
              <>
                {x.name}
                {x.backBar && <span className="tag muted"> Back bar</span>}
              </>
            ),
            csv: (x) => x.name,
          },
          text("Brand", (x) => x.brand),
          text("Category", (x) => x.category),
          {
            label: "On hand",
            num: true,
            sort: (x) => x.onHand,
            show: (x) =>
              x.onHand <= 0 ? (
                <span className="tag out">Out</span>
              ) : (
                <span className="tag low">{x.onHand} left</span>
              ),
            csv: (x) => x.onHand,
          },
          count("Reorder at", (x) => x.reorderAt),
          count("Sold, last 30 days", (x) => x.soldLast30),
          {
            label: "Cost",
            num: true,
            sort: (x) => x.costCents,
            show: (x) => (x.costCents ? formatMoney(x.costCents) : <span className="muted">No cost</span>),
            csv: (x) => (x.costCents ? { cents: x.costCents } : null),
          },
        ]}
        empty="Nothing is at or below its reorder point."
        note={
          <>
            Products at or below their reorder point, out of stock first. Suggested amounts to order come with
            purchase orders. Change a reorder point in <Link to="/inventory">Inventory</Link>.
          </>
        }
      />

      <ReportTable<StockCategoryRow>
        title="Stock value by category"
        range={today}
        rows={r.categories}
        rowKey={(x) => x.category}
        columns={[
          text("Category", (x) => x.category),
          count("Units on hand", (x) => x.units),
          money("At cost", (x) => x.costCents),
          money("At retail", (x) => x.retailCents),
        ]}
        total={{
          category: "Total",
          units: r.categories.reduce((s, x) => s + x.units, 0),
          costCents: r.costCents,
          retailCents: r.retailCents,
        }}
        empty="No products yet."
        note="Stock below zero counts as none."
      />

      {r.countsToCheck.length > 0 && (
        <ReportTable<CountToCheckRow>
          title="Check these counts"
          range={today}
          rows={r.countsToCheck}
          rowKey={(x) => x.productId}
          columns={[
            text("SKU", (x) => x.sku),
            text("Product", (x) => x.name),
            count("On hand", (x) => x.onHand),
          ]}
          empty=""
          note={
            <>
              These show less than zero: they sold before they were received. Count them in{" "}
              <Link to="/inventory/count">Count mode</Link>.
            </>
          }
        />
      )}
    </>
  );
}
