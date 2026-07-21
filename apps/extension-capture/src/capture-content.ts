/**
 * Canvas content script — training-data capture (fully automatic).
 *
 * On a GRADED results/history page, Canvas renders the answer key inline. This
 * script detects it and **auto-captures every keyed question on the page with
 * zero clicks** — question text, choices, images, the referenced dataset, the
 * correct answer, and an inferred concept/calc mode, all without any toggles.
 * A floating panel (bottom-right) shows the running count and handles export.
 *
 * On a LIVE / ungraded quiz there is no answer key anywhere on the page, so
 * nothing can be auto-labeled; each question gets a manual pill instead —
 * select the correct choice(s), click it, and your selection is the label.
 *
 * Everything is local: no network (beyond fetching the question's own images /
 * packaged datasets), no API, no cost. Captures persist in chrome.storage.local
 * and export as fixtures matching evals/solve-fixtures/*.json.
 */

import {
  findQuestions,
  collectChoices,
  detectCorrectChoices,
  scrapeQuestion,
  selectedChoiceLabels,
  looksGraded,
  normalizeText,
  findStem,
} from "./scrape";
import {
  upsertCapture,
  hasCapture,
  getAllCaptures,
  clearCaptures,
  toFixtureBundle,
  toJsonl,
  downloadText,
  hashId,
  templateId,
  inferMode,
  fixtureName,
} from "./store";
import { loadDatasets, detectDatasetRefs } from "./datasets";
import type { Capture } from "./types";

const ATTR = "shcapAttached";
const pills = new Map<HTMLElement, HTMLButtonElement>();

// =============================================================================
// boot
// =============================================================================

