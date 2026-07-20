/**
 * Lemon Squeezy license-key validator, KV-backed cache.
 *
 * On Workers, we cache validation results in KV so cold starts don't re-hit
 * LS. TTL 10 min. If LS isn't configured (no API key), we allow access — good
 * for local dev, must set the key in prod.
 *
 * LS API:
 *   POST https://api.lemonsqueezy.com/v1/licenses/validate
 *   body: { license_key, instance_name? }
 *   returns: { valid: boolean, license_key: { status, ... }, meta: { ... } }
 */

import type { Env } from "../types";

export interface LicenseCheck {
  ok: boolean;
  reason?: string;
}

const CACHE_TTL_SEC = 10 * 60; // 10 min
const KV_PREFIX = "license:";

export async function validateLicense(
  env: Env,
  licenseKey: string,
): Promise<LicenseCheck> {
  const apiKey = env.LEMONSQUEEZY_API_KEY;

  // If LS isn't configured, allow access (dev mode). Production must set.
  if (!apiKey) {
    return { ok: true, reason: "LS_NOT_CONFIGURED" };
  }

  if (!licenseKey) return { ok: false, reason: "Missing license key" };

  // Check KV cache first
  const cacheKey = `${KV_PREFIX}${licenseKey}`;
  const cached = await env.STATSHELPR_KV.get(cacheKey, "json");
  if (cached) {
    return cached as LicenseCheck;
  }

  try {
    const res = await fetch(
      "https://api.lemonsqueezy.com/v1/licenses/validate",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${apiKey}`,
        },
        body: new URLSearchParams({ license_key: licenseKey }).toString(),
      },
    );

    if (!res.ok) {
      const result: LicenseCheck = { ok: false, reason: `LS API ${res.status}` };
      await putCache(env, cacheKey, result);
      return result;
    }

    const json = (await res.json()) as {
      valid: boolean;
      error?: string;
      license_key?: { status: string };
      meta?: { store_id?: number; variant_id?: number };
    };

    let result: LicenseCheck;
    if (!json.valid) {
      result = { ok: false, reason: json.error ?? "License invalid" };
    } else if (json.license_key?.status !== "active") {
      result = {
        ok: false,
        reason: `License status: ${json.license_key?.status ?? "unknown"}`,
      };
    } else if (
      env.LEMONSQUEEZY_STORE_ID &&
      String(json.meta?.store_id ?? "") !== env.LEMONSQUEEZY_STORE_ID
    ) {
      result = { ok: false, reason: "License from wrong store" };
    } else if (
      env.LEMONSQUEEZY_VARIANT_ID &&
      String(json.meta?.variant_id ?? "") !== env.LEMONSQUEEZY_VARIANT_ID
    ) {
      result = { ok: false, reason: "License for wrong product" };
    } else {
      result = { ok: true };
    }

    await putCache(env, cacheKey, result);
    return result;
  } catch (e) {
    return { ok: false, reason: `LS check failed: ${(e as Error).message}` };
  }
}

async function putCache(env: Env, key: string, result: LicenseCheck) {
  await env.STATSHELPR_KV.put(key, JSON.stringify(result), {
    expirationTtl: CACHE_TTL_SEC,
  });
}

/** Invalidate a cached license entry (e.g. from webhook on cancel). */
export async function invalidateLicense(env: Env, licenseKey: string) {
  await env.STATSHELPR_KV.delete(`${KV_PREFIX}${licenseKey}`);
}
