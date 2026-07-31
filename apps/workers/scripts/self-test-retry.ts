/**
 * Self-test for packages/solver-core/src/core/providers/retry.ts — the
 * transparent server-side retry/backoff wrapper every LLM provider's
 * chat()/chatStream() fetch() call goes through (see gemini.ts).
 *
 * Covers the pure header-parsing helpers directly, then fetchWithRetry
 * end-to-end against a hand-rolled fake `fetch` (no real network) covering:
 * non-retryable statuses passing straight through, retryable statuses
 * (429/5xx) retrying until success or budget exhaustion, network errors
 * retrying then eventually rethrowing, Retry-After honoring + clamping to
 * the wall-clock budget, the onWaiting heartbeat firing mid-sleep, and the
 * per-attempt connect timeout converting a hang into a retried attempt.
 * Every test uses small ms overrides so the whole file runs in well under a
 * second of real wall-clock time despite using real timers (no fake-timer
 * library in this workspace — same "keep it simple" spirit as the other
 * self-tests here).
 *
 * Same plain-tsx pattern as self-test-metrics.ts / self-test-security.ts (no
 * vitest in this workspace) — run via:
 *
 *   pnpm --filter @statshelpr/api exec tsx ../workers/scripts/self-test-retry.ts
 *
 * Exit code is 0 if every check passes, 1 otherwise (CI-friendly).
 */

import {
  fetchWithRetry,
  parseDurationHeaderMs,
  parseRetryAfterMs,
  retryDelayFromHeaders,
  RETRYABLE_STATUSES,
} from "@statshelpr/solver-core/core/providers";

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

function approxEqual(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

/** A minimal fake Response — just enough surface for retry.ts (status/ok/
 *  headers/body). Cloned "body" as an empty ReadableStream so `res.body?.
 *  cancel()` on a discarded retryable response works exactly like a real
 *  fetch Response would. */
function fakeResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(new ReadableStream(), { status, headers });
}

