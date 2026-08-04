# r-runner/plumber.R
#
# The Cloud Run "R runner" service: executes an already-wrapped R script on
# behalf of the Cloudflare Worker and returns its captured output. See
# docs/cloud-run-r-migration.md section 2 for the full design, and
# apps/api/lib/sandbox.ts (runRViaWebr / dataPreamble) for the client-side
# contract this implements the server half of.
#
# Contract (pinned):
#   POST /runR
#     header: X-Runner-Secret: <secret>
#     body:   { "code": "<R script, already wrapped by the Worker>",
#               "files": [ { "filename": "...", "content": "..." }, ... ] }
#     ->      { "stdout": "...", "stderr": "...", "exitCode": 0|1, "durationMs": N }
#   GET /health
#     -> { "ok": true }     (EXEMPT from auth -- see "@preempt auth" below)
#
# The Worker sends `code` already wrapped with options(warn=1)/options(width=...)/
# set.seed()/the data-file preamble (mirroring sandbox.ts's dataPreamble()).
# This file must run `code` verbatim -- it never re-wraps or otherwise mutates it.

library(plumber)

# --- Auth -------------------------------------------------------------------
# Shared-secret header auth. Cloud Run itself is deployed --allow-unauthenticated
# (the Worker has no Google identity token to send -- see README.md "Auth
# model"), so this header is the ONLY access gate. Fails CLOSED: an unset/empty
# R_RUNNER_SECRET denies every request, rather than accidentally letting through
# a request whose header also happens to be empty/missing.
#
# SECURITY -- the secret is stored ONLY as a SHA-256 digest, and the plaintext
# is dropped from the process environment immediately (see README.md "Sandbox
# model"). Both steps matter, because the scripts this service runs are written
# by an LLM from attacker-controllable text: apps/workers/src/routes/solve.ts
# accepts an arbitrary `questionText` over a public, license-optional endpoint,
# feeds the model's output here verbatim, and returns our stdout to that same
# caller as `result.rOutput`. Any script must therefore be assumed hostile and
# actively hunting for credentials, with a channel to print what it finds.
#
# This service only ever VERIFIES the secret -- it never has to send it
# anywhere (the Worker is the one that presents it) -- so a digest is
# sufficient, and it is the only form worth keeping in memory here.
#
# An earlier revision reasoned that a plaintext RUNNER_SECRET was already
# unreachable because plumber runs this file's top level in an environment that
# is a SIBLING of each script's `new.env(parent = globalenv())`, not an
# ancestor. True, but it covers only one of the two ways a script can reach a
# value it cannot name lexically:
#   1. Sys.getenv("R_RUNNER_SECRET") reads the OS process environment and
#      ignores R's lexical scoping entirely. Closed by the Sys.unsetenv below.
#   2. R's call-stack reflection -- environment(sys.function(n)) on a CALLING
#      frame -- reaches this file's environment without resolving any name
#      lexically. NOT closed by scoping, and not closable by it. Closed here by
#      making the reachable value a digest: an attacker who walks the stack
#      gets a SHA-256 hash they cannot present as a header and cannot invert.
# Storing the plaintext would leave (2) wide open no matter where it is bound.
.secret_digest <- local({
  plaintext <- Sys.getenv("R_RUNNER_SECRET")
  # Preserve the fail-closed contract: with no secret configured there is no
  # digest, and digest_matches() below denies every request.
  if (!nzchar(plaintext)) NULL else openssl::sha256(charToRaw(plaintext))
})
Sys.unsetenv("R_RUNNER_SECRET")

# Constant-time-ish comparison of two fixed-length digests. Comparing hashes
# rather than plaintexts also removes any length/prefix signal a naive
# identical() on the raw secrets would leak.
digest_matches <- function(supplied) {
  if (is.null(.secret_digest) || !is.character(supplied) || length(supplied) != 1L) return(FALSE)
  identical(openssl::sha256(charToRaw(supplied)), .secret_digest)
}

