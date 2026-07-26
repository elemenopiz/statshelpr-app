# statshelpr Liability-Reduction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce UT Institutional Rules and Texas Penal Code § 32.50 exposure by making statshelpr a display-and-tutoring instrument that never writes into a graded submission, while preserving the solver, the R pipeline, and the paid product.

**Architecture:** Three workstreams. (1) Non-code: DBA filing + ToS rewrite. (2) Removals: the DOM write-back becomes suggestion-only — the student performs every act that produces the graded artifact. (3) Additions: real tutoring surfaces (manual input, practice generator, post-attempt review) that make the "general stats instrument" characterization factually true rather than argued.

**Tech Stack:** TypeScript, Chrome MV3, esbuild, Vitest + happy-dom, `@statshelpr/solver-core` (shared by extension / API / prod workers), Cloud Run R runner.

---

## EXECUTION STATE — updated 2026-07-27

> ## ⛔ SUGGESTION-ONLY ARC ABANDONED — 2026-07-27 by owner
>
> **Tasks 3, 4, and 5 are not shipped and are not going to ship.** The DOM
> write-back stays as it was at base `0a8efb1`: `selectChoice` clicks the
> radio/checkbox, `setSelectValue` sets the dropdown, `fillTextInput` and
> `writeBlanks` type into fields, each downgrading to a highlight-only mark
> when the field is disabled or read-only.
>
> **Why.** Task 5 was cancelled mid-arc (see the row below), which left the
> product in a state no copy could describe honestly: choices and single text
> fields were suggestion-only while matching and multiple-dropdowns questions
> still wrote directly into the submission. A half-converted write-back is
> worse than either end state — it is harder to explain to a user than "it
> fills the answer in" and it bought no § 32.50 protection while blanks still
> wrote. The owner elected to keep the shipping behavior whole and make the
> legal and store copy accurate to it instead.
>
> **Where the code went.** Commits `c24541b`, `632a225`, `c4dfd85`,
> `524916b`, `3993083` remain on branch `liability-reduction` and its
> descendants (`assent-gate`, `extension-listing-telemetry`,
> `hash-separation-comments`, `legal-copy-fixes`). They were **not** merged to
> `main`. Everything else on those branches was cherry-picked across.
>
> **Binding consequence for all copy.** No ToS, Privacy Policy, store listing,
> popup, or marketing text may say or imply that statshelpr suggests, marks,
> or highlights rather than enters answers, or that the student performs the
> selection. That is false for every question type. Copy must say it enters
> the answer and that the student reviews and submits. See
> `docs/cws/listing.md` and ToS §5, both written to this rule.

**Worktree:** `/Users/zsha/Documents/statshelpr-liability`, branch `liability-reduction`, base `0a8efb1`.

| Task | Status |
|---|---|
| 3 — suggestion-only choices | **ABANDONED 2026-07-27 — not merged to main.** Was implemented (`c24541b`, `632a225`, `c4dfd85`) and reviewed; superseded by the decision above. |
| 4 — answer chip | **ABANDONED 2026-07-27 — not merged to main.** Was implemented (`524916b`, `3993083`); superseded by the decision above. |
| 5 — blanks | **CANCELLED 2026-07-27 by owner.** Started and stopped mid-implementation; worktree reverted clean. Matching and multiple-dropdowns questions **still write answers into the submission** via `writeBlanks`. `setSelectValue` and `setTextInputValue` remain live. This cancellation is what triggered abandoning Tasks 3–4 as well — see the decision above. |
| 6 — surface gate | **DECIDED 2026-07-27: Config B.** Not implemented. See decision record. |
| 7–13 | Not started. |

**Corrections made to this plan during execution (all found by review subagents):**
1. Task 3 said "delete `setSelectValue` entirely" — but `writeBlanks` calls it. Deferred to Task 5.
2. Task 3's brief stated an absolute "nothing reachable from `suggestAnswerChoice` writes to a submission" alongside a scope boundary excluding `fillTextInput`, which `suggestAnswerChoice` delegates to. Contradictory; sequencing note added to Task 4.
3. Task 4 would have hit the identical `setTextInputValue` trap. Pre-corrected.

