/**
 * matching_question round trip — driven by a REAL capture record
 * (canvasQuestionId 32223290: "Match the terms below to their correct
 * definitions", 6 rows).
 *
 * IMPORTANT fixture-building note (see project memory
 * project_capture_truefalse_distractor_gap): Canvas's graded matching review
 * page renders each row's <select> containing ONLY the chosen option, so
 * every captured matching blank's `options` array is a one-item singleton —
 * that's a known, already-tracked capture-pipeline gap, not something to
 * work around here. Per that memory note's own documented fix ("matching
 * questions whose options are all distinct are unaffected — the union
 * across blanks reconstructs the full set"), this fixture reconstructs the
 * real shared dropdown pool as the union of all 6 blanks' singleton
 * options — exactly what a live (unsubmitted) Canvas matching question's
 * <select> actually offers in every row.
 */
import { describe, expect, it } from "vitest";
import { deriveBlankAnswers } from "@statshelpr/solver-core/solver";
import { collectBlanks, writeBlanks, type SelectScrapedBlank } from "../src/canvas-dom";
import { buildMatchingQuestion } from "./fixtures/canvas-classic";
import { captureById } from "./fixtures/captures";
import { toApiBlanks } from "./helpers";

const REC = captureById("32223290");
const SHARED_POOL = REC.blanks.map((b) => b.correct); // union — each blank contributed exactly one distinct term

function buildFixture() {
  return buildMatchingQuestion({
    stemText: REC.questionText,
    rows: REC.blanks.map((b) => ({ key: b.key, label: b.label, correctOption: b.correct })),
    sharedOptionPool: SHARED_POOL,
  });
}

