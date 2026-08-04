# Eval fixture quarantine — 2026-08-04

Static archaeology + structural/content pass over the eval fixture set ahead of the
reasoning-budget tuning run. No LLM/API calls were made; every finding below is either
mined from git history / prior eval-run records, or derived by direct inspection and
arithmetic on the fixtures' own embedded data.

## Directory layout you're looking at

`evals/solve-fixtures/` is not independent of `evals/solve-fixtures-calc/` and
`evals/solve-fixtures-concept/` — before this pass, every one of the 139 files in
`solve-fixtures/` was a byte-identical copy of a file in either `solve-fixtures-calc/`
(92 of them) or `solve-fixtures-concept/` (47 of them), i.e. `solve-fixtures` =
`calc` ∪ `concept`. The calc/concept dirs additionally carried 3 synthetic files each
pool doesn't fully share (see "3 synthetic regression fixtures" below). This means
**every quarantined fixture existed in two places** (the combined pool + its mode
pool), so each one was `git mv`-ed out of both, and this directory mirrors that:

```
evals/solve-fixtures-quarantined/<name>.json                        # was evals/solve-fixtures/<name>.json
evals/solve-fixtures-quarantined/solve-fixtures-calc/<name>.json    # was evals/solve-fixtures-calc/<name>.json
evals/solve-fixtures-quarantined/solve-fixtures-concept/<name>.json # was evals/solve-fixtures-concept/<name>.json
```

Nothing was deleted; every move is a plain `git mv` and is fully reversible.

## Phase 1 — what the historical record already told us

