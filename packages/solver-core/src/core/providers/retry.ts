/**
 * Transparent server-side retry/backoff for upstream LLM HTTP calls.
 *
 * Goal: a student hitting a TRANSIENT upstream blocker (429 rate limit —
 * including a TPM window, which resets every minute — or a 502/503/504, or
 * the connection just hanging) should see a longer wait, never an error. This
 * module is the shared mechanic every provider's `chat()`/`chatStream()`
 * wraps their fetch() call in (currently just gemini.ts — see that file).
 *
 * Retries ONLY:
 *   - HTTP 429 (rate limit) and 5xx 502/503/504 (upstream fault)
 *   - a thrown network error (DNS/connection reset/TLS/our own connect
 *     timeout below firing) — the same catch-all class apps/workers/src/
 *     lib/r-runner.ts already retries once for the Cloud Run R service
 *
 * Deliberately does NOT retry: 2xx (nothing to do), 401/403 (auth is not
 * transient), 400/422 (bad input is not transient), or any other 4xx/5xx not
 * in the retryable set above — those are handed straight back to the caller
 * on the first attempt so its existing error path runs unchanged.
 *
 * Web-standard APIs only (fetch/AbortController/AbortSignal.timeout/
 * setTimeout/Date/Math.random) — this package runs on Cloudflare Workers
 * (apps/workers) AND Node/Next (apps/api), and neither runtime's globals can
 * be assumed present in the other (see gemini.ts's `process` comment).
 * `AbortSignal.timeout` specifically is already relied on elsewhere in this
 * codebase (apps/workers/src/lib/r-runner.ts), confirming it's safe here too.
 */

/** Info describing one retry about to happen — passed to `onRetry` right
 *  before that retry's backoff sleep begins. */
export interface RetryEvent {
  /** 1-based count of this retry (1 = first retry, after the original
   *  attempt failed; matches "retry N of maxRetries" framing). */
  attempt: number;
  /** How long this retry will sleep before firing, in ms (already clamped to
   *  the remaining wall-clock budget). */
  delayMs: number;
  /** The HTTP status that triggered this retry. Absent when the retry was
   *  triggered by fetch() itself rejecting (network error/connect timeout). */
  status?: number;
  /** The thrown error, when this retry was triggered by fetch() rejecting. */
  error?: unknown;
}

export interface FetchWithRetryOptions {
  /** Max retries AFTER the initial attempt. Default 5. */
  maxRetries?: number;
  /** Total wall-clock budget across the initial attempt + every retry/wait,
   *  in ms. Whichever of this or `maxRetries` is hit first stops retrying.
   *  Default 60_000 — generous, because a TPM rate-limit window resets every
   *  60s and a longer wait beats surfacing a failure, but bounded so a solve
   *  can never appear to hang forever. */
  maxElapsedMs?: number;
  /** Base delay for exponential backoff with full jitter, in ms. Default
   *  500. Actual per-retry delay is `random(0, base * 2**retryIndex)`, unless
   *  a `Retry-After`/rate-limit-reset response header says otherwise (see
   *  module doc — headers win when present). */
  baseDelayMs?: number;
  /** Per-attempt connect timeout: how long a single fetch() is allowed to
   *  take before it's treated as a network error and retried. A FRESH
   *  AbortSignal.timeout() is used on every attempt — a retry gets its own
   *  full budget, not the remainder of the previous attempt's (same pattern
   *  as lib/r-runner.ts's TIMEOUT_MS). Default 30_000. Only applied when the
   *  caller's own `init.signal` is unset — an explicit caller signal is
   *  respected as-is and never overridden. */
  connectTimeoutMs?: number;
  /** Fires once, synchronously, immediately before each retry's backoff
   *  sleep begins. Purely observational (e.g. metrics/logging) — never
   *  awaited, never affects retry behavior. */
  onRetry?: (event: RetryEvent) => void;
  /** Fires every `waitingIntervalMs` WHILE a single backoff sleep is still in
   *  progress (never during the first interval, never for short sleeps).
   *  Exists so a caller streaming SSE downstream can emit a "still working"
   *  heartbeat during a long wait instead of going idle — see
   *  apps/workers/src/routes/solve.ts's own heartbeat for the same pattern
   *  applied to its R-repair pipeline. */
  onWaiting?: () => void;
  /** Heartbeat cadence for `onWaiting`, in ms. Default 10_000 — matches
   *  solve.ts's existing R-repair heartbeat and stays comfortably under the
   *  extension's 30s SSE idle-abort watchdog (content.ts's
   *  SSE_IDLE_TIMEOUT_MS). */
  waitingIntervalMs?: number;
}

export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_MAX_ELAPSED_MS = 60_000;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_WAITING_INTERVAL_MS = 10_000;

