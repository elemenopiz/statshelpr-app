/**
 * chrome.storage.local persistence for captures + conversion to the eval
 * fixture format. Shared by the on-page panel (capture-content.ts) and the
 * popup dashboard (popup.ts).
 *
 * Captures are keyed by `Capture.id` (a stable hash of the normalized question
 * text) so re-capturing the same question updates its label in place rather
 * than creating a duplicate — fixing a mislabel is just capturing again.
 */

import {
  DEFAULT_SETTINGS,
  type Capture,
  type CaptureSettings,
  type Fixture,
} from "./types";
import { expandDataFiles } from "./datasets";

const KEY_CAPTURES = "statshelpr.captures";
const KEY_SETTINGS = "statshelpr.captureSettings";

// ---- captures ---------------------------------------------------------------

export async function getAllCaptures(): Promise<Capture[]> {
  const r = await chrome.storage.local.get(KEY_CAPTURES);
  const map = (r[KEY_CAPTURES] as Record<string, Capture> | undefined) ?? {};
  return Object.values(map).sort((a, b) => b.capturedAt - a.capturedAt);
}

export async function upsertCapture(capture: Capture): Promise<void> {
  const r = await chrome.storage.local.get(KEY_CAPTURES);
  const map = (r[KEY_CAPTURES] as Record<string, Capture> | undefined) ?? {};
  map[capture.id] = capture;
  await chrome.storage.local.set({ [KEY_CAPTURES]: map });
}

export async function removeCapture(id: string): Promise<void> {
  const r = await chrome.storage.local.get(KEY_CAPTURES);
  const map = (r[KEY_CAPTURES] as Record<string, Capture> | undefined) ?? {};
  delete map[id];
  await chrome.storage.local.set({ [KEY_CAPTURES]: map });
}

export async function clearCaptures(): Promise<void> {
  await chrome.storage.local.set({ [KEY_CAPTURES]: {} });
}

/** Keep only the most recent capture per templateId, dropping near-duplicate
 * variants (same question, different numbers). Returns how many were removed. */
export async function dedupeTemplates(): Promise<number> {
  const r = await chrome.storage.local.get(KEY_CAPTURES);
  const map = (r[KEY_CAPTURES] as Record<string, Capture> | undefined) ?? {};
  const newestPerTemplate = new Map<string, Capture>();
  for (const c of Object.values(map)) {
    const prev = newestPerTemplate.get(c.templateId);
    if (!prev || c.capturedAt > prev.capturedAt) newestPerTemplate.set(c.templateId, c);
  }
  const keep = new Set([...newestPerTemplate.values()].map((c) => c.id));
  const next: Record<string, Capture> = {};
  let removed = 0;
  for (const c of Object.values(map)) {
    if (keep.has(c.id)) next[c.id] = c;
    else removed += 1;
  }
  if (removed > 0) await chrome.storage.local.set({ [KEY_CAPTURES]: next });
  return removed;
}

export async function hasCapture(id: string): Promise<boolean> {
  const r = await chrome.storage.local.get(KEY_CAPTURES);
  const map = (r[KEY_CAPTURES] as Record<string, Capture> | undefined) ?? {};
  return Boolean(map[id]);
}

// ---- settings ---------------------------------------------------------------

export async function getSettings(): Promise<CaptureSettings> {
  const r = await chrome.storage.local.get(KEY_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(r[KEY_SETTINGS] as Partial<CaptureSettings> | undefined) };
}

export async function saveSettings(patch: Partial<CaptureSettings>): Promise<CaptureSettings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY_SETTINGS]: next });
  return next;
}

// ---- fixture conversion + export -------------------------------------------

/** Convert a capture to the exact fixture shape run-evals.ts consumes.
 * `datasets` is the packaged CSV map (from loadDatasets); referenced datasets
 * are expanded into request.dataFiles, inlined unless `inline` is false. */
export function toFixture(
  c: Capture,
  datasets: Record<string, string> = {},
  inline = true,
): Fixture {
  const request: Fixture["request"] = {
    questionText: c.questionText,
    choices: c.choices,
  };
  if (c.images.length > 0) request.images = c.images;
  const dataFiles = expandDataFiles(c.datasetRefs, datasets, inline);
  if (dataFiles.length > 0) request.dataFiles = dataFiles;
  return {
    name: c.name,
    request,
    expected: {
      mode: c.mode,
      selectedChoices: c.correctChoices,
    },
    meta: { source: c.source, url: c.url, capturedAt: c.capturedAt },
  };
}

/** Pretty-printed JSON array of fixtures — drop through
 * `scripts/import-captures.ts` to split into evals/solve-fixtures/*.json. */
export function toFixtureBundle(
  captures: Capture[],
  datasets: Record<string, string> = {},
  inline = true,
): string {
  return JSON.stringify(captures.map((c) => toFixture(c, datasets, inline)), null, 2);
}

/** One fixture per line (JSONL) — convenient for training pipelines. */
export function toJsonl(
  captures: Capture[],
  datasets: Record<string, string> = {},
  inline = true,
): string {
  return captures.map((c) => JSON.stringify(toFixture(c, datasets, inline))).join("\n") + "\n";
}

/** Trigger a browser download of `text`. Works from both the popup (extension
 * page) and the on-page panel (content script) — both run inside the same
 * renderer, and the call sites are user-gesture initiated. */
export function downloadText(filename: string, text: string, mime = "application/json"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

// ---- capture construction ---------------------------------------------------

/** djb2 hash → base36. Deterministic id from normalized question text so the
 * same question de-dupes across captures/sessions. */
export function hashId(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Template id: hash of the question text with numbers blanked and punctuation
 * dropped, so "P(X)=0.3…" and "P(X)=0.5…" (same question, reshuffled numbers)
 * share an id. Used to spot and prune near-duplicate variants across attempts. */
export function templateId(text: string): string {
  const norm = text
    .toLowerCase()
    .replace(/\d+(?:[.,]\d+)?/g, "#")
    .replace(/[^a-z#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return hashId(norm);
}

/** Short, human/​filename-friendly name for a fixture. */
export function fixtureName(questionText: string, kind: string): string {
  const words = questionText.replace(/\s+/g, " ").trim().split(" ").slice(0, 9).join(" ");
  const snippet = words.length < questionText.length ? `${words}…` : words;
  return `${kind}: ${snippet}`;
}

/** kebab slug + short hash → stable, unique fixture filename. */
export function fixtureSlug(id: string, questionText: string): string {
  const base = questionText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 7)
    .join("-");
  return `${base || "question"}-${id}`;
}
