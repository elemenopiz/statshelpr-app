/**
 * Global daily circuit breaker — security-audit item D (the "real backstop
 * the audit says is missing").
 *
 * Every other limiter in this codebase (lib/rate-limit.ts's per-install and
 * per-IP buckets) is scoped to ONE caller. This one isn't scoped to anyone:
 * it caps the total of EVERY Gemini-billed call this Worker makes — across
 * the entire service, every caller, free or paid — at a single configurable
 * daily ceiling. The point is a hard, known-in-advance upper bound on
 * worst-case daily spend that holds even if every per-caller limiter is
 * somehow bypassed, misconfigured, or simply hasn't been thought of yet (a
 * bug causing a client retry storm, a scraping run rotating both install ids
 * AND IPs, etc.) — so the worst case is "the whole service 503s for the rest
 * of the UTC day", never "the bill grows without bound".
 *
 * Reuses lib/rate-limit.ts's checkAndIncrement with a single fixed bucket id
 * under its own KV key prefix — same get/recheck/put semantics (see that
 * file's doc comment for the exact residual race window), just with no
 * per-caller scope to hash: everyone shares the one "global" bucket.
 *
 * Checked in routes/solve.ts before EACH Gemini call it makes, individually —
 * not once per request. A concept question makes one (the first pass, right
 * after the per-caller auth/license/rate-limit gates and immediately before
 * the Gemini stream). A calc question can make up to three, each gated here
 * separately right before it fires: the first pass, an optional R-repair
 * retry, and the interpret pass (the latter two used to be the separate
 * /api/interpret route's own single call — see
 * docs/cloud-run-r-migration.md §3 — that route is gone; both are now
 * internal continuations of the one /api/solve request, but the PER-CALL
 * checkpoint is preserved so the global ceiling still bounds worst-case
 * Gemini spend the same way it did when solve and interpret were separate
 * requests). Checking before each call rather than once per request means
 * only work that will actually incur Gemini cost counts toward the ceiling.
 * It deliberately is NOT at the very top of the route: a top-of-route
 * check-and-increment let cheap rejected requests (bad/empty auth,
 * over-IP-limit, malformed body) bump the global counter, so
 * ~GLOBAL_DAILY_CALL_LIMIT junk requests from a single IP could trip a
 * service-wide 503 for the rest of the UTC day — a DoS vector. The per-IP +
 * per-install gates absorb that before the first checkpoint.
 *
 * *** CEILING SIZING — re-check before trusting, same spirit as lib/cost.ts's
 * pricing-source disclaimer ***
 * Default GLOBAL_DAILY_CALL_LIMIT = 1000 (every Gemini call/day, across all
 * legs of /api/solve — see the per-call checkpoints above; NOT 1000
 * questions/day, since a calc question can now consume up to 3 calls against
 * this ceiling instead of 2 — the R-repair leg is a new addition this
 * migration brought back from apps/api/lib/solver/r-repair.ts, which the
 * prior Cloudflare-native solve.ts/interpret.ts split never had).
 * Worst-case $/day math (see lib/cost.ts for the underlying rates):
 *   - Pessimistic per-call cost assumes EVERY call is costed at the pricier
 *     IMAGE_VISION_MODEL rate ($1.50/$7.50 per 1M in/out — a caller can
 *     freely claim `images: [...]` on a direct API call to route onto this
 *     rate) with ~20,000 prompt tokens (the system prompt is ~5-6k tokens;
 *     the data-context block lib/data-summary.ts + core/data-context.ts
 *     builds is server-computed and hard-capped at 50,000 chars ≈ 12.5k
 *     tokens; the rest is headroom for question text/choices/images) and
 *     the full MAX_TOKENS_FIRST output cap (6,000 tokens, solver-core's
 *     solver/settings.ts) — i.e. (20000/1e6)*1.50 + (6000/1e6)*7.50 = $0.075,
 *     rounded up to $0.08/call for margin.
 *   - 1000 calls/day × $0.08 = $80/day worst case ($~2,400 if it somehow ran
 *     at the ceiling for a full month — an immediately-visible anomaly, not
 *     a steady state: the founder gets the existing daily 08:00 UTC alert
 *     cron AND can watch /dashboard live).
 *   - Real (non-adversarial) traffic at 1000 calls/day would cost far less
 *     than $80 — most solves are concept-mode (one call, cheap text model,
 *     modest output), so this ceiling only approaches its worst-case dollar
 *     figure under a genuinely adversarial, maximize-every-dimension
 *     pattern, not organic usage.
 *   - NOT covered by a call-COUNT ceiling: a single call with an
 *     abnormally large body (there's no per-request payload-size cap on
 *     `questionText`/`rCode`/`stdout` today beyond the server-computed
 *     data-context truncation) could individually cost more than the $0.08
 *     assumption above. That's a real residual gap, flagged here rather
 *     than silently assumed away — a payload-size cap would need its own
 *     pass and its own product tradeoffs (real course CSVs can legitimately
 *     be large), which is out of scope for this fix.
 *   - Current legitimate volume is documented (lib/metrics-store.ts) as
 *     "single-digit-to-low-hundreds of requests/day" pre-launch, so 1000
 *     leaves comfortable headroom for organic growth/spikes before this
 *     ever trips under normal operation. Bump the wrangler.toml var as real
 *     traffic data justifies it.
 */

