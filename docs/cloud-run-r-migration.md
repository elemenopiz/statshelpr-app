# Migration: move R execution to Google Cloud Run (server-side)

**Goal:** stop the browser extension from executing server-authored R (the Chrome Web Store
"remotely hosted code" violation — see `docs/planning.md` and the policy analysis in this session)
by running the R on a small Cloud Run service we control. The extension then only ever displays a
finished answer — it never runs remote code.

**Status:** proposal / not started. Written 2026-07-23 against `main` @ `be6d593`.

---

## 0. TL;DR — why this is smaller than it looks

The compliant "do everything server-side" pipeline **already exists** in the repo from before the
2026-07-20 Cloudflare migration; it was only shelved for infra cost, not deleted:

| Piece that already exists | What it does | Reuse as |
|---|---|---|
| `apps/api/lib/solver/non-streaming.ts` (`solveNonStreaming`) | Full server-side flow: LLM → run R → repair-on-error → LLM interpret → final answer. Browser runs nothing. | The template to port into the Worker |
| `apps/api/lib/solver/r-repair.ts` (`repairRCode`) | Re-prompts the model with stdout/stderr when R exits non-zero | Copy as-is into the Worker |
| `apps/api/lib/sandbox.ts` (`runRViaWebr`, `dataPreamble`) | Already calls an **HTTP R service** at `POST /runR` and wraps the script identically | The exact contract the Cloud Run service implements |
| `scripts/webr-eval-server.cjs` | A working `POST /runR` R server (WebR-in-Node) | Prototype the Cloud Run service in ~1 hour |
| `packages/solver-core/*` | `chat`, `parseResponse`, `extractRCode`, `buildFollowupContent`, `buildSystemPrompt`, model settings — already imported by the Worker | No change |

So the work is: **(1)** stand up one Cloud Run service that runs R, **(2)** rewire `solve.ts` to do
the calc+interpret server-side instead of handing R code to the browser, **(3)** delete the
client-side WebR from the extension.

---

## 1. Architecture: before → after

```
BEFORE (violates the policy):
  extension → POST /api/solve → Gemini writes R → server returns { mode:"rcode", rCode }
           → extension runs rCode in bundled WebR
           → extension POST /api/interpret → Gemini reads output → final answer

AFTER (compliant):
  extension → POST /api/solve → Worker:
                 Gemini writes R
                 → Worker POST {R_RUNNER_URL}/runR  (Cloud Run runs the R)
                 → repair-on-error (re-prompt Gemini, re-run) if needed
                 → Gemini interprets the R output
              → Worker returns the FINAL answer (one response)
           → extension just displays / fills the answer   ← never executes anything
```

The extension's calc path becomes identical in shape to today's **concept** path: send question,
await one answer. No WebR, no second `/api/interpret` round-trip from the client.

---

## 2. Part A — the Cloud Run service (the "R runner")

A tiny HTTP service: `POST /runR { code, files } → { stdout, stderr, exitCode, durationMs }`, plus
`GET /health`. This is the **exact** contract `sandbox.ts`'s `runRViaWebr()` already speaks, so the
Worker side barely changes.

**Recommended runtime: native R** (not WebR-in-Node). Native R starts in ~1–2s, runs truly
concurrently (one process per request), and — with packages pre-installed into the image — has no
per-request download. WebR-in-Node (the existing sidecar) is fine to *prototype* with but boots
slowly and serializes one run at a time, which hurts the class-quiz burst.

### 2.1 Dockerfile (native R + plumber)

Use the `rocker/tidyverse` base (tidyverse + ggplot2 + broom already compiled in), then add the few
extra packages from `apps/api/lib/sandbox.ts`'s `R_PACKAGES`:

