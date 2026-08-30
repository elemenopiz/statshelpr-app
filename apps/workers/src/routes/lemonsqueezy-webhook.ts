import { Hono } from "hono";
import type { Env } from "../types";
import { recordRevenueEvent } from "../lib/metrics-store";
import { activateForInstall } from "../lib/license-activation";

/**
 * Lemon Squeezy webhook receiver.
 *
 * Configure at LS Dashboard → Settings → Webhooks → Add endpoint:
 *   URL:     https://api.statshelpr.com/api/webhooks/lemonsqueezy
 *   Secret:  (generate, then `wrangler secret put LEMONSQUEEZY_WEBHOOK_SECRET`)
 *   Events:  subscription_created, subscription_updated, subscription_cancelled,
 *            subscription_payment_success, subscription_payment_failed
 *
 * Verifies LS's HMAC-SHA256 signature on the raw body before processing.
 * Idempotent: stores each event ID in KV with 30-day TTL and skips duplicates
 * so LS retries don't double-process.
 */

export const lsWebhook = new Hono<{ Bindings: Env }>();

lsWebhook.post("/", async (c) => {
  const secret = c.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) {
    return c.json({ error: "Webhook secret not configured" }, 500);
  }

  const rawBody = await c.req.text();
  const signature = c.req.header("x-signature") ?? "";

  // Verify HMAC-SHA256
  const valid = await verifySignature(secret, rawBody, signature);
  if (!valid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: LSWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as LSWebhookPayload;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const eventName = payload.meta?.event_name;
  const eventId = c.req.header("x-event-id") ?? `${eventName}-${Date.now()}`;

  // Idempotency check — LS retries on failures, don't double-process
  const eventKey = `ls_event:${eventId}`;
  const seen = await c.env.STATSHELPR_KV.get(eventKey);
  if (seen) {
    return c.json({ ok: true, note: "already processed" });
  }

  try {
    switch (eventName) {
      case "subscription_created":
        await activateLicense(c.env, payload);
        await writeInstallClaim(c.env, payload);
        await upsertSubRecord(c.env, payload, "active");
        // First subscription for this id -> a real new-MRR event. Deliberately
        // NOT recorded on payment_success (recurring renewal) or updated (a
        // state change), either of which would double-count the same active
        // subscriber as new revenue (dashboard-v2 item 6).
        await recordRevenueEvent(c.env, "created");
        break;
      case "subscription_payment_success":
      case "subscription_updated":
        await activateLicense(c.env, payload);
        await upsertSubRecord(c.env, payload, "active");
        break;
      case "subscription_cancelled":
      case "subscription_expired":
        await deactivateLicense(c.env, payload);
        await upsertSubRecord(c.env, payload, "cancelled");
        await recordRevenueEvent(c.env, "cancelled");
        break;
      case "subscription_payment_failed":
        await deactivateLicense(c.env, payload);
        await upsertSubRecord(c.env, payload, "cancelled");
        await recordRevenueEvent(c.env, "paymentFailed");
        break;
      // Other events (subscription_plan_changed, etc.) — noop for now
    }

    await c.env.STATSHELPR_KV.put(eventKey, "1", {
      expirationTtl: 30 * 86_400,
    });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

/** Resolve a webhook's license key via LS's license-keys API, keyed on the
 *  subscription's order_id. Subscription webhook payloads do NOT carry a
 *  `license_key` or `first_subscription_item.license_key` field despite
 *  those names suggesting they would (confirmed against LS's documented
 *  subscription attributes and the Subscription Item object) — the key only
 *  ever arrives directly on a separate `license_key_created` event this
 *  handler doesn't subscribe to. `order_id` IS present on every
 *  subscription_* webhook, so resolve through the same license-keys lookup
 *  routes/license-from-order.ts already uses for the checkout success page.
 *
 *  Unlike that route, this applies NO recency window: license-from-order.ts
 *  needs one because it's a public, unauthenticated endpoint being defended
 *  against order-id enumeration (see its module doc). This function is only
 *  ever reached after the HMAC signature check above, and a cancellation can
 *  legitimately land months after the original order — a recency gate would
 *  make deactivation silently fail exactly like the bug this replaces. */
async function resolveLicenseKeyFromOrder(
  env: Env,
  orderId: string | number | undefined,
): Promise<string | null> {
  if (orderId === undefined || orderId === null || orderId === "") return null;
  const apiKey = env.LEMONSQUEEZY_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `https://api.lemonsqueezy.com/v1/license-keys?filter[order_id]=${encodeURIComponent(String(orderId))}`,
      {
        headers: {
          Accept: "application/vnd.api+json",
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ attributes?: { key?: string } }> };
    return json.data?.[0]?.attributes?.key ?? null;
  } catch {
    return null;
  }
}

async function activateLicense(env: Env, payload: LSWebhookPayload) {
  const attrs = payload.data?.attributes;
  const licenseKey = await resolveLicenseKeyFromOrder(env, attrs?.order_id);
  if (!licenseKey) return;

  const record = {
    active: true,
    email: attrs?.user_email,
    customerId: attrs?.customer_id,
    subscriptionId: payload.data?.id,
    activatedAt: Date.now(),
  };
  // Persist license state. TTL 400 days — subscription checks refresh it.
  await env.STATSHELPR_KV.put(`license:${licenseKey}`, JSON.stringify({ ok: true, ...record }), {
    expirationTtl: 400 * 86_400,
  });
}

/** Zero-click activation handoff (see routes/claim-license.ts for the other
 *  half + the security rationale). The popup bakes the extension's install id
 *  into the checkout link as LS custom data; when the purchase webhook lands
 *  we park the license key under `claim:{installId}` for the extension's
 *  background poll to pick up, and pre-bind the license to that install so
 *  the single-device lock is already pointing at the purchasing browser.
 *
 *  ONLY called for subscription_created: custom_data rides along on every
 *  later lifecycle webhook too (renewals, updates), and re-binding there
 *  would yank a license BACK to the original install after the user has
 *  legitimately reset it onto a new device. */
async function writeInstallClaim(env: Env, payload: LSWebhookPayload) {
  const attrs = payload.data?.attributes;
  const licenseKey = await resolveLicenseKeyFromOrder(env, attrs?.order_id);
  const installId = payload.meta?.custom_data?.["install_id"];
  if (!licenseKey || typeof installId !== "string" || !installId) return;

  await env.STATSHELPR_KV.put(
    `claim:${installId}`,
    JSON.stringify({ licenseKey, createdAt: Date.now() }),
    { expirationTtl: 48 * 3600 },
  );

  try {
    await activateForInstall(env, licenseKey, installId);
  } catch {
    // Best-effort pre-bind — the claim entry above is what auto-activation
    // needs; binding happens lazily on first solve anyway (routes/solve.ts).
  }
}

async function deactivateLicense(env: Env, payload: LSWebhookPayload) {
  const attrs = payload.data?.attributes;
  const licenseKey = await resolveLicenseKeyFromOrder(env, attrs?.order_id);
  if (!licenseKey) return;

  await env.STATSHELPR_KV.put(
    `license:${licenseKey}`,
    JSON.stringify({ ok: false, reason: "Subscription inactive" }),
    { expirationTtl: 30 * 86_400 },
  );
}

/** Point-in-time subscription state for the live active-subscriber count
 *  (dashboard-v2 item 6). Written under a CLEAN `sub:{subscriptionId}`
 *  keyspace — NOT `license:`, which validateLicense pollutes with short-lived
 *  validation-cache entries (even for invalid keys), so a `license:` scan
 *  would badly overcount. metrics-load.ts scans `sub:` and counts
 *  status === "active" to derive MRR. */
interface SubRecord {
  status: "active" | "cancelled";
  email?: string;
  customerId?: number;
  /** The subscription's monthly price — current plan price is $14.99. */
  priceUsd: number;
  createdAt: number;
  updatedAt: number;
}

/** Upsert the `sub:{id}` record, preserving the original createdAt across
 *  updates. Keyed on the LS subscription id (payload.data.id) so each
 *  subscriber is exactly one KV entry regardless of how many lifecycle events
 *  fire. TTL 400 days; every lifecycle event refreshes it. */
async function upsertSubRecord(
  env: Env,
  payload: LSWebhookPayload,
  status: "active" | "cancelled",
): Promise<void> {
  const subscriptionId = payload.data?.id;
  if (!subscriptionId) return;

  const attrs = payload.data?.attributes;
  const key = `sub:${subscriptionId}`;
  const existing = (await env.STATSHELPR_KV.get(key, "json")) as SubRecord | null;
  const now = Date.now();

  const record: SubRecord = {
    status,
    email: attrs?.user_email ?? existing?.email,
    customerId: attrs?.customer_id ?? existing?.customerId,
    priceUsd: 14.99,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await env.STATSHELPR_KV.put(key, JSON.stringify(record), {
    expirationTtl: 400 * 86_400,
  });
}

async function verifySignature(
  secret: string,
  body: string,
  signature: string,
): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqual(expected, signature.toLowerCase());
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

interface LSWebhookPayload {
  meta?: { event_name?: string; custom_data?: Record<string, unknown> };
  data?: {
    id?: string;
    attributes?: {
      order_id?: string | number;
      user_email?: string;
      customer_id?: number;
    };
  };
}
