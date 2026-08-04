/**
 * Golden test for buildSystemPrompt's course-profile split (course-topic
 * branch). Structured to fail LOUDLY on future drift: rather than comparing
 * two ad-hoc snapshots, it takes the FROZEN pre-course-topic prompt fixture
 * (../test-fixtures/system-prompt.pre-course-topic.txt — captured from
 * buildSystemPrompt({}) at commit 43f6e0f, the base this branch forked from,
 * before anything in this branch touched system-prompt.ts/stats-reference.ts)
 * and RECONSTRUCTS what each profile's output should be by applying ONLY the
 * known, named transformations this branch made — then asserts EXACT array
 * equality (line by line) against the real buildSystemPrompt() output.
 *
 * If anyone (including a future agent) changes so much as one character
 * anywhere else in system-prompt.ts or stats-reference.ts — a role line, a
 * routing rule, REGRESSION_INTERPRETATION, any STATS_REFERENCE section,
 * QUICK_REFERENCE's other bullets — the reconstructed-vs-actual comparison
 * stops matching and this test fails, by construction (see describeMismatch's
 * line-by-line pinpoint below). It does NOT gate an intentional, correct edit
 * to the TOPIC/course-convention text itself (those are read from the
 * exported named constants, not re-typed here) — but any OTHER change must
 * come with an explicit, deliberate update to the frozen fixture.
 *
 * PINNED MODEL-OUTPUT-CONTRACT CHANGE: this branch alters what the model is
 * instructed to output (adds a trailing TOPIC line) and, for the generic
 * profile, alters actual guidance content. Gated on a post-funding eval
 * re-run (scripts/run-evals.ts) before any deploy — the eval set was just
 * cleaned (denominators 130/85/48); exclude all 23 matching-question
 * fixtures (known-leaky) from that run. See system-prompt.ts's
 * TOPIC_INSTRUCTION_LINE doc comment.
 *
 * No vitest in this workspace (package.json only defines "typecheck") — a
 * plain tsx script, the same convention apps/workers/scripts/self-test-metrics.ts
 * already uses for a package with no test runner. This package has no
 * @types/node dependency (unlike apps/workers, which gets it transitively via
 * wrangler), so this script deliberately avoids node:fs/node:path/node:url and
 * the `process` global entirely — the baseline fixture is a plain .ts module
 * (test-fixtures/system-prompt.pre-course-topic.ts), not a file read at
 * runtime, and a failed check throws instead of setting process.exitCode (an
 * uncaught throw already exits non-zero under tsx/node, same CI-friendly
 * contract). Run via:
 *
 *   <repo-root>/node_modules/.pnpm/node_modules/.bin/tsx packages/solver-core/scripts/self-test-prompt.ts
 *
 * Exit code 0 if every check passes, non-zero otherwise (CI-friendly).
 */
import {
  buildSystemPrompt,
  GENERIC_SAMPLING_DISTRIBUTION_LINE,
  STA301_SAMPLING_DISTRIBUTION_LINE,
  TOPIC_INSTRUCTION_LINE,
  TOPIC_QUICK_REFERENCE_LINE,
} from "../src/core/system-prompt";
import { DE_MOIVRE_LINE_GENERIC, DE_MOIVRE_LINE_STA301 } from "../src/core/stats-reference";
import { parseResponse } from "../src/core/parse-response";
import { TOPICS } from "../src/core/topics";
import { PRE_COURSE_TOPIC_SYSTEM_PROMPT } from "../test-fixtures/system-prompt.pre-course-topic";

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function describeMismatch(expected: string[], actual: string[]): string {
  if (expected.length !== actual.length) {
    return `length differs: expected ${expected.length} lines, got ${actual.length}`;
  }
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) {
      return (
        `first mismatch at line ${i}:\n` +
        `    expected: ${JSON.stringify((expected[i] ?? "").slice(0, 200))}\n` +
        `    actual:   ${JSON.stringify((actual[i] ?? "").slice(0, 200))}`
      );
    }
  }
  return "";
}

/** Finds `anchor` as an EXACT full-line match and inserts `newLine` right
 *  after it. Throws (loud, unmissable failure — not a silent no-op) unless
 *  the anchor matches EXACTLY once, since 0 matches means the anchor text
 *  drifted out of sync with system-prompt.ts and >1 match would make the
 *  insertion point ambiguous. */
