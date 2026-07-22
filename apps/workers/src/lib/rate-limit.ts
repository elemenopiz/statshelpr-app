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
 *    solve's per-install bucket (unchanged default), solve/interpret's new
 *    per-IP backstop (see `getClientIp` below, wired in routes/solve.ts +
 *    routes/interpret.ts), interpret's own independent per-install counter
 *    (routes/interpret.ts), and the global kill switch (lib/kill-switch.ts).
 *    Each caller passes its own `keyPrefix` so these never share a KV
 *    keyspace even though they may hash the SAME raw bucket id (e.g.
 *    interpret's per-install counter hashes the same install id solve's
 *    does, but under a different prefix — see routes/interpret.ts).
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
   *  SAME raw bucket id (e.g. interpret's per-install counter reusing the
   *  same install id solve's counter hashes) MUST use different prefixes or
   *  they'd silently share one KV entry — SHA-256 collision odds between
   *  *different* raw bucket ids (an install-id UUID vs an IP string) already
   *  make cross-purpose collisions astronomically unlikely on their own, but
   *  an explicit prefix costs nothing and keeps raw KV keys self-describing
   *  under `wrangler kv key list`. */
  keyPrefix?: string;
}

interface StoredCount {
  count: number;
  resetAt: number;
}

/** SHA-256 the bucket id so we never store license keys / install ids raw in KV.
 *  Exported so lib/metrics-store.ts / routes/telemetry.ts can hash install ids
 *  with this EXACT same function — the metrics DAU/WAU install-hash set only
 *  dedupes correctly if server events (solve/interpret) and the client
 *  telemetry beacon hash the same install id to the same value. */
export async function hashBucket(bucketId: string): Promise<string> {
  const buf = new TextEncoder().encode(bucketId);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
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
  const limit = options?.limit ?? (Number(env.FREE_TIER_DAILY_LIMIT ?? "5") || 5);
  const prefix = options?.keyPrefix ?? KV_PREFIX;
  const hash = await hashBucket(bucketId || "anon");
  const key = `${prefix}${hash}`;
  const now = Date.now();

  const raw = (await env.STATSHELPR_KV.get(key, "json")) as StoredCount | null;

  // Expired or missing: reset to 1. No recheck here — a lost "first hit of
  // the window" race just means two near-simultaneous callers both start at
  // count 1 instead of 1-then-2, which self-corrects on either one's NEXT
  // increment (that path below IS recheck-guarded).
  if (!raw || raw.resetAt < now) {
    const resetAt = now + 86_400_000;
    await env.STATSHELPR_KV.put(key, JSON.stringify({ count: 1, resetAt }), {
      expirationTtl: 86_400 + 60,
    });
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
  await env.STATSHELPR_KV.put(key, JSON.stringify({ count: newCount, resetAt: latest.resetAt }), {
    expirationTtl: ttlSec,
  });
  return { allowed: true, count: newCount, limit, resetAt: latest.resetAt };
}