**Task 3 regression — fixed in `c4dfd85`:** `content.ts:352-357` pre-solve reset cleared only `.statshelpr-suggested` while marking spans two classes on two elements; re-solve left a stale label tint. Reset now clears both.

**Finding relevant to Task 5:** `setSelectValue`, `writeBlanks`'s no-match branch, and `setTextInputValue` each mark only the element itself and do **not** need two-class treatment — a `<select>` / text `<input>` is one self-contained widget, unlike a radio paired with a separate `<label>` carrying the visible text. Pending reviewer confirmation. If confirmed, Task 5 has no work on this point.

**Blocking gate — RESOLVED 2026-07-27 by abandoning the arc:** Task 2's ToS sentence *"statshelpr does not enter, select, or submit answers on your behalf"* must NEVER ship. Tasks 3–5 were abandoned, so the gate it was waiting on can no longer be satisfied — the extension enters answers for every question type. The shipped ToS §5 states that plainly.

---

## Why each change exists

Every code change below maps to a specific legal mechanism. An engineer executing this plan should not "simplify" a change without understanding what it was load-bearing for.

| Change | Mechanism |
|---|---|
| No write-back into submissions | § 32.50(b) requires preparing/**delivering** an academic product. If `input.value` is never set by us, the submitted artifact is the student's. Also restores the "instrument, not preparer" characterization. |
| Answer shown adjacent, never inside the field | Same as above, plus removes the "is this field filled?" ambiguity that causes blank submissions. |
| Explanation panel | § 32.50(e) defense presupposes assisting "the other person's preparation." An explanation surface that students actually use is what makes that true. |
| Manual input box | Substantial legitimate use. Makes generality real instead of declared. |
| Practice generator | Same. This is the feature that makes "tutor" accurate. |
| Post-attempt review | Unambiguously authorized on every vector. |
| Keep metrics | Usage data on tutoring features is the evidence that they aren't vestigial. Removing telemetry to avoid unfavorable data is the error this plan exists to avoid. |
| Surface gate (Task 6) | UT 11-402(c)(4): "providing aid or assistance… **without authority**… in conjunction with a test." Authority is determined by surface, not by delivery mechanism. **This is the only change that materially moves UT exposure.** |

### Explicitly excluded, and why

**Decoy `host_permissions` / `matches` entries for unrelated sites.** Rejected. `canvas-dom.ts` is 852 lines of Canvas-quiz-specific parsing; adding match patterns with no corresponding parser creates a provable gap between what the manifest claims and what the code does. That gap is affirmative-steps evidence of the *Grokster* kind, it is visible in a one-line manifest diff, and declaring unused permissions is independently a Chrome Web Store violation. The manual input box (Task 8) achieves real generality and is the honest substitute.

**Any feature designed not to be used.** If the tutoring surfaces have near-zero engagement, the metrics prove the product's actual purpose. Build them to be used or don't build them.

---

## Task 0: Worktree

**Step 1:** Create the worktree.

```bash
git worktree add ../statshelpr-liability -b liability-reduction
```

**Step 2:** Verify base is current `main`.

```bash
cd ../statshelpr-liability && git log --oneline -1
```
Expected: `0a8efb1 Merge branch 'r-export-popup-ui'` or later.

**Step 3:** Install and confirm the suite is green before touching anything.

```bash
pnpm install && pnpm --filter @statshelpr/extension test
```
Expected: all 14 test files pass. **If anything fails here, stop — you are not on a clean base.**

---

# Phase A — Non-code (can run in parallel with Phase B)

## Task 1: Assumed name certificate (user action, not Claude)

**Owner:** Zak. Not a code task.

**Step 1:** File a Texas assumed name certificate ("DBA") for `statshelpr` with the Travis County Clerk. ~$25.

**Step 2:** Record the exact legal party string for the ToS: `Zak Shaikh d/b/a statshelpr`.

**Note:** LLC deferred until ~$1k MRR. An LLC does nothing for UT discipline or § 32.50 (both attach personally); it only shields civil claims, and at current revenue there is little to shield. Revisit at first real revenue or first contract.

---

## Task 2: Terms of Service rewrite

**Files:**
- Modify: the ToS source (locate with `rg -l "Academic Integrity" --glob '!node_modules'`)

**Step 1:** Remove the existing user warranty sentence.

Delete: *"By using statshelpr, you warrant that your use complies with all applicable academic integrity obligations."*

It is unenforceable against UT (no privity), worthless against § 32.50 (negligence standard), and reads as anticipation of the prohibited use.

**Step 2:** Replace the Academic Integrity section with a descriptive one.

```markdown
## 4. Academic Integrity

statshelpr is a statistics tutoring and computation tool. It displays worked
solutions and runnable R code.

statshelpr does not enter, select, or submit answers on your behalf. Any
answer you submit is one you entered yourself.

You are responsible for knowing and following your institution's academic
integrity policy, including whether outside tools are permitted for a given
assignment or assessment.
```

> **⛔ DEAD DRAFT — DO NOT COPY THIS BLOCK. Sentence two is false.** It was
> written for the suggestion-only build that was abandoned on 2026-07-27.
> statshelpr *does* enter and select answers; only "does not submit" is true.
> The live wording is in `apps/landing/legal.html` §5 — take it from there,
> not from here. This block is kept only as a record of what was drafted.

**Step 3:** Add the clauses that carry actual civil value.

- **Parties:** `Zak Shaikh d/b/a statshelpr` (from Task 1).
- **Warranty disclaimer:** AS IS; no warranty of accuracy. *This is the most important addition.* The likeliest civil claim is "the answer was wrong and I lost credit," not anything academic.
- **Limitation of liability:** capped at fees paid in the trailing 12 months.
- **Arbitration + class action waiver:** AAA consumer rules, Travis County, TX.
- **Governing law:** Texas.
- **Termination:** right to suspend any account at any time, any reason.
- **Refund policy:** chargeback defense.
- **Privacy:** state plainly that no question text or answer content is transmitted to analytics or stored — this is already true (Task 12 keeps it true).

**Step 4:** Attorney review — ~$300–600, 1–2 hours, Texas licensed.

Have them review **only**: the arbitration clause, the liability cap, and the warranty disclaimer. Those three fail if drafted wrong and are the ones doing real work. Do not pay for review of the academic-integrity section; it is descriptive prose.

**Step 5:** Commit.

```bash
git add docs/ && git commit -m "legal: rewrite ToS — descriptive integrity section, add liability cap, arbitration, warranty disclaimer"
```

---

# Phase B — Removals

## Task 3: Choice selection becomes suggestion-only

**Files:**
- Modify: `apps/extension/src/canvas-dom.ts:91-136` (`selectAnswerChoice` → `suggestAnswerChoice`)
- Modify: `apps/extension/src/canvas-dom.ts:184-216` (`applyChoice`, `setSelectValue`)
- Modify: `apps/extension/src/content.ts:50,500`
- Modify: `apps/extension/public/panel.css`
- Test: `apps/extension/test/multiple-choice.test.ts` and all sibling type tests

**Design:** rename rather than silently change behavior. The rename makes every stale call site a compile error instead of a silent behavior change, and it self-documents the diff.

**Step 1: Write the failing test.**

Add to `apps/extension/test/multiple-choice.test.ts`:

```typescript
it("suggests without selecting: marks the choice, never sets checked, fires no events", () => {
  const { question } = buildChoiceQuestion({
    questionType: "multiple_choice_question",
    inputType: "radio",
    stemText: REC.questionText,
    choiceTexts: REC.choices.map((c) => c.text),
  });
  const scraped = collectAnswerChoices(question);
  const apiChoices = toApiChoices(scraped);
  const { firedInput, firedChange } = trackEvents(question);

  const count = suggestAnswerChoice(question, "Answer: A.", ["A"], apiChoices);

  expect(count).toBe(1);
  const marked = question.querySelectorAll(".statshelpr-suggested");
  expect(marked).toHaveLength(1);
  // The student's submission is untouched.
  const radios = [...question.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(radios.every((r) => r.checked === false)).toBe(true);
  expect(firedInput()).toBe(false);
  expect(firedChange()).toBe(false);
});
```

**Step 2: Run it — verify it fails.**

```bash
pnpm --filter @statshelpr/extension test -- multiple-choice
```
Expected: FAIL, `suggestAnswerChoice is not exported`.

**Step 3: Implement.**

In `canvas-dom.ts`, rename the export and strip the mutation from `applyChoice`:

```typescript
export function suggestAnswerChoice(
  question: HTMLElement,
  answer: string,
  selectedLabels: string[] = [],
  originalChoices?: Array<{ label: string; text: string }>,
): number {
```

Replace `applyChoice`:

```typescript
/** Mark a choice as the suggested answer. Never mutates the input's checked
 * state, never sets a <select>'s value, never dispatches events — the student
 * performs every act that produces the graded submission. Returns 1 when a
 * mark was applied. */
