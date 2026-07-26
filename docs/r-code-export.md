# Feature: copy practice-quiz R code from the popup

**Status:** IMPLEMENTED 2026-07-24, merged to `main`. First cut shipped a floating on-page
"download as .R file" button (§2 below describes that version); a same-day follow-up replaced it
with what's actually live now: a folded "R code" section in the popup (`popup.html`/`popup.ts`,
next to "R libraries"), unfolding to a **"Copy R code for this quiz"** button that copies the
bundle to the clipboard. The buffer, privacy contract, and `local({...})` wrapping are unchanged
from §0/§1 below — only the surface (popup vs. on-page) and the action (clipboard copy vs. file
download) changed. Popup fetches the buffer from the content script per-open via a new
`sh-get-r-export` runtime message (content script responds synchronously with `{hasCode, bundle}`);
see `apps/extension/src/r-export.ts` and the `sh-get-r-export` handler in `content.ts`'s
`onMessage` listener.

**Goal:** let a student copy the R code the extension generated for the *computational* (calc)
questions in a practice/ungraded quiz attempt, bundled into one clipboard payload. Concept
questions never produce R and are excluded automatically.

---

## 0. Decided constraints (do not relitigate these)

- **Calc questions only.** Concept-question answers are never included (they have no `rCode`).
- **No question text.** Never include the quiz question, choices, or answer.
- **No comments, no labels, no identifiers.** No `# Q3`, no quiz name, no timestamp, no question
  type label — nothing that ties a code block back to a specific question or quiz. The export is
  an anonymous bundle of R snippets, nothing else.
- **Each snippet is scope-isolated**, not comment-labeled, to prevent variable collisions when
  concatenated (e.g. two questions both defining `x` or `model`). Wrap each in `local({ ... })` (or
  bare `{ }`), separated by a blank line. This solves the collision problem without adding any
  identifying text.
- **Why this shape:** discussed at length this session — the concern is that code paired with
  question/quiz identity turns a personal study export into a reusable answer key if the same
  question bank is recycled across semesters/sections. Stripping question text and identifiers
  keeps the export as "R patterns I used" rather than "answers to Fall 2026 Quiz 4." This is a
  practice/ungraded-quiz feature, not a live-graded-quiz feature.

---

## 1. What already exists (confirmed by code search, 2026-07-24)

| Need | Status | Where |
|---|---|---|
| calc vs. concept distinction | **Already exists** | `packages/solver-core/src/core/parse-response.ts:77` — `parseResponse()` sets `mode: "concept" \| "calc"` |
| R code per calc question | **Already exists** | `apps/api/lib/solver/non-streaming.ts:83-84` returns `{ mode: "calc", rCode, rOutput, ... }`; streaming route mirrors this shape via SSE at `apps/api/app/api/solve/route.ts:257-269` |
| Cross-question session state (quiz attempt) | **Does not exist** | No session/attempt id anywhere in `apps/extension`, `apps/api`, or `packages/solver-core`. The closest thing, `apps/extension/src/telemetry.ts`, is fire-and-forget per question and is explicitly barred by its own privacy contract (`telemetry.ts:14-17`) from carrying question/answer content or a linking id — do not repurpose it for this. |
| R code display / any UI surface in the extension | **Does not exist** | `apps/extension/src/content.ts:1-39` states outright: "No answer card, no explanation, no R code display... in this content script." `rCode` is received (`content.ts:82-104`) but only kept "for potential future display," never rendered. |
| Download/export mechanism | **Does not exist** | No `Blob`/`createObjectURL`/`chrome.downloads` usage anywhere in the extension today (grep clean). Would be written from scratch. |
| Practice vs. graded runtime signal | **Planned, not built** | `docs/planning.md:11-14, 223` describes an "off-by-default toggle labeled 'for practice / ungraded assignments only'" for the answer-select behavior — no such flag exists in code yet. This feature currently has no way to *know* it's in a practice context; it just needs its own trigger. |

---

## 2. Proposed shape (original plan — see status note above for what actually shipped)

1. **Buffer, not persistence.** Add an in-memory array scoped to the content-script instance
   (lives alongside the hook in `onSolve()`, `apps/extension/src/content.ts` ~line 450-521). On
   each solve where `solveResult.mode === "calc"`, push `solveResult.rCode` only — nothing else
   from the response. Resets on page reload; that's acceptable as a first cut since export happens
   at quiz end while still on the page. Revisit `chrome.storage.session` only if quizzes are found
   to span multiple page loads in practice.
2. **Export trigger.** New UI affordance ("download my R code") — there is no existing answer-card
   UI to hang this off of, so this is new surface. Worth coordinating with the planned
   explanation/R-code panel reframe in `docs/planning.md` rather than building two separate UI
   additions independently.
3. **Bundling.** Join buffered snippets, each wrapped in `local({ ... })`, blank line between each,
   no headers/footers, no comments. If the buffer is empty (no calc questions this attempt), hide/
   disable the export affordance rather than downloading an empty file.
4. **Download.** `Blob` + `<a download>` is sufficient and avoids requesting the `downloads`
   permission in `manifest.json`. No need for `chrome.downloads.download` unless a specific reason
   emerges.

---

## 3. Open questions from the build session — resolved as shipped

Resolved: no "quiz end" detection (the popup section is just always there, gated on
`hasExportableCode()`), not gated behind the unbuilt practice/graded toggle, shipped standalone
ahead of the planned explanation panel. Original open questions kept below for context.

- Does "quiz end" have a detectable signal today (a Canvas DOM event/route change in
  `canvas-dom.ts`), or does the export button just live persistently and the student clicks it
  whenever they're done? Needs a decision before writing the trigger.
- Should this ship gated behind the not-yet-built practice/graded toggle (§planning.md:14), or
  ship independently on the reasoning that the export button itself only makes sense in a
  practice context? Recommend deciding this alongside whoever builds that toggle, not in
  isolation.
- Does this ride along with the planned explanation/R-code display panel, or ship as a standalone
  minimal button ahead of that panel landing?

---

## 4. Explicit non-goals

- No live/graded-quiz support.
- No question text, choices, or answers in the export, ever.
- No comments, labels, question numbers, quiz names, or timestamps in the export.
- No export of concept-question content (none exists to export).
