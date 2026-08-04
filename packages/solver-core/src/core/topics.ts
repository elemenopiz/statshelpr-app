/**
 * Fixed topic taxonomy the model self-labels each answer with (system-prompt.ts's
 * `TOPIC: <topic>` output line, extracted by parse-response.ts). Derived from
 * stats-reference.ts's own section headers, consolidated where a header doesn't
 * earn its own bucket:
 *   - "DATA TYPES & IMPORT" folds into `data_wrangling` (it's introductory
 *     data-handling content, not a distinct topic students ask about).
 *   - Everything else maps ~1:1 to a stats-reference.ts section (see the
 *     inline comments below).
 *
 * Single source of truth, shared by:
 *  - system-prompt.ts — lists these tokens verbatim in the model's output
 *    instruction (both course profiles get the same taxonomy).
 *  - parse-response.ts — validates the model's TOPIC line against this set;
 *    anything missing/unrecognized parses to "unknown", never a parse failure.
 *  - apps/workers/src/lib/metrics-store.ts — re-validates independently
 *    server-side before a topic string can become a `server.byTopic` KV
 *    bucket key (defense in depth; this list is imported directly from here
 *    rather than hand-duplicated, so the prompt/parser/storage layers cannot
 *    silently drift apart).
 *
 * Changing this array changes the model output CONTRACT (system-prompt.ts's
 * TOPIC instruction) — see that file's call-site comment for the eval-gate
 * note before deploying a change here.
 */
export const TOPICS = [
  "probability", // stats-reference.ts § PROBABILITY (L3)
  "plots", // § PLOTS (L4)
  "summary_statistics", // § SUMMARY STATISTICS (L5)
  "data_wrangling", // § DATA WRANGLING (L6) + § DATA TYPES & IMPORT (folded in)
  "linear_regression", // § LINEAR REGRESSION (L7, L14, L15)
  "clt", // § STATISTICAL UNCERTAINTY & CLT (L8, L11)
  "bootstrap", // § BOOTSTRAP (L9)
  "hypothesis_testing", // § P-VALUES & HYPOTHESIS TESTING (L10, L11)
  "large_sample_inference", // § LARGE-SAMPLE INFERENCE IN R (L11)
  "experiments_causation", // § EXPERIMENTS & CAUSATION (L12)
  "multiple_regression", // § MULTIPLE REGRESSION & CONFOUNDING (L15)
  "probability_models", // § PROBABILITY MODELS (L17)
  "non_stats", // the question isn't about statistics/data analysis at all
  "other", // genuinely doesn't fit any bucket above
] as const;

export type Topic = (typeof TOPICS)[number];

const TOPIC_SET: ReadonlySet<string> = new Set(TOPICS);

/** True when `value` is exactly one of the taxonomy members above. Deliberately
 *  does NOT accept "unknown" — that's parse-response.ts's own fallback for a
 *  missing/invalid TOPIC line, never a value the model is instructed to emit,
 *  so keeping it outside this set lets callers tell "model didn't comply"
 *  apart from "model complied and picked a real bucket". */
export function isTopic(value: string): value is Topic {
  return TOPIC_SET.has(value);
}
