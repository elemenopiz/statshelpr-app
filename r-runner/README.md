# r-runner

A small Cloud Run HTTP service that executes R scripts on behalf of the
statshelpr Worker (`apps/workers`), replacing in-browser WebR execution. See
`docs/cloud-run-r-migration.md` section 2 for the full design and rationale;
this README covers only how to build, deploy, and operate this service.

## Contract

```
POST /runR
  header: X-Runner-Secret: <secret>
  body:   { "code": "<R script>", "files": [ { "filename": "...", "content": "..." }, ... ] }
  ->      { "stdout": "...", "stderr": "...", "exitCode": 0 | 1, "durationMs": <int> }

GET /health
  -> { "ok": true }   (no secret required)
```

`code` arrives already wrapped by the Worker (`options(warn = 1)`,
`options(width = ...)`, `set.seed(...)`, and a data-file preamble that loads
each uploaded CSV into a variable named after its filename stem — see
`dataPreamble()` in `apps/api/lib/sandbox.ts`). `plumber.R` runs it verbatim;
it never re-wraps or otherwise mutates it.

Both endpoints carry `@parser text`, which stops plumber from attempting its
own automatic JSON parse of the body before the handler runs. That's not
just tidiness: plumber's default parsers otherwise run unconditionally as
part of its endpoint dispatch, outside of and before this file's own
`tryCatch`-guarded `jsonlite::fromJSON(req$postBody, ...)` call, and a
malformed body made that unconditional step throw past our error handling —
observed directly as an uncaught 500 against a real running instance of this
file, not predicted from reading docs. `@parser none` looks like the more
obvious fix and is what a first pass here used, but it hits a separate,
real bug in the installed `plumber` version's "none" parser registration
(a literal `"*"` handed to `stringi::stri_detect_regex` as a content-type
wildcard, which is invalid regex syntax) — that broke every request, not
just malformed ones. `@parser text` avoids both: no premature JSON
validation, and no wildcard-regex content-type matching.

## Sandbox model

**Assume every script this service runs is hostile.** Not because the model is
malicious, but because of where its input comes from: `POST /api/solve` on the
Worker accepts a free-form `questionText` (the only check is that it is
non-empty — see `apps/workers/src/routes/solve.ts`), a license key is optional
there (`lib/license.ts` returns `ok: true, tier: "free"` for an absent key), and
whatever the model writes is executed here verbatim with its stdout returned to
that same caller as `result.rOutput`. So an anonymous stranger with `curl` can
submit text, have R code generated from it, run it here, and read the output.
The extension's Canvas scraping is a client-side convenience, not a boundary.

Filtering the R for dangerous constructs is NOT the defense and should not be
attempted — R has far too many ways to spell the same operation (`do.call`,
parse-then-evaluate, backtick lookup, `base::` qualification), and the whole
point of the product is to run arbitrary statistical code. The boundary is what
the container HOLDS and what its identity CAN DO:

1. **No usable credential in the process.** `R_RUNNER_SECRET` is reduced to a
   SHA-256 digest at startup and the plaintext is dropped from the process
   environment (see the auth block in `plumber.R` for both leak paths this
   closes and why lexical scoping alone does not close them).
2. **No privileged identity.** The service runs as a dedicated service account
   with no IAM role bindings, so the metadata-server token a script can always
   mint is worth nothing — see the `--service-account` note under "Deploy".

Known and accepted, because they are bounded by the two properties above:

* Scripts have outbound network access (Cloud Run default). With no privileged
  identity and no secret in memory, that buys an attacker a slow, rate-limited
  proxy and nothing else.
* Scripts run in the server process, so a script calling `quit()` ends that
  container early and one that attaches a package leaves it attached for the
  next request in the same warm container. Both were true before this hardening
  and neither exposes data across users (each request still gets a fresh
  `new.env()` and a fresh `tempfile()` workdir). Running each script in a
  throwaway child session via `callr` closes both and was prototyped and
  measured; it costs roughly +0.8s per request on a warm container, because a
  fresh session must re-attach mosaic/tidyverse every time instead of once.
  Deliberately not adopted — revisit if crash isolation becomes worth that.

## Auth model

This service is deployed `--allow-unauthenticated` at the Cloud Run/IAM
level. **The only access control is the `X-Runner-Secret` header**, checked
by the `auth` filter in `plumber.R`. This is a deliberate correction to the
migration doc's original draft, which specified `--no-allow-unauthenticated`
— that would require the caller to present a Google-signed OIDC identity
token, which the Worker does not (and, at launch, has no easy way to)
produce. With `--no-allow-unauthenticated`, every legitimate request from the
Worker would be rejected by IAM before it ever reached `plumber.R`.

