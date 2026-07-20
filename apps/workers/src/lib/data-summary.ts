import Papa from "papaparse";
import type { ColumnSummary, DataframeSummary } from "@/lib/core";

/**
 * Parse a CSV string into a column summary mirroring `.summarize_data_context()` in R.
 * The resulting summary feeds `buildDataContext` to produce the system prompt context block.
 */
export function summarizeCsv(name: string, csv: string): DataframeSummary {
  const parsed = Papa.parse<Record<string, unknown>>(csv, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
  });
  const rows = parsed.data;
  const fields = parsed.meta.fields ?? [];

  const columns: ColumnSummary[] = fields.map((field) => {
    const values = rows.map((r) => r[field]);
    return summarizeColumn(field, values);
  });

  return {
    name,
    rows: rows.length,
    cols: fields.length,
    columns,
  };
}

function summarizeColumn(name: string, values: unknown[]): ColumnSummary {
  const nonNull = values.filter((v) => v !== null && v !== undefined && v !== "");
  if (nonNull.length === 0) return { name, dtype: "unknown" };

  const allNumeric = nonNull.every((v) => typeof v === "number" && Number.isFinite(v));
  if (allNumeric) {
    const nums = nonNull as number[];
    const sorted = [...nums].sort((a, b) => a - b);
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, nums.length - 1);
    const sd = Math.sqrt(variance);
    const median =
      sorted.length % 2 === 0
        ? ((sorted[sorted.length / 2 - 1] ?? 0) + (sorted[sorted.length / 2] ?? 0)) / 2
        : sorted[Math.floor(sorted.length / 2)] ?? 0;
    return {
      name,
      dtype: "numeric",
      numeric: {
        mean,
        median,
        sd,
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
        naCount: values.length - nums.length,
      },
    };
  }

  const allBool = nonNull.every((v) => typeof v === "boolean");
  const dtype: ColumnSummary["dtype"] = allBool ? "logical" : "categorical";

  const counts = new Map<string, number>();
  for (const v of nonNull) {
    const key = String(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sortedCounts = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  return {
    name,
    dtype,
    categorical: { counts: sortedCounts },
  };
}
