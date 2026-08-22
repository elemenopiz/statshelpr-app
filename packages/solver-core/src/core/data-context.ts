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
    q25?: number;
    q75?: number;
    iqr?: number;
    isBinary01?: boolean;
    discreteTag?: string;
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
  sampleRows?: Record<string, unknown>[];
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

  const dfBlocks: Array<{ name: string; block: string }> = [];

  for (const df of frames.slice(0, maxDataframes)) {
    const lines: string[] = [];
    for (const col of df.columns.slice(0, maxColumns)) {
      let line = `  - ${col.name} [${col.dtype}]`;
      if (col.numeric) {
        const { mean, median, sd, min, max, naCount, q25, q75, iqr, isBinary01, discreteTag } = col.numeric;
        const naTag = naCount > 0 ? ` NAs=${naCount}` : "";
        const tag = isBinary01
          ? ` (binary 0/1 indicator)`
          : discreteTag
            ? ` (${discreteTag})`
            : "";
        const iqrPart =
          q25 !== undefined && q75 !== undefined && iqr !== undefined
            ? ` [min=${fmt(min)}, Q1=${fmt(q25)}, median=${fmt(median)}, Q3=${fmt(q75)}, max=${fmt(max)}, IQR=${fmt(iqr)}]`
            : ` | mean=${fmt(mean)} median=${fmt(median)} sd=${fmt(sd)} min=${fmt(min)} max=${fmt(max)}`;
        line +=
          q25 !== undefined && q75 !== undefined
            ? ` | mean=${fmt(mean)} sd=${fmt(sd)}${iqrPart}${tag}${naTag}`
            : `${iqrPart}${tag}${naTag}`;
      } else if (col.categorical) {
        const shown = col.categorical.counts.slice(0, maxCategoricalVals);
        const more = col.categorical.counts.length - shown.length;
        const countsStr = shown.map(([k, v]) => `${k}=${v}`).join(", ");
        const sortedAlpha = [...col.categorical.counts].sort((a, b) => a[0].localeCompare(b[0]));
        const refLevel = sortedAlpha[0]?.[0];
        const refTag = refLevel !== undefined ? ` (R baseline ref: "${refLevel}")` : "";
        line += `${refTag} | counts: ${countsStr}${more > 0 ? ` ... (+${more} more)` : ""}`;
      }
      lines.push(line);
    }
    if (df.columns.length > maxColumns) lines.push("  ... (more columns)");

    let sampleBlock = "";
    if (df.sampleRows && df.sampleRows.length > 0) {
      const sampleLines = df.sampleRows.map((r, i) => `  row ${i + 1}: ${JSON.stringify(r)}`);
      sampleBlock = `\nSample rows (first ${df.sampleRows.length}):\n${sampleLines.join("\n")}`;
    }

    dfBlocks.push({
      name: df.name,
      block: `Dataframe: ${df.name} (${df.rows} rows x ${df.cols} cols)\n${lines.join("\n")}${sampleBlock}`,
    });
  }

  const droppedByCap = frames.length > maxDataframes ? frames.slice(maxDataframes).map((d) => d.name) : [];

  const HEADER = "--- USER R ENVIRONMENT CONTEXT ---\nUse exact dataframe and column names from this context.";
  const FOOTER = "----------------------------------";
  const budget = Math.max(0, maxContextChars - HEADER.length - FOOTER.length - 4);

  // Add whole dataframe blocks until the budget runs out, instead of joining
  // everything and cutting the tail of the combined string — a tail-cut can
  // land mid-block and silently drop later dataframes with no indication of
  // which ones went missing, so a question referencing the dropped data gets
  // answered against data the model was never shown.
  const includedBlocks: string[] = [];
  let used = 0;
  let cutoffIndex = dfBlocks.length;

  for (const [i, { name, block }] of dfBlocks.entries()) {
    const sepLen = includedBlocks.length > 0 ? 2 : 0;
    if (used + sepLen + block.length <= budget) {
      includedBlocks.push(block);
      used += sepLen + block.length;
      continue;
    }
    if (includedBlocks.length === 0) {
      // Even the first dataframe alone blows the budget — include a
      // truncated version of it rather than showing the model zero
      // dataframes.
      const room = Math.max(0, budget - used);
      includedBlocks.push(`${block.slice(0, room)}\n  ... (${name} truncated for space)`);
      cutoffIndex = i + 1;
    } else {
      cutoffIndex = i;
    }
    break;
  }

  const omittedNames = [...dfBlocks.slice(cutoffIndex).map((b) => b.name), ...droppedByCap];
  const omittedNote =
    omittedNames.length > 0
      ? `\n\n... (${omittedNames.length} dataframe(s) omitted for space: ${omittedNames.join(", ")})`
      : "";

  return [HEADER, includedBlocks.join("\n\n") + omittedNote, FOOTER].join("\n");
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toFixed(4);
}
