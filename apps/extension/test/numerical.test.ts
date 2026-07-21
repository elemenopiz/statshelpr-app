/**
 * numerical_question round trip — driven by a REAL capture record
 * (canvasQuestionId 32408199: Amazon Prime sales-revenue prediction, real
 * answerText "2,087" — comma-formatted, a genuine "options containing
 * commas" case for a fill-in field).
 *
 * text-fill has a different contract than choice-based types:
 * selectAnswerChoice's very first branch is
 * `if (choices.length === 1 && choices[0]?.kind === "text-fill") return
 * fillTextInput(...)` — selectedLabels never factors in at all, so there is
 * no server-label-vs-client-fallback split the way choice questions have.
 * The interesting fallback axis for THIS type is fillTextInput()'s own
 * answer-text extraction regex across the shapes a model actually produces
 * ("Answer: x", "Final answer: x", bare "x") — that's what the "fallback"
 * test below covers instead.
 */
import { describe, expect, it } from "vitest";
import { deriveSelectedChoices } from "@statshelpr/solver-core/solver";
import { collectAnswerChoices, selectAnswerChoice } from "../src/canvas-dom";
import { buildTextFillQuestion } from "./fixtures/canvas-classic";
import { captureById } from "./fixtures/captures";
import { toApiChoices } from "./helpers";

const REC = captureById("32408199"); // answerText "2,087"

describe("numerical_question", () => {
  it("scrape: single text-fill choice, label A, placeholder-fallback text matches real capture ('(fill in your answer)')", () => {
    const { question } = buildTextFillQuestion({ stemText: REC.questionText, numerical: true });
    const scraped = collectAnswerChoices(question);
    expect(scraped).toHaveLength(1);
    expect(scraped[0]!.label).toBe("A");
    expect(scraped[0]!.kind).toBe("text-fill");
    expect(scraped[0]!.text).toBe(REC.choices[0]!.text); // "(fill in your answer)"
  });

  it("round trip: 'Answer: <comma-formatted value>.' fills the input verbatim (minus the trailing period), fires events, marks suggested", () => {
    const { question, input } = buildTextFillQuestion({ stemText: REC.questionText, numerical: true });
    const scraped = collectAnswerChoices(question);
    const apiChoices = toApiChoices(scraped);
    let inputFired = false;
    let changeFired = false;
    input.addEventListener("input", () => (inputFired = true));
    input.addEventListener("change", () => (changeFired = true));

    // Realistic model output: reasoning line, then the contract's final
    // "Answer: <value>" line with a trailing period (a documented tricky format).
    const answer = `764 + 1323(1) = 2,087.\n\nAnswer: ${REC.answerText}.`;
    // deriveSelectedChoices is still called in production for every solve
    // (content.ts doesn't special-case text-fill) — for a single text-type
    // choice it correctly finds nothing to select and returns [].
    const selectedLabels = deriveSelectedChoices(answer, apiChoices);
    expect(selectedLabels).toEqual([]);

    const count = selectAnswerChoice(question, answer, selectedLabels);
    expect(count).toBe(1);
    expect(input.value).toBe("2,087"); // trailing period stripped, comma kept verbatim
    expect(input.classList.contains("statshelpr-suggested")).toBe(true);
    expect(inputFired).toBe(true);
    expect(changeFired).toBe(true);
  });

  it("fallback: fillTextInput's extraction regex handles 'Final answer:' and bare (no-prefix) value shapes", () => {
    const { question: q1, input: i1 } = buildTextFillQuestion({ stemText: REC.questionText, numerical: true });
    selectAnswerChoice(q1, `Working it out step by step...\n\nFinal answer: ${REC.answerText}`, []);
    expect(i1.value).toBe("2,087");

    const { question: q2, input: i2 } = buildTextFillQuestion({ stemText: REC.questionText, numerical: true });
    // No "Answer:" prefix at all — fillTextInput's regex falls back to using
    // the whole answer string verbatim.
    selectAnswerChoice(q2, REC.answerText!, []);
    expect(i2.value).toBe("2,087");
  });

  it("negative: a disabled numerical input is highlight-only but still counted, value stays empty", () => {
    const { question, input } = buildTextFillQuestion({ stemText: REC.questionText, numerical: true, disabled: true });
    // A disabled/readOnly text-fill input is filtered out of
    // collectAnswerChoices entirely (see FIXME in regression.test.ts) — this
    // negative documents the CURRENT (buggy) behavior for numerical
    // specifically: nothing is collected, so selectAnswerChoice can't even
    // reach fillTextInput's own (dead, for this path) disabled branch.
    expect(collectAnswerChoices(question)).toEqual([]);
    const count = selectAnswerChoice(question, "Answer: 42", []);
    expect(count).toBe(0);
    expect(input.classList.contains("statshelpr-suggested")).toBe(false);
  });

  it.fails(
    "FIXME(numeric $/comma sanitize): a dollar-prefixed answer should be written as a clean numeric value, not left with a literal '$'",
    () => {
      const { question, input } = buildTextFillQuestion({ stemText: REC.questionText, numerical: true });
      selectAnswerChoice(question, "Answer: $2,087.", []);
      // Desired behavior once the known "numeric $/comma sanitize" fix (named
      // in this task's own briefing as a separately-owned upcoming change)
      // lands: the '$' should not be written into a numerical input's value.
      expect(input.value).not.toContain("$");
    },
  );
});