function boot() {
  ensurePanel();
  scanAndInject();

  const observer = new MutationObserver((records) => {
    // Ignore our own panel/pill mutations to avoid a rescan feedback loop.
    if (records.every((r) => (r.target as HTMLElement).closest?.("#shcap-panel"))) return;
    scanAndInject();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["statshelpr.captures"]) {
      void refreshAllPillStates();
      void refreshPanel();
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

// =============================================================================
// scan → inject pills → auto-capture keyed questions
// =============================================================================

let pendingScan = false;
function scanAndInject() {
  if (pendingScan) return;
  pendingScan = true;
  setTimeout(() => {
    pendingScan = false;
    for (const q of findQuestions()) injectPill(q);
    void refreshPanel();
    void maybeAutoCapture();
  }, 120);
}

/** Auto-capture every answer-keyed question that hasn't been captured yet — the
 * whole point of the tool. Idempotent: each question is attempted once per page
 * (autoAttempted) and skipped if already stored (dedup). No-ops on ungraded
 * pages, where no question has a key. */
let autoCapturing = false;
const autoAttempted = new Set<string>();
async function maybeAutoCapture() {
  if (autoCapturing) return;
  autoCapturing = true;
  try {
    let n = 0;
    for (const q of findQuestions()) {
      if (!detectCorrectChoices(q, collectChoices(q)).hasKey) continue;
      const id = hashId(scrapeText(q));
      if (!id || autoAttempted.has(id)) continue;
      autoAttempted.add(id);
      if (await hasCapture(id)) continue;
      const pill = pills.get(q);
      if (pill && (await captureOne(q, pill))) n += 1;
    }
    if (n > 0) {
      setAutoStatus(`⚡ auto-captured ${n} — verify the answers`);
      await refreshPanel();
    }
  } finally {
    autoCapturing = false;
  }
}

function injectPill(question: HTMLElement) {
  if (question.dataset[ATTR] === "1") return;
  question.dataset[ATTR] = "1";

  const pill = el("button", { className: "shcap-pill", type: "button" });
  pill.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void captureOne(question, pill);
  });

  const bar = el("div", { className: "shcap-qbar" }, [pill]);
  question.insertBefore(bar, question.firstChild);
  pills.set(question, pill);

  void setPillState(question, pill);
}

/** Reflect the question's status on its pill: saved (green), keyed & about to
 * auto-capture, or awaiting a manual selection on an ungraded page. */
async function setPillState(question: HTMLElement, pill: HTMLButtonElement) {
  const { hasKey, labels } = detectCorrectChoices(question, collectChoices(question));
  const id = hashId(scrapeText(question));
  const saved = id ? await hasCapture(id) : false;

  pill.classList.toggle("shcap-has-key", hasKey);
  pill.classList.toggle("shcap-saved", saved);
  question.classList.toggle("shcap-captured", saved);

  if (saved) {
    pill.textContent = "✓ saved";
    pill.title = "Captured — click to re-capture / update the label";
  } else if (hasKey) {
    pill.textContent = `⬇ ${labels.join("")}`;
    pill.title = "Answer key detected — capturing automatically (click to force)";
  } else {
    pill.textContent = "⬇ capture";
    pill.title = looksGraded(question)
      ? "No key auto-detected — select the correct choice(s), then click"
      : "Live quiz: select the correct choice(s), then click to capture";
  }
}

async function refreshAllPillStates() {
  for (const [question, pill] of pills) {
    if (document.contains(question)) await setPillState(question, pill);
    else pills.delete(question);
  }
}

// =============================================================================
// capture — everything auto-detected (answer, images, dataset, mode)
// =============================================================================

async function captureOne(question: HTMLElement, pill: HTMLButtonElement): Promise<boolean> {
  pill.classList.add("shcap-busy");
  try {
    const scraped = await scrapeQuestion(question, { includeImages: true });
    const detected = detectCorrectChoices(question, scraped.raw);

    let correctChoices: string[];
    let source: Capture["source"];
    if (detected.hasKey) {
      correctChoices = detected.labels;
      source = "answer-key";
    } else {
      correctChoices = selectedChoiceLabels(scraped.raw);
      source = "manual";
      if (correctChoices.length === 0) {
        flashPill(pill, "select answer first", "shcap-warn");
        return false;
      }
    }

    const id = hashId(scraped.text);
    const kind = scraped.choices[0]?.type ?? "radio";
    const datasetRefs = detectDatasetRefs(scraped.text);
    const capture: Capture = {
      id,
      templateId: templateId(scraped.text),
      name: fixtureName(scraped.text, kind),
      questionText: scraped.text,
      choices: scraped.choices,
      images: scraped.images,
      correctChoices,
      datasetRefs,
      mode: inferMode(scraped.text, scraped.choices),
      source,
      url: location.href,
      ...idsFromUrl(),
      capturedAt: Date.now(),
    };
    await upsertCapture(capture);
    await setPillState(question, pill);
    flashPill(pill, datasetRefs.length ? `✓ +${datasetRefs[0]}` : "✓ saved", "shcap-saved");
    return true;
  } catch (e) {
    flashPill(pill, "! " + truncate((e as Error).message, 24), "shcap-err");
    return false;
  } finally {
    pill.classList.remove("shcap-busy");
  }
}

/** Manual re-trigger for the keyed questions on the page (auto-capture already
 * runs on load; this is here for after a Clear, or if the observer missed a
 * late-rendered question). */
async function captureAllKeyed(btn: HTMLButtonElement) {
  const questions = findQuestions().filter((q) => detectCorrectChoices(q, collectChoices(q)).hasKey);
  if (questions.length === 0) return;
  btn.disabled = true;
  let done = 0;
  for (const q of questions) {
    const pill = pills.get(q);
    if (pill && (await captureOne(q, pill))) done += 1;
    btn.textContent = `Capturing ${done}/${questions.length}…`;
  }
  btn.disabled = false;
  await refreshPanel();
}

// =============================================================================
// floating panel
// =============================================================================

function ensurePanel() {
  if (document.getElementById("shcap-panel")) return;

  const collapseBtn = el("button", { className: "shcap-collapse", type: "button", title: "Collapse", text: "–" });
  const head = el("div", { className: "shcap-head" }, [
    el("span", { className: "shcap-title" }, [document.createTextNode("statshelpr · "), el("b", { text: "capture" })]),
    collapseBtn,
  ]);

  const total = el("b", { id: "shcap-total", text: "0" });
  const breakdown = el("span", { className: "shcap-sub", id: "shcap-breakdown" });
  const stat = el("div", { className: "shcap-stat" }, [total, document.createTextNode(" captured "), breakdown]);
  const page = el("div", { className: "shcap-page", id: "shcap-page", text: "–" });
  const auto = el("div", { className: "shcap-auto", id: "shcap-auto" });
  auto.style.display = "none";

  const captureKeyed = el("button", {
    className: "shcap-btn shcap-primary",
    id: "shcap-capture-keyed",
    type: "button",
    text: "Capture keyed",
  });

  const exportJsonBtn = el("button", { className: "shcap-btn", id: "shcap-export-json", type: "button", text: "Export .json" });
  const exportJsonlBtn = el("button", { className: "shcap-btn", id: "shcap-export-jsonl", type: "button", text: ".jsonl" });
  const exportRow = el("div", { className: "shcap-row" }, [exportJsonBtn, exportJsonlBtn]);
  const clearBtn = el("button", { className: "shcap-btn shcap-quiet", id: "shcap-clear", type: "button", text: "Clear all" });

  const body = el("div", { className: "shcap-body" }, [stat, page, auto, captureKeyed, exportRow, clearBtn]);
  const panel = el("div", { id: "shcap-panel" }, [head, body]);
  document.body.appendChild(panel);

  collapseBtn.addEventListener("click", () => panel.classList.toggle("shcap-collapsed"));
  head.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".shcap-collapse")) return;
    if (panel.classList.contains("shcap-collapsed")) panel.classList.remove("shcap-collapsed");
  });
  captureKeyed.addEventListener("click", (e) => void captureAllKeyed(e.currentTarget as HTMLButtonElement));
  exportJsonBtn.addEventListener("click", () => void exportBundle("json"));
  exportJsonlBtn.addEventListener("click", () => void exportBundle("jsonl"));
  clearBtn.addEventListener("click", () => void clearAll());
}