function insertAfter(lines: string[], anchor: string, newLine: string): string[] {
  const matches = lines.reduce<number[]>((acc, l, i) => (l === anchor ? [...acc, i] : acc), []);
  if (matches.length !== 1) {
    throw new Error(
      `insertAfter: expected exactly 1 match for anchor, found ${matches.length}. ` +
        `Anchor text may be stale — update it to match system-prompt.ts. Anchor: ${JSON.stringify(anchor)}`,
    );
  }
  const idx = matches[0]!;
  return [...lines.slice(0, idx + 1), newLine, ...lines.slice(idx + 1)];
}

/** Same "exactly once or throw" contract as insertAfter, for a whole-line
 *  swap (the course-convention block / the de Moivre line). */
function replaceLine(lines: string[], oldLine: string, newLine: string): string[] {
  const matches = lines.reduce<number[]>((acc, l, i) => (l === oldLine ? [...acc, i] : acc), []);
  if (matches.length !== 1) {
    throw new Error(
      `replaceLine: expected exactly 1 match, found ${matches.length}. Looking for: ${JSON.stringify(oldLine)}`,
    );
  }
  const out = [...lines];
  out[matches[0]!] = newLine;
  return out;
}

// ---------------------------------------------------------------------------
console.log("system-prompt.ts (course-topic golden test)");

const baselineLines = PRE_COURSE_TOPIC_SYSTEM_PROMPT.split("\n");

/** Copied VERBATIM from system-prompt.ts's buildRoutingRules/QUICK_REFERENCE
 *  arrays — lines this branch did NOT change. They exist ONLY to locate WHERE
 *  the new TOPIC lines get inserted when reconstructing the expected output
 *  below; insertAfter throws immediately if either has since drifted instead
 *  of silently inserting in the wrong place. */
const CONFIDENCE_LINE_ANCHOR =
  "After your answer (whether [CONCEPT] or [RCODE]), append on a new line: CONFIDENCE: High, CONFIDENCE: Med, or CONFIDENCE: Low. Use Low only when genuinely uncertain or the question is ambiguous.";
const QUICK_REF_BULLET_6_ANCHOR =
  "6. CONFIDENCE line goes after the answer on its own line. Low confidence prints a warning.";

// --- default (UT Austin STA 301) profile ------------------------------------
{
  let expected = baselineLines;
  expected = insertAfter(expected, CONFIDENCE_LINE_ANCHOR, TOPIC_INSTRUCTION_LINE);
  expected = insertAfter(expected, QUICK_REF_BULLET_6_ANCHOR, TOPIC_QUICK_REFERENCE_LINE);

  const actual = buildSystemPrompt({}).split("\n");
  const actualNoArgAtAll = buildSystemPrompt().split("\n");

  check(
    "default profile (courseProfile omitted) === pre-change prompt + EXACTLY the TOPIC-instruction block, nothing else",
    arraysEqual(expected, actual),
    describeMismatch(expected, actual),
  );
  check(
    "buildSystemPrompt() with zero arguments matches buildSystemPrompt({}) (options object itself is optional)",
    arraysEqual(actual, actualNoArgAtAll),
  );
  check(
    "default profile keeps the STA301 sampling-distribution convention verbatim",
    actual.includes(STA301_SAMPLING_DISTRIBUTION_LINE),
  );
  check(
    "default profile does NOT contain the generic sampling-distribution line",
    !actual.includes(GENERIC_SAMPLING_DISTRIBUTION_LINE),
  );
  check(
    "default profile keeps the STA301-branded de Moivre line verbatim",
    actual.includes(DE_MOIVRE_LINE_STA301),
  );
}

// --- generic profile ---------------------------------------------------------
{
  let expected = baselineLines;
  expected = replaceLine(expected, STA301_SAMPLING_DISTRIBUTION_LINE, GENERIC_SAMPLING_DISTRIBUTION_LINE);
  expected = replaceLine(expected, DE_MOIVRE_LINE_STA301, DE_MOIVRE_LINE_GENERIC);
  expected = insertAfter(expected, CONFIDENCE_LINE_ANCHOR, TOPIC_INSTRUCTION_LINE);
  expected = insertAfter(expected, QUICK_REF_BULLET_6_ANCHOR, TOPIC_QUICK_REFERENCE_LINE);

  const actual = buildSystemPrompt({ courseProfile: "generic" }).split("\n");

  check(
    "generic profile === pre-change prompt with EXACTLY the 2 swapped blocks + the TOPIC-instruction block, nothing else",
    arraysEqual(expected, actual),
    describeMismatch(expected, actual),
  );
  check(
    "generic profile does NOT contain the STA301 sampling-distribution convention",
    !actual.includes(STA301_SAMPLING_DISTRIBUTION_LINE),
  );
  check(
    "generic profile does NOT contain the STA301-branded de Moivre line",
    !actual.includes(DE_MOIVRE_LINE_STA301),
  );
  check(
    "generic profile keeps the de Moivre SE FORMULA content — only the course-branding clause changed",
    actual.some((l) => l.includes("SE of the MEAN = σ/√n")),
  );
}

