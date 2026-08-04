/**
 * Fetch wrapper for the Cloud Run "R runner" service (r-runner/plumber.R) —
 * the Worker's HTTP client for POST /runR. Ported from
 * apps/api/lib/sandbox.ts's runRViaWebr + dataPreamble (read-only reference,
 * not imported — see docs/cloud-run-r-migration.md §2/§3.1), with a hard
 * timeout (30s by default; 180s when `packages` is passed, see
 * INSTALL_TIMEOUT_MS below) and ONE retry for transient failures so a Cloud
 * Run cold start (min-instances 0, see the migration doc §2.4) doesn't sink
 * a solve.
 *
 * PINNED FILENAME-SANITIZATION CONTRACT (do not improvise): the Cloud Run
 * service writes each uploaded file to disk under
 * `gsub("[^A-Za-z0-9._-]", "_", basename(filename))` (r-runner/plumber.R).
 * For the wrapped R script's `read.csv(...)` calls (built by dataPreamble
 * below) to find those files, BOTH sides of this request must reference the
 * exact same sanitized name:
 *   1. the `files` array in the POST body (sanitizeFilename applied here), and
 *   2. the preamble's read.csv() filename argument (readName, also
 *      sanitizeFilename — NOT the raw filename the old WebR sidecar used to
 *      accept verbatim, see sandbox.ts's runRViaWebr).
 * Getting these two out of sync silently breaks every calc question with a
 * data file (read.csv finds nothing, R errors, and the repair loop can't fix
 * a filename mismatch it never sees) — so both use the SAME call site below.
 */

import type { DataFile } from "@statshelpr/solver-core/solver";
import type { Env } from "../types";

export interface RunRResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  /** Only present when the request carried a `packages` field — mirrors
   *  r-runner/plumber.R's `/runR` response, which gates these same two
   *  fields behind the identical condition (see that file's `install_result`
   *  handling). Package names this call successfully installed on demand
   *  (r-runner/plumber.R's install_missing_packages) — read by
   *  routes/solve.ts to feed the runtimeInstalledRPackages metric
   *  (lib/metrics-store.ts). */
  installedPackages?: string[];
  /** Requested-and-missing package names that did NOT end up installed this
   *  call (grammar-invalid, timed out, per-package install failure, or
   *  skipped outright because more than 10 were missing at once — see
   *  plumber.R's MAX_MISSING_TO_INSTALL). Diagnostic only: routes/solve.ts
   *  does not need this to drive telemetry — a script that then tries to
   *  library()/require() a still-missing package hits R's normal "there is
   *  no package called ..." error, which the EXISTING missingRPackages
   *  telemetry (extractMissingRPackageNames) already captures regardless of
   *  why the package never became available. */
  installFailed?: string[];
}

const TIMEOUT_MS = 30_000; // never let one R run hang a solve indefinitely
/** Worst-case budget for a request that names `packages`: r-runner's install
 *  phase is internally capped at 90s (plumber.R's INSTALL_BUDGET_SECS) on
 *  top of script execution's own pre-existing, still-unbounded-at-the-R-level
 *  budget — both now sit under Cloud Run's request timeout, raised from 30s
 *  to 180s specifically for this (see r-runner/README.md's Deploy section
 *  and its "On-demand package installs" section for the full budget
 *  breakdown). This is a CEILING, not the typical case — most packages-
 *  present requests install nothing new (already on the runner, or already
 *  warm from an earlier request on the same container) and return as fast
 *  as a normal call. */
const INSTALL_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 2; // 1 try + 1 retry — see the transient-failure note below

/** Matches apps/api/lib/sandbox.ts's Vercel-sandbox `safeName` exactly, and
 *  (pinned contract, see module doc) MUST match r-runner/plumber.R's
 *  `gsub("[^A-Za-z0-9._-]", "_", basename(filename))` byte-for-byte. */
function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Load each provided data file into a variable named after its file stem
 * (ads.csv -> `ads`), so R code can reference the dataframe by the same name
 * the model is shown in the "R ENVIRONMENT CONTEXT" (buildDataContext)
 * without an explicit read.csv. Ported VERBATIM from apps/api/lib/sandbox.ts
 * (read-only reference per task scope — not imported from apps/api), other
 * than fixing the `readName` callsite below to this runner's
 * sanitized-filename contract (see module doc) instead of sandbox.ts's
 * WebR-sidecar branch, which wrote files under the RAW filename. Uses
 * assign() so any stem is valid, and tryCatch so a missing/bad file yields
 * NULL (a clear downstream error the repair loop can act on) rather than
 * aborting the whole script.
 */
