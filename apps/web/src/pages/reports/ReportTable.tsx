import { useState, type ReactNode } from "react";
import { csvFileName, formatMoney, toCsv, type CsvValue } from "@pet-pos/core";

export interface Column<T> {
  label: string;
  /** Right-aligned with tabular numbers (money and counts). */
  num?: boolean;
  /** What the column sorts by. Money sorts by cents. */
  sort: (row: T) => number | string;
  /** On screen. */
  show: (row: T) => ReactNode;
  /** In the CSV. Money goes in as { cents } and comes out as plain dollars. */
  csv: (row: T) => CsvValue;
}

/** A money column: shown as $1,234.56, sorted by cents, written as 1234.56. */
export function money<T>(label: string, cents: (row: T) => number): Column<T> {
  return {
    label,
    num: true,
    sort: cents,
    show: (r) => formatMoney(cents(r)),
    csv: (r) => ({ cents: cents(r) }),
  };
}

/** A count column. */
export function count<T>(label: string, n: (row: T) => number): Column<T> {
  return { label, num: true, sort: n, show: (r) => n(r).toLocaleString("en-US"), csv: n };
}

/** A text column. */
export function text<T>(label: string, s: (row: T) => string | null): Column<T> {
  return { label, sort: (r) => s(r) ?? "", show: (r) => s(r) ?? "—", csv: s };
}

interface Props<T> {
  title: string;
  /** Names the CSV file, with the range. */
  range: { from: string; to: string };
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** A totals row at the bottom, shown and downloaded but never sorted. */
  total?: T;
  empty: string;
  note?: ReactNode;
}

/** A report table: sortable by any column, with a CSV of exactly what's on screen. */
export function ReportTable<T>({ title, range, rows, columns, rowKey, total, empty, note }: Props<T>) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const sorted = sort
    ? [...rows].sort((a, b) => {
        const x = columns[sort.col]!.sort(a);
        const y = columns[sort.col]!.sort(b);
        const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        return c * sort.dir;
      })
    : rows;

  function download() {
    const body = [...sorted, ...(total ? [total] : [])].map((r) => columns.map((c) => c.csv(r)));
    const blob = new Blob(
      [
        toCsv(
          columns.map((c) => c.label),
          body,
        ),
      ],
      { type: "text/csv;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvFileName(title, range.from, range.to);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="report-section" aria-label={title}>
      <div className="report-head">
        <h2>{title}</h2>
        {rows.length > 0 && (
          <button type="button" onClick={download}>
            Download CSV
          </button>
        )}
      </div>
      <div className="tablewrap">
        <table className={columns.length > 4 ? "wide" : undefined}>
          <thead>
            <tr>
              {columns.map((c, i) => {
                const on = sort?.col === i;
                return (
                  <th
                    key={c.label}
                    className={c.num ? "r" : undefined}
                    aria-sort={on ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}
                  >
                    <button
                      type="button"
                      className="sort"
                      onClick={() =>
                        setSort(
                          on ? { col: i, dir: sort!.dir === 1 ? -1 : 1 } : { col: i, dir: c.num ? -1 : 1 },
                        )
                      }
                    >
                      {c.label}
                      <span aria-hidden="true">{on ? (sort!.dir === 1 ? " ▲" : " ▼") : ""}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={rowKey(r)}>
                {columns.map((c) => (
                  <td key={c.label} className={c.num ? "r num" : undefined}>
                    {c.show(r)}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="muted">
                  {empty}
                </td>
              </tr>
            )}
            {total && rows.length > 0 && (
              <tr className="total">
                {columns.map((c, i) => (
                  <td key={c.label} className={c.num ? "r num" : undefined}>
                    {i === 0 ? <b>{c.show(total)}</b> : c.show(total)}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {note && <p className="muted small report-note">{note}</p>}
    </section>
  );
}

export function Kpi({
  label,
  value,
  sub,
  warn,
}: {
  label: string;
  value: string;
  sub?: string;
  warn?: boolean;
}) {
  return (
    <div className={warn ? "kpi warn" : "kpi"}>
      <span className="muted">{label}</span>
      <b className="num">{value}</b>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}