- **`git log --follow --stat -- evals/`** shows only 5 commits ever touched `evals/`.
  The entire 139-fixture pool was added in one batch (`18a1d7e`, "checkpoint:
  eval-driven solver fixes, eval infra, and WIP workers port", 2026-07-22). The only
  fixture-level history beyond that batch:
  - `4721d96` (2026-05-11) added 3 hand-written fixtures (`concept-checkbox.json`,
    `concept-radio.json`, `graph-summary.json`).
  - `cec146c` (2026-07-21) **removed those same 3 fixtures**, with the message:
    *"These 3 were hand-written textbook archetypes, not real Canvas questions.
    Removing so the eval set starts clean before hand-labeling real questions."*
    This is the project's own precedent: non-Canvas-captured fixtures don't belong
    in the accuracy pool.
  - `10e482e` (2026-07-23) added 3 **more** hand-written fixtures
    (`expected-value-nimbus-inline.json`, `distribution-shape-income-no-data.json`,
    `distribution-shape-scooby-time-no-data.json`) as regression tests for a specific
    routing bug fix. These were deliberately kept out of `solve-fixtures/` (the
    combined pool) but leaked into `solve-fixtures-calc/` and
    `solve-fixtures-concept/`, which are run as their own accuracy gates. See
    "3 synthetic regression fixtures" below — same problem class as `cec146c`,
    recognized but **not auto-quarantined** here since Phase 3's quarantine bucket is
    reserved for structural corruption, not provenance calls.
  - `beb4c0c` (2026-07-23) documents a specific known-bad result in its commit body:
    *"rentals.csv miss (38 vs 42) is PRE-EXISTING ... untouched by the prompt
    change."* This pointed directly at the fixture flagged below under "rentals.csv
    Cancellation CI."

- **`evals/captures/_screening/batch-{1..6}.json`** (146 raw captures reviewed before
  becoming fixtures) records `verified`/`outcome`/`answerSource` per item. 139 came
  back `verified: true, outcome: correct` — exactly the 139 that became
  `solve-fixtures/`. The other **7** came back `verified: false, outcome: incorrect,
  answerSource: none` (the self-correct pipeline never converged on a graded answer).

- **`evals/unsolved/`** holds exactly those same 7 captures (confirmed by matching
  question text). They were correctly excluded from every fixture pool already —
  no action needed, they're not part of the 139/93/49 denominators and never were.

- **`evals/_debug/run-*.json`** (8 recorded eval runs) gave the fixture-level failure
  history used to corroborate several findings below (see each entry's "evidence").
  Two runs (`20260721T20-27-*`) are Gemini-rate-limit noise against a scratch dir, not
  signal.

- **Known-problem class from project memory** ("capture pipeline emitted only the
  literal on-page option text for TRUE/FALSE questions — fixtures may show Yes/No
  where the key says TRUE/FALSE"): checked exhaustively — every `matching_question`
  / `multiple_dropdowns_question` blank in the 139-fixture pool has
  `request.blanks[].options` containing `expected.blanks[].correct` verbatim (0
  mismatches), and a scan of all 146 raw captures for TRUE/FALSE-vs-Yes/No polarity
  mismatches between presented options and the selected/correct answer also came back
  clean (0 of 59 binary blanks). **This specific bug is not present in the current
  pool** — worth re-checking on future capture batches, but nothing to quarantine now.

## Quarantined (9 files) — CLEAR structural break

**Root cause, confirmed by source inspection, not guesswork:** Canvas renders
regression-model equations as LaTeX `equation_images` (e.g.
`.../equation_images/Bonus%3D0.45...`). The capture pipeline sometimes transcribes
that image to plain text inline in `questionText` and sometimes doesn't — when it
doesn't, the image URL survives only in `meta.imageUrls`, a field the solver never
reads (confirmed in `packages/solver-core/src/solver/prompts.ts`: only
`questionText`, `choices`, and `blanks` feed the prompt). The result is a stem that
says "The model equation is:" followed immediately by the next sentence, with the
actual equation gone — the coefficients the question asks about are simply not
visible to the solver.

This was discoverable with certainty because **9 of the 9** cases below have an exact
duplicate capture (same `canvasQuestionId`, found via a full pairwise scan) where the
transcription succeeded — i.e. removing the broken copy loses zero coverage, the
intact twin already tests the identical question. 9 of the 10 total duplicate-capture
pairs in the set follow this exact "one broken, one fine" pattern, which is itself
strong evidence this is a systematic capture-timing bug (equation image likely renders
async and the capture sometimes fires before it resolves), not one-off bad luck.

| Quarantined (broken) | Mode | Intact twin left in place | canvasQuestionId |
|---|---|---|---|
| `this-is-one-of-multiple-questions-about-ia2iqy.json` | calc | `...-17t2uzq.json` | 32444464 |
| `this-is-one-of-multiple-questions-about-jac2xx.json` | calc | `...-1etlkdd.json` | 32444463 |
| `this-is-one-of-multiple-questions-about-ufr6x.json` | calc | `...-j2vjl1.json` | 32444462 |
| `for-a-regression-model-with-a-dummy-af1c3k.json` | calc | `for-a-regression-model-y-b0-b1-mjduxr.json` | 32408205 |
| `in-a-linear-regression-model-we-describe-tlivo5.json` | calc | `...-1qgm33p.json` | 32223434 |
| `the-amazon-e-commerce-data-science-team-1olc8jx.json` | calc | `...-1rqe7v.json` | 32408199 |
| `the-amazon-e-commerce-data-science-team-s9fyrp.json` | concept | `...-1xfjqgj.json` | 32408198 |
| `the-georgia-csv-file-contains-georgia-s-1bwjghb.json` | calc | `...-i73eqe.json` | 32406744 |
| `the-owner-of-borgin-and-burkes-an-9ioqb.json` | calc | `...-tn8pey.json` | 32223436 |

Concrete examples:

- **NCAA coaches, `ufr6x`** (multiple_dropdowns, 6 blanks): text reads "...The model
  equation is: Use this model equation to fill in the blanks below..." — the equation
  `Bonus=0.45+0.15*Salary+0.84*SEC-0.11*(Salary*SEC)` is entirely absent. Directly
  confirmed against `evals/_debug/run-2026-07-21T21-11-01-184Z.json`, where the model
  answered every blank empty and said *"I am not confident because the regression
  model equation and coefficients were omitted from the prompt."* Its twin `j2vjl1`
  has the full equation inline and is unaffected.
- **Borgin and Burkes, `9ioqb`** (numerical, expects `377`): text reads "The model
  equation is: If 70 customers visit the shop tomorrow, what is the daily sales
  revenue predicted..." with no equation. Same debug run log: model answered *"Cannot
  be determined (missing model equation)."* Twin `tn8pey` has
  `Sales_i=10.56+5.23*Customers_i+e_i` inline and is fine.
- **Amazon Prime, `s9fyrp`** (matching_question, "match each equation component with
  its label"): asks to match the bare tokens `764`, `1323`, `Sales`, `Prime`, `e` to
  `baseline`/`offset`/`response Y variable`/`predictor X variable`/`residual`. Without
  the equation `Sales=764+1323*Prime+e`, `Sales`→response and `Prime`→predictor are
  inferable from the preamble, but nothing distinguishes `764` (intercept/baseline)
  from `1323` (slope/offset) — genuinely unanswerable for 2 of 5 blanks. Twin
  `1xfjqgj` has the equation inline and is fully answerable.
- `the-georgia-csv-file-contains-georgia-s-1bwjghb.json` is the one softer case in
  this batch: the missing formula (`ucountPct=(ballots-votes)/ballots`) is loosely
  recoverable from the prose description of what "undercounted" means, so it's less
  clearly *unanswerable* than the other 8. It's included anyway because its exact
  duplicate twin (`i73eqe`) has the formula inline and is strictly better in every
  respect — quarantining `1bwjghb` costs nothing.

## Flagged, NOT moved — judgment calls for owner review

**1. Likely-wrong answer key: `evals/solve-fixtures/the-rentals-csv-data-frame-contains-data-1e76ype.json`**
(also in `solve-fixtures-calc/`). Numerical question: "Calculate a large-sample 95%
confidence interval for the population proportion of rental properties allowing
cancellation. What is the lower limit?" Expected key: `answerContains: ["42"]`.
Recomputing directly from the fixture's own embedded 98-row `rentals.csv` (no LLM
involved — plain arithmetic on the CSV already in the file):
  - `x = 47` "yes" out of `n = 98` → `p̂ = 0.4796`
  - Wald 95% CI lower bound ≈ **38.1%**
  - Wilson score 95% CI lower bound ≈ **38.3%** (this is what R's
    `prop.test(..., correct=FALSE)` actually computes)

Both standard methods land at 38, not 42. This matches what the solver independently
computed in two separate historical eval runs
(`evals/_debug/run-2026-07-21T21-11-01-184Z.json` and
`run-2026-07-22T19-45-18-747Z.json`, both got 38 via `prop.test`), and matches commit
`beb4c0c`'s own note that this miss is "PRE-EXISTING." Three independent lines of
evidence (two solver runs + fresh recomputation) all say 38; nothing supports 42. High
confidence the key is wrong, but left in place per the judgment-call rule — an
answer-key change is a content edit, not a structural fix, and should be a deliberate
owner decision.

**2. Systemic: `matching_question` fixtures leak their own answer (23 files, 110 blanks, 100% of the category).**
Every `matching_question` fixture's `request.blanks[i].options` array contains
**exactly one item — the correct answer itself** (verified: 110/110 blanks across all
23 files, zero exceptions). Confirmed in `packages/solver-core/src/solver/prompts.ts`
(`buildBlanksPrompt`) that when a blank has `options`, they're rendered into the
prompt as `options: <list>` with the instruction to "copy the chosen option verbatim"
— and `scripts/run-evals.ts` spreads `fixture.request` straight into the POST body
(`JSON.stringify({ ...request, stream: false, debug: true })`), so this is exactly
what the eval harness sends today, not a hypothetical. Contrast with
`multiple_dropdowns_question`, where `options` correctly holds 2–6 real distractors.
Net effect: every matching-question fixture is solvable by copying the one string
it's handed, regardless of model quality or reasoning budget — meaning this entire
category (23 of 139 fixtures, ~17%) contributes no discriminating signal to the
upcoming reasoning-budget sweep. This is a capture-pipeline/format gap (matching
questions apparently get captured per-blank instead of with the shared drag-pool
Canvas actually shows the student), not corruption of any individual file's answer
key, so nothing was moved — but it's arguably the single highest-impact finding in
this pass for the specific goal of not poisoning the tuning run, since it silently
inflates apparent accuracy on ~1 in 6 fixtures. Affected files: every fixture under
`evals/solve-fixtures*/` with `meta.questionType == "matching_question"`.

**3. Pure duplicate, both copies fine: `walt-disney-studios-encompasses-a-collection-of-{xc4l6e,yn4yc8}.json`**
(canvasQuestionId 32223401, mode concept). Same question, same choices, same key
(`N`). Neither copy is defective — `xc4l6e` keeps the "−" separators between variable
name and description ("title − name of film"), `yn4yc8` has them stripped ("title
name of film"), a cosmetic difference only. This is pure duplicate weighting with no
"broken twin" to justify picking one over the other, so both were left in place;
owner's call whether to drop one.

**4. 3 synthetic (non-Canvas) regression fixtures inflating `-calc`/`-concept` counts only:**
`evals/solve-fixtures-calc/expected-value-nimbus-inline.json`,
`evals/solve-fixtures-concept/distribution-shape-income-no-data.json`,
`evals/solve-fixtures-concept/distribution-shape-scooby-time-no-data.json`. Added in
`10e482e` as regression tests for the "dataset referenced but not uploaded" routing
fix, all 3 lack a `meta` block entirely (no `canvasQuestionId`/`capturedAt`/etc — every
real capture has one), and none were ever added to the combined `solve-fixtures/`
pool. Directly analogous to the 3 fixtures the project already removed once in
`cec146c` for being "not real Canvas questions." Not quarantined here because they
still have standalone value as regression tests for that specific routing bug and
Phase 3's quarantine bucket is for structural corruption, not provenance — but they
should not be counted as "real Canvas accuracy" signal, and the owner may want to
relocate them to a dedicated regression-fixtures directory outside the two accuracy
gates.

## Checked thoroughly, came back clean (no action)

- **Truncated/cut-off stems:** every `questionText` in the 139-fixture pool was
  checked for trailing dangling words (articles/prepositions/conjunctions with no
  sensible completion). Zero genuine hits — every apparent "ends without a period"
  case is a normal Canvas stem ending in `:` before either a separate `choices` list
  or an inline `[Select]`/blanks structure supplies the completion.
- **HTML fragments leaked into text:** 0 hits.
- **Structural invariants** (missing/empty choices, duplicate choice labels or text,
  answer key absent, answer key referencing a nonexistent choice label, multi-answer
  key on a single-select `multiple_choice_question`, numerical questions missing an
  answer key, blanks-based questions with an empty `correct` value, duplicate blank
  keys, request/expected blank-count mismatch, empty `dataFiles` content): 0 hits
  across all 139 fixtures.
- **Dataset referenced by name but not attached** (e.g. text mentions `x.csv` with no
  matching `dataFiles` entry): 0 hits in the 139-fixture pool (the only fixtures with
  this shape are the 2 deliberately-synthetic "no-data" ones above, which are testing
  that exact scenario on purpose).
- **"All of the above" / "none of the above" not in last position:** fires on ~40
  `multiple_choice_question` fixtures, but every instance checked is a deliberate
  combinatorial choice set (e.g. "1 and 2 only" / "All of the above (1,2,3)" / "None
  of the above" as 8 co-equal options), not a scrambled canonical ordering — Canvas's
  per-student answer shuffling doesn't affect answerability since the key is stored by
  label, not position. Not a defect.
- **Duplicate/near-duplicate stems:** full pairwise scan (canvasQuestionId exact match
  + normalized-text fuzzy match >0.90 within shared-prefix buckets) found exactly the
  10 canvasQuestionId pairs discussed above and nothing else. The other high-similarity
  pairs it surfaced (e.g. two different NCAA sub-questions, two different Walt Disney
  sub-questions, two different "video-game reaction time" sub-questions) are
  confirmed-legitimate distinct questions sharing a long scenario preamble — this
  course's quizzes routinely ask several distinct questions about one dataset/scenario,
  which is expected, not duplication.
- **TRUE/FALSE vs Yes/No distractor mismatch** (the specific known-problem class from
  project memory): see Phase 1 section above — checked from three angles, 0 instances
  found in the current pool.

## Final counts

| Directory | Before | After | Removed |
|---|---|---|---|
| `evals/solve-fixtures/` | 139 | **130** | 9 |
| `evals/solve-fixtures-calc/` | 93 | **85** | 8 |
| `evals/solve-fixtures-concept/` | 49 | **48** | 1 |
| `evals/solve-fixtures-quarantined/` (+ 2 subdirs) | 0 | **18** (9 + 8 + 1) | — |
| `evals/unsolved/` | 7 | 7 | unchanged, already excluded from all pools |
| `evals/captures/`, `evals/_debug/` | — | — | untouched, reference-only |

Flagged-but-kept, for owner decision (not reflected in the counts above since nothing
moved): 1 likely-wrong numeric key, 23 matching_question fixtures with a systemic
answer-leak format issue, 1 pure-duplicate pair (2 files), 3 synthetic non-Canvas
fixtures live only in the calc/concept pools.
