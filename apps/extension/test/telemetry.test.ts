/**
 * questionType-derivation + outcome-mapping coverage for the content-free
 * write-back OUTCOME beacon (see src/telemetry.ts, and content.ts's onSolve
 * for the one caller). Pure logic — no chrome.* anywhere, mirroring
 * telemetry.ts's own chrome-free-by-design rule — but deriveQuestionType
 * reuses the SAME real DOM fixtures (test/fixtures/canvas-classic.ts) every
 * other canvas-dom.ts suite in this directory builds from, so its
 * `.answer_match_left` matching-vs-multiple_dropdowns heuristic is exercised
 * against the actual Canvas markup shape it reads, not a hand-rolled stand-in.
 */
import { describe, expect, it } from "vitest";
import { collectAnswerChoices, collectBlanks } from "../src/canvas-dom";
import {
  buildChoiceQuestion,
  buildFillInMultipleBlanks,
  buildMatchingQuestion,
  buildMultipleDropdowns,
  buildNoInputsQuestion,
  buildSingleDropdown,
  buildTextFillQuestion,
} from "./fixtures/canvas-classic";
import { buildTelemetryBody, deriveOutcome, deriveQuestionType } from "../src/telemetry";

describe("deriveQuestionType", () => {
  it("2 radios reading True/False -> true_false", () => {
    const { question } = buildChoiceQuestion({
      questionType: "true_false_question",
      inputType: "radio",
      stemText: "True or False: the sky is blue.",
      choiceTexts: ["True", "False"],
    });
    const choices = collectAnswerChoices(question);
    expect(deriveQuestionType({ choices, blanks: [] })).toBe("true_false");
  });

  it("lowercase 'true'/'false' choice text still reads as true_false (case-insensitive)", () => {
    const { question } = buildChoiceQuestion({
      questionType: "true_false_question",
      inputType: "radio",
      stemText: "True or False: ...",
      choiceTexts: ["true", "false"],
    });
    const choices = collectAnswerChoices(question);
    expect(deriveQuestionType({ choices, blanks: [] })).toBe("true_false");
  });

  it("radios with non-True/False text -> multiple_choice", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_choice_question",
      inputType: "radio",
      stemText: "Pick one.",
      choiceTexts: ["Alpha", "Beta", "Gamma"],
    });
    const choices = collectAnswerChoices(question);
    expect(deriveQuestionType({ choices, blanks: [] })).toBe("multiple_choice");
  });

  it("exactly 2 radios but NOT True/False text -> multiple_choice, not misclassified as true_false", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_choice_question",
      inputType: "radio",
      stemText: "Pick one.",
      choiceTexts: ["Yes", "No"],
    });
    const choices = collectAnswerChoices(question);
    expect(deriveQuestionType({ choices, blanks: [] })).toBe("multiple_choice");
  });

  it("checkboxes -> multiple_answers", () => {
    const { question } = buildChoiceQuestion({
      questionType: "multiple_answers_question",
      inputType: "checkbox",
      stemText: "Select all that apply.",
      choiceTexts: ["A", "B", "C"],
    });
    const choices = collectAnswerChoices(question);
    expect(deriveQuestionType({ choices, blanks: [] })).toBe("multiple_answers");
  });

  it("single <select> -> dropdown", () => {
    const { question } = buildSingleDropdown({
      stemText: "Which test is appropriate?",
      optionTexts: ["one-sample t-test", "two-sample t-test", "chi-square test"],
    });
    const choices = collectAnswerChoices(question);
    expect(deriveQuestionType({ choices, blanks: [] })).toBe("dropdown");
  });

  it("single numerical fill-in -> numerical", () => {
    const { question } = buildTextFillQuestion({ stemText: "Enter the mean.", numerical: true });
    const choices = collectAnswerChoices(question);
    expect(deriveQuestionType({ choices, blanks: [] })).toBe("numerical");
  });

  it("single plain text fill-in (short_answer, non-numerical) -> numerical (no separate text/short-answer bucket in the pinned contract)", () => {
    const { question } = buildTextFillQuestion({ stemText: "Name the test statistic." });
    const choices = collectAnswerChoices(question);
    expect(deriveQuestionType({ choices, blanks: [] })).toBe("numerical");
  });

  it("2+ select-backed blanks WITH .answer_match_left rows -> matching", () => {
    const { question } = buildMatchingQuestion({
      stemText: "Match the terms below to their correct definitions.",
      rows: [
        { key: "b1", label: "Term 1", correctOption: "Def 1" },
        { key: "b2", label: "Term 2", correctOption: "Def 2" },
      ],
      sharedOptionPool: ["Def 1", "Def 2"],
    });
    const blanks = collectBlanks(question);
    expect(deriveQuestionType({ choices: [], blanks })).toBe("matching");
  });

  it("2+ select-backed blanks WITHOUT .answer_match_left rows -> multiple_dropdowns", () => {
    const { question } = buildMultipleDropdowns({
      stemText: "Fill in the blanks in the sentence below.",
      blanks: [
        { key: "b1", label: "first blank context", options: ["x", "y"], correctOption: "x" },
        { key: "b2", label: "second blank context", options: ["x", "y"], correctOption: "y" },
      ],
    });
    const blanks = collectBlanks(question);
    expect(deriveQuestionType({ choices: [], blanks })).toBe("multiple_dropdowns");
  });

  it("2+ input-backed blanks -> fill_in_multiple_blanks", () => {
    const { question } = buildFillInMultipleBlanks({
      stemText: "Fill in the blanks.",
      blanks: [
        { key: "aa", label: "first", correctValue: "1" },
        { key: "bb", label: "second", correctValue: "2" },
      ],
    });
    const blanks = collectBlanks(question);
    expect(deriveQuestionType({ choices: [], blanks })).toBe("fill_in_multiple_blanks");
  });

  it("nothing scrapable -> unknown", () => {
    const { question } = buildNoInputsQuestion({ stemText: "Just informational text, no inputs at all." });
    const choices = collectAnswerChoices(question);
    const blanks = collectBlanks(question);
    expect(choices).toHaveLength(0);
    expect(blanks).toHaveLength(0);
    expect(deriveQuestionType({ choices, blanks })).toBe("unknown");
  });
});

