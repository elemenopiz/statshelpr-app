#!/usr/bin/env bash
# r-runner/smoke-test.sh
#
# Smoke test for a deployed r-runner Cloud Run service. See
# docs/cloud-run-r-migration.md section 9 ("Verification").
#
# Exercises: GET /health (no auth), a t.test run, a data-file run (CSV
# written + read back by its filename stem), an R-error run, and a
# wrong-secret auth check. Prints PASS/FAIL per case and exits non-zero if
# anything failed.
#
# Usage:
#   R_RUNNER_URL=https://statshelpr-r-runner-xxxx.run.app \
#   R_RUNNER_SECRET=<the shared secret> \
#   ./smoke-test.sh
#
# jq is not required (grep is used throughout), but if you have it installed
# `... | jq .` on any of the curl calls below is a nice way to eyeball a
# response body by hand while debugging a failure.

set -euo pipefail

: "${R_RUNNER_URL:?Set R_RUNNER_URL to the deployed Cloud Run service URL}"
: "${R_RUNNER_SECRET:?Set R_RUNNER_SECRET to the shared secret}"

BASE_URL="${R_RUNNER_URL%/}"
PASS_COUNT=0
FAIL_COUNT=0

BODY_FILE="$(mktemp)"
cleanup() {
  rm -f "$BODY_FILE"
}
trap cleanup EXIT

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "PASS: $1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "FAIL: $1"
  echo "      status=$2"
  echo "      body=$3"
}

# Escapes a string for embedding as a JSON string value: backslash and
# double-quote get escaped, and a literal newline becomes a literal two-char
# "\n" escape (JSON strings cannot contain a raw newline byte).
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

# POSTs $2 (already-valid JSON) to path $1 with header X-Runner-Secret: $3.
# Writes the response body to $BODY_FILE and prints the HTTP status code.
post_json() {
  local path="$1" json="$2" secret="$3"
  curl -sS -o "$BODY_FILE" -w '%{http_code}' \
    -X POST "$BASE_URL$path" \
    -H "Content-Type: application/json" \
    -H "X-Runner-Secret: $secret" \
    -d "$json"
}

echo "== r-runner smoke test: $BASE_URL =="

# -- health (no auth required) ------------------------------------------
echo
echo "-- GET /health --"
status=$(curl -sS -o "$BODY_FILE" -w '%{http_code}' "$BASE_URL/health")
body=$(cat "$BODY_FILE")
if [ "$status" = "200" ] && printf '%s' "$body" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
  pass "GET /health -> 200 {ok:true}"
else
  fail "GET /health" "$status" "$body"
fi

# -- t.test case ----------------------------------------------------------
echo
echo "-- t.test --"
json='{"code":"print(t.test(1:10, 2:11))","files":[]}'
status=$(post_json "/runR" "$json" "$R_RUNNER_SECRET")
body=$(cat "$BODY_FILE")
if [ "$status" = "200" ] && printf '%s' "$body" | grep -q "t = "; then
  pass "t.test case -> 200, stdout contains 't = '"
else
  fail "t.test case" "$status" "$body"
fi

# -- data-file case ---------------------------------------------------------
# A tiny inline CSV. The Worker normally prepends a preamble that reads each
# uploaded file into a variable named after its filename stem (see
# dataPreamble() in apps/api/lib/sandbox.ts); this test reproduces that one
# line of preamble itself so it can exercise the runner directly, without
# going through the Worker. "MEAN_RESULT:" is a deliberately distinctive
# label so the assertion below can't accidentally match an unrelated digit
# elsewhere in the JSON response (e.g. durationMs).
echo
echo "-- data file (read nums.csv by stem, print a mean) --"
data_code='nums <- read.csv("nums.csv"); cat("MEAN_RESULT:", mean(nums$x))'
csv_content='x
1
2
3'
json=$(printf '{"code":"%s","files":[{"filename":"nums.csv","content":"%s"}]}' \
  "$(json_escape "$data_code")" "$(json_escape "$csv_content")")
status=$(post_json "/runR" "$json" "$R_RUNNER_SECRET")
body=$(cat "$BODY_FILE")
if [ "$status" = "200" ] && printf '%s' "$body" | grep -Eq 'MEAN_RESULT:[[:space:]]*2'; then
  pass "data-file case -> 200, mean (2) present in stdout"
else
  fail "data-file case" "$status" "$body"
fi

# -- on-demand package install case ------------------------------------------
# Exercises the `packages` field (r-runner/plumber.R's install_missing_packages)
# end to end against the REAL deployed image: "pwr" is a small, dependency-
# light, binary-available CRAN package deliberately NOT in the baked-in
# catalog (Dockerfile), so a fresh container should need to install it here.
# Asserts on ACTUAL SCRIPT BEHAVIOR (does code that needs the package run
# successfully?) rather than on installedPackages/installFailed bookkeeping,
# so this passes whether the runner installed it fresh THIS request or it was
# already resident from an earlier request on the same warm container (see
# README.md's "known limitations" -- package state persists on warm
# containers). The power value is loosely pattern-matched (a decimal between
# 0 and 1) rather than an exact number, since this deliberately runs against
# whatever pwr/R version the deployed image actually resolves, not a version
# pinned in this repo.
echo
echo "-- on-demand package install (pwr, not in the baked-in catalog) --"
pkg_code='library(pwr); r <- pwr.t.test(d = 0.5, n = 20, sig.level = 0.05, type = "two.sample"); cat("POWER_RESULT:", round(r$power, 4))'
json=$(printf '{"code":"%s","files":[],"packages":["pwr"]}' "$(json_escape "$pkg_code")")
status=$(post_json "/runR" "$json" "$R_RUNNER_SECRET")
body=$(cat "$BODY_FILE")
if [ "$status" = "200" ] && printf '%s' "$body" | grep -Eq 'POWER_RESULT:[[:space:]]*0\.[0-9]+'; then
  pass "on-demand install case -> 200, pwr loaded and computed a power value"
else
  fail "on-demand install case" "$status" "$body"
fi

# -- error case -------------------------------------------------------------
echo
echo "-- R error --"
json='{"code":"stop(\"boom\")","files":[]}'
status=$(post_json "/runR" "$json" "$R_RUNNER_SECRET")
body=$(cat "$BODY_FILE")
has_exit_1=$(printf '%s' "$body" | grep -Eq '"exitCode"[[:space:]]*:[[:space:]]*1' && echo yes || echo no)
has_nonempty_stderr=$(printf '%s' "$body" | grep -Eq '"stderr"[[:space:]]*:[[:space:]]*""' && echo no || echo yes)
if [ "$status" = "200" ] && [ "$has_exit_1" = "yes" ] && [ "$has_nonempty_stderr" = "yes" ]; then
  pass "error case -> exitCode 1, non-empty stderr"
else
  fail "error case" "$status" "$body"
fi

# -- auth case (wrong secret) ------------------------------------------------
echo
echo "-- wrong secret --"
json='{"code":"print(1)","files":[]}'
status=$(post_json "/runR" "$json" "definitely-the-wrong-secret")
body=$(cat "$BODY_FILE")
if [ "$status" = "403" ]; then
  pass "wrong secret -> 403"
else
  fail "wrong secret" "$status" "$body"
fi

echo
echo "== $PASS_COUNT passed, $FAIL_COUNT failed =="
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