// --- generic profile composes correctly with every other option ------------
{
  const withEverything = buildSystemPrompt({
    dataContext: "some data context",
    imageMode: true,
    hasBlanks: true,
    rPackages: ["car"],
    courseProfile: "generic",
  });
  check(
    "generic profile composes with dataContext/imageMode/hasBlanks/rPackages without throwing",
    typeof withEverything === "string" && withEverything.length > 0,
  );
  check(
    "generic + rPackages still applies the package-priority directive",
    withEverything.includes("prioritize car, and base R"),
  );
  check("generic + dataContext still appends the data context block", withEverything.includes("some data context"));
  check(
    "generic profile still carries the TOPIC instruction alongside every other option",
    withEverything.includes(TOPIC_INSTRUCTION_LINE),
  );
}

// ---------------------------------------------------------------------------
console.log("\nparse-response.ts (TOPIC extraction)");

{
  const r = parseResponse("[CONCEPT]\nAnswer: B\nCONFIDENCE: High\nTOPIC: bootstrap");
  check("valid TOPIC line parses to its exact token", r.topic === "bootstrap", `got ${r.topic}`);
  check("TOPIC line is stripped from body", r.body === "Answer: B", `got ${JSON.stringify(r.body)}`);
  check("confidence still parses correctly alongside TOPIC", r.confidence === "High");
}

{
  // Old outputs (pre-topic-feature) must still parse — the whole point of
  // making TOPIC optional.
  const r = parseResponse("[CONCEPT]\nAnswer: B\nCONFIDENCE: High");
  check("missing TOPIC line -> topic 'unknown', NEVER a parse failure", r.topic === "unknown", `got ${r.topic}`);
  check("body/confidence unaffected when TOPIC is absent", r.body === "Answer: B" && r.confidence === "High");
}

{
  const r = parseResponse("[CONCEPT]\nAnswer: B\nCONFIDENCE: High\nTOPIC: some_made_up_thing");
  check("an off-taxonomy TOPIC value -> 'unknown', never a raw pass-through string", r.topic === "unknown", `got ${r.topic}`);
  check("body is still cleaned up even when TOPIC doesn't validate", r.body === "Answer: B", `got ${JSON.stringify(r.body)}`);
}

{
  const r = parseResponse("[CONCEPT]\nAnswer: B\nCONFIDENCE: High\nTOPIC: Linear-Regression");
  check(
    "a differently-cased/hyphenated but recognizable token still normalizes to its canonical form",
    r.topic === "linear_regression",
    `got ${r.topic}`,
  );
}

{
  // Calc/RCODE path: TOPIC (and CONFIDENCE) must be stripped from parsed.body
  // BEFORE extractRCode ever sees it, or the trailing annotation lines would
  // corrupt the R source solve.ts hands to the runner.
  const raw =
    "[RCODE]\n# PLAN: t.test, mu=0\nx <- 1\ncat('Final answer:', x, '\\n')\nCONFIDENCE: Med\nTOPIC: hypothesis_testing";
  const r = parseResponse(raw);
  check("calc path: mode is calc", r.mode === "calc");
  check("calc path: topic parses correctly", r.topic === "hypothesis_testing", `got ${r.topic}`);
  check(
    "calc path: TOPIC/CONFIDENCE lines never leak into the R code body",
    !r.body.includes("CONFIDENCE") && !r.body.includes("TOPIC"),
    JSON.stringify(r.body),
  );
}

{
  // Every taxonomy member must itself round-trip — the parser and the
  // prompt's listed tokens share the exact same TOPICS array, so this also
  // guards against the two ever silently drifting apart.
  let allOk = true;
  for (const t of TOPICS) {
    const r = parseResponse(`[CONCEPT]\nAnswer: A\nCONFIDENCE: Low\nTOPIC: ${t}`);
    if (r.topic !== t) allOk = false;
  }
  check(`every TOPICS member (${TOPICS.length} total) round-trips through parseResponse unchanged`, allOk);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
// No @types/node in this package (see the doc comment above) — throwing
// instead of setting process.exitCode gets the same CI-friendly "non-zero
// exit on failure" result: an uncaught error already exits the process
// non-zero under tsx/node, and this failure message is exactly what a CI log
// needs to see.
if (fail > 0) throw new Error(`${fail} check(s) failed — see PASS/FAIL output above.`);
