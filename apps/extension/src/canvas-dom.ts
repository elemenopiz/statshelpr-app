/**
 * Canvas DOM layer — scrapes question content (stem, answer choices, matching
 * / multiple-dropdowns blanks, images) out of the Canvas quiz page, and writes
 * the model's answer back into it (click / select / fill, or a highlight-only
 * mark when the field is disabled/read-only).
 *
 * Chrome-free by design — no `chrome.*` calls anywhere in this module — so it
 * can run standalone under happy-dom/jsdom in a test harness. All
 * chrome.storage / chrome.runtime access lives in content.ts, the sole
 * consumer of this module today.
 */

export interface ImageBlock {
  data: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
}

/** One answered blank of a matching / multiple-dropdowns question. */
export interface BlankAnswer {
  key: string;
  answer: string;
}

const SELECTORS_STEM = [
  ".question_text",
  ".user_content",
  "[data-testid='question-text']",
  "[data-testid='question-stem']",
  ".question-text-container",
  ".stem",
];

const CHOICE_INPUT_SELECTOR = 'input[type="radio"], input[type="checkbox"]';
const TEXT_INPUT_SELECTOR = [
  'input[type="text"]',
  'input[type="number"]',
  ".numerical_question_input",
  ".question_input",
].join(",");

// =============================================================================
// scraping
// =============================================================================

export interface ScrapedQuestion {
  text: string;
  choices: AnswerChoice[];
  /** Matching / multiple-dropdowns blanks (2+). Mutually exclusive with
   * `choices` — a blanks question yields no flat choices. */
  blanks: ScrapedBlank[];
  images: ImageBlock[];
}

export async function scrapeQuestion(question: HTMLElement): Promise<ScrapedQuestion> {
  const stem = findStem(question);
  if (!stem) throw new Error("Could not find question text.");

  // cleanText drops Canvas's "Links to an external site." screen-reader spans
  // (and script/style) that innerText would otherwise splice into the prompt.
  const stemText = cleanText(stem);
  if (!stemText) throw new Error("Question text is empty.");

  // Scrape images from the WHOLE question container — answer choices sometimes
  // have images too (e.g. "Which graph shows ___?"). Dedupe by image URL.
  const images = await collectImages(question);
  const choices = collectAnswerChoices(question);
  const blanks = collectBlanks(question);

  return { text: stemText, choices, blanks, images };
}

// =============================================================================
// answer-choice selection (the click)
// =============================================================================

/** Select/fill the model's answer into the page. Returns the count of
 * elements actually acted on (clicked / selected / filled, or highlight-only
 * marked when disabled) — 0 means nothing in the page could be written to. */
export function selectAnswerChoice(
  question: HTMLElement,
  answer: string,
  selectedLabels: string[] = [],
): number {
  const choices = collectAnswerChoices(question);
  if (choices.length === 0) return 0;

  // Special-case text-fill: there's just one slot, write the answer in.
  if (choices.length === 1 && choices[0]?.kind === "text-fill") {
    return fillTextInput(choices[0].input as HTMLInputElement, answer);
  }

  const selectedByBackend = selectedLabels
    .map((label) => choices.find((c) => c.label.toUpperCase() === label.toUpperCase()))
    .filter((c): c is AnswerChoice => Boolean(c));
  if (selectedByBackend.length > 0) {
    let count = 0;
    for (const c of selectedByBackend) count += applyChoice(c);
    return count;
  }

  // Multi-select via checkboxes
  const checkboxes = choices.filter((c) => c.kind === "checkbox");
  if (checkboxes.length > 0) {
    const selected = findSelectedChoices(answer, choices, true);
    let count = 0;
    for (const c of selected) count += applyChoice(c);
    return count;
  }

  // Dropdown: single-select, options scraped from the <select>
  const dropdown = choices.filter((c) => c.kind === "dropdown-option");
  if (dropdown.length > 0) {
    const c = pickByLetterOrText(answer, dropdown);
    return c ? applyChoice(c) : 0;
  }

  // Radio: single-select
  const radios = choices.filter((c) => c.kind === "radio");
  if (radios.length === 0) return 0;
  const c = pickByLetterOrText(answer, radios);
  return c ? applyChoice(c) : 0;
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

function applyChoice(choice: AnswerChoice): number {
  if (choice.kind === "dropdown-option") {
    return selectDropdownOption(choice);
  }
  if (choice.kind === "text-fill") {
    // shouldn't reach here in normal flow (text-fill is handled upstream)
    return 0;
  }
  return selectChoice(choice.input as HTMLInputElement);
}

function selectDropdownOption(choice: AnswerChoice): number {
  return setSelectValue(choice.input as HTMLSelectElement, choice.optionValue, choice.optionIndex);
}

/** Set a <select> to an option (by value, falling back to index) using the
 * React-aware native setter so New Quizzes / Canvas reacts to the change, and
 * mark it suggested. On a disabled/read-only select we only mark it. Always
 * returns 1 — a select is either set or marked, never a no-op. */
function setSelectValue(sel: HTMLSelectElement, value?: string, index?: number): number {
  if (sel.disabled) {
    sel.classList.add("statshelpr-suggested");
    return 1;
  }
  const proto = Object.getPrototypeOf(sel);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter && value !== undefined) setter.call(sel, value);
  else if (index !== undefined) sel.selectedIndex = index;
  sel.dispatchEvent(new Event("input", { bubbles: true }));
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  sel.classList.add("statshelpr-suggested");
  return 1;
}