describe("matching_question", () => {
  it("scrape: 6 blanks keyed blank1..blank6 positionally, .answer_match_left labels preserved, every row offers the FULL shared pool, placeholder skipped", () => {
    const { question } = buildFixture();
    // This fixture only ever builds <select>-backed blanks — narrow the
    // ScrapedBlank union (select-backed vs input-backed fill-in-multiple-blanks,
    // see canvas-dom.ts) so `.select` below type-checks without per-access guards.
    const scraped = collectBlanks(question) as SelectScrapedBlank[];

    expect(scraped).toHaveLength(6);
    expect(scraped.map((b) => b.key)).toEqual(["blank1", "blank2", "blank3", "blank4", "blank5", "blank6"]);
    expect(scraped.map((b) => b.label)).toEqual(REC.blanks.map((b) => b.label));
    // Every row's <select> carries the full 6-term shared pool, not just its
    // own correct answer — the whole point of reconstructing it via union.
    for (const b of scraped) {
      expect(b.options.map((o) => o.text)).toEqual(SHARED_POOL);
      expect(b.options.some((o) => /select/i.test(o.text))).toBe(false);
    }
  });

  it("round trip: contract-format answer ('Blank N: <term>' per line) matches every row to its correct term, fires events, marks suggested", () => {
    const { question } = buildFixture();
    // This fixture only ever builds <select>-backed blanks — narrow the
    // ScrapedBlank union (select-backed vs input-backed fill-in-multiple-blanks,
    // see canvas-dom.ts) so `.select` below type-checks without per-access guards.
    const scraped = collectBlanks(question) as SelectScrapedBlank[];
    const apiBlanks = toApiBlanks(scraped);

    const answer = REC.blanks.map((b, i) => `Blank ${i + 1}: ${b.correct}`).join("\n");
    const blankAnswers = deriveBlankAnswers(answer, apiBlanks);
    expect(blankAnswers.map((b) => b.answer)).toEqual(REC.blanks.map((b) => b.correct));

    const events = scraped.map(() => ({ input: false, change: false }));
    scraped.forEach((b, i) => {
      b.select.addEventListener("input", () => (events[i]!.input = true));
      b.select.addEventListener("change", () => (events[i]!.change = true));
    });

    const count = writeBlanks(question, blankAnswers);
    expect(count).toBe(6);
    scraped.forEach((b, i) => {
      expect(b.select.options[b.select.selectedIndex]?.textContent).toBe(REC.blanks[i]!.correct);
      expect(b.select.classList.contains("statshelpr-suggested")).toBe(true);
      expect(events[i]).toEqual({ input: true, change: true });
    });
  });

  it("fallback: deriveBlankAnswers' label-echo stage (no 'Blank N:' format) resolves via each row's own descriptive label line", () => {
    // Restricted to 2 rows whose labels are verified free of each other's
    // (or any other pool term's) text, so matchOption's longest-substring
    // scoring can't be pulled toward the wrong term — a real risk for
    // matching specifically, since every row shares the SAME option pool, and
    // several of this record's OWN definitions naturally mention other pool
    // terms inline ("Sample" row's own definition literally contains the
    // word "population"). Codebook / Unit-of-analysis is the safe pair.
    // That "Sample"/"population" case is exactly
    // FIXME(substring-matcher hardening) in regression.test.ts — confirmed
    // there to actually mis-resolve, not just theorized here.
    const codeBook = REC.blanks.find((b) => b.key === "blank4")!; // "Code book"
    const unitOfAnalysis = REC.blanks.find((b) => b.key === "blank5")!; // "Unit of analysis"
    const rows = [
      { key: codeBook.key, label: codeBook.label, correctOption: codeBook.correct },
      { key: unitOfAnalysis.key, label: unitOfAnalysis.label, correctOption: unitOfAnalysis.correct },
    ];
    const { question } = buildMatchingQuestion({
      stemText: REC.questionText,
      rows,
      sharedOptionPool: SHARED_POOL,
    });
    // This fixture only ever builds <select>-backed blanks — narrow the
    // ScrapedBlank union (select-backed vs input-backed fill-in-multiple-blanks,
    // see canvas-dom.ts) so `.select` below type-checks without per-access guards.
    const scraped = collectBlanks(question) as SelectScrapedBlank[];
    const apiBlanks = toApiBlanks(scraped);

    const answer = [
      `${codeBook.label} — the term for that is ${codeBook.correct}.`,
      `${unitOfAnalysis.label} — the term for that is ${unitOfAnalysis.correct}.`,
    ].join("\n");
    const blankAnswers = deriveBlankAnswers(answer, apiBlanks);
    expect(blankAnswers).toEqual([
      { key: "blank1", answer: "Code book" },
      { key: "blank2", answer: "Unit of analysis" },
    ]);

    const count = writeBlanks(question, blankAnswers);
    expect(count).toBe(2);
    expect(scraped[0]!.select.options[scraped[0]!.select.selectedIndex]?.textContent).toBe("Code book");
    expect(scraped[1]!.select.options[scraped[1]!.select.selectedIndex]?.textContent).toBe("Unit of analysis");
  });

  it("negative: an unmatchable blank answer leaves its select's value untouched (but highlighted+counted); sibling rows are unaffected", () => {
    const { question } = buildFixture();
    // This fixture only ever builds <select>-backed blanks — narrow the
    // ScrapedBlank union (select-backed vs input-backed fill-in-multiple-blanks,
    // see canvas-dom.ts) so `.select` below type-checks without per-access guards.
    const scraped = collectBlanks(question) as SelectScrapedBlank[];

    const blankAnswers = REC.blanks.map((b, i) =>
      i === 3 ? { key: `blank${i + 1}`, answer: "not a real term at all" } : { key: `blank${i + 1}`, answer: b.correct },
    );
    const count = writeBlanks(question, blankAnswers);
    expect(count).toBe(6);

    expect(scraped[3]!.select.value).toBe("");
    expect(scraped[3]!.select.classList.contains("statshelpr-suggested")).toBe(true);
    scraped.forEach((b, i) => {
      if (i === 3) return;
      expect(b.select.options[b.select.selectedIndex]?.textContent).toBe(REC.blanks[i]!.correct);
    });
  });

  it("negative: a disabled row <select> is highlight-only but still counted; sibling row still writes normally", () => {
    const rows = REC.blanks.slice(0, 2).map((b) => ({ key: b.key, label: b.label, correctOption: b.correct }));
    const { question } = buildMatchingQuestion({ stemText: REC.questionText, rows, sharedOptionPool: SHARED_POOL });
    // This fixture only ever builds <select>-backed blanks — narrow the
    // ScrapedBlank union (select-backed vs input-backed fill-in-multiple-blanks,
    // see canvas-dom.ts) so `.select` below type-checks without per-access guards.
    const scraped = collectBlanks(question) as SelectScrapedBlank[];
    scraped[0]!.select.disabled = true;

    const blankAnswers = rows.map((r, i) => ({ key: `blank${i + 1}`, answer: r.correctOption }));
    const count = writeBlanks(question, blankAnswers);
    expect(count).toBe(2);

    expect(scraped[0]!.select.value).toBe("");
    expect(scraped[0]!.select.classList.contains("statshelpr-suggested")).toBe(true);
    expect(scraped[1]!.select.options[scraped[1]!.select.selectedIndex]?.textContent).toBe(rows[1]!.correctOption);
  });
});
