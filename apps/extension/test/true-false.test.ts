/**
 * true_false_question round trip — SYNTHESIZED. Zero true_false_question
 * records exist in captures-20260722.json (confirmed: the dataset's
 * questionType breakdown is multiple_dropdowns/matching/multiple_choice/
 * multiple_answers/numerical only). Structurally it's just a 2-radio
 * multiple_choice, so this exercises the exact same canvas-dom.ts code path
 * as multiple-choice.test.ts with a different negative case (no-match,
 * rather than disabled) so the two files aren't redundant.
 */
import { describe, expect, it } from "vitest";
import { deriveSelectedChoices } from "@statshelpr/solver-core/solver";
import { collectAnswerChoices, selectAnswerChoice } from "../src/canvas-dom";
import { buildChoiceQuestion } from "./fixtures/canvas-classic";
import { FALLBACK_PREFIX, toApiChoices, trackEvents } from "./helpers";

const STEM =
  "True or False: for cardholders with the same student status and credit limit, a higher annual income is associated with a lower credit card balance.";

function build() {
  return buildChoiceQuestion({
    questionType: "true_false_question",
    inputType: "radio",
    stemText: STEM,
    choiceTexts: ["True", "False"],
  });
}

describe("true_false_question (synthesized)", () => {
  it("scrape: two radios, labels A/B, texts True/False in DOM order", () => {
    const { question } = build();
    const scraped = collectAnswerChoices(question);
    expect(scraped.map((c) => c.label)).toEqual(["A", "B"]);
    expect(scraped.map((c) => c.text)).toEqual(["True", "False"]);
    expect(scraped.every((c) => c.kind === "radio")).toBe(true);
  });

  it("round trip: server-derived label selects False, fires events, marks suggested", () => {
    const { question } = build();
    const scraped = collectAnswerChoices(question);
    const apiChoices = toApiChoices(scraped);
    const { firedInput, firedChange } = trackEvents(question);

    const answer =
      "A higher income is associated with a HIGHER balance in this model, so the statement is incorrect.\n\nAnswer: B";
    const selectedLabels = deriveSelectedChoices(answer, apiChoices);
    expect(selectedLabels).toEqual(["B"]);

    const count = selectAnswerChoice(question, answer, selectedLabels);
    expect(count).toBe(1);

    const falseChoice = scraped.find((c) => c.label === "B")!;
    const trueChoice = scraped.find((c) => c.label === "A")!;
    expect((falseChoice.input as HTMLInputElement).checked).toBe(true);
    expect((trueChoice.input as HTMLInputElement).checked).toBe(false);
    expect((falseChoice.input as HTMLInputElement).closest(".answer")?.classList.contains("statshelpr-suggested")).toBe(true);
    expect(firedInput.has(falseChoice.input)).toBe(true);
    expect(firedChange.has(falseChoice.input)).toBe(true);
  });

  it("fallback: empty selectedLabels + prose containing 'false' verbatim selects False via text match", () => {
    const { question } = build();
    const scraped = collectAnswerChoices(question);
    const answer = `${FALLBACK_PREFIX}the direction of the association described in the statement is false.`;
    const count = selectAnswerChoice(question, answer, []);
    expect(count).toBe(1);
    const falseChoice = scraped.find((c) => c.label === "B")!;
    expect((falseChoice.input as HTMLInputElement).checked).toBe(true);
  });

  it("negative: an answer matching neither True nor False writes nothing (count 0)", () => {
    const { question } = build();
    const answer = "Zzz inconclusive reasoning that never commits to either option.";
    const count = selectAnswerChoice(question, answer, []);
    expect(count).toBe(0);
  });
});
