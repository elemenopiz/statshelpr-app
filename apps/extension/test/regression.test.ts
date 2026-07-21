/**
 * Regression cases for known-tricky answer formats, run once here in
 * isolation (rather than duplicated across every per-type file) against
 * small, purpose-built fixtures where the exact mechanism under test is
 * unambiguous.
 */
import { describe, expect, it } from "vitest";
import { deriveBlankAnswers, deriveSelectedChoices } from "@statshelpr/solver-core/solver";
import { collectAnswerChoices, collectBlanks, selectAnswerChoice, writeBlanks } from "../src/canvas-dom";
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
    const scraped = collectBlanks(question);
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

describe("known bugs — documented here, NOT fixed (see task's separately-owned upcoming fixes)", () => {
  it.fails(
    "FIXME(disabled text-fill inconsistency): a disabled/readOnly single text-fill input should be highlight-only-but-counted, like every other disabled input kind — it currently returns 0 and is never marked",
    () => {
      // Every OTHER disabled input kind (radio/checkbox via selectChoice(),
      // <select> via setSelectValue(), and a blank's <select> via writeBlanks)
      // is still collected as a choice and gets highlight-only treatment:
      // count 1, `.statshelpr-suggested` added, value/checked left alone.
      // fillTextInput() even HAS that exact branch:
      //   if (input.disabled || input.readOnly) {
      //     input.classList.add("statshelpr-suggested");
      //     return 1;
      //   }
      // — but it's dead code on this call path. collectAnswerChoices's
      // Priority-3 branch filters text inputs with
      // `.filter((i) => !i.disabled && !i.readOnly)` BEFORE a disabled/
      // readOnly text-fill input ever becomes a "choice", so
      // `choices.length === 1 && choices[0]?.kind === "text-fill"` can never
      // be true for such an input — selectAnswerChoice's earlier
      // `if (choices.length === 0) return 0;` fires first, silently, with no
      // highlight at all. Verified directly against canvas-dom.ts (not
      // inferred): collectAnswerChoices(question) is [] and
      // selectAnswerChoice(...) returns 0 for a disabled numerical input.
      const { question, input } = buildTextFillQuestion({
        stemText: "What is 2 + 2?",
        numerical: true,
        disabled: true,
      });
      const count = selectAnswerChoice(question, "Answer: 4", []);
      expect(count).toBe(1); // FAILS today: actually 0
      expect(input.classList.contains("statshelpr-suggested")).toBe(true); // FAILS today: never added
    },
  );

  it.fails(
    "FIXME(substring-matcher hardening): matchOption's longest-substring heuristic can pick the WRONG option when a matching blank's own label naturally contains a different pool term",
    () => {
      // solver-core's deriveBlankAnswers, stage 2 (label-echo fallback):
      // matchOption(text, options) picks the LONGEST option that appears as a
      // substring of the matched text chunk, with no requirement that the
      // match be unique. A matching question's shared option pool makes this
      // a real risk: this exact record's own captured label for the "Sample"
      // row is "A specific selection of cases from the population." — which
      // legitimately contains the word "population", a DIFFERENT pool term
      // ("Population", 10 chars) that's LONGER than the actually-intended
      // answer ("Sample", 6 chars). Verified directly against solver-core
      // (not inferred): deriveBlankAnswers picks "Population" here even
      // though the answer explicitly names "Sample" as the term.
      // NOT a risk for the primary "Blank N: <verbatim option>" contract
      // path — that hits matchOption's exact-match branch first, before the
      // substring-scoring branch is ever reached.
      const pool = ["Population", "Sample", "Data frame", "Code book", "Unit of analysis", "Sampling bias"];
      const blanks = [{ key: "blank1", label: "A specific selection of cases from the population.", options: pool }];
      const answer = "A specific selection of cases from the population. That's called a Sample.";
      const result = deriveBlankAnswers(answer, blanks);
      expect(result).toEqual([{ key: "blank1", answer: "Sample" }]); // FAILS today: answer is "Population"
    },
  );
});
