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
 *
 * Classic Quizzes markup facts this file relies on (verified against a real
 * graded submission):
 *   - Every .question_holder embeds a hidden `.original_question_text` block
 *     whose `textarea[name=question_text]` holds the AUTHORED question HTML —
 *     never an answer. Each answer row also carries a hidden
 *     `input[name=answer_text]` with the row's text. Both must be excluded
 *     from fill-in answer detection.
 *   - `<span class="question_type">` states the question type outright
 *     (multiple_choice_question, matching_question, numerical_question, …).
 *   - Graded matching questions render ENABLED selects containing only the
 *     chosen option; graded numerical inputs are `readonly`, not `disabled`.
 *   - A matching row's left-hand prompt lives in `.answer_match_left`.
 */

import type { AnswerSource, ApiChoice, BlankAnswer, CaptureOutcome, ImageBlock } from "./types";
import { normalizeText, dedupeDoubled } from "@statshelpr/solver-core/core/text";

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
  /** The authored question HTML from Canvas's hidden question_text textarea
   * (clean links/code blocks/img tags; no screen-reader noise). Classic only. */
  questionHtml: string | null;
  /** Rendered outerHTML of the question container at scrape time — inputs,
   * selects, labels, answer rows and all (unlike questionHtml above, not
   * limited to Classic Quizzes' hidden textarea). Fixture material for a
   * future jsdom/happy-dom write-back test harness; null if the snapshot
   * failed. */
  questionDomHtml: string | null;
  /** Canvas's own question type, e.g. "matching_question". Classic only. */
  questionType: string | null;
  /** Canvas's numeric question id (stable across attempts). */
  canvasQuestionId: string | null;
  choices: ApiChoice[];
  images: ImageBlock[];
  /** Every candidate image URL found on the question — recorded even when the
   * byte-fetch fails, so missing images are visible instead of silent. */
  imageUrls: string[];
  /** Rich choices (with element refs) for labeling/detection. */
  raw: AnswerChoice[];
  /** Blanks for a multiple-dropdowns / matching question (empty otherwise). */
  blanks: RawBlank[];
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

// ---- question metadata (Classic Quizzes) ------------------------------------

/** Canvas's own question type ("matching_question", "numerical_question", …)
 * from the .question_type span, falling back to the *_question class token. */
export function questionTypeOf(question: HTMLElement): string | null {
  const span = question.querySelector(".question_type");
  const fromSpan = normalizeText(span?.textContent ?? "");
  if (/^[a-z_]+_question$/.test(fromSpan)) return fromSpan;
  const el = question.classList.contains("question")
    ? question
    : question.querySelector(".question, .display_question");
  for (const cls of el?.classList ?? []) {
    if (/^[a-z_]+_question$/.test(cls) && cls !== "display_question") return cls;
  }
  return null;
}

/** Canvas's numeric question id (e.g. "32223284"), stable across attempts. */
export function canvasQuestionIdOf(question: HTMLElement): string | null {
  const ids = [question.id, ...[...question.querySelectorAll<HTMLElement>("[id^='question_']")].map((e) => e.id)];
  for (const id of ids) {
    const m = (id ?? "").match(/^question_(\d+)$/);
    if (m) return m[1]!;
  }
  const href = question.querySelector<HTMLAnchorElement>("a.update_question_url")?.getAttribute("href") ?? "";
  return href.match(/\/questions\/(\d+)/)?.[1] ?? null;
}

/** The authored question HTML from the hidden original_question_text textarea. */
export function questionHtmlOf(question: HTMLElement): string | null {
  const ta = question.querySelector<HTMLTextAreaElement>(
    ".original_question_text textarea[name='question_text'], textarea.textarea_question_text",
  );
  const v = ta?.value?.trim();
  return v || null;
}

// ---- DOM snapshot (rendered question, for a future write-back test harness) -

/** Class/id prefixes of UI our own extensions inject or mark onto the page:
 * this file's own capture pill/panel (`shcap-*`) and the production tutor's
 * button/suggestion highlighting (`statshelpr-*`, apps/extension/src/content.ts).
 * The README explicitly supports loading both at once ("all injected UI is
 * shcap-prefixed so the two never collide"), so a capture can carry either. */
const INJECTED_UI_PREFIXES = ["shcap", "statshelpr"];

const MAX_QUESTION_DOM_HTML_BYTES = 512 * 1024;

