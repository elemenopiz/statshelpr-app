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

import type { AnswerSource, ApiChoice, CaptureOutcome, ImageBlock } from "./types";

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

  // Priority 3: a fill-in / numerical input. Match any text-like input (incl.
  // type-less and disabled/readonly ones — on a graded review the answer box is
  // disabled but still holds the value). When several exist, prefer the one that
  // actually carries an answer value.
  const textInputs = [
    ...question.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
  ].filter(isTextLike);
  if (textInputs.length >= 1) {
    const t =
      textInputs.find((i) => (i.value ?? "").trim()) ??
      textInputs.find((i) => i.classList.contains("question_input") || i.classList.contains("numerical_question_input")) ??
      textInputs[0]!;
    choices.push({
      input: t as HTMLInputElement,
      row: getChoiceRow(t as HTMLInputElement),
      label: "A",
      text: (t as HTMLInputElement).placeholder || "(fill in your answer)",
      kind: "text-fill",
    });
  }
  return choices;
}

/** A text-entry input (text/number/type-less/textarea), excluding the
 * structural input types. */
function isTextLike(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (el.tagName === "TEXTAREA") return true;
  const t = (el.getAttribute("type") || "text").toLowerCase();
  return !["radio", "checkbox", "hidden", "submit", "button", "file", "image", "reset"].includes(t);
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
      // input.checked on a live/graded input, or Canvas's `.selected_answer`
      // marker on the row (some submission views only set the class).
      if ((c.input as HTMLInputElement).checked || c.row?.classList.contains("selected_answer")) {
        out.push(c.label);
      }
    } else if (c.kind === "dropdown-option") {
      const sel = c.input as HTMLSelectElement;
      if (c.optionValue !== undefined && sel.value === c.optionValue) out.push(c.label);
    }
  }
  return out;
}

/** Whole-submission full marks, read from the page ("Score for this attempt:
 * X out of Y" or "Grade: X / Y"). When true, every answered question on an
 * answers-hidden submission is correct — the student aced it. Uses textContent
 * (no layout cost) so it's cheap to call per question. */
export function submissionFullMarks(): boolean {
  const text = document.body?.textContent || document.documentElement?.textContent || "";
  const m =
    text.match(/Score for this attempt:\s*([\d.]+)\s*(?:out of|\/)\s*([\d.]+)/i) ||
    text.match(/\bGrade:\s*([\d.]+)\s*\/\s*([\d.]+)/i) ||
    text.match(/\bScore:\s*([\d.]+)\s*(?:out of|\/)\s*([\d.]+)/i);
  return m ? parseFloat(m[2]!) > 0 && parseFloat(m[1]!) >= parseFloat(m[2]!) : false;
}

/** True when the choices are read-only (a graded submission review), false on a
 * live quiz where the inputs are still editable. */
export function isReadOnly(raw: AnswerChoice[]): boolean {
  return raw.length > 0 && raw.every((c) => (c.input as HTMLInputElement | HTMLSelectElement).disabled);
}

/** Right/wrong for a graded question: Canvas Classic tags the question
 * `.correct`/`.incorrect`; failing that, parse the per-question "X / Y pts". */
export function questionCorrectness(question: HTMLElement): "correct" | "incorrect" | null {
  const nodes = [question, ...question.querySelectorAll<HTMLElement>(".question, .display_question")];
  for (const n of nodes) if (n.classList.contains("incorrect")) return "incorrect";
  for (const n of nodes) if (n.classList.contains("correct")) return "correct";
  const score = questionScore(question);
  if (score) return score.possible > 0 && score.earned >= score.possible ? "correct" : "incorrect";
  return null;
}

/** Parse earned/possible points from a graded question header. */
export function questionScore(question: HTMLElement): { earned: number; possible: number } | null {
  const m = (question.textContent || "").match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*pts?\b/i);
  if (m) return { earned: parseFloat(m[1]!), possible: parseFloat(m[2]!) };
  const up = question.querySelector(".user_points");
  const qp = question.querySelector(".question_points, .points");
  if (up && qp) {
    const e = parseFloat((up.textContent || "").replace(/[^\d.]/g, ""));
    const p = parseFloat((qp.textContent || "").replace(/[^\d.]/g, ""));
    if (!Number.isNaN(e) && !Number.isNaN(p)) return { earned: e, possible: p };
  }
  return null;
}

export interface AnswerReadout {
  selectedChoices: string[];
  correctChoices: string[];
  /** For fill-in/numerical questions: the entered value (e.g. "0.073"). When
   * verified, this is the correct answer; otherwise it's the student's entry. */
  answerText?: string;
  outcome: CaptureOutcome;
  answerSource: AnswerSource;
  verified: boolean;
}

/**
 * Everything we can establish about a graded question's answer:
 *   - Canvas shows the key (.correct_answer)      → verified from answer-key.
 *   - answers hidden, question marked full-marks  → the student's own pick is
 *     correct → verified from self-correct.
 *   - answers hidden, question wrong / unscorable → unverified (question + the
 *     student's pick kept for the pool, correct answer unknown).
 */
export function readGradedAnswer(question: HTMLElement, raw: AnswerChoice[]): AnswerReadout {
  // Fill-in / numerical: the answer is the input value, not a choice letter.
  const fill = raw.find((c) => c.kind === "text-fill");
  if (fill) {
    const value = ((fill.input as HTMLInputElement).value ?? "").trim();
    const correctness = questionCorrectness(question);
    const isCorrect = correctness === "correct" || (correctness === null && submissionFullMarks());
    if (value && isCorrect) {
      return { selectedChoices: [], correctChoices: [], answerText: value, outcome: "correct", answerSource: "self-correct", verified: true };
    }
    return {
      selectedChoices: [],
      correctChoices: [],
      answerText: value,
      outcome: correctness === "incorrect" ? "incorrect" : "unknown",
      answerSource: "none",
      verified: false,
    };
  }

  const selectedChoices = selectedChoiceLabels(raw);
  const key = detectCorrectChoices(question, raw);
  if (key.hasKey) {
    return {
      selectedChoices,
      correctChoices: key.labels,
      outcome: sameSet(selectedChoices, key.labels) ? "correct" : "incorrect",
      answerSource: "answer-key",
      verified: true,
    };
  }
  const correctness = questionCorrectness(question);
  if (correctness === "correct" && selectedChoices.length > 0) {
    return { selectedChoices, correctChoices: selectedChoices, outcome: "correct", answerSource: "self-correct", verified: true };
  }
  if (correctness === "incorrect") {
    return { selectedChoices, correctChoices: [], outcome: "incorrect", answerSource: "none", verified: false };
  }
  // No per-question signal (e.g. the compact "Submission Details" view shows no
  // per-question points), but the whole submission is full marks → every pick
  // is correct.
  if (correctness === null && selectedChoices.length > 0 && submissionFullMarks()) {
    return { selectedChoices, correctChoices: selectedChoices, outcome: "correct", answerSource: "self-correct", verified: true };
  }
  return { selectedChoices, correctChoices: [], outcome: "unknown", answerSource: "none", verified: false };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a.map((x) => x.toUpperCase()));
  return b.every((x) => s.has(x.toUpperCase()));
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
    // currentSrc/src for loaded images; data-src/data-original for lazy-loaded
    // ones that haven't scrolled into view yet.
    const src =
      img.currentSrc ||
      img.src ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      "";
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
