/**
 * Build a data-context summary string that mirrors the R `.summarize_data_context()` output.
 * Computed server-side from parsed CSVs so the model sees the same shape it expects.
 */

export interface ColumnSummary {
  name: string;
  dtype: "numeric" | "categorical" | "logical" | "unknown";
  numeric?: {
    mean: number;
    median: number;
    sd: number;
    min: number;
    max: number;
    naCount: number;
  };
  categorical?: {
    counts: Array<[string, number]>;
    moreCount?: number;
  };
}

export interface DataframeSummary {
  name: string;
  rows: number;
  cols: number;
  columns: ColumnSummary[];
}

export interface BuildContextOptions {
  compact?: boolean;
}

export function buildDataContext(
  frames: DataframeSummary[],
  { compact = false }: BuildContextOptions = {},
): string {
  if (frames.length === 0) return "";

  const maxDataframes = compact ? 8 : 20;
  const maxColumns = compact ? 25 : 50;
  const maxCategoricalVals = compact ? 12 : 80;
  const maxContextChars = compact ? 12_000 : 50_000;

  const blocks: string[] = [];

  for (const df of frames.slice(0, maxDataframes)) {
    const lines: string[] = [];
    for (const col of df.columns.slice(0, maxColumns)) {
      let line = `  - ${col.name} [${col.dtype}]`;
      if (col.numeric) {
        const { mean, median, sd, min, max, naCount } = col.numeric;
        const naTag = naCount > 0 ? ` NAs=${naCount}` : "";
        line += ` | mean=${fmt(mean)} median=${fmt(median)} sd=${fmt(sd)} min=${fmt(min)} max=${fmt(max)}${naTag}`;
      } else if (col.categorical) {
        const shown = col.categorical.counts.slice(0, maxCategoricalVals);
        const more = col.categorical.counts.length - shown.length;
        const countsStr = shown.map(([k, v]) => `${k}=${v}`).join(", ");
        line += ` | counts: ${countsStr}${more > 0 ? ` ... (+${more} more)` : ""}`;
      }
      lines.push(line);
    }
    if (df.columns.length > maxColumns) lines.push("  ... (more columns)");

    blocks.push(
      `Dataframe: ${df.name} (${df.rows} rows x ${df.cols} cols)\n${lines.join("\n")}`,
    );
  }
  if (frames.length > maxDataframes) blocks.push("... (more dataframes)");

  let context = [
    "--- USER R ENVIRONMENT CONTEXT ---",
    "Use exact dataframe and column names from this context.",
    blocks.join("\n\n"),
    "----------------------------------",
  ].join("\n");

  if (context.length > maxContextChars) {
    context = context.slice(0, maxContextChars) + "\n... (context truncated)";
  }
  return context;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toFixed(4);
}
