/**
 * Canvas content script — training-data capture.
 *
 * Injects a small "capture" pill onto every quiz question and a floating panel
 * (bottom-right) that manages the captured set. Two capture paths:
 *
 *   1. Answer-key (automated) — on a graded results/history page Canvas shows
 *      the correct answer inline; the pill lights green and one click (or the
 *      panel's "Capture keyed" button) harvests the labeled fixture. This is
 *      the bulk path: submit a quiz, open results, capture every question at
 *      once.
 *   2. Manual — on a live/ungraded quiz with no key, select the correct
 *      choice(s) yourself, then click the pill; your selection becomes the
 *      label.
 *
 * Everything is local: no network, no API, no cost. Captured questions persist
 * in chrome.storage.local and are exported (from here or the popup) as fixtures
 * matching evals/solve-fixtures/*.json.
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
  getSettings,
  saveSettings,
  upsertCapture,
  hasCapture,
  getAllCaptures,
  clearCaptures,
  toFixtureBundle,
  toJsonl,
  downloadText,
  hashId,
  templateId,
  fixtureName,
} from "./store";
import { loadDatasets, detectDatasetRefs } from "./datasets";
import type { Capture, CaptureSettings } from "./types";

const ATTR = "shcapAttached";
let settings: CaptureSettings;
const pills = new Map<HTMLElement, HTMLButtonElement>();

// =============================================================================
// boot
// =============================================================================

async function boot() {
  settings = await getSettings();
  ensurePanel();
  scanAndInject();

  const observer = new MutationObserver((records) => {
    // Ignore our own panel/pill mutations to avoid a rescan feedback loop.
    if (records.every((r) => (r.target as HTMLElement).closest?.("#shcap-panel"))) return;
    scanAndInject();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes["statshelpr.captures"]) {
      void refreshAllPillStates();
      void refreshPanel();
    }
    if (changes["statshelpr.captureSettings"]) {
      void getSettings().then((s) => {
        settings = s;
        syncPanelControls();
      });
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot());
} else {
  void boot();
}

// =============================================================================
// per-question pill
// =============================================================================

let pendingScan = false;
function scanAndInject() {
  if (pendingScan) return;
  pendingScan = true;
  setTimeout(() => {
    pendingScan = false;
    for (const q of findQuestions()) injectPill(q);
    void refreshPanel();
  }, 120);
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

/** Reflect the question's current status on its pill: already-saved, has an
 * answer key (green), or needs a manual selection (gray). */