# --- Request size -------------------------------------------------------------
# plumber.maxRequestSize defaults to 0, which plumber's own docs define as
# "unlimited" ("Maximum length in bytes of request body. ... `0` means
# unlimited size. Defaults to `0`." -- R/options_plumber.R in the plumber
# source, confirmed 2026-07). CSVs up to ~8MB total ride in the JSON body (see
# docs/cloud-run-r-migration.md section 7, "Data file size"), well within any
# sane per-instance memory budget, so the unlimited default is left as-is
# rather than overridden with options(plumber.maxRequestSize = ...).

# --- Execution ----------------------------------------------------------------
# Run one already-wrapped R script and capture its output using the same
# stdout/stderr/exitCode decision tree as scripts/webr-eval-server.cjs's
# runR()/formatCaptureOutput(), so the repair loop + interpret pass (tuned
# against that sidecar's output) see an identical shape from native R:
#
#   * printed output (print()/cat()/autoprint of visible top-level results)
#     accumulates as `stdout`.
#   * warning()/message() conditions are buffered into `stderr` as
#     "warning: <msg>" / "message: <msg>", mirroring the sidecar's
#     formatCaptureOutput() prefixes. These are caught with
#     withCallingHandlers() and immediately muffled (execution continues) --
#     never with tryCatch(), so one warning can't abort the rest of the script.
#   * a terminal error (caught with tryCatch()) produces:
#       stdout   = trimmed printed output + "\n" + error text, combined
#                  (or "R error" if both are empty)
#       stderr   = the error text alone
#       exitCode = 1
#   * no error, non-empty stdout -> exitCode 0, stdout/stderr returned as captured
#   * no error, empty stdout, non-empty stderr -> stdout becomes the stderr
#     text, exitCode 1
#   * no error, both empty -> exitCode 0, both ""
#
# Autoprint is intentionally ON here (every visible top-level result gets
# printed, like typing each line at a console), where the WebR sidecar this
# mirrors runs with autoprint OFF (captureR's withAutoprint: false). That's a
# deliberate superset, not a bug: models normally print()/cat() explicitly, so
# autoprint only ever adds extra output for the downstream LLM interpret pass
# to (harmlessly) ignore -- it never removes output the sidecar would have
# produced.
run_r_code <- function(code) {
  stderr_lines <- character(0)
  had_error <- FALSE
  error_text <- ""

  # local = new.env(parent = globalenv()) gives the script access to base R
  # and any attached packages (via .GlobalEnv's own search-path parent,
  # always present) while isolating it from this function's own locals
  # above. Concretely: plumber's own pr() runs this whole file's top level in
  # new.env(parent = .GlobalEnv) (see ?plumber::pr), a *sibling* of the
  # environment below, not an ancestor of it -- so RUNNER_SECRET and this
  # function's locals are unreachable from the script by ordinary lookup,
  # without needing any extra isolation of our own.
  #
  # echo = FALSE keeps the script's own source lines out of the captured
  # output; print.eval = TRUE still auto-prints each visible top-level
  # result, same as typing the lines at a console one at a time.
  stdout_lines <- capture.output(
    withCallingHandlers(
      tryCatch(
        {
          source(
            textConnection(code),
            local = new.env(parent = globalenv()),
            echo = FALSE,
            print.eval = TRUE
          )
          invisible(NULL)
        },
        error = function(e) {
          had_error <<- TRUE
          error_text <<- conditionMessage(e)
          stderr_lines <<- c(stderr_lines, paste0("error: ", conditionMessage(e)))
          invisible(NULL)
        }
      ),
      warning = function(w) {
        stderr_lines <<- c(stderr_lines, paste0("warning: ", conditionMessage(w)))
        invokeRestart("muffleWarning")
      },
      message = function(m) {
        msg <- sub("\n+$", "", conditionMessage(m))
        stderr_lines <<- c(stderr_lines, paste0("message: ", msg))
        invokeRestart("muffleMessage")
      }
    ),
    type = "output"
  )
  # capture.output() carries its own internal on.exit(sink(); close(file)),
  # so the "output" sink it opens above is guaranteed to be torn down even if
  # something inside throws in a way that isn't a normal R "error" condition
  # -- there is nothing left for this function to clean up itself.

  stdout_text <- paste(stdout_lines, collapse = "\n")
  stderr_text <- paste(stderr_lines, collapse = "\n")

  if (had_error) {
    parts <- Filter(nzchar, c(trimws(stdout_text), error_text))
    combined <- paste(parts, collapse = "\n")
    if (!nzchar(combined)) combined <- "R error"
    return(list(stdout = combined, stderr = error_text, exitCode = 1L))
  }

  if (nzchar(trimws(stdout_text))) {
    return(list(stdout = stdout_text, stderr = stderr_text, exitCode = 0L))
  }
  if (nzchar(trimws(stderr_text))) {
    return(list(stdout = stderr_text, stderr = stderr_text, exitCode = 1L))
  }
  list(stdout = "", stderr = "", exitCode = 0L)
}

