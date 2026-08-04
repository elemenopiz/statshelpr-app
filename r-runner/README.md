# r-runner

A small Cloud Run HTTP service that executes R scripts on behalf of the
statshelpr Worker (`apps/workers`), replacing in-browser WebR execution. See
`docs/cloud-run-r-migration.md` section 2 for the full design and rationale;
this README covers only how to build, deploy, and operate this service.

## Contract

```
POST /runR
  header: X-Runner-Secret: <secret>
  body:   { "code": "<R script>", "files": [ { "filename": "...", "content": "..." }, ... ],
            "packages": ["pkg1", "pkg2", ...] }   -- OPTIONAL, see "On-demand package installs" below
  ->      { "stdout": "...", "stderr": "...", "exitCode": 0 | 1, "durationMs": <int>,
            "installedPackages": [...], "installFailed": [...] }  -- last two ONLY present when
                                                                       the request had a `packages` field

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
  --timeout 180s \
  --set-env-vars "R_RUNNER_SECRET=$(openssl rand -hex 32)"
```

**`--timeout 180s`** (raised from 30s) — required for "On-demand package
installs" below: a binary package install can take 5-30s each, and that time
comes ON TOP OF script execution within the SAME request, so the old 30s
ceiling left no room for both. 180s is NOT this service's new normal
latency — it is only the worst-case backstop for a customized request naming
packages the runner doesn't already have; the default preset (no `packages`
field, see that section) never approaches it, and even a packages-request
that installs nothing new returns as fast as it always did. Sized as
install budget (<=90s, `INSTALL_BUDGET_SECS` in `plumber.R`) + script
execution's own pre-existing, still-unbounded-at-the-R-level budget
(implicitly capped by whatever's left of this outer Cloud Run timeout,
exactly as it always was against the old 30s ceiling) + a margin for
request/response overhead — see "On-demand package installs" for the full
budget breakdown.

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

## On-demand package installs

A customized picker selection (the extension's library picker,
`apps/extension/src/r-packages.ts`) can name an R package that isn't baked
into this image's fixed catalog (the `install.packages()` line in
`Dockerfile`). Rather than failing outright, `POST /runR`'s optional
`packages` field lets `plumber.R` install what's missing on demand, before
running the script.

**The default preset is untouched.** A request with no `packages` field —
every UT student who has never opened the picker — never enters this code
path at all: not "installs nothing", the relevant block in `plumber.R`'s
`/runR` handler is gated behind `if (!is.null(body$packages))` and is not
even evaluated, so the response body for that path has no
`installedPackages`/`installFailed` keys and is byte-identical to before
this feature existed (confirmed against a real local `plumber::pr_run()`
instance — see "What was actually verified" below).

**Validation (defense in depth, re-checked at every layer independently):**
the extension's picker validates on save; the Worker's
`routes/solve.ts#validateSolveBody` caps the request at 15 names / 60 chars
each before it ever reaches this service; `plumber.R`'s
`validate_package_names()` re-validates AGAIN against
`^[A-Za-z][A-Za-z0-9.]{0,40}$` (same grammar as
`apps/workers/src/lib/metrics-store.ts`'s `MISSING_R_PACKAGE_NAME_RE`) and
silently drops anything that doesn't match — a malformed name never fails
the request, it just never gets installed (and the script will hit R's own
"there is no package called ..." error for it, same as today).

**Missing-package detection + caps:**
1. Of the validated names, `missing_package_names()` checks which are not
   already loadable via `requireNamespace()` — either not in the image's
   catalog, or (on a warm container) already installed by an earlier
   request. Packages already present cost nothing.
2. If more than 10 are missing, NONE are installed and the script proceeds
   as-is — it will fail with R's normal missing-package error for whichever
   it actually `library()`s/`require()`s, which `routes/solve.ts`'s
   `extractMissingRPackageNames` already parses into the EXISTING
   `missingRPackages` telemetry. This cap exists to bound worst-case latency
   for a request naming many packages at once, not to add a new failure
   mode — the failure it falls back to already existed before this feature.
3. Otherwise, each missing package installs in its own child `Rscript`
   process, sharing one **90-second** wall-clock budget
   (`INSTALL_BUDGET_SECS` in `plumber.R`) across however many are being
   installed. A per-package failure or the shared budget running out both
   log one line (`[r-runner-install] package=<name> outcome=<installed|
   failed|timeout|budget-exhausted>`) to stderr (captured by Cloud Run
   logging) and move on to the next package / to script execution — never a
   hung or crashed request. Installed packages are added to a dedicated,
   writable library directory prepended via `.libPaths()`, ahead of the
   image's read-only system catalog.
4. `/runR`'s response gains `installedPackages`/`installFailed` (string
   arrays, only present when the request had a `packages` field) so the
   Worker can record which names actually became available.

**Why a real (OS-level) timeout, not R's `setTimeLimit()`:** confirmed
directly against a real R session while building this — `setTimeLimit()`
only interrupts evaluation at R-level bytecode steps; it did NOT stop a
blocked `Sys.sleep()` call, but DID stop a pure R-level loop. Since
`install.packages()` spends nearly all its time in exactly the kind of
blocking C-level network I/O `setTimeLimit()` cannot see, it would silently
fail to bound a stalled download. Each install instead runs in a child
`Rscript` process via `system2(..., timeout = <remaining budget>)`, which
the OS kills after that many seconds regardless of what it's blocked on —
confirmed: a `system2(timeout = 1)` call wrapping a 3-second `sleep`
returned control at ~1.0s with status `124`, not 3s.

