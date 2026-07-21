import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";
import { validateLicense } from "@/lib/license";
import { deactivateCurrentInstance } from "@/lib/license-activation";
import { sendResetEmail } from "@/lib/resend";

/**
 * Device-switch reset for the single-device activation lock (lib/license-activation.ts).
 *
 * Verified (WebSearch of docs.lemonsqueezy.com snippets — the docs site 403s
 * bots directly — cross-checked against the lemonsqueezy.js SDK and multiple
 * independent third-party sources): Lemon Squeezy's Customer Portal is scoped
 * to subscriptions/billing/invoices/payment methods. It has NO buyer-facing
 * self-service API or portal page for license-key-instance management —
 * deactivating an instance is store-admin-only (dashboard "Store > Licenses"
 * or the authenticated /v1/licenses/deactivate call with the store's secret
 * API key). This is corroborated by:
 *   - lemonsqueezy.nolt.io/515, an open feature request for exactly this
 *     ("Improvements for deactivating license keys") — i.e. not shipped.
 *   - Third-party licensing vendors (e.g. LicenseSeat) marketing themselves
 *     as an LS add-on specifically because "customers can't manage their own
 *     licenses... or deactivate an old machine without contacting you."
 * So there is no portal URL to hand back — we always take the email-token
 * path: POST /request emails a one-time link to the license's purchase email
 * (from lib/license.ts's LicenseCheck.email, sourced from the LS webhook's
 * stored KV record or a live LS meta.customer_email lookup); POST /confirm
 * verifies the token and calls LS's deactivate on the license's current
 * instance. Never logs the license key.
 */
export const reset = new Hono<{ Bindings: Env }>();

reset.use(
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

const RESET_TOKEN_TTL_SEC = 30 * 60;
const RESET_TOKEN_PREFIX = "reset-token:";

interface ResetTokenRecord {
  licenseKey: string;
  createdAt: number;
}

reset.post("/request", async (c) => {
  let body: { licenseKey?: unknown };
  try {
    body = (await c.req.json()) as { licenseKey?: unknown };
  } catch {
    return c.json({ ok: false, reason: "Invalid JSON body" }, 400);
  }

  const licenseKey = typeof body.licenseKey === "string" ? body.licenseKey.trim() : "";
  if (!licenseKey) return c.json({ ok: false, reason: "licenseKey is required" }, 400);

  const lic = await validateLicense(c.env, licenseKey);
  if (!lic.ok) return c.json({ ok: false, reason: lic.reason ?? "Invalid license" }, 401);

  // No LS portal/API self-reset exists for buyers (see file header) — email
  // path only. The link always goes to the license's own purchase email, so
  // knowing the license key (the exact thing this feature protects against
  // someone else holding) isn't enough on its own to hijack a reset.
  if (!lic.email) {
    return c.json({ ok: false, reason: "No purchase email on file for this license." }, 400);
  }

  const resendKey = c.env.RESEND_API_KEY;
  if (!resendKey) {
    return c.json(
      { ok: false, reason: "Reset email is not configured (RESEND_API_KEY missing)." },
      500,
    );
  }

  const token = crypto.randomUUID();
  const record: ResetTokenRecord = { licenseKey, createdAt: Date.now() };
  await c.env.STATSHELPR_KV.put(`${RESET_TOKEN_PREFIX}${token}`, JSON.stringify(record), {
    expirationTtl: RESET_TOKEN_TTL_SEC,
  });

  const resetUrl = `https://statshelpr.com/reset-confirm?token=${token}`;
  const sent = await sendResetEmail(resendKey, lic.email, resetUrl);
  if (!sent.ok) {
    return c.json({ ok: false, reason: `Failed to send reset email: ${sent.reason}` }, 502);
  }

  return c.json({ ok: true, method: "email" });
});

reset.post("/confirm", async (c) => {
  let body: { token?: unknown };
  try {
    body = (await c.req.json()) as { token?: unknown };
  } catch {
    return c.json({ ok: false, reason: "Invalid JSON body" }, 400);
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return c.json({ ok: false, reason: "token is required" }, 400);

  const kvKey = `${RESET_TOKEN_PREFIX}${token}`;
  const record = (await c.env.STATSHELPR_KV.get(kvKey, "json")) as ResetTokenRecord | null;
  if (!record) return c.json({ ok: false, reason: "Invalid or expired reset link." }, 400);

  const result = await deactivateCurrentInstance(c.env, record.licenseKey);
  if (!result.ok) {
    // Leave the token valid so the user can retry on a transient LS error —
    // only consume it once the deactivation actually succeeds.
    return c.json({ ok: false, reason: result.reason ?? "Deactivation failed" }, 502);
  }

  await c.env.STATSHELPR_KV.delete(kvKey); // single-use
  return c.json({ ok: true });
});
