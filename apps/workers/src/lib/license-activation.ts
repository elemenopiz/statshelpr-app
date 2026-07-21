/**
 * Lemon Squeezy License API — activation binding (anti-sharing).
 *
 * Distinct from lib/license.ts (which only checks a key is valid/paid). This
 * module enforces that a PAID license is bound to exactly one install
 * (activation_limit = 1 on the LS product/variant), using the install id
 * (apps/extension/src/install-id.ts) as the LS activation "instance".
 *
 * LS License API (verified against docs.lemonsqueezy.com search snippets —
 * the docs site itself 403s bots — AND the official lemonsqueezy.js SDK
 * source, github.com/lmsqueezy/lemonsqueezy.js, src/license/{index,types}.ts):
 *
 *   POST https://api.lemonsqueezy.com/v1/licenses/activate
 *     body (form-urlencoded): license_key, instance_name
 *     200: { activated: true,  error: null, license_key: {..., activation_limit, activation_usage}, instance: {id, name, created_at}, meta }
 *     failure: { activated: false, error: "This license key has reached the activation limit.", license_key: {...}, meta }
 *
 *   POST https://api.lemonsqueezy.com/v1/licenses/validate
 *     body (form-urlencoded): license_key, instance_id?
 *     200: { valid: boolean, error, license_key, instance?, meta }
 *
 *   POST https://api.lemonsqueezy.com/v1/licenses/deactivate
 *     body (form-urlencoded): license_key, instance_id
 *     200: { deactivated: boolean, error, license_key, meta }
 *
 * None of the three require the store's secret API key (SDK calls $fetch
 * with needApiKey=false for all three — the license key itself is the
 * credential) and docs confirm plain `-d license_key=... -d instance_name=...`
 * curl examples with no Authorization header. We send our Bearer token
 * anyway (harmless, matches the existing lib/license.ts convention) but never
 * *require* it for these three calls.
 *
 * Duplicate-instance guard: LS's /activate does NOT dedupe by instance_name —
 * calling it twice for the same install creates two instances and burns two
 * activation slots (see github.com/lmsqueezy/lemonsqueezy.js/issues/22, and
 * the open feature request for a `unique_name` flag: lemonsqueezy.nolt.io/733).
 * If our own KV record of a prior activation is ever lost, blindly retrying
 * /activate would look identical to a genuine "another device" conflict and
 * could self-lock a paying customer out of their own single device. So on an
 * apparent at-limit response we double-check via the authenticated
 * license-key-instances list (filter by license_key_id, match by name) before
 * reporting atLimit — only ever needed on a cache miss, not the hot path.
 *
 * KV schema (never store raw license keys as *values* outside this file's
 * short-lived token use elsewhere; here we use hashed compound keys):
 *   activation:{sha256(licenseKey)}:{sha256(installId)} -> { instanceId, licenseKeyId?, activatedAt }
 *   activation-current:{sha256(licenseKey)}             -> { instanceId, installIdHash, activatedAt }
 * TTL 400 days, refreshed on every cache hit so an active subscriber's
 * binding never expires out from under them.
 */

import type { Env } from "../types";

export interface ActivationResult {
  ok: boolean;
  activated?: boolean;
  /** Another install already holds this license's single activation slot. */
  atLimit?: boolean;
  reason?: string;
}

const KV_ACTIVATION_PREFIX = "activation:";
const KV_CURRENT_PREFIX = "activation-current:";
const ACTIVATION_TTL_SEC = 400 * 86_400;

interface LsLicenseKey {
  id: number;
  activation_limit: number;
  activation_usage: number;
}

interface LsActivateResponse {
  activated: boolean;
  error: string | null;
  license_key?: LsLicenseKey;
  instance?: { id: string; name: string } | null;
}

interface LsDeactivateResponse {
  deactivated: boolean;
  error: string | null;
}

interface LsInstanceListResponse {
  data?: Array<{ attributes?: { identifier?: string; name?: string } }>;
}

interface StoredActivation {
  instanceId: string;
  licenseKeyId?: number;
  activatedAt: number;
}

interface StoredCurrent {
  instanceId: string;
  installIdHash: string;
  activatedAt: number;
}

/** Bind `licenseKey` to `installId`, activating with LS if not already done. */
export async function activateForInstall(
  env: Env,
  licenseKey: string,
  installId: string,
): Promise<ActivationResult> {
  // LS not configured -> dev mode, same bypass as validateLicense().
  if (!env.LEMONSQUEEZY_API_KEY) return { ok: true, activated: true };

  const name = installId || "anon";
  const licHash = await sha256Hex(licenseKey);
  const installHash = await sha256Hex(name);
  const kvKey = `${KV_ACTIVATION_PREFIX}${licHash}:${installHash}`;

  const cached = (await env.STATSHELPR_KV.get(kvKey, "json")) as StoredActivation | null;
  if (cached?.instanceId) {
    // Idempotent repeat for the same install — refresh TTL, skip LS entirely.
    await storeActivation(env, licHash, installHash, cached.instanceId, cached.licenseKeyId);
    return { ok: true, activated: true };
  }

  const act = await lsPost<LsActivateResponse>(env, "/v1/licenses/activate", {
    license_key: licenseKey,
    instance_name: name,
  });
  if (!act.ok) return { ok: false, reason: act.reason };

  const data = act.data;
  if (data.activated && data.instance?.id) {
    await storeActivation(env, licHash, installHash, data.instance.id, data.license_key?.id);
    return { ok: true, activated: true };
  }

  if (isAtLimitResponse(data) && data.license_key?.id) {
    const foundId = await findExistingInstanceByName(env, data.license_key.id, name);
    if (foundId) {
      // It's actually our own install — LS lost track of it (or our KV did).
      await storeActivation(env, licHash, installHash, foundId, data.license_key.id);
      return { ok: true, activated: true };
    }
    return { ok: false, atLimit: true, reason: data.error ?? "Activation limit reached" };
  }

  return { ok: false, reason: data.error ?? "License activation failed" };
}

