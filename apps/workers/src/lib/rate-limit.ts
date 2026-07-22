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
 */

import type { Env } from "../types";

const KV_PREFIX = "rl:";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
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

export async function checkAndIncrement(
  env: Env,
  bucketId: string,
): Promise<RateLimitResult> {
  const limit = Number(env.FREE_TIER_DAILY_LIMIT ?? "5") || 5;
  const hash = await hashBucket(bucketId || "anon");
  const key = `${KV_PREFIX}${hash}`;
  const now = Date.now();

  const raw = await env.STATSHELPR_KV.get(key, "json") as {
    count: number;
    resetAt: number;
  } | null;

  // Expired or missing: reset to 1
  if (!raw || raw.resetAt < now) {
    const resetAt = now + 86_400_000;
    await env.STATSHELPR_KV.put(
      key,
      JSON.stringify({ count: 1, resetAt }),
      { expirationTtl: 86_400 + 60 },
    );
    return { allowed: true, count: 1, limit, resetAt };
  }

  // At or over cap
  if (raw.count >= limit) {
    return { allowed: false, count: raw.count, limit, resetAt: raw.resetAt };
  }

  // Increment
  const newCount = raw.count + 1;
  const ttlSec = Math.max(60, Math.ceil((raw.resetAt - now) / 1000));
  await env.STATSHELPR_KV.put(
    key,
    JSON.stringify({ count: newCount, resetAt: raw.resetAt }),
    { expirationTtl: ttlSec },
  );
  return { allowed: true, count: newCount, limit, resetAt: raw.resetAt };
}