# --- On-demand package installs ------------------------------------------------
# A customized user's `packages` selection (the extension's library picker,
# apps/extension/src/r-packages.ts) can name a package that is NOT baked into
# this image (the fixed catalog in r-runner/Dockerfile). Rather than failing
# outright, install it here on demand -- bounded so this NEVER touches the
# default preset's behavior (no `packages` field in the request -- see the
# `/runR` handler's `if (!is.null(body$packages))` gate below, which skips
# this entire section, not just "installs nothing") and NEVER risks the
# Cloud Run request timeout (README.md's Deploy section -- 180s, raised from
# 30s specifically for this feature). This phase gets its own <=90s budget,
# well clear of that ceiling; script EXECUTION (run_r_code above) keeps
# exactly the timeout budget it always had -- implicitly bounded by the
# outer Cloud Run request timeout, unchanged by this feature.

# Grammar mirrors apps/workers/src/lib/metrics-store.ts's
# MISSING_R_PACKAGE_NAME_RE / packages/solver-core's system-prompt.ts
# sanitizePackageNames -- independently re-validated HERE too (never trust
# the Worker layer alone, same stance the rest of this file takes on the
# request body) since a validated name is about to build a child-process
# command line and an install.packages() call -- the most consequential
# place in this entire file for an unsanitized string to reach.
PACKAGE_NAME_RE <- "^[A-Za-z][A-Za-z0-9.]{0,40}$"
MAX_REQUESTED_PACKAGES <- 15L      # matches the Worker's own MAX_PACKAGES cap (routes/solve.ts)
MAX_MISSING_TO_INSTALL <- 10L      # more than this and we skip installing entirely -- see the handler below
INSTALL_BUDGET_SECS <- 90          # whole-phase ceiling; see README's 180s Cloud Run timeout
MIN_INSTALL_SLICE_SECS <- 2        # don't bother spawning a child for a sliver of leftover budget

# Dedicated writable library, prepended AHEAD of the image's read-only system
# library (rocker's baked-in catalog lives under R_HOME/library, and even if
# it happened to be writable at runtime, installing into it would blur the
# line between "baked into the image" and "installed on demand" that the
# Dockerfile's own catalog comment relies on). tempdir() resolves to a
# directory under Cloud Run's in-memory writable filesystem and is stable for
# the life of this container/process -- so a package installed for one
# request is still on .libPaths() for the NEXT request on the same warm
# container, the same warm-container-reuse characteristic README.md's "Known
# limitations" section already documents for library() state.
#
# MEMORY TRADEOFF: Cloud Run's writable filesystem is RAM-backed (see
# README.md's Memory note on the 2Gi instance size), so every byte installed
# here is a byte off the same budget the already-loaded tidyverse/mosaic/
# moderndive/infer stack draws from. Fine for a handful of small on-demand
# packages; worth revisiting if usage ever pushes many/large packages onto
# one warm container.
.runtime_lib_dir <- file.path(tempdir(), "runtime-r-libs")
dir.create(.runtime_lib_dir, showWarnings = FALSE, recursive = TRUE)
.libPaths(c(.runtime_lib_dir, .libPaths()))

