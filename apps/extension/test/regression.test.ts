/**
 * Regression cases for known-tricky answer formats, run once here in
 * isolation (rather than duplicated across every per-type file) against
 * small, purpose-built fixtures where the exact mechanism under test is
 * unambiguous.
 */
import { describe, expect, it } from "vitest";
import { deriveBlankAnswers, deriveSelectedChoices } from "@statshelpr/solver-core/solver";
import {
  collectAnswerChoices,
  collectBlanks,
  findStem,
  selectAnswerChoice,
  writeBlanks,
  type AnswerChoice,
  type SelectScrapedBlank,
} from "../src/canvas-dom";
import { buildChoiceQuestion, buildMultipleDropdowns, buildTextFillQuestion } from "./fixtures/canvas-classic";
import { captureById } from "./fixtures/captures";
import { toApiBlanks, toApiChoices } from "./helpers";

describe("regression: answer-format parsing (deriveSelectedChoices)", () => {
  it("'Answer: A.' — trailing period after the letter doesn't break label extraction", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_choice_question",
      inputType: "radio",
      stemText: "Pick one.",
      choiceTexts: ["one", "two", "three", "four"],
    });
    const apiChoices = toApiChoices(collectAnswerChoices(question));
    expect(deriveSelectedChoices("Reasoning...\n\nAnswer: A.", apiChoices)).toEqual(["A"]);
    expect(selectAnswerChoice(question, "Reasoning...\n\nAnswer: A.", ["A"])).toBe(1);
  });

  it("'Answer: (b)' — parenthesized, lowercase letter still resolves to the right label", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_choice_question",
      inputType: "radio",
      stemText: "Pick one.",
      choiceTexts: ["one", "two", "three", "four"],
    });
    const apiChoices = toApiChoices(collectAnswerChoices(question));
    expect(deriveSelectedChoices("Reasoning...\n\nAnswer: (b)", apiChoices)).toEqual(["B"]);
  });

  it("'Answer: A, C' — comma-separated multi-select only fires on checkbox (allowMultiple) pools", () => {
    const { question: checkboxQ } = buildChoiceQuestion({
      questionType: "multiple_answers_question",
      inputType: "checkbox",
      stemText: "Pick all that apply.",
      choiceTexts: ["one", "two", "three", "four"],
    });
    const checkboxChoices = toApiChoices(collectAnswerChoices(checkboxQ));
    expect(new Set(deriveSelectedChoices("Answer: A, C", checkboxChoices))).toEqual(new Set(["A", "C"]));

    // Documents the (correct, by design) contrast: a single-answer radio pool
    // short-circuits on the FIRST label found, since allowMultiple is false —
    // a plain MC question never legitimately has more than one correct letter.
    const { question: radioQ } = buildChoiceQuestion({
      questionType: "multiple_choice_question",
      inputType: "radio",
      stemText: "Pick one.",
      choiceTexts: ["one", "two", "three", "four"],
    });
    const radioChoices = toApiChoices(collectAnswerChoices(radioQ));
    expect(deriveSelectedChoices("Answer: A, C", radioChoices)).toEqual(["A"]);
  });

  it("options containing commas/currency ('$1,820,000') don't confuse label-based extraction", () => {
    const rec = captureById("32444463"); // NCAA bonus MC, choices up to $1,820,000
    const { question } = buildChoiceQuestion({
      questionType: "multiple_choice_question",
      inputType: "radio",
      stemText: rec.questionText,
      choiceTexts: rec.choices.map((c) => c.text),
    });
    const scraped = collectAnswerChoices(question);
    const apiChoices = toApiChoices(scraped);
    const answer = "The predicted bonus is $1,820,000.\n\nAnswer: D";
    expect(deriveSelectedChoices(answer, apiChoices)).toEqual(["D"]);
    expect(selectAnswerChoice(question, answer, ["D"])).toBe(1);
    const d = scraped.find((c) => c.label === "D")!;
    expect((d.input as HTMLInputElement).checked).toBe(true);
  });
});