function fillTextInput(input: HTMLInputElement, answer: string): number {
  // Try to extract just the value from "Answer: 12.34" or "Final answer: 12.34"
  const m = answer.match(/(?:Answer|Final answer)\s*:?\s*(.+?)(?:\n|$)/i);
  let value = (m?.[1] ?? answer).trim();
  // Drop trailing punctuation
  value = value.replace(/[.,;]\s*$/, "").trim();
  // Strip wrapping quotes
  value = value.replace(/^["'`]|["'`]$/g, "");
  return setTextInputValue(input, value);
}

/** Set a text/number input's value via the React-aware native setter (so New
 * Quizzes / Canvas reacts to the change), fire input+change, and mark
 * suggested — mirrors setSelectValue()'s contract exactly. On a
 * disabled/read-only input we only mark it. Always returns 1 — an input is
 * either set or marked, never a no-op. Shared by fillTextInput (single
 * text-fill, which does its own "Answer: X"-prefix extraction/cleanup above)
 * and writeBlanks's input-backed blank path (whose value arrives already
 * cleaned from solver-core's deriveBlankAnswers, so no re-extraction needed). */
function setTextInputValue(input: HTMLInputElement, value: string): number {
  if (input.disabled || input.readOnly) {
    input.classList.add("statshelpr-suggested");
    return 1;
  }
  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.classList.add("statshelpr-suggested");
  return 1;
}

export interface AnswerChoice {
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

export function collectAnswerChoices(question: HTMLElement): AnswerChoice[] {
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
  // TWO OR MORE answer selects = a matching / multiple-dropdowns question,
  // handled independently per blank via collectBlanks()/writeBlanks() — bail
  // here so the single-select path doesn't answer only the first blank.
  const selects = answerSelects(question);
  if (selects.length >= 2) return [];
  if (selects.length === 1) {
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

export function choiceTypeForApi(c: AnswerChoice): "radio" | "checkbox" | "dropdown" | "text" {
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

function answerSelects(question: HTMLElement): HTMLSelectElement[] {
  return [...question.querySelectorAll<HTMLSelectElement>("select")].filter(isAnswerSelect);
}

// =============================================================================
// matching / multiple-dropdowns / fill-in-multiple-blanks (2+ blanks)
// =============================================================================
//
// A matching or multiple-dropdowns question has one <select> per blank, each
// answered independently from its own options. A Classic
// fill_in_multiple_blanks_question instead has 2+ inline <input type=text>
// blanks with NO discrete option pool — the model supplies the value
// directly (see buildBlanksPrompt / deriveBlankAnswers in solver-core). Both
// shapes scrape to the same ScrapedBlank union (select-backed vs
// input-backed) so the rest of the pipeline — buildQuestionPrompt,
// deriveBlankAnswers, writeBlanks, and the API payload mapping in
// content.ts — shares one code path. `options` stays on both variants
// (always [] for input-backed, never omitted) so content.ts's
// `b.options.map((o) => o.text)` needs no per-kind branching.
//
// Mixed select+text questions (some blanks backed by a <select>, others by an
// <input>, in the same question) are out of scope: collectBlanks picks
// whichever kind dominates — 2+ answer-selects wins outright regardless of
// any text inputs also present; otherwise, 2+ enabled text inputs — and
// ignores the other kind entirely.

export interface BlankOption {
  value: string;
  text: string;
  index: number;
}

/** exported (alongside InputScrapedBlank) so callers that need to narrow a
 * ScrapedBlank union — e.g. a test fixture that knows its question is
 * select-backed — can name the specific member type rather than casting to
 * `any`. */
export interface SelectScrapedBlank {
  kind: "select";
  key: string;
  label: string;
  options: BlankOption[];
  select: HTMLSelectElement;
}

/** A Classic fill_in_multiple_blanks_question blank: free text, no option
 * pool. `options` is always [] (see the section comment above for why it's
 * kept rather than omitted). */
export interface InputScrapedBlank {
  kind: "input";
  key: string;
  label: string;
  options: BlankOption[];
  input: HTMLInputElement;
}

export type ScrapedBlank = SelectScrapedBlank | InputScrapedBlank;

export function collectBlanks(question: HTMLElement): ScrapedBlank[] {
  const selects = answerSelects(question);
  if (selects.length >= 2) {
    return selects.map((sel, i) => {
      const options: BlankOption[] = [...sel.options]
        .map((o, index) => ({ value: o.value, text: normalizeText(o.textContent ?? ""), index }))
        .filter((o) => o.text && !isPlaceholderOption(o.text));
      return { kind: "select", key: `blank${i + 1}`, label: blankLabel(sel, question), options, select: sel };
    });
  }
  return collectTextBlanks(question);
}

/** Classic fill_in_multiple_blanks_question: 2+ inline text inputs, no
 * radio/checkbox choices, fewer than 2 answer-selects (the latter already
 * guaranteed by collectBlanks — the only caller — falling through to here).
 * Gated on 2+ ENABLED inputs so a single stray text field elsewhere in the
 * question doesn't misfire this path; collectAnswerChoices's own
 * single-text-fill priority already owns that one-input case. Once gated in,
 * EVERY matching input (enabled or disabled) is collected, mirroring
 * answerSelects()'s own disabled-agnostic collection for <select> blanks. */
function collectTextBlanks(question: HTMLElement): ScrapedBlank[] {
  if (question.querySelector(CHOICE_INPUT_SELECTOR)) return [];
  const inputs = [...question.querySelectorAll<HTMLInputElement>(TEXT_INPUT_SELECTOR)];
  const enabledCount = inputs.filter((i) => !i.disabled && !i.readOnly).length;
  if (enabledCount < 2) return [];

  const used = new Set<string>();
  return inputs.map((input, i) => ({
    kind: "input" as const,
    key: inputBlankKey(input, i, used),
    label: blankLabel(input, question),
    options: [],
    input,
  }));
}

/** Stable key for an input-backed blank: the trailing `_<hash>` segment of
 * its name (Canvas's `question_<qid>_<blankhash>` convention — mirrors
 * extension-capture/src/scrape.ts's blankKey()), falling back to its id, then
 * to a positional `blank<n>` when neither yields a usable — non-empty, not
 * already claimed by an earlier blank in this question — key. */
function inputBlankKey(input: HTMLInputElement, index: number, used: Set<string>): string {
  for (const raw of [input.name, input.id]) {
    if (!raw) continue;
    const m = raw.match(/_([A-Za-z0-9]+)$/);
    const key = (m?.[1] ?? raw).trim();
    if (key && !used.has(key)) {
      used.add(key);
      return key;
    }
  }
  const fallback = `blank${index + 1}`;
  used.add(fallback);
  return fallback;
}

/** Human-readable prompt for one blank so the model can map answers to blanks:
 *   - matching question: the <label for=selectId> or `.answer_match_left` cell
 *     (the term / statement being matched);
 *   - inline multiple-dropdowns / fill-in-multiple-blanks: the surrounding
 *     sentence (nearest block), with every blank element inside it — <select>
 *     or <input> alike, not just this one — stripped out. */
function blankLabel(el: HTMLSelectElement | HTMLInputElement, question: HTMLElement): string {
  if (el.id) {
    const lab = question.querySelector<HTMLElement>(`label[for="${cssEscape(el.id)}"]`);
    const t = lab ? cleanText(lab) : "";
    if (t) return t;
  }
  const left = el.closest(".answer")?.querySelector<HTMLElement>(".answer_match_left");
  if (left) {
    const t = cleanText(left);
    if (t) return t;
  }
  const block = el.closest("li, p, td, .answer") as HTMLElement | null;
  if (block) {
    const clone = block.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("select, input, script, style, .screenreader-only").forEach((n) => n.remove());
    const t = normalizeText(clone.textContent ?? "");
    if (t) return t.slice(0, 200);
  }
  const aria = normalizeText(el.getAttribute("aria-label") ?? "");
  return /multiple dropdowns/i.test(aria) ? "" : aria;
}

function isPlaceholderOption(text: string): boolean {
  return !text || /^\[?\s*(select|choose)\s*\]?\s*\.{0,3}$/i.test(text);
}

/** Write each model-answered blank into its backing element — a <select> via
 * matchBlankOption + setSelectValue, or an <input> directly via
 * setTextInputValue (deriveBlankAnswers already cleaned free-text values
 * server-side, so no re-extraction happens here — see solver-core's
 * choices.ts). Blanks are matched by key first, then positionally. Returns
 * the count of blanks acted on (set, or highlight-only marked when
 * disabled/no option matched) — 0 means nothing could be written. */
export function writeBlanks(question: HTMLElement, answers: BlankAnswer[]): number {
  const blanks = collectBlanks(question);
  let count = 0;
  answers.forEach((a, i) => {
    const blank = blanks.find((b) => b.key === a.key) ?? blanks[i];
    if (!blank || !a.answer) return;
    if (blank.kind === "input") {
      count += setTextInputValue(blank.input, a.answer);
      return;
    }
    const opt = matchBlankOption(a.answer, blank.options);
    if (opt) {
      count += setSelectValue(blank.select, opt.value, opt.index);
    } else {
      blank.select.classList.add("statshelpr-suggested");
      count += 1;
    }
  });
  return count;
}

/** Best option for a model answer: exact (case-insensitive) first, then the
 * longest option that appears as a substring either way. */
function matchBlankOption(answer: string, options: BlankOption[]): BlankOption | null {
  const a = normalizeText(answer).toLowerCase();
  if (!a) return null;
  for (const o of options) if (o.text.toLowerCase() === a) return o;
  let best: BlankOption | null = null;
  for (const o of options) {
    const ol = o.text.toLowerCase();
    if (!ol) continue;
    const hit = a.includes(ol) || (ol.length >= 3 && ol.includes(a));
    if (hit && (!best || o.text.length > best.text.length)) best = o;
  }
  return best;
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

function selectChoice(input: HTMLInputElement): number {
  const row = getChoiceRow(input);
  if (input.disabled) {
    row?.classList.add("statshelpr-suggested");
    return row ? 1 : 0;
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
  return 1;
}

function choiceLabel(index: number): string {
  return String.fromCharCode(65 + index);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Element text with Canvas's screen-reader helper spans ("Links to an
 * external site.") and script/style removed, so they don't leak into the
 * prompt. Operates on a detached clone — never mutates the page. */
function cleanText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script, style, .screenreader-only").forEach((n) => n.remove());
  return normalizeText(clone.textContent ?? "");
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

/** Find the element holding the question's stem text, trying each selector in
 * SELECTORS_STEM in order — first non-empty match wins. Also used by
 * content.ts to decide whether a candidate container is a real question. */
export function findStem(question: HTMLElement): HTMLElement | null {
  for (const sel of SELECTORS_STEM) {
    const el = question.querySelector<HTMLElement>(sel);
    if (el && (el.innerText || el.textContent)?.trim()) return el;
  }
  return null;
}

// =============================================================================
// image scraping
// =============================================================================

async function collectImages(root: HTMLElement): Promise<ImageBlock[]> {
  const out: ImageBlock[] = [];
  const seen = new Set<string>(); // dedupe by URL/data-hash

  for (const img of [...root.querySelectorAll<HTMLImageElement>("img")]) {
    // currentSrc/src for loaded images; data-src/data-original for lazy-loaded
    // ones not yet scrolled into view when Solve is clicked.
    const src =
      img.currentSrc ||
      img.src ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      "";
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
