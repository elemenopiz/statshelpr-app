/**
 * Content-free write-back OUTCOME telemetry — pure derivation helpers only,
 * no `chrome.*` calls anywhere in this module (mirrors canvas-dom.ts's own
 * chrome-free-by-design rule) so it can be unit-tested under happy-dom
 * without a chrome shim — see test/telemetry.test.ts.
 *
 * content.ts (the sole caller, in onSolve()) owns everything chrome-specific
 * — install id, the telemetryDisabled opt-out read, and the actual `fetch`
 * POST to /api/telemetry — plus the wall-clock timing. This module only
 * turns already-known facts (the scraped question shape, a write count, a
 * thrown-or-not flag) into the two enums the beacon reports, and assembles
 * the final JSON body.
 *
 * PRIVACY CONTRACT: nothing here ever sees or touches question text, choice
 * text, or the model's answer — only shape (counts, DOM element kinds) and
 * enums. buildTelemetryBody()'s return type is the full, total set of fields
 * ever sent — see the PINNED CONTRACT in the task this shipped under.
 */

import type { ScrapedQuestion } from "./canvas-dom";

export type QuestionType =
  | "multiple_choice"
  | "multiple_answers"
  | "true_false"
  | "dropdown"
  | "matching"
  | "multiple_dropdowns"
  | "numerical"
  | "fill_in_multiple_blanks"
  | "unknown";

export type TelemetryOutcome = "written" | "nowrite" | "error";

export interface TelemetryBody {
  mode: "concept" | "calc";
  questionType: QuestionType;
  confidence: "High" | "Med" | "Low" | "";
  outcome: TelemetryOutcome;
  writeCount: number;
  clientLatencyMs: number;
}

/**
 * Best-effort question-type classification from the SCRAPED SHAPE alone —
 * counts and DOM element kinds only, never question/choice text.
 *
 * Blanks take priority over choices: canvas-dom.ts's collectBlanks/
 * collectAnswerChoices are mutually exclusive in practice (a 2+-select or
 * 2+-text-input blanks question always scrapes to empty `choices` — see
 * canvas-dom.ts's own Priority-2 comment on collectAnswerChoices), so a
 * populated `blanks` array always wins.
 *
 * matching vs multiple_dropdowns is a genuine best-effort call: both shapes
 * scrape to the IDENTICAL SelectScrapedBlank union by design (see
 * canvas-dom.ts's collectBlanks doc comment — "the rest of the pipeline...
 * shares one code path"), so there is no dedicated flag to read. We reach
 * for the same `.answer_match_left` marker canvas-dom.ts's own blankLabel()
 * already keys off of to recognize a Classic matching row. New Quizzes
 * matching markup (no `.answer_match_left` — and no NQ fixtures exist in
 * this repo yet to confirm its real shape, see test/new-quizzes.test.ts)
 * can't be told apart from multiple_dropdowns this way, so it reports as
 * "multiple_dropdowns" — the more general/generic of the two buckets. This
 * is the one documented, accepted miss in this derivation.
 */
export function deriveQuestionType(scraped: Pick<ScrapedQuestion, "choices" | "blanks">): QuestionType {
  const { choices, blanks } = scraped;

  if (blanks.length >= 2) {
    if (blanks.every((b) => b.kind === "input")) return "fill_in_multiple_blanks";
    const looksLikeMatching = blanks.some(
      (b) => b.kind === "select" && Boolean(b.select.closest(".answer")?.querySelector(".answer_match_left")),
    );
    return looksLikeMatching ? "matching" : "multiple_dropdowns";
  }

  // collectAnswerChoices' priority branches are mutually exclusive (radio/
  // checkbox, else single dropdown, else single text-fill), so `choices` is
  // always homogeneous in practice — `.some()` here is just a defensive way
  // to read "the kind actually present" without indexing choices[0].
  if (choices.some((c) => c.kind === "checkbox")) return "multiple_answers";
  if (choices.some((c) => c.kind === "dropdown-option")) return "dropdown";
  if (choices.some((c) => c.kind === "text-fill")) return "numerical";

  const radios = choices.filter((c) => c.kind === "radio");
  if (radios.length === 2 && radios.every((c) => /^(true|false)$/i.test(c.text.trim()))) {
    return "true_false";
  }
  if (radios.length > 0) return "multiple_choice";

  return "unknown";
}

/** written/nowrite/error mapping for the beacon's `outcome` field — see
 * content.ts's onSolve for the one call site. `threw` (a result came back
 * but the write-back call itself threw) always wins as "error" regardless
 * of whatever writeCount happened to be computed before the throw;
 * otherwise it's a plain writeCount>0 check. */
export function deriveOutcome(writeCount: number, threw: boolean): TelemetryOutcome {
  if (threw) return "error";
  return writeCount > 0 ? "written" : "nowrite";
}

/** Assemble the exact (content-free) /api/telemetry POST body. Centralized
 * here — rather than an inline object literal in content.ts — so the whole
 * contract shape is covered by one pure, chrome-free unit test instead of
 * only being checkable by eye at the fetch call site. */
export function buildTelemetryBody(params: TelemetryBody): TelemetryBody {
  return {
    mode: params.mode,
    questionType: params.questionType,
    confidence: params.confidence,
    outcome: params.outcome,
    writeCount: params.writeCount,
    clientLatencyMs: params.clientLatencyMs,
  };
}
