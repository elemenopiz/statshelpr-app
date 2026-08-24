/**
 * KV-backed 24h rolling rate limiter, keyed on a hash of a caller-supplied
 * bucket id. The function itself is generic — it just hashes whatever bucket
 * string it's given — callers decide what identifies a "user".
 *
 * Free tier: N solves/day (from FREE_TIER_DAILY_LIMIT env). Paid tier: unlimited —
 * solve.ts skips this call entirely when validateLicense returns tier "paid".
 *
 * Free-tier bucketing: solve.ts buckets free users on their extension's
 * persistent install id (X-Install-Id header, see
 * apps/extension/src/install-id.ts and planning §4), so the free N/day cap
 * is per-install rather than one bucket shared across the whole user base.
 * Requests with no install id (older extension builds, or the header
 * stripped in transit) fall back to a shared "anon" bucket — safe, but those
 * callers are back to the old global-cap behavior until they upgrade.
 *
 * Security-audit follow-up (closing the unbounded-LLM-cost hole):
 *  - `checkAndIncrement` now takes an optional `{ limit, keyPrefix }` so the
 *    SAME get/put/recheck logic can back multiple independent counters —
 *    solve's per-install bucket (unchanged default), solve's per-IP backstop
 *    (see `getClientIp` below, wired in routes/solve.ts), and the global
 *    kill switch (lib/kill-switch.ts). Each caller passes its own
 *    `keyPrefix` so these never share a KV keyspace even when they hash the
 *    SAME raw bucket id. (The retired standalone /api/interpret route ran
 *    its own per-install + per-IP counters under separate prefixes on this
 *    same mechanism; the Cloud Run migration folded the interpret leg into
 *    /api/solve — docs/cloud-run-r-migration.md — so solve's gates now cover
 *    the whole request and those counters simply age out of KV.)
 *  - Added a best-effort optimistic recheck immediately before the
 *    increment-`put` (see the doc comment inside `checkAndIncrement`) to
 *    shrink — not eliminate — the read-modify-write race window.
 */

import type { Context } from "hono";
import type { Env } from "../types";

const KV_PREFIX = "rl:";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Overrides the default FREE_TIER_DAILY_LIMIT-derived limit — used by
   *  every bucket that isn't solve's original free-tier-per-install counter
   *  (that one keeps relying on the env-var default so its behavior is
   *  byte-for-byte unchanged). */
  limit?: number;
  /** Overrides the default "rl:" KV key prefix. Two counters that hash the
   *  SAME raw bucket id (e.g. solve's per-IP backstop vs. any future
   *  counter keyed on the same IP string) MUST use different prefixes or
   *  they'd silently share one KV entry — SHA-256 collision odds between
   *  *different* raw bucket ids (an install-id UUID vs an IP string) already
   *  make cross-purpose collisions astronomically unlikely on their own, but
   *  an explicit prefix costs nothing and keeps raw KV keys self-describing
   *  under `wrangler kv key list`. */
  keyPrefix?: string;
  /** Overrides the default 24h rolling window (86_400_000 ms) a bucket
   *  resets on. Every pre-existing caller omits this and keeps the original
   *  day-long window byte-for-byte unchanged (solve.ts's hot path has since
   *  moved to lib/counters-do.ts's doGate anyway; this file's own self-tests
   *  are the only other caller and don't pass it either). Added for
   *  routes/license-from-order.ts's per-IP lookup budget, which needs an
   *  hourly window, not a daily one — see that route's doc for why. */
  windowMs?: number;
}

interface StoredCount {
  count: number;
  resetAt: number;
}

/** SHA-256 the bucket id so we never store license keys / install ids raw in KV.
 *  Exported so lib/metrics-store.ts / routes/telemetry.ts can hash install ids
 *  with this EXACT same function — the metrics DAU/WAU install-hash set only
 *  dedupes correctly if server events (solve, its interpret leg included) and
 *  the client telemetry beacon hash the same install id to the same value. */
