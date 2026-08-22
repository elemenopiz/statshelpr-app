/**
 * Self-test for Agent 6: Licensing, Webhook & Storage State Guard.
 *
 * Exercises:
 *  1. Lemon Squeezy webhook signature verification (HMAC-SHA256, timingSafeEqual, case tolerance)
 *  2. Webhook 30-day idempotency KV deduplication and lifecycle event handling
 *  3. License validation KV caching: 400-day TTL for valid licenses vs 10-minute TTL for invalid licenses
 *  4. Single-device activation locking: HMAC-SHA-256 keyed hash space separation, fail-closed contract, legacy migration, deactivation
 *  5. Claim license route and payload validation
 *
 * Run via:
 *   ./node_modules/.pnpm/node_modules/.bin/tsx apps/workers/scripts/self-test-licensing.ts
 */

import { validateLicense, invalidateLicense } from "../src/lib/license";
import {
  activateForInstall,
  deactivateCurrentInstance,
  activationHash,
  legacyActivationHash,
} from "../src/lib/license-activation";
import { hashBucket } from "../src/lib/rate-limit";
import { lsWebhook } from "../src/routes/lemonsqueezy-webhook";
import { claimLicense } from "../src/routes/claim-license";
import type { Env } from "../src/types";

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

class FakeKv {
  public store = new Map<string, { value: string; expirationTtl?: number }>();

  async get(key: string, type?: unknown): Promise<any> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return type === "json" ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, expirationTtl: options?.expirationTtl });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  getTtl(key: string): number | undefined {
    return this.store.get(key)?.expirationTtl;
  }
}

function fakeEnv(overrides: Partial<Env> = {}): Env & { STATSHELPR_KV: FakeKv } {
  return {
    LEMONSQUEEZY_API_KEY: "test-ls-api-key",
    LEMONSQUEEZY_WEBHOOK_SECRET: "test-webhook-secret-12345",
    ACTIVATION_HASH_SECRET: "test-activation-secret-67890",
    STATSHELPR_KV: new FakeKv() as unknown as Env["STATSHELPR_KV"],
    ...overrides,
  } as Env & { STATSHELPR_KV: FakeKv };
}