function dataPreamble(files: DataFile[], readName: (f: DataFile) => string): string {
  if (files.length === 0) return "";
  const lines = files.map((f) => {
    const stem = f.filename.replace(/\.(csv|tsv|txt)$/i, "");
    return `assign(${jsq(stem)}, tryCatch(read.csv(${jsq(readName(f))}, stringsAsFactors = FALSE), error = function(e) NULL))`;
  });
  return ["# auto-loaded datasets (available by name, per the R environment context)", ...lines].join("\n");
}

function jsq(s: string): string {
  return JSON.stringify(s);
}

/**
 * Run `rCode` on the Cloud Run R service, wrapping it exactly like
 * apps/api/lib/sandbox.ts's runRViaWebr does (same options()/set.seed()
 * preamble + dataPreamble) so output/formatting/seed match what the solver
 * prompts already assume.
 *
 * Fails CLOSED if the runner isn't configured — matches this codebase's
 * existing fail-closed convention for required-but-unset config (compare
 * routes/dashboard.ts's DASHBOARD_PASSWORD / routes/metrics.ts's
 * METRICS_TOKEN: an unset required secret must never silently open — or
 * here, silently no-op — a gate).
 * Concept questions never call this function, so an unset R_RUNNER_URL /
 * R_RUNNER_SECRET only takes down calc questions, not the service as a whole.
 *
 * `packages` is OMITTED (not just empty-array) for every caller that doesn't
 * pass it — the default preset, i.e. every request without a customized
 * picker selection (see routes/solve.ts's call site). That is load-bearing,
 * not cosmetic: passing `undefined` here means the JSON body sent to the
 * runner has no `packages` key AT ALL (not `"packages":[]`) and the timeout
 * stays the original 30s — byte-identical to this function's behavior
 * before on-demand installs existed. Only an explicit array (even an empty
 * one, e.g. a customized user who cleared every package) opts into the
 * extended 180s-worst-case timeout and the `packages` field on the wire —
 * see INSTALL_TIMEOUT_MS above.
 */
export async function runRRemote(
  env: Env,
  rCode: string,
  files: DataFile[],
  packages?: string[],
): Promise<RunRResult> {
  if (!env.R_RUNNER_URL || !env.R_RUNNER_SECRET) {
    throw new Error(
      "R runner not configured — set R_RUNNER_URL (wrangler.toml) and R_RUNNER_SECRET (wrangler secret put).",
    );
  }

  const readName = (f: DataFile) => sanitizeFilename(f.filename);
  const wrapped = [
    "options(warn = 1)",
    "options(width = 160)",
    "set.seed(123)",
    dataPreamble(files, readName),
    rCode,
  ]
    .filter(Boolean)
    .join("\n");

  // PINNED: same sanitizeFilename call as readName above — see module doc.
  const sanitizedFiles = files.map((f) => ({ filename: sanitizeFilename(f.filename), content: f.content }));
  // packages is spread in ONLY when defined — see this function's doc
  // comment above for why that distinction (vs. always sending a possibly-
  // empty array) is the actual byte-identical-default-preset guarantee.
  const body = JSON.stringify({
    code: wrapped,
    files: sanitizedFiles,
    ...(packages !== undefined ? { packages } : {}),
  });
  const headers = { "Content-Type": "application/json", "X-Runner-Secret": env.R_RUNNER_SECRET };
  const url = `${env.R_RUNNER_URL}/runR`;
  const timeoutMs = packages !== undefined ? INSTALL_TIMEOUT_MS : TIMEOUT_MS;

  let lastError = new Error("R runner call never attempted");
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      // Fresh AbortSignal.timeout() every attempt — a retry must get its own
      // full budget, not the remainder of the first attempt's.
      res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      // Network error / fetch throw (DNS failure, connection refused, our
      // own AbortSignal firing, etc.) — the transient class this retry
      // exists to absorb (a Cloud Run cold start, min-instances 0, see
      // migration doc §2.4). Deliberately NEVER retries on the R SCRIPT's
      // own non-zero exitCode below (that's a successful HTTP response) —
      // that's lib/r-repair.ts's job: a fresh Gemini call to fix the CODE,
      // not a network-level retry of the same broken script.
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < MAX_ATTEMPTS) continue;
      throw lastError;
    }

    if (res.ok) return (await res.json()) as RunRResult;

    const text = await res.text();
    lastError = new Error(`R runner ${res.status}: ${text}`);
    // Only a 5xx (the runner itself faulted, likely cold-start-adjacent) is
    // worth the retry budget; a 4xx (bad auth, malformed body) would fail
    // identically on a second attempt.
    if (res.status >= 500 && attempt < MAX_ATTEMPTS) continue;
    throw lastError;
  }
  throw lastError;
}
