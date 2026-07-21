/**
 * fill_in_multiple_blanks_question round trip — Classic's inline
 * <input type=text> blanks variant (2+ blanks, no discrete option pool),
 * distinct from multiple_dropdowns_question's inline <select>s.
 *
 * No real capture of this question type exists yet (the whole point of this
 * suite — see canvas-dom.ts's collectTextBlanks() doc comment), so unlike
 * matching.test.ts / multiple-dropdowns.test.ts this fixture is hand-built
 * rather than driven by evals/captures/captures-20260722.json. The fixture
 * still mirrors real Canvas markup facts documented in
 * fixtures/canvas-classic.ts's header comment: `question_input` class,
 * `question_<qid>_<blankhash>` naming, inline blanks in flowing
 * `.question_text` prose.
 *
 * Option-less blanks have a narrower deriveBlankAnswers fallback ladder than
 * option-backed ones: stages 2 (label-echo) and 3 (sole-mentioned-option) are
 * option-pool-specific and skipped entirely (see choices.ts's doc comment on
 * deriveBlankAnswers) — only the "Blank N:" (stage 1) and bare "N." (stage 1b)
 * forms can resolve a free-text blank. So "fallback path" here is the bare
 * "N. <value>" format (stage 1b), not a soleMentionedOption-style prose match.
 */
import { describe, expect, it } from "vitest";
import { deriveBlankAnswers } from "@statshelpr/solver-core/solver";
import { collectBlanks, writeBlanks, type InputScrapedBlank } from "../src/canvas-dom";
import { buildFillInMultipleBlanks, type TextBlankSpec } from "./fixtures/canvas-classic";
import { toApiBlanks } from "./helpers";

const STEM = "Fill in each blank below based on the fitted regression model.";

const SPECS: TextBlankSpec[] = [
  { key: "9fa1", label: "The estimated intercept (in dollars) is", correctValue: "8.6" },
  { key: "b22c", label: "The estimated slope (dollars per unit) is", correctValue: "1.45" },
  { key: "d03e", label: "The R-squared value, rounded to two decimals, is", correctValue: "0.87" },
];

