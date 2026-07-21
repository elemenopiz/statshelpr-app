/**
 * Canvas scraping + answer-key detection.
 *
 * The question/choice/image scraping mirrors the production content script
 * (apps/extension/src/content.ts) so captured fixtures match what /api/solve
 * actually receives at runtime — keep the SELECTORS_* lists in sync with that
 * file. What's new here is detectCorrectChoices(): on a *graded* Canvas page
 * (quiz results / submission history) Canvas renders the answer key inline, so
 * we can read the correct choice(s) straight off the DOM instead of
 * hand-labeling. That's the whole point of this tool.
 */

import type { ApiChoice, ImageBlock } from "./types";

// ---- selectors (mirror content.ts) -----------------------------------------

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

const QUESTION_SELECTOR = SELECTORS_QUESTION.join(",");
const CHOICE_INPUT_SELECTOR = 'input[type="radio"], input[type="checkbox"]';
const TEXT_INPUT_SELECTOR = [
  'input[type="text"]',
  'input[type="number"]',
  ".numerical_question_input",
  ".question_input",
].join(",");

// ---- public types ----------------------------------------------------------

/** A choice with its live DOM refs kept, so we can read `:checked` (manual
 * labeling) and inspect row classes (answer-key detection). */
export interface AnswerChoice {
  input: HTMLInputElement | HTMLSelectElement;
  row: HTMLElement | null;
  label: string;
  text: string;
  kind: "radio" | "checkbox" | "dropdown-option" | "text-fill";
  optionValue?: string;
  optionIndex?: number;
}

export interface ScrapedQuestion {
  text: string;
  choices: ApiChoice[];
  images: ImageBlock[];
  /** Rich choices (with element refs) for labeling/detection. */
  raw: AnswerChoice[];
}

export interface DetectionResult {
  /** Correct-answer labels found in the DOM, e.g. ["A","C"]. Empty if none. */
  labels: string[];
  /** True when Canvas exposed an answer key for this question. */
  hasKey: boolean;
}

// ---- question discovery -----------------------------------------------------

/** All answerable question containers on the page, de-nested (an outer and
 * inner match collapse to the outer, matching content.ts's behavior). */
export function findQuestions(root: ParentNode = document): HTMLElement[] {
  const found: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const sel of SELECTORS_QUESTION) {
    root.querySelectorAll<HTMLElement>(sel).forEach((q) => {
      if (seen.has(q)) return;
      if (hasQuestionAncestor(q)) return;
      if (!findStem(q)) return;
      seen.add(q);
      found.push(q);
    });
  }
  return found;
}

export function findStem(question: HTMLElement): HTMLElement | null {
  for (const sel of SELECTORS_STEM) {
    const el = question.querySelector<HTMLElement>(sel);
    if (el && (el.innerText || el.textContent)?.trim()) return el;
  }
  return null;
}

function hasQuestionAncestor(question: HTMLElement): boolean {
  const ancestor = question.parentElement?.closest<HTMLElement>(QUESTION_SELECTOR);
  return Boolean(ancestor && findStem(ancestor));
}

// ---- scraping ---------------------------------------------------------------

export async function scrapeQuestion(
  question: HTMLElement,
  opts: { includeImages: boolean },
): Promise<ScrapedQuestion> {
  const stem = findStem(question);
  if (!stem) throw new Error("Could not find question text.");
  const text = normalizeText(stem.innerText ?? stem.textContent ?? "");
  if (!text) throw new Error("Question text is empty.");

  const raw = collectChoices(question);
  const choices: ApiChoice[] = raw.map((c) => ({
    label: c.label,
    text: c.text,
    type: choiceTypeForApi(c),
  }));
  const images = opts.includeImages ? await collectImages(question) : [];
  return { text, choices, images, raw };
}

/** Synchronous choice collection (radio/checkbox → dropdown → text-fill), with
 * live element refs. Exported so the content script can read choices for
 * detection/labeling without awaiting image scraping. */
