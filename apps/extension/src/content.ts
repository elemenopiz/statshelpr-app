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
  selectedChoices?: string[];
  fillValues?: string[];
  confidence: "High" | "Med" | "Low" | "";
  lowConfidence: boolean;
  rCode?: string;
  rOutput?: string;
}

const FIRST_HINT_KEY = "statshelpr.firstHintShown";

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
const TEXT_INPUT_SELECTOR = [
  'input[type="text"]',
  'input[type="number"]',
  ".numerical_question_input",
  ".question_input",
].join(",");

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
        choices: scraped.choices.map((c) => ({
          label: c.label,
          text: c.text,
          type: choiceTypeForApi(c),
        })),
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
  selectAnswerChoice(question, cleaned, response.selectedChoices ?? []);
  setBtnState(btn, "success", undefined, response.confidence);
}

type BtnState = "default" | "loading" | "success" | "error";

function setBtnState(
  btn: HTMLButtonElement,
  state: BtnState,
  errorMsg?: string,
  confidence?: "High" | "Med" | "Low" | "",
) {
  btn.classList.remove("loading", "success", "success-med", "error");
  btn.removeAttribute("title");

  switch (state) {
    case "loading":
      btn.classList.add("loading");
      btn.disabled = true;
      clear(btn);
      btn.appendChild(mkEl("span", { className: "statshelpr-spinner" }));
      btn.setAttribute("title", "thinking…");
      return;
    case "success": {
      // Low / Med confidence → amber state with ⚠ so student knows to verify
      const isLow = confidence === "Low" || confidence === "Med";
      btn.classList.add(isLow ? "success-med" : "success");
      btn.disabled = false;
      btn.textContent = isLow ? "?" : "✓";
      btn.setAttribute(
        "title",
        isLow
          ? `answered with ${confidence?.toLowerCase()} confidence — verify before submitting (click to re-solve)`
          : "answered — click to re-solve",
      );
      setTimeout(() => {
        if (
          btn.classList.contains("success") ||
          btn.classList.contains("success-med")
        )
          setBtnState(btn, "default");
      }, 2400);
      return;
    }
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
  choices: AnswerChoice[];
  images: ImageBlock[];
}

async function scrapeQuestion(question: HTMLElement): Promise<ScrapedQuestion> {
  const stem = findStem(question);
  if (!stem) throw new Error("Could not find question text.");

  const stemText = normalizeText(stem.innerText ?? stem.textContent ?? "");
  if (!stemText) throw new Error("Question text is empty.");

  // Scrape images from the WHOLE question container — answer choices sometimes
  // have images too (e.g. "Which graph shows ___?"). Dedupe by image URL.
  const images = await collectImages(question);
  const choices = collectAnswerChoices(question);

  return { text: stemText, choices, images };
}

// =============================================================================
// answer-choice selection (the click)
// =============================================================================

function selectAnswerChoice(question: HTMLElement, answer: string, selectedLabels: string[] = []) {
  const choices = collectAnswerChoices(question);
  if (choices.length === 0) return;

  // Special-case text-fill: there's just one slot, write the answer in.
  if (choices.length === 1 && choices[0]?.kind === "text-fill") {
    fillTextInput(choices[0].input as HTMLInputElement, answer);
    return;
  }

  const selectedByBackend = selectedLabels
    .map((label) => choices.find((c) => c.label.toUpperCase() === label.toUpperCase()))
    .filter((c): c is AnswerChoice => Boolean(c));
  if (selectedByBackend.length > 0) {
    for (const c of selectedByBackend) applyChoice(c);
    return;
  }

  // Multi-select via checkboxes
  const checkboxes = choices.filter((c) => c.kind === "checkbox");
  if (checkboxes.length > 0) {
    const selected = findSelectedChoices(answer, choices, true);
    for (const c of selected) applyChoice(c);
    return;
  }

  // Dropdown: single-select, options scraped from the <select>
  const dropdown = choices.filter((c) => c.kind === "dropdown-option");
  if (dropdown.length > 0) {
    const c = pickByLetterOrText(answer, dropdown);
    if (c) applyChoice(c);
    return;
  }

  // Radio: single-select
  const radios = choices.filter((c) => c.kind === "radio");
  if (radios.length === 0) return;
  const c = pickByLetterOrText(answer, radios);
  if (c) applyChoice(c);
}

function pickByLetterOrText(answer: string, pool: AnswerChoice[]): AnswerChoice | null {
  const letterMatch = answer.match(/^\s*(?:Answer\s*:?\s*)?\(?([A-Za-z]|\d{1,2})\)?[\s.,)]?/);
  if (letterMatch && letterMatch[1]) {
    const tok = letterMatch[1].toUpperCase();
    let idx = -1;
    if (/^[A-Z]$/.test(tok)) idx = tok.charCodeAt(0) - 65;
    else if (/^\d+$/.test(tok)) idx = parseInt(tok, 10) - 1;
    if (idx >= 0 && idx < pool.length) return pool[idx] ?? null;
  }
  const answerLower = answer.toLowerCase();
  let best: AnswerChoice | null = null;
  let bestScore = 0;
  for (const c of pool) {
    const choiceLower = c.text.toLowerCase().trim();
    if (!choiceLower) continue;
    let score = 0;
    if (answerLower.includes(choiceLower) && choiceLower.length >= 3) score = choiceLower.length;
    else if (choiceLower.includes(answerLower.slice(0, 40))) score = answerLower.length / 2;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function applyChoice(choice: AnswerChoice) {
  if (choice.kind === "dropdown-option") {
    selectDropdownOption(choice);
    return;
  }
  if (choice.kind === "text-fill") {
    // shouldn't reach here in normal flow (text-fill is handled upstream)
    return;
  }
  selectChoice(choice.input as HTMLInputElement);
}

function selectDropdownOption(choice: AnswerChoice) {
  const sel = choice.input as HTMLSelectElement;
  if (sel.disabled) {
    sel.classList.add("statshelpr-correct");
    return;
  }
  // React-aware setter so New Quizzes / Canvas reacts to the change
  const proto = Object.getPrototypeOf(sel);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter && choice.optionValue !== undefined) {
    setter.call(sel, choice.optionValue);
  } else if (choice.optionIndex !== undefined) {
    sel.selectedIndex = choice.optionIndex;
  }
  sel.dispatchEvent(new Event("input", { bubbles: true }));
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  sel.classList.add("statshelpr-correct");
}

function fillTextInput(input: HTMLInputElement, answer: string) {
  if (input.disabled || input.readOnly) {
    input.classList.add("statshelpr-correct");
    return;
  }
  // Try to extract just the value from "Answer: 12.34" or "Final answer: 12.34"
  const m = answer.match(/(?:Answer|Final answer)\s*:?\s*(.+?)(?:\n|$)/i);
  let value = (m?.[1] ?? answer).trim();
  // Drop trailing punctuation
  value = value.replace(/[.,;]\s*$/, "").trim();
  // Strip wrapping quotes
  value = value.replace(/^["'`]|["'`]$/g, "");

  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.classList.add("statshelpr-correct");
}

interface AnswerChoice {
  // For radio/checkbox: the input itself. For dropdown-option: the parent <select>.
  // For text-fill: the <input type=text|number>.
  input: HTMLInputElement | HTMLSelectElement;
  label: string;
  text: string;
  kind: "radio" | "checkbox" | "dropdown-option" | "text-fill";
  /** dropdown-option: the option value to set on the select */
  optionValue?: string;
  /** dropdown-option: the option index inside the select */
  optionIndex?: number;
}

function collectAnswerChoices(question: HTMLElement): AnswerChoice[] {
  // Priority 1: radio / checkbox inputs (the dominant Canvas question type).
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
      kind: input.type === "checkbox" ? "checkbox" : "radio",
    });
  });

  if (choices.length > 0) return choices;

  // Priority 2: dropdown <select> answer fields. Canvas Classic uses
  // `<select name="answer_for_*">` for dropdown / TRUE-FALSE-style questions.
  // We treat the FIRST dropdown's options as the answer choices. Multi-dropdown
  // questions aren't fully supported yet — only the first dropdown gets answered.
  const selects = [...question.querySelectorAll<HTMLSelectElement>("select")].filter((sel) =>
    isAnswerSelect(sel),
  );
  if (selects.length > 0) {
    const sel = selects[0]!;
    let idx = 0;
    for (const opt of [...sel.querySelectorAll("option")]) {
      const text = normalizeText(opt.textContent ?? "");
      // Skip placeholder "[Select]" / "Choose..." entries
      if (!text || /^\[?\s*(select|choose)\s*\]?\s*\.{0,3}$/i.test(text)) continue;
      choices.push({
        input: sel,
        label: choiceLabel(idx),
        text,
        kind: "dropdown-option",
        optionValue: opt.value,
        optionIndex: [...sel.options].indexOf(opt),
      });
      idx += 1;
    }
    if (choices.length > 0) return choices;
  }

  // Priority 3: a single fill-in text/numerical input. We register a synthetic
  // "A" choice whose text is the input field itself, so downstream logic can
  // write the model's answer into the .value.
  const textInputs = [...question.querySelectorAll<HTMLInputElement>(TEXT_INPUT_SELECTOR)].filter(
    (i) => !i.disabled && !i.readOnly,
  );
  if (textInputs.length === 1) {
    const t = textInputs[0]!;
    choices.push({
      input: t,
      label: "A",
      text: t.placeholder || "(fill in your answer)",
      kind: "text-fill",
    });
  }

  return choices;
}