describe("deriveOutcome", () => {
  it("writeCount > 0 and no throw -> written", () => {
    expect(deriveOutcome(1, false)).toBe("written");
    expect(deriveOutcome(6, false)).toBe("written");
  });

  it("writeCount === 0 and no throw -> nowrite", () => {
    expect(deriveOutcome(0, false)).toBe("nowrite");
  });

  it("threw -> error, regardless of whatever writeCount was computed before the throw", () => {
    expect(deriveOutcome(0, true)).toBe("error");
    expect(deriveOutcome(3, true)).toBe("error");
  });
});

describe("buildTelemetryBody", () => {
  it("assembles exactly the pinned-contract fields, verbatim, nothing added or dropped", () => {
    const body = buildTelemetryBody({
      mode: "concept",
      questionType: "multiple_choice",
      confidence: "High",
      outcome: "written",
      writeCount: 1,
      clientLatencyMs: 842,
    });
    expect(body).toEqual({
      mode: "concept",
      questionType: "multiple_choice",
      confidence: "High",
      outcome: "written",
      writeCount: 1,
      clientLatencyMs: 842,
    });
    expect(Object.keys(body).sort()).toEqual(
      ["clientLatencyMs", "confidence", "mode", "outcome", "questionType", "writeCount"].sort(),
    );
  });

  it("round trips a calc/error/nowrite-count shape too (not just the happy path)", () => {
    const body = buildTelemetryBody({
      mode: "calc",
      questionType: "fill_in_multiple_blanks",
      confidence: "",
      outcome: "error",
      writeCount: 0,
      clientLatencyMs: 12345,
    });
    expect(body).toEqual({
      mode: "calc",
      questionType: "fill_in_multiple_blanks",
      confidence: "",
      outcome: "error",
      writeCount: 0,
      clientLatencyMs: 12345,
    });
  });
});