```dockerfile
# r-runner/Dockerfile
FROM rocker/tidyverse:4

# Extra R packages beyond tidyverse (mirror sandbox.ts R_PACKAGES) + plumber for the HTTP layer.
# System libs (openssl/xml2/curl/fontconfig/...) are already present in rocker/tidyverse.
RUN R -e "install.packages(c('mosaic','moderndive','infer','openssl','base64enc','plumber'), \
          repos='https://cloud.r-project.org', Ncpus=4)"

COPY plumber.R /app/plumber.R
WORKDIR /app
ENV PORT=8080
EXPOSE 8080
# One R process per container; Cloud Run runs many containers for concurrency (see 2.4).
CMD ["R", "-e", "plumber::pr_run(plumber::pr('/app/plumber.R'), host='0.0.0.0', port=as.integer(Sys.getenv('PORT')))"]
```

### 2.2 The endpoint (`plumber.R`)

Mirrors the script wrapping in `sandbox.ts` (`options(warn=1)`, `width=160`, `set.seed(123)`, the
`dataPreamble` that loads each CSV as a frame named by its stem) so output matches what the solver
already expects. Auth is a shared secret header so only our Worker can call it. It runs the script
string with `source(textConnection(...))` — R's idiom for executing a script from text.

```r
# /app/plumber.R
library(plumber)

RUNNER_SECRET <- Sys.getenv("R_RUNNER_SECRET")  # set via Cloud Run env

#* @filter auth
function(req, res) {
  if (!identical(req$HTTP_X_RUNNER_SECRET, RUNNER_SECRET) || RUNNER_SECRET == "") {
    res$status <- 403; return(list(error = "forbidden"))
  }
  plumber::forward()
}

#* @get /health
function() list(ok = TRUE)

#* @post /runR
#* @serializer unboxedJSON
function(req, res) {
  body  <- jsonlite::fromJSON(req$postBody, simplifyVector = FALSE)
  code  <- body$code %||% ""
  files <- body$files %||% list()

  dir.create("/tmp/work", showWarnings = FALSE); setwd("/tmp/work")
  for (f in files) writeLines(f$content, f$filename)   # data files by name (stem-loaded in `code`)

  start <- Sys.time()
  out <- character(); err <- character(); status <- 0L
  con_out <- textConnection("out", "wr", local = TRUE)
  con_err <- textConnection("err", "wr", local = TRUE)
  sink(con_out); sink(con_err, type = "message")
  # Run the model's R script from text. print.eval=TRUE mimics the REPL-style
  # autoprint the browser WebR path produced; the model also print()s explicitly.
  tryCatch(
    source(textConnection(code), local = new.env(), echo = FALSE, print.eval = TRUE),
    error = function(e) { message(conditionMessage(e)); status <<- 1L }
  )
  sink(type = "message"); sink(); close(con_out); close(con_err)

  list(
    stdout    = paste(out, collapse = "\n"),
    stderr    = paste(err, collapse = "\n"),
    exitCode  = status,
    durationMs = as.integer(difftime(Sys.time(), start, units = "secs") * 1000)
  )
}
```

> The Worker sends `code` already wrapped with the `set.seed`/`dataPreamble` preamble (same helper
> as `sandbox.ts`), so `plumber.R` just runs what it's given. Keep the wrapping in ONE place.
> Match the stdout/stderr capture semantics of `scripts/webr-eval-server.cjs` and validate against
> the `evals/` fixtures (§9) — capture details are the one thing to confirm empirically, not assume.

### 2.3 Deploy

```bash
# from r-runner/
gcloud run deploy statshelpr-r-runner \
  --source . \
  --region us-central1 \
  --no-allow-unauthenticated \
  --concurrency 1 \
  --cpu 1 --memory 2Gi \
  --min-instances 0 --max-instances 50 \
  --timeout 30s \
  --set-env-vars "R_RUNNER_SECRET=$(openssl rand -hex 32)"
```

Grab the service URL it prints (`https://statshelpr-r-runner-xxxx.run.app`).

### 2.4 Config that matters