/** Rendered outerHTML of the question container at scrape time — inputs,
 * selects, labels, answer rows and all (questionHtmlOf() above is stem-only
 * and Classic-only; this is the whole rendered container, every question
 * type). Fixture material for a future jsdom/happy-dom write-back test
 * harness. Works on a detached clone — the live page is never touched. Strips
 * only scripts/styles and our own extensions' injected UI; no other
 * transformation, since markup fidelity is the whole point. Capped at 512KB
 * as a last-resort safety net, not a normal path. */
export function questionDomHtmlOf(question: HTMLElement): string | null {
  try {
    const clone = question.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script, style").forEach((n) => n.remove());
    stripInjectedUi(clone);
    const html = clone.outerHTML;
    return html ? capBytes(html, MAX_QUESTION_DOM_HTML_BYTES) : null;
  } catch {
    return null;
  }
}

/** Remove our own extensions' injected UI from a detached clone. A matching
 * wrapper/button is dropped outright; a matching node that IS or CONTAINS a
 * real form control is kept (only the offending class/id is stripped) — the
 * production tutor marks Canvas's own `<select>`/`<input>`/answer row with
 * `.statshelpr-suggested` rather than always wrapping it, and deleting those
 * would throw away exactly the inputs this snapshot exists to capture. */
function stripInjectedUi(root: HTMLElement): void {
  for (const el of [...root.querySelectorAll<HTMLElement>("*")]) {
    if (!root.contains(el) || !isInjectedUi(el)) continue; // already removed with an ancestor
    if (/^(?:input|select|textarea|option)$/i.test(el.tagName) || el.querySelector("input, select, textarea")) {
      stripInjectedMarkers(el);
    } else {
      el.remove();
    }
  }
  if (isInjectedUi(root)) stripInjectedMarkers(root); // defensive; shouldn't happen
}

function isInjectedUi(el: Element): boolean {
  const starts = (s: string) => INJECTED_UI_PREFIXES.some((p) => s.startsWith(p));
  if (el.id && starts(el.id)) return true;
  for (const cls of el.classList) if (starts(cls)) return true;
  return false;
}

function stripInjectedMarkers(el: Element): void {
  const starts = (s: string) => INJECTED_UI_PREFIXES.some((p) => s.startsWith(p));
  if (el.id && starts(el.id)) el.removeAttribute("id");
  for (const cls of [...el.classList]) if (starts(cls)) el.classList.remove(cls);
  if (el.classList.length === 0) el.removeAttribute("class");
}

/** Matches trailing U+FFFD replacement char(s) left by decoding a multi-byte
 * UTF-8 sequence that capBytes() cut in half. Built via fromCharCode to keep
 * that code point out of the source as a literal. */
const BAD_UTF8_TAIL = new RegExp(`${String.fromCharCode(0xfffd)}+$`);

/** Truncate to at most `maxBytes` UTF-8 bytes without leaving a dangling
 * multi-byte character at the cut point. A stray cut mid-tag is fine — this is
 * a last-resort safety cap, not a feature. */
function capBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(BAD_UTF8_TAIL, "");
}

// ---- text extraction --------------------------------------------------------

/** Element text with Canvas's screen-reader helper spans ("Links to an
 * external site.") and scripts/styles removed. Works on a detached clone so
 * the page is never mutated. */
export function cleanText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script, style, .screenreader-only").forEach((n) => n.remove());
  return normalizeText(clone.textContent ?? "");
}

/** The question's stem text (cleaned) — the canonical capture id source, used
 * by both scraping and the content script's dedupe hashing. */
export function scrapeStemText(question: HTMLElement): string {
  const stem = findStem(question);
  return stem ? cleanText(stem) : "";
}

// ---- scraping ---------------------------------------------------------------

