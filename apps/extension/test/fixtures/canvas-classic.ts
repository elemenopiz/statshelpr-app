/**
 * Builders for REAL Canvas Classic quiz-TAKING markup — the shape the page
 * has while a student is still answering, before submission. This matters
 * because canvas-dom.ts's own selectors (CHOICE_INPUT_SELECTOR, the
 * `.answers`/`.answer` structure, `isAnswerSelect`, `TEXT_INPUT_SELECTOR`)
 * are written against that live-quiz DOM, and every fixture here is built to
 * be discovered by those exact selectors — not bespoke markup that happens
 * to satisfy the test.
 *
 * Structural facts encoded below (cross-checked against
 * apps/extension-capture/src/scrape.ts's header comment, which documents
 * them as "verified against a real graded submission", and against
 * canvas-dom.ts's own selector constants):
 *   - `.question_holder` wraps a `.question.display_question.<type>_question`
 *     element carrying the Canvas numeric id as `id="question_<id>"`.
 *   - The stem lives in `.question_text` (canvas-dom.ts's first and, on
 *     Classic, only-matching SELECTORS_STEM entry).
 *   - A hidden `.original_question_text > textarea[name="question_text"]`
 *     carries the AUTHORED html and must never leak into scraping — included
 *     in every fixture below as a decoy, per scrape.ts's documented warning.
 *   - Each `.answer` row pairs `input[type=radio|checkbox]` with
 *     `label[for=inputId]` wrapping `.answer_text`, plus a hidden
 *     `input[name="answer_text"]` decoy (a real but non-answer-bearing form
 *     field — canvas-dom.ts's TEXT_INPUT_SELECTOR only matches
 *     type=text/number so this is naturally excluded, not specially handled).
 *   - Matching rows carry `.answer_match_left`; multiple-dropdowns blanks are
 *     inline `<select>`s inside flowing `.question_text` prose so
 *     canvas-dom.ts's blankLabel() block-sentence heuristic has something
 *     real to strip.
 *   - Dropdown/matching/multiple-dropdowns `<select>`s carry Canvas's own
 *     `[ Select ]` placeholder option, matched by canvas-dom.ts's
 *     isPlaceholderOption regex.
 *
 * Every fixture is built with test/fixtures/dom.ts's `h()` (createElement
 * based, no HTML-string parsing) so nesting mirrors the real DOM exactly.
 */
import { h, selectEl, nextId } from "./dom";

// =============================================================================
// shared scaffolding
// =============================================================================

/** The hidden authored-html decoy every real .question_holder carries.
 * Never answer-bearing; must never leak into scrapeQuestion()'s stem text or
 * collectAnswerChoices()'s text-fill detection. */
function originalQuestionTextDecoy(authoredHtml: string): HTMLElement {
  return h("div", { class: "original_question_text", style: "display:none" }, [
    h("textarea", { name: "question_text", readonly: true }, [authoredHtml]),
  ]);
}

/** The hidden per-row `input[name=answer_text]` decoy every real `.answer`
 * row carries alongside its visible `.answer_text` label span. Type=hidden,
 * so it's naturally outside canvas-dom.ts's TEXT_INPUT_SELECTOR. */
function answerTextDecoy(text: string): HTMLElement {
  return h("input", { type: "hidden", name: "answer_text", value: text });
}

function questionHeader(n: number): HTMLElement {
  return h("div", { class: "header" }, [h("span", { class: "question_name" }, [`Question ${n}`])]);
}

function stemBlock(stemText: string): HTMLElement {
  return h("div", { class: "question_text user_content" }, [h("p", {}, [stemText])]);
}

function questionTypeSpan(questionType: string): HTMLElement {
  return h("span", { class: "question_type", style: "display:none" }, [questionType]);
}

function mountQuestion(id: string, questionType: string, inner: HTMLElement[]): HTMLElement {
  const q = h(
    "div",
    { class: `question display_question ${questionType}`, id: `question_${id}` },
    [questionTypeSpan(questionType), questionHeader(1), ...inner],
  );
  const holder = h("div", { class: "question_holder" }, [q]);
  document.body.appendChild(holder);
  return holder;
}

// =============================================================================
// radio / checkbox questions (multiple_choice, true_false, multiple_answers)
// =============================================================================

export interface ChoiceFixture {
  /** The `.question_holder` — pass this straight into scrapeQuestion /
   * collectAnswerChoices / selectAnswerChoice, exactly like content.ts does. */
  question: HTMLElement;
  /** Choice texts in DOM order — canvas-dom.ts assigns labels A, B, C… in
   * this same order, so `choiceTexts[i]` is always label `String.fromCharCode(65+i)`. */
  choiceTexts: string[];
}

