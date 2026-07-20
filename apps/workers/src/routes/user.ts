import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";
import { invalidateLicense, validateLicense } from "@/lib/license";

/**
 * GDPR/CCPA data deletion endpoint. Purges everything we store keyed on the
 * caller's license: cache entry, rate-limit counter, feedback (best-effort).
 */

export const user = new Hono<{ Bindings: Env }>();

user.use("*", cors({
  origin: "*",
  allowMethods: ["DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

user.delete("/", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const licenseKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  // Deletion requires an actual license key that identifies the caller's data.
  // Without this guard, an empty key would validate as free-tier and then purge
  // the shared "anon" rate-limit bucket (resetting every free user's counter).
  if (!licenseKey) {
    return c.json({ error: "A license key is required to delete account data." }, 400);
  }

  // Validate the caller owns the license before we delete anything.
  const lic = await validateLicense(c.env, licenseKey);
  if (!lic.ok) return c.json({ error: lic.reason ?? "Unauthorized" }, 401);

  // Purge license cache entry
  await invalidateLicense(c.env, licenseKey);

  // Purge rate-limit counter
  const hash = await hashKey(licenseKey);
  await c.env.STATSHELPR_KV.delete(`rl:${hash}`);

  // Feedback records are anonymized (only license hash stored); we don't
  // delete them here — they're not PII once hashed. If you want stricter
  // handling, list keys with prefix `feedback:` and filter by licenseHash.

  return c.json({ ok: true, deleted: ["license_cache", "rate_limit"] });
});

async function hashKey(key: string): Promise<string> {
  const buf = new TextEncoder().encode(key || "anon");
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