describe("regression: duplicate option lists across different blanks don't cross-wire (deriveBlankAnswers + writeBlanks)", () => {
  it("two blanks sharing an IDENTICAL 2-option pool resolve independently to opposite answers", () => {
    const { question } = buildMultipleDropdowns({
      stemText: "As X grows, the response tends to __blank1__, while the residual spread tends to __blank2__.",
      blanks: [
        { key: "trend", label: "As X grows, the response tends to", options: ["increase", "decrease"], correctOption: "increase" },
        { key: "spread", label: "the residual spread tends to", options: ["increase", "decrease"], correctOption: "decrease" },
      ],
    });
    // This fixture only ever builds <select>-backed blanks — narrow the
    // ScrapedBlank union (select-backed vs input-backed fill-in-multiple-blanks,
    // see canvas-dom.ts) so `.select` below type-checks without per-access guards.
    const scraped = collectBlanks(question) as SelectScrapedBlank[];
    const apiBlanks = toApiBlanks(scraped);

    const answer = "Blank 1: increase\nBlank 2: decrease";
    const blankAnswers = deriveBlankAnswers(answer, apiBlanks);
    expect(blankAnswers).toEqual([
      { key: "blank1", answer: "increase" },
      { key: "blank2", answer: "decrease" },
    ]);

    const count = writeBlanks(question, blankAnswers);
    expect(count).toBe(2);
    expect(scraped[0]!.select.options[scraped[0]!.select.selectedIndex]?.textContent).toBe("increase");
    expect(scraped[1]!.select.options[scraped[1]!.select.selectedIndex]?.textContent).toBe("decrease");
  });
});

describe("regression: trailing-period answers on a fill-in field", () => {
  it("'Answer: 42.5.' strips only the sentence-ending period, not the decimal point", () => {
    const { question, input } = buildTextFillQuestion({ stemText: "What is 40 + 2.5?", numerical: true });
    selectAnswerChoice(question, "Answer: 42.5.", []);
    expect(input.value).toBe("42.5");
  });
});

describe("fixed: disabled text-fill inconsistency (was FIXME)", () => {
  it("a disabled/readOnly single text-fill input is highlight-only-but-counted, like every other disabled input kind", () => {
    // Every OTHER disabled input kind (radio/checkbox via selectChoice(),
    // <select> via setSelectValue(), and a blank's <select> via writeBlanks)
    // is collected as a choice and gets highlight-only treatment: count 1,
    // `.statshelpr-suggested` added, value/checked left alone.
    // fillTextInput() has that exact branch:
    //   if (input.disabled || input.readOnly) {
    //     input.classList.add("statshelpr-suggested");
    //     return 1;
    //   }
    // — collectAnswerChoices's Priority-3 branch now collects a sole
    // disabled/readOnly text input as a "text-fill" choice too (only when NO
    // input is enabled — an enabled sibling still wins, unchanged), so this
    // branch is reachable and the input gets the same highlight-only
    // treatment as every other disabled input kind instead of being silently
    // skipped.
    const { question, input } = buildTextFillQuestion({
      stemText: "What is 2 + 2?",
      numerical: true,
      disabled: true,
    });
    const count = selectAnswerChoice(question, "Answer: 4", []);
    expect(count).toBe(1);
    expect(input.classList.contains("statshelpr-suggested")).toBe(true);
    expect(input.value).toBe(""); // disabled — never set
  });
});

describe("fixed: substring-matcher hardening (was FIXME)", () => {
  it("matchOption's label-echo stage no longer picks the WRONG option when a matching blank's own label naturally contains a different pool term", () => {
    // solver-core's deriveBlankAnswers, stage 2 (label-echo fallback): a
    // matching question's shared option pool makes the old raw
    // longest-substring heuristic a real risk — this exact record's own
    // captured label for the "Sample" row is "A specific selection of cases
    // from the population." — which legitimately contains the word
    // "population", a DIFFERENT pool term ("Population", 10 chars) that's
    // LONGER than the actually-intended answer ("Sample", 6 chars). Fixed by
    // stripping the echoed label out of the line before matchOption ever
    // sees it, so "population" (part of the label, not the answer) can't
    // compete in the first place. NOT a risk for the primary
    // "Blank N: <verbatim option>" contract path — that hits matchOption's
    // exact-match branch first, before the substring-scoring branch is ever
    // reached.
    const pool = ["Population", "Sample", "Data frame", "Code book", "Unit of analysis", "Sampling bias"];
    const blanks = [{ key: "blank1", label: "A specific selection of cases from the population.", options: pool }];
    const answer = "A specific selection of cases from the population. That's called a Sample.";
    const result = deriveBlankAnswers(answer, blanks);
    expect(result).toEqual([{ key: "blank1", answer: "Sample" }]);
  });
});

