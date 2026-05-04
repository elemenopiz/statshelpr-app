/**
 * Canvas content script — per-question Solve buttons + inline answer cards.
 *
 * Architecture:
 *  1. MutationObserver scans the DOM for question containers and injects a
 *     "Solve" button above each one (idempotent — won't double-inject).
 *  2. A floating CSV widget in the bottom-right manages course-wide data files,
 *     persisted to chrome.storage.local so the user only uploads each CSV once.
 *  3. On Solve click: scrape that question's text + images, stream from /api/solve
 *     via Server-Sent Events, render an answer card directly under the question.
 *  4. After the answer arrives, visually highlight the matching answer choice
 *     in the question (the student still clicks it themselves).
 */

import { renderMarkdown } from "./markdown";

interface DataFile {
  filename: string;
  content: string;
  size: number;
  addedAt: number;
}

interface ImageBlock {
  data: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
}

interface FinalResult {
  mode: "concept" | "calc";
  answer: string;
  confidence: "High" | "Med" | "Low" | "";
  lowConfidence: boolean;
  rCode?: string;
  rOutput?: string;
}

// Classic Quizzes uses .question_holder, .question_text. New Quizzes (LTI tool,
// iframed from quizzes.next.instructure.com) uses data-testid attributes and
// different class names. Both sets are tried in order.
const SELECTORS_QUESTION = [
  // Classic
  ".question_holder",
  ".display_question",
  // New Quizzes
  "[data-testid='question-container']",
  "[data-testid='quiz-question']",
  ".question-container",
  ".QuestionItem",
  ".item-body",
];

const SELECTORS_STEM = [
  // Classic
  ".question_text",
  ".user_content",
  // New Quizzes
  "[data-testid='question-text']",
  "[data-testid='question-stem']",
  ".question-text-container",
  ".stem",
];

const STORAGE_KEY_FILES = "statshelpr.files";
const STORAGE_KEY_CONFIG = "statshelpr.config";
const FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let dataFiles: DataFile[] = [];

// =============================================================================
// boot
// =============================================================================

function boot() {
  loadFiles().then(() => {
    injectFilesWidget();
    scanAndInject();
  });

  const observer = new MutationObserver(() => scanAndInject());
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

// =============================================================================
// per-question button injection
// =============================================================================

let pendingScan = false;
function scanAndInject() {
  if (pendingScan) return;
  pendingScan = true;
  // Coalesce rapid mutations
  setTimeout(() => {
    pendingScan = false;
    for (const sel of SELECTORS_QUESTION) {
      document.querySelectorAll<HTMLElement>(sel).forEach(injectButtonFor);
    }
  }, 100);
}

function injectButtonFor(question: HTMLElement) {
  if (question.dataset["statshelprAttached"] === "1") return;
  if (!findStem(question)) return; // skip if no stem (might be a wrapper)

  const bar = mkEl("div", { className: "statshelpr-solve-bar" });
  const btn = mkEl("button", { className: "statshelpr-btn-solve", type: "button" });
  btn.appendChild(mkSolveIcon());
  btn.appendChild(document.createTextNode("Solve"));
  const status = mkEl("span", { className: "statshelpr-btn-status" });

  bar.appendChild(btn);
  bar.appendChild(status);
  question.insertBefore(bar, question.firstChild);
  question.dataset["statshelprAttached"] = "1";

  btn.addEventListener("click", () => onSolve(question, btn, status));
}

function mkSolveIcon(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "currentColor");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3 1.5l11 6.5-11 6.5v-13z");
  svg.appendChild(path);
  return svg;
}

// =============================================================================
// solve flow (streaming)
// =============================================================================

