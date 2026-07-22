/**
 * Stable error-class labeller for failed solve/interpret calls (dashboard-v2
 * item 2). Pure, Env-free — unit-tested in apps/workers/scripts/self-test-metrics.ts.
 *
 * Mirrors routes/solve.ts's `humanizeError` regexes/status checks so the
 * user-facing message and the recorded `byErrorType` class stay in lockstep,
 * then folds the remaining upstream-shaped failures into a small closed enum
 * so a new failure mode never needs a schema bump. Returns one of:
 *   "quota" | "auth" | "rate_limit" | "timeout" | "bad_input" | "upstream" | "unknown"
 *
 * Order matters: message-based classes (quota, timeout) are checked before
 * status-based ones — same precedence as humanizeError, where the quota regex
 * wins over a 429 that carries a "resource exhausted" body.
 */
export function classifyError(e: unknown): string {
  const obj = (e ?? {}) as { status?: unknown; message?: unknown; name?: unknown };
  const status = typeof obj.status === "number" ? obj.status : undefined;
  const msg = typeof obj.message === "string" ? obj.message : "";
  const name = typeof obj.name === "string" ? obj.name : "";

  // Message-based classes first (mirror humanizeError's quota regex precedence).
  if (/credit balance|insufficient|quota|resource exhausted/i.test(msg)) return "quota";
  if (name === "AbortError" || name === "TimeoutError" || /timeout|abort/i.test(msg)) return "timeout";

  // Status-based classes (mirror humanizeError's 401/403 and 429 handling).
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  // 400/422: the upstream API rejected the request body itself (bad_input),
  // distinct from a 5xx/other upstream fault below.
  if (status === 400 || status === 422) return "bad_input";

  // Any other error that still carried an HTTP-ish status is an upstream-API
  // fault; a status-less error is genuinely unclassifiable.
  if (typeof status === "number") return "upstream";
  return "unknown";
}