describe("equation-image choices (img.alt text extraction)", () => {
  it("a choice that's ONLY an equation image (LaTeX in img.alt, no other text) is scrapeable and selectable end-to-end", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_choice_question",
      inputType: "radio",
      stemText: "Which equation gives the fitted slope?",
      choiceTexts: ["y = mx + b", "", "y = a + bx^2", "y = c"],
      choiceImageAlts: { 1: "\\beta_1 = 2.5" },
    });
    const scraped = collectAnswerChoices(question);
    // The image-only choice is still present — not dropped — and keeps its
    // rightful letter (B), so the letter list stays aligned with what's
    // actually rendered on screen.
    expect(scraped).toHaveLength(4);
    expect(scraped.map((c) => c.label)).toEqual(["A", "B", "C", "D"]);
    expect(scraped[1]!.text).toContain("beta_1");

    const count = selectAnswerChoice(question, "Answer: B", ["B"]);
    expect(count).toBe(1);
    expect((scraped[1]!.input as HTMLInputElement).checked).toBe(true);
    for (const c of scraped.filter((c) => c.label !== "B")) {
      expect((c.input as HTMLInputElement).checked).toBe(false);
    }
  });

  it("an alt-less equation image (no alt attribute at all) keeps its letter via a placeholder instead of being dropped", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_choice_question",
      inputType: "radio",
      stemText: "Which graph best fits the data?",
      choiceTexts: ["graph one", "", "graph three"],
      choiceImageAlts: { 1: undefined },
    });
    const scraped = collectAnswerChoices(question);
    expect(scraped).toHaveLength(3);
    expect(scraped.map((c) => c.label)).toEqual(["A", "B", "C"]);
    expect(scraped[1]!.text).toBe("(image 2)");

    const count = selectAnswerChoice(question, "Answer: B", ["B"]);
    expect(count).toBe(1);
    expect((scraped[1]!.input as HTMLInputElement).checked).toBe(true);
  });
});

describe("doubled equation text (dedupeDoubled normalization parity with extension-capture)", () => {
  it("a choice whose text is Canvas's doubled rendered-math + raw-LaTeX-source rendering scrapes deduped and still round-trips", () => {
    // Mirrors apps/extension-capture/src/scrape.ts's own dedupeDoubled() doc
    // comment example almost verbatim: Canvas concatenates the visual-math
    // rendering AND the raw LaTeX source into one textContent run.
    const doubled = "The slope is β1 The slope is \\beta_1";
    const { question } = buildChoiceQuestion({
      questionType: "multiple_choice_question",
      inputType: "radio",
      stemText: "Which choice reports the fitted slope?",
      choiceTexts: ["The intercept is 8.6", doubled, "The R-squared is 0.87"],
    });
    const scraped = collectAnswerChoices(question);
    expect(scraped[1]!.text).toBe("The slope is β1");
    expect(scraped[1]!.text).not.toContain("\\beta_1");

    const count = selectAnswerChoice(question, "Answer: B", ["B"]);
    expect(count).toBe(1);
    expect((scraped[1]!.input as HTMLInputElement).checked).toBe(true);
  });
});

