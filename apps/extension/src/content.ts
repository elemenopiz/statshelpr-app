/**
 * Canvas content script — tiny inline "solve" button next to each question.
 *
 * Flow on click:
 *   1. Set button to spinner (visual "thinking" feedback)
 *   2. Scrape question text + answer choices + any images
 *   3. POST /api/solve (non-streaming JSON)
 *   4. Parse the answer letter, find the matching radio/checkbox, click it
 *   5. Set button to ✓ briefly, then back to "solve" (re-clickable)
 *
 * No answer card, no explanation, no R code display.
 *
 * A small floating CSV widget in the bottom-right manages course-wide data
 * files, persisted in chrome.storage.local across sessions.
 */

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

interface SolveResponse {
  mode: "concept" | "calc";
  answer: string;
  confidence: "High" | "Med" | "Low" | "";
  lowConfidence: boolean;
  rCode?: string;
  rOutput?: string;
}

const SELECTORS_QUESTION = [
  ".question_holder",
  ".display_question",
  "[data-testid='question-container']",
  "[data-testid='quiz-question']",
  ".question-container",
  ".QuestionItem",
  ".item-body",
];

const SELECTORS_STEM = [
  ".question_text",
  ".user_content",
  "[data-testid='question-text']",
  "[data-testid='question-stem']",
  ".question-text-container",
  ".stem",
];

// Where to place the tiny button relative to the question. We try these in
// order — first match wins. Fall back to prepending into the question container.
const SELECTORS_HEADER = [
  ".question_name",                  // Classic Quizzes — the "Question 1" span
  ".header .question_name",
  ".question .header",
  "[data-testid='question-number']", // New Quizzes (guess)
  "[data-testid='question-header']",
];

const QUESTION_SELECTOR = SELECTORS_QUESTION.join(",");
const CHOICE_INPUT_SELECTOR = 'input[type="radio"], input[type="checkbox"]';

const STORAGE_KEY_FILES = "statshelpr.files";
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
  setTimeout(() => {
    pendingScan = false;
    for (const sel of SELECTORS_QUESTION) {
      document.querySelectorAll<HTMLElement>(sel).forEach(injectButtonFor);
    }
  }, 100);
}

function injectButtonFor(question: HTMLElement) {
  if (question.dataset["statshelprAttached"] === "1") return;
  if (hasQuestionAncestor(question)) return;
  if (!findStem(question)) return;

  const btn = mkEl("button", {
    className: "statshelpr-btn-solve",
    type: "button",
    text: "solve",
    title: "statshelpr: auto-answer this question",
  });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    void onSolve(question, btn);
  });

  const anchor = findHeader(question);
  if (anchor) {
    // Inline next to "Question 1" — append after the header text node
    anchor.appendChild(document.createTextNode(" "));
    anchor.appendChild(btn);
  } else {
    // Fallback: small wrapper at top of question container
    const wrap = mkEl("div", { className: "statshelpr-solve-wrap" });
    wrap.appendChild(btn);
    question.insertBefore(wrap, question.firstChild);
  }

  question.dataset["statshelprAttached"] = "1";
}