export async function hashBucket(bucketId: string): Promise<string> {
  const buf = new TextEncoder().encode(bucketId);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/**
 * Validates and normalizes a request's Origin header against Canvas's
 * school-subdomain shape, returning the bare hostname (e.g.
 * "utexas.instructure.com") on a match, or null for everything else —
 * missing header, wrong scheme, an extra subdomain level, a path/port/query
 * tacked on, or any other shape. The regex is anchored (^...$) so the WHOLE
 * (lowercased, length-capped) header must be exactly
 * `https://<1-63 lowercase alnum/hyphen chars>.instructure.com` — no partial
 * match, no trailing junk.
 *
 * Host-domain telemetry (2026-08, "are these organic users even UT
 * students?"): routes/solve.ts calls this ONCE per /api/solve request on the
 * Origin header the extension's content script's fetch() naturally carries
 * (the page's own Canvas origin — see apps/extension/src/content.ts's
 * onSolve, matched against *.instructure.com by manifest.json), then hashes
 * whatever this returns via hashBucket() above before it's ever used as a
 * metrics record key. An unvalidated Origin string must NEVER become that
 * key itself, raw or otherwise — this is the same class of hole the
 * gemini-9.9-ultra-pro client-string-poisoning incident exploited (an
 * attacker-controlled string reaching a metrics key). Every caller falls
 * back to a single fixed sentinel (lib/metrics-store.ts's HOST_HASH_OTHER)
 * on a null result, never the raw header.
 *
 * Pure/sync — no crypto, no Env — so it's independently unit-testable
 * (scripts/self-test-metrics.ts) without any KV/Context setup.
 */
const CANVAS_ORIGIN_MAX_CHARS = 100; // real instructure.com origins run ~30-45 chars; generous headroom before the regex even runs
const CANVAS_ORIGIN_RE = /^https:\/\/([a-z0-9-]{1,63}\.instructure\.com)$/;

export function extractCanvasHost(origin: string | null | undefined): string | null {
  if (!origin) return null;
  // Lowercase FIRST, then cap length — so the length bound applies to the
  // string the regex will actually see, regardless of any (rare) Unicode
  // case-folding expansion.
  const normalized = origin.toLowerCase().slice(0, CANVAS_ORIGIN_MAX_CHARS);
  const match = normalized.match(CANVAS_ORIGIN_RE);
  return match ? match[1]! : null;
}

/**
 * Best-effort client IP for the per-IP rate-limit backstop (defense-in-depth
 * against install-id rotation — the extension's install id is just
 * `crypto.randomUUID()` in chrome.storage.sync with no server issuance, see
 * apps/extension/src/install-id.ts, so a caller can trivially mint a fresh
 * one to reset the free-tier cap; an IP-keyed bucket doesn't reset with it).
 *
 * Cloudflare always sets CF-Connecting-IP at the edge for real internet
 * traffic reaching a Worker. Falls back to the first hop of X-Forwarded-For,
 * then a shared "unknown" bucket (same "safe but coarser" fallback pattern
 * as hashBucket's own "anon" default) for local dev or any request that
 * somehow arrives without either header.
 */
export function getClientIp(c: Context<{ Bindings: Env }>): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf;
  const xff = c.req.header("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || "unknown";
}

export async function checkAndIncrement(
  env: Env,
  bucketId: string,
  options?: RateLimitOptions,
): Promise<RateLimitResult> {
  const parsedDefault = Number(env.FREE_TIER_DAILY_LIMIT ?? "7");
  const defaultLimit = Number.isFinite(parsedDefault) && parsedDefault > 0 ? parsedDefault : 7;
  const limit = options?.limit ?? defaultLimit;
  const prefix = options?.keyPrefix ?? KV_PREFIX;
  const windowMs = options?.windowMs ?? 86_400_000;
  const hash = await hashBucket(bucketId || "anon");
  const key = `${prefix}${hash}`;
  const now = Date.now();

  const raw = (await env.STATSHELPR_KV.get(key, "json")) as StoredCount | null;

  // Expired or missing: reset to 1. No recheck here — a lost "first hit of
  // the window" race just means two near-simultaneous callers both start at
  // count 1 instead of 1-then-2, which self-corrects on either one's NEXT
  // increment (that path below IS recheck-guarded).
  if (!raw || raw.resetAt < now) {
    const resetAt = now + windowMs;
    await putCountFailOpen(env, key, { count: 1, resetAt }, Math.ceil(windowMs / 1000) + 60);
    return { allowed: true, count: 1, limit, resetAt };
  }

  // At or over cap — nothing to increment, no race to worry about (this
  // read is already the final word for this request either way).
  if (raw.count >= limit) {
    return { allowed: false, count: raw.count, limit, resetAt: raw.resetAt };
  }

  // --- optimistic recheck (security-audit item E) -------------------------
  // Plain Workers KV has no compare-and-swap. Without this recheck, two
  // requests hitting the SAME bucket within one KV round-trip of each other
  // both read the same `raw.count`, both compute the same `newCount`, and
  // the second `put` silently clobbers the first — an under-count (and
  // correspondingly, one extra request let through above the nominal limit)
  // bounded by however many requests actually raced. Re-reading right before
  // the write shrinks that window from "the ENTIRE first read → our write"
  // span down to just "this second read → our write": it can't eliminate
  // the race (still no CAS primitive to lean on), but it lets a
  // slightly-later request observe an in-between request's write instead of
  // blindly overwriting it with stale data. A real fix needs Durable
  // Objects (single-threaded, serialized access per key) or D1 (real
  // transactions) — deliberately NOT done here per the "don't over-engineer,
  // KV isn't strongly consistent" brief; this repo already accepts the same
  // trade-off for lib/metrics-store.ts's counters (see that file's doc
  // comment). The residual exposure from this race is bounded and small
  // (a handful of extra requests in the worst case, only when concurrent
  // requests land on the exact same bucket within milliseconds of each
  // other) — the actual backstop against unbounded volume regardless of any
  // single bucket's races is the global kill switch (lib/kill-switch.ts),
  // which is a separate, independent counter this same function also backs.
  const recheck = (await env.STATSHELPR_KV.get(key, "json")) as StoredCount | null;
  const latest = recheck && recheck.resetAt === raw.resetAt ? recheck : raw;

  if (latest.count >= limit) {
    return { allowed: false, count: latest.count, limit, resetAt: latest.resetAt };
  }

  const newCount = latest.count + 1;
  const ttlSec = Math.max(60, Math.ceil((latest.resetAt - now) / 1000));
  await putCountFailOpen(env, key, { count: newCount, resetAt: latest.resetAt }, ttlSec);
  return { allowed: true, count: newCount, limit, resetAt: latest.resetAt };
}

/**
 * KV put that swallows write failures instead of throwing (2026-07-29
 * capacity review, 30-simultaneous-users scenario). Workers KV allows only
 * ONE write per second to the SAME key — excess puts reject with a 429 — and
 * two of this module's counters are by design shared hot keys that a
 * classroom-sized burst WILL contend on: the kill switch's single global
 * bucket (lib/kill-switch.ts, incremented 1–3× per solve by every caller)
 * and the per-IP backstop (one bucket for a whole campus NAT). Before this
 * guard, the losing writes threw straight through routes/solve.ts's
 * route-level awaits (no app.onError in index.ts) and became bare 500s for
 * every student who lost the race.
 *
 * Failing OPEN is the right side to land on for these counters: the
 * enforcement decision was already made from the reads above (an over-limit
 * caller was rejected before any write was attempted — that path is
 * untouched), so a dropped increment only lets the count lag by the few
 * requests that raced in the same second. That's the same bounded undercount
 * the optimistic-recheck comment above already accepts from KV's missing
 * CAS, and the counter still advances at ≥1/sec under sustained load —
 * 86,400 potential increments/day dwarfs every configured ceiling, so caps
 * still trip on real volume. The alternative (fail closed) would turn one
 * second of write contention into user-visible errors, i.e. the counter
 * protecting the service by taking it down. Durable Objects remain the
 * exact-counting fix if it's ever worth it (see the recheck comment above).
 */
async function putCountFailOpen(
  env: Env,
  key: string,
  value: StoredCount,
  ttlSec: number,
): Promise<void> {
  try {
    await env.STATSHELPR_KV.put(key, JSON.stringify(value), { expirationTtl: ttlSec });
  } catch {
    // Same-key write contention (or any transient KV write failure) — count
    // lags slightly; never the caller's problem.
  }
}