export function buildChoiceQuestion(params: {
  id?: string;
  questionType: string;
  inputType: "radio" | "checkbox";
  stemText: string;
  choiceTexts: string[];
  /** Indices (into choiceTexts) whose <input> should render disabled. */
  disabledIndices?: number[];
}): ChoiceFixture {
  const id = params.id ?? nextId("q");
  const groupName = `question_${id}`;
  const rows = params.choiceTexts.map((text, i) => {
    const inputId = `question_${id}_answer_${i}`;
    const input = h("input", {
      type: params.inputType,
      name: params.inputType === "radio" ? groupName : undefined,
      id: inputId,
      value: String(1000 + i),
      disabled: params.disabledIndices?.includes(i) ?? false,
    });
    const label = h("label", { for: inputId }, [h("span", { class: "answer_text" }, [text])]);
    return h("div", { class: `answer answer_${i}` }, [input, label, answerTextDecoy(text)]);
  });
  const answers = h("div", { class: "answers" }, rows);
  const question = mountQuestion(id, params.questionType, [
    stemBlock(params.stemText),
    originalQuestionTextDecoy(`<p>${params.stemText}</p>`),
    answers,
  ]);
  return { question, choiceTexts: params.choiceTexts };
}

// =============================================================================
// single dropdown (Classic "dropdown"-style short_answer_question)
// =============================================================================

export interface DropdownFixture {
  question: HTMLElement;
  optionTexts: string[];
}

export function buildSingleDropdown(params: {
  id?: string;
  stemText: string;
  optionTexts: string[];
  disabled?: boolean;
}): DropdownFixture {
  const id = params.id ?? nextId("q");
  const sel = selectEl(
    {
      class: "question_input",
      name: `answer_for_${id}`,
      id: `answer_for_${id}`,
      disabled: params.disabled ?? false,
    },
    params.optionTexts.map((t, i) => [String(i + 1), t]),
  );
  const answers = h("div", { class: "answers" }, [h("div", { class: "answer" }, [sel])]);
  const question = mountQuestion(id, "short_answer_question", [
    stemBlock(params.stemText),
    originalQuestionTextDecoy(`<p>${params.stemText}</p>`),
    answers,
  ]);
  return { question, optionTexts: params.optionTexts };
}

// =============================================================================
// text-fill (numerical_question / short_answer_question single input)
// =============================================================================

export interface TextFillFixture {
  question: HTMLElement;
  input: HTMLInputElement;
}

export function buildTextFillQuestion(params: {
  id?: string;
  stemText: string;
  numerical?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
}): TextFillFixture {
  const id = params.id ?? nextId("q");
  const cls = params.numerical ? "question_input numerical_question_input" : "question_input";
  const input = h("input", {
    type: "text",
    class: cls,
    name: `question_${id}_input`,
    autocomplete: "off",
    disabled: params.disabled ?? false,
    readonly: params.readOnly ?? false,
    placeholder: params.placeholder,
  }) as HTMLInputElement;
  const answers = h("div", { class: "answers" }, [h("div", { class: "answer" }, [input])]);
  const question = mountQuestion(id, params.numerical ? "numerical_question" : "short_answer_question", [
    stemBlock(params.stemText),
    originalQuestionTextDecoy(`<p>${params.stemText}</p>`),
    answers,
  ]);
  return { question, input };
}

// =============================================================================
// matching (2+ blanks sharing one option pool, .answer_match_left prompts)
// =============================================================================

export interface BlankSpec {
  key: string;
  /** .answer_match_left text (matching) or surrounding sentence (multi-dropdowns). */
  label: string;
  /** Full option pool offered in this blank's <select>. */
  options: string[];
  /** The option (verbatim, must be present in `options`) this blank's "correct" pick is. */
  correctOption: string;
}

export interface BlanksFixture {
  question: HTMLElement;
  blanks: BlankSpec[];
}

/** A matching question: N rows, each `.answer_match_left` + `<select>`. Real
 * captures of graded matching pages only ever record the ONE selected option
 * per row (a known, tracked capture-pipeline gap — see
 * project_capture_truefalse_distractor_gap memory note), so callers
 * reconstruct the shared pool via `sharedOptionPool` (typically the union of
 * every row's real captured option) rather than each row supplying its own. */
export function buildMatchingQuestion(params: {
  id?: string;
  stemText: string;
  rows: Array<{ key: string; label: string; correctOption: string }>;
  sharedOptionPool: string[];
}): BlanksFixture {
  const id = params.id ?? nextId("q");
  const rowEls = params.rows.map((row) => {
    const selId = `answer_for_${row.key}`;
    const sel = selectEl(
      { name: selId, id: selId, class: "matching_answer" },
      params.sharedOptionPool.map((t, i) => [String(i + 1), t]),
    );
    return h("div", { class: "answer" }, [
      h("div", { class: "answer_match_left" }, [row.label]),
      sel,
    ]);
  });
  const answers = h("div", { class: "answers" }, rowEls);
  const question = mountQuestion(id, "matching_question", [
    stemBlock(params.stemText),
    originalQuestionTextDecoy(`<p>${params.stemText}</p>`),
    answers,
  ]);
  const blanks: BlankSpec[] = params.rows.map((row) => ({
    key: row.key,
    label: row.label,
    options: params.sharedOptionPool,
    correctOption: row.correctOption,
  }));
  return { question, blanks };
}