**Future hardening path:** once it's worth the operational complexity, switch
to `--no-allow-unauthenticated` and have the Worker mint a Google-signed OIDC
identity token per request (e.g. via a service account and
`iam.serviceAccounts.signJwt`, or the Workers-side `google-auth-library`
equivalent), verified automatically by Cloud Run/IAM before the request
reaches this container. That removes the shared secret as a standing,
copyable credential. Not needed to launch — the shared secret is fine for
current scale (see `docs/cloud-run-r-migration.md` section 5).

## Deploy

```bash
# from r-runner/
gcloud run deploy statshelpr-r-runner \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --service-account statshelpr-r-runner@PROJECT_ID.iam.gserviceaccount.com \
  --concurrency 1 \
  --cpu 1 --memory 2Gi \
  --min-instances 0 --max-instances 50 \
  --timeout 30s \
  --set-env-vars "R_RUNNER_SECRET=$(openssl rand -hex 32)"
```

**`--service-account` is REQUIRED — do not omit it.** Omitting it runs this
service as the project's DEFAULT COMPUTE service account, which conventionally
carries `roles/editor` on the whole project. This container executes
model-authored R code (see "Sandbox model" below), and any code running here
can read the GCP metadata server to mint an OAuth token for whatever identity
the service runs as:

```
http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token
```

With the default account that token is broad project access — enough to create
billable resources. Create a dedicated account with NO role bindings at all
(this service calls no Google APIs, so it needs none):

```bash
gcloud iam service-accounts create statshelpr-r-runner \
  --display-name="statshelpr R runner (intentionally no IAM roles)"
```

Grant it nothing. If a future change makes this service need a Google API,
grant that one narrow role here rather than reaching for the default account.

This corrects the migration doc's `--no-allow-unauthenticated` to
`--allow-unauthenticated` per "Auth model" above — everything else matches
the doc's original config. Grab the printed service URL
(`https://statshelpr-r-runner-xxxx.run.app`) and set it as `R_RUNNER_URL` in
the Worker's environment; put the same secret value in the Worker's
`R_RUNNER_SECRET` (`wrangler secret put R_RUNNER_SECRET`).