/**
 * Fetch with transparent retry/backoff on transient failures.
 *
 * On success (2xx) or a NON-retryable status, resolves with that Response on
 * the first attempt — indistinguishable from a plain `fetch()` call to the
 * caller. On a retryable status, retries until either budget is exhausted,
 * then resolves with the LAST Response so the caller's existing error path
 * (e.g. gemini.ts's `rejectIfBad`) runs exactly as it would have without this
 * wrapper. On a persistent network error, throws the last error once budget
 * is exhausted — same throw-on-network-error contract plain `fetch()` has.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchWithRetryOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxElapsedMs = opts.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const waitingIntervalMs = opts.waitingIntervalMs ?? DEFAULT_WAITING_INTERVAL_MS;

  const startedAt = Date.now();

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        // Fresh timeout signal per attempt (see option doc); an explicit
        // caller-supplied signal is left untouched.
        signal: init.signal ?? AbortSignal.timeout(connectTimeoutMs),
      });
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      if (attempt >= maxRetries || elapsed >= maxElapsedMs) throw err;
      const delayMs = clamp(backoffDelayMs(attempt, baseDelayMs), maxElapsedMs - elapsed);
      opts.onRetry?.({ attempt: attempt + 1, delayMs, error: err });
      await sleepWithHeartbeat(delayMs, opts.onWaiting, waitingIntervalMs);
      continue;
    }

    if (res.ok || !RETRYABLE_STATUSES.has(res.status)) return res;

    const elapsed = Date.now() - startedAt;
    if (attempt >= maxRetries || elapsed >= maxElapsedMs) return res; // budget exhausted — hand back for the caller's normal error path

    const delayMs = clamp(
      retryDelayFromHeaders(res.headers) ?? backoffDelayMs(attempt, baseDelayMs),
      maxElapsedMs - elapsed,
    );
    opts.onRetry?.({ attempt: attempt + 1, delayMs, status: res.status });
    // We're discarding this Response (a retry is coming) — release its body/
    // connection rather than leaving it unconsumed. Never awaited-into-danger:
    // wrapped so a runtime that rejects/throws on cancel() of an empty body
    // can't break the retry loop.
    await res.body?.cancel().catch(() => {});
    await sleepWithHeartbeat(delayMs, opts.onWaiting, waitingIntervalMs);
  }
}

/** Exponential backoff with full jitter (AWS's "Full Jitter" algorithm):
 *  uniform random in `[0, base * 2**retryIndex)`. Spreads out retries from
 *  concurrent callers instead of having them all wake up in lockstep. */
function backoffDelayMs(retryIndex: number, baseDelayMs: number): number {
  const cap = baseDelayMs * 2 ** retryIndex;
  return Math.random() * cap;
}

function clamp(delayMs: number, remainingBudgetMs: number): number {
  return Math.max(0, Math.min(delayMs, remainingBudgetMs));
}

/** Sleeps `ms`, calling `onWaiting` every `intervalMs` WHILE still waiting
 *  (not before the first interval, not after the last partial one) — see
 *  `onWaiting`'s doc on FetchWithRetryOptions for why this exists. */
async function sleepWithHeartbeat(
  ms: number,
  onWaiting: (() => void) | undefined,
  intervalMs: number,
): Promise<void> {
  if (!onWaiting || ms <= intervalMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return;
  }
  let remaining = ms;
  while (remaining > intervalMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    remaining -= intervalMs;
    onWaiting();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, remaining));
}

/** `Retry-After` per RFC 7231 §7.1.3: either delta-seconds or an HTTP-date. */
export function parseRetryAfterMs(value: string): number | undefined {
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  return Number.isNaN(dateMs) ? undefined : dateMs - Date.now();
}

/** Go-`time.Duration`-shaped value (e.g. "1s", "6m0s", "2h56m21.6s",
 *  "500ms") — the format OpenAI's `x-ratelimit-reset-requests` /
 *  `x-ratelimit-reset-tokens` headers use. Sums every `<number><unit>` pair
 *  found; returns undefined if none were found (rather than 0, so an absent/
 *  unparseable header correctly falls through to backoff instead of a 0ms
 *  "retry immediately"). Order matters in the unit alternation: "ms" must be
 *  checked before "m" or it would match as "m" + a stray "s". Uses
 *  `matchAll` (not a manual regex-loop) purely for readability. */
export function parseDurationHeaderMs(value: string): number | undefined {
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let totalMs = 0;
  let found = false;
  for (const match of value.matchAll(re)) {
    found = true;
    const amount = Number(match[1]);
    const unit = match[2];
    const unitMs = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;
    totalMs += amount * unitMs;
  }
  return found ? totalMs : undefined;
}

/** Header-driven retry delay, checked in priority order: standard
 *  `Retry-After` first, then OpenAI-style rate-limit reset headers (Gemini
 *  doesn't send these today; honoring them costs nothing when absent and
 *  costs nothing extra to check — see gemini.ts's own "OpenAI-style" parity
 *  comments, this codebase already treats OpenAI's shapes as the reference
 *  vocabulary). When both `x-ratelimit-reset-requests` and `-tokens` are
 *  present, takes the larger — a 429 could be tripped by either window, and
 *  the larger one is the one that actually gates the next successful call.
 *  Returns undefined (fall through to exponential backoff) when no header is
 *  present or parseable. */
export function retryDelayFromHeaders(headers: Headers): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const ms = parseRetryAfterMs(retryAfter);
    if (ms !== undefined) return Math.max(0, ms);
  }

  const resetCandidates = [
    headers.get("x-ratelimit-reset-requests"),
    headers.get("x-ratelimit-reset-tokens"),
  ]
    .filter((v): v is string => v !== null)
    .map(parseDurationHeaderMs)
    .filter((v): v is number => v !== undefined);
  if (resetCandidates.length > 0) return Math.max(0, Math.max(...resetCandidates));

  return undefined;
}