async function onSolve(
  question: HTMLElement,
  btn: HTMLButtonElement,
  status: HTMLSpanElement,
) {
  btn.setAttribute("disabled", "");
  status.textContent = "";

  // Remove any prior card and prior highlight for this question
  const prior = question.querySelector(":scope > .statshelpr-card");
  if (prior) prior.remove();
  question.querySelectorAll(".statshelpr-correct").forEach((el) =>
    el.classList.remove("statshelpr-correct"),
  );

  const retryFn = () => onSolve(question, btn, status);
  const card = createCard(question, retryFn);
  question.appendChild(card.root);
  card.setPhase("Reading question…");

  let scraped;
  try {
    scraped = await scrapeQuestion(question);
  } catch (e) {
    card.setError((e as Error).message);
    btn.removeAttribute("disabled");
    return;
  }

  const cfg = await getConfig();
  const apiUrl = cfg.apiUrl ?? "http://localhost:3030";
  const licenseKey = cfg.licenseKey ?? "";

  card.setPhase("Thinking…");

  try {
    await streamSolve(`${apiUrl}/api/solve`, licenseKey, scraped, card);
  } catch (e) {
    card.setError((e as Error).message);
  } finally {
    btn.removeAttribute("disabled");
    status.textContent = "";
  }
}

interface ScrapedQuestion {
  text: string;
  images: ImageBlock[];
}

async function scrapeQuestion(question: HTMLElement): Promise<ScrapedQuestion> {
  const stem = findStem(question);
  if (!stem) throw new Error("Could not find question text in this question container.");

  const text = (stem.innerText ?? stem.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("Question text appears empty.");

  const images = await collectImages(stem);
  return { text, images };
}

async function streamSolve(
  url: string,
  licenseKey: string,
  scraped: ScrapedQuestion,
  card: AnswerCard,
) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(licenseKey ? { Authorization: `Bearer ${licenseKey}` } : {}),
    },
    body: JSON.stringify({
      questionText: scraped.text,
      images: scraped.images,
      dataFiles: dataFiles.map((f) => ({ filename: f.filename, content: f.content })),
      stream: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
  }
  if (!res.body) throw new Error("Empty response stream.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buf.indexOf("\n\n")) !== -1) {
      const eventBlock = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      handleSseEvent(eventBlock, card);
    }
  }
}

function handleSseEvent(block: string, card: AnswerCard) {
  // Each block is `data: <json>` lines (we ignore other SSE fields).
  const dataLines = block
    .split("\n")
    .filter((ln) => ln.startsWith("data:"))
    .map((ln) => ln.slice(5).trim())
    .filter((ln) => ln.length > 0);
  if (dataLines.length === 0) return;
  const payload = dataLines.join("\n");

  let evt: { type: string; [k: string]: unknown };
  try {
    evt = JSON.parse(payload);
  } catch {
    return;
  }

  switch (evt.type) {
    case "phase":
      card.setPhase(String(evt["label"] ?? ""));
      break;
    case "delta":
      card.appendDelta(String(evt["text"] ?? ""));
      break;
    case "result":
      card.setFinal(evt["result"] as FinalResult);
      break;
    case "error":
      card.setError(String(evt["message"] ?? "Unknown error"));
      break;
  }
}

// =============================================================================
// answer card
// =============================================================================

interface AnswerCard {
  root: HTMLElement;
  setPhase: (label: string) => void;
  appendDelta: (text: string) => void;
  setFinal: (r: FinalResult) => void;
  setError: (msg: string) => void;
}

