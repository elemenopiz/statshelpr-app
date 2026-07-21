/**
 * short_answer_question round trip — SYNTHESIZED. No short_answer_question
 * records exist in captures-20260722.json (the dataset's questionType
 * breakdown has no such entry). Structurally identical to numerical_question
 * at the canvas-dom.ts layer (single text-fill choice) except the input
 * lacks the `numerical_question_input` class and the answer is free text
 * rather than a number — used here to cover fillTextInput's quote-stripping,
 * which numerical.test.ts doesn't exercise (a quoted numeral is unrealistic).
 */
import { describe, expect, it } from "vitest";
import { deriveSelectedChoices } from "@statshelpr/solver-core/solver";
import { collectAnswerChoices, selectAnswerChoice } from "../src/canvas-dom";
import { buildTextFillQuestion } from "./fixtures/canvas-classic";
import { toApiChoices } from "./helpers";

const STEM = "Which base-R function fits a linear regression model?";

describe("short_answer_question (synthesized)", () => {
  it("scrape: single text-fill choice, label A, kind text-fill, no numerical_question_input class", () => {
    const { question, input } = buildTextFillQuestion({ stemText: STEM });
    const scraped = collectAnswerChoices(question);
    expect(scraped).toHaveLength(1);
    expect(scraped[0]!.label).toBe("A");
    expect(scraped[0]!.kind).toBe("text-fill");
    expect(input.classList.contains("numerical_question_input")).toBe(false);
    expect(input.classList.contains("question_input")).toBe(true);
  });

  it("round trip: 'Answer: <text>' fills the input, fires events, marks suggested", () => {
    const { question, input } = buildTextFillQuestion({ stemText: STEM });
    const scraped = collectAnswerChoices(question);
    const apiChoices = toApiChoices(scraped);
    let inputFired = false;
    let changeFired = false;
    input.addEventListener("input", () => (inputFired = true));
    input.addEventListener("change", () => (changeFired = true));

    const answer = "The base-R function for fitting a linear model is lm().\n\nAnswer: lm";
    const selectedLabels = deriveSelectedChoices(answer, apiChoices);
    expect(selectedLabels).toEqual([]); // text-fill never resolves selectedChoices

    const count = selectAnswerChoice(question, answer, selectedLabels);
    expect(count).toBe(1);
    expect(input.value).toBe("lm");
    expect(input.classList.contains("statshelpr-suggested")).toBe(true);
    expect(inputFired).toBe(true);
    expect(changeFired).toBe(true);
  });

  it("fallback: a quoted answer ('Answer: \"lm\"') has its wrapping quotes stripped", () => {
    const { question, input } = buildTextFillQuestion({ stemText: STEM });
    selectAnswerChoice(question, 'Answer: "lm"', []);
    expect(input.value).toBe("lm");
  });

  it("negative: a read-only short-answer input is highlight-only but still counted", () => {
    const { question, input } = buildTextFillQuestion({ stemText: STEM, readOnly: true });
    // Same documented gap as numerical's disabled case: a readOnly text-fill
    // input never becomes a "choice" in the first place, so it's silently
    // skipped rather than highlight-only-marked like every other input kind.
    // See regression.test.ts FIXME(disabled text-fill inconsistency).
    expect(collectAnswerChoices(question)).toEqual([]);
    const count = selectAnswerChoice(question, "Answer: lm", []);
    expect(count).toBe(0);
    expect(input.classList.contains("statshelpr-suggested")).toBe(false);
  });
});
