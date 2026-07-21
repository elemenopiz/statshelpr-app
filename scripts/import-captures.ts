/**
 * Split a capture bundle exported by the Data Capture extension ("Export all")
 * into two dirs:
 *   - evals/solve-fixtures/  — VERIFIED questions (answer known), in the shape
 *     scripts/run-evals.ts consumes.
 *   - evals/unsolved/        — the rest (answer unknown): the held-out AI-test
 *     set, kept as the full capture record.
 *
 * Verified records reference datasets by name; their CSV content is pulled from
 * apps/extension-capture/datasets/ (override with --datasets) and inlined into
 * the fixture so run-evals can run it.
 *
 * Usage:
 *   tsx scripts/import-captures.ts <bundle.json|.jsonl> [--fixtures <dir>] [--unsolved <dir>] [--datasets <dir>] [--strip-meta]
 *
 * Filenames are a stable slug + short hash of the question text, so re-importing
 * an updated bundle overwrites the same files instead of piling up duplicates.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import * as path from "node:path";

interface CaptureRecord {
  name: string;
  questionText: string;
  choices?: unknown[];
  images?: unknown[];
  datasetRefs?: string[];
  selectedChoices?: string[];
  correctChoices?: string[];
  answerText?: string;
  outcome?: string;
  answerSource?: string;
  verified?: boolean;
  mode?: string;
  url?: string;
  capturedAt?: number;
  // legacy fixture-shaped records
  request?: { questionText?: string };
  expected?: { mode?: string; selectedChoices?: string[] };
}

async function main() {
  const args = process.argv.slice(2);
  const bundlePath = args.find((a) => !a.startsWith("--"));
  if (!bundlePath) {
    console.error("usage: tsx scripts/import-captures.ts <bundle.json|.jsonl> [--fixtures <dir>] [--unsolved <dir>] [--strip-meta]");
    process.exitCode = 1;
    return;
  }
  const stripMeta = args.includes("--strip-meta");
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const fixturesDir = argDir(args, "--fixtures") ?? path.resolve(repoRoot, "evals/solve-fixtures");
  const unsolvedDir = argDir(args, "--unsolved") ?? path.resolve(repoRoot, "evals/unsolved");
  const datasetsDir = argDir(args, "--datasets") ?? path.resolve(repoRoot, "apps/extension-capture/datasets");
  const datasets = await loadDatasets(datasetsDir);

  const raw = await readFile(path.resolve(process.cwd(), bundlePath), "utf8");
  const records = parseBundle(raw, bundlePath);
  if (records.length === 0) {
    console.error(`No records found in ${bundlePath}`);
    process.exitCode = 1;
    return;
  }

  await mkdir(fixturesDir, { recursive: true });
  await mkdir(unsolvedDir, { recursive: true });
  const usedSlugs = new Set<string>();
  const missingDatasets = new Set<string>();
  let fixtures = 0;
  let unsolved = 0;
  let skipped = 0;

  for (const rec of records) {
    const q = questionOf(rec);
    if (!q) {
      skipped += 1;
      continue;
    }
    let slug = fixtureSlug(q);
    while (usedSlugs.has(slug)) slug = `${slug}-x`;
    usedSlugs.add(slug);

    if (isVerified(rec)) {
      const fixture = toFixture(rec, datasets, missingDatasets);
      if (stripMeta) delete (fixture as { meta?: unknown }).meta;
      await writeFile(path.join(fixturesDir, `${slug}.json`), JSON.stringify(fixture, null, 2) + "\n", "utf8");
      fixtures += 1;
    } else {
      await writeFile(path.join(unsolvedDir, `${slug}.json`), JSON.stringify(rec, null, 2) + "\n", "utf8");
      unsolved += 1;
    }
  }

  console.log(`Wrote ${fixtures} → ${rel(fixturesDir)} · ${unsolved} → ${rel(unsolvedDir)}${skipped ? ` · ${skipped} skipped` : ""}`);
  if (missingDatasets.size > 0) {
    console.warn(`⚠ dataset(s) not found in ${rel(datasetsDir)} (fixture written without them): ${[...missingDatasets].join(", ")}`);
    console.warn(`  regenerate with: pnpm --filter @statshelpr/extension-capture datasets <file.RData>`);
  }
  function rel(p: string) {
    return path.relative(process.cwd(), p);
  }
}

/** Load datasets/<name>.csv into a { filename: content } map (empty if absent). */
async function loadDatasets(dir: string): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (name.endsWith(".csv")) map[name] = await readFile(path.join(dir, name), "utf8");
  }
  return map;
}

/** Case-insensitive filename → canonical dataset key. */
function matchDataset(ref: string, datasets: Record<string, string>): string | null {
  if (datasets[ref] !== undefined) return ref;
  const lower = ref.toLowerCase();
  for (const k of Object.keys(datasets)) if (k.toLowerCase() === lower) return k;
  return null;
}

/** A record we trust the answer for → an eval fixture. */
function isVerified(r: CaptureRecord): boolean {
  if (r.expected) return true; // legacy fixture-shaped record
  return r.verified === true && ((r.correctChoices?.length ?? 0) > 0 || !!r.answerText);
}

function questionOf(r: CaptureRecord): string {
  return r.questionText || r.request?.questionText || r.name || "";
}

/** Convert a capture record to the fixture shape run-evals.ts runs, inlining
 * referenced dataset CSVs from `datasets` (run-evals needs the content). */
function toFixture(r: CaptureRecord, datasets: Record<string, string>, missing: Set<string>): unknown {
  if (r.expected && r.request) return r; // already a fixture
  const request: Record<string, unknown> = { questionText: r.questionText, choices: r.choices ?? [] };
  if (r.images?.length) request.images = r.images;
  const dataFiles: Array<{ filename: string; content: string }> = [];
  for (const ref of r.datasetRefs ?? []) {
    const key = matchDataset(ref, datasets);
    if (key) dataFiles.push({ filename: key, content: datasets[key]! });
    else missing.add(ref);
  }
  if (dataFiles.length) request.dataFiles = dataFiles;
  const expected: Record<string, unknown> = {
    mode: r.mode === "calc" ? "calc" : "concept",
    selectedChoices: r.correctChoices ?? [],
  };
  if (r.answerText) expected.answerContains = [r.answerText];
  return {
    name: r.name,
    request,
    expected,
    meta: { answerSource: r.answerSource, outcome: r.outcome, url: r.url, capturedAt: r.capturedAt },
  };
}

function argDir(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? path.resolve(process.cwd(), args[i + 1]!) : null;
}

function parseBundle(raw: string, file: string): CaptureRecord[] {
  if (file.endsWith(".jsonl")) {
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as CaptureRecord);
  }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as CaptureRecord[]) : [parsed as CaptureRecord];
}

/** Mirror of the extension's store.fixtureSlug so filenames stay stable. */
function fixtureSlug(questionText: string): string {
  const id = hashId(questionText.replace(/\s+/g, " ").trim());
  const base = questionText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 7)
    .join("-");
  return `${base || "question"}-${id}`;
}

function hashId(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
