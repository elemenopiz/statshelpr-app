/**
 * Access to the course datasets packaged with the extension.
 *
 * `scripts/convert-rdata.mjs` turns an R `.RData` (e.g. KCdata_1-22.RData) into
 * datasets/<name>.csv, and the build bakes those into dist/datasets.json — a
 * { "scooby.csv": "<csv text>", … } map served as a web-accessible resource.
 * Questions cite datasets by filename ("the data frame in scooby.csv"), so we
 * detect those references at capture time and inline the matching CSV into the
 * exported fixture's dataFiles (the runnable shape /api/solve expects).
 *
 * The 1.7 MB map is fetched lazily (only on export), so the content script that
 * injects on every Canvas page stays small.
 */

let cache: Record<string, string> | null = null;

export async function loadDatasets(): Promise<Record<string, string>> {
  if (cache) return cache;
  try {
    const res = await fetch(chrome.runtime.getURL("datasets.json"));
    cache = res.ok ? ((await res.json()) as Record<string, string>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** Filenames a question references, e.g. ["scooby.csv"]. Deduped, case kept. */
export function detectDatasetRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Za-z0-9_.\-]+\.csv)\b/g)) out.add(m[1]!);
  return [...out];
}

/** Expand stored filename refs into fixture dataFiles. Unknown datasets (not in
 * the packaged map) are dropped. `inline: false` keeps the filename but empty
 * content, for lean exports. */
export function expandDataFiles(
  refs: string[],
  datasets: Record<string, string>,
  inline: boolean,
): Array<{ filename: string; content: string }> {
  const out: Array<{ filename: string; content: string }> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = matchKey(ref, datasets);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ filename: key, content: inline ? (datasets[key] ?? "") : "" });
  }
  return out;
}

/** Case-insensitive filename → canonical dataset key (e.g. "cps85.csv" → "CPS85.csv"). */
export function matchKey(ref: string, datasets: Record<string, string>): string | null {
  if (datasets[ref] !== undefined) return ref;
  const lower = ref.toLowerCase();
  for (const k of Object.keys(datasets)) if (k.toLowerCase() === lower) return k;
  return null;
}