**Binary-only, official repo only, no exceptions.** `Dockerfile` points this
image's default repos at Posit Package Manager's (P3M) binary CRAN mirror
for the image's Linux codename (resolved from `/etc/os-release` at build
time) — precompiled binaries install in seconds; a source build could take
minutes and blow the install budget, and would need compiler toolchains
this hardening has no reason to assume are still wanted at runtime. This
image NEVER installs from `remotes`/GitHub/an arbitrary URL, at build time
or run time — P3M's CRAN-compatible endpoint is the only repo configured,
anywhere in this image.

**Memory tradeoff:** Cloud Run's writable filesystem is RAM-backed (see
"Memory" above), so every byte a runtime install writes is a byte off the
same `2Gi` budget the already-loaded tidyverse/mosaic/moderndive/infer stack
draws from. Fine for a handful of small on-demand packages on top of that;
worth revisiting if usage ever pushes many/large packages onto one warm
container.

**Egress note:** this feature does not change the runner's network posture.
Model-authored scripts already had outbound network access before this
feature existed (see "Sandbox model" above); a locked-down `repos` option
plus "never remotes/GitHub/URL" is an APPLICATION-level control on what
THIS FILE'S OWN CODE installs from, not a network-level allowlist. A real
egress allowlist would need a VPC connector (~$8-15/mo) and is deliberately
DEFERRED — out of scope for the free-tier-conscious posture this service
currently runs under; revisit if that tradeoff ever changes.

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

**On-demand package installs (this feature, same "verify against real R"
bar):** the same local R (4.5.2) plus a real local `plumber::pr_run()`
instance (not just `parse()`/reading) were used again here.
`validate_package_names()`/`missing_package_names()` were run directly with
~20 assertions (non-string entries, regex-invalid names including shell
metacharacters/path-traversal/backticks, duplicates, the 41-char boundary,
the 15-name cap). The install-phase control flow (shared-budget deadline
math, per-package timeout, structured logging, installed-vs-failed split)
was exercised end-to-end with a real `system2()`/child-`Rscript` harness
standing in for `install.packages()` — including a deliberately-hung child
(`Sys.sleep(30)` inside a 3s budget) that was confirmed KILLED at the budget
boundary rather than run to completion, the specific hang this design exists
to make impossible. `setTimeLimit()` was confirmed NOT to interrupt a
blocked system call (only R-level evaluation) — the reason this uses
`system2(timeout=)` instead. `--vanilla` was confirmed to skip
`Rprofile.site` (via `--no-site-file`) using a real site-file + `R_PROFILE`
env var test, which is why the child install process uses an explicit
`--no-save --no-restore --no-init-file --no-environ` flag set instead. The
generated Dockerfile `Rprofile.site` content (P3M repos URL +
`HTTPUserAgent`) was loaded as a real site profile and confirmed both
options resolve as intended. Finally, the full modified `plumber.R` was
loaded via a real `plumber::pr("plumber.R")` (module-level code executes,
endpoints register) and then run as a real local HTTP server, hit with
`curl` for: no `packages` field (response has no `installedPackages`/
`installFailed` keys at all — the byte-identical default-preset guarantee),
all-invalid-grammar names (silently dropped), an already-installed package
(no-op), a syntactically-valid but not-installed package (clean `failed`
outcome, no hang), a installed+missing mix, and 11 missing names (the >10
cap correctly skips installing anything). All of the above ran without
network access — P3M's actual binary-serving behavior against a real
`rocker/tidyverse` container is NOT verified (see below).

Specifically still open until the first real `gcloud run deploy`:

- The Docker **build** itself: that `rocker/tidyverse:4.4.3` actually builds
  cleanly with `mosaic` / `moderndive` / `infer` layered on top (these have
  larger dependency trees than the base image's own packages), on R 4.4.3
  specifically rather than the 4.5.2 tested against here, and on whatever
  `plumber` version that image's `install.packages()` call resolves to
  (unpinned, so potentially newer than the one tested here — the `@parser
  none` bug found above is exactly the kind of thing worth a quick smoke
  test against after any `plumber` version bump).
- **On-demand installs specifically:** whether `rocker/tidyverse:4.4.3`
  already points at P3M by default (this Dockerfile's new Rprofile.site
  lines take effect regardless, but confirming the base image's OWN default
  would tell you whether they're redundant-but-harmless or load-bearing);
  that the resolved `VERSION_CODENAME` for this exact tag is one P3M
  actually serves binaries for; real install latency for a binary package
  against P3M from a Cloud Run container specifically (network path/latency
  will differ from any local test); and whether `system2(..., timeout=)`'s
  process-group SIGKILL behaves identically inside Cloud Run's container
  runtime as it did in this local, non-containerized test.
- The exact byte-for-byte stdout formatting native R produces for real
  `evals/solve-fixtures-calc/`-style scripts, compared against
  `scripts/webr-eval-server.cjs`'s WebR output (`docs/cloud-run-r-migration.md`
  section 7 flags this as expected-but-to-be-confirmed drift, absorbed by
  the downstream LLM interpret pass).
- Real cold-start timing and memory headroom at `2Gi` under load.
- Everything above ran on macOS/arm64 with a localhost TCP connection, not
  Linux inside a container behind Cloud Run's networking/proxying — that
  layer is unavoidably new at first deploy.