- `--concurrency 1`: R is CPU-bound; one request per container. Cloud Run spins up more containers
  to absorb a burst (that's how 50 concurrent quiz-solves get handled).
- `--memory 2Gi`: tidyverse loaded is memory-heavy; 512Mi will OOM. 1Gi may suffice — load-test.
- `--min-instances 0`: scales to **zero** when idle → **$0** at rest. To kill cold-start latency
  during a known quiz window, set `--min-instances 2` (small always-on cost, see §5).
- `--max-instances 50`: cap the blast radius. Raise if real bursts exceed it.
- `--timeout 30s`: a runaway R script can't hang forever (this is the server-side answer to the
  "no R timeout" bug from the audit).
- `--no-allow-unauthenticated` + the secret header: defense in depth so only our Worker calls it.

> **Fast-prototype alternative:** containerize `scripts/webr-eval-server.cjs` instead (Node base +
> `@r-wasm/webr`, expose its existing `POST /runR`). Zero new R code and byte-identical output to
> today's browser WebR — good for a first end-to-end test. Swap to native R before real load.

---

## 3. Part B — Cloudflare Worker changes (`apps/workers`)

### 3.1 New: `src/lib/r-runner.ts` (the fetch wrapper)

Direct port of `sandbox.ts`'s `runRViaWebr` + `dataPreamble`, with a hard timeout:

```ts
import type { Env } from "../types";
import type { DataFile } from "@statshelpr/solver-core/solver";

export interface RunRResult { stdout: string; stderr: string; exitCode: number; durationMs: number; }

export async function runRRemote(env: Env, rCode: string, files: DataFile[]): Promise<RunRResult> {
  const wrapped = [
    "options(warn = 1)", "options(width = 160)", "set.seed(123)",
    dataPreamble(files), rCode,
  ].filter(Boolean).join("\n");

  const res = await fetch(`${env.R_RUNNER_URL}/runR`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Runner-Secret": env.R_RUNNER_SECRET },
    body: JSON.stringify({ code: wrapped, files }),
    signal: AbortSignal.timeout(30_000),           // never hang a solve
  });
  if (!res.ok) throw new Error(`R runner ${res.status}: ${await res.text()}`);
  return (await res.json()) as RunRResult;
}

function dataPreamble(files: DataFile[]): string { /* copy verbatim from apps/api/lib/sandbox.ts */ }
```

### 3.2 Rewire `src/routes/solve.ts`

After the first Gemini pass, when the parsed mode is `calc`, do server-side what the browser used to
do — this is `solveNonStreaming`'s `runCalculationStage` + `runInterpretStage`, ported. Emit SSE
`phase` updates for UX, then emit the **final** answer:

```
1. first Gemini pass  (already there) → parseResponse
2. concept?  → return answer  (already there, unchanged)
3. calc:
   a. rCode = extractRCode(parsed.body)                    // already imported
   b. write phase "Computing…"
   c. runResult = await runRRemote(env, rCode, dataFiles)  // NEW — replaces the client
   d. if runResult.exitCode !== 0:  rCode = repairRCode(...) ; runResult = runRRemote(...)  // port r-repair.ts
   e. write phase "Finalizing…"
   f. interpret = chat(... buildFollowupContent(body, rCode, runResult.stdout) ...)  // was /api/interpret
   g. emit { type:"result", result:{ mode:"calc", answer, selectedChoices, blanks, confidence } }
```

Everything in steps a/d/f already exists in `solveNonStreaming` / `r-repair.ts` / solver-core — copy
it in, swap `runR` (Vercel) for `runRRemote` (Cloud Run).

### 3.3 Delete `src/routes/interpret.ts` (and its plumbing)

`/api/interpret` was a *client-initiated* second call; it no longer exists as a public route (the
interpret pass is now internal, step 3f). Remove:

- `src/routes/interpret.ts` and its route registration in `src/index.ts`.
- `src/lib/interpret-token.ts` and the token mint in `solve.ts` — the token only existed to protect
  the public `/api/interpret`; with no public interpret route, it's obsolete. (This retires the
  interim cost-hole fix from `49c51c7` **for interpret**; the per-install + per-IP + global
  kill-switch limits on `/api/solve` stay and still matter.)

### 3.4 Env / secrets (`wrangler.toml` + `wrangler secret`)

