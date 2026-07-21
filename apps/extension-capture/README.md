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
auto-captures every question and buckets each by what can be verified:

- **Verified** → goes in the eval fixtures. Either Canvas shows the key inline
  (`.correct_answer`), **or** the question is marked full marks — so the
  student's own selected answer *is* the correct one (works even when the quiz
  hides correct answers, which is the common case). The panel shows
  `⚡ auto-captured N (V verified)`.
- **Unsolved** → the separate held-out export. A question missed on every
  attempt while answers are hidden: we keep the question, choices, images,
  dataset, and the student's (wrong/unknown) pick + outcome, but the correct
  answer is unknown. This is the set to test the AI on once it aces the verified
  fixtures — deliberately kept out of the eval set so it can't leak answers.

Fixtures and Unsolved form a clean partition (answer known vs unknown), so
together they're every captured question. Each record carries: question text,
choices, images, referenced dataset, the student's selection, whether it was
right/wrong (`outcome`), the correct answer when known, an inferred concept/calc
mode, and course/quiz/url/time. Every question type is covered — radio,
checkbox, dropdown, fill-in — plus images (fetched from `instructure.com` and
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

## Exports

Two buttons in the panel/popup:

- **Export fixtures** — verified captures only, in the `evals/solve-fixtures`
  shape. Split into files and run the evals:
  ```bash
  pnpm import:captures ~/Downloads/statshelpr-fixtures-*.json   # → evals/solve-fixtures/
  pnpm eval
  ```
- **Export unsolved** — the questions whose answer was never established
  (missed every attempt, answers hidden), with the full question record: choices,
  images, dataset, the student's pick, and outcome. The held-out AI-test set;
  not the eval fixture shape. (Fixtures + Unsolved = every captured question.)

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
