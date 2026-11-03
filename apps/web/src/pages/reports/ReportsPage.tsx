import { useQuery } from "@tanstack/react-query";
import { Navigate, NavLink, Route, Routes, useLocation, useParams, useSearchParams } from "react-router";
import { formatDate, isIsoDate, matchPreset, presetRange, RANGE_PRESETS, todayIso } from "@pet-pos/core";
import { errorMessage } from "../../ui/errors.ts";
import { AstroTab } from "./AstroTab.tsx";
import { GroomingTab } from "./GroomingTab.tsx";
import { SalesTab } from "./SalesTab.tsx";
import { StockTab } from "./StockTab.tsx";

export const REPORT_TABS = [
  { key: "sales", label: "Sales" },
  { key: "grooming", label: "Grooming" },
  { key: "stock", label: "Stock" },
  { key: "astro", label: "Astro" },
] as const;
type TabKey = (typeof REPORT_TABS)[number]["key"];

export function ReportsRoutes() {
  const location = useLocation();
  return (
    <Routes>
      <Route index element={<Navigate to={{ pathname: "sales", search: location.search }} replace />} />
      <Route path=":tab" element={<ReportsPage />} />
    </Routes>
  );
}

/** The range from the address (?from=…&to=…), or this month. Kept there so a report can be bookmarked. */
export function useReportRange(): {
  range: { from: string; to: string };
  setRange: (r: { from: string; to: string }) => void;
} {
  const [params, setParams] = useSearchParams();
  const today = todayIso();
  const from = params.get("from");
  const to = params.get("to");
  const range =
    from && to && isIsoDate(from) && isIsoDate(to) ? { from, to } : presetRange("this_month", today);
  return { range, setRange: (r) => setParams(r, { replace: true }) };
}

export function rangeText(r: { from: string; to: string }, today = todayIso()): string {
  return r.from === r.to
    ? formatDate(r.from, today)
    : `${formatDate(r.from, today)} to ${formatDate(r.to, today)}`;
}

export function ReportsPage() {
  const { tab = "sales" } = useParams();
  const { range, setRange } = useReportRange();
  const today = todayIso();
  const preset = matchPreset(range.from, range.to, today);
  const search = `?from=${range.from}&to=${range.to}`;
  const key = (REPORT_TABS.find((t) => t.key === tab)?.key ?? null) as TabKey | null;
  if (!key) return <Navigate to={`/reports/sales${search}`} replace />;

  return (
    <>
      <div className="page-head">
        <h1>Reports</h1>
        <span className="muted">{key === "stock" ? "As of today" : rangeText(range, today)}</span>
      </div>
      <nav className="cat-tabs report-tabs" aria-label="Reports" style={{ marginTop: 0 }}>
        {REPORT_TABS.map((t) => (
          <NavLink key={t.key} to={`/reports/${t.key}${search}`} className="tab-link">
            {t.label}
          </NavLink>
        ))}
      </nav>
      {key !== "stock" && (
        <div className="toolbar" aria-label="Date range">
          <div className="cat-tabs" style={{ marginTop: 0 }}>
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                aria-pressed={preset === p.key}
                onClick={() => setRange(presetRange(p.key, today))}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label>
            <span className="muted small">From </span>
            <input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => e.target.value && setRange({ from: e.target.value, to: range.to })}
              aria-label="From"
            />
          </label>
          <label>
            <span className="muted small">To </span>
            <input
              type="date"
              value={range.to}
              min={range.from}
              onChange={(e) => e.target.value && setRange({ from: range.from, to: e.target.value })}
              aria-label="To"
            />
          </label>
        </div>
      )}
      {key === "sales" && <SalesTab range={range} />}
      {key === "grooming" && <GroomingTab range={range} />}
      {key === "stock" && <StockTab />}
      {key === "astro" && <AstroTab range={range} />}
    </>
  );
}

/** Loading and errors, the same on every tab. */
export function useReport<T>(name: string, range: { from: string; to: string } | null, fn: () => Promise<T>) {
  return useQuery({ queryKey: ["report", name, range], queryFn: fn });
}

export function ReportState({ q }: { q: { isPending: boolean; isError: boolean; error: unknown } }) {
  if (q.isError) return <p className="error-box">{errorMessage(q.error)}</p>;
  if (q.isPending) return <p className="muted">Adding it up…</p>;
  return null;
}
