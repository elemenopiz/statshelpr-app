import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";

/**
 * Resolve a buyer's Lemon Squeezy license key from their order ID, right
 * after checkout — lets the success page auto-activate the extension
 * instead of making the user copy the key out of their confirmation email.
 *
 * LS API:
 *   GET https://api.lemonsqueezy.com/v1/license-keys?filter[order_id]=<id>
 *   headers: Accept: application/vnd.api+json, Authorization: Bearer <key>
 *   returns a JSON:API list — `data` is an array (empty if the license key
 *   hasn't been issued yet, e.g. the `order_created` webhook hasn't landed).
 *   Confirmed against the official lemonsqueezy.js SDK source
 *   (src/licenseKeys/{index,types}.ts): `filter.orderId` -> `order_id` on
 *   the wire, `ListLicenseKeys.data` is `LicenseKeyData[]`, and each
 *   license key's `attributes.key` holds the full key string.
 *
 * SECURITY: handing back a key for a known order ID is safe — every solve
 * still validates the key server-side against LS (see lib/license.ts), so
 * this endpoint only saves a copy-paste, it doesn't grant access by itself.
 * Never log the key.
 */

export const licenseFromOrder = new Hono<{ Bindings: Env }>();

licenseFromOrder.use(
  "*",
  cors({
    origin: [
      "https://statshelpr.com",
      "https://www.statshelpr.com",
      "http://localhost:4321",
    ],
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

interface LSLicenseKeyListResponse {
  data?: Array<{ attributes?: { key?: string } }>;
}

licenseFromOrder.post("/", async (c) => {
  let body: { orderId?: unknown };
  try {
    body = (await c.req.json()) as { orderId?: unknown };
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const orderId = body.orderId;
  if (typeof orderId !== "string" || !orderId) {
    return c.json({ ok: false, error: "orderId is required" }, 400);
  }

  const apiKey = c.env.LEMONSQUEEZY_API_KEY;
  if (!apiKey) {
    return c.json({ ok: false, error: "License lookup not configured" }, 500);
  }

  try {
    const res = await fetch(
      `https://api.lemonsqueezy.com/v1/license-keys?filter[order_id]=${encodeURIComponent(orderId)}`,
      {
        headers: {
          Accept: "application/vnd.api+json",
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );

    if (!res.ok) {
      return c.json(
        { ok: false, error: `Lemon Squeezy API error (${res.status})` },
        502,
      );
    }

    const json = (await res.json()) as LSLicenseKeyListResponse;
    const licenseKey = json.data?.[0]?.attributes?.key;

    if (!licenseKey) {
      // LS issues the license key asynchronously after checkout (webhook-
      // driven) — no match yet just means "not ready", not an error, so the
      // success page can poll again shortly.
      return c.json({ ok: false, error: "License not ready yet" }, 200);
    }

    return c.json({ ok: true, licenseKey }, 200);
  } catch (e) {
    return c.json(
      { ok: false, error: `Lemon Squeezy request failed: ${(e as Error).message}` },
      502,
    );
  }
});