#' Validate + cap a raw `packages` request field. Ignores invalid entries
#' rather than failing the request (matches this file's existing stance on
#' malformed sub-fields -- e.g. a bad `files` entry above is skipped, not
#' fatal): the request as a whole must never 400 just because one requested
#' package name was junk. jsonlite::fromJSON(..., simplifyVector = FALSE)
#' parses a JSON array into a `list`, one element per array entry, each
#' still its own native type (a crafted body could send numbers/objects, not
#' just strings) -- the vapply below coerces anything that isn't a single
#' character string to NA and drops it before the regex ever sees it.
#' Verified directly against real R (see the worktree's scratch smoke test
#' referenced in this branch's commit message): non-string entries, regex-
#' invalid names (spaces, semicolons, leading dashes/digits, backticks,
#' path-traversal, shell metacharacters), duplicates, the >41-char case, and
#' the >15-names cap all behave as documented here.
validate_package_names <- function(pkgs) {
  if (is.null(pkgs) || length(pkgs) == 0) return(character(0))
  chars <- vapply(
    pkgs,
    function(p) if (is.character(p) && length(p) == 1L) p else NA_character_,
    character(1)
  )
  chars <- chars[!is.na(chars)]
  valid <- unique(chars[grepl(PACKAGE_NAME_RE, chars)])
  if (length(valid) > MAX_REQUESTED_PACKAGES) valid <- valid[seq_len(MAX_REQUESTED_PACKAGES)]
  valid
}

#' Which of `names` (already validated) are not currently loadable from
#' .libPaths() -- either the system catalog (r-runner/Dockerfile) or a
#' previous request's runtime install still resident on this same warm
#' container. quietly=TRUE matches this file's existing preference for
#' silence from anything that isn't the script's own captured output (see
#' run_r_code's doc above).
missing_package_names <- function(names) {
  if (length(names) == 0) return(character(0))
  names[!vapply(names, requireNamespace, logical(1), quietly = TRUE)]
}

#' Install `names` (already validated + already confirmed missing) from the
#' image's configured binary repo (Dockerfile's site Rprofile -- Posit
#' Package Manager, binary-only; NEVER remotes/GitHub/arbitrary-URL installs)
#' into .runtime_lib_dir, inside a shared `budget_secs` wall-clock ceiling
#' that this function guarantees is never exceeded by more than the last
#' package's own per-call overhead.
#'
#' REAL timeout, deliberately NOT R's setTimeLimit(): setTimeLimit() only
#' interrupts evaluation at R-level bytecode steps and does NOT interrupt a
#' blocked system call -- confirmed directly against this R (4.5.2) while
#' building this function: a 1s elapsed limit failed to stop a 3s
#' Sys.sleep(), but DID stop a pure R-level busy loop after ~1s.
#' install.packages() spends nearly all of its time inside exactly the kind
#' of blocking C-level network I/O setTimeLimit() cannot see, so it would
#' silently fail to bound a stalled download -- precisely the hang this
#' function exists to make impossible. Each package installs in its OWN
#' child `Rscript` process via system2(..., timeout=), enforced by the OS
#' killing the child process after the given number of seconds regardless of
#' what it's blocked on (confirmed: system2(timeout=1) against a 3s `sleep`
#' returned status 124, a warning, and control back to the caller at ~1.0s,
#' not 3s) -- that OS-level guarantee is what makes "the whole install phase
#' in the <=90s budget" actually true rather than aspirational.
#'
#' The child is invoked WITHOUT --vanilla: --vanilla implies --no-site-file,
#' which would skip loading Rprofile.site -- exactly where the Dockerfile
#' configures the P3M binary repo this function relies on. Confirmed
#' directly: with --vanilla a site file's options(repos=...) never took
#' effect (repos stayed the unset "@CRAN@" placeholder); with
#' --no-save --no-restore --no-init-file --no-environ (site file NOT
#' suppressed) it did. Package names are shQuote()'d before being embedded
#' in the child's `-e` expression, then that whole expression is shQuote()'d
#' again as the argument system2() hands to the shell -- confirmed
#' necessary: system2() does NOT auto-quote args elements, so an
#' unquoted ";" in a value would be read as a shell command separator. Belt-
#' and-suspenders here since PACKAGE_NAME_RE already forbids every character
#' that would matter, but this is the single most sensitive string-assembly
#' point in the file, so it gets the same "never trust the previous layer
#' alone" treatment as everything else in this section.
#'
#' Never throws -- a per-package failure or the shared budget running out
#' both log one structured line and move on, same contract as every other
#' best-effort corner of this file (metrics-shaped logging, not control
#' flow). Returns list(installed = character(...), failed = character(...)).
install_missing_packages <- function(names, budget_secs = INSTALL_BUDGET_SECS) {
  installed <- character(0)
  failed <- character(0)
  if (length(names) == 0) return(list(installed = installed, failed = failed))

  rscript_bin <- file.path(R.home("bin"), "Rscript")
  deadline <- Sys.time() + budget_secs
  for (name in names) {
    remaining <- as.numeric(difftime(deadline, Sys.time(), units = "secs"))
    if (remaining < MIN_INSTALL_SLICE_SECS) {
      message(sprintf("[r-runner-install] package=%s outcome=budget-exhausted", name))
      failed <- c(failed, name)
      next
    }

    child_expr <- sprintf(
      "install.packages(%s, lib = %s, repos = getOption(\"repos\"), quiet = TRUE, Ncpus = 1)",
      shQuote(name), shQuote(.runtime_lib_dir)
    )
    status <- tryCatch(
      withCallingHandlers(
        system2(
          rscript_bin,
          args = c("--no-save", "--no-restore", "--no-init-file", "--no-environ", "-e", shQuote(child_expr)),
          stdout = FALSE, stderr = FALSE,
          timeout = as.integer(ceiling(remaining))
        ),
        warning = function(w) invokeRestart("muffleWarning")
      ),
      error = function(e) -1L
    )

    # Ground truth is a fresh requireNamespace() check, not the child's exit
    # status -- install.packages() itself doesn't reliably fail its OWN
    # process's exit code just because one package failed (see the
    # Dockerfile's own comment on this same behavior for the image's build-
    # time install), and a killed-mid-install child can leave a partial,
    # non-loadable package directory behind either way. This also means a
    # SIGKILLed child (status 124) is handled by the SAME check as a clean
    # but unsuccessful one, with the status only used to label WHY in the log.
    if (requireNamespace(name, quietly = TRUE)) {
      installed <- c(installed, name)
      message(sprintf("[r-runner-install] package=%s outcome=installed", name))
    } else {
      outcome <- if (identical(status, 124L)) "timeout" else "failed"
      failed <- c(failed, name)
      message(sprintf("[r-runner-install] package=%s outcome=%s", name, outcome))
    }
  }
  list(installed = installed, failed = failed)
}

