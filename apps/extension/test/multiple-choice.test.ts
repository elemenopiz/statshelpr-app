/**
 * multiple_choice_question round trip — driven by a REAL capture record
 * (canvasQuestionId 32444463: NCAA coach-bonus regression prediction, 6
 * currency-formatted radio choices up to $1,820,000). Real captured MC
 * questions never exceed a handful of choices with plain-ish text, so the
 * currency/comma formatting here already covers "options containing commas"
 * from the regression list; deeper format-parsing edge cases (trailing
 * periods, parenthesized letters, multi-answer lists) live in
 * regression.test.ts so they're not duplicated across every type file.
 */
import { describe, expect, it } from "vitest";
import { deriveSelectedChoices } from "@statshelpr/solver-core/solver";
import { collectAnswerChoices, selectAnswerChoice } from "../src/canvas-dom";
import { buildChoiceQuestion, buildNoInputsQuestion } from "./fixtures/canvas-classic";
import { captureById } from "./fixtures/captures";
import { FALLBACK_PREFIX, toApiChoices, trackEvents } from "./helpers";

const REC = captureById("32444463");

describe("multiple_choice_question", () => {
  it("scrape: assigns labels A..F in DOM order and preserves choice text verbatim", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_choice_question",
      inputType: "radio",
      stemText: REC.questionText,
      choiceTexts: REC.choices.map((c) => c.text),
    });
    const scraped = collectAnswerChoices(question);
    expect(scraped.map((c) => c.label)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(scraped.map((c) => c.text)).toEqual(REC.choices.map((c) => c.text));
    expect(scraped.every((c) => c.kind === "radio")).toBe(true);
  });

  it("round trip: server-derived label (Answer: A.) selects the right radio, fires events, marks suggested", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_choice_question",
      inputType: "radio",
      stemText: REC.questionText,
      choiceTexts: REC.choices.map((c) => c.text),
    });
    const scraped = collectAnswerChoices(question);
    const apiChoices = toApiChoices(scraped);
    const { firedInput, firedChange } = trackEvents(question);

    // The real model-answer contract: reasoning, then a final "Answer: <letter>."
    // line (trailing period — a documented tricky format).
    const answer = [
      "Plugging Salary=2 and SEC=0 into the fitted equation gives a predicted",
      "bonus of $750,000, which matches choice A.",
      "",
      "Answer: A.",
    ].join("\n");
    const selectedLabels = deriveSelectedChoices(answer, apiChoices);
    expect(selectedLabels).toEqual(["A"]);

    const count = selectAnswerChoice(question, answer, selectedLabels);
    expect(count).toBe(1);

    const correct = scraped.find((c) => c.label === "A")!;
    const others = scraped.filter((c) => c.label !== "A");
    expect((correct.input as HTMLInputElement).checked).toBe(true);
    for (const c of others) expect((c.input as HTMLInputElement).checked).toBe(false);

    const correctRow = (correct.input as HTMLInputElement).closest(".answer");
    expect(correctRow?.classList.contains("statshelpr-suggested")).toBe(true);
    expect(firedInput.has(correct.input)).toBe(true);
    expect(firedChange.has(correct.input)).toBe(true);
  });

  it("fallback: empty selectedLabels + prose containing the choice text verbatim still selects it (client-side text match)", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_choice_question",
      inputType: "radio",
      stemText: REC.questionText,
      choiceTexts: REC.choices.map((c) => c.text),
    });
    const scraped = collectAnswerChoices(question);

    // No "Answer: X" line at all — proves selectAnswerChoice's
    // pickByLetterOrText substring-scoring fallback, not the label-parse path.
    const answer = `${FALLBACK_PREFIX}the predicted bonus for this scenario comes out to $750,000, comfortably closest to the first listed option.`;
    const count = selectAnswerChoice(question, answer, []);
    expect(count).toBe(1);

    const a = scraped.find((c) => c.label === "A")!;
    expect((a.input as HTMLInputElement).checked).toBe(true);
  });

  it("negative: a disabled radio is highlight-only (not clicked) but still counted", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_choice_question",
      inputType: "radio",
      stemText: "Which of these is prime?",
      choiceTexts: ["4", "6", "7", "9"],
      disabledIndices: [2], // "7", the correct one, rendered disabled (locked/graded view)
    });
    const scraped = collectAnswerChoices(question);
    const count = selectAnswerChoice(question, "Answer: C", ["C"]);
    expect(count).toBe(1);

    const c = scraped.find((x) => x.label === "C")!;
    const input = c.input as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.checked).toBe(false); // never clicked — disabled short-circuits before .click()
    expect(input.closest(".answer")?.classList.contains("statshelpr-suggested")).toBe(true);
  });

  it("negative: a question with no scrapable inputs writes nothing (count 0)", () => {
    // A text-only / information block: a stem with no .answers section at all.
    const { question } = buildNoInputsQuestion({ stemText: "For context only, no question here." });
    expect(collectAnswerChoices(question)).toEqual([]);
    const count = selectAnswerChoice(question, "Answer: A", ["A"]);
    expect(count).toBe(0);
  });
});
