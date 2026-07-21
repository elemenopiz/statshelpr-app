/**
 * multiple_dropdowns_question round trip — driven by a REAL capture record
 * (canvasQuestionId 32408330: grocery.csv pricing regression, 7 inline
 * dropdown blanks). Deliberately picked because it mixes BOTH label styles
 * canvas-dom.ts's blankLabel() can produce: a bare fallback (label === key,
 * e.g. "negative", "more") for blanks with little surrounding prose, and a
 * full descriptive sentence for others — real Canvas questions produce both.
 *
 * Blanks questions have no `selectedLabels` concept (writeBlanks takes only
 * the BlankAnswer[] derived by deriveBlankAnswers — there's no separate
 * server-derived-labels vs client-fallback split the way selectAnswerChoice
 * has). So "fallback path" here is reinterpreted as: deriveBlankAnswers has
 * its OWN internal fallback ladder (exact "Blank N:" line -> bare "N. "
 * line -> label-echo line -> sole-mentioned-option) — the round-trip test
 * exercises stage 1 (the contract format), the dedicated fallback test
 * exercises stage 3 (soleMentionedOption) with free-form prose that never
 * uses the "Blank N:" format at all.
 */
import { describe, expect, it } from "vitest";
import { deriveBlankAnswers } from "@statshelpr/solver-core/solver";
import { collectBlanks, writeBlanks, type SelectScrapedBlank } from "../src/canvas-dom";
import { buildMultipleDropdowns, type BlankSpec } from "./fixtures/canvas-classic";
import { captureById } from "./fixtures/captures";
import { toApiBlanks } from "./helpers";

const REC = captureById("32408330");

function allBlankSpecs(): BlankSpec[] {
  return REC.blanks.map((b) => ({
    key: b.key,
    label: b.label,
    options: b.options,
    correctOption: b.correct,
  }));
}