# --- Filters ------------------------------------------------------------------

#* @filter auth
function(req, res) {
  supplied <- req$HTTP_X_RUNNER_SECRET
  # digest_matches() folds in the old nzchar(RUNNER_SECRET) fail-closed check:
  # an unset secret leaves .secret_digest NULL, which never matches.
  authorized <- !is.null(supplied) && digest_matches(supplied)
  if (!authorized) {
    res$status <- 403
    return(list(error = "forbidden"))
  }
  plumber::forward()
}

# --- Endpoints ------------------------------------------------------------------

#* Liveness/readiness probe. No secret required.
#* @get /health
#* @preempt auth
#* @serializer unboxedJSON
#* @parser text
function() {
  list(ok = TRUE)
}

#* Run an already-wrapped R script (see contract above) and return its
#* captured stdout/stderr/exitCode/durationMs.
#*
#* This endpoint parses its own body (req$postBody via jsonlite::fromJSON
#* below, inside a tryCatch that turns malformed JSON into a clean 400).
#* The parser tag two lines down turns off plumber's own default parsers
#* (c("json","form","text","octet","multi"); see ?pr_set_parsers), which
#* otherwise also try to parse the body before this function ever runs, as
#* an unconditional step in plumber's endpoint dispatch that is not wrapped
#* in a try of its own. Left at the default, a malformed body throws there
#* instead, past our own tryCatch, and surfaces as an uncaught 500 rather
#* than the intended 400 -- confirmed against a real running instance of
#* this file, not just by reading plumber's source. (Note for future
#* editors: plumber scans every "#*" line for a tag, so don't start an
#* explanatory comment line with "@" the way this paragraph just avoided
#* doing -- it will be parsed as a directive, not read as prose.)
#* @post /runR
#* @serializer unboxedJSON
#* @parser text
function(req, res) {
  start_time <- Sys.time()

  body <- tryCatch(
    jsonlite::fromJSON(req$postBody, simplifyVector = FALSE),
    error = function(e) NULL
  )
  if (is.null(body) || !is.list(body)) {
    res$status <- 400
    return(list(error = "invalid JSON body"))
  }

  code <- body$code
  if (is.null(code) || !is.character(code)) code <- ""

  files <- body$files
  if (is.null(files)) files <- list()

  # On-demand package installs -- ONLY when the request explicitly names
  # packages (a customized picker selection, see apps/extension/src/
  # r-packages.ts). Absent `packages` -- the default-preset path every UT
  # student is on -- never enters this block at all: it is not merely "installs
  # nothing", the block is not even EVALUATED, so the response shape and
  # timing for that path stay byte-identical to before this feature existed.
  # Placed before the workdir switch below so this phase never depends on
  # (or interferes with) the per-request tempfile() isolation the file-upload
  # loop sets up next. See the "On-demand package installs" section above for
  # the full design (validate -> detect-missing -> cap -> install-with-budget).
  install_result <- NULL
  if (!is.null(body$packages)) {
    valid_names <- validate_package_names(body$packages)
    missing <- missing_package_names(valid_names)
    install_result <- if (length(missing) == 0) {
      list(installed = character(0), failed = character(0))
    } else if (length(missing) > MAX_MISSING_TO_INSTALL) {
      # Too many at once to safely fit the shared budget -- install NONE and
      # proceed to script execution. The script will hit R's normal "there is
      # no package called ..." error for whichever it actually library()s/
      # require()s, which routes/solve.ts's extractMissingRPackageNames
      # already parses into the existing missingRPackages telemetry -- so
      # this path is never silent, it just reuses telemetry that already
      # exists rather than needing a new one.
      message(sprintf(
        "[r-runner-install] skipped=%d packages (exceeds cap of %d) -- proceeding without installing",
        length(missing), MAX_MISSING_TO_INSTALL
      ))
      list(installed = character(0), failed = missing)
    } else {
      install_missing_packages(missing, INSTALL_BUDGET_SECS)
    }
  }

  # Per-request isolated workdir: a warm container serves many requests in
  # sequence (never concurrently -- see README.md's --concurrency 1), so a
  # fixed directory would leak one request's data files into the next. Every
  # branch below -- success, R error, or an uncaught failure in this handler
  # itself -- runs through this same on.exit, so the container is always
  # returned to a clean state before it picks up the next request.
  old_wd <- getwd()
  work_dir <- tempfile("run")
  dir.create(work_dir, recursive = TRUE)
  setwd(work_dir)
  on.exit(
    {
      setwd(old_wd)
      unlink(work_dir, recursive = TRUE, force = TRUE)
    },
    add = TRUE
  )

  for (f in files) {
    filename <- f$filename
    if (is.null(filename) || !is.character(filename) || !nzchar(filename)) next
    # Pinned sanitization -- must match the Worker's JS sanitizer exactly
    # (replace(/[^a-zA-Z0-9._-]/g, "_")) so the on-disk name matches what the
    # Worker's read.csv() preamble, already baked into `code`, expects.
    # basename() first is extra defense against a crafted "../" filename
    # escaping the workdir; in normal operation filenames are already bare
    # (no directory separators), so it is a no-op there.
    safe_name <- gsub("[^A-Za-z0-9._-]", "_", basename(filename))
    content <- f$content
    if (is.null(content) || !is.character(content)) content <- ""
    # writeBin(charToRaw(...)) writes the exact bytes of `content`, with no
    # trailing newline appended -- writeLines() would add one, which is
    # cheap-but-real byte drift from what the caller actually sent.
    writeBin(charToRaw(content), safe_name)
  }

  result <- run_r_code(code)
  result$durationMs <- as.integer(round(as.numeric(difftime(Sys.time(), start_time, units = "secs")) * 1000))
  # Only appended when the request had a `packages` field (see the gate
  # above) -- so a default-preset request's response body is byte-identical
  # to before this feature existed, not just functionally equivalent. as.list()
  # so a single-element result serializes as a JSON array (["pwr"]), not a
  # bare scalar, matching @serializer unboxedJSON's array-vs-scalar
  # convention for every other list-valued field in this file.
  if (!is.null(install_result)) {
    result$installedPackages <- as.list(install_result$installed)
    result$installFailed <- as.list(install_result$failed)
  }
  result
}