function findHeader(question: HTMLElement): HTMLElement | null {
  for (const sel of SELECTORS_HEADER) {
    const el = question.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

// =============================================================================
// solve flow (single non-streaming request)
// =============================================================================

async function onSolve(question: HTMLElement, btn: HTMLButtonElement) {
  if (btn.disabled) return;
  setBtnState(btn, "loading");
  // Clear any prior visual marker on this question
  question.querySelectorAll(".statshelpr-correct").forEach((el) =>
    el.classList.remove("statshelpr-correct"),
  );

  let scraped: ScrapedQuestion;
  try {
    scraped = await scrapeQuestion(question);
  } catch (e) {
    setBtnState(btn, "error", (e as Error).message);
    return;
  }

  const cfg = await getConfig();
  const apiUrl = (cfg.apiUrl ?? "http://localhost:3030").replace(/\/$/, "");
  const licenseKey = cfg.licenseKey ?? "";

  let response: SolveResponse;
  try {
    const res = await fetch(`${apiUrl}/api/solve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(licenseKey ? { Authorization: `Bearer ${licenseKey}` } : {}),
      },
      body: JSON.stringify({
        questionText: scraped.text,
        images: scraped.images,
        dataFiles: dataFiles.map((f) => ({ filename: f.filename, content: f.content })),
        // stream:false (default) — we don't need progress events, just the result
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      // Try to extract the {error: "..."} field from a JSON error response
      let msg = body.slice(0, 200);
      try {
        const parsed = JSON.parse(body) as { error?: string };
        if (parsed.error) msg = parsed.error;
      } catch {
        /* not JSON — use raw body */
      }
      throw new Error(msg);
    }
    response = (await res.json()) as SolveResponse;
  } catch (e) {
    setBtnState(btn, "error", (e as Error).message);
    return;
  }

  const cleaned = stripTags(response.answer);
  selectAnswerChoice(question, cleaned);
  setBtnState(btn, "success");
}

type BtnState = "default" | "loading" | "success" | "error";

function setBtnState(btn: HTMLButtonElement, state: BtnState, errorMsg?: string) {
  btn.classList.remove("loading", "success", "error");
  btn.removeAttribute("title");

  switch (state) {
    case "loading":
      btn.classList.add("loading");
      btn.disabled = true;
      clear(btn);
      btn.appendChild(mkEl("span", { className: "statshelpr-spinner" }));
      btn.setAttribute("title", "thinking…");
      return;
    case "success":
      btn.classList.add("success");
      btn.disabled = false;
      btn.textContent = "✓";
      btn.setAttribute("title", "answered — click to re-solve");
      // Revert to "solve" after a moment so user can re-click
      setTimeout(() => {
        if (btn.classList.contains("success")) setBtnState(btn, "default");
      }, 2000);
      return;
    case "error":
      btn.classList.add("error");
      btn.disabled = false;
      btn.textContent = "!";
      btn.setAttribute("title", errorMsg ?? "error — click to retry");
      return;
    default:
      btn.disabled = false;
      btn.textContent = "solve";
      btn.setAttribute("title", "statshelpr: auto-answer this question");
  }
}

// =============================================================================
// scraping
// =============================================================================

interface ScrapedQuestion {
  text: string;
  images: ImageBlock[];
}

async function scrapeQuestion(question: HTMLElement): Promise<ScrapedQuestion> {
  const stem = findStem(question);
  if (!stem) throw new Error("Could not find question text.");

  const stemText = normalizeText(stem.innerText ?? stem.textContent ?? "");
  if (!stemText) throw new Error("Question text is empty.");

  const images = await collectImages(stem);
  const choices = collectAnswerChoices(question);

  // Always tell the model the choice letters. The system prompt expects an
  // answer like "Answer: B" — we then match B to the corresponding radio.
  const choiceText = choices.length
    ? [
        "",
        "Answer choices:",
        ...choices.map((c) => `${c.label}. ${c.text}`),
        "",
        "Respond with just the correct choice letter(s).",
      ].join("\n")
    : "";

  return { text: `${stemText}${choiceText}`, images };
}

// =============================================================================
// answer-choice selection (the click)
// =============================================================================

function selectAnswerChoice(question: HTMLElement, answer: string) {
  const choices = collectAnswerChoices(question);
  if (choices.length === 0) return;

  // Multi-select: any checkboxes means "select all that apply"
  const checkboxes = choices.filter((c) => c.input.type === "checkbox");
  if (checkboxes.length > 0) {
    const selected = findSelectedChoices(answer, choices, true);
    for (const c of selected) selectChoice(c.input);
    return;
  }

  const radios = choices.filter((c) => c.input.type === "radio");
  if (radios.length === 0) return;

  // Try letter (A-E) or number (1-5) at start of answer
  const letterMatch = answer.match(/^\s*(?:Answer\s*:?\s*)?\(?([A-Ea-e1-5])\)?[\s.,)]?/);
  if (letterMatch && letterMatch[1]) {
    const ch = letterMatch[1].toUpperCase();
    let idx = -1;
    if (/[A-E]/.test(ch)) idx = ch.charCodeAt(0) - 65;
    else if (/[1-5]/.test(ch)) idx = parseInt(ch, 10) - 1;
    if (idx >= 0 && idx < radios.length) {
      const target = radios[idx]?.input;
      if (target) {
        selectChoice(target);
        return;
      }
    }
  }

  // Fallback: substring match against each choice's visible text
  const answerLower = answer.toLowerCase();
  let best: HTMLInputElement | null = null;
  let bestScore = 0;
  for (const c of radios) {
    const choiceLower = c.text.toLowerCase().trim();
    if (!choiceLower) continue;
    let score = 0;
    if (answerLower.includes(choiceLower) && choiceLower.length >= 4) score = choiceLower.length;
    else if (choiceLower.includes(answerLower.slice(0, 40))) score = answerLower.length / 2;
    if (score > bestScore) {
      bestScore = score;
      best = c.input;
    }
  }
  if (best) selectChoice(best);
}

interface AnswerChoice {
  input: HTMLInputElement;
  label: string;
  text: string;
}

function collectAnswerChoices(question: HTMLElement): AnswerChoice[] {
  const inputs = [...question.querySelectorAll<HTMLInputElement>(CHOICE_INPUT_SELECTOR)];
  const choices: AnswerChoice[] = [];
  const seenRows = new Set<Element>();

  inputs.forEach((input, index) => {
    const row = getChoiceRow(input);
    if (row && seenRows.has(row)) return;
    if (row) seenRows.add(row);

    const text = normalizeText(getChoiceText(input));
    if (!text) return;
    choices.push({
      input,
      label: choiceLabel(index),
      text,
    });
  });

  return choices;
}

function findSelectedChoices(
  answer: string,
  choices: AnswerChoice[],
  allowMultiple: boolean,
): AnswerChoice[] {
  const byLabel = new Map(choices.map((c) => [c.label.toUpperCase(), c]));
  const selected = new Map<HTMLInputElement, AnswerChoice>();

  const answerLine =
    answer.match(/^\s*Answer\s*:?\s*(.+)$/im)?.[1] ??
    answer.match(/correct(?:\s+interpretation)?(?:\(s\))?\s*:?\s*(.+)$/im)?.[1] ??
    answer;

  for (const m of answerLine.matchAll(/\b([A-Z])\b/g)) {
    const c = byLabel.get(m[1].toUpperCase());
    if (c) {
      selected.set(c.input, c);
      if (!allowMultiple) return [c];
    }
  }

  const answerLower = answer.toLowerCase();
  for (const c of choices) {
    const choiceLower = c.text.toLowerCase();
    if (choiceLower.length >= 12 && answerLower.includes(choiceLower)) {
      selected.set(c.input, c);
    }
  }

  return [...selected.values()];
}

function getChoiceText(input: HTMLInputElement): string {
  if (input.id) {
    const label = document.querySelector(`label[for="${cssEscape(input.id)}"]`);
    if (label) return label.textContent ?? "";
  }
  const row = getChoiceRow(input);
  if (row) {
    const at = row.querySelector(".answer_text, .answer_html");
    if (at?.textContent) return at.textContent;
    return row.textContent ?? "";
  }
  return "";
}

function getChoiceRow(input: HTMLInputElement): HTMLElement | null {
  return (
    (input.closest(".answer") as HTMLElement | null) ??
    (input.closest(".answer_row") as HTMLElement | null) ??
    (input.closest("label") as HTMLElement | null) ??
    (input.parentElement as HTMLElement | null)
  );
}

function selectChoice(input: HTMLInputElement) {
  const row = getChoiceRow(input);
  if (input.disabled) {
    row?.classList.add("statshelpr-correct");
    return;
  }

  if (!input.checked) input.click();
  if (!input.checked) {
    // Some React-based UIs (New Quizzes) don't react to .click() — set the
    // checked property via the native descriptor + dispatch input/change.
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, "checked")?.set;
    setter?.call(input, true);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  row?.classList.add("statshelpr-correct");
}

function hasQuestionAncestor(question: HTMLElement): boolean {
  const ancestor = question.parentElement?.closest<HTMLElement>(QUESTION_SELECTOR);
  return Boolean(ancestor && findStem(ancestor));
}

function choiceLabel(index: number): string {
  return String.fromCharCode(65 + index);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function stripTags(s: string): string {
  return s.replace(/^\s*\[(CONCEPT|RCODE|CALC)\]\s*\n?/i, "").trim();
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
      /* skip */
    }
  }
  for (const c of [...root.querySelectorAll<HTMLCanvasElement>("canvas")]) {
    try {
      const dataUrl = c.toDataURL("image/png");
      const data = dataUrl.split(",")[1];
      if (data) out.push({ data, mediaType: "image/png" });
    } catch {
      /* tainted canvas — skip */
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
