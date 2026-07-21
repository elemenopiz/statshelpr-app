/**
 * Canvas content script — tiny inline "solve" button next to each question.
 *
 * Flow on click:
 *   1. Set button to spinner (visual "thinking" feedback)
 *   2. Scrape question text + answer choices + any images
 *   3. POST /api/solve (SSE) — either a "concept" result, or a "rcode"
 *      hand-off that's run locally via WebR and interpreted by /api/interpret
 *      (SSE) — see onSolve() for the full branch.
 *   4. Parse the answer letter, find the matching radio/checkbox, click it
 *   5. Set button to ✓ briefly, then back to "solve" (re-clickable)
 *
 * No answer card, no explanation, no R code display — status during the
 * (rare, R-only) multi-step path surfaces only as the button's hover title.
 *
 * A small floating CSV widget in the bottom-right manages course-wide data
 * files, persisted in chrome.storage.local across sessions.
 *
 * RCODE questions (server hands back R code instead of a final answer): WebR
 * (R compiled to WebAssembly, see ./webr-runner) runs the code right here in
 * the content script, then the stdout is POSTed to /api/interpret for the
 * LLM to turn into a final answer — see the RCODE branch in onSolve().
 */

import { getInstallId } from "./install-id";
import { initWebR, runR } from "./webr-runner";

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

// =============================================================================
// /api/solve + /api/interpret — both stream Server-Sent Events. "phase" and
// "delta" events exist for a richer streaming UI; the inline button UX here
// doesn't render them (no panel to update) so they're consumed and ignored —
// only the terminal "result"/"error" event matters to onSolve.
// =============================================================================

interface ConceptResult {
  mode: "concept";
  answer: string;
  selectedChoices?: string[];
  confidence: "High" | "Med" | "Low" | "";
  lowConfidence: boolean;
}

/** /api/solve hands off to the client when the question needs R: the server
 * sends back the R code to run (via WebR) instead of running it itself. */
interface RCodeResult {
  mode: "rcode";
  rCode: string;
  assistantBody: string;
}

/** Final answer after WebR ran the R code and /api/interpret reasoned over
 * its stdout. */
interface CalcResult {
  mode: "calc";
  rCode: string;
  rOutput: string;
  rExitCode: number;
  rDurationMs: number;
  answer: string;
  selectedChoices?: string[];
  confidence: "High" | "Med" | "Low" | "";
  lowConfidence: boolean;
}

type SolveResult = ConceptResult | RCodeResult | CalcResult;

type SseEvent =
  | { type: "phase"; label: string }
  | { type: "delta"; text: string }
  | { type: "result"; result: SolveResult }
  | { type: "error"; message: string };

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

/** Local mirror of the server's 24h rolling solve counter so the popup can
 * show "n of 5 left today" without an extra endpoint. Server stays the
 * authority — on a 402 we sync to its resetAt. */
const STORAGE_KEY_SOLVE_STATS = "statshelpr.solveStats";
const FREE_DAILY_LIMIT = 5;
const SOLVE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface SolveStats {
  count: number;
  resetAt: number;
}

let dataFiles: DataFile[] = [];

// =============================================================================
// boot
// =============================================================================

function boot() {
  void loadFiles().then(() => scanAndInject());

  // Load user's button-opacity preference and apply it as a CSS variable
  // (--sh-idle-opacity) that panel.css reads. The variable is set on the
  // document root so it applies to every injected button, and re-applied
  // whenever the user drags the popup slider.
  void applyButtonOpacityFromStorage();

  // Preload WebR in the background the moment we mount on a Canvas page, so
  // the (one-time, ~15s) boot happens invisibly while the user reads the
  // quiz instead of blocking their first RCODE solve. Fire-and-forget: we
  // swallow failures here rather than surface them before the user has even
  // asked for a solve — a real RCODE attempt will call initWebR()/runR()
  // itself and report the same (cached) failure through the button's error
  // state instead.
  initWebR().catch(() => {
    /* swallowed — see comment above */
  });

  // Re-load CSVs (and re-apply opacity) whenever the popup updates them so
  // freshly-uploaded files / settings changes are picked up without reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY_FILES]) {
      void loadFiles();
    }
    if (area === "sync" && changes["buttonOpacity"]) {
      const next = changes["buttonOpacity"].newValue;
      if (typeof next === "number") applyButtonOpacity(next);
    }
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
    className: "statshelpr-btn-tutor",
    type: "button",
    text: "·",
    title: "",
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
    const wrap = mkEl("div", { className: "statshelpr-tutor-wrap" });
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
// solve flow
// =============================================================================
//
// /api/solve always streams SSE. Two outcomes:
//   - mode "concept" — done, render like any other result.
//   - mode "rcode"   — server wants R run client-side. We boot WebR (lazy,
//     cached — see webr-runner.ts), run the code, then POST the stdout to
//     /api/interpret (also SSE) for the LLM to turn into a final answer.