function applyChoice(choice: AnswerChoice): number {
  if (choice.kind === "text-fill") return 0; // handled by suggestTextAnswer
  const el = choice.input as HTMLElement;
  el.classList.add("statshelpr-suggested");
  labelElementFor(el)?.classList.add("statshelpr-suggested-label");
  return 1;
}
```

Delete `selectDropdownOption` (used only by the choice path). For a dropdown choice, mark the `<option>`'s parent `<select>` and surface the option text in the panel (Task 7) — do not set `selectedIndex`.

**Do NOT delete `setSelectValue` in this task.** `writeBlanks` (canvas-dom.ts:579) still calls it, and `writeBlanks` belongs to Task 5. Deleting it here breaks compilation and forces an out-of-scope edit. `applyChoice` simply stops routing through it; **Task 5 deletes it** once `writeBlanks` no longer needs it.

**Step 4: Add the highlight styles** to `panel.css`:

```css
.statshelpr-suggested {
  outline: 2px solid var(--sh-accent, #4f46e5);
  outline-offset: 2px;
  border-radius: 3px;
}
.statshelpr-suggested-label {
  background: color-mix(in srgb, var(--sh-accent, #4f46e5) 12%, transparent);
  border-radius: 3px;
}
```

**Step 5: Update every call site and test.**

```bash
rg -l "selectAnswerChoice" apps/extension
```
Update each. In the type tests, assertions of the form `expect(input.checked).toBe(true)` become `expect(input.classList.contains("statshelpr-suggested")).toBe(true)` plus `expect(input.checked).toBe(false)`.

**Step 6: Run the full suite.**

```bash
pnpm --filter @statshelpr/extension test
```
Expected: all pass.

**Step 7: Commit.**

```bash
git commit -am "extension: suggest answers instead of selecting them — never mutate the submission"
```

---

## Task 4: Adjacent answer chip for text-fill

> **Sequencing note (added after Task 3 review).** Until this task lands, `suggestAnswerChoice` still reaches `fillTextInput` for single-text-fill questions, which sets `input.value` and dispatches input/change events. Task 3's suggestion-only guarantee therefore covers radio / checkbox / dropdown **only**. The claim "statshelpr does not enter, select, or submit answers on your behalf" is not true extension-wide until Tasks 4 **and** 5 are both merged — this is the gate referenced in Task 2 Step 2.

**Files:**
- Modify: `apps/extension/src/canvas-dom.ts:218-228` (`fillTextInput` → `suggestTextAnswer`)
- Modify: `apps/extension/public/panel.css`
- Test: `apps/extension/test/numerical.test.ts`, `apps/extension/test/short-answer.test.ts`

**Design:** the chip is a sibling element positioned next to the input — **not** a `placeholder`, and **not** inside the field. It persists while the student types (no clear-on-keystroke, per the stranded-mid-type problem) and never touches the input node.

**Step 1: Write the failing test** in `numerical.test.ts`:

```typescript
it("suggests without filling: renders an adjacent chip, leaves the input empty and untouched", () => {
  const { question, input } = buildTextFillQuestion({ stemText: REC.questionText, numerical: true });
  let inputFired = false;
  input.addEventListener("input", () => (inputFired = true));

  const count = suggestTextAnswer(input, "Answer: 2,087.");

  expect(count).toBe(1);
  expect(input.value).toBe("");
  expect(input.placeholder).not.toContain("2,087");
  expect(inputFired).toBe(false);

  const chip = question.querySelector(".statshelpr-answer-chip");
  expect(chip?.textContent).toContain("2,087");
});

it("chip persists while the student types (no clear-on-keystroke)", () => {
  const { question, input } = buildTextFillQuestion({ stemText: REC.questionText, numerical: true });
  suggestTextAnswer(input, "Answer: 2,087.");
  input.value = "2";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(question.querySelector(".statshelpr-answer-chip")).not.toBeNull();
});
```

**Step 2: Run — verify failure.**

```bash
pnpm --filter @statshelpr/extension test -- numerical
```

**Step 3: Implement.** Keep the existing value-extraction logic verbatim (the regex, punctuation strip, quote strip, `isNumericalTarget` / `sanitizeNumericValue` calls) — only the final write changes:

```typescript
/** Render the model's answer as a chip pinned next to `input`. Never sets
 * input.value, input.placeholder, or dispatches events — the student types
 * the answer themselves. Idempotent: a second call replaces the chip. */
export function suggestTextAnswer(input: HTMLInputElement, answer: string): number {
  const m = answer.match(/(?:Answer|Final answer)\s*:?\s*(.+?)(?:\n|$)/i);
  let value = (m?.[1] ?? answer).trim();
  value = value.replace(/[.,;]\s*$/, "").trim();
  value = value.replace(/^["'`]|["'`]$/g, "");
  if (isNumericalTarget(input, value)) value = sanitizeNumericValue(value) || value;
  if (!value) return 0;

  input.parentElement?.querySelector(".statshelpr-answer-chip")?.remove();

  const chip = document.createElement("span");
  chip.className = "statshelpr-answer-chip";
  chip.textContent = `Answer: ${value}`;
  input.insertAdjacentElement("afterend", chip);
  input.classList.add("statshelpr-suggested");
  return 1;
}
```

**Do NOT delete `setTextInputValue` in this task.** Same trap as `setSelectValue` in Task 3: `writeBlanks` also calls it, and `writeBlanks` belongs to Task 5. `suggestTextAnswer` simply stops calling it; **Task 5 deletes both** `setTextInputValue` and `setSelectValue` once `writeBlanks` is converted.

**Step 4:** Update `suggestAnswerChoice`'s text-fill branch (was line 101-103):

```typescript
if (choices.length === 1 && choices[0]?.kind === "text-fill") {
  return suggestTextAnswer(choices[0].input as HTMLInputElement, answer);
}
```

**Step 5:** Style in `panel.css` — visually distinct from user input so it can never be mistaken for a filled field:

```css
.statshelpr-answer-chip {
  display: inline-block;
  margin-left: 8px;
  padding: 2px 8px;
  font: 500 13px/1.4 ui-monospace, monospace;
  color: var(--sh-accent, #4f46e5);
  background: color-mix(in srgb, var(--sh-accent, #4f46e5) 10%, transparent);
  border: 1px dashed var(--sh-accent, #4f46e5);
  border-radius: 4px;
  user-select: all;
}
```

**Step 6: Run and commit.**

```bash
pnpm --filter @statshelpr/extension test && \
git commit -am "extension: adjacent answer chip replaces text-input fill"
```

---

## Task 5: Blanks (matching / multiple-dropdowns) become suggestion-only

**Files:**
- Modify: `apps/extension/src/canvas-dom.ts` (`writeBlanks`)
- Test: `apps/extension/test/matching.test.ts`, `multiple-dropdowns.test.ts`, `fill-in-multiple-blanks.test.ts`

`writeBlanks` sets `<select>` values via the React-aware native setter. Same treatment: mark the select, render the suggested option text in an adjacent chip, set nothing.

**Step 1:** Write failing tests asserting `select.selectedIndex === 0` (unchanged) and a chip per blank.
**Step 2:** Run, verify failure.
**Step 3:** Rename `writeBlanks` → `suggestBlanks`; replace `setSelectValue` calls with `applyChoice`-style marking **plus a mandatory chip per blank**.

> **The chip is not optional here.** For a radio/checkbox, the answer text is already rendered on the page in the `<label>`, so an outline alone communicates the answer. For a `<select>` or text `<input>`, the answer text only appears because the current code *writes it into the widget* — once this task stops writing, an outlined-but-empty `<select>` showing `[ Select ]` says "something is suggested" and nothing more. Every suggestion on a select or text input MUST carry a chip with the actual answer text, or the feature is non-functional for these question types. `writeBlanks`'s existing no-match branch (canvas-dom.ts:592-594) marks a select without setting it and is a live preview of exactly this failure mode.

Also delete `setSelectValue` and `setTextInputValue` in this task — both are freed once `writeBlanks` no longer calls them. Verify with `rg "setSelectValue|setTextInputValue" apps/extension` before deleting.
**Step 4:** Update `content.ts:500`.
**Step 5:** Run full suite; commit.

```bash
git commit -am "extension: suggest blanks instead of writing them"
```

---

## Task 6: DECIDED — graded-attempt surface

> ### Decision record
>
> **Date:** 2026-07-27
> **Decided by:** Zak Shaikh (owner)
> **Outcome: Config B — statshelpr continues to operate on live graded quiz attempts.** Task 6 is not implemented.
>
> **What was weighed.** Config A (gating `/quizzes/:id/take` and the New Quizzes runtime) was presented as the recommended option and declined. The tradeoff was explicit: Config A was the only change in this plan that materially reduces UT Institutional Rules exposure, and it would have cost coverage of live graded attempts while retaining assignments, modules, practice quizzes, and post-submission review.
>
> **Risk knowingly accepted.** UT 11-402(c)(4) prohibits "providing aid or assistance… without authority… in conjunction with a test." Authority is a property of the surface, not of the delivery mechanism — so Tasks 3–5, which stop the extension from writing into submissions anywhere, do not reduce this particular exposure. 11-402(a) permits a single faculty member to initiate proceedings, adjudicated on a preponderance standard. The target course (STA 301) is a large required McCombs course.
>
> **Risk still mitigated by the rest of the plan.** Tasks 3–5 mean nothing is ever entered into a submission by the extension on any surface, which addresses § 32.50(b) and the civil vector. Tasks 7–10 build genuine tutoring and general-solver surfaces. Task 2 adds the warranty disclaimer and liability cap.
>
> **Consequences for other tasks:** ~~Task 2's sentence *"statshelpr does not enter, select, or submit answers on your behalf"* remains accurate under Config B once Tasks 3–5 merge, and ships as written.~~ **Superseded 2026-07-27:** Tasks 3–5 were abandoned (see the notice at the top of this document), so that sentence is false and must never ship. The shipped ToS §5 says the opposite — that statshelpr enters the answer and the student reviews and submits it. Only the *"does not submit"* half of the original claim survives. Task 11's store copy is unaffected by the Config B choice but was likewise rewritten to describe entering, not suggesting. No claim anywhere in the product may state or imply that the extension is unavailable during graded attempts.

**Retained below for the record — this is the option that was declined.**

The UT rule is 11-402(c)(4): *"providing aid or assistance to or receiving aid or assistance from another student or individual, **without authority**, in conjunction with a test, project, or other assignment."* Authority is a property of the **surface**, not the delivery mechanism. Highlighting on an exam is still providing aid on an exam. Tasks 3–5 do not change this.

### Config A — gate the graded attempt (recommended)

**Files:** `apps/extension/public/manifest.json`, `apps/extension/src/content.ts`

Remove from `content_scripts[0].matches`:
- `https://quizzes.next.instructure.com/*`

Narrow `https://*.instructure.com/courses/*/quizzes/*` and add a boot guard in `content.ts`:

```typescript
/** True on a live graded quiz attempt. statshelpr does not operate here —
 * see docs/plans/2026-07-27-liability-reduction.md Task 6. */
function isGradedAttempt(): boolean {
  const p = location.pathname;
  return /\/courses\/\d+\/quizzes\/\d+\/take/.test(p) || location.hostname === "quizzes.next.instructure.com";
}
```

Bail before button injection. Keep everything on `/assignments/*`, `/modules/*`, practice quizzes, and post-submission review pages.

Also drop `quizzes.next.instructure.com` from `host_permissions`.

| | § 32.50 | Civil | **UT 11-402** | CWS |
|---|---|---|---|---|
| Config A | ~None | Low | **Low** | Low |
| Config B | Low | Low | **Unchanged — high** | High |

### Config B — keep graded attempts ← **SELECTED 2026-07-27**

Skip this task. Tasks 3–5 still apply. See the decision record at the top of this task.

---

## Task 7: Explanation panel

**Files:**
- Create: `apps/extension/src/explain-panel.ts`
- Modify: `apps/extension/src/content.ts`, `apps/extension/public/panel.css`
- Modify: `packages/solver-core/` — add `explanation` to the result contract
- Test: `apps/extension/test/explain-panel.test.ts`

**Note for the implementer:** there is no in-page panel today. `content.ts:24-28` documents "no answer card, no explanation" and `panel.css` currently styles only the button and toast. This task builds the panel.

**Design:**
- Collapsible container appended under the question, **collapsed by default**.
- **Auto-expands on the first solve of a session only** (`chrome.storage.session`, key `statshelpr.panelIntroShown`), then remembers per-question state. Students cannot use a surface they never discover, and the tutoring metrics in Task 12 depend on discovery.
- Renders: method line, worked steps, R code (reuse `r-export.ts` formatting), and the answer.

**Step 1:** Add `explanation: string` to `ConceptResult` / `CalcResult` in `content.ts:72-105` and to the solver-core result type. Populate it server-side in the same response — **one API call, no extra round trip.** Do not scrape model thinking blocks: unpolished, not display-intended, and provider terms may restrict surfacing them.

**Step 2–5:** TDD the panel — failing test for collapsed-by-default, one for first-solve auto-expand, then implement, then commit.

```bash
git commit -am "extension: in-page explanation panel, collapsed by default"
```

---

# Phase C — Additions

## Task 8: Manual problem input (popup)

**Files:** `apps/extension/src/popup.ts`, `apps/extension/public/popup.html`

**This is the highest-value item in the plan.** It is what makes the tool a general stats instrument rather than a Canvas reader — the real version of the generality that decoy host permissions would only have simulated.

- Textarea + optional CSV attach (reuse the existing DATA FILES storage).
- POSTs the same `/api/solve` endpoint; renders worked solution + R code + copy button.
- Works entirely off Canvas: textbook problems, lecture examples, PDFs.

TDD the request-shaping and render functions; the DOM wiring can be smoke-tested.

```bash
git commit -am "popup: manual problem input — solve any stats problem"
```

## Task 9: Practice generator

**Files:** `apps/extension/src/popup.ts`, new solver-core prompt path

"5 more like this" — same concept, new numbers, full worked solutions. Seeded from either a solved question or manual input.

```bash
git commit -am "popup: practice problem generator"
```

## Task 10: Post-attempt review mode

**Files:** `apps/extension/src/content.ts`, `apps/extension/src/canvas-dom.ts`

On a submitted/graded quiz review page, offer "explain every question." Zero exposure on every vector — nothing is being prepared for submission.

```bash
git commit -am "extension: post-attempt review mode"
```

---

# Phase D — Ship

## Task 11: Store copy scrub

**Files:** `apps/extension/public/manifest.json`, store listing

Remove anything implying quiz completion, scores, or speed. Lead with the R pipeline and the manual solver.

Proposed description:

```
Statistics tutor — worked solutions with runnable R code. Solve any stats
problem from the popup, generate practice problems, and review your work.
```

## Task 12: Metrics — keep, and extend

**Files:** `apps/extension/src/telemetry.ts`

**Do not remove the metrics layer.** Add content-free counters for the new surfaces: `manual_solve`, `practice_generated`, `panel_expanded`, `review_mode_used`.

Preserve the existing privacy contract exactly: no question text, no answers, no course/quiz identifiers that resolve to an institution, and **keep the install-id namespace separate from the billing-email namespace** so no join can build a per-student activity history. The value is in those two identifiers never meeting.

## Task 13: Verify and integrate

```bash
pnpm --filter @statshelpr/extension test
pnpm --filter @statshelpr/extension build
```

Manual verification on a real Canvas practice quiz — confirm no radio is ever checked, no input value is ever set, and the chip renders adjacent.

Bump `manifest.json` version to `1.2.0`. Then per CLAUDE.md, merge to main and remove the worktree:

```bash
git checkout main && git merge liability-reduction && git worktree remove ../statshelpr-liability
```

---

## Timeline

| Week | Work |
|---|---|
| 1 | Task 1 (DBA), Task 2 (ToS → attorney), Tasks 3–5 (removals, ~1 day of code), Task 6 decision |
| 2 | Task 7 (panel), Task 8 (manual input) |
| 3 | Task 9 (practice), Task 10 (review), Tasks 11–12 |
| 4 | Task 13, beta with a handful of students, launch |