/** A multiple-dropdowns question: N inline <select>s embedded in flowing
 * sentence prose inside .question_text, each with its OWN distinct option
 * pool (unlike matching, these are real per-blank distractor sets straight
 * from the capture — multiple_dropdowns_question wasn't affected by the
 * matching capture gap; fixed upstream in commit 052080c). */
export function buildMultipleDropdowns(params: {
  id?: string;
  stemText: string;
  blanks: BlankSpec[];
}): BlanksFixture {
  const id = params.id ?? nextId("q");
  const paragraphs = params.blanks.map((blank) => {
    const selId = `answer_for_${blank.key}`;
    const sel = selectEl(
      { class: "question_input", name: selId, id: selId },
      blank.options.map((t, i) => [String(i + 1), t]),
    );
    // Select appended AFTER the label text so canvas-dom.ts's blankLabel()
    // (which clones the block, strips the <select>, and reads what's left)
    // recovers exactly `blank.label` — an exact, checkable round trip.
    return h("p", {}, [blank.label ? `${blank.label} ` : null, sel]);
  });
  const question = mountQuestion(id, "multiple_dropdowns_question", [
    h("div", { class: "question_text user_content" }, [params.stemText, ...paragraphs]),
    originalQuestionTextDecoy(`<p>${params.stemText}</p>`),
  ]);
  return { question, blanks: params.blanks };
}

// =============================================================================
// fill-in-multiple-blanks (2+ inline <input type=text>, no discrete option pool)
// =============================================================================

export interface TextBlankSpec {
  /** Expected round-trip key. Becomes the trailing segment of the <input>'s
   * `name` (`question_<qid>_<key>`) — canvas-dom.ts's inputBlankKey() extracts
   * it back out via the same trailing-hash regex extension-capture/src/scrape.ts's
   * blankKey() uses for <select>-backed blanks, so it must be alnum-only (no
   * underscores), matching Canvas's real opaque blank-hash format. Pass ""
   * to render the input with NO name/id at all, exercising inputBlankKey()'s
   * positional `blank<n>` fallback instead. Two blanks sharing the same
   * non-empty key exercise the dedup fallback (second one collides, so it
   * also falls back to positional). */
  key: string;
  /** Surrounding sentence context (with the input itself stripped) —
   * mirrors BlankSpec.label's role for multiple-dropdowns. */
  label: string;
  /** The value this blank's "correct" answer is. */
  correctValue: string;
}

export interface TextBlanksFixture {
  question: HTMLElement;
  blanks: TextBlankSpec[];
  /** The <input> elements in the same order as `blanks`. */
  inputs: HTMLInputElement[];
}

/** A Classic fill_in_multiple_blanks_question: N inline <input type=text>
 * blanks embedded in flowing sentence prose inside .question_text, each
 * carrying a stable Canvas-style name (`question_<qid>_<blankhash>`, class
 * `question_input`) — same shape multiple_dropdowns_question uses for its
 * <select>s, just with a text input instead. One <p> per blank (like
 * buildMultipleDropdowns) so blankLabel()'s nearest-block-with-blanks-stripped
 * heuristic recovers exactly `blank.label` — an exact, checkable round trip. */
export function buildFillInMultipleBlanks(params: {
  id?: string;
  stemText: string;
  blanks: TextBlankSpec[];
  /** Indices (into params.blanks) whose <input> should render disabled. */
  disabledIndices?: number[];
}): TextBlanksFixture {
  const id = params.id ?? nextId("q");
  const inputs: HTMLInputElement[] = [];
  const paragraphs = params.blanks.map((blank, i) => {
    const input = h("input", {
      type: "text",
      class: "question_input",
      name: blank.key ? `question_${id}_${blank.key}` : undefined,
      autocomplete: "off",
      disabled: params.disabledIndices?.includes(i) ?? false,
    }) as HTMLInputElement;
    inputs.push(input);
    // Input appended AFTER the label text so canvas-dom.ts's blankLabel()
    // (which clones the block, strips select/input, and reads what's left)
    // recovers exactly `blank.label` — an exact, checkable round trip.
    return h("p", {}, [blank.label ? `${blank.label} ` : null, input]);
  });
  const question = mountQuestion(id, "fill_in_multiple_blanks_question", [
    h("div", { class: "question_text user_content" }, [params.stemText, ...paragraphs]),
    originalQuestionTextDecoy(`<p>${params.stemText}</p>`),
  ]);
  return { question, blanks: params.blanks, inputs };
}

// =============================================================================
// no-inputs question (negative case)
// =============================================================================

export function buildNoInputsQuestion(params: { id?: string; stemText: string }): { question: HTMLElement } {
  const id = params.id ?? nextId("q");
  const question = mountQuestion(id, "text_only_question", [
    stemBlock(params.stemText),
    originalQuestionTextDecoy(`<p>${params.stemText}</p>`),
  ]);
  return { question };
}