async function onSolve(question: HTMLElement, btn: HTMLButtonElement) {
  if (btn.disabled) return;
  setBtnState(btn, "loading");
  // Clear any prior visual marker on this question
  question.querySelectorAll(".statshelpr-suggested").forEach((el) =>
    el.classList.remove("statshelpr-suggested"),
  );

  // Refresh CSVs from storage in case the popup uploaded a file while we
  // were already on the Canvas page.
  await loadFiles();

  let scraped: ScrapedQuestion;
  try {
    scraped = await scrapeQuestion(question);
  } catch (e) {
    setBtnState(btn, "error", (e as Error).message);
    return;
  }

  const cfg = await getConfig();
  const apiUrl = (cfg.apiUrl ?? "https://api.statshelpr.com").replace(/\/$/, "");
  const licenseKey = cfg.licenseKey ?? "";
  const installId = await getInstallId();
  // Shared by both /api/solve and /api/interpret below — the install id lets
  // the server bucket the free-tier rate limit per install (see install-id.ts).
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    "X-Install-Id": installId,
    ...(licenseKey ? { Authorization: `Bearer ${licenseKey}` } : {}),
  };
  const apiChoices = scraped.choices.map((c) => ({
    label: c.label,
    text: c.text,
    type: choiceTypeForApi(c),
  }));
  const apiDataFiles = dataFiles.map((f) => ({ filename: f.filename, content: f.content }));

  let final: ConceptResult | CalcResult;
  try {
    const solveRes = await fetch(`${apiUrl}/api/solve`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        questionText: scraped.text,
        choices: apiChoices,
        images: scraped.images,
        dataFiles: apiDataFiles,
      }),
    });
    if (!solveRes.ok) {
      const bodyText = await solveRes.text();
      if (solveRes.status === 402) {
        // Daily limit — sync the local counter to the server's window.
        let resetAt: number | undefined;
        try {
          resetAt = (JSON.parse(bodyText) as { resetAt?: number }).resetAt;
        } catch {
          /* body wasn't JSON — keep our own resetAt */
        }
        void recordSolveLimitHit(resetAt);
      }
      throw new Error(extractErrorMsg(bodyText));
    }
    // Passed the rate limiter — the server counted this solve, mirror it.
    void recordSolveUse();
    const solveResult = await consumeSseResult(solveRes);

    if (solveResult.mode === "concept") {
      final = solveResult;
    } else if (solveResult.mode === "rcode") {
      // RCODE — run R locally via WebR, then have the server interpret it.
      // No panel in this button-only UI, so the button's title attribute (a
      // native hover tooltip) is the only status surface we have.
      btn.setAttribute("title", "Running R…");

      // Race a short timeout so we only show the "first-time setup" message
      // when the (one-time, ~15s) WebR boot is actually happening — repeat
      // solves reuse the already-booted instance and this resolves instantly.
      const raceOutcome = await Promise.race([
        initWebR().then(() => "ready" as const),
        sleep(500).then(() => "slow" as const),
      ]);
      if (raceOutcome === "slow") {
        btn.setAttribute("title", "First-time setup, ~15s…");
        await initWebR(); // same cached boot promise — just waiting it out
        btn.setAttribute("title", "Running R…");
      }

      const runResult = await runR(solveResult.rCode, apiDataFiles);

      btn.setAttribute("title", "Interpreting result…");
      const interpretRes = await fetch(`${apiUrl}/api/interpret`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          questionText: scraped.text,
          choices: apiChoices,
          images: scraped.images,
          dataFiles: apiDataFiles,
          rCode: solveResult.rCode,
          stdout: runResult.stdout,
          exitCode: runResult.exitCode,
          durationMs: runResult.durationMs,
          assistantBody: solveResult.assistantBody,
        }),
      });
      if (!interpretRes.ok) throw new Error(await readErrorBody(interpretRes));
      const interpretResult = await consumeSseResult(interpretRes);
      if (interpretResult.mode !== "calc") {
        throw new Error("Unexpected response from interpreter.");
      }
      final = interpretResult;
    } else {
      throw new Error("Unexpected response from solve.");
    }
  } catch (e) {
    setBtnState(btn, "error", (e as Error).message);
    return;
  }

  const cleaned = stripTags(final.answer);
  selectAnswerChoice(question, cleaned, final.selectedChoices ?? []);
  setBtnState(btn, "success");
}

async function readErrorBody(res: Response): Promise<string> {
  return extractErrorMsg(await res.text());
}

function extractErrorMsg(body: string): string {
  // Try to extract the {error: "..."} field from a JSON error response
  let msg = body.slice(0, 200);
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (parsed.error) msg = parsed.error;
  } catch {
    /* not JSON — use raw body */
  }
  return msg;
}

/** Mirror one counted solve into chrome.storage.local for the popup meter.
 * Fire-and-forget: never lets bookkeeping break a solve. */
