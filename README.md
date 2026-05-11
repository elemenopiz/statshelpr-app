# statshelpr-app

Canvas-embedded stats tutor — Chrome extension + Next.js API.

The extension scrapes the active quiz question (text + images), sends it to a Next.js API on Vercel, which classifies it as conceptual or code-required. Conceptual → Claude answers directly. Code-required → Claude writes R, code runs in a Vercel Sandbox microVM with tidyverse + mosaic + moderndive pre-installed, output is interpreted into a final answer. The extension renders the answer inline below each question and selects the matching answer choice.

**Live:** https://statshelpr.com (landing page) — extension installs from this repo.

## Architecture

```
Chrome extension (Canvas)
  ├─ Per-question Solve buttons (injected via MutationObserver)
  ├─ Floating CSV widget (course-wide data files, persisted in chrome.storage)
  └─ POST /api/solve  (SSE, streaming)  →  Next.js on Vercel
        ├─ POST /api/auth/validate-license → Lemon Squeezy
        ├─ classify (streaming) → [CONCEPT] | [RCODE]
        ├─ [CONCEPT] → Claude streams answer → done
        └─ [RCODE]   → Claude writes R → Vercel Sandbox runs R → Claude streams interpretation → done
```

## Layout

```
statshelpr-app/
├── apps/api/                        # Next.js App Router
│   ├── app/api/solve/route.ts       # streaming SSE endpoint
│   ├── app/api/health/route.ts      # status probe used by popup
│   ├── app/api/auth/validate-license/route.ts  # Lemon Squeezy gate
│   ├── lib/core/                    # system prompt, stats reference, parsers (TS port of exam_assistant.R)
│   ├── lib/sandbox.ts               # Vercel Sandbox R runner
│   └── lib/license.ts, lib/sse.ts, lib/data-summary.ts
├── apps/extension/                  # Chrome MV3 extension
│   ├── public/manifest.json         # Classic + New Quizzes matches
│   ├── src/content.ts               # per-question Solve buttons + inline answer cards
│   ├── src/popup.ts                 # status dot, license + API URL config
│   ├── src/background.ts
│   └── src/markdown.ts              # tiny markdown→DOM + R syntax highlighter
└── scripts/
    └── create-r-snapshot.ts         # One-time Vercel Sandbox snapshot builder
```

## Local dev

### 1. Install

```bash
cd web
pnpm install
```

### 2. Configure API env

If you've already linked a Vercel project, pull from there:

```bash
cd apps/api
vercel link --yes
vercel env pull .env.local --yes        # pulls ANTHROPIC_API_KEY, R_SANDBOX_SNAPSHOT_ID,
                                        # VERCEL_OIDC_TOKEN (auto-refreshed for sandbox auth)
```

Otherwise, start from the template:

```bash
cp apps/api/.env.example apps/api/.env.local
# fill in:
#   ANTHROPIC_API_KEY=sk-ant-...
#   R_SANDBOX_SNAPSHOT_ID=    (leave blank initially; runs slow until snapshot built)
#   VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID  (only for sandbox auth in local dev)
```

> **Note:** `VERCEL_OIDC_TOKEN` from `vercel env pull` is valid for ~12h. Re-pull at the start of each dev session to avoid mid-session sandbox auth failures.

### 3. Run API

```bash
cd apps/api
pnpm dev
```

The API listens on `http://localhost:3030`.

> **zsh note:** macOS zsh treats `#` as a literal character in interactive mode by default. Don't paste shell commands with inline `# comments` — they'll be passed as positional args. Either run commands one at a time without comments, or `setopt interactivecomments` in your shell.

### 4. Build extension

```bash
pnpm build:extension
# → web/apps/extension/dist/
```

Load `web/apps/extension/dist/` as an unpacked extension in `chrome://extensions` (Developer mode → Load unpacked). Click the extension icon, set API URL to `http://localhost:3030`, save.

### 5. Try it

Open any Canvas quiz on `*.instructure.com/courses/*/quizzes/*`.

- A **Solve** button appears above every question. Click it → answer streams in directly under that question, with R code + output collapsed below, and the matching answer choice is selected.
- A small **Data files** widget sits in the bottom-right. Drop CSVs in once; they persist across all quizzes (7-day TTL) and are sent automatically with each Solve.

## Lemon Squeezy

If `LEMONSQUEEZY_API_KEY` is unset the API runs ungated (good for dev).
For production:

```bash
vercel env add LEMONSQUEEZY_API_KEY production       # https://app.lemonsqueezy.com/settings/api
vercel env add LEMONSQUEEZY_STORE_ID production      # numeric, from Settings → Stores
vercel env add LEMONSQUEEZY_VARIANT_ID production    # numeric, from your Pro variant
```

Validation hits `POST https://api.lemonsqueezy.com/v1/licenses/validate` and caches the result in memory for 10 min per key. License keys go in the extension popup → saved per-browser via `chrome.storage.sync`.

## Building the R sandbox snapshot

The first time you run a code-required question without a snapshot, the API installs R + ~8 packages on every request (~15 min, will probably time out). Build a snapshot once:

```bash
cd web
pnpm tsx scripts/create-r-snapshot.ts
```

The script prints the snapshot ID. Add it to your Vercel project env:

```bash
vercel env add R_SANDBOX_SNAPSHOT_ID production
# paste the snapshot ID
```

Subsequent `/api/solve` calls boot from the snapshot in <1s.

## Deployment

```bash
cd web/apps/api
vercel link        # link to Vercel project
vercel env add ANTHROPIC_API_KEY production
vercel env add R_SANDBOX_SNAPSHOT_ID production
vercel deploy --prod
```

Update the extension's API URL in popup → save, then reload the extension.

## What's not built yet

- Per-license rate limiting / usage counter (Pro = unlimited but no Free tier yet).
- Conversation follow-up (the R version's `ask()`); the extension currently solves single questions only.
- Extension icon assets (using default Chrome puzzle-piece icon).
- New Quizzes (LTI-tool-based) selectors — current selectors cover Classic Quizzes (`.question_holder`, `.display_question`, `.question_text`). New Quizzes may need additions after live testing.
- Markdown rendering + R syntax highlighting in answers (currently plain text).
- Health check endpoint + popup status indicator.

## Source of truth for the classifier

The system prompt, stats reference, routing rules, and response parsing in `packages/core/` are a verbatim TypeScript port of `rstudio_assistant.R` / `exam_assistant.R` (top of the repo). Keep them in sync — when you tweak a routing rule in one, update the other.