function createCard(question: HTMLElement, retry: () => void): AnswerCard {
  const root = mkEl("div", { className: "statshelpr-card" });
  const headerLeft = mkEl("span", {}, [document.createTextNode("statshelpr")]);
  const confTag = mkEl("span", { className: "conf-tag", id: "conf-tag", style: "display:none" });
  const headerActions = mkEl("span", { className: "card-actions", id: "card-actions", style: "display:none" });
  const headerRight = mkEl("span", { className: "header-right" }, [confTag, headerActions]);
  const header = mkEl("div", { className: "statshelpr-card-header" }, [headerLeft, headerRight]);
  const body = mkEl("div", { className: "statshelpr-card-body" });
  root.appendChild(header);
  root.appendChild(body);

  let phase: HTMLElement | null = null;
  let answerEl: HTMLElement | null = null;
  let streamingBuf = "";

  function setPhase(label: string) {
    clear(body);
    phase = mkEl("div", { className: "statshelpr-phase" }, [
      mkEl("span", { className: "statshelpr-spinner" }),
      document.createTextNode(label),
    ]);
    body.appendChild(phase);
    answerEl = null;
    streamingBuf = "";
  }

  function appendDelta(text: string) {
    if (!answerEl) {
      clear(body);
      answerEl = mkEl("p", { className: "statshelpr-answer-text" });
      body.appendChild(answerEl);
    }
    streamingBuf += text;
    // Strip the routing tag from streamed display
    const cleaned = streamingBuf.replace(/^\s*\[(CONCEPT|RCODE|CALC)\]\s*\n?/i, "");
    answerEl.textContent = cleaned;
  }

  function setFinal(r: FinalResult) {
    clear(body);
    if (confTag && r.confidence) {
      confTag.style.display = "";
      confTag.textContent = r.confidence;
      confTag.className = `conf-tag ${r.confidence.toLowerCase()}`;
    }
    if (r.lowConfidence) root.classList.add("low-conf");

    const ansBox = mkEl("div", { className: "statshelpr-answer-text statshelpr-md" });
    const answerStripped = stripTags(r.answer);
    renderMarkdown(answerStripped, ansBox);
    body.appendChild(ansBox);

    // Header action buttons
    clear(headerActions);
    headerActions.appendChild(makeIconButton("⎘", "Copy answer", () => copyText(answerStripped)));
    if (r.mode === "calc" && r.rCode) {
      headerActions.appendChild(makeIconButton("⎘R", "Copy R code", () => copyText(r.rCode ?? "")));
    }
    headerActions.appendChild(makeIconButton("↻", "Re-solve", () => retry()));
    headerActions.style.display = "";

    if (r.mode === "calc" && r.rCode) {
      const det = mkEl("details", { className: "statshelpr-detail" });
      det.appendChild(mkEl("summary", { text: "R code" }));
      const codeBlock = mkEl("pre", { className: "statshelpr-code" });
      renderMarkdown("```r\n" + r.rCode + "\n```", codeBlock);
      det.appendChild(codeBlock);
      body.appendChild(det);
    }
    if (r.mode === "calc" && r.rOutput) {
      const det = mkEl("details", { className: "statshelpr-detail" });
      det.appendChild(mkEl("summary", { text: "R output" }));
      det.appendChild(mkEl("div", { className: "statshelpr-output", text: r.rOutput.slice(0, 4000) }));
      body.appendChild(det);
    }

    highlightAnswerChoice(question, answerStripped);
  }

  function setError(msg: string) {
    clear(body);
    const wrap = mkEl("div", { className: "statshelpr-card-error" });
    wrap.appendChild(mkEl("div", { text: msg, style: "margin-bottom:8px" }));
    const retryBtn = mkEl("button", {
      className: "statshelpr-btn-inline",
      type: "button",
      text: "↻ Retry",
    });
    retryBtn.addEventListener("click", () => retry());
    wrap.appendChild(retryBtn);
    body.appendChild(wrap);
    headerActions.style.display = "none";
  }

  return { root, setPhase, appendDelta, setFinal, setError };
}

function stripTags(s: string): string {
  return s.replace(/^\s*\[(CONCEPT|RCODE|CALC)\]\s*\n?/i, "").trim();
}

function makeIconButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = mkEl("button", {
    className: "statshelpr-icon-btn",
    type: "button",
    title,
    text: label,
  });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
    const orig = btn.textContent ?? "";
    btn.textContent = "✓";
    setTimeout(() => (btn.textContent = orig), 900);
  });
  return btn;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback: textarea trick
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* ignore */
    }
    document.body.removeChild(ta);
  }
}

// =============================================================================
// answer choice highlighting (visual mark only — student still clicks)
// =============================================================================

