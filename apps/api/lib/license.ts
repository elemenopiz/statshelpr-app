/**
 * Lemon Squeezy license-key validator with in-memory result caching.
 *
 * LS API:
 *   POST https://api.lemonsqueezy.com/v1/licenses/validate
 *   body: { license_key, instance_name? }
 *   returns: { valid: boolean, license_key: { status, ... }, meta: { ... } }
 */

interface CacheEntry {
  ok: boolean;
  reason?: string;
  expiresAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const cache = new Map<string, CacheEntry>();

export interface LicenseCheck {
  ok: boolean;
  reason?: string;
}

export async function validateLicense(licenseKey: string): Promise<LicenseCheck> {
  const apiKey = process.env["LEMONSQUEEZY_API_KEY"];
  const expectedStoreId = process.env["LEMONSQUEEZY_STORE_ID"];
  const expectedVariantId = process.env["LEMONSQUEEZY_VARIANT_ID"];

  // If LS isn't configured, allow access (dev mode). Production should set these.
  if (!apiKey) {
    return { ok: true, reason: "LS_NOT_CONFIGURED" };
  }

  if (!licenseKey) return { ok: false, reason: "Missing license key" };

  const cached = cache.get(licenseKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: cached.ok, reason: cached.reason };
  }

  try {
    const res = await fetch("https://api.lemonsqueezy.com/v1/licenses/validate", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${apiKey}`,
      },
      body: new URLSearchParams({ license_key: licenseKey }).toString(),
    });

    if (!res.ok) {
      const reason = `LS API ${res.status}`;
      put(licenseKey, false, reason);
      return { ok: false, reason };
    }

    const json = (await res.json()) as {
      valid: boolean;
      error?: string;
      license_key?: { status: string };
      meta?: { store_id?: number; variant_id?: number };
    };

    if (!json.valid) {
      const reason = json.error ?? "License invalid";
      put(licenseKey, false, reason);
      return { ok: false, reason };
    }

    if (json.license_key?.status !== "active") {
      const reason = `License status: ${json.license_key?.status ?? "unknown"}`;
      put(licenseKey, false, reason);
      return { ok: false, reason };
    }

    if (expectedStoreId && String(json.meta?.store_id ?? "") !== expectedStoreId) {
      const reason = "License from wrong store";
      put(licenseKey, false, reason);
      return { ok: false, reason };
    }

    if (expectedVariantId && String(json.meta?.variant_id ?? "") !== expectedVariantId) {
      const reason = "License for wrong product";
      put(licenseKey, false, reason);
      return { ok: false, reason };
    }

    put(licenseKey, true);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `LS check failed: ${(e as Error).message}` };
  }
}

function put(key: string, ok: boolean, reason?: string) {
  cache.set(key, { ok, reason, expiresAt: Date.now() + CACHE_TTL_MS });
}