/** Deactivate whatever install currently holds `licenseKey`'s activation slot. */
export async function deactivateCurrentInstance(
  env: Env,
  licenseKey: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!env.LEMONSQUEEZY_API_KEY) return { ok: true }; // dev mode, nothing bound

  const licHash = await sha256Hex(licenseKey);
  const currentKvKey = `${KV_CURRENT_PREFIX}${licHash}`;
  const current = (await env.STATSHELPR_KV.get(currentKvKey, "json")) as StoredCurrent | null;
  if (!current) return { ok: true }; // nothing activated — already in the reset state

  const deact = await lsPost<LsDeactivateResponse>(env, "/v1/licenses/deactivate", {
    license_key: licenseKey,
    instance_id: current.instanceId,
  });
  if (!deact.ok) return { ok: false, reason: deact.reason };

  const alreadyGone =
    !deact.data.deactivated && /not found|does not exist|invalid/i.test(deact.data.error ?? "");
  if (!deact.data.deactivated && !alreadyGone) {
    return { ok: false, reason: deact.data.error ?? "Deactivation failed" };
  }

  await env.STATSHELPR_KV.delete(`${KV_ACTIVATION_PREFIX}${licHash}:${current.installIdHash}`);
  await env.STATSHELPR_KV.delete(currentKvKey);
  return { ok: true };
}

function isAtLimitResponse(data: LsActivateResponse): boolean {
  const lk = data.license_key;
  if (lk && typeof lk.activation_usage === "number" && typeof lk.activation_limit === "number") {
    if (lk.activation_usage >= lk.activation_limit) return true;
  }
  return /activation limit/i.test(data.error ?? "");
}

async function findExistingInstanceByName(
  env: Env,
  licenseKeyId: number,
  instanceName: string,
): Promise<string | null> {
  const res = await lsGet<LsInstanceListResponse>(
    env,
    `/v1/license-key-instances?filter[license_key_id]=${encodeURIComponent(String(licenseKeyId))}`,
  );
  if (!res.ok) return null;
  const match = res.data.data?.find((d) => d.attributes?.name === instanceName);
  return match?.attributes?.identifier ?? null;
}

async function storeActivation(
  env: Env,
  licHash: string,
  installHash: string,
  instanceId: string,
  licenseKeyId?: number,
): Promise<void> {
  const now = Date.now();
  await env.STATSHELPR_KV.put(
    `${KV_ACTIVATION_PREFIX}${licHash}:${installHash}`,
    JSON.stringify({ instanceId, licenseKeyId, activatedAt: now }),
    { expirationTtl: ACTIVATION_TTL_SEC },
  );
  await env.STATSHELPR_KV.put(
    `${KV_CURRENT_PREFIX}${licHash}`,
    JSON.stringify({ instanceId, installIdHash: installHash, activatedAt: now }),
    { expirationTtl: ACTIVATION_TTL_SEC },
  );
}

/** POST to the LS License API (form-urlencoded; no API key required, but we send one). */
async function lsPost<T>(
  env: Env,
  path: string,
  params: Record<string, string>,
): Promise<{ ok: true; data: T } | { ok: false; reason: string }> {
  try {
    const res = await fetch(`https://api.lemonsqueezy.com${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${env.LEMONSQUEEZY_API_KEY ?? ""}`,
      },
      body: new URLSearchParams(params).toString(),
    });
    const data = (await res.json().catch(() => null)) as T | null;
    if (data === null) return { ok: false, reason: `LS API ${res.status}: unparseable response` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: `LS request failed: ${(e as Error).message}` };
  }
}

/** GET against the authenticated (Store API) side of LS — needed for the instance list lookup. */
async function lsGet<T>(
  env: Env,
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; reason: string }> {
  try {
    const res = await fetch(`https://api.lemonsqueezy.com${path}`, {
      headers: {
        Accept: "application/vnd.api+json",
        Authorization: `Bearer ${env.LEMONSQUEEZY_API_KEY ?? ""}`,
      },
    });
    const data = (await res.json().catch(() => null)) as T | null;
    if (!res.ok || data === null) return { ok: false, reason: `LS API ${res.status}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: `LS request failed: ${(e as Error).message}` };
  }
}

/** SHA-256 hash, truncated to 128 bits — matches the convention in lib/rate-limit.ts. */
async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