describe("fixed: verify-before-click (DOM-shift guard)", () => {
  it("a stale backend label is remapped by original choice text, even when the answer is only a letter", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_choice_question",
      inputType: "radio",
      stemText: "Pick one.",
      choiceTexts: ["alpha choice", "bravo choice", "charlie choice"],
    });
    // The scrape sent to the server BEFORE the async solve round-trip.
    const originalChoices: AnswerChoice[] = collectAnswerChoices(question);
    expect(originalChoices.map((c) => c.label)).toEqual(["A", "B", "C"]);
    const bravo = originalChoices.find((c) => c.label === "B")!;

    // Simulate the DOM shifting while the solve was in flight: a new choice
    // row is inserted at the very top of .answers, pushing every existing row
    // down one slot. Re-scraped now, "B" points at what used to be "A" — a
    // completely different choice than the one the server actually saw as B.
    const answersEl = question.querySelector(".answers")!;
    const newInput = document.createElement("input");
    newInput.type = "radio";
    newInput.id = "question_shift_answer_new";
    const newLabel = document.createElement("label");
    newLabel.setAttribute("for", newInput.id);
    const newText = document.createElement("span");
    newText.className = "answer_text";
    newText.textContent = "newly inserted choice";
    newLabel.appendChild(newText);
    const newRow = document.createElement("div");
    newRow.className = "answer answer_new";
    newRow.appendChild(newInput);
    newRow.appendChild(newLabel);
    answersEl.insertBefore(newRow, answersEl.firstChild);

    const reScraped = collectAnswerChoices(question);
    expect(reScraped.map((c) => c.text)).toEqual([
      "newly inserted choice",
      "alpha choice",
      "bravo choice",
      "charlie choice",
    ]);
    expect(reScraped.find((c) => c.label === "B")!.text).toBe("alpha choice"); // no longer "bravo choice"

    // Backend answered based on the ORIGINAL scrape — it said "B" (bravo choice).
    // This mirrors the production log that exposed the bug: the model's
    // answer is just "Answer: B", so there is no answer-text fallback to save
    // a stale letter mapping.
    const answer = "Answer: B";
    const count = selectAnswerChoice(question, answer, ["B"], originalChoices);
    expect(count).toBe(1);

    // The actual "bravo choice" element gets checked (found via text, not
    // via the now-stale "B" letter)...
    expect((bravo.input as HTMLInputElement).checked).toBe(true);
    // ...and whatever is CURRENTLY labeled "B" (the wrong element) is not.
    const stillLabeledB = reScraped.find((c) => c.label === "B")!;
    expect((stillLabeledB.input as HTMLInputElement).checked).toBe(false);
  });

  it("refuses an ambiguous stale mapping instead of guessing between duplicate choice texts", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_choice_question",
      inputType: "radio",
      stemText: "Pick one.",
      choiceTexts: ["same choice", "different choice", "same choice"],
    });
    const originalChoices: AnswerChoice[] = collectAnswerChoices(question);
    const answersEl = question.querySelector(".answers")!;
    const newInput = document.createElement("input");
    newInput.type = "radio";
    newInput.id = "question_shift_answer_ambiguous_new";
    const newLabel = document.createElement("label");
    newLabel.setAttribute("for", newInput.id);
    newLabel.textContent = "newly inserted choice";
    const newRow = document.createElement("div");
    newRow.className = "answer answer_ambiguous_new";
    newRow.append(newInput, newLabel);
    answersEl.insertBefore(newRow, answersEl.firstChild);

    const count = selectAnswerChoice(question, "Answer: A", ["A"], originalChoices);
    expect(count).toBe(0);
    expect([...question.querySelectorAll<HTMLInputElement>('input[type="radio"]')].every((input) => !input.checked)).toBe(true);
  });

  it("with no originalChoices supplied, behavior is unchanged — a backend label is trusted outright (back-compat default)", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_choice_question",
      inputType: "radio",
      stemText: "Pick one.",
      choiceTexts: ["one", "two", "three"],
    });
    const count = selectAnswerChoice(question, "Answer: B", ["B"]);
    expect(count).toBe(1);
    const scraped = collectAnswerChoices(question);
    expect((scraped.find((c) => c.label === "B")!.input as HTMLInputElement).checked).toBe(true);
  });
});

describe("regression: multi-letter choice label matching (AA vs A substring safety)", () => {
  it("deriveSelectedChoices matches AA without falsely matching A when pool contains both", () => {
    const apiChoices = [
      { label: "A", text: "Option Alpha", type: "radio" as const },
      { label: "AA", text: "Option Double Alpha", type: "radio" as const },
    ];
    // Length-descending regex order ensures "AA" matches as AA, not as prefix "A"
    expect(deriveSelectedChoices("Reasoning...\n\nAnswer: AA", apiChoices)).toEqual(["AA"]);
    expect(deriveSelectedChoices("Reasoning...\n\nAnswer: A", apiChoices)).toEqual(["A"]);
  });
});

describe("regression: findStem matching container element directly", () => {
  it("findStem returns the element itself when it matches a stem selector", () => {
    const el = document.createElement("div");
    el.className = "question_text";
    el.textContent = "What is the standard error?";
    const stem = findStem(el);
    expect(stem).toBe(el);
  });
});
