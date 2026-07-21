/**
 * Split a capture bundle exported by the Data Capture extension into individual
 * fixture files under evals/solve-fixtures/, ready for scripts/run-evals.ts.
 *
 * Usage:
 *   tsx scripts/import-captures.ts <bundle.json | bundle.jsonl> [--out <dir>] [--strip-meta]
 *
 * The bundle is either a JSON array of fixtures (.json) or one fixture per line
 * (.jsonl) — both are what the extension's Export buttons produce. Filenames are
 * a stable slug + short hash of the question text, so re-importing an updated
 * bundle overwrites the same files instead of piling up duplicates.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import * as path from "node:path";

interface Fixture {
  name: string;
  request: { questionText?: string; choices?: unknown[]; images?: unknown[] };
  expected: { mode: string; selectedChoices: string[]; answerContains?: string[] };
  meta?: unknown;
}

async function main() {
  const args = process.argv.slice(2);
  const bundlePath = args.find((a) => !a.startsWith("--"));
  if (!bundlePath) {
    console.error("usage: tsx scripts/import-captures.ts <bundle.json|.jsonl> [--out <dir>] [--strip-meta]");
    process.exitCode = 1;
    return;
  }
  const stripMeta = args.includes("--strip-meta");
  const outIdx = args.indexOf("--out");
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const outDir =
    outIdx >= 0 && args[outIdx + 1]
      ? path.resolve(process.cwd(), args[outIdx + 1]!)
      : path.resolve(repoRoot, "evals/solve-fixtures");

  const raw = await readFile(path.resolve(process.cwd(), bundlePath), "utf8");
  const fixtures = parseBundle(raw, bundlePath);
  if (fixtures.length === 0) {
    console.error(`No fixtures found in ${bundlePath}`);
    process.exitCode = 1;
    return;
  }

  await mkdir(outDir, { recursive: true });
  const existing = new Set(await readdir(outDir).catch(() => [] as string[]));

  let written = 0;
  let overwritten = 0;
  const usedSlugs = new Set<string>();
  for (const fixture of fixtures) {
    if (!isValid(fixture)) {
      console.warn(`skip (invalid): ${fixture?.name ?? "<unnamed>"}`);
      continue;
    }
    if (stripMeta) delete fixture.meta;
    const q = fixture.request.questionText ?? fixture.name;
    let slug = fixtureSlug(q);
    // Guard against two different questions colliding on the same slug.
    while (usedSlugs.has(slug)) slug = `${slug}-x`;
    usedSlugs.add(slug);
    const file = `${slug}.json`;
    if (existing.has(file)) overwritten += 1;
    await writeFile(path.join(outDir, file), JSON.stringify(fixture, null, 2) + "\n", "utf8");
    written += 1;
  }

  console.log(`Wrote ${written} fixtures → ${path.relative(process.cwd(), outDir)}${overwritten ? ` (${overwritten} overwritten)` : ""}`);
}

function parseBundle(raw: string, file: string): Fixture[] {
  if (file.endsWith(".jsonl")) {
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Fixture);
  }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as Fixture[]) : [parsed as Fixture];
}

function isValid(f: Fixture | undefined): f is Fixture {
  return Boolean(
    f &&
      typeof f.name === "string" &&
      f.request &&
      f.expected &&
      (f.expected.mode === "concept" || f.expected.mode === "calc") &&
      Array.isArray(f.expected.selectedChoices),
  );
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