```toml
[vars]
R_RUNNER_URL = "https://statshelpr-r-runner-xxxx.run.app"
```
```bash
wrangler secret put R_RUNNER_SECRET   # same value as the Cloud Run env var
```
Add `R_RUNNER_URL: string` and `R_RUNNER_SECRET: string` to `Env` in `src/types.ts`.

> **Auth between Worker and Cloud Run:** simplest is the shared `X-Runner-Secret` header shown here.
> Stronger (later): make the runner `--no-allow-unauthenticated` and have the Worker mint a Google
> OIDC identity token. The shared secret is fine to launch.

---

## 4. Part C — extension changes (`apps/extension`)

This is mostly **deletion** — the extension gets smaller and simpler.

- **`src/content.ts`**: remove the `mode === "rcode"` branch, the `runR(...)` call, and the
  `/api/interpret` fetch. `onSolve` now awaits a single `/api/solve` SSE result and renders/fills the
  answer — same code path the concept result already uses.
- **`src/webr-runner.ts`**: **delete** (no client-side R).
- **`public/webr/`** (~65 MB WebR bundle): **delete**. Removes the biggest chunk of the package and
  the slow first-run WebR boot.
- **`public/manifest.json`**:
  - remove the `web_accessible_resources` entry exposing `webr/*`;
  - drop `'wasm-unsafe-eval'` from `content_security_policy.extension_pages` (no WASM anymore →
    `"script-src 'self'; object-src 'self'"`);
  - bump `version`.
- **`src/popup.ts` / `popup.html`**: remove the "R libraries" editor and the "r sandbox" health row
  (the user-editable package list is meaningless once R runs server-side with a fixed image). Keep
  the AI-tutor/license rows.
- **`src/packages.ts`**: delete or repurpose (only referenced by the popup R-library UI).

Net: the extension is a thin question-scraper + answer-renderer again; ~65 MB smaller; no `wasm-unsafe-eval`.

---

## 5. Cost estimate (Cloud Run only)

**Assumptions (deliberately pessimistic):** every active user maxes the 5 solves/day free cap;
~25% of solves actually need R execution (from this session's coverage analysis: ~71% of questions
need *zero* execution, ~26% need real R); each R run ≈ 2s CPU on 1 vCPU + 2 GiB. Cloud Run free
tier/month ≈ 180,000 vCPU-s, 360,000 GiB-s, 2M requests. (Verify current rates at
`cloud.google.com/run/pricing` before relying on this.)

| Scale | R runs/mo (pessimistic) | vCPU-s | GiB-s | Cloud Run cost |
|---|---|---|---|---|
| **500 users** | ~19,000 | ~38,000 (of 180k free) | ~76,000 (of 360k free) | **$0** (within free tier) |
| **5,000 users** | ~190,000 | ~380,000 → ~200k billable | ~760,000 → ~400k billable | **≈ $5–15/mo** |

- **Scale-to-zero = $0 at rest.** The only way to pay more is keeping instances warm: `--min-instances 2`
  for snappy quiz-burst starts adds roughly **$10–30/mo** depending on CPU-allocation settings. Start
  at `min-instances 0`; add warm instances only if cold-start latency during real quizzes is a problem.
- **Reality is far below pessimistic** (not every user is active daily at the cap) — expect **$0** at
  500 and **single-digit dollars** at 5,000.
- **Perspective:** this is a rounding error next to the **Gemini** bill (the real COGS, already bounded
  by the `/api/solve` rate limits + kill switch). Don't over-optimize the R host.

---

## 6. Rollout sequence (order matters)

The new Worker changes the `/api/solve` calc response (final answer instead of `rcode`) and removes
`/api/interpret`, so an **old** extension build would break against a **new** Worker. Sequence:

1. **Deploy the Cloud Run service** first — it just sits idle with no traffic. Smoke-test `POST /runR`
   with a couple of the `evals/solve-fixtures-calc/` R snippets.
2. **Deploy the Worker** (`wrangler deploy`) with `R_RUNNER_URL` + `R_RUNNER_SECRET` set, **and** ship
   the updated extension build **together**. The extension isn't on the Web Store yet and distribution
   is limited, so the coupling window is low-risk — but don't deploy the Worker hours before the
   extension.