**`--concurrency 1` is a correctness requirement here, not just a
performance knob.** `plumber.R` isolates each request's data files with a
per-request `tempfile()` workdir, but does so via a single process-global
`setwd()` (see `plumber.R`'s `/runR` handler) — safe only because Cloud Run
guarantees at most one request is being handled inside a given container at
a time when concurrency is 1. Raising `--concurrency` above 1 without
changing that isolation strategy would let one request's working directory
leak into another's.

**Memory:** `2Gi` mirrors the migration doc's conservative starting point —
tidyverse plus mosaic/moderndive/infer loaded is memory-heavy. The doc notes
`1Gi` may suffice; treat that as untested until it's been through a real
load test (a few concurrent classes' worth of quiz-solve bursts), not as a
default to switch to blind.

## Cold starts

Native R in this image starts in roughly 1–2 seconds. A burst of many
simultaneous solves hitting a fully cold service (nothing warm) means that
many container starts in parallel — each individual request still only waits
on its own container's ~1–2s start, but `--min-instances 0` means the very
first requests after an idle period all pay that cost. If cold-start latency
during a known quiz window becomes a real problem, raise `--min-instances`
(e.g. to 2) — this trades a small always-on cost (see
`docs/cloud-run-r-migration.md` section 5) for instant starts. Leave it at 0
until that's actually observed to matter.

## Smoke test

```bash
R_RUNNER_URL=https://statshelpr-r-runner-xxxx.run.app \
R_RUNNER_SECRET=<the secret from the deploy step above> \
./smoke-test.sh
```

Exercises `/health`, a `t.test` run, a data-file run (writes a tiny CSV,
reads it back by its filename stem, checks the computed mean appears in
`stdout`), an R-error run (checks `exitCode: 1` and non-empty `stderr`), and
a wrong-secret request (checks `403`). Prints `PASS`/`FAIL` per case and
exits non-zero if anything failed. Requires only `curl` and standard POSIX
shell tools — `jq` is not required.

## Rotating the secret

1. Generate a new value: `openssl rand -hex 32`.
2. Update Cloud Run: `gcloud run services update statshelpr-r-runner --region us-central1 --set-env-vars "R_RUNNER_SECRET=<new value>"`.
3. Update the Worker to match: `wrangler secret put R_RUNNER_SECRET`, then redeploy the Worker.

Steps 2 and 3 are not atomic — there's a brief window where the two sides
disagree and `/runR` calls will 403 until the Worker's redeploy lands. At
current scale (see `docs/cloud-run-r-migration.md` section 5) that's an
acceptable short blip; do it during low-traffic hours. If that ever stops
being acceptable, the fix is to have the `auth` filter accept either of two
valid secrets during a rotation window, not to try to make the two deploys
atomic.

## Known limitations

- **Package state persists across requests on a warm container.** A script's
  `library(...)` calls attach packages to the R session's search path, which
  is process-global, not request-scoped — unlike the per-request `tempfile()`
  workdir, this is not (and cannot cheaply be) reset between requests on the
  same warm container. In practice this is low-risk: the fixed, known set of
  packages these scripts use (tidyverse, mosaic, moderndive, infer, broom,
  ggplot2, openssl, base64enc) are designed to layer on top of each other
  (mosaic/moderndive/infer are part of the same teaching-tools ecosystem
  built on tidyverse), so name-masking surprises across requests are
  unlikely — but it's a real characteristic of the R session model worth
  knowing about if output ever looks subtly dependent on request order.
- **`plumber.maxRequestSize` is left at its default (`0` = unlimited)** —
  see the comment in `plumber.R`. If very large payloads ever become a
  concern, that's the option to set, not something to solve by adding a
  reverse proxy in front.

## What was actually verified, and what's still open until a real deploy

This machine has no Docker, but — despite the brief for this work assuming
otherwise — it does have a working R (4.5.2, not the image's 4.4.3, and not
inside a container). Given that, verification went well beyond reading:

- `run_r_code()`, the `auth` filter, and the `/health`/`/runR` handler bodies
  were extracted verbatim from `plumber.R` and run against real R directly
  (no mocking of R itself), with ~85 assertions covering every branch of the
  stdout/stderr/exitCode decision tree, multi-statement scripts with
  embedded newlines, autoprint vs. invisible-assignment behavior,
  environment isolation from this file's own internals (confirmed a script
  genuinely cannot see `RUNNER_SECRET` or this file's other locals), warning/
  message buffering and continuation, a realistic `mosaic`/`do()`/`resample()`
  bootstrap script matching the shape of real captures in `evals/_debug/`,
  path-traversal filenames, malformed JSON, and back-to-back calls confirming
  isolated, cleaned-up temp workdirs.
- `plumber` itself turned out to be installable from CRAN here (most of its
  dependencies, e.g. `httpuv`, were already present). That made it possible
  to run the **actual, unmodified `plumber.R`** as a real HTTP server on
  localhost and run the **actual, unmodified `smoke-test.sh`** against it —
  full pass — plus additional manual `curl` checks: the exact `unboxedJSON`
  response shape (bare scalars, not arrays), a missing (not just wrong)
  secret header, an empty body, a multi-byte UTF-8 CSV round-tripping intact
  through JSON → `writeBin` → `read.csv` → response, and two back-to-back
  real requests confirming request B genuinely cannot see request A's data
  file on disk.
- That live server caught two real bugs no amount of reading would have
  surfaced: a malformed JSON body triggering plumber's own unconditional
  pre-parse into an uncaught 500 instead of this file's intended 400, and
  the "obvious" fix (`@parser none`) hitting a separate real bug in the
  installed `plumber` version (an invalid wildcard regex in that parser's
  own content-type matching, which broke *every* request, not just
  malformed ones). Both are described in detail in "Contract" above, at the
  `@parser text` line — the fix that was actually shipped, verified against
  the same live server.
- `rocker/tidyverse`'s published tags were checked via Docker Hub's API.

Specifically still open until the first real `gcloud run deploy`:

- The Docker **build** itself: that `rocker/tidyverse:4.4.3` actually builds
  cleanly with `mosaic` / `moderndive` / `infer` layered on top (these have
  larger dependency trees than the base image's own packages), on R 4.4.3
  specifically rather than the 4.5.2 tested against here, and on whatever
  `plumber` version that image's `install.packages()` call resolves to
  (unpinned, so potentially newer than the one tested here — the `@parser
  none` bug found above is exactly the kind of thing worth a quick smoke
  test against after any `plumber` version bump).
- The exact byte-for-byte stdout formatting native R produces for real
  `evals/solve-fixtures-calc/`-style scripts, compared against
  `scripts/webr-eval-server.cjs`'s WebR output (`docs/cloud-run-r-migration.md`
  section 7 flags this as expected-but-to-be-confirmed drift, absorbed by
  the downstream LLM interpret pass).
- Real cold-start timing and memory headroom at `2Gi` under load.
- Everything above ran on macOS/arm64 with a localhost TCP connection, not
  Linux inside a container behind Cloud Run's networking/proxying — that
  layer is unavoidably new at first deploy.
