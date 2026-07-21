/**
 * Canvas content script — training-data capture (automatic).
 *
 * On a GRADED submission/review page, opening the page auto-captures **every**
 * question with zero clicks and buckets each by what we can verify:
 *   - Canvas shows the key, or the question is marked full-marks (so your own
 *     pick is the correct answer) → VERIFIED → goes in the eval fixtures.
 *   - You missed it and answers are hidden → UNVERIFIED → question + your pick
 *     kept for the separate "question pool" export, correct answer unknown.
 * Re-capturing across attempts never downgrades a verified answer.
 *
 * On a LIVE quiz (editable inputs, no key) each question gets a manual pill:
 * select the correct choice(s), click, your selection is the label.
 *
 * Local only. Persists in chrome.storage.local; exports fixtures + pool.
 */

import {
  findQuestions,
  collectChoices,
  scrapeQuestion,
  readGradedAnswer,
  readMultiDropdown,
  collectBlanks,
  isReadOnly,
  selectedChoiceLabels,
  looksGraded,
  normalizeText,
  findStem,
  type AnswerReadout,
} from "./scrape";
import {
  mergeCapture,
  hasCapture,
  getCapture,
  getAllCaptures,
  clearCaptures,
  toDatasetBundle,
  downloadText,
  hashId,
  templateId,
  inferMode,
  fixtureName,
} from "./store";
import { detectDatasetRefs } from "./datasets";
import type { Capture } from "./types";

const ATTR = "shcapAttached";
const pills = new Map<HTMLElement, HTMLButtonElement>();

// =============================================================================
// boot
// =============================================================================