function highlightAnswerChoice(question: HTMLElement, answer: string) {
  const radios = [...question.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  if (radios.length === 0) return;

  // Try to extract a letter (A-E) or number (1-5) from the start of the answer
  const letterMatch = answer.match(/^\s*(?:Answer\s*:?\s*)?\(?([A-Ea-e1-5])\)?[\s.,)]?/);
  if (letterMatch && letterMatch[1]) {
    const ch = letterMatch[1].toUpperCase();
    let idx = -1;
    if (/[A-E]/.test(ch)) idx = ch.charCodeAt(0) - 65;
    else if (/[1-5]/.test(ch)) idx = parseInt(ch, 10) - 1;
    if (idx >= 0 && idx < radios.length) {
      const target = radios[idx];
      if (target) {
        markChoice(target);
        return;
      }
    }
  }

  // Fallback: substring match against each choice's visible text
  const answerLower = answer.toLowerCase();
  let bestRadio: HTMLInputElement | null = null;
  let bestScore = 0;
  for (const radio of radios) {
    const choiceText = getChoiceText(radio).toLowerCase().trim();
    if (!choiceText) continue;
    let score = 0;
    if (answerLower.includes(choiceText) && choiceText.length >= 4) score = choiceText.length;
    else if (choiceText.includes(answerLower.slice(0, 40))) score = answerLower.length / 2;
    if (score > bestScore) {
      bestScore = score;
      bestRadio = radio;
    }
  }
  if (bestRadio) markChoice(bestRadio);
}

function getChoiceText(radio: HTMLInputElement): string {
  if (radio.id) {
    const label = document.querySelector(`label[for="${cssEscape(radio.id)}"]`);
    if (label) return label.textContent ?? "";
  }
  const row = radio.closest(".answer, .answer_row, label");
  if (row) {
    const at = row.querySelector(".answer_text, .answer_html");
    if (at?.textContent) return at.textContent;
    return row.textContent ?? "";
  }
  return "";
}