async function main() {
  // ---------------------------------------------------------------------------
  console.log("retry.ts: parseRetryAfterMs");

  check('parseRetryAfterMs("2") -> 2000ms', parseRetryAfterMs("2") === 2000);
  check('parseRetryAfterMs("0") -> 0ms', parseRetryAfterMs("0") === 0);
  check('parseRetryAfterMs(" 5 ") -> trims whitespace', parseRetryAfterMs(" 5 ") === 5000);
  {
    const future = new Date(Date.now() + 10_000);
    const ms = parseRetryAfterMs(future.toUTCString());
    check(
      "parseRetryAfterMs(HTTP-date) -> ~10000ms",
      ms !== undefined && approxEqual(ms, 10_000, 1_000),
      `got ${ms}`,
    );
  }
  check('parseRetryAfterMs("not-a-date") -> undefined', parseRetryAfterMs("not-a-date") === undefined);
  check('parseRetryAfterMs("") -> undefined', parseRetryAfterMs("") === undefined);

  // ---------------------------------------------------------------------------
  console.log("retry.ts: parseDurationHeaderMs (OpenAI-style x-ratelimit-reset-*)");

  check('parseDurationHeaderMs("1s") -> 1000ms', parseDurationHeaderMs("1s") === 1000);
  check('parseDurationHeaderMs("500ms") -> 500ms', parseDurationHeaderMs("500ms") === 500);
  check('parseDurationHeaderMs("6m0s") -> 360000ms', parseDurationHeaderMs("6m0s") === 360_000);
  {
    const expected = 2 * 3_600_000 + 56 * 60_000 + 21.6 * 1000;
    const got = parseDurationHeaderMs("2h56m21.6s");
    check("parseDurationHeaderMs(\"2h56m21.6s\") sums every unit", got !== undefined && approxEqual(got, expected, 0.001), `got ${got}, want ${expected}`);
  }
  check('parseDurationHeaderMs("ms" ahead of "m" disambiguation: "10ms")', parseDurationHeaderMs("10ms") === 10);
  check('parseDurationHeaderMs("") -> undefined (not 0)', parseDurationHeaderMs("") === undefined);
  check('parseDurationHeaderMs("garbage") -> undefined', parseDurationHeaderMs("garbage") === undefined);

  // ---------------------------------------------------------------------------
  console.log("retry.ts: retryDelayFromHeaders");

  check(
    "retry-after alone -> its value",
    retryDelayFromHeaders(new Headers({ "retry-after": "3" })) === 3000,
  );
  check(
    "x-ratelimit-reset-requests/-tokens -> the LARGER of the two",
    retryDelayFromHeaders(
      new Headers({ "x-ratelimit-reset-requests": "1s", "x-ratelimit-reset-tokens": "6m0s" }),
    ) === 360_000,
  );
  check(
    "retry-after takes priority over x-ratelimit-reset-* when both present",
    retryDelayFromHeaders(
      new Headers({ "retry-after": "1", "x-ratelimit-reset-tokens": "6m0s" }),
    ) === 1000,
  );
  check("no headers -> undefined", retryDelayFromHeaders(new Headers()) === undefined);

  // ---------------------------------------------------------------------------
  console.log("retry.ts: RETRYABLE_STATUSES");

  check("429 is retryable", RETRYABLE_STATUSES.has(429));
  check("502/503/504 are retryable", [502, 503, 504].every((s) => RETRYABLE_STATUSES.has(s)));
  check("401/400/200 are NOT retryable", ![401, 400, 200].some((s) => RETRYABLE_STATUSES.has(s)));
  check("500 is NOT retryable (not in the pinned set)", !RETRYABLE_STATUSES.has(500));

  // ---------------------------------------------------------------------------
  console.log("retry.ts: fetchWithRetry (fake fetch, no real network)");

  const realFetch = globalThis.fetch;
  let fetchCalls = 0;

  function install(handler: (call: number) => Promise<Response>) {
    fetchCalls = 0;
    globalThis.fetch = ((..._args: unknown[]) => {
      fetchCalls++;
      return handler(fetchCalls);
    }) as typeof fetch;
  }

  {
    install(async () => fakeResponse(200));
    const res = await fetchWithRetry("https://example.test/ok", {});
    check("2xx: resolves on the first attempt", res.status === 200 && fetchCalls === 1, `calls=${fetchCalls}`);
  }

  {
    install(async () => fakeResponse(401));
    const res = await fetchWithRetry("https://example.test/auth", {}, { baseDelayMs: 1, maxElapsedMs: 500 });
    check(
      "401: returned immediately, never retried (auth is not transient)",
      res.status === 401 && fetchCalls === 1,
      `calls=${fetchCalls}`,
    );
  }

  {
    install(async () => fakeResponse(400));
    const res = await fetchWithRetry("https://example.test/badinput", {}, { baseDelayMs: 1, maxElapsedMs: 500 });
    check(
      "400: returned immediately, never retried (bad input is not transient)",
      res.status === 400 && fetchCalls === 1,
      `calls=${fetchCalls}`,
    );
  }

  {
    install(async (call) => fakeResponse(call === 1 ? 429 : 200));
    let retryEvents = 0;
    const res = await fetchWithRetry(
      "https://example.test/rate-limited-once",
      {},
      { baseDelayMs: 1, maxElapsedMs: 500, onRetry: () => retryEvents++ },
    );
    check(
      "429 then 200: retries once and succeeds",
      res.status === 200 && fetchCalls === 2 && retryEvents === 1,
      `calls=${fetchCalls}, retryEvents=${retryEvents}`,
    );
  }

  {
    install(async () => fakeResponse(503));
    let retryEvents = 0;
    const res = await fetchWithRetry(
      "https://example.test/always-503",
      {},
      { baseDelayMs: 1, maxElapsedMs: 500, maxRetries: 2, onRetry: () => retryEvents++ },
    );
    check(
      "always 503, maxRetries=2: exactly 3 attempts (1 + 2 retries), last Response returned",
      res.status === 503 && fetchCalls === 3 && retryEvents === 2,
      `calls=${fetchCalls}, retryEvents=${retryEvents}`,
    );
  }

  {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed: network error");
    }) as typeof fetch;
    let threw: unknown;
    try {
      await fetchWithRetry("https://example.test/network-down", {}, { baseDelayMs: 1, maxElapsedMs: 500, maxRetries: 2 });
    } catch (e) {
      threw = e;
    }
    check(
      "persistent network error: rethrows the last error once budget exhausted",
      threw instanceof TypeError && (threw as Error).message.includes("network error"),
      String(threw),
    );
  }

  {
    // Retry-After requests a much longer wait (100s) than the remaining
    // wall-clock budget allows — the delay must be CLAMPED down, and the
    // second failure must stop retrying on budget exhaustion even though
    // maxRetries (5) was never reached.
    install(async () => fakeResponse(429, { "retry-after": "100" }));
    const startedAt = Date.now();
    const res = await fetchWithRetry(
      "https://example.test/long-retry-after",
      {},
      { baseDelayMs: 10, maxElapsedMs: 60, maxRetries: 5 },
    );
    const elapsed = Date.now() - startedAt;
    check(
      "Retry-After longer than the budget: clamped, and elapsed-budget wins over maxRetries",
      res.status === 429 && fetchCalls === 2 && elapsed < 1000,
      `calls=${fetchCalls}, elapsedMs=${elapsed}`,
    );
  }

  {
    // Deterministic delay (via Retry-After, not jittered backoff) long enough
    // to cross a few heartbeat ticks.
    install(async (call) => fakeResponse(call === 1 ? 429 : 200, call === 1 ? { "retry-after": "0.35" } : {}));
    let waitingTicks = 0;
    const res = await fetchWithRetry(
      "https://example.test/heartbeat",
      {},
      { baseDelayMs: 1, maxElapsedMs: 5000, waitingIntervalMs: 100, onWaiting: () => waitingTicks++ },
    );
    check(
      "onWaiting heartbeat fires ~every 100ms during a 350ms sleep (3 ticks)",
      res.status === 200 && waitingTicks === 3,
      `waitingTicks=${waitingTicks}`,
    );
  }

  {
    // Simulates a hung connection on the FIRST attempt only: fetch never
    // settles unless its signal aborts. A small connectTimeoutMs should
    // convert that hang into a network-error retry (same as a real dropped
    // connection would), and the second attempt succeeds immediately.
    let hangCalls = 0;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      hangCalls++;
      if (hangCalls > 1) return Promise.resolve(fakeResponse(200));
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(fakeResponse(200)), 5_000); // "never" relative to the timeout below
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(init.signal!.reason);
        });
      });
    }) as typeof fetch;
    const startedAt = Date.now();
    const res = await fetchWithRetry(
      "https://example.test/hangs",
      {},
      { baseDelayMs: 1, maxElapsedMs: 2000, connectTimeoutMs: 20 },
    );
    const elapsed = Date.now() - startedAt;
    check(
      "a hung first attempt is cut off by connectTimeoutMs and retried",
      res.status === 200 && hangCalls === 2 && elapsed < 1000,
      `hangCalls=${hangCalls}, elapsedMs=${elapsed}`,
    );
  }

  globalThis.fetch = realFetch;

  // ---------------------------------------------------------------------------
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
