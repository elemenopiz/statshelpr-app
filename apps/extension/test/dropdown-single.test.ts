/**
 * Single dropdown_question round trip — SYNTHESIZED. No standalone
 * dropdown_question records exist in captures-20260722.json (every captured
 * `choices[].type` is radio/checkbox/text; "dropdown" never appears — the
 * only dropdown-shaped captures are multiple_dropdowns_question, which is
 * 2+ blanks and mutually exclusive with this single-<select> shape per
 * canvas-dom.ts's own collectAnswerChoices Priority-2 comment).
 */
import { describe, expect, it } from "vitest";
import { deriveSelectedChoices } from "@statshelpr/solver-core/solver";
import { collectAnswerChoices, selectAnswerChoice } from "../src/canvas-dom";
import { buildSingleDropdown } from "./fixtures/canvas-classic";
import { FALLBACK_PREFIX, toApiChoices } from "./helpers";

const STEM = "Which statistical test is most appropriate for comparing a single sample mean to a known population value?";
const OPTIONS = [
  "one-sample t-test",
  "two-sample t-test",
  "paired t-test",
  "chi-square test of independence",
  "one-way ANOVA",
];

describe("dropdown_question (single <select>, synthesized)", () => {
  it("scrape: placeholder skipped, labels A..E in option order, kind dropdown-option", () => {
    const { question } = buildSingleDropdown({ stemText: STEM, optionTexts: OPTIONS });
    const scraped = collectAnswerChoices(question);
    expect(scraped.map((c) => c.label)).toEqual(["A", "B", "C", "D", "E"]);
    expect(scraped.map((c) => c.text)).toEqual(OPTIONS);
    expect(scraped.every((c) => c.kind === "dropdown-option")).toBe(true);
    expect(scraped.some((c) => c.text.includes("Select"))).toBe(false);
  });

  it("round trip: server-derived label sets the <select> value, fires events, marks suggested", () => {
    const { question } = buildSingleDropdown({ stemText: STEM, optionTexts: OPTIONS });
    const scraped = collectAnswerChoices(question);
    const apiChoices = toApiChoices(scraped);
    const sel = scraped[0]!.input as HTMLSelectElement;
    let inputFired = false;
    let changeFired = false;
    sel.addEventListener("input", () => (inputFired = true));
    sel.addEventListener("change", () => (changeFired = true));

    const answer = "A single sample compared to a known population value calls for a one-sample t-test.\n\nAnswer: A";
    const selectedLabels = deriveSelectedChoices(answer, apiChoices);
    expect(selectedLabels).toEqual(["A"]);

    const count = selectAnswerChoice(question, answer, selectedLabels);
    expect(count).toBe(1);
    expect(sel.value).toBe(scraped[0]!.optionValue);
    expect(sel.options[sel.selectedIndex]?.textContent).toBe("one-sample t-test");
    expect(sel.classList.contains("statshelpr-suggested")).toBe(true);
    expect(inputFired).toBe(true);
    expect(changeFired).toBe(true);
  });

  it("fallback: empty selectedLabels + prose containing the option text verbatim still selects it", () => {
    const { question } = buildSingleDropdown({ stemText: STEM, optionTexts: OPTIONS });
    const scraped = collectAnswerChoices(question);
    const sel = scraped[0]!.input as HTMLSelectElement;

    const answer = `${FALLBACK_PREFIX}the design described calls for a one-sample t-test here.`;
    const count = selectAnswerChoice(question, answer, []);
    expect(count).toBe(1);
    expect(sel.options[sel.selectedIndex]?.textContent).toBe("one-sample t-test");
  });

  it("negative: a disabled <select> is highlight-only but still counted, value stays at placeholder", () => {
    const { question } = buildSingleDropdown({ stemText: STEM, optionTexts: OPTIONS, disabled: true });
    const scraped = collectAnswerChoices(question);
    const sel = scraped[0]!.input as HTMLSelectElement;
    expect(sel.value).toBe(""); // placeholder

    const count = selectAnswerChoice(question, "Answer: A", ["A"]);
    expect(count).toBe(1);
    expect(sel.value).toBe(""); // untouched — never set
    expect(sel.classList.contains("statshelpr-suggested")).toBe(true);
  });
});
