# statshelpr — Data Capture (DEV)

A **developer-only** sideload extension for building the eval/training set. It
scrapes Canvas quiz questions exactly the way the production tutor does, and —
on graded pages — reads Canvas's own answer key to produce labeled fixtures with
no hand-labeling. Output matches `evals/solve-fixtures/*.json`, so it feeds
`scripts/run-evals.ts` directly.

> Not for the Chrome Web Store. It's meant to be loaded unpacked on your own
> machine against your own Canvas courses.

## How it captures answers

- **Answer key (automated).** On a quiz **results / submission history** page,
  Canvas marks the correct choice inline (`.correct_answer` and friends). The
  on-page pill turns green and shows the detected letters; **Capture keyed** on
  the floating panel harvests every keyed question on the page at once. This is
  the fast path — take/submit a quiz, open results, capture the whole page.
- **Manual.** On a live/ungraded quiz with no key, select the correct choice(s)
  yourself, then click the question's pill. Your selection becomes the label.

Every question type is captured: single-answer (radio), select-all (checkbox),
dropdown, fill-in (text), and any images embedded in the question or answers.

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
on PATH). Re-run it whenever the course data changes. Toggle **datasets** in the
popup off to export filename-only refs (lean) instead of inlined content.

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

## Export → fixtures → eval

1. Click **Export .json** (in the panel or the popup) to download a bundle of
   all captures.
2. Split it into individual fixture files:
   ```bash
   tsx scripts/import-captures.ts ~/Downloads/statshelpr-fixtures-*.json
   # → evals/solve-fixtures/<slug>.json
   ```
3. Run the evals:
   ```bash
   tsx scripts/run-evals.ts --base-url http://localhost:3030
   ```

`.jsonl` export is also available for training pipelines (one fixture per line).

## Notes

- **`mode` (concept/calc)** defaults to `concept`. The DOM can't tell you whether
  a question needs R, so flip individual captures to `calc` in the popup (or set
  the panel default before capturing a batch of calc questions).
- **Images** are embedded by default (needed for graph/figure questions). Toggle
  off for text-only sets to keep bundles small.
- **Selector drift.** Question/choice/answer-key selectors mirror
  `apps/extension/src/content.ts`. If Canvas changes its markup, update
  `src/scrape.ts` here and `content.ts` together. If auto-detection misses a
  correct answer on a graded page, the pill falls back to manual labeling — note
  the question type/markup so the selectors can be extended.