function setAutoStatus(msg: string) {
  const el = document.getElementById("shcap-auto");
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? "block" : "none";
}

async function refreshPanel() {
  const captures = await getAllCaptures();
  const total = document.getElementById("shcap-total");
  const breakdown = document.getElementById("shcap-breakdown");
  const page = document.getElementById("shcap-page");
  const keyedBtn = document.getElementById("shcap-capture-keyed") as HTMLButtonElement | null;
  if (!total || !breakdown || !page || !keyedBtn) return;

  total.textContent = String(captures.length);
  const keyed = captures.filter((c) => c.source === "answer-key").length;
  const templates = new Set(captures.map((c) => c.templateId)).size;
  const variants = captures.length - templates;
  breakdown.textContent = captures.length
    ? `· ${keyed} keyed · ${templates} unique${variants ? ` · ${variants} variant${variants === 1 ? "" : "s"}` : ""}`
    : "";

  const onPage = findQuestions();
  const withKey = onPage.filter((q) => detectCorrectChoices(q, collectChoices(q)).hasKey).length;
  page.textContent = withKey
    ? `This page: ${onPage.length} question${onPage.length === 1 ? "" : "s"}, ${withKey} auto-captured`
    : `This page: ${onPage.length} question${onPage.length === 1 ? "" : "s"}, no answer key (manual)`;
  keyedBtn.textContent = withKey ? `Re-capture keyed (${withKey})` : "No answer key on page";
  keyedBtn.disabled = withKey === 0;
}

async function exportBundle(kind: "json" | "jsonl") {
  const captures = await getAllCaptures();
  if (captures.length === 0) return;
  const datasets = await loadDatasets();
  if (kind === "json") {
    downloadText(`statshelpr-fixtures-${stamp()}.json`, toFixtureBundle(captures, datasets, true));
  } else {
    downloadText(`statshelpr-fixtures-${stamp()}.jsonl`, toJsonl(captures, datasets, true));
  }
}

async function clearAll() {
  const captures = await getAllCaptures();
  if (captures.length === 0) return;
  if (!confirm(`Delete all ${captures.length} captured questions? Export first if you want to keep them.`)) {
    return;
  }
  await clearCaptures();
  autoAttempted.clear();
  setAutoStatus("");
  await refreshAllPillStates();
  await refreshPanel();
}

// =============================================================================
// helpers
// =============================================================================

/** Question stem text (sync) for id hashing / dedupe checks. */
function scrapeText(question: HTMLElement): string {
  const stem = findStem(question);
  return normalizeText(stem?.innerText ?? stem?.textContent ?? "");
}

function idsFromUrl(): { courseId?: string; quizId?: string } {
  const course = location.pathname.match(/\/courses\/(\d+)/)?.[1];
  const quiz = location.pathname.match(/\/quizzes\/(\d+)/)?.[1];
  const out: { courseId?: string; quizId?: string } = {};
  if (course) out.courseId = course;
  if (quiz) out.quizId = quiz;
  return out;
}

function flashPill(pill: HTMLButtonElement, text: string, cls: string) {
  const prev = pill.textContent;
  pill.classList.add(cls);
  pill.textContent = text;
  setTimeout(() => {
    pill.classList.remove(cls);
    if (pill.textContent === text) pill.textContent = prev;
  }, 1600);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ---- tiny DOM builder -------------------------------------------------------

interface ElProps {
  className?: string;
  id?: string;
  text?: string;
  title?: string;
  type?: string;
  value?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.id) node.id = props.id;
  if (props.title) node.title = props.title;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.type && "type" in node) (node as HTMLInputElement).type = props.type;
  if (props.value !== undefined && "value" in node) (node as HTMLInputElement).value = props.value;
  for (const c of children) node.appendChild(c);
  return node;
}