async function recordSolveUse(): Promise<void> {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEY_SOLVE_STATS);
    const prev = r[STORAGE_KEY_SOLVE_STATS] as SolveStats | undefined;
    const now = Date.now();
    const next: SolveStats =
      !prev || prev.resetAt < now
        ? { count: 1, resetAt: now + SOLVE_WINDOW_MS }
        : { count: prev.count + 1, resetAt: prev.resetAt };
    await chrome.storage.local.set({ [STORAGE_KEY_SOLVE_STATS]: next });
  } catch {
    /* tracking only */
  }
}

/** The server said the daily cap is hit — pin the local mirror to it. */
async function recordSolveLimitHit(resetAt?: number): Promise<void> {
  try {
    const next: SolveStats = {
      count: FREE_DAILY_LIMIT,
      resetAt: resetAt ?? Date.now() + SOLVE_WINDOW_MS,
    };
    await chrome.storage.local.set({ [STORAGE_KEY_SOLVE_STATS]: next });
  } catch {
    /* tracking only */
  }
}

/**
 * Read an SSE response stream down to its terminal "result" event.
 * "phase"/"delta" events are consumed and ignored — this button-only UI has no
 * panel to stream text into, only the button's spinner/title.
 */
async function consumeSseResult(res: Response): Promise<SolveResult> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Empty response stream.");
  const decoder = new TextDecoder();
  let buf = "";
  let result: SolveResult | null = null;
  let errorMsg: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const jsonStr = dataLine.slice(5).trim();
      if (!jsonStr) continue;
      let evt: SseEvent;
      try {
        evt = JSON.parse(jsonStr) as SseEvent;
      } catch {
        continue; // malformed frame — skip it
      }
      if (evt.type === "result") result = evt.result;
      else if (evt.type === "error") errorMsg = evt.message;
    }
  }

  if (errorMsg) throw new Error(errorMsg);
  if (!result) throw new Error("No result received from server.");
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      return;
    case "success":
      btn.classList.add("success");
      btn.disabled = false;
      btn.textContent = "✓";
      // Revert to default state after a moment so it's re-clickable
      setTimeout(() => {
        if (btn.classList.contains("success")) setBtnState(btn, "default");
      }, 1800);
      return;
    case "error":
      btn.classList.add("error");
      btn.disabled = false;
      btn.textContent = "!";
      btn.setAttribute("title", errorMsg ?? "");
      return;
    default:
      btn.disabled = false;
      btn.textContent = "·";
      btn.setAttribute("title", "");
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
    sel.classList.add("statshelpr-suggested");
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
  sel.classList.add("statshelpr-suggested");
}

function fillTextInput(input: HTMLInputElement, answer: string) {
  if (input.disabled || input.readOnly) {
    input.classList.add("statshelpr-suggested");
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
  input.classList.add("statshelpr-suggested");
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
  const selected = new Map<HTMLInputElement | HTMLSelectElement, AnswerChoice>();

  const answerLine =
    answer.match(/^\s*Answer\s*:?\s*(.+)$/im)?.[1] ??
    answer.match(/correct(?:\s+interpretation)?(?:\(s\))?\s*:?\s*(.+)$/im)?.[1] ??
    answer;

  for (const m of answerLine.matchAll(/\b([A-Z])\b/g)) {
    const letter = m[1];
    if (!letter) continue;
    const c = byLabel.get(letter.toUpperCase());
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
    row?.classList.add("statshelpr-suggested");
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
  row?.classList.add("statshelpr-suggested");
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
// storage
// =============================================================================
//
// Data files are managed in the extension popup (drag-drop or file picker) and
// stored in chrome.storage.local. The content script reads them whenever a
// Solve fires, and listens for storage changes so a freshly-uploaded CSV is
// visible without reloading the Canvas tab.

async function loadFiles() {
  const r = await chrome.storage.local.get(STORAGE_KEY_FILES);
  const stored = (r[STORAGE_KEY_FILES] as DataFile[] | undefined) ?? [];
  const now = Date.now();
  dataFiles = stored.filter((f) => now - f.addedAt < FILE_TTL_MS);
}

async function applyButtonOpacityFromStorage(): Promise<void> {
  const r = (await chrome.storage.sync.get(["buttonOpacity"])) as {
    buttonOpacity?: number;
  };
  applyButtonOpacity(typeof r.buttonOpacity === "number" ? r.buttonOpacity : 0.2);
}

function applyButtonOpacity(value: number): void {
  // Clamp to a sane range so a bad stored value can't blow past 1.0 or go
  // negative. Paid users can drag the popup slider to 0 (fully invisible) —
  // gating who's allowed to write a low value is the popup's job, not ours.
  const clamped = Math.min(1, Math.max(0, value));
  document.documentElement.style.setProperty("--sh-idle-opacity", String(clamped));
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
  if (opts.type && tag === "button")
    (node as HTMLButtonElement).type = opts.type as HTMLButtonElement["type"];
  if (opts.text !== undefined) node.textContent = opts.text;
  for (const c of children) {
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function clear(node: HTMLElement) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
