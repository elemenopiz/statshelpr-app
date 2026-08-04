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
 * Checked in routes/solve.ts before EACH LLM provider call it makes (Luna
 * primary or the Gemini fallback leg — see lib/llm.ts), individually —
 * not once per request. A concept question makes one (the first pass, right
 * after the per-caller auth/license/rate-limit gates and immediately before
 * the Gemini stream). A calc question can make up to three, each gated here
 * separately right before it fires: the first pass, an optional R-repair
 * retry, and the interpret pass (the latter two used to be the separate
 * /api/interpret route's own single call — see
 * docs/cloud-run-r-migration.md §3 — that route is gone; both are now
 * internal continuations of the one /api/solve request, but the PER-CALL
 * checkpoint is preserved so the global ceiling still bounds worst-case
 * provider spend the same way it did when solve and interpret were separate
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
 * Default GLOBAL_DAILY_CALL_LIMIT = 1000 (every provider call/day — Luna or
 * Gemini-fallback; the $0.08/call pessimistic bound below still holds
 * post-Luna-swap because the priciest path is the Gemini IMAGE fallback at
 * ~$0.075/call — across all
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
import type { RateLimitResult } from "./rate-limit";
import { doGate, doAddSpendInBackground, doSetConfig, type IncrItem } from "./counters-do";

const DEFAULT_LIMIT = 1000;

// --- dollar ceiling (2026-07-29 capacity review) ---------------------------
// The call-count ceiling above bounds VOLUME, but its dollar meaning depends
// on a pessimistic per-call cost assumption ($0.08 — see the sizing comment
// above). This second, independent bound caps the ACTUAL dollars: solve.ts
// reports each Gemini leg's real costUsd (lib/cost.ts rates on the usage
// counts Gemini returned) into the spend row, and checkGlobalKillSwitch
// refuses further calls once the day's accumulated spend crosses
// GLOBAL_DAILY_SPEND_LIMIT_USD. Between the two, an abuser can't win either
// way: many cheap calls trip the count first, few stuffed calls trip this
// first — so the worst possible day costs ~the spend cap plus in-flight
// overshoot (calls already streaming when the trip lands; bounded by
// concurrency × worst per-call cost, single-digit dollars).
//
// STORAGE MOVED (DO switch, same day): both the call counter and the spend
// row now live in lib/counters-do.ts's CountersDO — serialized, exact, no
// KV write-cap or same-key-contention exposure. The old KV records
// (`ks:<hash>`, `ks$:spend`) simply age out via their TTLs; nothing migrates
// (a daily counter's history isn't worth carrying across a storage move —
// worst case the ceilings restart mid-day once, on deploy day). The key
// STRINGS are kept for continuity in the DO's table.
export const GLOBAL_CALLS_KEY = "ks:global";
export const GLOBAL_SPEND_KEY = "ks$:spend";
const DEFAULT_SPEND_LIMIT_USD = 25;

export const KILL_SWITCH_MESSAGE =
  "statshelpr is temporarily over its daily request volume ceiling. Please try again later.";

export function globalCallLimit(env: Env): number {
  return Number(env.GLOBAL_DAILY_CALL_LIMIT ?? String(DEFAULT_LIMIT)) || DEFAULT_LIMIT;
}

/** The FLOOR of the effective spend ceiling — see the "subscriber-scaled
 *  global spend ceiling" section below for the full formula. This function's
 *  name/signature are unchanged (existing callers, including
 *  checkGlobalKillSwitch below, are still correct passing this straight
 *  through as GateSpend.limitUsd) — it's the MEANING that changed: this is
 *  no longer necessarily the enforced ceiling by itself, only its lower
 *  bound. At 0 active subscribers (or whenever the cron-computed value is
 *  missing/stale/corrupt) the effective ceiling IS this value, so existing
 *  behavior is byte-identical until there's a paying base to scale from. */
export function globalSpendLimitUsd(env: Env): number {
  return (
    Number(env.GLOBAL_DAILY_SPEND_LIMIT_USD ?? String(DEFAULT_SPEND_LIMIT_USD)) ||
    DEFAULT_SPEND_LIMIT_USD
  );
}

// --- subscriber-scaled global spend ceiling (owner directive, 2026-08-04:
// "shouldn't be a thing, should scale") ---------------------------------
//
// globalSpendLimitUsd above is now only the FLOOR of the ceiling actually
// enforced. The full formula:
//
//   effective ceiling = max(globalSpendLimitUsd(env), activeSubscribers × perSubDailySpendUsd(env))
//
// computeEffectiveSpendLimitUsd evaluates this PURE arithmetic (no I/O — see
// its own doc for why that's deliberate). persistEffectiveSpendLimit wraps
// it with the actual write: called ONCE/DAY from src/index.ts's scheduled
// cron (never the request path — activeSubscribers comes from
// lib/metrics-load.ts's countActiveSubscribers, an O(subscriber-count) KV
// scan too expensive to repeat per-solve), it persists the computed number
// into the SAME CountersDO instance the hot gate already round-trips for
// its other counters, via counters-do.ts's setConfig op.
//
// The READ side lives entirely inside CountersDO.resolveSpendLimit (see
// that file): checkGlobalKillSwitch below and routes/solve.ts's own inline
// doGate call both pass `cfgKey: GLOBAL_SPEND_LIMIT_CFG_KEY` alongside the
// FLOOR as `limitUsd` — the DO resolves `max(limitUsd, freshConfigRow)`
// internally, as part of the SAME fetch those call sites already make. Zero
// extra subrequests on the hot path.
//
// Staleness / fail-safe: SPEND_LIMIT_STALENESS_MS (48h — one full missed
// cron tick of slack past the normal 24h cadence) is how long a persisted
// value stays "fresh" before CountersDO.resolveSpendLimit stops trusting it
// and silently falls back to the floor alone. Missing (never computed —
// e.g. brand new deploy before the first cron tick), stale (cron broken for
// >48h), or corrupt (setConfig already refuses to persist a
// non-finite/non-positive value, but this is defense in depth) all collapse
// to the SAME safe outcome: the floor. The ceiling can therefore never end
// up missing, corrupt, or unlimited — only "at least the floor" — matching
// the existing hard-breaker's own "never unlimited" contract.
const DEFAULT_PER_SUB_DAILY_SPEND_USD = 2;
export const GLOBAL_SPEND_LIMIT_CFG_KEY = "ks$:spendLimit:cfg";
export const SPEND_LIMIT_STALENESS_MS = 2 * 86_400_000; // 48h

export function perSubDailySpendUsd(env: Env): number {
  return (
    Number(env.PER_SUB_DAILY_SPEND_USD ?? String(DEFAULT_PER_SUB_DAILY_SPEND_USD)) ||
    DEFAULT_PER_SUB_DAILY_SPEND_USD
  );
}

/** Pure formula — no Env I/O beyond reading the two already-synchronous env
 *  vars above, no DO/KV access — so scripts/self-test-security.ts can
 *  exercise the arithmetic (including the floor/scaled crossover) directly,
 *  the same testability reasoning lib/metrics-store.ts's applyServerEvent
 *  etc. already follow. Negative/garbage subscriber counts (should never
 *  happen — countActiveSubscribers only ever counts real KV records — but
 *  this is cheap insurance) are floored at 0 rather than allowed to pull the
 *  ceiling below the floor. */
export function computeEffectiveSpendLimitUsd(env: Env, activeSubscribers: number): number {
  const floor = globalSpendLimitUsd(env);
  const scaled = Math.max(0, activeSubscribers) * perSubDailySpendUsd(env);
  return Math.max(floor, scaled);
}

/** Computes AND persists the effective ceiling — the one function
 *  src/index.ts's scheduled cron actually calls, once/day. See the section
 *  doc above for the full read/write flow. Never throws (doSetConfig's own
 *  contract): a failed persist just means CountersDO.resolveSpendLimit keeps
 *  using whatever was there before (or the floor, if this has never once
 *  succeeded) until tomorrow's tick. Returns the computed value so the cron
 *  can log it. */
export async function persistEffectiveSpendLimit(env: Env, activeSubscribers: number): Promise<number> {
  const value = computeEffectiveSpendLimitUsd(env, activeSubscribers);
  await doSetConfig(env, GLOBAL_SPEND_LIMIT_CFG_KEY, value, SPEND_LIMIT_STALENESS_MS);
  return value;
}

/** Checks AND increments the global daily counter in one call — an "allowed"
 *  result has already been counted, so the caller should call this once per
 *  GEMINI CALL, not once per REQUEST (routes/solve.ts calls this before the
 *  repair and interpret legs — see the module doc above), immediately before
 *  doing that call's Gemini-bound work, and 503 immediately on `!allowed`
 *  without incrementing anything else or making the call. Also refuses when
 *  the day's accumulated REAL spend (recordGlobalSpendInBackground below)
 *  has crossed the dollar ceiling — one gate, two independent bounds.
 *
 *  (The FIRST leg's check no longer comes through here: routes/solve.ts
 *  folds it into its single combined doGate call together with the per-IP
 *  and per-install checks, using the same GLOBAL_CALLS_KEY/GLOBAL_SPEND_KEY
 *  rows — one DO round trip instead of three sequential KV gates.) */
export async function checkGlobalKillSwitch(env: Env): Promise<RateLimitResult> {
  const limit = globalCallLimit(env);
  const gate = await doGate(env, [{ key: GLOBAL_CALLS_KEY, limit }], {
    key: GLOBAL_SPEND_KEY,
    limitUsd: globalSpendLimitUsd(env),
    // Subscriber-scaled ceiling override (2026-08-04) — see the section doc
    // above. CountersDO resolves max(limitUsd, this cfg row) internally, in
    // the SAME fetch, so this adds no extra subrequest here either.
    cfgKey: GLOBAL_SPEND_LIMIT_CFG_KEY,
  });
  const r = gate.results[0];
  return {
    allowed: gate.allowed,
    count: r?.count ?? 0,
    limit,
    resetAt: r?.resetAt ?? Date.now() + 86_400_000,
  };
}

/** Adds one Gemini leg's real cost to the day's global spend row in the
 *  CountersDO. Fire-and-forget from solve.ts right after each leg's usage
 *  arrives — never throws, never blocks the stream. Exact within the DO
 *  (serialized), best-effort across the wire: a lost add only delays the
 *  trip by that call's cost; never surfaces to the caller. */
export function recordGlobalSpendInBackground(
  c: Context<{ Bindings: Env }>,
  costUsd: number,
): void {
  doAddSpendInBackground(c, GLOBAL_SPEND_KEY, costUsd);
}

// =============================================================================
// --- paid-tier soft cap (owner directive, 2026-08-04) -----------------------
// =============================================================================
// Distinct in kind from every breaker above: this NEVER blocks a paid solve.
// Paid stays genuinely unlimited (see routes/solve.ts's
// `if (lic.tier !== "paid")` gate — the hard per-IP/per-install caps skip
// paid callers entirely, unchanged by this section). This exists purely as
// a fair-use throttle for the rare paid install that's WAY outside normal
// usage: past a generous daily or monthly threshold, each solve gets a
// short server-side delay (PAID_SOFT_THROTTLE_DELAY_MS) instead of an
// instant answer — silent to the ~100% of paying users who never come close.
//
// Metering is exact (CountersDO, serialized) but the counting itself is
// NEVER blocking or fail-closed — see doGate's fail-open contract
// (counters-do.ts): a counters outage just means this request isn't
// throttled (decidePaidSoftThrottle below sees a fabricated {count: 0} and
// returns throttle: false), same fail-open stance as the hard breakers'
// own DO calls one section up.
//
// Thresholds are deliberately generous relative to the documented heavy-user
// assumption (AVG_SOLVES_PER_USER_PER_MONTH = 110, wrangler.toml): 100/day
// is most of a full heavy-use MONTH in one day, and 600/month is ~5.5x that
// same monthly assumption while still keeping the margin floor the owner
// asked for (600 x ~$0.017/solve ~= $10.20, under the $15/mo price). Both
// are one-line tunable HERE — deliberately plain TS constants, not
// wrangler.toml vars, per the brief: these are product/fair-use judgment
// calls to revisit in code review, not infra ceilings the owner needs to
// redeploy-tune independently of that review.
export const PAID_DAILY_SOFT_THRESHOLD = 100;
export const PAID_MONTHLY_SOFT_THRESHOLD = 600;
export const PAID_SOFT_THROTTLE_DELAY_MS = 15_000;

function paidDailyKey(installHash: string): string {
  return `paid:d:${installHash}`;
}
function paidMonthlyKey(installHash: string): string {
  return `paid:m:${installHash}`;
}

/** Start of the NEXT UTC calendar month, in ms — Date.UTC rolls month=12
 *  over into January of the following year on its own, so this needs no
 *  manual year-wrap handling. Used as the monthly counter's `resetAtIfFresh`
 *  (see IncrItem's doc in counters-do.ts): a calendar-month window, not a
 *  rolling 30-day one, per the brief ("Monthly window = calendar month
 *  UTC"). */
function startOfNextUtcMonthMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

export interface PaidSoftCapIncrItems {
  daily: IncrItem;
  monthly: IncrItem;
}

/** Builds the two `incr` items routes/solve.ts folds into its existing
 *  combined doGate call for a paid solve (see that call site) — one MORE DO
 *  round trip would also satisfy the brief's "counted per SOLVE REQUEST,
 *  metered in CountersDO" requirement, but riding the SAME fetch the gate
 *  already makes is strictly cheaper and this codebase's established
 *  pattern (see doGate's own module doc: "ONE CountersDO round trip
 *  replacing what used to be three sequential KV counters"). Keyed on the
 *  install hash — the SAME hashBucket(installId) solve.ts already computes
 *  for the free-tier per-install counter — under a DISJOINT key prefix
 *  (`paid:d:`/`paid:m:` vs. free tier's `rl:`) so a free-tier and paid-tier
 *  count for the same physical install never share a row even if the
 *  install later upgrades. */
export function buildPaidSoftCapIncrItems(installHash: string): PaidSoftCapIncrItems {
  const now = Date.now();
  return {
    daily: { key: paidDailyKey(installHash), resetAtIfFresh: now + 86_400_000 },
    monthly: { key: paidMonthlyKey(installHash), resetAtIfFresh: startOfNextUtcMonthMs(now) },
  };
}

export interface PaidSoftCapDecision {
  throttle: boolean;
  reason?: "daily" | "monthly";
}

/** Pure decision function — given the two POST-INCREMENT counts from the
 *  SAME doGate round trip solve.ts already makes (buildPaidSoftCapIncrItems
 *  above), decides whether THIS request should be throttled and which
 *  threshold caused it. Daily is checked first (matches the free-tier
 *  gate's own IP-before-install precedence convention in routes/solve.ts) —
 *  a request past BOTH thresholds in the same call reports "daily", not
 *  "monthly"; the monthly counter still incremented correctly regardless,
 *  this only affects which single reason gets recorded.
 *
 *  "Past it" = strictly greater than the threshold: the 100th daily solve
 *  is normal, un-throttled service, and the 101st is the first throttled
 *  one (matches "100 solves/day" reading as an allowance, not a trigger
 *  value). No Env/DO dependency — exported standalone so
 *  scripts/self-test-security.ts can exercise the arithmetic directly,
 *  same testability precedent as computeEffectiveSpendLimitUsd above. */
export function decidePaidSoftThrottle(dailyCount: number, monthlyCount: number): PaidSoftCapDecision {
  if (dailyCount > PAID_DAILY_SOFT_THRESHOLD) return { throttle: true, reason: "daily" };
  if (monthlyCount > PAID_MONTHLY_SOFT_THRESHOLD) return { throttle: true, reason: "monthly" };
  return { throttle: false };
}
