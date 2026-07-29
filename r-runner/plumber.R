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
  result
}