export async function scrapeQuestion(
  question: HTMLElement,
  opts: { includeImages: boolean },
): Promise<ScrapedQuestion> {
  const stem = findStem(question);
  if (!stem) throw new Error("Could not find question text.");
  const text = cleanText(stem);
  if (!text) throw new Error("Question text is empty.");

  const raw = collectChoices(question);
  const choices: ApiChoice[] = raw.map((c) => ({
    label: c.label,
    text: c.text,
    type: choiceTypeForApi(c),
  }));
  const { images, imageUrls } = opts.includeImages
    ? await collectImages(question)
    : { images: [], imageUrls: [] };
  return {
    text,
    questionHtml: questionHtmlOf(question),
    questionDomHtml: questionDomHtmlOf(question),
    questionType: questionTypeOf(question),
    canvasQuestionId: canvasQuestionIdOf(question),
    choices,
    images,
    imageUrls,
    raw,
    blanks: collectBlanks(question),
  };
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
    const text = dedupeDoubled(getChoiceText(input));
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

  // Priority 2: a SINGLE dropdown <select> answer field (Classic dropdown /
  // T-F). Multiple answer selects = a "multiple dropdowns" / matching question,
  // handled as blanks by collectBlanks() — not flattened into choices here.
  const selects = collectAnswerSelects(question);
  if (selects.length === 1) {
    const sel = selects[0]!;
    let idx = 0;
    for (const opt of [...sel.querySelectorAll("option")]) {
      const text = dedupeDoubled(opt.textContent ?? "");
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

  // Priority 3: a fill-in / numerical input. Only *visible, answer-bearing*
  // fields qualify: Canvas hides the authored question HTML in a
  // `textarea[name=question_text]` and each answer row's text in an
  // `input[name=answer_text]` — sweeping those in is how a capture ends up
  // with the question HTML as its "answer". Prefer Canvas's canonical answer
  // box (.question_input / .numerical_question_input) over other inputs.
  const textInputs = [
    ...question.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
  ]
    .filter(isTextLike)
    .filter((el) => !isNonAnswerField(el));
  if (textInputs.length >= 1) {
    const t =
      textInputs.find(
        (i) => i.classList.contains("question_input") || i.classList.contains("numerical_question_input"),
      ) ??
      textInputs.find((i) => (i.value ?? "").trim()) ??
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

/** Canvas metadata fields that look like text inputs but never hold the
 * student's answer (hidden authored-HTML/row-text stores), plus anything not
 * actually visible on the page. */
function isNonAnswerField(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (el.closest(".original_question_text")) return true;
  const name = el.getAttribute("name") ?? "";
  if (["answer_text", "question_text", "text_after_answers", "answer_selection_type"].includes(name)) return true;
  return !isVisible(el);
}

function isVisible(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === "function") return el.checkVisibility();
  return el.offsetParent !== null || el.getClientRects().length > 0;
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

/** True when the choices are read-only (a graded submission review), false on
 * a live quiz where the inputs are still editable. Canvas marks graded
 * numerical inputs `readonly` (not `disabled`), so honor both. */
export function isReadOnly(raw: AnswerChoice[]): boolean {
  return (
    raw.length > 0 &&
    raw.every((c) => {
      const el = c.input as HTMLInputElement | HTMLSelectElement;
      return el.disabled || ("readOnly" in el && (el as HTMLInputElement).readOnly);
    })
  );
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
  /** For multiple-dropdowns / matching questions: one entry per blank. */
  blanks?: BlankAnswer[];
  outcome: CaptureOutcome;
  answerSource: AnswerSource;
  verified: boolean;
}

/**
 * Multiple-dropdowns / matching question: one answer per blank. On a graded
 * full-marks review every selected value is correct (self-correct); a live
 * quiz treats the user's selections as asserted-correct. Wrong/hidden → the
 * blanks keep the student's picks but `correct` stays empty (unverified).
 *
 * NOTE: graded review pages render these selects ENABLED (with only the
 * chosen option in them), so "some select is editable" does NOT mean live —
 * the page-level graded signals win.
 */
export function readMultiDropdown(question: HTMLElement, raws: RawBlank[]): AnswerReadout {
  const graded = looksGraded(question);
  const live = !graded && raws.some((b) => !b.disabled);
  const allAnswered = raws.length > 0 && raws.every((b) => b.selected);
  const correctness = live
    ? "correct"
    : questionCorrectness(question) ?? (submissionFullMarks() ? "correct" : null);
  const verified = allAnswered && correctness === "correct";
  const blanks: BlankAnswer[] = raws.map((b) => ({
    key: b.key,
    ...(b.label ? { label: b.label } : {}),
    selected: b.selected,
    correct: verified ? b.selected : "",
    options: b.options,
  }));
  const outcome: CaptureOutcome =
    correctness === "correct" ? "correct" : correctness === "incorrect" ? "incorrect" : "unknown";
  return {
    selectedChoices: [],
    correctChoices: [],
    blanks,
    outcome,
    answerSource: verified ? (live ? "manual" : "self-correct") : "none",
    verified,
  };
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

function collectAnswerSelects(question: HTMLElement): HTMLSelectElement[] {
  return [...question.querySelectorAll<HTMLSelectElement>("select")].filter(isAnswerSelect);
}

/** One dropdown "blank" of a multiple-dropdowns / matching question. */
export interface RawBlank {
  key: string; // blank id (from the select's name) or "blank N"
  label: string; // left-hand prompt of the row (.answer_match_left); "" if none
  selected: string; // the student's chosen option text ("" if none)
  options: string[]; // all non-placeholder option texts
  disabled: boolean; // read-only (graded review) vs editable (live)
}

/** Collect the blanks of a matching / multiple-dropdowns question (2+ blanks).
 * Returns [] for single-dropdown / non-dropdown questions. */
export function collectBlanks(question: HTMLElement): RawBlank[] {
  // Graded multiple-dropdowns / fill-in-multiple-blanks: Canvas renders the
  // per-blank answer key as `.answer_group` blocks — the inline <select>s show
  // only "[ Select ]", so their value/options are useless on this view. The
  // groups carry the full option pool AND the student's pick, so prefer them.
  const grouped = collectAnswerGroupBlanks(question);
  if (grouped.length >= 2) return grouped;

  // Matching (graded selects stay populated) or a live multiple-dropdowns quiz.
  const selects = collectAnswerSelects(question);
  if (selects.length < 2) return [];
  return selects.map((sel, i) => {
    const options = [...sel.querySelectorAll("option")]
      .map((o) => normalizeText(o.textContent ?? ""))
      .filter((t) => t && !isPlaceholderOption(t));
    const selOpt = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
    let selected = selOpt ? normalizeText(selOpt.textContent ?? "") : "";
    if (isPlaceholderOption(selected)) selected = "";
    return {
      key: blankKey(sel, i),
      label: blankLabelForSelect(sel),
      selected,
      options,
      disabled: sel.disabled,
    };
  });
}

/**
 * Blanks read from graded `.answer_group` blocks (Canvas multiple-dropdowns /
 * fill-in-multiple-blanks review). Each group is one blank: every option is an
 * `.answer` row (`.answer_text`), the student's pick is the `.selected_answer`
 * row, and `.blank_id` names the blank. The inline <select>s (empty on this
 * view) still carry the surrounding sentence — our best per-blank label — so
 * we zip them to the groups by order. Returns [] when there are no groups.
 */
function collectAnswerGroupBlanks(question: HTMLElement): RawBlank[] {
  const groups = [...question.querySelectorAll<HTMLElement>(".answer_group")];
  if (groups.length < 2) return [];

  // Label each blank with its inline <select>'s surrounding sentence. How we
  // pair a group to a select depends on the counts:
  //  - Equal counts → pair by DOCUMENT ORDER (group[i] ↔ select[i]). This is
  //    the unambiguous case and, crucially, is the ONLY correct pairing when
  //    two blanks share an identical option pool (e.g. an intercept and a slope
  //    dropdown both offering the same numbers) — option-set matching can't
  //    tell those apart and would give both the same label.
  //  - Unequal counts → some blanks are fixed statements with no dropdown, so
  //    order is unreliable; match by option-set, but ONLY on signatures that
  //    are unique among the selects (ambiguous/absent → fall back to blank id).
  const selects = collectAnswerSelects(question);
  const positional = groups.length === selects.length;
  const sigOfSelect = (sel: HTMLSelectElement) =>
    optionSignature([...sel.querySelectorAll("option")].map((o) => normalizeText(o.textContent ?? "")));
  const sigCount = new Map<string, number>();
  for (const sel of selects) sigCount.set(sigOfSelect(sel), (sigCount.get(sigOfSelect(sel)) ?? 0) + 1);
  const uniqueSelectBySig = new Map<string, HTMLSelectElement>();
  for (const sel of selects) {
    const sig = sigOfSelect(sel);
    if (sig && sigCount.get(sig) === 1) uniqueSelectBySig.set(sig, sel);
  }

  return groups.map((group, i) => {
    const rows = [...group.querySelectorAll<HTMLElement>(".answer")];
    const optionOf = (row: HTMLElement) => dedupeDoubled(cleanText(row.querySelector<HTMLElement>(".answer_text") ?? row));
    const options = [...new Set(rows.map(optionOf).filter((t) => t && !isPlaceholderOption(t)))];
    const selRow = group.querySelector<HTMLElement>(".answer.selected_answer");
    let selected = selRow ? optionOf(selRow) : "";
    if (isPlaceholderOption(selected)) selected = "";
    const blankId = normalizeText(group.querySelector(".blank_id")?.textContent ?? "");
    const sel = positional ? selects[i] : uniqueSelectBySig.get(optionSignature(options));
    return {
      key: blankId || `blank${i + 1}`,
      label: (sel && blankLabelForSelect(sel)) || blankId,
      selected,
      options,
      disabled: true, // graded review: no editable input
    };
  });
}

/** Order-independent signature of an option set (lower-cased, placeholder
 * dropped, sorted) so a blank's answer group can be matched to the inline
 * <select> that offers the same options. */
function optionSignature(options: string[]): string {
  return options
    .map((o) => normalizeText(o).toLowerCase())
    .filter((o) => o && !isPlaceholderOption(o))
    .sort()
    .join("|");
}

/** Best per-blank label: the matching row's left prompt (`.answer_match_left`),
 * else the surrounding sentence of an inline multiple-dropdowns <select> (the
 * <select>s themselves stripped), else its aria-label. */
function blankLabelForSelect(sel: HTMLSelectElement): string {
  const left = sel.closest(".answer")?.querySelector<HTMLElement>(".answer_match_left");
  if (left) {
    const t = cleanText(left);
    if (t) return t;
  }
  const block = sel.closest("li, p, td, .answer") as HTMLElement | null;
  if (block) {
    const clone = block.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("select, script, style, .screenreader-only").forEach((n) => n.remove());
    const t = normalizeText(clone.textContent ?? "");
    if (t) return t.slice(0, 200);
  }
  const aria = normalizeText(sel.getAttribute("aria-label") ?? "");
  return /multiple dropdowns/i.test(aria) ? "" : aria;
}

function isPlaceholderOption(text: string): boolean {
  return !text || /^\[?\s*(select|choose)\s*\]?\s*\.{0,3}$/i.test(text);
}

function blankKey(sel: HTMLSelectElement, i: number): string {
  const name = sel.name || "";
  const m = name.match(/answer_for_(.+)$/i) ?? name.match(/_([A-Za-z0-9]+)$/);
  return (m?.[1] ?? `blank${i + 1}`).trim();
}

// ---- images (mirror content.ts; bytes via the background relay) -------------

export interface CollectedImages {
  images: ImageBlock[];
  imageUrls: string[];
}

async function collectImages(root: HTMLElement): Promise<CollectedImages> {
  const images: ImageBlock[] = [];
  const imageUrls: string[] = [];
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
    if (!src.startsWith("data:")) imageUrls.push(src);
    const block = await fetchImageBlock(src).catch(() => null);
    if (block) images.push(block);
  }
  for (const c of [...root.querySelectorAll<HTMLCanvasElement>("canvas")]) {
    try {
      const dataUrl = c.toDataURL("image/png");
      const data = dataUrl.split(",")[1];
      if (!data) continue;
      const key = `canvas:${data.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      images.push({ data, mediaType: "image/png" });
    } catch {
      /* tainted canvas — skip */
    }
  }
  return { images, imageUrls };
}

/** Fetch image bytes: first via the background service worker (host
 * permissions apply there, so cross-origin hosts like bookdown.org work),
 * then falling back to a direct page-context fetch (same-origin/data: URLs
 * or an old build without the worker). */
async function fetchImageBlock(url: string): Promise<ImageBlock | null> {
  const viaBackground = await fetchImageViaBackground(url);
  if (viaBackground) return viaBackground;
  return urlToImageBlock(url);
}

async function fetchImageViaBackground(url: string): Promise<ImageBlock | null> {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) return null;
    const res = (await chrome.runtime.sendMessage({ type: "shcap:fetch-image", url })) as
      | { ok: true; data: string; mediaType: ImageBlock["mediaType"] }
      | { ok: false; error?: string }
      | undefined;
    if (res && res.ok === true && res.data) return { data: res.data, mediaType: res.mediaType };
    return null;
  } catch {
    return null;
  }
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
//
// normalizeText/dedupeDoubled now live in packages/solver-core/src/core/text.ts
// (shared with apps/extension/src/canvas-dom.ts — see that file's own
// doubled-equation-text cleanup) and are re-exported here unchanged so any
// existing `import { normalizeText } from "./scrape"` keeps working.

export { normalizeText, dedupeDoubled };

function choiceLabel(index: number): string {
  return String.fromCharCode(65 + index);
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