function boot() {
  scanAndInject();

  const observer = new MutationObserver((records) => {
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
// scan → inject pills → auto-capture (only in a frame that has questions)
// =============================================================================

let pendingScan = false;
function scanAndInject() {
  if (pendingScan) return;
  pendingScan = true;
  setTimeout(() => {
    pendingScan = false;
    const questions = findQuestions();
    if (questions.length === 0) return; // no panel/pills in question-less frames
    ensurePanel();
    for (const q of questions) injectPill(q);
    void refreshPanel();
    void maybeAutoCapture();
  }, 150);
}

/** Auto-capture every question on a graded page (verified + pool). Idempotent:
 * attempted once per page load, and already-verified questions are skipped. */
let autoCapturing = false;
const autoAttempted = new Set<string>();
async function maybeAutoCapture() {
  if (autoCapturing) return;
  autoCapturing = true;
  try {
    let captured = 0;
    let verified = 0;
    for (const q of findQuestions()) {
      if (!isGradedQuestion(q)) continue;
      const id = hashId(scrapeText(q));
      if (!id || autoAttempted.has(id)) continue;
      autoAttempted.add(id);
      const existing = await getCapture(id);
      if (existing?.verified) continue; // already have a trusted answer
      const pill = pills.get(q);
      if (!pill) continue;
      const res = await captureOne(q, pill);
      if (res) {
        captured += 1;
        if (res.verified) verified += 1;
      }
    }
    if (captured > 0) {
      setAutoStatus(`⚡ auto-captured ${captured} (${verified} verified)`);
      await refreshPanel();
    }
  } finally {
    autoCapturing = false;
  }
}

/** A graded, read-only question we can auto-harvest (vs a live editable quiz). */
function isGradedQuestion(q: HTMLElement): boolean {
  return looksGraded(q) || isReadOnly(collectChoices(q)) || collectBlanks(q).some((b) => b.disabled);
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

async function setPillState(question: HTMLElement, pill: HTMLButtonElement) {
  const raw = collectChoices(question);
  const id = hashId(scrapeText(question));
  const saved = id ? await hasCapture(id) : false;
  question.classList.toggle("shcap-captured", saved);
  pill.classList.remove("shcap-has-key", "shcap-saved", "shcap-warn");

  if (saved) {
    const c = id ? await getCapture(id) : undefined;
    pill.classList.add(c?.verified ? "shcap-saved" : "shcap-warn");
    pill.textContent = c?.verified ? `✓ ${answerDisplay(c) || "saved"}` : "✓ pool";
    pill.title = c?.verified ? "Captured (verified)" : "Captured to pool (answer unverified)";
    return;
  }
  const blanks = collectBlanks(question);
  if (blanks.length >= 2) {
    const a = readMultiDropdown(question, blanks);
    pill.classList.toggle("shcap-has-key", a.verified);
    pill.textContent = a.verified ? `⬇ ${blanks.length} blanks` : "⬇ pool";
    pill.title = a.verified
      ? "Matching — will capture every blank's answer"
      : "Matching — captured to the pool (answers unverified)";
  } else if (isReadOnly(raw)) {
    const a = readGradedAnswer(question, raw);
    pill.classList.toggle("shcap-has-key", a.verified);
    pill.textContent = a.verified ? `⬇ ${answerDisplay(a) || "saved"}` : "⬇ pool";
    pill.title = a.verified
      ? "Full-marks / keyed — will capture the correct answer"
      : `Answers hidden & ${a.outcome} — captured to the pool (answer unknown)`;
  } else {
    pill.textContent = "⬇ capture";
    pill.title = "Live quiz: select the correct choice(s), then click";
  }
}

async function refreshAllPillStates() {
  for (const [question, pill] of pills) {
    if (document.contains(question)) await setPillState(question, pill);
    else pills.delete(question);
  }
}

// =============================================================================
// capture
// =============================================================================

async function captureOne(question: HTMLElement, pill: HTMLButtonElement): Promise<AnswerReadout | null> {
  pill.classList.add("shcap-busy");
  try {
    const scraped = await scrapeQuestion(question, { includeImages: true });

    let readout: AnswerReadout;
    if (scraped.blanks.length >= 2) {
      // matching / multiple-dropdowns. On a live quiz, require at least one
      // answered before capturing (don't store an empty record).
      const live = scraped.blanks.some((b) => !b.disabled);
      if (live && !scraped.blanks.some((b) => b.selected)) {
        flashPill(pill, "answer first", "shcap-warn");
        return null;
      }
      readout = readMultiDropdown(question, scraped.blanks);
    } else if (isReadOnly(scraped.raw)) {
      readout = readGradedAnswer(question, scraped.raw); // graded review
    } else {
      // live quiz — the user asserts the answer by selecting / entering it
      const fill = scraped.raw.find((c) => c.kind === "text-fill");
      if (fill) {
        const value = ((fill.input as HTMLInputElement).value ?? "").trim();
        if (!value) {
          flashPill(pill, "enter answer first", "shcap-warn");
          return null;
        }
        readout = { selectedChoices: [], correctChoices: [], answerText: value, outcome: "correct", answerSource: "manual", verified: true };
      } else {
        const selected = selectedChoiceLabels(scraped.raw);
        if (selected.length === 0) {
          flashPill(pill, "select answer first", "shcap-warn");
          return null;
        }
        readout = { selectedChoices: selected, correctChoices: selected, outcome: "correct", answerSource: "manual", verified: true };
      }
    }

    const scrapedText = scraped.text;
    const kind = scraped.choices[0]?.type ?? "radio";
    const capture: Capture = {
      id: hashId(scrapedText),
      templateId: templateId(scrapedText),
      name: fixtureName(scrapedText, kind),
      questionText: scrapedText,
      choices: scraped.choices,
      images: scraped.images,
      selectedChoices: readout.selectedChoices,
      correctChoices: readout.correctChoices,
      ...(readout.answerText ? { answerText: readout.answerText } : {}),
      ...(readout.blanks ? { blanks: readout.blanks } : {}),
      outcome: readout.outcome,
      answerSource: readout.answerSource,
      verified: readout.verified,
      datasetRefs: detectDatasetRefs(scrapedText),
      mode: inferMode(scrapedText, scraped.choices),
      url: location.href,
      ...idsFromUrl(),
      capturedAt: Date.now(),
    };
    await mergeCapture(capture);
    await setPillState(question, pill);
    flashPill(
      pill,
      readout.verified ? `✓ ${answerDisplay(readout) || "saved"}` : "✓ pool",
      readout.verified ? "shcap-saved" : "shcap-warn",
    );
    return readout;
  } catch (e) {
    flashPill(pill, "! " + truncate((e as Error).message, 22), "shcap-err");
    return null;
  } finally {
    pill.classList.remove("shcap-busy");
  }
}

/** Manual re-trigger: capture every graded question on the page (after a Clear,
 * or if the observer missed a late-rendered one). */
async function captureAllGraded(btn: HTMLButtonElement) {
  const questions = findQuestions().filter(isGradedQuestion);
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

  const captureBtn = el("button", {
    className: "shcap-btn shcap-primary",
    id: "shcap-capture-all",
    type: "button",
    text: "Capture page",
  });

  const exportBtn = el("button", { className: "shcap-btn", id: "shcap-export", type: "button", text: "Export all" });
  const clearBtn = el("button", { className: "shcap-btn shcap-quiet", id: "shcap-clear", type: "button", text: "Clear all" });

  const body = el("div", { className: "shcap-body" }, [stat, page, auto, captureBtn, exportBtn, clearBtn]);
  const panel = el("div", { id: "shcap-panel" }, [head, body]);
  document.body.appendChild(panel);

  collapseBtn.addEventListener("click", () => panel.classList.toggle("shcap-collapsed"));
  head.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".shcap-collapse")) return;
    if (panel.classList.contains("shcap-collapsed")) panel.classList.remove("shcap-collapsed");
  });
  captureBtn.addEventListener("click", (e) => void captureAllGraded(e.currentTarget as HTMLButtonElement));
  exportBtn.addEventListener("click", () => void exportAll());
  clearBtn.addEventListener("click", () => void clearAll());
}

