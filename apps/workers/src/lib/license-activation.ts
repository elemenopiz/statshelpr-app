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
 *   activation:{h(licenseKey)}:{h(installId)} -> { instanceId, licenseKeyId?, activatedAt }
 *   activation-current:{h(licenseKey)}        -> { instanceId, installIdHash, activatedAt }
 * TTL 400 days, refreshed on every cache hit so an active subscriber's
 * binding never expires out from under them.
 *
 * `h` = activationHash() below: HMAC-SHA-256 keyed on ACTIVATION_HASH_SECRET,
 * NOT a bare digest. This hash space is deliberately DISJOINT from the
 * metrics/rate-limit hash space (lib/rate-limit.ts's hashBucket, whose values
 * land in lib/metrics-store.ts's per-day `installHashes` presence sets).
 *
 * Why that matters (privacy fix, 2026-07-27): both functions used to be a
 * byte-identical unsalted `sha256(x).slice(0,32)`, so the install hash inside
 * an `activation:` key was the SAME string that appears in the daily
 * `installHashes` sets. Anyone holding a raw license key — which is also the
 * lookup value of the `license:{key}` record, and that record carries the
 * buyer's email — could recompute the matching install hash offline and read
 * off exactly which days that named, paying customer was active. Keying this
 * side with a secret breaks that join: without ACTIVATION_HASH_SECRET the
 * activation-side hash of an install id is not computable from the license
 * key (or from anything else an attacker holds), so the two key spaces can no
 * longer be correlated. hashBucket stays unkeyed on purpose — it must stay
 * reproducible across the solve path and the client telemetry beacon so DAU
 * dedupe works, and it never touches license keys.
 *
 * Migration (these keys have a 400-day TTL, so live paying customers WILL
 * have records under the old unsalted hash): every read here falls through to
 * the legacy unsalted key on a miss, re-writes the record under the new keyed
 * hash, and deletes the legacy one — see legacyActivationHash() and
 * readLegacyActivation() at the bottom. Nobody is logged out and no extra LS
 * /activate call is made; a migrating install just does one extra KV read on
 * its first request after deploy. Legacy records that are never touched again
 * simply age out on their existing TTL.
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
/** Same key space lib/license.ts writes/reads (`license:{key}`) — read here
 *  only to detect the dev-license flag that skips LS activation. */
const LICENSE_PREFIX = "license:";
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

  // Dev/test licenses: a `license:{key}` KV record seeded directly (with
  // `{"dev":true}`) that LemonSqueezy never sold. Calling LS /activate for
  // such a key returns "license_key not found" and would 403 an otherwise
  // valid paid solve. These skip activation entirely (no single-device
  // binding — they're for internal testing across devices). Safe because the
  // only way to get one is a manual `wrangler kv key put` with the dev flag;
  // a real buyer's key never has it, so real single-device enforcement is
  // unchanged. validateLicense() already returns tier:"paid" for the same
  // record. See the founder's test-access provisioning, 2026-07-23.
  const licRecord = (await env.STATSHELPR_KV.get(`${LICENSE_PREFIX}${licenseKey}`, "json")) as
    | { dev?: boolean }
    | null;
  if (licRecord?.dev === true) return { ok: true, activated: true };

  // Fail closed, same contract as R_RUNNER_SECRET / METRICS_TOKEN /
  // DASHBOARD_PASSWORD: no secret means we cannot compute the keyed hash, and
  // silently dropping back to the unsalted digest would quietly re-open the
  // correlation hole this module's header describes. Dev licenses (above) and
  // the whole LS-unconfigured dev path (further above) both return before
  // here, so this only ever bites a real deploy that skipped the secret.
  if (!env.ACTIVATION_HASH_SECRET) {
    return { ok: false, reason: "Activation not configured (ACTIVATION_HASH_SECRET unset)" };
  }

  const name = installId || "anon";
  const licHash = await activationHash(env, licenseKey);
  const installHash = await activationHash(env, name);
  const kvKey = `${KV_ACTIVATION_PREFIX}${licHash}:${installHash}`;

  let cached = (await env.STATSHELPR_KV.get(kvKey, "json")) as StoredActivation | null;
  // Miss under the keyed hash: this install may predate the keyed-hash
  // migration and still hold a live record under the legacy unsalted key.
  // Read it through instead of calling LS /activate, which would burn a
  // second activation slot for the same device and could self-lock a paying
  // customer out — the exact failure the duplicate-instance guard in this
  // file's header warns about.
  let legacy: LegacyActivation | null = null;
  if (!cached) {
    legacy = await readLegacyActivation(env, licenseKey, name);
    cached = legacy?.record ?? null;
  }
  if (cached?.instanceId) {
    // Idempotent repeat for the same install — refresh TTL, skip LS entirely.
    await storeActivation(env, licHash, installHash, cached.instanceId, cached.licenseKeyId);
    // Retire the legacy keys only now that the record is safely stored under
    // the keyed hash — never the other way round. (Even if this Worker died
    // between the two, the next request would miss both keys, call LS, and be
    // recovered by findExistingInstanceByName below, which matches the LS
    // instance by our install-id name. Ordering it this way means that
    // recovery path is never needed in the first place.)
    if (legacy) await deleteLegacyActivation(env, legacy);
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
  if (!env.ACTIVATION_HASH_SECRET) {
    return { ok: false, reason: "Activation not configured (ACTIVATION_HASH_SECRET unset)" };
  }

  // Resolve the binding in the keyed hash space first, then fall back to the
  // legacy unsalted one. `licHash` tracks whichever space we actually FOUND
  // the record in, because the record's own `installIdHash` was written in
  // that same space — mixing the two would delete nothing and leave a stale
  // binding behind, which would make the customer's next device look
  // at-limit. Nothing is migrated here: this path is deleting the record, so
  // rewriting it under the new hash first would be pure waste.
  let licHash = await activationHash(env, licenseKey);
  let current = (await env.STATSHELPR_KV.get(
    `${KV_CURRENT_PREFIX}${licHash}`,
    "json",
  )) as StoredCurrent | null;
  if (!current) {
    const legacyLicHash = await legacyActivationHash(licenseKey);
    const legacyCurrent = (await env.STATSHELPR_KV.get(
      `${KV_CURRENT_PREFIX}${legacyLicHash}`,
      "json",
    )) as StoredCurrent | null;
    if (legacyCurrent) {
      licHash = legacyLicHash;
      current = legacyCurrent;
    }
  }
  const currentKvKey = `${KV_CURRENT_PREFIX}${licHash}`;
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

function toHex128(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** Importing the HMAC key costs a crypto.subtle round-trip, and we hash two
 *  values (license key + install id) per activation. Workers isolates are
 *  reused across requests, so memoizing the CryptoKey on the secret it was
 *  derived from is safe and cuts that in half; the secret is compared so a
 *  rotated secret can never be served a stale key. */
let hmacKeyCache: { secret: string; key: Promise<CryptoKey> } | null = null;

function activationHmacKey(secret: string): Promise<CryptoKey> {
  if (hmacKeyCache?.secret === secret) return hmacKeyCache.key;
  const key = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  hmacKeyCache = { secret, key };
  return key;
}

/**
 * Keyed hash for every activation KV key, truncated to 128 bits.
 *
 * HMAC-SHA-256 under ACTIVATION_HASH_SECRET rather than a bare digest, so
 * this module's hash space cannot be joined to lib/rate-limit.ts's unkeyed
 * hashBucket (and therefore to lib/metrics-store.ts's daily `installHashes`
 * presence sets) by anyone holding a raw license key — see the module header
 * for the full attack this closes. Do NOT "simplify" this back to
 * crypto.subtle.digest: matching hashBucket's output is precisely the bug.
 *
 * Exported only so scripts/self-test-security.ts can assert the two hash
 * spaces stay disjoint; nothing else should call it.
 */
export async function activationHash(env: Env, input: string): Promise<string> {
  const secret = env.ACTIVATION_HASH_SECRET;
  if (!secret) throw new Error("ACTIVATION_HASH_SECRET unset");
  const key = await activationHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return toHex128(sig);
}

/**
 * The pre-2026-07-27 unsalted hash — byte-identical to lib/rate-limit.ts's
 * hashBucket, which is exactly why it was replaced. MIGRATION ONLY: it exists
 * so live records written before the keyed-hash cutover can still be found
 * and retired (see readLegacyActivation). Never write a new key with it.
 *
 * Exported only for scripts/self-test-security.ts, which asserts it still
 * matches hashBucket — that equality is what proves the read-through fallback
 * actually lands on the old keys rather than silently missing them.
 */
export async function legacyActivationHash(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  return toHex128(await crypto.subtle.digest("SHA-256", buf));
}

interface LegacyActivation {
  record: StoredActivation;
  /** The legacy `activation:{lic}:{install}` key this came from. */
  activationKey: string;
  /** The matching legacy `activation-current:{lic}` key. */
  currentKey: string;
}

/**
 * Look up a pre-migration activation record under the legacy unsalted keys.
 * Pure read — the caller re-stores the record under the keyed hash first and
 * only then calls deleteLegacyActivation, so the binding is never briefly
 * absent from KV. Returns null when there is nothing to migrate, which is the
 * steady state once every active install has made one request post-deploy.
 */
async function readLegacyActivation(
  env: Env,
  licenseKey: string,
  installName: string,
): Promise<LegacyActivation | null> {
  const legacyLicHash = await legacyActivationHash(licenseKey);
  const legacyInstallHash = await legacyActivationHash(installName);
  const activationKey = `${KV_ACTIVATION_PREFIX}${legacyLicHash}:${legacyInstallHash}`;
  const record = (await env.STATSHELPR_KV.get(activationKey, "json")) as StoredActivation | null;
  if (!record?.instanceId) return null;
  return { record, activationKey, currentKey: `${KV_CURRENT_PREFIX}${legacyLicHash}` };
}

/** Drop both legacy keys once the record has been re-stored under the keyed
 *  hash, completing the move. */
async function deleteLegacyActivation(env: Env, legacy: LegacyActivation): Promise<void> {
  await env.STATSHELPR_KV.delete(legacy.activationKey);
  await env.STATSHELPR_KV.delete(legacy.currentKey);
}