import type { Context } from "hono";
import type { Env } from "../types";
import { checkAndIncrement, type RateLimitResult } from "./rate-limit";

const KV_PREFIX = "ks:";
const GLOBAL_BUCKET_ID = "global";
const DEFAULT_LIMIT = 1000;

// --- dollar ceiling (2026-07-29 capacity review) ---------------------------
// The call-count ceiling above bounds VOLUME, but its dollar meaning depends
// on a pessimistic per-call cost assumption ($0.08 — see the sizing comment
// above). This second, independent record bounds the ACTUAL dollars: solve.ts
// reports each Gemini leg's real costUsd (lib/cost.ts rates on the usage
// counts Gemini returned) into `ks$:spend`, and checkGlobalKillSwitch refuses
// further calls once the day's accumulated spend crosses
// GLOBAL_DAILY_SPEND_LIMIT_USD. Between the two, an abuser can't win either
// way: many cheap calls trip the count first, few stuffed calls trip this
// first — so the worst possible day costs ~the spend cap plus in-flight
// overshoot (calls already streaming when the trip lands; bounded by
// concurrency × worst per-call cost, single-digit dollars), instead of
// "whatever the per-call pessimism times the call cap works out to".
//
// Same 24h-rolling-window/TTL pattern as rate-limit.ts's StoredCount, and the
// same no-CAS caveats: concurrent spend adds can race (lost adds = slight
// undercount, i.e. the trip lands marginally late, never early) and the put
// fails OPEN via the same contention rationale as rate-limit.ts's
// putCountFailOpen — a burst-second's lost write may not cost the caller
// anything, sustained spend still lands at ≥1 write/sec.
const SPEND_KV_KEY = "ks$:spend";
const DEFAULT_SPEND_LIMIT_USD = 25;

interface StoredSpend {
  usd: number;
  resetAt: number;
}

export const KILL_SWITCH_MESSAGE =
  "statshelpr is temporarily over its daily request volume ceiling. Please try again later.";

/** Checks AND increments the global daily counter in one call — mirrors
 *  lib/rate-limit.ts's per-caller buckets: an "allowed" result has already
 *  been counted, so the caller should call this once per GEMINI CALL, not
 *  once per REQUEST (routes/solve.ts calls this up to three times for a
 *  single calc question — see the module doc above), immediately before
 *  doing that call's Gemini-bound work, and 503 immediately on `!allowed`
 *  without incrementing anything else or making the call. Also refuses when
 *  the day's accumulated REAL spend (recordGlobalSpendInBackground below)
 *  has crossed the dollar ceiling — one gate, two independent bounds. */
export async function checkGlobalKillSwitch(env: Env): Promise<RateLimitResult> {
  const limit = Number(env.GLOBAL_DAILY_CALL_LIMIT ?? String(DEFAULT_LIMIT)) || DEFAULT_LIMIT;
  const result = await checkAndIncrement(env, GLOBAL_BUCKET_ID, { limit, keyPrefix: KV_PREFIX });
  if (!result.allowed) return result;

  const spendLimit =
    Number(env.GLOBAL_DAILY_SPEND_LIMIT_USD ?? String(DEFAULT_SPEND_LIMIT_USD)) ||
    DEFAULT_SPEND_LIMIT_USD;
  try {
    const spend = (await env.STATSHELPR_KV.get(SPEND_KV_KEY, "json")) as StoredSpend | null;
    if (spend && spend.resetAt > Date.now() && spend.usd >= spendLimit) {
      return { ...result, allowed: false };
    }
  } catch {
    // KV read failure — fall through on the count decision alone rather than
    // 500 the solve; the count ceiling still bounds the day.
  }
  return result;
}

/** Adds one Gemini leg's real cost to the day's global spend record.
 *  Fire-and-forget from solve.ts right after each leg's usage arrives —
 *  never throws, never blocks the stream (same waitUntil pattern as
 *  lib/metrics-store.ts's recorders). Read-modify-write without CAS: see the
 *  module comment above for why a racy or dropped add is acceptable here. */
export function recordGlobalSpendInBackground(
  c: Context<{ Bindings: Env }>,
  costUsd: number,
): void {
  if (!(costUsd > 0)) return;
  const p = addGlobalSpend(c.env, costUsd);
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    // No executionCtx (tests/local edge cases) — the promise still runs.
  }
}

async function addGlobalSpend(env: Env, costUsd: number): Promise<void> {
  try {
    const now = Date.now();
    const raw = (await env.STATSHELPR_KV.get(SPEND_KV_KEY, "json")) as StoredSpend | null;
    const fresh = !raw || raw.resetAt < now;
    const resetAt = fresh ? now + 86_400_000 : raw.resetAt;
    const usd = (fresh ? 0 : raw.usd) + costUsd;
    const ttlSec = Math.max(60, Math.ceil((resetAt - now) / 1000));
    await env.STATSHELPR_KV.put(SPEND_KV_KEY, JSON.stringify({ usd, resetAt }), {
      expirationTtl: ttlSec + 60,
    });
  } catch {
    // Same-key write contention or transient KV failure — a lost add only
    // delays the trip by that call's cost; never surfaces to the caller.
  }
}