function setAutoStatus(msg: string) {
  const node = document.getElementById("shcap-auto");
  if (!node) return;
  node.textContent = msg;
  node.style.display = msg ? "block" : "none";
}

async function refreshPanel() {
  const captures = await getAllCaptures();
  const total = document.getElementById("shcap-total");
  const breakdown = document.getElementById("shcap-breakdown");
  const page = document.getElementById("shcap-page");
  const captureBtn = document.getElementById("shcap-capture-all") as HTMLButtonElement | null;
  if (!total || !breakdown || !page || !captureBtn) return;

  total.textContent = String(captures.length);
  const verified = captures.filter((c) => c.verified).length;
  const unsolved = captures.length - verified;
  const templates = new Set(captures.map((c) => c.templateId)).size;
  breakdown.textContent = captures.length
    ? `· ${verified} verified · ${unsolved} unsolved · ${templates} unique`
    : "";

  const onPage = findQuestions();
  const graded = onPage.filter(isGradedQuestion).length;
  page.textContent = graded
    ? `This page: ${onPage.length} question${onPage.length === 1 ? "" : "s"}, auto-captured`
    : `This page: ${onPage.length} question${onPage.length === 1 ? "" : "s"}, live (manual)`;
  captureBtn.textContent = graded ? `Re-capture page (${graded})` : "Capture page";
}

async function exportAll() {
  const captures = await getAllCaptures();
  if (captures.length === 0) return;
  downloadText(`statshelpr-captures-${stamp()}.json`, toDatasetBundle(captures));
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

function scrapeText(question: HTMLElement): string {
  const stem = findStem(question);
  return normalizeText(stem?.innerText ?? stem?.textContent ?? "");
}

function idsFromUrl(): { courseId?: string; quizId?: string } {
  const course = location.pathname.match(/\/courses\/(\d+)/)?.[1];
  const quiz = location.pathname.match(/\/(?:quizzes|assignments)\/(\d+)/)?.[1];
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

/** Short answer label for a pill: choice letters, a fill-in value, or blank count. */
function answerDisplay(a: { correctChoices: string[]; answerText?: string; blanks?: unknown[] }): string {
  if (a.correctChoices.length) return a.correctChoices.join("");
  if (a.answerText) return truncate(a.answerText, 10);
  if (a.blanks?.length) return `${a.blanks.length} blanks`;
  return "";
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
  for (const c of children) node.appendChild(c);
  return node;
}
