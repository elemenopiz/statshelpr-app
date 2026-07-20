/**
 * KV-backed 24h rolling rate limiter, keyed on a hash of the license key.
 *
 * Free tier: N solves/day (from FREE_TIER_DAILY_LIMIT env). Paid tier: unlimited
 * (skip the check). Currently every license goes through the counter — if we
 * add tier metadata later, skip based on tier.
 */

import type { Env } from "../types";

const KV_PREFIX = "rl:";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  resetAt: number;
}

/** SHA-256 the license key so we never store it raw in KV. */
async function hashLicense(licenseKey: string): Promise<string> {
  const buf = new TextEncoder().encode(licenseKey);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export async function checkAndIncrement(
  env: Env,
  licenseKey: string,
): Promise<RateLimitResult> {
  const limit = Number(env.FREE_TIER_DAILY_LIMIT ?? "5") || 5;
  const hash = await hashLicense(licenseKey || "anon");
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
