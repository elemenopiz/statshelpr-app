# statshelpr — Data Capture (DEV)

A **developer-only** sideload extension for building the eval/training set. It
scrapes Canvas quiz questions exactly the way the production tutor does, and —
on graded pages — reads Canvas's own answer key to produce labeled fixtures with
no hand-labeling. Output matches `evals/solve-fixtures/*.json`, so it feeds
`scripts/run-evals.ts` directly.

> Not for the Chrome Web Store. It's meant to be loaded unpacked on your own
> machine against your own Canvas courses.

## How it captures answers

Capture is **automatic — no toggles, no clicks.** Opening a graded submission
auto-captures every question. Each record is flagged:

- **`verified: true`** — the answer is known. Either Canvas shows the key inline
  (`.correct_answer`), **or** the question is marked full marks so the student's
  own selected answer *is* the correct one (works even when the quiz hides
  correct answers — the common case). The panel shows `⚡ auto-captured N (V verified)`.
- **`verified: false`** — missed on every attempt while answers are hidden, so we
  keep the question + the student's (wrong/unknown) pick + `outcome`, but the
  correct answer is unknown. The held-out set to test the AI on later.

Everything exports to **one file** (`Export all`); `scripts/import-captures.ts`
splits it by `verified` into `evals/solve-fixtures/` (answer known) and
`evals/unsolved/` (the AI-test set) when you run evals. Each record carries:
question text, choices, images, referenced dataset, the student's selection,
`outcome` (right/wrong), the correct answer when known, an inferred concept/calc
mode, and course/quiz/url/time. Every question type is covered — radio, checkbox,
dropdown, fill-in/numerical — plus images (fetched from `instructure.com` and
`canvas-user-content.com`).

On a **live/ungraded quiz** there's no answer on the page, so each question gets
a manual pill — select the correct choice(s), click, your selection is the label.

Re-capturing the same question across attempts **never downgrades a verified
answer** (right one attempt, wrong another → the verified version wins).

## Dedup across attempts

A shuffle/bank quiz reuses questions across attempts, sometimes with different
numbers. The tool handles all three cases:

- **Exact reuse** → deduped automatically. Captures are keyed by question text,
  so re-capturing the same question updates it in place (also how you fix a
  mislabel). Choice order is ignored, so reshuffled answers still dedup.
- **Slightly-changed variants** (same wording, different numbers) → captured as
  distinct examples (their answers usually differ) but grouped by a **template
  id** (the question text with numbers blanked). The panel/popup show
  `N unique · M variants`, and the popup's **Dedupe variants** button collapses
  each template to its newest capture when you want a lean set.
- **New questions** → captured normally.

## Datasets

Many questions reference a data frame (e.g. *"the data frame in scooby.csv…"*).
The tool detects `*.csv` references and, on export, inlines the matching dataset
into the fixture's `dataFiles` (the runnable shape `run-evals.ts` expects).

The datasets are packaged from the course's R data:

```bash
pnpm --filter @statshelpr/extension-capture datasets ~/Downloads/KCdata_1-22.RData
pnpm build:capture      # bakes datasets/*.csv → dist/datasets.json
```

`convert-rdata.mjs` writes one `datasets/<name>.csv` per data frame (requires R
on PATH). Re-run it whenever the course data changes.

Everything is local — no network, no API calls, no solve-quota usage.

## Build

```bash
# from repo root, once:
pnpm install

# (one-time) convert the course RData into packaged CSVs:
pnpm --filter @statshelpr/extension-capture datasets ~/Downloads/KCdata_1-22.RData

# build the extension:
pnpm build:capture            # → apps/extension-capture/dist
# or: cd apps/extension-capture && pnpm build / pnpm watch
```

## Sideload

1. Visit `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `apps/extension-capture/dist`.
3. Open a Canvas quiz or a graded results page. You'll see:
   - a **capture pill** on each question, and
   - a floating **capture panel** (bottom-right).

Loading this alongside the production extension is fine — all injected UI is
`shcap-`-prefixed so the two never collide.

## Export

One **Export all** button (panel or popup) → a single
`statshelpr-captures-<time>.json` with every captured question, each flagged
`verified` + `outcome`. When you're ready to run evals, split it:

```bash
pnpm import:captures ~/Downloads/statshelpr-captures-*.json
#   verified   → evals/solve-fixtures/   (answer known — the eval set)
#   unverified → evals/unsolved/         (the held-out AI-test set)
pnpm eval
```

`import-captures` converts verified records to the `run-evals` fixture shape
(choice answers → `expected.selectedChoices`, numerical/fill-in → `answerContains`)
and writes the rest untouched.

## Notes

- **`mode` (concept/calc)** is inferred from the question (numeric fill-in or
  "compute the mean/regression/probability…" → `calc`, else `concept`). It's the
  one label the DOM can't state outright, so it's a best guess — fix the rare
  miss per-item in the popup.
- **Images & datasets** are always scanned/attached automatically — no settings.
- **Selector drift.** Question/choice/answer-key selectors mirror
  `apps/extension/src/content.ts`. If Canvas changes its markup, update
  `src/scrape.ts` here and `content.ts` together. If auto-detection misses a
  correct answer on a graded page, the pill falls back to manual labeling — note
  the question type/markup so the selectors can be extended.