async function setPillState(question: HTMLElement, pill: HTMLButtonElement) {
  const raw = collectChoices(question);
  const { hasKey, labels } = detectCorrectChoices(question, raw);
  const id = hashId(scrapeText(question));
  const saved = id ? await hasCapture(id) : false;

  pill.classList.toggle("shcap-has-key", hasKey);
  pill.classList.toggle("shcap-saved", saved);
  question.classList.toggle("shcap-captured", saved);

  if (saved) {
    pill.textContent = "✓ saved";
    pill.title = "Captured — click to re-capture / update the label";
  } else if (hasKey) {
    pill.textContent = `⬇ capture (${labels.join("")})`;
    pill.title = "Answer key detected — click to capture this labeled question";
  } else {
    pill.textContent = "⬇ capture";
    pill.title = looksGraded(question)
      ? "No key auto-detected — select the correct choice(s), then click"
      : "Select the correct choice(s) first, then click to capture your label";
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

async function captureOne(question: HTMLElement, pill: HTMLButtonElement): Promise<boolean> {
  pill.classList.add("shcap-busy");
  try {
    const scraped = await scrapeQuestion(question, { includeImages: settings.includeImages });
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
      mode: settings.defaultMode,
      source,
      url: location.href,
      ...idsFromUrl(),
      capturedAt: Date.now(),
    };
    await upsertCapture(capture);
    await setPillState(question, pill);
    flashPill(pill, datasetRefs.length ? `✓ saved +${datasetRefs[0]}` : "✓ saved", "shcap-saved");
    return true;
  } catch (e) {
    flashPill(pill, "! " + truncate((e as Error).message, 24), "shcap-err");
    return false;
  } finally {
    pill.classList.remove("shcap-busy");
  }
}

/** Bulk-capture every question on the page that has a detected answer key. */
async function captureAllKeyed(btn: HTMLButtonElement) {
  const questions = findQuestions().filter((q) => detectCorrectChoices(q, collectChoices(q)).hasKey);
  if (questions.length === 0) return;
  btn.disabled = true;
  let done = 0;
  for (const q of questions) {
    const pill = pills.get(q);
    if (pill) {
      const ok = await captureOne(q, pill);
      if (ok) done += 1;
    }
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

  const captureKeyed = el("button", {
    className: "shcap-btn shcap-primary",
    id: "shcap-capture-keyed",
    type: "button",
    text: "Capture keyed",
  });

  const modeSel = el("select", { id: "shcap-mode" }, [
    el("option", { value: "concept", text: "concept" }),
    el("option", { value: "calc", text: "calc" }),
  ]);
  const modeLabel = el("label", { className: "shcap-seg", title: "Mode stamped on new captures" }, [
    document.createTextNode("mode "),
    modeSel,
  ]);
  const imagesCheck = el("input", { id: "shcap-images", type: "checkbox" });
  const imagesLabel = el(
    "label",
    { className: "shcap-check", title: "Embed images in captures (needed for graph questions)" },
    [imagesCheck, document.createTextNode(" images")],
  );
  const controls = el("div", { className: "shcap-controls" }, [modeLabel, imagesLabel]);

  const exportJsonBtn = el("button", { className: "shcap-btn", id: "shcap-export-json", type: "button", text: "Export .json" });
  const exportJsonlBtn = el("button", { className: "shcap-btn", id: "shcap-export-jsonl", type: "button", text: ".jsonl" });
  const exportRow = el("div", { className: "shcap-row" }, [exportJsonBtn, exportJsonlBtn]);
  const clearBtn = el("button", { className: "shcap-btn shcap-quiet", id: "shcap-clear", type: "button", text: "Clear all" });

  const body = el("div", { className: "shcap-body" }, [stat, page, captureKeyed, controls, exportRow, clearBtn]);
  const panel = el("div", { id: "shcap-panel" }, [head, body]);
  document.body.appendChild(panel);

  collapseBtn.addEventListener("click", () => panel.classList.toggle("shcap-collapsed"));
  head.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".shcap-collapse")) return;
    if (panel.classList.contains("shcap-collapsed")) panel.classList.remove("shcap-collapsed");
  });
  captureKeyed.addEventListener("click", (e) => void captureAllKeyed(e.currentTarget as HTMLButtonElement));
  modeSel.addEventListener("change", async () => {
    settings = await saveSettings({ defaultMode: modeSel.value as CaptureSettings["defaultMode"] });
  });
  imagesCheck.addEventListener("change", async () => {
    settings = await saveSettings({ includeImages: imagesCheck.checked });
  });
  exportJsonBtn.addEventListener("click", () => void exportBundle("json"));
  exportJsonlBtn.addEventListener("click", () => void exportBundle("jsonl"));
  clearBtn.addEventListener("click", () => void clearAll());

  syncPanelControls();
}

function syncPanelControls() {
  const mode = document.querySelector<HTMLSelectElement>("#shcap-mode");
  const images = document.querySelector<HTMLInputElement>("#shcap-images");
  if (mode) mode.value = settings.defaultMode;
  if (images) images.checked = settings.includeImages;
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
  page.textContent = `This page: ${onPage.length} question${onPage.length === 1 ? "" : "s"}, ${withKey} with answer key`;
  keyedBtn.textContent = withKey ? `Capture keyed (${withKey})` : "No answer key on page";
  keyedBtn.disabled = withKey === 0;
}

async function exportBundle(kind: "json" | "jsonl") {
  const captures = await getAllCaptures();
  if (captures.length === 0) return;
  const datasets = await loadDatasets();
  const inline = settings.inlineDatasets;
  if (kind === "json") {
    downloadText(`statshelpr-fixtures-${stamp()}.json`, toFixtureBundle(captures, datasets, inline));
  } else {
    downloadText(`statshelpr-fixtures-${stamp()}.jsonl`, toJsonl(captures, datasets, inline));
  }
}

async function clearAll() {
  const captures = await getAllCaptures();
  if (captures.length === 0) return;
  if (!confirm(`Delete all ${captures.length} captured questions? Export first if you want to keep them.`)) {
    return;
  }
  await clearCaptures();
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
