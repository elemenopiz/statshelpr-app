/**
 * chrome.storage.local persistence for captures + conversion to the eval
 * fixture format. Shared by the on-page panel (capture-content.ts) and the
 * popup dashboard (popup.ts).
 *
 * Captures are keyed by `Capture.id` (a stable hash of the normalized question
 * text) so re-capturing the same question updates its label in place rather
 * than creating a duplicate — fixing a mislabel is just capturing again.
 */

import { type ApiChoice, type Capture, type CaptureMode, type Fixture, type PoolItem } from "./types";
import { expandDataFiles } from "./datasets";

const KEY_CAPTURES = "statshelpr.captures";

// ---- captures ---------------------------------------------------------------

export async function getAllCaptures(): Promise<Capture[]> {
  const r = await chrome.storage.local.get(KEY_CAPTURES);
  const map = (r[KEY_CAPTURES] as Record<string, Capture> | undefined) ?? {};
  return Object.values(map).sort((a, b) => b.capturedAt - a.capturedAt);
}

/** Overwrite a capture by id (used by explicit popup edits like mode changes). */
export async function upsertCapture(capture: Capture): Promise<void> {
  const r = await chrome.storage.local.get(KEY_CAPTURES);
  const map = (r[KEY_CAPTURES] as Record<string, Capture> | undefined) ?? {};
  map[capture.id] = capture;
  await chrome.storage.local.set({ [KEY_CAPTURES]: map });
}

/** Capture-time upsert that never downgrades a verified answer. The same
 * question can recur across attempts (right one time, wrong another); we keep
 * the verified version rather than letting a later wrong attempt overwrite it. */
export async function mergeCapture(next: Capture): Promise<void> {
  const r = await chrome.storage.local.get(KEY_CAPTURES);
  const map = (r[KEY_CAPTURES] as Record<string, Capture> | undefined) ?? {};
  const prev = map[next.id];
  map[next.id] = prev ? mergePreferVerified(prev, next) : next;
  await chrome.storage.local.set({ [KEY_CAPTURES]: map });
}

function mergePreferVerified(prev: Capture, next: Capture): Capture {
  if (prev.verified && !next.verified) {
    return { ...prev, capturedAt: Math.max(prev.capturedAt, next.capturedAt) };
  }
  if (!prev.verified && next.verified) return next;
  return next.capturedAt >= prev.capturedAt ? next : prev;
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

export async function getCapture(id: string): Promise<Capture | undefined> {
  const r = await chrome.storage.local.get(KEY_CAPTURES);
  const map = (r[KEY_CAPTURES] as Record<string, Capture> | undefined) ?? {};
  return map[id];
}

export async function hasCapture(id: string): Promise<boolean> {
  const r = await chrome.storage.local.get(KEY_CAPTURES);
  const map = (r[KEY_CAPTURES] as Record<string, Capture> | undefined) ?? {};
  return Boolean(map[id]);
}

// ---- mode inference ---------------------------------------------------------

/**
 * Best-guess concept vs calc from the question, so nothing has to be toggled.
 * `calc` = the answer requires computing a statistic from data; `concept` =
 * reasoning/definition. Deliberately precision-biased toward calc only on a
 * clear computational cue (a numeric fill-in, or explicit "compute the mean /
 * regression / probability …" language), because a wrong mode makes run-evals
 * mark an otherwise-correct fixture as failed. The popup lets you fix the rare
 * miss per-item — it's the one label the DOM can't state outright.
 */
export function inferMode(text: string, choices: ApiChoice[]): CaptureMode {
  // A lone fill-in (numeric answer) is essentially always a calculation.
  if (choices.length === 1 && choices[0]?.type === "text") return "calc";
  const t = ` ${text.toLowerCase()} `;
  const calc =
    /(calculat|comput(e|ing|ation)|\bfind the\b|estimate the|what is the (value|probability|mean|median|average|proportion|percent|standard deviation)|how many|standard deviation|\bvariance\b|regression|slope|intercept|\bpredict|correlation|z-?score|confidence interval|margin of error|test statistic|p-?value|expected value|interquartile|\biqr\b|quartile|\bodds\b|\bproportion\b)/.test(
      t,
    );
  return calc ? "calc" : "concept";
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
  const expected: Fixture["expected"] = {
    mode: c.mode,
    selectedChoices: c.correctChoices,
  };
  // Fill-in / numerical answer → checked via answerContains (run-evals matches
  // the model's answer text against it), since there's no choice letter.
  if (c.answerText) expected.answerContains = [c.answerText];
  return {
    name: c.name,
    request,
    expected,
    meta: { answerSource: c.answerSource, outcome: c.outcome, url: c.url, capturedAt: c.capturedAt },
  };
}

/** A capture whose correct answer we trust — a correct choice, or a verified
 * fill-in value. */
function isSolved(c: Capture): boolean {
  return c.verified && (c.correctChoices.length > 0 || !!c.answerText);
}

export function verifiedOnly(captures: Capture[]): Capture[] {
  return captures.filter(isSolved);
}

/** Captures whose correct answer we never established — the "unsolved" set
 * (missed on every attempt, answers hidden). The AI-test dataset. */
export function unsolvedOnly(captures: Capture[]): Capture[] {
  return captures.filter((c) => !isSolved(c));
}

/** Pretty-printed JSON array of fixtures (verified captures only) — drop through
 * `scripts/import-captures.ts` to split into evals/solve-fixtures/*.json. */
export function toFixtureBundle(
  captures: Capture[],
  datasets: Record<string, string> = {},
  inline = true,
): string {
  return JSON.stringify(verifiedOnly(captures).map((c) => toFixture(c, datasets, inline)), null, 2);
}

/** One fixture per line (JSONL, verified only) — for training pipelines. */
export function toJsonl(
  captures: Capture[],
  datasets: Record<string, string> = {},
  inline = true,
): string {
  return verifiedOnly(captures).map((c) => JSON.stringify(toFixture(c, datasets, inline))).join("\n") + "\n";
}

/** The "unsolved" dataset — captures whose answer we never learned (missed on
 * every attempt, answers hidden), with the full question, images, dataset, the
 * student's wrong/unknown pick, and outcome. The held-out set to test the AI on
 * once it aces the verified fixtures. Complete question record, not the eval
 * fixture shape. */
export function toPoolBundle(
  captures: Capture[],
  datasets: Record<string, string> = {},
): string {
  const items: PoolItem[] = unsolvedOnly(captures).map((c) => {
    const item: PoolItem = {
      name: c.name,
      questionText: c.questionText,
      choices: c.choices,
      selectedChoices: c.selectedChoices,
      correctChoices: c.correctChoices,
      outcome: c.outcome,
      answerSource: c.answerSource,
      verified: c.verified,
      mode: c.mode,
      templateId: c.templateId,
      url: c.url,
      capturedAt: c.capturedAt,
    };
    if (c.answerText) item.answerText = c.answerText;
    if (c.courseId) item.courseId = c.courseId;
    if (c.quizId) item.quizId = c.quizId;
    if (c.images.length > 0) item.images = c.images;
    const dataFiles = expandDataFiles(c.datasetRefs, datasets, true);
    if (dataFiles.length > 0) item.dataFiles = dataFiles;
    return item;
  });
  return JSON.stringify(items, null, 2);
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