function choiceTypeForApi(c: AnswerChoice): "radio" | "checkbox" | "dropdown" | "text" {
  switch (c.kind) {
    case "checkbox": return "checkbox";
    case "dropdown-option": return "dropdown";
    case "text-fill": return "text";
    default: return "radio";
  }
}

function isAnswerSelect(sel: HTMLSelectElement): boolean {
  // Filter out unrelated selects (e.g., the CSV widget never has any).
  // Canvas answer-dropdowns have names matching answer_for_* or are inside .answers.
  const name = sel.name || "";
  if (/^answer_for_/i.test(name)) return true;
  if (sel.closest(".answers, .answer, .question_text, [data-testid*='question']")) return true;
  if (sel.classList.contains("question_input")) return true;
  return false;
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
  const seen = new Set<string>(); // dedupe by URL/data-hash

  for (const img of [...root.querySelectorAll<HTMLImageElement>("img")]) {
    const src = img.currentSrc || img.src;
    if (!src) continue;
    // Skip data: URIs that are tiny placeholders (1x1 spacers)
    if (src.startsWith("data:") && src.length < 200) continue;
    // Skip Canvas UI sprites (icons, avatars)
    if (/avatar|spinner|loading|icon-/.test(src)) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    try {
      const block = await urlToImageBlock(src);
      if (block) out.push(block);
    } catch {
      /* skip */
    }
  }
  for (const c of [...root.querySelectorAll<HTMLCanvasElement>("canvas")]) {
    try {
      const dataUrl = c.toDataURL("image/png");
      const data = dataUrl.split(",")[1];
      if (!data) continue;
      // Use a hash-ish key based on length (cheap, OK for dedup within one question)
      const key = `canvas:${data.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ data, mediaType: "image/png" });
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