function markChoice(radio: HTMLInputElement) {
  const row =
    (radio.closest(".answer") as HTMLElement | null) ??
    (radio.closest(".answer_row") as HTMLElement | null) ??
    (radio.closest("label") as HTMLElement | null) ??
    (radio.parentElement as HTMLElement | null);
  if (!row) return;
  row.classList.add("statshelpr-correct");
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// =============================================================================
// floating CSV widget
// =============================================================================

function injectFilesWidget() {
  if (document.getElementById("statshelpr-files-widget")) return;

  const widget = mkEl("div", {
    id: "statshelpr-files-widget",
    className: "statshelpr-files-widget collapsed",
  });
  const header = mkEl("div", { className: "statshelpr-files-header" }, [
    document.createTextNode("Data files"),
    mkEl("span", { className: "count", id: "files-count" }),
  ]);
  const body = mkEl("div", { className: "statshelpr-files-body" });
  widget.appendChild(header);
  widget.appendChild(body);

  const dz = mkEl("div", { className: "statshelpr-dropzone" });
  dz.appendChild(document.createTextNode("Drop CSV here"));
  dz.appendChild(mkEl("br"));
  const hint = mkEl("span", { text: "or click to upload" });
  hint.style.fontSize = "10px";
  hint.style.color = "#999";
  dz.appendChild(hint);
  body.appendChild(dz);

  const list = mkEl("div", { className: "statshelpr-files-list", id: "files-list" });
  body.appendChild(list);

  const fileInput = mkEl("input") as HTMLInputElement;
  fileInput.type = "file";
  fileInput.accept = ".csv,.tsv,.txt";
  fileInput.multiple = true;
  fileInput.style.display = "none";
  body.appendChild(fileInput);

  document.body.appendChild(widget);

  header.addEventListener("click", () => widget.classList.toggle("collapsed"));
  dz.addEventListener("click", (e) => {
    e.stopPropagation();
    fileInput.click();
  });
  fileInput.addEventListener("change", async () => {
    if (fileInput.files) await ingestFiles([...fileInput.files]);
    fileInput.value = "";
  });
  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("drag-over");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
  dz.addEventListener("drop", async (e) => {
    e.preventDefault();
    dz.classList.remove("drag-over");
    if (e.dataTransfer?.files) await ingestFiles([...e.dataTransfer.files]);
  });

  renderFilesList();
}

async function ingestFiles(files: File[]) {
  for (const f of files) {
    const text = await f.text();
    dataFiles = dataFiles.filter((d) => d.filename !== f.name);
    dataFiles.push({
      filename: f.name,
      content: text,
      size: text.length,
      addedAt: Date.now(),
    });
  }
  await saveFiles();
  renderFilesList();
  // Auto-expand widget when files are added
  document.getElementById("statshelpr-files-widget")?.classList.remove("collapsed");
}

function renderFilesList() {
  const list = document.getElementById("files-list");
  const count = document.getElementById("files-count");
  if (!list) return;
  clear(list);
  if (count) count.textContent = String(dataFiles.length);
  for (const f of dataFiles) {
    const row = mkEl("div", { className: "row" });
    row.appendChild(mkEl("span", { className: "name", text: f.filename, title: f.filename }));
    row.appendChild(mkEl("span", { className: "size", text: `${(f.size / 1024).toFixed(1)} KB` }));
    const rm = mkEl("button", { className: "remove", text: "×", title: "Remove" });
    rm.addEventListener("click", async () => {
      dataFiles = dataFiles.filter((d) => d.filename !== f.filename);
      await saveFiles();
      renderFilesList();
    });
    row.appendChild(rm);
    list.appendChild(row);
  }
}

// =============================================================================
// storage
// =============================================================================

async function loadFiles() {
  const r = await chrome.storage.local.get(STORAGE_KEY_FILES);
  const stored = (r[STORAGE_KEY_FILES] as DataFile[] | undefined) ?? [];
  // Drop any older than TTL
  const now = Date.now();
  dataFiles = stored.filter((f) => now - f.addedAt < FILE_TTL_MS);
  if (dataFiles.length !== stored.length) await saveFiles();
}

async function saveFiles() {
  await chrome.storage.local.set({ [STORAGE_KEY_FILES]: dataFiles });
}

async function getConfig(): Promise<{ apiUrl?: string; licenseKey?: string }> {
  const r = await chrome.storage.sync.get(["apiUrl", "licenseKey"]);
  return r as { apiUrl?: string; licenseKey?: string };
}

// =============================================================================
// image scraping
// =============================================================================

async function collectImages(root: HTMLElement): Promise<ImageBlock[]> {
  const out: ImageBlock[] = [];

  for (const img of [...root.querySelectorAll<HTMLImageElement>("img")]) {
    if (!img.src) continue;
    try {
      const block = await urlToImageBlock(img.src);
      if (block) out.push(block);
    } catch {
      // skip
    }
  }
  for (const c of [...root.querySelectorAll<HTMLCanvasElement>("canvas")]) {
    try {
      const dataUrl = c.toDataURL("image/png");
      const data = dataUrl.split(",")[1];
      if (data) out.push({ data, mediaType: "image/png" });
    } catch {
      // tainted canvas — skip
    }
  }
  return out;
}

async function urlToImageBlock(url: string): Promise<ImageBlock | null> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) return null;
  const blob = await res.blob();
  const t = blob.type.toLowerCase();
  let mediaType: ImageBlock["mediaType"] | null = null;
  if (t === "image/png") mediaType = "image/png";
  else if (t === "image/jpeg" || t === "image/jpg") mediaType = "image/jpeg";
  else if (t === "image/webp") mediaType = "image/webp";
  if (!mediaType) return null;

  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result;
      if (typeof result !== "string") return reject(new Error("read failed"));
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  return { data, mediaType };
}

// =============================================================================
// helpers
// =============================================================================

function findStem(question: HTMLElement): HTMLElement | null {
  for (const sel of SELECTORS_STEM) {
    const el = question.querySelector<HTMLElement>(sel);
    if (el && (el.innerText || el.textContent)?.trim()) return el;
  }
  return null;
}

interface ElOptions {
  className?: string;
  id?: string;
  text?: string;
  title?: string;
  type?: string;
  style?: string;
}

function mkEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.id) node.id = opts.id;
  if (opts.title) node.title = opts.title;
  if (opts.style) node.setAttribute("style", opts.style);
  if (opts.type && tag === "button") (node as HTMLButtonElement).type = opts.type;
  if (opts.text !== undefined) node.textContent = opts.text;
  for (const c of children) {
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function clear(node: HTMLElement) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
