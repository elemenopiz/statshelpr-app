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

Re-capturing a question updates it in place (deduped by question text), so
fixing a mislabel is just capturing again. Everything is local — no network, no
API calls, no solve-quota usage.

## Build

```bash
# from repo root, once:
pnpm install

# build the extension:
cd apps/extension-capture
pnpm build        # → apps/extension-capture/dist
pnpm watch        # rebuild on change
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