export function collectChoices(question: HTMLElement): AnswerChoice[] {
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
      row,
      label: choiceLabel(index),
      text,
      kind: input.type === "checkbox" ? "checkbox" : "radio",
    });
  });
  if (choices.length > 0) return choices;

  // Priority 2: dropdown <select> answer fields (Classic dropdown / T-F).
  const selects = [...question.querySelectorAll<HTMLSelectElement>("select")].filter(isAnswerSelect);
  if (selects.length > 0) {
    const sel = selects[0]!;
    let idx = 0;
    for (const opt of [...sel.querySelectorAll("option")]) {
      const text = normalizeText(opt.textContent ?? "");
      if (!text || /^\[?\s*(select|choose)\s*\]?\s*\.{0,3}$/i.test(text)) continue;
      choices.push({
        input: sel,
        row: opt.closest(".answer") as HTMLElement | null,
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

  // Priority 3: a single fill-in text/numerical input.
  const textInputs = [...question.querySelectorAll<HTMLInputElement>(TEXT_INPUT_SELECTOR)];
  if (textInputs.length === 1) {
    const t = textInputs[0]!;
    choices.push({
      input: t,
      row: getChoiceRow(t),
      label: "A",
      text: t.placeholder || "(fill in your answer)",
      kind: "text-fill",
    });
  }
  return choices;
}

function choiceTypeForApi(c: AnswerChoice): ApiChoice["type"] {
  switch (c.kind) {
    case "checkbox":
      return "checkbox";
    case "dropdown-option":
      return "dropdown";
    case "text-fill":
      return "text";
    default:
      return "radio";
  }
}

// ---- answer-key detection (the interesting part) ----------------------------

/**
 * Read the correct answer(s) off a graded Canvas page.
 *
 * Classic Quizzes results pages tag the correct answer row with
 * `.correct_answer` (and add `.answer_arrow.correct`); the question holder
 * gets `.correct`/`.incorrect`. New Quizzes is less consistent, so we also
 * accept generic "correct" signals on the row (class / aria-label / testid),
 * always excluding the substring trap in "incorrect".
 *
 * Returns the labels of every choice the DOM marks correct. `hasKey` is false
 * when nothing on the question looks graded — the caller then falls back to
 * manual labeling from the user's own selection.
 */
export function detectCorrectChoices(_question: HTMLElement, raw: AnswerChoice[]): DetectionResult {
  const labels: string[] = [];
  for (const c of raw) {
    if (c.kind === "dropdown-option" || c.kind === "text-fill") continue;
    if (isRowMarkedCorrect(c.row)) labels.push(c.label);
  }
  return { labels, hasKey: labels.length > 0 };
}

/** Whether this question is on a graded/review page at all (even if we found
 * no correct row — e.g. a dropdown question we can't auto-key). */
export function looksGraded(question: HTMLElement): boolean {
  if (question.querySelector(".correct_answer, .answer_arrow.correct, .selected_answer")) return true;
  const holder = question.closest(".question, .question_holder, .display_question") as HTMLElement | null;
  if (holder && (holder.classList.contains("correct") || holder.classList.contains("incorrect"))) {
    return true;
  }
  return /\/(history|submissions|moderate)\b/.test(location.pathname);
}

function isRowMarkedCorrect(row: HTMLElement | null): boolean {
  if (!row) return false;
  // Classic Quizzes: the correct answer row carries `.correct_answer`.
  if (hasCorrectClass(row) || row.closest(".correct_answer")) return true;
  if (row.querySelector(".answer_arrow.correct")) return true;
  // Generic signals (New Quizzes / themed markup).
  const aria = (row.getAttribute("aria-label") || "").toLowerCase();
  if (isCorrectWord(aria)) return true;
  const testid = (row.getAttribute("data-testid") || "").toLowerCase();
  if (isCorrectWord(testid)) return true;
  return false;
}

function hasCorrectClass(el: HTMLElement): boolean {
  for (const cls of el.classList) {
    if (isCorrectWord(cls)) return true;
  }
  return false;
}

/** "correct" present but not as part of "incorrect". */
function isCorrectWord(s: string): boolean {
  return /correct/.test(s) && !/incorrect/.test(s);
}

/** Labels of the choices the user has currently selected — used for manual
 * labeling on live (ungraded) quizzes: the user picks the right answer, we
 * record their selection. */
export function selectedChoiceLabels(raw: AnswerChoice[]): string[] {
  const out: string[] = [];
  for (const c of raw) {
    if (c.kind === "radio" || c.kind === "checkbox") {
      if ((c.input as HTMLInputElement).checked) out.push(c.label);
    } else if (c.kind === "dropdown-option") {
      const sel = c.input as HTMLSelectElement;
      if (c.optionValue !== undefined && sel.value === c.optionValue) out.push(c.label);
    }
  }
  return out;
}

// ---- choice text / row helpers (mirror content.ts) --------------------------

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

function isAnswerSelect(sel: HTMLSelectElement): boolean {
  const name = sel.name || "";
  if (/^answer_for_/i.test(name)) return true;
  if (sel.closest(".answers, .answer, .question_text, [data-testid*='question']")) return true;
  if (sel.classList.contains("question_input")) return true;
  return false;
}

// ---- images (mirror content.ts) --------------------------------------------

async function collectImages(root: HTMLElement): Promise<ImageBlock[]> {
  const out: ImageBlock[] = [];
  const seen = new Set<string>();
  for (const img of [...root.querySelectorAll<HTMLImageElement>("img")]) {
    const src = img.currentSrc || img.src;
    if (!src) continue;
    if (src.startsWith("data:") && src.length < 200) continue;
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

// ---- small utils ------------------------------------------------------------

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function choiceLabel(index: number): string {
  return String.fromCharCode(65 + index);
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