describe("multiple_dropdowns_question", () => {
  it("scrape: 7 blanks keyed blank1..blank7 positionally, real labels (both bare-key and full-sentence) and option pools preserved, placeholder skipped", () => {
    const { question } = buildMultipleDropdowns({ stemText: REC.questionText, blanks: allBlankSpecs() });
    // This fixture only ever builds <select>-backed blanks — narrow the
    // ScrapedBlank union (select-backed vs input-backed fill-in-multiple-blanks,
    // see canvas-dom.ts) so `.select` below type-checks without per-access guards.
    const scraped = collectBlanks(question) as SelectScrapedBlank[];

    expect(scraped).toHaveLength(7);
    // canvas-dom.ts's collectBlanks keys blanks POSITIONALLY (blank1..blankN)
    // regardless of the <select>'s own name/id — unlike the capture
    // pipeline's scrape.ts, which derives semantic keys from the name
    // attribute. This is the documented, intended contract (task spec: with
    // "blanks keyed blank1..N"), not a bug.
    expect(scraped.map((b) => b.key)).toEqual(["blank1", "blank2", "blank3", "blank4", "blank5", "blank6", "blank7"]);
    expect(scraped.map((b) => b.label)).toEqual(REC.blanks.map((b) => b.label));
    expect(scraped.map((b) => b.options.map((o) => o.text))).toEqual(REC.blanks.map((b) => b.options));
    // placeholder "[ Select ]" never appears among scraped options
    for (const b of scraped) expect(b.options.some((o) => /select/i.test(o.text))).toBe(false);
  });

  it("round trip: contract-format answer ('Blank N: <option>' per line) fills every select correctly, fires events, marks suggested", () => {
    const specs = allBlankSpecs();
    const { question } = buildMultipleDropdowns({ stemText: REC.questionText, blanks: specs });
    // This fixture only ever builds <select>-backed blanks — narrow the
    // ScrapedBlank union (select-backed vs input-backed fill-in-multiple-blanks,
    // see canvas-dom.ts) so `.select` below type-checks without per-access guards.
    const scraped = collectBlanks(question) as SelectScrapedBlank[];
    const apiBlanks = toApiBlanks(scraped);

    const answer = specs.map((b, i) => `Blank ${i + 1}: ${b.correctOption}`).join("\n");
    const blankAnswers = deriveBlankAnswers(answer, apiBlanks);
    expect(blankAnswers.map((b) => b.answer)).toEqual(specs.map((b) => b.correctOption));

    const events: Array<{ input: boolean; change: boolean }> = scraped.map(() => ({ input: false, change: false }));
    scraped.forEach((b, i) => {
      b.select.addEventListener("input", () => (events[i]!.input = true));
      b.select.addEventListener("change", () => (events[i]!.change = true));
    });

    const count = writeBlanks(question, blankAnswers);
    expect(count).toBe(7);

    scraped.forEach((b, i) => {
      const expectedText = specs[i]!.correctOption;
      expect(b.select.options[b.select.selectedIndex]?.textContent).toBe(expectedText);
      expect(b.select.classList.contains("statshelpr-suggested")).toBe(true);
      expect(events[i]).toEqual({ input: true, change: true });
    });
  });

  it("fallback: deriveBlankAnswers' sole-mentioned-option stage (no 'Blank N:' format at all) still fills the right selects", () => {
    // A deliberately small 2-blank subset so the free-form prose can mention
    // each target option exactly once without any other option text
    // accidentally also appearing (which would make soleMentionedOption
    // ambiguous and correctly return "").
    const centsBlank = REC.blanks.find((b) => b.key === "3_cents")!;
    const slopeBlank = REC.blanks.find((b) => b.key === "the_same_slope")!;
    const specs: BlankSpec[] = [
      { key: centsBlank.key, label: centsBlank.label, options: centsBlank.options, correctOption: centsBlank.correct },
      { key: slopeBlank.key, label: slopeBlank.label, options: slopeBlank.options, correctOption: slopeBlank.correct },
    ];
    const { question } = buildMultipleDropdowns({ stemText: REC.questionText, blanks: specs });
    // This fixture only ever builds <select>-backed blanks — narrow the
    // ScrapedBlank union (select-backed vs input-backed fill-in-multiple-blanks,
    // see canvas-dom.ts) so `.select` below type-checks without per-access guards.
    const scraped = collectBlanks(question) as SelectScrapedBlank[];
    const apiBlanks = toApiBlanks(scraped);

    const answer =
      "Looking at the regression output, the margin comes out to about 3 cents, and since there is " +
      "no interaction term in the model, the same slope applies across every product category here.";
    const blankAnswers = deriveBlankAnswers(answer, apiBlanks);
    expect(blankAnswers).toEqual([
      { key: "blank1", answer: "3 cents" },
      { key: "blank2", answer: "the same slope" },
    ]);

    const count = writeBlanks(question, blankAnswers);
    expect(count).toBe(2);
    expect(scraped[0]!.select.options[scraped[0]!.select.selectedIndex]?.textContent).toBe("3 cents");
    expect(scraped[1]!.select.options[scraped[1]!.select.selectedIndex]?.textContent).toBe("the same slope");
  });

  it("negative: an unmatchable blank answer leaves its select's value untouched (but highlighted+counted); other blanks are unaffected", () => {
    const specs = allBlankSpecs();
    const { question } = buildMultipleDropdowns({ stemText: REC.questionText, blanks: specs });
    // This fixture only ever builds <select>-backed blanks — narrow the
    // ScrapedBlank union (select-backed vs input-backed fill-in-multiple-blanks,
    // see canvas-dom.ts) so `.select` below type-checks without per-access guards.
    const scraped = collectBlanks(question) as SelectScrapedBlank[];

    const blankAnswers = specs.map((b, i) =>
      i === 2 ? { key: `blank${i + 1}`, answer: "zzz_no_such_option_exists" } : { key: `blank${i + 1}`, answer: b.correctOption },
    );
    const count = writeBlanks(question, blankAnswers);
    expect(count).toBe(7); // every blank counted — 6 real writes + 1 highlight-only

    const unmatched = scraped[2]!;
    expect(unmatched.select.value).toBe(""); // untouched — still the placeholder
    expect(unmatched.select.classList.contains("statshelpr-suggested")).toBe(true);

    // every OTHER blank still got its correct value — no cross-contamination
    scraped.forEach((b, i) => {
      if (i === 2) return;
      expect(b.select.options[b.select.selectedIndex]?.textContent).toBe(specs[i]!.correctOption);
    });
  });

  it("negative: a disabled blank <select> is highlight-only but still counted; its sibling blank still writes normally", () => {
    const specs = allBlankSpecs().slice(0, 2);
    const { question } = buildMultipleDropdowns({ stemText: REC.questionText, blanks: specs });
    // This fixture only ever builds <select>-backed blanks — narrow the
    // ScrapedBlank union (select-backed vs input-backed fill-in-multiple-blanks,
    // see canvas-dom.ts) so `.select` below type-checks without per-access guards.
    const scraped = collectBlanks(question) as SelectScrapedBlank[];
    scraped[0]!.select.disabled = true;

    const blankAnswers = specs.map((b, i) => ({ key: `blank${i + 1}`, answer: b.correctOption }));
    const count = writeBlanks(question, blankAnswers);
    expect(count).toBe(2);

    expect(scraped[0]!.select.value).toBe(""); // disabled — never set
    expect(scraped[0]!.select.classList.contains("statshelpr-suggested")).toBe(true);
    expect(scraped[1]!.select.options[scraped[1]!.select.selectedIndex]?.textContent).toBe(specs[1]!.correctOption);
  });
});
