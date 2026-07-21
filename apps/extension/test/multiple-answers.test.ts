/**
 * multiple_answers_question round trip — driven by two REAL capture records:
 *   - 32223434: all 4 checkboxes correct, gnarly LaTeX-remnant subscript text
 *     ("The slope of the regression line is β 1") — used for scrape fidelity
 *     and the fallback text-match path.
 *   - 32444464: partial credit (A, C correct out of 4) with long prose
 *     choices — used for the primary label-driven round trip, the realistic
 *     "not all boxes checked" case.
 */
import { describe, expect, it } from "vitest";
import { deriveSelectedChoices } from "@statshelpr/solver-core/solver";
import { collectAnswerChoices, selectAnswerChoice } from "../src/canvas-dom";
import { buildChoiceQuestion } from "./fixtures/canvas-classic";
import { captureById } from "./fixtures/captures";
import { FALLBACK_PREFIX, toApiChoices, trackEvents } from "./helpers";

const GNARLY = captureById("32223434"); // all-correct, β/subscript text
const PARTIAL = captureById("32444464"); // A, C correct

describe("multiple_answers_question", () => {
  it("scrape: labels A..D in DOM order, gnarly LaTeX-remnant text preserved verbatim, kind checkbox", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_answers_question",
      inputType: "checkbox",
      stemText: GNARLY.questionText,
      choiceTexts: GNARLY.choices.map((c) => c.text),
    });
    const scraped = collectAnswerChoices(question);
    expect(scraped.map((c) => c.label)).toEqual(["A", "B", "C", "D"]);
    expect(scraped.map((c) => c.text)).toEqual(GNARLY.choices.map((c) => c.text));
    expect(scraped.some((c) => c.text.includes("β"))).toBe(true);
    expect(scraped.every((c) => c.kind === "checkbox")).toBe(true);
  });

  it("round trip: server-derived labels (Answer: A, C) checks exactly A and C, fires events, marks suggested", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_answers_question",
      inputType: "checkbox",
      stemText: PARTIAL.questionText,
      choiceTexts: PARTIAL.choices.map((c) => c.text),
    });
    const scraped = collectAnswerChoices(question);
    const apiChoices = toApiChoices(scraped);
    const { firedInput, firedChange } = trackEvents(question);

    const answer = [
      "The model has no interaction term (A is false)... wait, re-reading the",
      "equation there IS an interaction term, so A holds. B misstates the SEC",
      "rate. C correctly describes the slower SEC growth. D has the wrong sign.",
      "",
      "Answer: A, C",
    ].join("\n");
    const selectedLabels = deriveSelectedChoices(answer, apiChoices);
    expect(new Set(selectedLabels)).toEqual(new Set(["A", "C"]));

    const count = selectAnswerChoice(question, answer, selectedLabels);
    expect(count).toBe(2);

    const byLabel = new Map(scraped.map((c) => [c.label, c.input as HTMLInputElement]));
    expect(byLabel.get("A")!.checked).toBe(true);
    expect(byLabel.get("C")!.checked).toBe(true);
    expect(byLabel.get("B")!.checked).toBe(false);
    expect(byLabel.get("D")!.checked).toBe(false);
    expect(byLabel.get("A")!.closest(".answer")?.classList.contains("statshelpr-suggested")).toBe(true);
    expect(byLabel.get("C")!.closest(".answer")?.classList.contains("statshelpr-suggested")).toBe(true);
    expect(firedInput.has(byLabel.get("A")!)).toBe(true);
    expect(firedChange.has(byLabel.get("C")!)).toBe(true);
  });

  it("fallback: empty selectedLabels + prose quoting exactly two choices verbatim selects only those two", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_answers_question",
      inputType: "checkbox",
      stemText: GNARLY.questionText,
      choiceTexts: GNARLY.choices.map((c) => c.text),
    });
    const scraped = collectAnswerChoices(question);
    // Quotes choice A and C verbatim (each well over the 12-char substring
    // threshold findSelectedChoices requires); B and D are never mentioned.
    const answer =
      `${FALLBACK_PREFIX}two of the four claims hold: "The slope of the regression line is β 1" ` +
      `and "Model error is represented by e i" are both accurate; the other two overstate things.`;
    const count = selectAnswerChoice(question, answer, []);
    expect(count).toBe(2);

    const byLabel = new Map(scraped.map((c) => [c.label, c.input as HTMLInputElement]));
    expect(byLabel.get("A")!.checked).toBe(true);
    expect(byLabel.get("C")!.checked).toBe(true);
    expect(byLabel.get("B")!.checked).toBe(false);
    expect(byLabel.get("D")!.checked).toBe(false);
  });

  it("negative: a disabled checkbox among the selected set is highlight-only but still counted", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_answers_question",
      inputType: "checkbox",
      stemText: "Select all even numbers.",
      choiceTexts: ["2", "4", "5"],
      disabledIndices: [1], // "4", rendered disabled
    });
    const scraped = collectAnswerChoices(question);
    const count = selectAnswerChoice(question, "Answer: A, B", ["A", "B"]);
    expect(count).toBe(2);

    const byLabel = new Map(scraped.map((c) => [c.label, c.input as HTMLInputElement]));
    expect(byLabel.get("A")!.checked).toBe(true); // enabled — actually clicked
    expect(byLabel.get("B")!.checked).toBe(false); // disabled — never clicked
    expect(byLabel.get("B")!.closest(".answer")?.classList.contains("statshelpr-suggested")).toBe(true);
  });
});