3. Keep the old Worker one `wrangler rollback` away until the new path is confirmed on real questions.

> If you ever need a zero-downtime cutover with users on mixed extension versions, have the Worker
> temporarily support BOTH: return `rcode` when the request signals an old client, final answer
> otherwise. Not needed at current scale.

---

## 7. Risks & caveats

- **Cold starts on bursts.** 50 simultaneous solves from a cold service = up to 50 container starts
  (~1–2s each for native R). Mitigate with `--min-instances`, or accept a ~2s wait on the first few.
  WebR-in-Node cold starts are much worse (10–60s) — another reason to use native R.
- **R output parity.** Native R may format slightly differently than browser WebR (package versions,
  print widths). The **interpret pass reads the output and writes the answer**, so minor formatting
  drift is absorbed — but re-run the eval fixtures and confirm answers still match before cutover.
- **Added server latency on calc.** Calc now does R + (maybe repair) + interpret server-side before the
  student sees anything (~2–6s), vs. today streaming rcode immediately. But it *removes* the ~15s
  client WebR boot, so net first-answer time is usually **better**. Concept questions are unaffected
  (still fast/streamed).
- **Data file size.** CSVs are POSTed to Cloud Run per calc request. Fine at current caps (8 MB total,
  `popup.ts`), but this is the one place a payload-size cap on `/api/solve` (a separate audit warning)
  is worth adding.
- **Region.** Put Cloud Run near the Worker's traffic and near Gemini's endpoint to minimize round-trip
  latency; `us-central1` is a safe default.

---

## 8. File-by-file checklist

**New**
- `r-runner/Dockerfile`, `r-runner/plumber.R` — the Cloud Run service.
- `apps/workers/src/lib/r-runner.ts` — `runRRemote` + `dataPreamble` (port from `sandbox.ts`).

**Change**
- `apps/workers/src/routes/solve.ts` — calc branch calls `runRRemote` + repair + interpret; emit final answer.
- `apps/workers/src/types.ts` — add `R_RUNNER_URL`, `R_RUNNER_SECRET` to `Env`.
- `apps/workers/wrangler.toml` — add `R_RUNNER_URL` var; `wrangler secret put R_RUNNER_SECRET`.
- `apps/workers/src/index.ts` — unregister the interpret route.
- `apps/extension/src/content.ts` — delete rcode branch, WebR call, `/api/interpret` fetch.
- `apps/extension/public/manifest.json` — drop `wasm-unsafe-eval` + `webr/*` WAR; bump version.
- `apps/extension/src/popup.ts` / `popup.html` — remove R-libraries + r-sandbox UI.

**Delete**
- `apps/workers/src/routes/interpret.ts`, `apps/workers/src/lib/interpret-token.ts`.
- `apps/extension/src/webr-runner.ts`, `apps/extension/public/webr/`, `apps/extension/src/packages.ts`.

**Reference only (copy from, don't ship)**
- `apps/api/lib/solver/non-streaming.ts`, `apps/api/lib/solver/r-repair.ts`, `apps/api/lib/sandbox.ts`,
  `scripts/webr-eval-server.cjs`.

---

## 9. Verification

- Cloud Run: `curl -H "X-Runner-Secret: …" -d '{"code":"print(t.test(1:10, 2:11))"}' …/runR` returns stdout.
- Worker: `pnpm --filter @statshelpr/workers exec tsc --noEmit`; `wrangler deploy --dry-run`.
- End-to-end: run the calc eval fixtures against the new runner and confirm answers match the
  `expected` field (no accuracy regression).
- Extension: `pnpm build:extension`; load unpacked; solve one concept + one calc question on a real
  Canvas quiz; confirm no `webr/` requests and no `wasm-unsafe-eval` in the manifest.
- Policy: confirm the shipped `dist/` contains no interpreter executing server-sent code — the only
  thing crossing the wire to the extension is the final answer text.