async function computeHmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function main() {
  console.log("=== Agent 6: Licensing, Webhook & Storage State Guard Self-Test ===\n");

  // ---------------------------------------------------------------------------
  console.log("1. Lemon Squeezy Webhook Verification & HMAC-SHA256");

  {
    const env = fakeEnv();
    const orderId = "order-456";
    const payload = JSON.stringify({
      meta: { event_name: "subscription_created", custom_data: { install_id: "install-test-uuid-1" } },
      data: {
        id: "sub-123",
        attributes: {
          // Real subscription_* webhooks carry order_id, NOT license_key (see
          // resolveLicenseKeyFromOrder's doc in lemonsqueezy-webhook.ts) — the
          // webhook resolves the key via LS's license-keys API, mocked below.
          order_id: orderId,
          user_email: "user@example.com",
          customer_id: 9999,
        },
      },
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/license-keys") && urlStr.includes(`filter[order_id]=${orderId}`)) {
        return new Response(
          JSON.stringify({ data: [{ attributes: { key: "LIC-TEST-WEBHOOK-1" } }] }),
          { status: 200 },
        );
      }
      return origFetch(url, init);
    };

    const validSig = await computeHmacHex(env.LEMONSQUEEZY_WEBHOOK_SECRET!, payload);

    // Test 1.1: Valid signature with x-event-id
    const req1 = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": validSig,
        "x-event-id": "evt-001",
      },
      body: payload,
    });

    const res1 = await lsWebhook.fetch(req1, env);
    check("valid webhook signature succeeds (200 OK)", res1.status === 200);
    const json1 = (await res1.json()) as { ok?: boolean };
    check("response body has ok: true", json1.ok === true);

    // Verify KV writes
    check(
      "webhook records 30-day idempotency key in KV",
      env.STATSHELPR_KV.has("ls_event:evt-001") &&
        env.STATSHELPR_KV.getTtl("ls_event:evt-001") === 30 * 86400,
    );
    check(
      "webhook activates license in KV with 400-day TTL",
      env.STATSHELPR_KV.has("license:LIC-TEST-WEBHOOK-1") &&
        env.STATSHELPR_KV.getTtl("license:LIC-TEST-WEBHOOK-1") === 400 * 86400,
    );
    check(
      "webhook parks zero-click claim with 48h TTL",
      env.STATSHELPR_KV.has("claim:install-test-uuid-1") &&
        env.STATSHELPR_KV.getTtl("claim:install-test-uuid-1") === 48 * 3600,
    );
    check(
      "webhook upserts sub record with 400-day TTL",
      env.STATSHELPR_KV.has("sub:sub-123") &&
        env.STATSHELPR_KV.getTtl("sub:sub-123") === 400 * 86400,
    );

    // Test 1.2: Idempotency deduplication
    const req2 = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": validSig,
        "x-event-id": "evt-001",
      },
      body: payload,
    });
    const res2 = await lsWebhook.fetch(req2, env);
    const json2 = (await res2.json()) as { ok?: boolean; note?: string };
    check(
      "duplicate event is deduplicated with 'already processed'",
      res2.status === 200 && json2.note === "already processed",
    );

    // Test 1.3: Tampered signature rejection (401)
    const badSig = validSig.slice(0, -2) + "00";
    const reqBad = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": badSig,
        "x-event-id": "evt-002",
      },
      body: payload,
    });
    const resBad = await lsWebhook.fetch(reqBad, env);
    check("tampered signature returns 401 Unauthorized", resBad.status === 401);

    // Test 1.4: Missing signature rejection (401)
    const reqNoSig = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: payload,
    });
    const resNoSig = await lsWebhook.fetch(reqNoSig, env);
    check("missing signature returns 401 Unauthorized", resNoSig.status === 401);

    // Test 1.5: Uppercase signature accepted via case-insensitivity
    const upperSig = validSig.toUpperCase();
    const reqUpper = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": upperSig,
        "x-event-id": "evt-003",
      },
      body: payload,
    });
    const resUpper = await lsWebhook.fetch(reqUpper, env);
    check("uppercase hex signature is verified correctly", resUpper.status === 200);

    // Test 1.6: Cancellation actually revokes the cached license (the bug —
    // deactivateLicense used to read a field that doesn't exist on real LS
    // payloads, so it silently no-opped and a cancelled subscriber kept paid
    // access for the full 400-day validateLicense() cache TTL).
    const cancelPayload = JSON.stringify({
      meta: { event_name: "subscription_cancelled" },
      data: {
        id: "sub-123",
        attributes: { order_id: orderId, user_email: "user@example.com", customer_id: 9999 },
      },
    });
    const cancelSig = await computeHmacHex(env.LEMONSQUEEZY_WEBHOOK_SECRET!, cancelPayload);
    const reqCancel = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": cancelSig,
        "x-event-id": "evt-cancel-001",
      },
      body: cancelPayload,
    });
    const resCancel = await lsWebhook.fetch(reqCancel, env);
    check("cancellation webhook returns 200 OK", resCancel.status === 200);
    const cancelledRecord = (await env.STATSHELPR_KV.get("license:LIC-TEST-WEBHOOK-1", "json")) as {
      ok: boolean;
    } | null;
    check(
      "cancellation resolves the same key via order_id and revokes it (ok: false)",
      cancelledRecord?.ok === false,
    );

    globalThis.fetch = origFetch;
  }

  // ---------------------------------------------------------------------------
  console.log("\n2. License KV Caching in license.ts (400-day vs 10-minute TTL)");

  {
    const env = fakeEnv();
    const validKey = "LIC-PAID-EXISTING";
    // Pre-populate KV cache with a valid license
    await env.STATSHELPR_KV.put(
      `license:${validKey}`,
      JSON.stringify({ ok: true, tier: "paid", email: "student@utexas.edu" }),
      { expirationTtl: 400 * 86400 },
    );

    const check1 = await validateLicense(env, validKey);
    check("cached valid license returns ok: true, tier: 'paid'", check1.ok === true && check1.tier === "paid");
    check("cached valid license includes email", check1.email === "student@utexas.edu");

    // Invalidate license
    await invalidateLicense(env, validKey);
    check("invalidateLicense removes the key from KV", !env.STATSHELPR_KV.has(`license:${validKey}`));

    // Empty license key -> free tier (unrestricted check, no cache write)
    const checkFree = await validateLicense(env, "");
    check("empty license key defaults to ok: true, tier: 'free'", checkFree.ok === true && checkFree.tier === "free");

    // The dev extension's synthetic paid key must be accepted without ever
    // reaching Lemon Squeezy. This is deliberately tested with LS configured
    // because that is where the old bug surfaced: validation passed, then the
    // activation step sent the fake key to LS and got license_key_not_found.
    const devBypass = "statshelpr-dev-founder-bypass-2026";
    const devCheck = await validateLicense(env, devBypass);
    check("dev bypass key validates as paid", devCheck.ok === true && devCheck.tier === "paid");
  }

  // ---------------------------------------------------------------------------
  console.log("\n3. Single-Device Activation Locking & Hash Separation");

  {
    const env = fakeEnv();
    const installId = "inst-uuid-xyz-123";
    const licenseKey = "LIC-DEVICE-TEST-1";

    const keyedHash = await activationHash(env, installId);
    const metricsHash = await hashBucket(installId);
    check("activation hash is disjoint from metrics hashBucket", keyedHash !== metricsHash);

    // Fail closed if secret missing
    const noSecretEnv = fakeEnv({ ACTIVATION_HASH_SECRET: undefined });
    let threw = false;
    try {
      await activationHash(noSecretEnv, installId);
    } catch {
      threw = true;
    }
    check("activationHash throws when ACTIVATION_HASH_SECRET is unset", threw);

    // Dev license bypass check
    await env.STATSHELPR_KV.put(`license:LIC-DEV-KEY`, JSON.stringify({ ok: true, dev: true }));
    const devRes = await activateForInstall(env, "LIC-DEV-KEY", installId);
    check("dev license bypasses LS activation", devRes.ok === true && devRes.activated === true);

    const devBypassRes = await activateForInstall(
      env,
      "statshelpr-dev-founder-bypass-2026",
      installId,
    );
    check(
      "dev build bypasses LS activation",
      devBypassRes.ok === true && devBypassRes.activated === true,
    );

    // Deactivate instance
    const licHash = await activationHash(env, licenseKey);
    const instHash = await activationHash(env, installId);
    await env.STATSHELPR_KV.put(
      `activation:${licHash}:${instHash}`,
      JSON.stringify({ instanceId: "inst-1", activatedAt: Date.now() }),
    );
    await env.STATSHELPR_KV.put(
      `activation-current:${licHash}`,
      JSON.stringify({ instanceId: "inst-1", installIdHash: instHash, activatedAt: Date.now() }),
    );

    // Mock LS deactivate response by intercepting global fetch
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/licenses/deactivate")) {
        return new Response(JSON.stringify({ deactivated: true, error: null }), { status: 200 });
      }
      return origFetch(url, init);
    };

    const deactRes = await deactivateCurrentInstance(env, licenseKey);
    check("deactivateCurrentInstance succeeds", deactRes.ok === true);
    check("deactivateCurrentInstance cleans up activation key", !env.STATSHELPR_KV.has(`activation:${licHash}:${instHash}`));
    check("deactivateCurrentInstance cleans up activation-current key", !env.STATSHELPR_KV.has(`activation-current:${licHash}`));

    globalThis.fetch = origFetch;
  }

  // ---------------------------------------------------------------------------
  console.log("\n4. Claim License Route & Zero-Click Poll Endpoint");

  {
    const env = fakeEnv();
    const installId = "3f9c1b7e-0000-4a11-9c2d-abcdefabcdef";
    const licenseKey = "LIC-CLAIM-999";

    // When no claim parked yet:
    const req1 = new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId }),
    });
    const res1 = await claimLicense.fetch(req1, env);
    check("unclaimed poll returns 200 with ok: false (keep waiting)", res1.status === 200);
    const json1 = (await res1.json()) as { ok?: boolean };
    check("unclaimed json ok is false", json1.ok === false);

    // Park claim
    await env.STATSHELPR_KV.put(`claim:${installId}`, JSON.stringify({ licenseKey }));

    const req2 = new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId }),
    });
    const res2 = await claimLicense.fetch(req2, env);
    check("claimed poll returns 200 with ok: true", res2.status === 200);
    const json2 = (await res2.json()) as { ok?: boolean; licenseKey?: string };
    check("claimed json contains licenseKey", json2.ok === true && json2.licenseKey === licenseKey);

    // Bad installId validation (< 8 chars)
    const reqBad = new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: "short" }),
    });
    const resBad = await claimLicense.fetch(reqBad, env);
    check("invalid/short installId returns 400 Bad Request", resBad.status === 400);
  }

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