describe("fill_in_multiple_blanks_question", () => {
  it("scrape: 3 blanks keyed from each input's name hash suffix, real sentence-context labels, no options, kind='input'", () => {
    const { question } = buildFillInMultipleBlanks({ stemText: STEM, blanks: SPECS });
    const scraped = collectBlanks(question);

    expect(scraped).toHaveLength(3);
    expect(scraped.map((b) => b.key)).toEqual(["9fa1", "b22c", "d03e"]);
    expect(scraped.map((b) => b.label)).toEqual(SPECS.map((b) => b.label));
    expect(scraped.every((b) => b.kind === "input")).toBe(true);
    expect(scraped.every((b) => b.options.length === 0)).toBe(true);

    // The wire payload (content.ts's apiBlanks mapping, mirrored here by
    // toApiBlanks) passes options: [] through cleanly for every blank — the
    // `apiBlanks.length ? { blanks } : {}` spread in content.ts keys off the
    // blanks ARRAY, not any individual blank's options length, so an
    // option-less blank is never silently dropped from the request.
    const apiBlanks = toApiBlanks(scraped);
    expect(apiBlanks).toEqual(SPECS.map((b) => ({ key: b.key, label: b.label, options: [] })));
  });

  it("scrape: key extraction falls back to positional blank<n> when an input has no name/id, or when its name-hash collides with an earlier blank's", () => {
    const specs: TextBlankSpec[] = [
      { key: "9fa1", label: "first", correctValue: "1" },
      { key: "", label: "second (no name/id at all)", correctValue: "2" }, // -> blank2
      { key: "9fa1", label: "third (hash collides with blank 1's)", correctValue: "3" }, // -> blank3
    ];
    const { question } = buildFillInMultipleBlanks({ stemText: STEM, blanks: specs });
    const scraped = collectBlanks(question);

    expect(scraped.map((b) => b.key)).toEqual(["9fa1", "blank2", "blank3"]);
  });

  it("round trip: contract-format answer ('Blank N: <value>' per line, trailing period on a numeric blank) fills every input correctly, fires events, marks suggested", () => {
    const { question } = buildFillInMultipleBlanks({ stemText: STEM, blanks: SPECS });
    const scraped = collectBlanks(question) as InputScrapedBlank[];
    const apiBlanks = toApiBlanks(scraped);

    // Blank 2's line carries a trailing sentence period after the numeric
    // value — deriveBlankAnswers' cleanFreeformValue() must strip exactly
    // that trailing punctuation without touching the decimal point.
    const answer = "Blank 1: 8.6\nBlank 2: 1.45.\nBlank 3: 0.87";
    const blankAnswers = deriveBlankAnswers(answer, apiBlanks);
    expect(blankAnswers).toEqual([
      { key: "9fa1", answer: "8.6" },
      { key: "b22c", answer: "1.45" },
      { key: "d03e", answer: "0.87" },
    ]);

    const events: Array<{ input: boolean; change: boolean }> = scraped.map(() => ({ input: false, change: false }));
    scraped.forEach((b, i) => {
      b.input.addEventListener("input", () => (events[i]!.input = true));
      b.input.addEventListener("change", () => (events[i]!.change = true));
    });

    const count = writeBlanks(question, blankAnswers);
    expect(count).toBe(3);

    scraped.forEach((b, i) => {
      expect(b.input.value).toBe(SPECS[i]!.correctValue);
      expect(b.input.classList.contains("statshelpr-suggested")).toBe(true);
      expect(events[i]).toEqual({ input: true, change: true });
    });
  });

  it("fallback: bare 'N. <value>' lines (no 'Blank' keyword) still resolve every blank — the only other format option-less blanks can parse", () => {
    const { question } = buildFillInMultipleBlanks({ stemText: STEM, blanks: SPECS });
    const scraped = collectBlanks(question) as InputScrapedBlank[];
    const apiBlanks = toApiBlanks(scraped);

    const answer = "1. 8.6\n2. 1.45\n3. 0.87";
    const blankAnswers = deriveBlankAnswers(answer, apiBlanks);
    expect(blankAnswers).toEqual([
      { key: "9fa1", answer: "8.6" },
      { key: "b22c", answer: "1.45" },
      { key: "d03e", answer: "0.87" },
    ]);

    const count = writeBlanks(question, blankAnswers);
    expect(count).toBe(3);
    scraped.forEach((b, i) => expect(b.input.value).toBe(SPECS[i]!.correctValue));
  });

  it("negative: an unanswered blank (missing from the model's answer text) leaves only its input untouched; siblings still write normally", () => {
    const { question } = buildFillInMultipleBlanks({ stemText: STEM, blanks: SPECS });
    const scraped = collectBlanks(question) as InputScrapedBlank[];
    const apiBlanks = toApiBlanks(scraped);

    // Blank 2 never appears in the answer at all.
    const answer = "Blank 1: 8.6\nBlank 3: 0.87";
    const blankAnswers = deriveBlankAnswers(answer, apiBlanks);
    expect(blankAnswers[1]).toEqual({ key: "b22c", answer: "" });

    const count = writeBlanks(question, blankAnswers);
    expect(count).toBe(2); // only the 2 answered blanks counted

    expect(scraped[1]!.input.value).toBe(""); // untouched
    expect(scraped[1]!.input.classList.contains("statshelpr-suggested")).toBe(false);
    expect(scraped[0]!.input.value).toBe("8.6");
    expect(scraped[2]!.input.value).toBe("0.87");
  });

  it("negative: a disabled input blank is highlight-only but still counted; its enabled siblings still write normally", () => {
    // 3 blanks total (2 enabled + 1 disabled) so collectTextBlanks' own
    // trigger gate (2+ ENABLED inputs) still fires — disabling down to only 1
    // enabled input would make the whole question stop being recognized as
    // fill-in-multiple-blanks at all, which is a different scenario (covered
    // implicitly: collectBlanks would return [] and there'd be nothing here
    // to write back to).
    const { question } = buildFillInMultipleBlanks({ stemText: STEM, blanks: SPECS, disabledIndices: [1] });
    const scraped = collectBlanks(question) as InputScrapedBlank[];
    expect(scraped[1]!.input.disabled).toBe(true);

    const blankAnswers = SPECS.map((b) => ({ key: b.key, answer: b.correctValue }));
    const count = writeBlanks(question, blankAnswers);
    expect(count).toBe(3); // every blank counted — 2 real writes + 1 highlight-only

    expect(scraped[1]!.input.value).toBe(""); // disabled — never set
    expect(scraped[1]!.input.classList.contains("statshelpr-suggested")).toBe(true);
    expect(scraped[0]!.input.value).toBe("8.6");
    expect(scraped[2]!.input.value).toBe("0.87");
  });

  it("negative: no blank answered at all leaves count 0 and nothing written", () => {
    const { question } = buildFillInMultipleBlanks({ stemText: STEM, blanks: SPECS });
    const scraped = collectBlanks(question) as InputScrapedBlank[];
    const apiBlanks = toApiBlanks(scraped);

    const blankAnswers = deriveBlankAnswers("I don't know any of these.", apiBlanks);
    expect(blankAnswers.every((b) => b.answer === "")).toBe(true);

    const count = writeBlanks(question, blankAnswers);
    expect(count).toBe(0);
    scraped.forEach((b) => {
      expect(b.input.value).toBe("");
      expect(b.input.classList.contains("statshelpr-suggested")).toBe(false);
    });
  });
});
